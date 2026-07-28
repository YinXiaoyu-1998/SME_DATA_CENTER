import { readFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { config as loadDotenv } from "dotenv";
import { PrismaMariaDb } from "@prisma/adapter-mariadb";
import { PrismaClient } from "@prisma/client";
import { AuthCore } from "../apps/api/src/auth/auth-core.js";
import { createPrismaAuthCoreRepository } from "../apps/api/src/auth/prisma-auth-repository.js";

loadDotenv({ quiet: true, override: false });

const DEFAULT_API_URL = "https://api.smedatacenter.xyz";
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

  const prisma = new PrismaClient({ adapter: new PrismaMariaDb(databaseUrl) });
  const auth = new AuthCore(createPrismaAuthCoreRepository(prisma));
  const identity = await prisma.loginIdentity.findFirst({
    where: { employeeId: "emp_admin", disabled: false },
    select: { id: true, employeeId: true, orgId: true }
  });
  if (!identity) {
    await prisma.$disconnect();
    throw new Error("Synthetic staging admin LoginIdentity is missing.");
  }
  const session = await auth.createSession({
    identityId: identity.id,
    employeeId: identity.employeeId,
    orgId: identity.orgId
  });
  const headers = { authorization: `Bearer ${session.accessToken}` };

  try {
    const uploads = await Promise.all([
      uploadFixture(apiUrl, headers, "fixtures/evidence/kitchen-sop.md", "Staging Kitchen SOP"),
      uploadFixture(apiUrl, headers, "fixtures/evidence/shift-notes.txt", "Staging Shift Notes")
    ]);

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
          fileTypes: ["md", "txt"]
        },
        limit: 5
      })
    });

    const uploadedIds = new Set(uploads.map((upload) => upload.document.documentId));
    if (!search.results.some((result) => uploadedIds.has(result.documentId))) {
      throw new Error("Staging smoke search did not return an uploaded fixture document.");
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
  } finally {
    await auth.logout(session.durableCredential);
    await prisma.$disconnect();
  }
}

async function uploadFixture(
  apiUrl: string,
  headers: Record<string, string>,
  fixturePath: string,
  title: string
): Promise<EvidenceUploadResponse> {
  const body = await readFile(join(process.cwd(), fixturePath));
  const form = new FormData();
  form.append("file", new Blob([body]), basename(fixturePath));
  form.append("title", title);
  form.append("sourceSystem", "staging_fixture_smoke");
  form.append("labelKeys[]", "store:baoli");

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

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
