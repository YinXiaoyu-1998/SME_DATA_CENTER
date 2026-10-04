import { randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { createDatabaseAdapter } from "@smedc/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPrismaLedgerReconciliation } from "./reconciliation.js";
import { createPrismaLedgerSourceReader } from "./source-reader.js";
import { createPrismaLedgerArchiveRepository } from "./repository.js";
import { createLedgerArchiveService } from "./service.js";
import { ledgerStoreNameHash } from "./keys.js";

const enabled = process.env["RUN_LEDGER_PRISMA_INTEGRATION"] === "1";
const databaseUrl = process.env["DATABASE_URL"] ?? "";
if (enabled) {
  const url = new URL(databaseUrl);
  if (!["127.0.0.1", "localhost"].includes(url.hostname) || !url.pathname.includes("ledger_test"))
    throw new Error("Local synthetic ledger_test database required");
}
(enabled ? describe : describe.skip)("durable reconciliation two-client integration", () => {
  const orgId = `ledger_reconcile_${randomUUID().slice(0, 8)}`;
  const key = { orgId, storeName: "Facts without index", purchaseDate: "2026-10-03" };
  const clock = new Date("2026-10-03T19:00:00Z");
  let first: PrismaClient, second: PrismaClient;
  let a: ReturnType<typeof createPrismaLedgerReconciliation>,
    b: ReturnType<typeof createPrismaLedgerReconciliation>;
  let reconciliationRunId: string;
  let documentId: string;
  const head = { headObject: async () => ({ state: "not_found" as const }) };
  async function claim() {
    const processing = await first.processingRun.findFirstOrThrow({
      where: { orgId, ledgerPdfReconciliationRunId: reconciliationRunId }
    });
    await first.processingRun.update({
      where: { id: processing.id },
      data: {
        status: "running",
        lockedBy: "synthetic-reconciler",
        lockedUntil: new Date(clock.getTime() + 60_000),
        attemptNumber: { increment: 1 }
      }
    });
    return {
      runId: processing.id,
      lockedBy: "synthetic-reconciler",
      attemptNumber: processing.attemptNumber + 1
    };
  }
  beforeAll(async () => {
    first = new PrismaClient({ adapter: createDatabaseAdapter(databaseUrl) });
    second = new PrismaClient({ adapter: createDatabaseAdapter(databaseUrl) });
    a = createPrismaLedgerReconciliation({ prisma: first, now: () => clock });
    b = createPrismaLedgerReconciliation({ prisma: second, now: () => clock });
    await first.organization.create({
      data: { id: orgId, name: "Synthetic reconciliation fixture" }
    });
    const uploader = await first.employee.create({
      data: {
        orgId,
        email: `${orgId}@example.invalid`,
        displayName: "Synthetic",
        role: "admin",
        clearance: 3
      }
    });
    const doc = await first.document.create({
      data: {
        orgId,
        uploaderId: uploader.id,
        title: "Synthetic ledger",
        documentType: "structured_dataset",
        documentKind: "structured",
        status: "active",
        storageObjectKey: `${orgId}/synthetic.xlsx`,
        checksumSha256: "a".repeat(64)
      }
    });
    documentId = doc.id;
    const batch = await first.importBatch.create({
      data: {
        orgId,
        sourceDocumentId: doc.id,
        dataset: "delivery_ledger",
        status: "applied",
        idempotencyKey: "source",
        requestFingerprint: "a".repeat(64)
      }
    });
    await first.deliveryLedgerRow.create({
      data: {
        orgId,
        sourceDocumentId: doc.id,
        importBatchId: batch.id,
        sourceRowNumber: 1,
        payload: {
          store_name: key.storeName,
          purchase_date: key.purchaseDate,
          receipt_id: "receipt",
          item_name: "Rice",
          purchase_quantity: "1.00",
          purchase_amount: "5.00"
        }
      }
    });
    await first.ledgerPdfPartition.createMany({
      data: ["Orphan A", "Orphan B", "Orphan C"].map((storeName) => ({
        orgId,
        storeName,
        storeNameHash: ledgerStoreNameHash(storeName),
        purchaseDate: new Date("2026-10-03T00:00:00Z"),
        currentObjectKey: `${orgId}/${storeName}.pdf`,
        byteSize: 12n,
        checksumSha256: "a".repeat(64)
      }))
    });
  });
  afterAll(async () => {
    const where = { orgId };
    await first.auditLog.deleteMany({ where });
    await first.processingRun.deleteMany({ where });
    await first.ledgerPdfReconciliationTarget.deleteMany({ where });
    await first.ledgerArtifactRequestItem.deleteMany({ where });
    await first.ledgerArtifactRequest.deleteMany({ where });
    await first.ledgerPdfSource.deleteMany({ where });
    await first.ledgerPdfPartition.deleteMany({ where });
    await first.ledgerPdfReconciliationRun.deleteMany({ where });
    await first.deliveryLedgerRow.deleteMany({ where });
    await first.importBatch.deleteMany({ where });
    await first.document.deleteMany({ where });
    await first.employee.deleteMany({ where });
    await first.organization.delete({ where: { id: orgId } });
    await Promise.all([first.$disconnect(), second.$disconnect()]);
  });
  it("deduplicates scheduling and resumes the oldest unfinished run before a new date", async () => {
    expect(await a.ensureDailyReconciliation({ enabled: false, orgId })).toBeUndefined();
    const results = await Promise.all(
      [a, b].map((service) => service.ensureDailyReconciliation({ enabled: true, orgId }))
    );
    expect(results).toEqual([undefined, undefined]);
    reconciliationRunId = (
      await first.ledgerPdfReconciliationRun.findFirstOrThrow({ where: { orgId } })
    ).id;
    expect(await first.ledgerPdfReconciliationRun.count({ where: { orgId } })).toBe(1);
    const run = await first.ledgerPdfReconciliationRun.findUniqueOrThrow({
      where: { id: reconciliationRunId }
    });
    expect(run.scheduleDate.toISOString().slice(0, 10)).toBe("2026-10-04");
    expect(
      await b.ensureDailyReconciliation({
        enabled: true,
        orgId,
        now: new Date("2026-10-20T19:00:00Z")
      })
    ).toBeUndefined();
    const processing = await first.processingRun.findFirstOrThrow({
      where: { orgId, ledgerPdfReconciliationRunId: reconciliationRunId }
    });
    expect(processing.priority).toBe(20);
  });
  it("discovers unindexed facts, recovers a page crash without duplicate refresh, checkpoints phases", async () => {
    const lease = await claim();
    const checkpoint = a.repository.checkpoint;
    a.repository.checkpoint = async () => {
      throw new Error("synthetic checkpoint interruption");
    };
    await expect(
      a.reconcileLedgerPage({ runId: reconciliationRunId, lease, storage: head })
    ).rejects.toThrow("checkpoint interruption");
    a.repository.checkpoint = checkpoint;
    expect(await first.ledgerArtifactRequest.count({ where: { orgId } })).toBe(1);
    const result = await b.reconcileLedgerPage({
      runId: reconciliationRunId,
      lease,
      storage: head
    });
    expect(result).toEqual({ done: false, phase: "index", nextCursor: null });
    const after = await first.ledgerPdfPartition.findUniqueOrThrow({
      where: {
        orgId_storeNameHash_purchaseDate: {
          orgId,
          storeNameHash: ledgerStoreNameHash(key.storeName),
          purchaseDate: new Date(`${key.purchaseDate}T00:00:00Z`)
        }
      }
    });
    expect(after.requestedGeneration).toBe(1);
    const listA = a.repository.listKeys;
    const listB = b.repository.listKeys;
    let arrivals = 0;
    let release!: () => void;
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    const gate =
      (list: typeof listA) =>
      async (...args: Parameters<typeof listA>) => {
        const page = await list(...args);
        if (++arrivals === 2) release();
        await barrier;
        return page;
      };
    a.repository.listKeys = gate(listA);
    b.repository.listKeys = gate(listB);
    const pageLease = await claim();
    const competingPages = await Promise.allSettled(
      [a, b].map((service) =>
        service.reconcileLedgerPage({
          runId: reconciliationRunId,
          lease: pageLease,
          storage: head,
          limit: 2
        })
      )
    );
    a.repository.listKeys = listA;
    b.repository.listKeys = listB;
    const winners = competingPages.filter((result) => result.status === "fulfilled");
    expect(winners).toHaveLength(1);
    expect(competingPages.filter((result) => result.status === "rejected")).toHaveLength(1);
    const next = winners[0]!.value;
    expect(next.phase).toBe("index");
    expect(next.nextCursor).not.toBeNull();
    const resumed = await b.reconcileLedgerPage({
      runId: reconciliationRunId,
      lease: await claim(),
      storage: head,
      limit: 2
    });
    expect(resumed.done).toBe(true);
    const state = await a.getReconciliationStatus(reconciliationRunId);
    expect(state).toMatchObject({
      scannedCount: 4,
      submittedCount: 4,
      scanCompleted: true,
      repairsCompleted: false,
      repairPending: 4,
      repairedCount: 0
    });
    expect(
      await first.processingRun.count({
        where: { orgId, jobType: "ledger_pdf_generate", priority: 20 }
      })
    ).toBe(4);
  });
  it("guards pointer and missed source changes under the lock and reuses retry-scheduled generation", async () => {
    // Reopen a synthetic scan solely to exercise exact lease guards against a completed checkpoint.
    await first.ledgerPdfReconciliationRun.update({
      where: { id: reconciliationRunId },
      data: { phase: "facts", status: "running" }
    });
    const lease = await claim();
    const state = await a.repository.getState(reconciliationRunId, lease);
    const observation = await a.repository.observe(key);
    await second.ledgerPdfPartition.update({
      where: { id: observation.partition!.id },
      data: { currentObjectKey: `${orgId}/newer.pdf`, byteSize: 13n }
    });
    await expect(
      a.repository.reserveRepair({ key, state, lease, ...observation, needsRepair: true })
    ).rejects.toThrow("OBSERVATION_STALE");
    expect(
      (
        await first.ledgerPdfPartition.findUniqueOrThrow({
          where: { id: observation.partition!.id }
        })
      ).requestedGeneration
    ).toBe(1);
    // Use a different synthetic schedule/run to avoid the prior page's idempotency reservation.
    const newRun = await first.ledgerPdfReconciliationRun.create({
      data: { orgId, scheduleDate: new Date("2026-10-05T00:00:00Z") }
    });
    const newJob = await first.processingRun.create({
      data: {
        orgId,
        jobKey: `ledger-reconcile:${newRun.id}`,
        jobType: "ledger_pdf_reconcile",
        ledgerPdfReconciliationRunId: newRun.id,
        status: "running",
        lockedBy: lease.lockedBy,
        lockedUntil: new Date(clock.getTime() + 60_000),
        attemptNumber: 1
      }
    });
    const newLease = { ...lease, runId: newJob.id, attemptNumber: 1 };
    const newState = await a.repository.getState(newRun.id, newLease);
    const fresh = await a.repository.observe(key);
    await second.document.update({
      where: { id: documentId },
      data: { checksumSha256: "b".repeat(64) }
    });
    await expect(
      a.repository.reserveRepair({
        key,
        state: newState,
        lease: newLease,
        ...fresh,
        needsRepair: true
      })
    ).rejects.toThrow("OBSERVATION_STALE");
    const generationJob = await first.processingRun.findFirstOrThrow({
      where: {
        orgId,
        jobType: "ledger_pdf_generate",
        ledgerArtifactRequestItem: { partitionId: observation.partition!.id }
      }
    });
    await first.processingRun.update({
      where: { id: generationJob.id },
      data: { status: "retry_scheduled" }
    });
    expect(
      await a.repository.reserveRepair({
        key,
        state: newState,
        lease: newLease,
        ...(await a.repository.observe(key)),
        needsRepair: true
      })
    ).toBe("inflight");
    expect(
      (
        await first.ledgerPdfPartition.findUniqueOrThrow({
          where: { id: observation.partition!.id }
        })
      ).requestedGeneration
    ).toBe(1);
    const sameObservation = await a.repository.observe(key);
    expect(
      await Promise.all(
        [a, b].map((service) =>
          service.repository.reserveRepair({
            key,
            state: newState,
            lease: newLease,
            ...sameObservation,
            needsRepair: true
          })
        )
      )
    ).toEqual(["inflight", "inflight"]);
    await expect(
      a.repository.getState(newRun.id, { ...newLease, attemptNumber: 0 })
    ).rejects.toThrow("LEASE_LOST");
    const source = createPrismaLedgerSourceReader({ prisma: first });
    expect((await source.readLedgerSourceMetadata(key)).sourceFingerprint).toBe(
      (await source.readLedgerSnapshot(key)).sourceFingerprint
    );
    expect(
      await first.ledgerPdfReconciliationTarget.count({
        where: { orgId, reconciliationRunId: newRun.id }
      })
    ).toBe(1);
    const tracked = await first.ledgerPdfReconciliationTarget.findFirstOrThrow({
      where: { orgId, reconciliationRunId: newRun.id },
      include: { requestItem: true }
    });
    expect(tracked.requestItem.generation).toBe(1);
    await first.ledgerPdfReconciliationRun.update({
      where: { id: newRun.id },
      data: { phase: "completed", status: "succeeded" }
    });
    expect(await a.getReconciliationStatus(newRun.id)).toMatchObject({
      scanCompleted: true,
      repairsCompleted: false,
      repairTargetCount: 1,
      repairedCount: 0,
      repairPending: 1
    });
    await first.ledgerArtifactRequestItem.update({
      where: { id: tracked.requestItemId },
      data: { status: "succeeded" }
    });
    expect(await a.getReconciliationStatus(newRun.id)).toMatchObject({
      repairsCompleted: true,
      repairedCount: 1
    });
    await first.ledgerArtifactRequestItem.update({
      where: { id: tracked.requestItemId },
      data: { status: "failed" }
    });
    const manual = await createLedgerArchiveService(
      createPrismaLedgerArchiveRepository({ prisma: second })
    ).requestPartitionRefresh({
      key,
      actor: { kind: "operator", label: "synthetic later manual refresh" },
      idempotencyKey: "later-manual",
      onlyIfNeeded: false
    });
    await second.ledgerArtifactRequestItem.updateMany({
      where: { orgId, requestId: manual!.requestId },
      data: { status: "succeeded" }
    });
    expect(await a.getReconciliationStatus(newRun.id)).toMatchObject({
      repairsCompleted: false,
      repairTargetCount: 1,
      repairFailedCount: 1,
      repairedCount: 0
    });
    await first.ledgerArtifactRequestItem.update({
      where: { id: tracked.requestItemId },
      data: { status: "superseded" }
    });
    expect(await a.getReconciliationStatus(newRun.id)).toMatchObject({
      repairsCompleted: false,
      repairSupersededCount: 1,
      repairedCount: 0
    });
    await first.processingRun.update({ where: { id: newJob.id }, data: { lockedUntil: clock } });
    await expect(
      a.repository.reserveRepair({
        key,
        state: newState,
        lease: newLease,
        ...(await a.repository.observe(key)),
        needsRepair: true
      })
    ).rejects.toThrow("LEASE_LOST");
  });
});
