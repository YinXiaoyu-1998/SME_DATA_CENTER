import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { config as loadDotenv } from "dotenv";
import { createDatabaseAdapter, lockAuthorizationPublication } from "@smedc/db";
import { PrismaClient } from "@prisma/client";
import { createStorageAdapter } from "@smedc/storage";
import { AuthCore } from "../apps/api/src/auth/auth-core.js";
import { parseApiRetrievalRuntimeConfig } from "../apps/api/src/config/retrieval-runtime.js";
import { createPrismaAuthCoreRepository } from "../apps/api/src/auth/prisma-auth-repository.js";

loadDotenv({ quiet: true, override: false });

const DEFAULT_API_URL = "https://api.smedatacenter.xyz";
const STAGING_FIXTURE_SOURCE_SYSTEM = "staging_fixture_smoke";
interface EvidenceUploadResponse {
  document: {
    documentId: string;
    status: string;
  };
}

interface EvidenceStatusResponse {
  document: {
    documentId: string;
    status: string;
  };
  documentIndex: {
    status: string;
  };
}

interface EvidenceSearchResponse {
  results: Array<{
    documentId: string;
    text: string;
  }>;
}

async function main() {
  const apiUrl = normalizeApiUrl(process.env["STAGING_SMOKE_API_URL"] ?? DEFAULT_API_URL);
  const databaseUrl = process.env["DATABASE_URL"];

  if (!databaseUrl) {
    throw new Error("DATABASE_URL is required for the server-side official staging smoke.");
  }

  const prisma = new PrismaClient({ adapter: createDatabaseAdapter(databaseUrl) });
  const auth = new AuthCore(createPrismaAuthCoreRepository(prisma));
  const identity = await prisma.loginIdentity.findFirst({
    where: { employeeId: "emp_admin", disabled: false },
    select: { id: true, employeeId: true, orgId: true }
  });
  if (!identity) {
    await prisma.$disconnect();
    throw new Error("Synthetic staging admin LoginIdentity is missing.");
  }
  if (identity.orgId !== "default-org") {
    await prisma.$disconnect();
    throw new Error("Staging smoke requires the seeded synthetic QA organization.");
  }
  const state = await prisma.businessAuthorizationState.findUnique({
    where: { orgId: identity.orgId }
  });
  if (state?.mode !== "legacy") {
    await prisma.$disconnect();
    throw new Error("Staging smoke must not change an activated QA tenant.");
  }
  await cleanupStagingFixtureDocuments(prisma, identity.orgId);
  const categoryId = `staging-smoke-${randomUUID()}`;
  const session = await auth.createSession({
    identityId: identity.id,
    employeeId: identity.employeeId,
    orgId: identity.orgId
  });
  const headers = { authorization: `Bearer ${session.accessToken}` };
  let smokeFailure: unknown;
  let cleanupFailure: unknown;
  let logoutFailure: unknown;

  try {
    await prisma.$transaction(async (tx) => {
      const state = await lockAuthorizationPublication(tx, identity.orgId);
      if (state.mode !== "legacy")
        throw new Error("Staging smoke must not change an activated QA tenant.");
      await tx.businessCategory.create({
        data: {
          orgId: identity.orgId,
          id: categoryId,
          name: "Staging fixture smoke",
          kind: "evidence",
          allowGroup: true,
          allowStore: false
        }
      });
    });
    const uploads = [
      await uploadFixture(
        apiUrl,
        headers,
        "fixtures/evidence/kitchen-sop.md",
        "Staging Kitchen SOP",
        categoryId
      ),
      await uploadFixture(
        apiUrl,
        headers,
        "fixtures/evidence/shift-notes.txt",
        "Staging Shift Notes",
        categoryId
      )
    ];

    await Promise.all(
      uploads.map((upload) => waitForIndexed(apiUrl, headers, upload.document.documentId))
    );

    const search = await apiJson<EvidenceSearchResponse>(apiUrl, "/v1/evidence/search", {
      method: "POST",
      headers: {
        ...headers,
        "content-type": "application/json"
      },
      body: JSON.stringify({
        query: "fridge temperatures",
        filters: {
          fileTypes: ["md", "txt"],
          documentIds: uploads.map((upload) => upload.document.documentId)
        },
        limit: 5
      })
    });

    const uploadedIds = new Set(uploads.map((upload) => upload.document.documentId));
    if (!search.results.some((result) => uploadedIds.has(result.documentId))) {
      throw new Error(
        `Staging smoke search did not return an uploaded fixture document; returned=${search.results
          .map((result) => result.documentId)
          .join(",")}`
      );
    }

    console.log(
      JSON.stringify(
        {
          ok: true,
          uploadedDocuments: uploads.map((upload) => upload.document.documentId),
          searchedFor: "fridge temperatures"
        },
        null,
        2
      )
    );
  } catch (error) {
    smokeFailure = error;
  }

  try {
    await cleanupStagingFixtureDocuments(prisma, identity.orgId);
    await prisma.businessCategory.deleteMany({ where: { orgId: identity.orgId, id: categoryId } });
  } catch (error) {
    cleanupFailure = error;
  }

  try {
    await auth.logout(session.durableCredential);
  } catch (error) {
    logoutFailure = error;
  } finally {
    await prisma.$disconnect();
  }

  if (smokeFailure) {
    if (cleanupFailure) {
      console.error(`Staging smoke cleanup failed: ${errorToMessage(cleanupFailure)}`);
    }
    if (logoutFailure) {
      console.error(`Staging smoke logout failed: ${errorToMessage(logoutFailure)}`);
    }
    throw smokeFailure;
  }

  if (cleanupFailure) {
    throw cleanupFailure;
  }

  if (logoutFailure) {
    throw logoutFailure;
  }
}

