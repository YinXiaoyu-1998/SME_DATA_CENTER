import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createReadStream } from "node:fs";
import { Prisma, PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  FIXED_BUSINESS_CATEGORY_KEYS,
  canReadResource,
  COST_CARD_UPLOAD_SCHEMA,
  costCardFromRows
} from "@smedc/domain";
import { exportCostCardCsv } from "@smedc/structured-ingestion";
import { LocalFileSystemStorageAdapter } from "@smedc/storage";
import { createPrismaProcessingWorkerRepository } from "../../../apps/worker/src/worker.js";
import { createDatabaseAdapter } from "./adapter.js";
import { createBusinessAuthorizationRepository } from "./business-authorization.js";
import { toResourceReadRequirement } from "./business-authorization-records.js";
import { createPrismaStructuredPartitionRepository } from "./structured-partitions.js";
import {
  archiveCostCard,
  costCardIdentityKey,
  costCardOperation,
  createCostCardId,
  publishCostCards,
  readCostCardBaselines,
  type CostCardPublishInput
} from "./cost-cards.js";
import {
  canDeleteStorageGarbage,
  enqueueStorageGarbage,
  listDueStorageGarbage
} from "./storage-garbage.js";

const suite = process.env["RUN_COST_CARD_PRISMA_INTEGRATION"] === "1" ? describe : describe.skip;
suite("cost cards: real atomic directory and storage lifecycle", () => {
  const prisma = new PrismaClient({
    adapter: createDatabaseAdapter(process.env["DATABASE_URL"] ?? "")
  });
  const repository = createBusinessAuthorizationRepository({ prisma });
  const orgId = "cost_card_integration";
  const actorId = "cost_card_admin";
  let root: string;
  let storage: LocalFileSystemStorageAdapter;
  const now = new Date();
  beforeAll(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "smedc-cost-cards-"));
    storage = new LocalFileSystemStorageAdapter({ root: path.join(root, "storage") });
    await prisma.organization.create({ data: { id: orgId, name: "Synthetic cost cards" } });
    await prisma.employee.create({
      data: {
        id: actorId,
        orgId,
        email: "cost-card@example.invalid",
        displayName: "Admin",
        role: "admin",
        clearance: 0
      }
    });
    await prisma.businessAuthorizationState.create({
      data: { orgId, mode: "enabled", version: 1n }
    });
  });
  afterAll(async () => {
    await prisma.processingRun.updateMany({
      where: { orgId, status: "running" },
      data: { status: "failed", lockedBy: null, lockedUntil: null }
    });
    await prisma.$disconnect();
    if (root) await rm(root, { recursive: true, force: true });
  });

  it("idempotently fills an enabled tenant without granting access or changing old configuration", async () => {
    await prisma.businessCategory.create({
      data: {
        id: "old_category",
        orgId,
        key: "vip",
        name: "VIP",
        kind: "fixed",
        confidentialityLevel: 2,
        allowGroup: true,
        allowStore: false
      }
    });
    const old = await prisma.businessCategory.findUniqueOrThrow({
      where: { orgId_id: { orgId, id: "old_category" } }
    });
    const first = await repository.initializeFixedCategories({
      orgId,
      actorId,
      expectedVersion: "1"
    });
    expect(first).toMatchObject({
      authorizationVersion: "2",
      value: { createdCount: FIXED_BUSINESS_CATEGORY_KEYS.length - 1 }
    });
    const category = await prisma.businessCategory.findUniqueOrThrow({
      where: { orgId_key: { orgId, key: "cost_cards" } }
    });
    expect(category).toMatchObject({
      confidentialityLevel: null,
      allowGroup: true,
      allowStore: false
    });
    expect(
      await prisma.businessCategory.findUnique({ where: { orgId_id: { orgId, id: old.id } } })
    ).toEqual(old);
    expect(await prisma.businessGrant.count({ where: { orgId } })).toBe(0);
    expect(
      (await repository.initializeFixedCategories({ orgId, actorId, expectedVersion: "2" })).value
        .createdCount
    ).toBe(0);
    await expect(
      repository.initializeFixedCategories({ orgId, actorId, expectedVersion: "2" })
    ).rejects.toThrow("AUTHORIZATION_VERSION_CONFLICT");
    await prisma.businessCategory.update({
      where: { orgId_id: { orgId, id: category.id } },
      data: { confidentialityLevel: 2 }
    });
  });

  it("publishes mixed complete cards, fences stale baselines, preserves sources and protects adopted/archived objects", async () => {
    const first = await prepare([row("spu1", "sku", "1"), row("spu2", "sku", "2")]);
    await publish(first);
    const initial = await prisma.costCard.findMany({ where: { orgId }, orderBy: { spuId: "asc" } });
    expect(initial).toHaveLength(2);
    expect(initial[0]!.salePrice!.toString()).toBe("99999999999999.123456");
    // Both same-SKU SPUs remain separate; metadata-only source changes do not replace unchanged content.
    const mixed = await prepare([
      row("spu1", "sku", "1"),
      row("spu2", "sku", "3"),
      row("spu3", "sku", "4")
    ]);
    const result = await publish(mixed);
    expect(result.counts).toEqual({ inserted: 1, updated: 1, unchanged: 1, restored: 0 });
    expect(result.inputItemRowCount).toBe(3);
    expect(await prisma.costCard.findUnique({ where: { id: initial[0]!.id } })).toEqual(initial[0]);
    expect(await prisma.storageGarbage.count({ where: { processingRunId: mixed.runId } })).toBe(0);
    const retired = await prisma.storageGarbage.findFirstOrThrow({
      where: { objectKey: initial[1]!.objectKey }
    });
    expect(retired.availableAt.getTime()).toBe(now.getTime() + 86400_000);
    expect(
      (await listDueStorageGarbage(prisma, now, 100)).some((item) => item.id === retired.id)
    ).toBe(false);
    expect(await canDelete({ ...retired, now: new Date(now.getTime() + 86400_000) })).toBe(true);

    const collision = await prepare([row("unrelated_identity", "sku", "1")]);
    collision.candidates[0]!.id = initial[0]!.id;
    await expect(publish(collision)).rejects.toThrow();
    expect(await prisma.costCard.findUnique({ where: { id: initial[0]!.id } })).toEqual(initial[0]);
    const stale = await prepare([row("spu2", "sku", "5"), row("spu3", "sku", "6")]);
    await publish(await prepare([row("spu2", "sku", "7")]));
    await expect(publish(stale)).rejects.toThrow("COST_CARD_BASELINE_STALE");
    const untouched = await prisma.costCard.findFirstOrThrow({ where: { orgId, spuId: "spu3" } });
    expect(untouched.revision).toBe(1n);
    // Transaction rollback includes directory/resources, adoption, source and terminal status.
    const failed = await prepare([row("spu3", "sku", "8"), row("spu4", "sku", "9")]);
    failed.candidates[1]!.objectKey = "unowned-key.csv";
    await expect(publish(failed)).rejects.toThrow("COST_CARD_OBJECT_NOT_OWNED");
    expect(await prisma.costCard.findUnique({ where: { id: untouched.id } })).toEqual(untouched);
    expect(await prisma.costCard.count({ where: { orgId, spuId: "spu4" } })).toBe(0);
    expect(
      (await prisma.importBatch.findUniqueOrThrow({ where: { id: failed.importBatchId } })).status
    ).toBe("validating");
    const lost = await prepare([row("spu3", "sku", "10")]);
    await prisma.processingRun.update({
      where: { id: lost.runId },
      data: { lockedBy: "another-worker" }
    });
    await expect(publish(lost)).rejects.toThrow("PROCESSING_LEASE_LOST");

    const archived = await prisma.$transaction((tx) =>
      archiveCostCard(tx, { orgId, actorId, costCardId: untouched.id })
    );
    expect(archived.revision).toBe("2");
    expect(
      await prisma.$transaction((tx) =>
        archiveCostCard(tx, { orgId, actorId, costCardId: untouched.id })
      )
    ).toEqual(archived);
    await enqueueStorageGarbage(prisma, {
      objectKey: untouched.objectKey,
      reason: "synthetic_accidental_current"
    });
    const currentGarbage = await prisma.storageGarbage.findFirstOrThrow({
      where: { objectKey: untouched.objectKey }
    });
    expect(await canDelete({ ...currentGarbage, now: new Date() })).toBe(false);
    // Old successful request cannot replay publication or restore the archived card.
    await expect(publish(mixed)).rejects.toThrow("PROCESSING_LEASE_LOST");
    const restored = await publish(await prepare([row("spu3", "sku", "4")]));
    expect(restored.counts.restored).toBe(1);
    const active = await prisma.costCard.findUniqueOrThrow({ where: { id: untouched.id } });
    expect(active).toMatchObject({ revision: 3n, archivedAt: null });
    expect(active.objectKey).not.toBe(untouched.objectKey);
    // Successful commit followed by worker crash leaves no adopted candidate cleanup record.
    expect(await prisma.storageGarbage.count({ where: { objectKey: active.objectKey } })).toBe(0);
    expect((await storage.statObject(active.objectKey)).hash).toBe(active.checksumSha256);
    await prisma.document.update({
      where: { id: active.sourceDocumentId },
      data: { status: "archived", archivedAt: now }
    });
    expect(
      (await prisma.costCard.findUniqueOrThrow({ where: { id: active.id } })).archivedAt
    ).toBeNull();
    const resource = await prisma.businessResource.findFirstOrThrow({
      where: { orgId, kind: "cost_card", resourceKey: `cost-card:${active.id}` },
      include: { scopes: { include: { dimensions: true } } }
    });
    expect(
      canReadResource(
        await repository.loadAuthorizationSnapshot(actorId, orgId),
        toResourceReadRequirement(resource)
      ).allowed
    ).toBe(false);
    expect(await prisma.document.count({ where: { orgId } })).toBeGreaterThan(1);
  });

  it("serializes GC behind in-flight publication after the fenced lease expires", async () => {
    const input = await prepare([row("gc_forward", "sku", "1")]);
    const start = new Date();
    input.now = start;
    await prisma.processingRun.update({
      where: { id: input.runId },
      data: { lockedUntil: new Date(start.getTime() + 1000) }
    });
    const candidate = input.candidates[0]!;
    const garbage = await prisma.storageGarbage.findFirstOrThrow({
      where: { objectKey: candidate.objectKey! }
    });
    const fenced = barrier(),
      resume = barrier(),
      gcLockAttempt = barrier(),
      gcFinished = barrier();
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(start);
    const publication = prisma.$transaction(
      (tx) =>
        publishCostCards(
          queryBarrier(tx, (query) => {
            if (query.sql.includes("FROM organizations")) {
              fenced.release();
              return resume.promise;
            }
          }),
          input
        ),
      { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted, timeout: 120000 }
    );
    let collection: Promise<void> | undefined;
    try {
      await fenced.promise;
      vi.setSystemTime(new Date(start.getTime() + 2000));
      const gcClient = new Proxy(prisma, {
        get(target, property) {
          if (property === "$transaction")
            return (
              callback: (tx: Prisma.TransactionClient) => Promise<unknown>,
              options: unknown
            ) =>
              target.$transaction(
                (tx) =>
                  callback(
                    queryBarrier(tx, (query) => {
                      if (
                        query.sql.includes("FROM processing_runs") &&
                        query.sql.includes("FOR UPDATE")
                      )
                        gcLockAttempt.release();
                    })
                  ),
                options as { isolationLevel: Prisma.TransactionIsolationLevel }
              );
          const value = Reflect.get(target, property);
          return typeof value === "function" ? value.bind(target) : value;
        }
      });
      const gc = createPrismaStructuredPartitionRepository({ prisma: gcClient });
      collection = (async () => {
        if (
          await gc.canDeleteGarbage!({
            id: garbage.id,
            objectKey: garbage.objectKey,
            now: new Date()
          })
        )
          await storage.deleteObject(garbage.objectKey);
        gcFinished.release();
      })();
      // Old MVCC guard finishes/deletes; repaired guard reaches the held run lock.
      await Promise.race([gcFinished.promise, gcLockAttempt.promise]);
      resume.release();
      await Promise.all([publication, collection]);
      const current = await prisma.costCard.findUniqueOrThrow({ where: { id: candidate.id } });
      expect(current.objectKey).toBe(garbage.objectKey);
      expect((await storage.headObject(current.objectKey)).state).toBe("found");
    } finally {
      resume.release();
      await publication.catch(() => undefined);
      await collection?.catch(() => undefined);
      vi.useRealTimers();
    }
  });

  it("rejects publication and heartbeat queued behind GC after lease expiry", async () => {
    const input = await prepare([row("gc_reverse", "sku", "1")]);
    const start = new Date();
    input.now = start;
    const expiry = new Date(start.getTime() + 1000);
    await prisma.processingRun.update({
      where: { id: input.runId },
      data: { lockedUntil: expiry }
    });
    const candidate = input.candidates[0]!;
    const garbage = await prisma.storageGarbage.findFirstOrThrow({
      where: { objectKey: candidate.objectKey! }
    });
    const locked = barrier(),
      resume = barrier(),
      publisherWaiting = barrier();
    const worker = createPrismaProcessingWorkerRepository(process.env["DATABASE_URL"]!);
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(start);
    const gcClient = new Proxy(prisma, {
      get(target, property) {
        if (property === "$transaction")
          return (callback: (tx: Prisma.TransactionClient) => Promise<unknown>, options: unknown) =>
            target.$transaction(
              (tx) =>
                callback(
                  queryBarrier(
                    tx,
                    () => undefined,
                    (query) => {
                      if (
                        query.sql.includes("FROM storage_garbage") &&
                        query.sql.includes("FOR UPDATE")
                      ) {
                        locked.release();
                        return resume.promise;
                      }
                    }
                  )
                ),
              options as { isolationLevel: Prisma.TransactionIsolationLevel }
            );
        const value = Reflect.get(target, property);
        return typeof value === "function" ? value.bind(target) : value;
      }
    });
    const gc = createPrismaStructuredPartitionRepository({ prisma: gcClient });
    const collection = gc.canDeleteGarbage!({ ...garbage, now: start });
    let publication: Promise<unknown> | undefined;
    let heartbeat: Promise<boolean> | undefined;
    try {
      await locked.promise;
      publication = prisma
        .$transaction(
          (tx) =>
            publishCostCards(
              queryBarrier(tx, (query) => {
                if (query.sql.includes("FROM processing_runs") && query.sql.includes("FOR UPDATE"))
                  publisherWaiting.release();
              }),
              input
            ),
          { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted }
        )
        .catch((error) => error);
      heartbeat = worker.heartbeatProcessingRun!({
        runId: input.runId,
        attemptNumber: input.attemptNumber,
        workerId: input.workerId,
        leaseSeconds: 60,
        now: start
      });
      await publisherWaiting.promise;
      vi.setSystemTime(new Date(start.getTime() + 2000));
      resume.release();
      expect(await collection).toBe(true);
      await storage.deleteObject(garbage.objectKey);
      expect(await publication).toMatchObject({ message: "PROCESSING_LEASE_LOST" });
      expect(await heartbeat).toBe(false);
      const run = await prisma.processingRun.findUniqueOrThrow({ where: { id: input.runId } });
      expect(run.lockedUntil).toEqual(expiry);
      expect(await prisma.costCard.findUnique({ where: { id: candidate.id } })).toBeNull();
      expect((await storage.headObject(garbage.objectKey)).state).toBe("not_found");
    } finally {
      resume.release();
      await Promise.allSettled([collection, publication, heartbeat]);
      vi.useRealTimers();
      await worker.disconnect?.();
    }
  });

  it("uses a fresh RC reference read even when its caller already holds an older RR snapshot", async () => {
    const input = await prepare([row("gc_snapshot", "sku", "1")]);
    const candidate = input.candidates[0]!;
    const gc = createPrismaStructuredPartitionRepository({ prisma });
    await prisma.$transaction(
      async (oldSnapshot) => {
        expect(
          await oldSnapshot.costCard.count({ where: { objectKey: candidate.objectKey! } })
        ).toBe(0);
        await publish(input);
        await archiveCostCardInTransaction(candidate.id);
        await enqueueStorageGarbage(prisma, {
          objectKey: candidate.objectKey!,
          reason: "synthetic_stale_snapshot"
        });
        const garbage = await prisma.storageGarbage.findFirstOrThrow({
          where: { objectKey: candidate.objectKey! }
        });
        expect(
          await oldSnapshot.costCard.count({ where: { objectKey: candidate.objectKey! } })
        ).toBe(0);
        expect(await gc.canDeleteGarbage!({ ...garbage, now: new Date() })).toBe(false);
        expect((await storage.headObject(candidate.objectKey!)).state).toBe("found");
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead, timeout: 120000 }
    );
  });

  async function archiveCostCardInTransaction(costCardId: string) {
    return prisma.$transaction((tx) => archiveCostCard(tx, { orgId, actorId, costCardId }));
  }

  async function canDelete(input: { id: string; objectKey: string; now: Date }) {
    return prisma.$transaction((tx) => canDeleteStorageGarbage(tx, input), {
      isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted
    });
  }
  async function publish(input: CostCardPublishInput) {
    return prisma.$transaction((tx) => publishCostCards(tx, input), {
      isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted,
      timeout: 120_000
    });
  }
  async function prepare(rows: Record<string, unknown>[]): Promise<CostCardPublishInput> {
    const cards = rows.map((value) =>
      costCardFromRows([value], {
        enterpriseKey: "synthetic",
        sourceNamespace: "meituan",
        spuId: String(value["spu_id"]),
        skuId: String(value["sku_id"])
      })
    );
    for (const [index, card] of cards.entries())
      card.recipes[0]!.items[0]!.source = {
        sourceSheetIndex: 0,
        sourceSheetName: "Synthetic",
        sourceRowNumber: index + 2
      };
    const exported = await exportCostCardCsv(
      {
        cards,
        inputCardCount: cards.length,
        inputItemRowCount: rows.length,
        validationErrors: [],
        validationErrorCount: 0,
        validationErrorsTruncated: false
      },
      { workDirectory: root }
    );
    const sourceDocumentId = createCostCardId(),
      importBatchId = createCostCardId(),
      runId = createCostCardId();
    await prisma.document.create({
      data: {
        id: sourceDocumentId,
        orgId,
        uploaderId: actorId,
        title: "Synthetic source",
        documentType: "structured_dataset",
        documentKind: "structured",
        status: "processing",
        storageObjectKey: `synthetic/${sourceDocumentId}.xlsx`,
        sourceMetadata: { enterpriseKey: "synthetic" }
      }
    });
    await prisma.importBatch.create({
      data: {
        id: importBatchId,
        sourceDocumentId,
        orgId,
        dataset: "cost_cards",
        idempotencyKey: randomUUID(),
        requestFingerprint: "a".repeat(64),
        status: "validating"
      }
    });
    await prisma.processingRun.create({
      data: {
        id: runId,
        orgId,
        documentId: sourceDocumentId,
        jobKey: runId,
        jobType: "structured_import",
        status: "running",
        lockedBy: "synthetic-worker",
        lockedUntil: new Date(now.getTime() + 3600_000),
        attemptNumber: 1
      }
    });
    const baselines = await readCostCardBaselines(
      prisma,
      orgId,
      exported.cards.map((card) => card.identity)
    );
    const candidates = [];
    for (const card of exported.cards) {
      const baseline = baselines.get(costCardIdentityKey(card.identity)) ?? null;
      const id = baseline?.id ?? createCostCardId();
      const objectKey =
        costCardOperation(baseline, card.contentHash, card.canonicalizationVersion) === "unchanged"
          ? null
          : `cost-cards/${orgId}/${runId}/1/${id}.csv`;
      if (objectKey) {
        await enqueueStorageGarbage(prisma, {
          objectKey,
          processingRunId: runId,
          reason: "cost_card_candidate"
        });
        await storage.putObjectAtKey({
          key: objectKey,
          body: createReadStream(card.localFilePath),
          contentLength: card.byteSize,
          checksumSha256: card.checksumSha256
        });
      }
      candidates.push({ ...card, id, objectKey, baseline });
    }
    return {
      orgId,
      enterpriseName: "Synthetic",
      sourceDocumentId,
      importBatchId,
      actorId,
      runId,
      workerId: "synthetic-worker",
      attemptNumber: 1,
      now,
      sourceSheetSummary: [],
      candidates,
      inputItemRowCount: rows.length,
      changes: [],
      changesTruncated: false
    };
  }
});

