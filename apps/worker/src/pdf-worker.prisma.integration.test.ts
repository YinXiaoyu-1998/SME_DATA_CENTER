import { createHash, randomUUID } from "node:crypto";
import { PrismaEvidenceRevalidator } from "../../api/src/evidence.js";
import { PrismaMariaDb } from "@prisma/adapter-mariadb";
import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPrismaProcessingWorkerRepository } from "./worker.js";
import type { EvidenceIndexingResult } from "./worker.js";
import {
  pdfCandidateIdentity,
  reconcilePdfEvidenceAttempt,
  type PdfEvidenceAttempt
} from "./evidence-artifacts.js";
const enabled = process.env["RUN_PDF_WORKER_PRISMA_INTEGRATION"] === "1";
const url = process.env["DATABASE_URL"] ?? "";
const orgId = `pdf-worker-${randomUUID().slice(0, 8)}`;
const employeeId = `pwe_${randomUUID().slice(0, 16)}`;
const now = new Date();
const config = `phase3.retrieval.${orgId}`;
(enabled ? describe : describe.skip)("isolated real Prisma PDF candidate worker", () => {
  const prisma = new PrismaClient({ adapter: new PrismaMariaDb(url) });
  const repository = createPrismaProcessingWorkerRepository(url, {
    evidenceRetrievalConfigVersion: config
  });
  let baseline: unknown;
  beforeAll(async () => {
    const ownedCi =
      process.env["CI"] === "true" &&
      process.env["COMPOSE_PROJECT_NAME"] === "sme_data_center_ci" &&
      url === "mysql://smedc:smedc_local_password@127.0.0.1:3307/smedc";
    if (url !== "mysql://smedc:smedc_local_password@127.0.0.1:13307/smedc" && !ownedCi)
      throw new Error("Dedicated local PDF DB required.");
    baseline = await prisma.document.findMany({
      where: { orgId: "pdf-migration-baseline" },
      include: { chunks: true, indexes: true }
    });
    await prisma.organization.create({ data: { id: orgId, name: "Synthetic PDF worker" } });
    await prisma.employee.create({
      data: {
        id: employeeId,
        orgId,
        email: `${orgId}@example.invalid`,
        displayName: "Synthetic",
        role: "employee",
        clearance: 0
      }
    });
  });
  afterAll(async () => {
    await prisma.pdfEvidenceAttempt.deleteMany({ where: { orgId } });
    await prisma.auditLog.deleteMany({ where: { orgId } });
    await prisma.processingRun.deleteMany({ where: { orgId } });
    await prisma.document.deleteMany({ where: { orgId } });
    await prisma.retrievalConfig.deleteMany({ where: { version: config } });
    await prisma.employee.deleteMany({ where: { id: employeeId } });
    await prisma.organization.deleteMany({ where: { id: orgId } });
    expect(
      await prisma.document.findMany({
        where: { orgId: "pdf-migration-baseline" },
        include: { chunks: true, indexes: true }
      })
    ).toEqual(baseline);
    await repository.disconnect?.();
    await prisma.$disconnect();
  });
  async function fixture(label: string, fileType: "pdf" | "md" | null = "pdf") {
    const id = `pd_${label}_${randomUUID().slice(0, 8)}`;
    const runId = `pr_${randomUUID().slice(0, 16)}`;
    await prisma.document.create({
      data: {
        id,
        orgId,
        uploaderId: employeeId,
        documentType: "raw_material",
        documentKind: "evidence",
        title: "Synthetic",
        status: "pending_processing",
        fileType,
        storageObjectKey: `synthetic/${id}`,
        originalFileName: `${id}.${fileType}`,
        checksumSha256: "a".repeat(64),
        confidentialityLevel: 0
      }
    });
    await prisma.processingRun.create({
      data: {
        id: runId,
        orgId,
        documentId: id,
        jobType: "evidence_document_index",
        jobKey: `evidence_document_index:${id}:1:${config}`,
        availableAt: now
      }
    });
    return { id, runId };
  }
  async function claim(workerId = "pdf-test") {
    return repository.claimNextProcessingRun({ workerId, now, leaseSeconds: 120, jobScope: "pdf" });
  }
  async function candidate(run: NonNullable<Awaited<ReturnType<typeof claim>>>, suffix = "") {
    const identity = pdfCandidateIdentity(run, "a".repeat(64), `fp${suffix}`, config);
    const point = createHash("sha256").update(identity.generation).digest("hex").slice(0, 32);
    const attempt: PdfEvidenceAttempt = {
      ...identity,
      orgId,
      documentId: run.documentId,
      runId: run.id,
      attemptNumber: run.attemptNumber,
      contentVersion: 1,
      retrievalConfigVersion: config,
      parserFingerprint: `fp${suffix}`,
      collection: "synthetic",
      pointIds: [point],
      state: "staged"
    };
    await repository.pdfArtifacts!.stage({ attempt, workerId: "pdf-test", now });
    const result: EvidenceIndexingResult = {
      retrievalConfigVersion: config,
      qdrantCollection: "synthetic",
      embeddingProvider: "fake",
      embeddingModel: "fake",
      embeddingVersion: "v1",
      embeddingDimension: 8,
      lexicalIndexVersion: "v1",
      rerankProvider: null,
      rerankModel: null,
      rerankVersion: null,
      parserFingerprint: attempt.parserFingerprint,
      parsedObjectKey: attempt.parsedObjectKey,
      parseSummary: { pageCount: 1, complete: true },
      pdfAttemptId: attempt.id,
      chunks: [
        {
          documentId: run.documentId,
          chunkIndex: 0,
          chunkText: "synthetic text",
          chunkHash: "a".repeat(64),
          indexType: "evidence",
          chunkId: `chk_${point}`,
          qdrantPointId: point,
          contentVersion: 1,
          retrievalConfigVersion: config,
          modelName: "fake",
          modelVersion: "v1",
          sourceLocation: { sourceLocations: [{ pageNumber: 1, method: "native" }] }
        }
      ]
    };
    return { attempt, result };
  }
  async function visible(results: EvidenceIndexingResult[]) {
    return new PrismaEvidenceRevalidator(prisma).revalidate({
      orgId,
      employee: {
        id: employeeId,
        orgId,
        organizationName: "Synthetic",
        displayName: "Synthetic",
        email: `${orgId}@example.invalid`,
        role: "employee",
        clearance: 0,
        disabled: false
      },
      filters: { documentIds: [], fileTypes: [] },
      candidates: results.flatMap((result) =>
        result.chunks.map((chunk) => ({
          chunkId: chunk.chunkId,
          documentId: chunk.documentId,
          qdrantPointId: chunk.qdrantPointId,
          contentVersion: chunk.contentVersion,
          retrievalConfigVersion: chunk.retrievalConfigVersion,
          text: chunk.chunkText,
          hybridScore: 1,
          matchedBy: ["dense"]
        }))
      )
    });
  }
  async function activate(runId: string, documentId: string, result: EvidenceIndexingResult) {
    return repository.completeEvidenceIndexing!({
      runId,
      documentId,
      workerId: "pdf-test",
      now,
      result,
      chunks: result.chunks
    });
  }
  it("general excludes PDF; PDF excludes MD and other jobs", async () => {
    const pdf = await fixture("scope");
    const md = await fixture("scope", "md");
    const untyped = await fixture("untyped", null);
    const general = await repository.claimNextProcessingRun({
      workerId: "general-test",
      now,
      leaseSeconds: 120,
      jobScope: "general"
    });
    expect(general?.documentId).toBe(md.id);
    expect(
      (
        await repository.claimNextProcessingRun({
          workerId: "general-test",
          now,
          leaseSeconds: 120,
          jobScope: "general"
        })
      )?.documentId
    ).toBe(untyped.id);
    expect((await claim())?.documentId).toBe(pdf.id);
    expect(await claim()).toBeNull();
    await prisma.processingRun.updateMany({
      where: { id: { in: [pdf.runId, md.runId, untyped.runId] } },
      data: { status: "failed", lockedBy: null, lockedUntil: null }
    });
  });
  it("keeps old ready PDF available through claim/retry/terminal failure, then replaces chunks atomically", async () => {
    const f = await fixture("preserve");
    const run = (await claim())!;
    const first = await candidate(run, "first");
    await activate(f.runId, f.id, first.result);
    await prisma.processingRun.update({
      where: { id: f.runId },
      data: { status: "queued", availableAt: now }
    });
    const retry = (await claim())!;
    expect(retry.document?.status).toBe("active");
    expect(await visible([first.result])).toHaveLength(1);
    const second = await candidate(retry, "second");
    expect((await visible([first.result, second.result])).map((c) => c.qdrantPointId)).toEqual(
      first.attempt.pointIds
    );
    expect(await prisma.documentChunk.findMany({ where: { documentId: f.id } })).toMatchObject([
      { qdrantPointId: first.attempt.pointIds[0] }
    ]);
    await repository.failProcessingRun({
      runId: f.runId,
      documentId: f.id,
      workerId: "pdf-test",
      now,
      errorCode: "PDF_BUSY",
      errorSummary: "Synthetic failure",
      willRetry: true,
      nextAvailableAt: now
    });
    expect((await prisma.document.findUniqueOrThrow({ where: { id: f.id } })).status).toBe(
      "active"
    );
    expect(await visible([first.result])).toHaveLength(1);
    const terminal = (await claim())!;
    await repository.failProcessingRun({
      runId: f.runId,
      documentId: f.id,
      workerId: "pdf-test",
      now,
      errorCode: "PDF_TIMEOUT",
      errorSummary: "Synthetic failure",
      willRetry: false,
      nextAvailableAt: now
    });
    expect((await prisma.document.findUniqueOrThrow({ where: { id: f.id } })).status).toBe(
      "active"
    );
    expect(await visible([first.result])).toHaveLength(1);
    const deleted: string[] = [];
    await reconcilePdfEvidenceAttempt({
      attempt: second.attempt,
      repository: repository.pdfArtifacts!,
      storage: {
        async deleteObject(key) {
          deleted.push(key);
        }
      },
      qdrantWriter: {
        async deleteEvidencePoints({ pointIds }) {
          deleted.push(...pointIds);
        }
      },
      now
    });
    expect(deleted).toEqual([...second.attempt.pointIds, second.attempt.parsedObjectKey]);
    expect(deleted).not.toContain(first.attempt.parsedObjectKey);
    await prisma.processingRun.update({
      where: { id: f.runId },
      data: { status: "queued", availableAt: now }
    });
    const final = (await claim())!;
    const third = await candidate(final, "third");
    await activate(f.runId, f.id, third.result);
    expect(await prisma.documentChunk.findMany({ where: { documentId: f.id } })).toMatchObject([
      { qdrantPointId: third.attempt.pointIds[0] }
    ]);
    expect(await prisma.documentChunk.count({ where: { documentId: f.id } })).toBe(1);
    expect(
      (await visible([first.result, second.result, third.result])).map((c) => c.qdrantPointId)
    ).toEqual(third.attempt.pointIds);
    expect(
      (await prisma.documentIndex.findFirstOrThrow({ where: { documentId: f.id } })).parsedObjectKey
    ).toBe(third.attempt.parsedObjectKey);
    expect(terminal.attemptNumber).toBeGreaterThan(retry.attemptNumber);
  });
  it("rollback after point staging is invisible and cleanup prevents later activation", async () => {
    const f = await fixture("rollback");
    const run = (await claim())!;
    const c = await candidate(run);
    const invalid = {
      ...c.result,
      chunks: c.result.chunks.map((chunk) => ({ ...chunk, modelName: "x".repeat(256) }))
    };
    await expect(activate(f.runId, f.id, invalid)).rejects.toThrow();
    expect(await prisma.documentChunk.count({ where: { documentId: f.id } })).toBe(0);
    expect(await prisma.documentIndex.count({ where: { documentId: f.id } })).toBe(0);
    expect(await repository.pdfArtifacts!.claimCleanup({ id: c.attempt.id, now })).toBe("live");
    expect(
      await repository.pdfArtifacts!.claimCleanup({
        id: c.attempt.id,
        now,
        settledWorkerId: "pdf-test"
      })
    ).toBe("cleanup");
    await expect(activate(f.runId, f.id, c.result)).rejects.toThrow();
    expect(await prisma.documentChunk.count({ where: { documentId: f.id } })).toBe(0);
    await prisma.processingRun.update({
      where: { id: f.runId },
      data: { status: "failed", lockedBy: null, lockedUntil: null }
    });
  });
  it("serializes activation and cleanup so a committed candidate is retained", async () => {
    const f = await fixture("race");
    const run = (await claim())!;
    const c = await candidate(run);
    const outcomes = await Promise.allSettled([
      activate(f.runId, f.id, c.result),
      repository.pdfArtifacts!.claimCleanup({ id: c.attempt.id, now, settledWorkerId: "pdf-test" })
    ]);
    const chunks = await prisma.documentChunk.findMany({ where: { documentId: f.id } });
    if (chunks.length) {
      expect(outcomes[0].status).toBe("fulfilled");
      expect(await repository.pdfArtifacts!.claimCleanup({ id: c.attempt.id, now })).toBe("owned");
    } else {
      expect(outcomes[0].status).toBe("rejected");
      expect(
        (await prisma.pdfEvidenceAttempt.findUniqueOrThrow({ where: { id: c.attempt.id } })).state
      ).toBe("cleanup");
    }
    await prisma.processingRun.update({
      where: { id: f.runId },
      data: { status: "failed", lockedBy: null, lockedUntil: null }
    });
  });
  it("allows only one concurrent claim of an expired PDF lease", async () => {
    const f = await fixture("claimrace");
    await prisma.processingRun.update({
      where: { id: f.runId },
      data: { status: "running", lockedBy: "dead", lockedUntil: new Date(now.getTime() - 1000) }
    });
    const claims = await Promise.all([claim("pdf-race-a"), claim("pdf-race-b")]);
    expect(claims.filter(Boolean)).toHaveLength(1);
    await prisma.processingRun.update({
      where: { id: f.runId },
      data: { status: "failed", lockedBy: null, lockedUntil: null }
    });
  });
  it("defers cleaned manifest recovery and preserves exact IDs for late writes", async () => {
    const f = await fixture("retained");
    const run = (await claim())!;
    const c = await candidate(run);
    await repository.pdfArtifacts!.claimCleanup({
      id: c.attempt.id,
      now,
      settledWorkerId: "pdf-test"
    });
    await repository.pdfArtifacts!.finishCleanup(c.attempt.id);
    const record = await prisma.pdfEvidenceAttempt.findUniqueOrThrow({
      where: { id: c.attempt.id }
    });
    expect(record.state).toBe("cleaned");
    expect(record.pointIds).toEqual(c.attempt.pointIds);
    expect(
      (await repository.pdfArtifacts!.listRecoverable({ now: new Date(), limit: 10 })).map(
        (a) => a.id
      )
    ).not.toContain(c.attempt.id);
    await prisma.processingRun.update({
      where: { id: f.runId },
      data: { status: "failed", lockedBy: null, lockedUntil: null }
    });
  });
  it.each(["expired", "archived"] as const)("cannot activate an %s PDF candidate", async (mode) => {
    const f = await fixture(mode);
    const run = (await claim())!;
    const c = await candidate(run);
    if (mode === "expired")
      await prisma.processingRun.update({
        where: { id: f.runId },
        data: { lockedUntil: new Date(Date.now() - 1000) }
      });
    else
      await prisma.document.update({
        where: { id: f.id },
        data: { status: "archived", archivedAt: new Date() }
      });
    await expect(
      repository.completeEvidenceIndexing!({
        runId: f.runId,
        documentId: f.id,
        workerId: "pdf-test",
        now: mode === "expired" ? new Date(now.getTime() - 5000) : now,
        result: c.result,
        chunks: c.result.chunks
      })
    ).rejects.toThrow();
    expect(await visible([c.result])).toEqual([]);
    await prisma.processingRun.update({
      where: { id: f.runId },
      data: { status: "failed", lockedBy: null, lockedUntil: null }
    });
  });
  it("rejects a forged cleanup resource list instead of deleting another attempt", async () => {
    const f = await fixture("forged");
    const run = (await claim())!;
    const c = await candidate(run);
    await prisma.processingRun.update({
      where: { id: f.runId },
      data: { status: "failed", lockedBy: null, lockedUntil: null }
    });
    const deleted: string[] = [];
    await expect(
      reconcilePdfEvidenceAttempt({
        attempt: { ...c.attempt, parsedObjectKey: "other-attempt.json", pointIds: ["other-point"] },
        repository: repository.pdfArtifacts!,
        storage: {
          async deleteObject(key) {
            deleted.push(key);
          }
        },
        qdrantWriter: {
          async deleteEvidencePoints({ pointIds }) {
            deleted.push(...pointIds);
          }
        },
        now
      })
    ).rejects.toThrow("PDF manifest ownership does not match.");
    expect(deleted).toEqual([]);
  });
});