export async function uploadFixture(
  apiUrl: string,
  headers: Record<string, string>,
  fixturePath: string,
  title: string,
  categoryId: string
): Promise<EvidenceUploadResponse> {
  const body = await readFile(join(process.cwd(), fixturePath));
  const form = new FormData();
  form.append("file", new Blob([body]), basename(fixturePath));
  form.append("title", title);
  form.append("sourceSystem", STAGING_FIXTURE_SOURCE_SYSTEM);
  form.append("confidentialityLevel", "0");
  form.append("categoryId", categoryId);
  form.append(
    "scopes",
    JSON.stringify([
      { enterpriseKey: STAGING_FIXTURE_SOURCE_SYSTEM, ownership: "group", dimensions: {} }
    ])
  );

  const upload = await apiJson<EvidenceUploadResponse>(apiUrl, "/v1/documents/evidence", {
    method: "POST",
    headers,
    body: form
  });

  if (upload.document.status !== "pending_processing") {
    throw new Error(
      `Expected fixture ${fixturePath} to start pending_processing, got ${upload.document.status}.`
    );
  }

  return upload;
}

async function cleanupStagingFixtureDocuments(prisma: PrismaClient, orgId: string): Promise<void> {
  const documents = await prisma.document.findMany({
    where: {
      orgId,
      sourceSystem: STAGING_FIXTURE_SOURCE_SYSTEM
    },
    select: {
      id: true,
      storageObjectKey: true,
      chunks: {
        where: {
          qdrantPointId: {
            not: null
          }
        },
        select: {
          qdrantPointId: true
        }
      }
    }
  });

  if (documents.length === 0) {
    return;
  }

  const qdrantPointIds = documents.flatMap((document) =>
    document.chunks
      .map((chunk) => chunk.qdrantPointId)
      .filter((pointId): pointId is string => Boolean(pointId))
  );

  await deleteQdrantPoints(qdrantPointIds);

  const storage = createStorageAdapter(process.env);
  for (const document of documents) {
    await storage.deleteObject(document.storageObjectKey);
  }

  const documentIds = documents.map((document) => document.id);
  await prisma.$transaction(async (tx) => {
    await tx.businessResource.deleteMany({
      where: {
        orgId,
        OR: [{ documentId: { in: documentIds } }, { sourceDocumentId: { in: documentIds } }]
      }
    });
    await tx.document.deleteMany({
      where: { orgId, id: { in: documentIds }, sourceSystem: STAGING_FIXTURE_SOURCE_SYSTEM }
    });
  });
}

async function deleteQdrantPoints(pointIds: string[]): Promise<void> {
  if (pointIds.length === 0) {
    return;
  }

  const runtime = parseApiRetrievalRuntimeConfig();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), runtime.qdrant.timeoutMs);

  try {
    const response = await fetch(
      `${runtime.qdrant.url}/collections/${encodeURIComponent(
        runtime.qdrant.collectionName
      )}/points/delete?wait=true`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(runtime.qdrant.apiKey ? { "api-key": runtime.qdrant.apiKey } : {})
        },
        body: JSON.stringify({
          points: pointIds
        }),
        signal: controller.signal
      }
    );

    if (!response.ok) {
      throw new Error(`Qdrant smoke fixture cleanup failed: HTTP ${response.status}`);
    }
  } finally {
    clearTimeout(timeout);
  }
}

async function waitForIndexed(
  apiUrl: string,
  headers: Record<string, string>,
  documentId: string
): Promise<void> {
  const deadline = Date.now() + 180_000;
  let lastStatus = "unknown";

  while (Date.now() < deadline) {
    const status = await apiJson<EvidenceStatusResponse>(
      apiUrl,
      `/v1/documents/evidence/${encodeURIComponent(documentId)}/status`,
      { headers }
    );
    lastStatus = `${status.document.status}/${status.documentIndex.status}`;

    if (status.document.status === "active" && status.documentIndex.status === "ready") {
      return;
    }

    await delay(3_000);
  }

  throw new Error(`Document ${documentId} was not indexed before timeout; last=${lastStatus}.`);
}

async function apiJson<T>(apiUrl: string, path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(new URL(path, apiUrl), init);
  const body = await response.json().catch(() => null);

  if (!response.ok) {
    throw new Error(`HTTP ${response.status} for ${path}: ${JSON.stringify(body)}`);
  }

  return body as T;
}

function normalizeApiUrl(input: string): string {
  return input.endsWith("/") ? input : `${input}/`;
}

function errorToMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
