import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import ExcelJS from "exceljs";
import { COST_CARD_UPLOAD_SCHEMA, normalizeEnterpriseIdentity } from "@smedc/domain";
import {
  createDatabaseAdapter,
  createBusinessAuthorizationRepository,
  createPrismaCostCardRepository,
  createPrismaStructuredPartitionRepository,
  CostCardPublicationError,
  archiveCostCard
} from "@smedc/db";
import { LocalFileSystemStorageAdapter } from "@smedc/storage";
import { buildApiServer } from "../../api/src/server.js";
import { createBusinessAuthorizationService } from "../../api/src/business-authorization.js";
import { createPrismaStructuredImportRepository } from "../../api/src/structured-imports.js";
import { createMultipartPayload } from "../../api/src/test-support/multipart-fixtures.js";
import { createPrismaProcessingWorkerRepository, runWorkerOnce } from "./worker.js";
import { createCostCardImporter } from "./cost-card-import.js";
import {
  createPartitionImporter,
  partitionImportLimitsFromRuntime,
  type PartitionImportRuntimeLimits
} from "./partition-import.js";
import { loadWorkerRuntimeLimits } from "./config/runtime-limits.js";

const suite = process.env["RUN_COST_CARD_PRISMA_INTEGRATION"] === "1" ? describe : describe.skip;
suite("cost card API to worker publication", () => {
  const databaseUrl = process.env["DATABASE_URL"] ?? "";
  const prisma = new PrismaClient({ adapter: createDatabaseAdapter(databaseUrl) });
  const authorization = createBusinessAuthorizationRepository({ prisma });
  const orgId = "cost_card_worker_org",
    adminId = "cost_card_worker_admin",
    employeeId = "cost_card_worker_employee";
  const enterpriseName = "Synthetic cost-card enterprise";
  const enterpriseKey = normalizeEnterpriseIdentity(enterpriseName).enterpriseKey;
  const worker = createPrismaProcessingWorkerRepository(databaseUrl);
  const imports = createPrismaStructuredImportRepository({
    databaseUrl,
    batchInsertSize: 500,
    transactionTimeoutMs: 120000
  });
  let root: string;
  let storage: LocalFileSystemStorageAdapter;
  let app: ReturnType<typeof buildApiServer>;
  let categoryId: string;
  let clock = new Date();
  const now = () => clock;
  beforeAll(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "smedc-cost-card-pipeline-"));
    storage = new LocalFileSystemStorageAdapter({ root: path.join(root, "storage") });
    await prisma.organization.create({ data: { id: orgId, name: "Synthetic" } });
    for (const [id, role, clearance] of [
      [adminId, "admin", 0],
      [employeeId, "employee", 2]
    ] as const)
      await prisma.employee.create({
        data: { id, orgId, role, clearance, email: `${id}@example.invalid`, displayName: id }
      });
    await prisma.businessAuthorizationState.create({
      data: { orgId, mode: "enabled", version: 1n }
    });
    app = buildApiServer({
      businessAuthorizationService: createBusinessAuthorizationService(authorization),
      structuredImportRepository: imports,
      storageAdapter: storage,
      uploadAuthorizationAuditRepository: { appendDenied: async () => undefined },
      authenticateAccessToken: async (id) => {
        const employee = await prisma.employee.findFirst({ where: { id, orgId } });
        return employee ? { ...employee, organizationName: "Synthetic" } : null;
      },
      cursorSigningSecret: "synthetic-cost-card-cursor-secret",
      logger: false
    });
  });
  afterAll(async () => {
    await app?.close();
    await worker.disconnect?.();
    await prisma.processingRun.updateMany({
      where: { orgId, status: { in: ["running", "retry_scheduled", "queued"] } },
      data: { status: "failed", lockedBy: null, lockedUntil: null }
    });
    await prisma.$disconnect();
    if (root) await rm(root, { recursive: true, force: true });
  });

  it("accepts configured admin originals, atomically replaces complete cards, preserves batch summaries and denies revoked reads", async () => {
    const firstRows = [
      row("spu1"),
      row("spu1", { recipe_type: "例外配方", recipe_name: "例外", source_stores_text: "甲店" }),
      row("spu2")
    ];
    const original = csv(firstRows);
    expect((await upload(original, "missing-category")).statusCode).toBe(400);
    expect(await prisma.document.count({ where: { orgId } })).toBe(0);
    await authorization.initializeFixedCategories({
      orgId,
      actorId: adminId,
      expectedVersion: "1"
    });
    const category = await prisma.businessCategory.findUniqueOrThrow({
      where: { orgId_key: { orgId, key: "cost_cards" } }
    });
    categoryId = category.id;
    expect((await upload(original, "unconfigured-category")).statusCode).toBe(400);
    await authorization.configureCategory({
      ...(await context()),
      id: categoryId,
      key: "cost_cards",
      name: "cost_cards",
      kind: "fixed",
      confidentialityLevel: 2,
      ownerships: ["group"],
      requiredDimensionIds: []
    });
    expect((await upload(original, "employee", employeeId)).statusCode).toBe(403);
    expect(
      (await upload(original, "override", adminId, [{ name: "confidentialityLevel", value: "0" }]))
        .statusCode
    ).toBe(400);
    const accepted = await upload(original, "first");
    expect(accepted.statusCode).toBe(202);
    const firstId = accepted.json().importBatch.importBatchId;
    expect(accepted.json().importBatch).not.toHaveProperty("publicationSummary");
    expect(await runImport()).toMatchObject({ status: "active" });
    const first = await prisma.importBatch.findUniqueOrThrow({ where: { id: firstId } });
    expect(first).toMatchObject({ status: "applied", totalRowCount: 3, appliedRowCount: 3 });
    expect(first.publicationSummary).toMatchObject({
      inputCardCount: 2,
      inputItemRowCount: 3,
      counts: { inserted: 2, updated: 0, unchanged: 0, restored: 0 }
    });
    expect(Array.isArray(first.sourceSheetSummary)).toBe(true);
    const before = await prisma.costCard.findMany({ where: { orgId }, orderBy: { spuId: "asc" } });
    expect(before[0]!.recipeCount).toBe(2);
    expect((await status(firstId, adminId)).json().importBatch).not.toHaveProperty(
      "publicationSummary"
    );
    await grantEmployee(true);
    expect((await status(firstId, employeeId)).json().importBatch.publicationSummary).toEqual(
      first.publicationSummary
    );
    const secondResponse = await upload(csv([row("spu1"), row("spu2")]), "second");
    expect(secondResponse.statusCode).toBe(202);
    expect(await runImport()).toMatchObject({ status: "active" });
    const secondId = secondResponse.json().importBatch.importBatchId;
    const second = (await status(secondId, employeeId)).json().importBatch;
    expect(second.publicationSummary).toMatchObject({
      counts: { inserted: 0, updated: 1, unchanged: 1, restored: 0 },
      changes: [{ operation: "updated", changedFields: ["recipes.removed"] }]
    });
    const current = await prisma.costCard.findMany({ where: { orgId }, orderBy: { spuId: "asc" } });
    expect(current[0]!).toMatchObject({ id: before[0]!.id, recipeCount: 1, revision: 2n });
    expect(current[1]).toEqual(before[1]);
    expect((await status(firstId, employeeId)).json().importBatch.publicationSummary).toEqual(
      first.publicationSummary
    );
    await prisma.document.update({
      where: { id: first.sourceDocumentId },
      data: { status: "archived", archivedAt: clock }
    });
    expect((await status(firstId, employeeId)).json().importBatch.publicationSummary).toEqual(
      first.publicationSummary
    );
    expect(
      (
        await storage.headObject(
          (await prisma.document.findUniqueOrThrow({ where: { id: first.sourceDocumentId } }))
            .storageObjectKey
        )
      ).state
    ).toBe("found");
    await prisma.$transaction((tx) =>
      archiveCostCard(tx, { orgId, actorId: adminId, costCardId: current[0]!.id })
    );
    expect((await upload(original, "first")).statusCode).toBe(202);
    expect(
      (await prisma.costCard.findUniqueOrThrow({ where: { id: current[0]!.id } })).archivedAt
    ).not.toBeNull();
    expect((await upload(csv([row("spu1", { dish_name: "changed" })]), "first")).statusCode).toBe(
      409
    );
    expect((await upload(original, "restore")).statusCode).toBe(202);
    expect(await runImport()).toMatchObject({ status: "active" });
    expect(
      (await prisma.costCard.findUniqueOrThrow({ where: { id: current[0]!.id } })).archivedAt
    ).toBeNull();
    const stable = await prisma.costCard.findMany({ where: { orgId }, orderBy: { id: "asc" } });
    const invalid = await upload(await badWorkbook(), "bad-exception", adminId, [], "xlsx");
    expect(invalid.statusCode).toBe(202);
    expect(await runImport()).toMatchObject({ status: "rejected" });
    expect(await prisma.costCard.findMany({ where: { orgId }, orderBy: { id: "asc" } })).toEqual(
      stable
    );
    const invalidBatch = await prisma.importBatch.findUniqueOrThrow({
      where: { id: invalid.json().importBatch.importBatchId }
    });
    expect(invalidBatch.status).toBe("rejected");
    expect(invalidBatch.publicationSummary).toBeNull();
    await grantEmployee(false);
    expect((await status(firstId, employeeId)).statusCode).toBe(404);
    expect((await status(firstId, adminId)).json().importBatch).not.toHaveProperty(
      "publicationSummary"
    );
  });

  it("uses finite outer retries with fresh preparation and queued failure cleanup", async () => {
    const accepted = await upload(csv([row("failure", { net_quantity: "2" })]), "retry-conflict");
    expect(accepted.statusCode).toBe(202);
    const repository = createPrismaCostCardRepository(prisma);
    const read = vi.spyOn(repository, "readBaselines");
    vi.spyOn(repository, "publish").mockRejectedValue(
      new CostCardPublicationError("COST_CARD_BASELINE_STALE", true)
    );
    expect(await runImport(repository, 2)).toMatchObject({ status: "retry_scheduled" });
    clock = new Date(clock.getTime() + 2000);
    expect(await runImport(repository, 2)).toMatchObject({ status: "processing_failed" });
    expect(read).toHaveBeenCalledTimes(2);
    expect(await prisma.costCard.count({ where: { orgId, spuId: "failure" } })).toBe(0);
    const batch = await prisma.importBatch.findUniqueOrThrow({
      where: { id: accepted.json().importBatch.importBatchId }
    });
    expect(batch).toMatchObject({
      status: "failed",
      publicationSummary: null,
      errorCode: "COST_CARD_BASELINE_STALE"
    });
    const run = await prisma.processingRun.findFirstOrThrow({
      where: { orgId, documentId: batch.sourceDocumentId }
    });
    const garbage = await prisma.storageGarbage.findMany({ where: { processingRunId: run.id } });
    expect(garbage).toHaveLength(2);
    const cleanupRepository = createPrismaStructuredPartitionRepository({ prisma });
    const cleanup = createPartitionImporter({ repository: cleanupRepository, limits: limits() });
    await cleanup.maintain({ storage, now: new Date(Date.now() + 5000) });
    for (const item of garbage)
      expect((await storage.headObject(item.objectKey)).state).toBe("not_found");
    await cleanup.disconnect();
    for (const card of await prisma.costCard.findMany({ where: { orgId } }))
      expect((await storage.headObject(card.objectKey)).state).toBe("found");
  });

  it("rejects lowered input limits, verification failure and lost leases without publishing a subset", async () => {
    const before = await prisma.costCard.findMany({ where: { orgId }, orderBy: { id: "asc" } });
    for (const [key, overrides, expected] of [
      ["rows", { maxRows: 1 }, "rejected"],
      ["bytes", { maxSourceBytes: 1 }, "processing_failed"]
    ] as const) {
      expect((await upload(csv([row("limitA"), row("limitB")]), `limit-${key}`)).statusCode).toBe(
        202
      );
      expect(await runImport(createPrismaCostCardRepository(prisma), 1, overrides)).toMatchObject({
        status: expected
      });
    }
    const failed = await upload(csv([row("verify-failure")]), "verify-failure");
    expect(failed.statusCode).toBe(202);
    const actualStat = storage.statObject.bind(storage);
    const stat = vi.spyOn(storage, "statObject").mockImplementation(async (key) => {
      const actual = await actualStat(key);
      return key.startsWith("cost-cards/") ? { ...actual, hash: "wrong" } : actual;
    });
    expect(await runImport()).toMatchObject({ status: "processing_failed" });
    stat.mockRestore();
    expect(
      (
        await prisma.importBatch.findUniqueOrThrow({
          where: { id: failed.json().importBatch.importBatchId }
        })
      ).publicationSummary
    ).toBeNull();
    const lost = await upload(csv([row("lost-lease")]), "lost-lease");
    expect(lost.statusCode).toBe(202);
    const repository = createPrismaCostCardRepository(prisma);
    const publish = repository.publish.bind(repository);
    vi.spyOn(repository, "publish").mockImplementation(async (input) => {
      await prisma.processingRun.update({
        where: { id: input.runId },
        data: { lockedBy: "new-worker" }
      });
      return publish(input);
    });
    expect(await runImport(repository)).toMatchObject({ status: "retry_scheduled" });
    expect(await prisma.costCard.findMany({ where: { orgId }, orderBy: { id: "asc" } })).toEqual(
      before
    );
  });

  function limits() {
    return partitionImportLimitsFromRuntime(
      loadWorkerRuntimeLimits({
        PARTITION_IMPORT_WORK_DIR: path.join(root, "work"),
        PARTITION_IMPORT_MIN_FREE_BYTES: "1"
      })
    );
  }
  async function runImport(
    repository = createPrismaCostCardRepository(prisma),
    maxAttempts = 1,
    override: Partial<PartitionImportRuntimeLimits> = {}
  ) {
    clock = new Date(Math.max(clock.getTime(), Date.now() + 10));
    return runWorkerOnce({
      repository: worker,
      storage,
      costCardImporter: createCostCardImporter({
        repository,
        limits: { ...limits(), ...override }
      }),
      workerId: "cost-card-pipeline",
      maxAttempts,
      retryBaseMs: 1,
      retryMaxMs: 1,
      now
    });
  }
  async function context() {
    return {
      orgId,
      actorId: adminId,
      expectedVersion: (await authorization.loadAuthorizationSnapshot(adminId, orgId))
        .authorizationVersion
    };
  }
  async function grantEmployee(allowed: boolean) {
    await authorization.configureAccount({
      ...(await context()),
      employeeId,
      clearance: 2,
      grants: allowed
        ? [
            {
              id: "cost_card_worker_grant",
              orgId,
              enterpriseKey,
              categoryIds: [categoryId],
              ownership: "group",
              dimensions: {}
            }
          ]
        : []
    });
  }
  async function upload(
    content: Buffer,
    idempotencyKey: string,
    actor = adminId,
    extra: Array<{ name: string; value: string }> = [],
    type = "csv"
  ) {
    const multipart = createMultipartPayload([
      { name: "dataset", value: "cost_cards" },
      { name: "enterpriseName", value: enterpriseName },
      { name: "idempotencyKey", value: idempotencyKey },
      ...extra,
      {
        name: "file",
        fileName: `synthetic.${type}`,
        contentType:
          type === "csv"
            ? "text/csv"
            : "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        value: content
      }
    ]);
    return app.inject({
      method: "POST",
      url: "/v1/structured/imports",
      headers: { authorization: `Bearer ${actor}`, "content-type": multipart.contentType },
      payload: multipart.body
    });
  }
  async function status(id: string, actor: string) {
    return app.inject({
      method: "GET",
      url: `/v1/structured/imports/${id}`,
      headers: { authorization: `Bearer ${actor}` }
    });
  }
});
function row(spuId: string, overrides: Record<string, string> = {}) {
  return Object.fromEntries(
    COST_CARD_UPLOAD_SCHEMA.map((field) => [
      field.canonicalName,
      (
        {
          spu_id: spuId,
          sku_id: "sku",
          dish_name: "滩羊肉锅",
          specification_name: spuId,
          sale_price: "99999999999999.123456",
          has_cost_card: "true",
          source_dish_deleted: "false",
          recipe_type: "标准配方",
          recipe_name: "标准",
          item_code: "item",
          item_name: "羊肉",
          cost_unit: "kg",
          net_quantity: "1",
          ...overrides
        } as Record<string, string>
      )[field.canonicalName] ?? ""
    ])
  );
}
function csv(rows: Record<string, string>[]) {
  return Buffer.from(
    [
      COST_CARD_UPLOAD_SCHEMA.map((field) => field.sourceColumn).join(","),
      ...rows.map((row) =>
        COST_CARD_UPLOAD_SCHEMA.map((field) => JSON.stringify(row[field.canonicalName] ?? "")).join(
          ","
        )
      ),
      ""
    ].join("\n")
  );
}
async function badWorkbook() {
  const book = new ExcelJS.Workbook();
  const headers = COST_CARD_UPLOAD_SCHEMA.map((field) => field.sourceColumn);
  book
    .addWorksheet("标准")
    .addRows([headers, COST_CARD_UPLOAD_SCHEMA.map((field) => row("spu1")[field.canonicalName])]);
  book
    .addWorksheet("例外")
    .addRows([
      headers.slice(0, -1),
      COST_CARD_UPLOAD_SCHEMA.map(
        (field) =>
          row("spu1", { recipe_type: "例外配方", recipe_name: "例外", source_stores_text: "甲店" })[
            field.canonicalName
          ]
      )
    ]);
  return Buffer.from(await book.xlsx.writeBuffer());
}
