import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createReadStream } from "node:fs";
import { Prisma, PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { canReadResource, COST_CARD_UPLOAD_SCHEMA, costCardFromRows } from "@smedc/domain";
import { exportCostCardCsv } from "@smedc/structured-ingestion";
import { LocalFileSystemStorageAdapter } from "@smedc/storage";
import { createDatabaseAdapter } from "./adapter.js";
import { createBusinessAuthorizationRepository } from "./business-authorization.js";
import { toResourceReadRequirement } from "./business-authorization-records.js";
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
  const now = new Date("2026-10-14T00:00:00Z");
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
    expect(first).toMatchObject({ authorizationVersion: "2", value: { createdCount: 8 } });
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
    expect(await listDueStorageGarbage(prisma, now, 100)).toEqual([]);
    expect(
      await canDeleteStorageGarbage(prisma, {
        ...retired,
        now: new Date(now.getTime() + 86400_000)
      })
    ).toBe(true);

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
    expect(await canDeleteStorageGarbage(prisma, { ...currentGarbage, now: new Date() })).toBe(
      false
    );
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
          : `cost-cards/${orgId}/${runId}/${id}.csv`;
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
