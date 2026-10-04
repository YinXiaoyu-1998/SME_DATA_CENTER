import type { StorageAdapter } from "@smedc/storage";
import { randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createDatabaseAdapter,
  enqueueStorageGarbage,
  listDueStorageGarbage,
  storageGarbageKeyHash,
  createPrismaStructuredPartitionRepository
} from "@smedc/db";
import {
  createPrismaProcessingWorkerRepository,
  ProcessingLeaseLostError,
  runWorkerOnce
} from "../../../apps/worker/src/worker.js";
import { createPrismaLedgerArchiveRepository } from "./repository.js";
import { createPrismaLedgerPublicationArchive, type PublishLedgerPdfInput } from "./publication.js";
const enabled = process.env["RUN_LEDGER_PRISMA_INTEGRATION"] === "1";
const databaseUrl = process.env["DATABASE_URL"] ?? "";
if (enabled) {
  const url = new URL(databaseUrl);
  if (!["localhost", "127.0.0.1"].includes(url.hostname) || !url.pathname.includes("ledger_test"))
    throw new Error("Local synthetic ledger_test required");
}
(enabled ? describe : describe.skip)("fenced ledger publication and exact garbage", () => {
  const orgId = `ledger_pub_${randomUUID().slice(0, 8)}`;
  const prisma = new PrismaClient({ adapter: createDatabaseAdapter(databaseUrl) });
  const competing = new PrismaClient({ adapter: createDatabaseAdapter(databaseUrl) });
  const archive = createPrismaLedgerArchiveRepository({ prisma });
  const publication = createPrismaLedgerPublicationArchive({ prisma });
  const worker = createPrismaProcessingWorkerRepository(databaseUrl);
  const otherWorker = createPrismaProcessingWorkerRepository(databaseUrl);
  const garbageKeys: string[] = [];
  let sourceId: string;
  const sourceChecksum = "a".repeat(64);
  const date = "2026-10-01";
  beforeAll(async () => {
    await prisma.organization.create({ data: { id: orgId, name: "Synthetic publication" } });
    const employee = await prisma.employee.create({
      data: {
        orgId,
        email: `${orgId}@example.invalid`,
        displayName: "Synthetic",
        role: "admin",
        clearance: 3
      }
    });
    const source = await prisma.document.create({
      data: {
        orgId,
        uploaderId: employee.id,
        title: "Synthetic source",
        documentType: "raw_material",
        status: "active",
        documentKind: "structured",
        fileType: "csv",
        storageObjectKey: `synthetic/${orgId}/source`,
        checksumSha256: sourceChecksum,
        byteSize: 10n,
        confidentialityLevel: 1
      }
    });
    sourceId = source.id;
    await prisma.importBatch.create({
      data: {
        orgId,
        sourceDocumentId: source.id,
        dataset: "delivery_ledger",
        idempotencyKey: `${orgId}-source`,
        requestFingerprint: "e".repeat(64),
        status: "applied",
        appliedRowCount: 1,
        totalRowCount: 1
      }
    });
  });
  afterAll(async () => {
    await prisma.storageGarbage.deleteMany({ where: { objectKey: { in: garbageKeys } } });
    await prisma.auditLog.deleteMany({ where: { orgId } });
    await prisma.processingRun.deleteMany({ where: { orgId } });
    await prisma.ledgerPdfSource.deleteMany({ where: { orgId } });
    await prisma.ledgerArtifactRequestItem.deleteMany({ where: { orgId } });
    await prisma.ledgerArtifactRequest.deleteMany({ where: { orgId } });
    await prisma.ledgerPdfPartition.deleteMany({ where: { orgId } });
    await prisma.importBatch.deleteMany({ where: { orgId } });
    await prisma.document.deleteMany({ where: { orgId } });
    await prisma.employee.deleteMany({ where: { orgId } });
    await prisma.organization.delete({ where: { id: orgId } });
    await Promise.all([
      prisma.$disconnect(),
      competing.$disconnect(),
      worker.disconnect?.(),
      otherWorker.disconnect?.()
    ]);
  });
  async function reserve(storeName: string) {
    const result = await archive.reserveRefresh({
      orgId,
      actor: { kind: "operator", label: "synthetic" },
      idempotencyKey: randomUUID(),
      requestFingerprint: "b".repeat(64),
      scope: { storeNames: [storeName], dates: [date] },
      keys: [{ orgId, storeName, purchaseDate: date }]
    });
    const item = await prisma.ledgerArtifactRequestItem.findFirstOrThrow({
      where: { requestId: result!.requestId }
    });
    const run = await prisma.processingRun.findFirstOrThrow({
      where: { ledgerArtifactRequestItemId: item.id }
    });
    await prisma.processingRun.update({
      where: { id: run.id },
      data: {
        status: "running",
        attemptNumber: 1,
        lockedBy: "synthetic-worker",
        lockedUntil: new Date(Date.now() + 120_000)
      }
    });
    const candidateKey = `synthetic/${orgId}/${randomUUID()}.pdf`;
    garbageKeys.push(candidateKey);
    const input: PublishLedgerPdfInput = {
      partitionId: item.partitionId,
      generation: item.generation,
      dataRevision: 0,
      sourceFingerprint: "f".repeat(64),
      leaseToken: { runId: run.id, lockedBy: "synthetic-worker", attemptNumber: 1 },
      candidate: {
        objectKey: candidateKey,
        byteSize: 10,
        checksumSha256: "d".repeat(64),
        pageCount: 1
      },
      sources: [
        {
          sourceDocumentId: sourceId,
          kind: "ledger",
          confidentialityLevel: 1,
          checksumSha256: sourceChecksum
        }
      ],
      rowCount: 1,
      certificateCount: 0
    };
    await publication.registerCandidate({
      orgId,
      leaseToken: input.leaseToken,
      objectKey: candidateKey
    });
    return { item, run, input };
  }
  it("atomically publishes, replaces old PDF, and empty revokes only derived state", async () => {
    const first = await reserve("Atomic");
    expect(await publication.publishLedgerPdf(first.input)).toBe("published");
    expect(
      await prisma.storageGarbage.findUnique({
        where: { objectKeyHash: storageGarbageKeyHash(first.input.candidate!.objectKey) }
      })
    ).toBeNull();
    const second = await reserve("Atomic");
    expect(await publication.publishLedgerPdf(second.input)).toBe("published");
    expect(
      await prisma.storageGarbage.findUnique({
        where: { objectKeyHash: storageGarbageKeyHash(first.input.candidate!.objectKey) }
      })
    ).toMatchObject({ reason: "ledger_pdf_replaced" });
    const empty = await reserve("Atomic");
    expect(
      await publication.publishLedgerPdf({
        ...empty.input,
        candidate: null,
        sources: [],
        rowCount: 0
      })
    ).toBe("published");
    expect(
      await prisma.ledgerPdfPartition.findUnique({ where: { id: first.item.partitionId } })
    ).toMatchObject({ currentObjectKey: null, rowCount: 0 });
    expect(await prisma.document.count({ where: { orgId, id: sourceId } })).toBe(1);
    expect(await prisma.importBatch.count({ where: { orgId, sourceDocumentId: sourceId } })).toBe(
      1
    );
  });
  it("new generation finishes first and old attempt cannot overwrite it", async () => {
    const old = await reserve("Generation");
    const current = await reserve("Generation");
    expect(await publication.publishLedgerPdf(current.input)).toBe("published");
    expect(await publication.publishLedgerPdf(old.input)).toBe("superseded");
    expect(
      await prisma.ledgerPdfPartition.findUnique({ where: { id: old.item.partitionId } })
    ).toMatchObject({
      currentObjectKey: current.input.candidate!.objectKey,
      publishedGeneration: current.item.generation
    });
    expect(await listDueStorageGarbage(prisma, new Date(), 1000)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ objectKey: old.input.candidate!.objectKey })
      ])
    );
  });
  it("same-generation revision change requeues its job and the next attempt publishes fresh data", async () => {
    const previous = await reserve("Revision");
    await publication.publishLedgerPdf(previous.input);
    const value = await reserve("Revision");
    await prisma.ledgerPdfPartition.update({
      where: { id: value.item.partitionId },
      data: { dataRevision: { increment: 1 } }
    });
    const now = new Date();
    await prisma.processingRun.update({
      where: { id: value.run.id },
      data: {
        status: "queued",
        attemptNumber: 0,
        lockedBy: null,
        lockedUntil: null,
        availableAt: new Date(0),
        priority: -101
      }
    });
    const latestKey = `synthetic/${orgId}/${randomUUID()}.pdf`;
    garbageKeys.push(latestKey);
    const handler = {
      async process({
        run
      }: {
        run: { id: string; lockedBy: string | null; attemptNumber: number };
      }) {
        const leaseToken = {
          runId: run.id,
          lockedBy: run.lockedBy!,
          attemptNumber: run.attemptNumber
        };
        if (run.attemptNumber === 1)
          return publication.publishLedgerPdf({ ...value.input, leaseToken });
        const current = await prisma.ledgerPdfPartition.findUniqueOrThrow({
          where: { id: value.item.partitionId }
        });
        await publication.registerCandidate({ orgId, leaseToken, objectKey: latestKey });
        return publication.publishLedgerPdf({
          ...value.input,
          leaseToken,
          dataRevision: current.dataRevision,
          candidate: { ...value.input.candidate!, objectKey: latestKey }
        });
      }
    };
    const input = {
      repository: worker,
      storage: {} as StorageAdapter,
      ledgerJobs: { ledger_pdf_generate: handler },
      workerId: "synthetic-worker",
      retryBaseMs: 1
    };
    expect(await runWorkerOnce({ ...input, now: () => now })).toMatchObject({
      status: "retry_scheduled"
    });
    expect(
      await prisma.processingRun.findUniqueOrThrow({ where: { id: value.run.id } })
    ).toMatchObject({
      status: "retry_scheduled",
      attemptNumber: 1,
      errorCode: "LEDGER_SOURCE_CHANGED"
    });
    expect(
      await prisma.ledgerArtifactRequestItem.findUniqueOrThrow({ where: { id: value.item.id } })
    ).toMatchObject({ status: "queued", generation: value.item.generation });
    expect(
      await prisma.ledgerPdfPartition.findUniqueOrThrow({ where: { id: value.item.partitionId } })
    ).toMatchObject({ currentObjectKey: previous.input.candidate!.objectKey });
    expect(await runWorkerOnce({ ...input, now: () => new Date(now.getTime() + 5) })).toMatchObject(
      { status: "active" }
    );
    expect(
      await prisma.processingRun.findUniqueOrThrow({ where: { id: value.run.id } })
    ).toMatchObject({
      status: "succeeded",
      attemptNumber: 2,
      ledgerArtifactRequestItemId: value.item.id
    });
    expect(
      await prisma.ledgerPdfPartition.findUniqueOrThrow({ where: { id: value.item.partitionId } })
    ).toMatchObject({
      currentObjectKey: latestKey,
      publishedDataRevision: 1,
      publishedGeneration: value.item.generation
    });
  });
  it("invalid source rolls back publication and preserves its candidate registration", async () => {
    const previous = await reserve("Invalid");
    await publication.publishLedgerPdf(previous.input);
    const value = await reserve("Invalid");
    await prisma.document.update({
      where: { id: sourceId },
      data: { status: "processing_failed" }
    });
    await expect(publication.publishLedgerPdf(value.input)).rejects.toThrow(
      "LEDGER_SOURCE_CHANGED"
    );
    expect(
      await prisma.ledgerPdfPartition.findUnique({ where: { id: value.item.partitionId } })
    ).toMatchObject({ currentObjectKey: previous.input.candidate!.objectKey });
    expect(
      await prisma.storageGarbage.findUnique({
        where: { objectKeyHash: storageGarbageKeyHash(value.input.candidate!.objectKey) }
      })
    ).not.toBeNull();
    await prisma.document.update({ where: { id: sourceId }, data: { status: "active" } });
  });
  it("protects live uploads even after delay, retains exact long/case keys and tombstones", async () => {
    const value = await reserve("Garbage");
    const keys = [
      `synthetic/${orgId}/${"X".repeat(800)}`,
      `synthetic/${orgId}/Case`,
      `synthetic/${orgId}/case`,
      `synthetic/${orgId}/case `
    ];
    garbageKeys.push(...keys);
    for (const objectKey of keys)
      await enqueueStorageGarbage(prisma, { objectKey, reason: "synthetic" });
    await enqueueStorageGarbage(prisma, {
      objectKey: value.input.candidate!.objectKey,
      reason: "ledger_upload_candidate",
      processingRunId: value.run.id,
      availableAt: new Date(0)
    });
    const due = await listDueStorageGarbage(prisma, new Date(), 1000);
    expect(due.map((item) => item.objectKey)).toEqual(expect.arrayContaining(keys));
    expect(due.map((item) => item.objectKey)).not.toContain(value.input.candidate!.objectKey);
    await prisma.processingRun.update({
      where: { id: value.run.id },
      data: { lockedUntil: new Date(0) }
    });
    const expired = await listDueStorageGarbage(prisma, new Date(), 1000);
    const candidate = expired.find((item) => item.objectKey === value.input.candidate!.objectKey)!;
    expect(candidate).toBeDefined();
    await createPrismaStructuredPartitionRepository({ prisma }).deleteGarbage(candidate.id);
    expect(await prisma.storageGarbage.findUnique({ where: { id: candidate.id } })).toMatchObject({
      repeatDeletion: true
    });
  });
  it("two expired-run reclaimers elect one attempt and stale failure with reused workerId cannot mutate it", async () => {
    // Keep only this run claimable within the shared synthetic organization.
    await prisma.processingRun.updateMany({
      where: { orgId, status: "running" },
      data: { status: "failed", lockedBy: null, lockedUntil: null }
    });
    const value = await reserve("Reclaim");
    const now = new Date();
    await prisma.processingRun.update({
      where: { id: value.run.id },
      data: {
        lockedUntil: new Date(now.getTime() - 1000),
        availableAt: new Date("1900-01-01"),
        priority: -100
      }
    });
    const result = await Promise.all([
      worker.claimNextProcessingRun({ workerId: "synthetic-worker", now, leaseSeconds: 120 }),
      otherWorker.claimNextProcessingRun({ workerId: "synthetic-worker", now, leaseSeconds: 120 })
    ]);
    expect(result.filter(Boolean)).toHaveLength(1);
    const winner = result.find(Boolean)!;
    expect(winner.id).toBe(value.run.id);
    expect(winner.attemptNumber).toBe(2);
    await expect(
      worker.failProcessingRun({
        runId: value.run.id,
        attemptNumber: 1,
        documentId: value.run.id,
        workerId: "synthetic-worker",
        now,
        errorCode: "STALE",
        errorSummary: "synthetic stale",
        willRetry: false,
        nextAvailableAt: now
      })
    ).rejects.toBeInstanceOf(ProcessingLeaseLostError);
    await expect(publication.publishLedgerPdf(value.input)).rejects.toThrow(
      "PROCESSING_LEASE_LOST"
    );
    expect(await prisma.processingRun.findUnique({ where: { id: value.run.id } })).toMatchObject({
      status: "running",
      attemptNumber: 2
    });
  });
});
