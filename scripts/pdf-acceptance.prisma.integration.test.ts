import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { PrismaMariaDb } from "@prisma/adapter-mariadb";
import { PrismaClient } from "@prisma/client";
import { LocalFileSystemStorageAdapter } from "@smedc/storage";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  cleanupPrismaPdfAcceptanceRun,
  createPdfQdrantResources,
  inventoryPdfAcceptanceRun,
  registerPdfDocument,
  readPdfManifest,
  setupPdfAcceptanceRun
} from "./pdf-acceptance-controller.js";
import {
  createPdfAcceptanceManifest,
  type PdfAcceptanceManifest
} from "./pdf-acceptance-support.js";
import { pdfCandidateIdentity } from "../apps/worker/src/evidence-artifacts.js";

const enabled = process.env["RUN_PDF_ACCEPTANCE_PRISMA_INTEGRATION"] === "1";
describe.skipIf(!enabled)("local isolated PDF cleanup proof", () => {
  const url = process.env["DATABASE_URL"] ?? "";
  const qdrant = process.env["QDRANT_URL"] ?? "";
  const prisma = new PrismaClient({ adapter: new PrismaMariaDb(url) });
  const tag = randomUUID().slice(0, 8);
  const outside = `pdf-task7-outside-${tag}`;
  const collection = `pdf_task7_${tag}`;
  const sentinelPoint = randomUUID();
  const sentinelDoc = `sentinel_${tag}`;
  const manifests: PdfAcceptanceManifest[] = [];
  let root: string;
  let storage: LocalFileSystemStorageAdapter;
  let baseline: unknown;
  let authorized = false;
  const request = async (method: string, route: string, body?: unknown) => {
    const response = await fetch(`${qdrant}/collections/${collection}${route}`, {
      method,
      headers: { "content-type": "application/json" },
      ...(body ? { body: JSON.stringify(body) } : {})
    });
    if (!response.ok) throw new Error(`Local Qdrant proof failed ${response.status}`);
    return response.json();
  };
  const save = async () => {};
  beforeAll(async () => {
    const local =
      url === "mysql://smedc:smedc_local_password@127.0.0.1:13307/smedc" &&
      qdrant === "http://127.0.0.1:16337";
    const ci =
      process.env["CI"] === "true" &&
      process.env["COMPOSE_PROJECT_NAME"] === "sme_data_center_ci" &&
      url === "mysql://smedc:smedc_local_password@127.0.0.1:3307/smedc" &&
      qdrant === "http://127.0.0.1:6333";
    if (!local && !ci) throw new Error("Exact authorized local targets required.");
    authorized = true;
    baseline = await prisma.document.findMany({
      where: { orgId: "pdf-migration-baseline" },
      include: { chunks: true, indexes: true }
    });
    root = await mkdtemp(path.join(os.tmpdir(), "pdf-task7-proof-"));
    storage = new LocalFileSystemStorageAdapter({ root });
    await request("PUT", "", { vectors: { size: 2, distance: "Cosine" } });
    await prisma.organization.create({ data: { id: outside, name: "Outside synthetic sentinel" } });
    const employee = await prisma.employee.create({
      data: {
        orgId: outside,
        email: `${outside}@example.invalid`,
        displayName: "Sentinel",
        role: "employee",
        clearance: 3
      }
    });
    const object = await storage.putObject({
      orgId: outside,
      documentId: sentinelDoc,
      fileName: "sentinel.pdf",
      body: "outside sentinel"
    });
    await prisma.document.create({
      data: {
        id: sentinelDoc,
        orgId: outside,
        uploaderId: employee.id,
        title: "Sentinel",
        documentType: "raw_material",
        documentKind: "evidence",
        fileType: "pdf",
        storageObjectKey: object.key,
        status: "active"
      }
    });
    await request("PUT", "/points?wait=true", {
      points: [
        { id: sentinelPoint, vector: [1, 0], payload: { orgId: outside, documentId: sentinelDoc } }
      ]
    });
  });
  afterAll(async () => {
    if (!authorized) {
      await prisma.$disconnect();
      return;
    }
    for (const m of manifests) {
      await prisma.pdfEvidenceAttempt.deleteMany({ where: { orgId: { in: m.orgIds } } });
      await prisma.document.deleteMany({ where: { orgId: { in: m.orgIds } } });
      await prisma.oAuthAccessToken.deleteMany({ where: { orgId: { in: m.orgIds } } });
      await prisma.authSecurityEvent.deleteMany({ where: { orgId: { in: m.orgIds } } });
      await prisma.authSession.deleteMany({ where: { orgId: { in: m.orgIds } } });
      await prisma.loginIdentity.deleteMany({ where: { orgId: { in: m.orgIds } } });
      await prisma.auditLog.deleteMany({ where: { orgId: { in: m.orgIds } } });
      await prisma.employee.deleteMany({ where: { orgId: { in: m.orgIds } } });
      await prisma.organization.deleteMany({ where: { id: { in: m.orgIds } } });
      await prisma.retrievalConfig.deleteMany({ where: { version: `task7-${m.runId}` } });
    }
    expect(await prisma.document.findUnique({ where: { id: sentinelDoc } })).not.toBeNull();
    expect(
      (await request("POST", "/points", { ids: [sentinelPoint], with_payload: true })).result
    ).toHaveLength(1);
    expect(
      (await storage.statObject(`org/${outside}/documents/${sentinelDoc}/original/sentinel.pdf`))
        .size
    ).toBe(16);
    expect(
      await prisma.document.findMany({
        where: { orgId: "pdf-migration-baseline" },
        include: { chunks: true, indexes: true }
      })
    ).toEqual(baseline);
    await prisma.document.deleteMany({ where: { orgId: outside } });
    await prisma.employee.deleteMany({ where: { orgId: outside } });
    await prisma.organization.delete({ where: { id: outside } });
    await request("DELETE", "");
    await rm(root, { recursive: true, force: true });
    await prisma.$disconnect();
  });
  async function fixture(state: "active" | "cleaned" = "active") {
    const m = createPdfAcceptanceManifest(`local7-${randomUUID().slice(0, 8)}`);
    manifests.push(m);
    await setupPdfAcceptanceRun(prisma, m, save);
    const orgId = m.orgIds[0];
    const employee = await prisma.employee.findUniqueOrThrow({ where: { id: m.employeeIds[0] } });
    const id = `doc_${randomUUID().slice(0, 8)}`;
    const runId = `run_${randomUUID().slice(0, 8)}`;
    const config = `task7-${m.runId}`;
    const point = randomUUID();
    const object = await storage.putObject({
      orgId,
      documentId: id,
      fileName: "synthetic.pdf",
      body: "synthetic PDF"
    });
    await prisma.document.create({
      data: {
        id,
        orgId,
        uploaderId: employee.id,
        title: "Synthetic PDF",
        documentType: "raw_material",
        documentKind: "evidence",
        fileType: "pdf",
        status: state === "active" ? "active" : "pending_processing",
        storageObjectKey: object.key,
        sourceSystem: `pdf_acceptance_${m.runId}`,
        checksumSha256: "a".repeat(64)
      }
    });
    await prisma.processingRun.create({
      data: {
        id: runId,
        orgId,
        documentId: id,
        jobKey: `task7:${id}`,
        jobType: "evidence_document_index",
        attemptNumber: 1,
        status: state === "active" ? "succeeded" : "failed",
        finishedAt: new Date()
      }
    });
    const identity = pdfCandidateIdentity(
      {
        id: runId,
        orgId,
        documentId: id,
        attemptNumber: 1,
        document: { contentVersion: 1 }
      } as never,
      "a".repeat(64),
      "synthetic-fp",
      config
    );
    await storage.putObjectAtKey!({
      key: identity.parsedObjectKey,
      body: Readable.from(["synthetic parsed"]),
      contentLength: 16,
      checksumSha256: createHash("sha256").update("synthetic parsed").digest("hex")
    });
    await prisma.pdfEvidenceAttempt.create({
      data: {
        ...identity,
        orgId,
        documentId: id,
        runId,
        attemptNumber: 1,
        contentVersion: 1,
        retrievalConfigVersion: config,
        parserFingerprint: "synthetic-fp",
        collection,
        pointIds: [point],
        state
      }
    });
    await request("PUT", "/points?wait=true", {
      points: [{ id: point, vector: [1, 0], payload: { orgId, documentId: id } }]
    });
    if (state === "active") {
      const retrieval = await prisma.retrievalConfig.create({
        data: {
          version: config,
          chunkerName: "synthetic",
          denseEmbeddingProvider: "fake",
          denseEmbeddingModel: "fake",
          denseVectorDimension: 2,
          qdrantCollection: collection,
          configJson: {}
        }
      });
      const index = await prisma.documentIndex.create({
        data: {
          orgId,
          documentId: id,
          retrievalConfigId: retrieval.id,
          contentVersion: 1,
          status: "ready",
          indexedChunkCount: 1,
          qdrantCollection: collection,
          parserFingerprint: "synthetic-fp",
          parsedObjectKey: identity.parsedObjectKey,
          parseSummary: { complete: true, pageCount: 1 }
        }
      });
      await prisma.documentChunk.create({
        data: {
          documentId: id,
          documentIndexId: index.id,
          chunkIndex: 0,
          chunkText: "synthetic",
          chunkHash: "a".repeat(64),
          qdrantPointId: point
        }
      });
    }
    const external = createPdfQdrantResources({ url: qdrant, collection, storage });
    await registerPdfDocument(prisma, m, id, external, save);
    return { m, external, identity, point };
  }
  it("runs actual compiled PDF setup/cleanup before legacy cleanup without loading .env", async () => {
    const m = createPdfAcceptanceManifest(`cli7-${randomUUID().slice(0, 8)}`);
    manifests.push(m);
    const manifestPath = path.join(root, "private", `${m.runId}.json`);
    const env = {
      ...process.env,
      DATABASE_URL: url,
      QDRANT_URL: qdrant,
      QDRANT_COLLECTION_EVIDENCE: collection,
      STORAGE_DRIVER: "local",
      LOCAL_STORAGE_ROOT: root,
      SMEDC_PDF_ACCEPTANCE_LOCAL: "1"
    };
    for (const command of ["setup", "cleanup"]) {
      const result = JSON.parse(
        execFileSync(
          process.execPath,
          [
            "dist/release/official-manual-acceptance.js",
            command,
            "--profile=pdf",
            `--run-id=${m.runId}`,
            `--manifest=${manifestPath}`
          ],
          { env, encoding: "utf8" }
        )
      );
      expect(result).toMatchObject({ ok: true, profile: "pdf", command });
    }
    expect((await readPdfManifest(manifestPath, m.runId)).phase).toBe("complete");
    expect(await prisma.organization.count({ where: { id: { in: m.orgIds } } })).toBe(0);
  });
  it("removes confirmed two-org resources, survives deletion interruption and preserves outside sentinels", async () => {
    const { m, external, identity } = await fixture();
    const remove = storage.deleteObject.bind(storage);
    let fail = true;
    storage.deleteObject = async (key) => {
      if (fail && key.includes("/original/")) {
        fail = false;
        throw new Error("synthetic interrupted delete");
      }
      await remove(key);
    };
    await expect(cleanupPrismaPdfAcceptanceRun(prisma, m, external, save)).rejects.toThrow(
      "synthetic interrupted delete"
    );
    expect(
      (await prisma.pdfEvidenceAttempt.findUniqueOrThrow({ where: { id: identity.id } }))
        .acceptanceRunId
    ).toBe(m.runId);
    expect(await prisma.organization.count({ where: { id: { in: m.orgIds } } })).toBe(2);
    await expect(cleanupPrismaPdfAcceptanceRun(prisma, m, external, save)).resolves.toMatchObject({
      organizations: 0,
      attempts: 0,
      storageObjects: 0,
      qdrantPoints: 0
    });
    expect((await request("POST", "/points", { ids: [sentinelPoint] })).result).toHaveLength(1);
  });
  it("rejects unregistered objects/accounts and forged document/proof, retaining late-write recovery", async () => {
    const { m, external, identity, point } = await fixture("cleaned");
    const extra = await storage.putObject({
      orgId: m.orgIds[1],
      documentId: "extra",
      fileName: "extra.pdf",
      body: "extra"
    });
    await expect(cleanupPrismaPdfAcceptanceRun(prisma, m, external, save)).rejects.toThrow(
      /unregistered/i
    );
    await storage.deleteObject(extra.key);
    const unknown = await prisma.employee.create({
      data: {
        orgId: m.orgIds[1],
        email: `extra-${m.runId}@example.invalid`,
        displayName: "Unexpected",
        role: "employee",
        clearance: 0
      }
    });
    await expect(cleanupPrismaPdfAcceptanceRun(prisma, m, external, save)).rejects.toThrow(
      /unregistered/i
    );
    await prisma.employee.delete({ where: { id: unknown.id } });
    m.documentIds.push(sentinelDoc);
    await expect(cleanupPrismaPdfAcceptanceRun(prisma, m, external, save)).rejects.toThrow();
    m.documentIds.pop();
    m.settledAttemptIds = [identity.id]; // forged private claim must not establish DB proof
    await expect(cleanupPrismaPdfAcceptanceRun(prisma, m, external, save)).rejects.toThrow(
      /recovery required/i
    );
    expect(
      (await prisma.pdfEvidenceAttempt.findUniqueOrThrow({ where: { id: identity.id } }))
        .acceptanceRunId
    ).toBeNull();
    await request("PUT", "/points?wait=true", {
      points: [
        { id: point, vector: [1, 0], payload: { orgId: m.orgIds[0], documentId: m.documentIds[0] } }
      ]
    });
    await expect(cleanupPrismaPdfAcceptanceRun(prisma, m, external, save)).rejects.toThrow(
      /recovery required/i
    );
    expect((await request("POST", "/points", { ids: [point] })).result).toEqual([]);
    expect((await inventoryPdfAcceptanceRun(prisma, m, external)).attempts).toHaveLength(1);
  });
});