function barrier() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}
function queryBarrier(
  tx: Prisma.TransactionClient,
  before: (query: Prisma.Sql) => void | Promise<void>,
  after: (query: Prisma.Sql) => void | Promise<void> = () => undefined
): Prisma.TransactionClient {
  return new Proxy(tx, {
    get(target, property) {
      if (property === "$queryRaw")
        return async (query: Prisma.Sql) => {
          await before(query);
          const result = await target.$queryRaw(query);
          await after(query);
          return result;
        };
      const value = Reflect.get(target, property);
      return typeof value === "function" ? value.bind(target) : value;
    }
  });
}

function row(spuId: string, skuId: string, quantity: string) {
  return Object.fromEntries(
    COST_CARD_UPLOAD_SCHEMA.map((field) => [
      field.canonicalName,
      (
        {
          spu_id: spuId,
          sku_id: skuId,
          dish_name: "滩羊肉锅",
          sale_price: "99999999999999.123456",
          has_cost_card: "true",
          source_dish_deleted: "false",
          recipe_type: "标准配方",
          recipe_name: "标准",
          item_code: "item",
          item_name: "羊肉",
          cost_unit: "kg",
          net_quantity: quantity
        } as Record<string, string>
      )[field.canonicalName] ?? null
    ])
  );
}
