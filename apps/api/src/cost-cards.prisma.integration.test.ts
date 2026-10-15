import { createReadStream } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  COST_CARD_UPLOAD_SCHEMA,
  costCardFromRows,
  normalizeEnterpriseIdentity
} from "@smedc/domain";
import {
  createDatabaseAdapter,
  createBusinessAuthorizationRepository,
  createPrismaCostCardDirectoryRepository,
  archiveCostCard,
  lockAuthorizationPublication,
  persistCostCardReadRequirement,
  persistStructuredSourceReadRequirements,
  enqueueStorageGarbage
} from "@smedc/db";
import { LocalFileSystemStorageAdapter } from "@smedc/storage";
import { exportCostCardCsv } from "@smedc/structured-ingestion";
import { buildApiServer } from "./server.js";
import { createBusinessAuthorizationService } from "./business-authorization.js";
import { createCostCardService } from "./cost-cards.js";

const suite = process.env["RUN_COST_CARD_PRISMA_INTEGRATION"] === "1" ? describe : describe.skip;
suite("cost card directory authorization and immutable manifest snapshots", () => {
  const prisma = new PrismaClient({
    adapter: createDatabaseAdapter(process.env["DATABASE_URL"] ?? "")
  });
  const permissions = createBusinessAuthorizationRepository({ prisma });
  const orgId = "cost_card_query_org",
    otherOrg = "cost_card_query_other",
    adminId = "cost_card_query_admin",
    employeeId = "cost_card_query_employee";
  const enterpriseName = "Synthetic restaurant",
    enterpriseKey = normalizeEnterpriseIdentity(enterpriseName).enterpriseKey;
  let root: string,
    storage: LocalFileSystemStorageAdapter,
    app: ReturnType<typeof buildApiServer>,
    categoryId: string;
  beforeAll(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "smedc-cost-card-query-"));
    storage = new LocalFileSystemStorageAdapter({ root: path.join(root, "storage") });
    for (const org of [orgId, otherOrg]) {
      await prisma.organization.create({ data: { id: org, name: "Synthetic" } });
      const admin = org === orgId ? adminId : "cost_card_query_other_admin";
      await prisma.employee.create({
        data: {
          id: admin,
          orgId: org,
          email: `${admin}@example.invalid`,
          displayName: admin,
          role: "admin",
          clearance: 0
        }
      });
      await prisma.businessAuthorizationState.create({
        data: { orgId: org, mode: "enabled", version: 1n }
      });
      await permissions.initializeFixedCategories({
        orgId: org,
        actorId: admin,
        expectedVersion: "1"
      });
      await prisma.businessCategory.update({
        where: { orgId_key: { orgId: org, key: "cost_cards" } },
        data: { confidentialityLevel: 2 }
      });
    }
    categoryId = (
      await prisma.businessCategory.findUniqueOrThrow({
        where: { orgId_key: { orgId, key: "cost_cards" } }
      })
    ).id;
    await prisma.employee.create({
      data: {
        id: employeeId,
        orgId,
        email: "cost-card-reader@example.invalid",
        displayName: "Reader",
        role: "employee",
        clearance: 2
      }
    });
    for (const [id, org, uploader] of [
      ["cost_query_source1", orgId, adminId],
      ["cost_query_source2", orgId, adminId],
      ["cost_query_source_foreign", otherOrg, "cost_card_query_other_admin"]
    ] as const) {
      await prisma.document.create({
        data: {
          id,
          orgId: org,
          uploaderId: uploader,
          title: "Synthetic original",
          documentKind: "structured",
          documentType: "structured_dataset",
          fileType: "csv",
          status: "active",
          storageObjectKey: `synthetic/${id}.csv`,
          sourceMetadata: { enterpriseKey }
        }
      });
      await prisma.importBatch.create({
        data: {
          id: id.replace("source", "batch"),
          orgId: org,
          sourceDocumentId: id,
          dataset: "cost_cards",
          idempotencyKey: id,
          requestFingerprint: "a".repeat(64),
          status: "applied",
          appliedAt: new Date()
        }
      });
    }
    for (const [id, spu, sku, specification, name, source, org] of [
      ["cost_query_small", "spu1", "sku1", "小份", "滩羊肉锅", "cost_query_source1", orgId],
      ["cost_query_large", "spu1", "sku2", "大份", "滩羊肉锅", "cost_query_source2", orgId],
      ["cost_query_other_spu", "spu2", "sku1", "标准", "滩羊肉锅", "cost_query_source1", orgId],
      ["cost_query_literal", "spu3", "sku3", "字面", "滩羊%_肉锅", "cost_query_source1", orgId],
      ["cost_query_archived", "spu4", "sku4", "归档", "滩羊肉锅", "cost_query_source1", orgId],
      [
        "cost_query_foreign",
        "spu1",
        "sku1",
        "外部",
        "滩羊肉锅",
        "cost_query_source_foreign",
        otherOrg
      ]
    ]) {
      const exported = await exportCard(spu!, sku!, name!, specification!);
      const objectKey = `cost-cards/${org}/${id}.csv`;
      await storage.putObjectAtKey({
        key: objectKey,
        body: createReadStream(exported.localFilePath),
        contentLength: exported.byteSize,
        checksumSha256: exported.checksumSha256
      });
      await prisma.costCard.create({
        data: {
          id,
          orgId: org!,
          enterpriseKey,
          enterpriseName,
          sourceNamespace: "meituan",
          spuId: spu!,
          skuId: sku!,
          dishName: name!,
          specificationName: specification!,
          baseCategoryName: "锅类",
          salePrice: "99999999999999.123456",
          hasCostCard: true,
          sourceDishDeleted: false,
          objectKey,
          checksumSha256: exported.checksumSha256,
          byteSize: exported.byteSize,
          itemRowCount: exported.itemRowCount,
          recipeCount: exported.recipeCount,
          contentHash: exported.contentHash,
          canonicalizationVersion: 1,
          csvSchemaVersion: 1,
          sourceDocumentId: source!,
          importBatchId: source!.replace("source", "batch"),
          revision: id === "cost_query_large" ? 2n : 1n
        }
      });
      await prisma.$transaction(async (tx) => {
        const state = await lockAuthorizationPublication(tx, org!);
        await persistCostCardReadRequirement(
          tx,
          { orgId: org!, costCardId: id!, enterpriseKey, workerId: "synthetic-fixture" },
          state
        );
      });
    }
    await prisma.$transaction(async (tx) => {
      await persistStructuredSourceReadRequirements(tx, {
        orgId,
        sourceDocumentId: "cost_query_source1",
        dataset: "cost_cards",
        enterpriseKey,
        rows: [{ payload: {} }],
        workerId: "synthetic-fixture"
      });
    });
    await prisma.$transaction((tx) =>
      archiveCostCard(tx, { orgId, actorId: adminId, costCardId: "cost_query_archived" })
    );
    await prisma.document.update({
      where: { id: "cost_query_source1" },
      data: { status: "archived", archivedAt: new Date() }
    });
    await grant(true);
    app = buildApiServer({
      businessAuthorizationService: createBusinessAuthorizationService(permissions),
      storageAdapter: storage,
      costCardService: createCostCardService({
        repository: createPrismaCostCardDirectoryRepository(prisma),
        storage,
        maxCards: 10,
        urlTtlSeconds: 900
      }),
      authenticateAccessToken: async (id) => {
        const employee = await prisma.employee.findUnique({ where: { id } });
        return employee ? { ...employee, organizationName: "Synthetic" } : null;
      },
      cursorSigningSecret: "synthetic-cost-card-query-cursor",
      logger: false
    });
  });
  afterAll(async () => {
    await app?.close();
    await prisma.$disconnect();
    if (root) await rm(root, { recursive: true, force: true });
  });

  it("finds independent same-name specifications/SPUs, literal names and exact prices with authorized stable pagination", async () => {
    const equal = await query({ filter: { field: "dish_name", op: "eq", value: "滩羊肉锅" } });
    expect(equal.statusCode).toBe(200);
    expect(
      equal
        .json()
        .rows.map((row: { cost_card_id: string }) => row.cost_card_id)
        .sort()
    ).toEqual(["cost_query_small", "cost_query_large", "cost_query_other_spu"].sort());
    expect(
      equal
        .json()
        .rows.every(
          (row: { sale_price: unknown; revision: unknown }) =>
            row.sale_price === "99999999999999.123456" && typeof row.revision === "string"
        )
    ).toBe(true);
    expect(equal.json().rows[0].has_cost_card).toBe(true);
    expect(
      (await query({ filter: { field: "dish_name", op: "contains", value: "%_" } }))
        .json()
        .rows.map((row: { cost_card_id: string }) => row.cost_card_id)
    ).toEqual(["cost_query_literal"]);
    expect(
      (await query({ filter: { field: "dish_name", op: "starts_with", value: "滩羊" } })).json()
        .rows
    ).toHaveLength(4);
    expect(
      (
        await query({
          filter: {
            and: [
              { field: "spu_id", op: "eq", value: "spu1" },
              { field: "sku_id", op: "in", value: ["sku2"] },
              { field: "specification_name", op: "eq", value: "大份" },
              { field: "base_category_name", op: "eq", value: "锅类" },
              { field: "sale_price", op: "gte", value: "99999999999999.123455" }
            ]
          }
        })
      )
        .json()
        .rows.map((row: { cost_card_id: string }) => row.cost_card_id)
    ).toEqual(["cost_query_large"]);
    const first = (await query({ page: { limit: 2 } })).json();
    const second = (await query({ page: { limit: 2, cursor: first.nextCursor } })).json();
    expect(new Set([...first.rows, ...second.rows].map((row) => row.cost_card_id)).size).toBe(4);
    expect(second.nextCursor).toBeNull();
    expect((await query({ filter: { field: "sale_price", op: "eq", value: 1 } })).statusCode).toBe(
      400
    );
    expect((await query({ select: ["item_name"] })).statusCode).toBe(400);
    expect((await query({ aggregates: [{ op: "count" }] })).statusCode).toBe(400);
    const discovery = (await request("GET", "/v1/structured/datasets"))
      .json()
      .datasets.find((entry: { dataset: string }) => entry.dataset === "cost_cards");
    expect(discovery).toMatchObject({ accessMode: "catalog_query", queryModes: ["detail"] });
    expect(
      discovery.fields.some(
        (field: { canonicalName: string }) =>
          field.canonicalName === "item_name" || field.canonicalName === "object_key"
      )
    ).toBe(false);
    const coverage = await request("GET", "/v1/structured/datasets/cost_cards/coverage");
    expect(coverage.json()).toMatchObject({ cardCount: 4, totalItemRowCount: 4 });
    expect(coverage.json().sources).toHaveLength(2);
  });

  it("fixes mixed per-card sources and rejects incomplete IDs, caps, archived and cross-organization cards", async () => {
    const result = await manifest({ costCardIds: ["cost_query_small", "cost_query_large"] });
    expect(result.statusCode).toBe(200);
    const entries = result.json().cards;
    expect(entries).toMatchObject([
      {
        costCardId: "cost_query_large",
        revision: "2",
        sourceDocumentId: "cost_query_source2",
        importBatchId: "cost_query_batch2"
      },
      {
        costCardId: "cost_query_small",
        revision: "1",
        sourceDocumentId: "cost_query_source1",
        importBatchId: "cost_query_batch1"
      }
    ]);
    expect(
      (await request("POST", "/v1/source-documents/cost_query_source1/download-url")).statusCode
    ).toBe(404);
    for (const id of ["cost_query_archived", "cost_query_foreign", "missing"])
      expect((await manifest({ costCardIds: ["cost_query_small", id] })).statusCode).toBe(403);
    expect((await manifest({ dishName: "no matching card" })).json()).toMatchObject({
      cardCount: 0,
      totalItemRowCount: 0,
      cards: []
    });
    const limited = createCostCardService({
      repository: createPrismaCostCardDirectoryRepository(prisma),
      storage,
      maxCards: 1,
      urlTtlSeconds: 900
    });
    await expect(
      limited.createCostCardManifest({ auth: { id: employeeId, orgId }, selection: {} })
    ).rejects.toThrow("COST_CARD_MANIFEST_TOO_LARGE");
    expect(
      (await request("POST", "/v1/cost-cards/cost_query_small/archive", undefined, employeeId))
        .statusCode
    ).toBe(403);
  });

  it("rejects signing-time updates, archives and revocations using new database reads", async () => {
    const realSign = storage.createDownloadUrl.bind(storage);
    let changed = false;
    const update = vi
      .spyOn(storage, "createDownloadUrl")
      .mockImplementation(async (key, options) => {
        if (!changed) {
          changed = true;
          await replaceLargeCard();
        }
        return realSign(key, options);
      });
    const updated = await manifest({ costCardIds: ["cost_query_large", "cost_query_small"] });
    expect(updated.statusCode).toBe(409);
    expect(updated.json().error).toMatchObject({ code: "COST_CARD_CHANGED", retryable: true });
    expect(updated.body).not.toContain("file:");
    update.mockRestore();
    expect((await manifest({ costCardIds: ["cost_query_large"] })).json().cards[0].revision).toBe(
      "3"
    );
    const archive = vi
      .spyOn(storage, "createDownloadUrl")
      .mockImplementation(async (key, options) => {
        await prisma.$transaction((tx) =>
          archiveCostCard(tx, { orgId, actorId: adminId, costCardId: "cost_query_literal" })
        );
        return realSign(key, options);
      });
    expect((await manifest({ costCardIds: ["cost_query_literal"] })).json().error.code).toBe(
      "COST_CARD_CHANGED"
    );
    archive.mockRestore();
    const before = await request(
      "POST",
      "/v1/cost-cards/cost_query_literal/archive",
      undefined,
      adminId
    );
    const again = await request(
      "POST",
      "/v1/cost-cards/cost_query_literal/archive",
      undefined,
      adminId
    );
    expect(again.json()).toEqual(before.json());
    const revoke = vi
      .spyOn(storage, "createDownloadUrl")
      .mockImplementation(async (key, options) => {
        await grant(false);
        return realSign(key, options);
      });
    const revoked = await manifest({ costCardIds: ["cost_query_small"] });
    expect(revoked.statusCode).toBe(409);
    expect(revoked.json().error.code).toBe("COST_CARD_CHANGED");
    revoke.mockRestore();
    await grant(true);
  });

  it("does not disclose directories through low clearance, absent group grants or non-enabled modes", async () => {
    await grant(false);
    expect((await query({})).json().rows).toEqual([]);
    expect((await manifest({ costCardIds: ["cost_query_small"] })).statusCode).toBe(403);
    await grant(true, 0);
    expect((await query({})).json().rows).toEqual([]);
    expect(
      (await request("GET", "/v1/structured/datasets"))
        .json()
        .datasets.some((entry: { dataset: string }) => entry.dataset === "cost_cards")
    ).toBe(false);
    await grant(true);
    const page = (await query({ page: { limit: 1 } })).json();
    await grant(false);
    expect((await query({ page: { limit: 1, cursor: page.nextCursor } })).statusCode).toBe(400);
    await grant(true);
    for (const mode of ["legacy", "preparing", "suspended"] as const) {
      await prisma.businessAuthorizationState.update({
        where: { orgId },
        data: { mode, version: { increment: 1 } }
      });
      expect((await query({})).statusCode).toBe(403);
      expect((await manifest({})).statusCode).toBe(403);
      expect(
        (await request("GET", "/v1/structured/datasets"))
          .json()
          .datasets.some((entry: { dataset: string }) => entry.dataset === "cost_cards")
      ).toBe(false);
    }
    await prisma.businessAuthorizationState.update({
      where: { orgId },
      data: { mode: "enabled", version: { increment: 1 } }
    });
  });

  async function query(extra: Record<string, unknown>) {
    return request("POST", "/v1/structured/query", { dataset: "cost_cards", ...extra });
  }
  async function manifest(selection: Record<string, unknown>) {
    return request("POST", "/v1/cost-cards/manifest", selection);
  }
  async function request(
    method: "GET" | "POST",
    url: string,
    payload?: Record<string, unknown>,
    actor = employeeId
  ) {
    return app.inject({
      method,
      url,
      headers: { authorization: `Bearer ${actor}` },
      ...(payload === undefined ? {} : { payload })
    });
  }
  async function grant(allowed: boolean, clearance = 2) {
    await permissions.configureAccount({
      orgId,
      actorId: adminId,
      expectedVersion: (await permissions.loadAuthorizationSnapshot(adminId, orgId))
        .authorizationVersion,
      employeeId,
      clearance,
      grants: allowed
        ? [
            {
              id: "cost_card_query_grant",
              orgId,
              enterpriseKey,
              ownership: "group",
              categoryIds: [categoryId],
              dimensions: {}
            }
          ]
        : []
    });
  }
  async function exportCard(
    spu: string,
    sku: string,
    name: string,
    specification: string,
    quantity = "1"
  ) {
    const values = Object.fromEntries(
      COST_CARD_UPLOAD_SCHEMA.map((field) => [
        field.canonicalName,
        (
          {
            spu_id: spu,
            sku_id: sku,
            dish_name: name,
            specification_name: specification,
            base_category_name: "锅类",
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
    const card = costCardFromRows([values], {
      enterpriseKey,
      sourceNamespace: "meituan",
      spuId: spu,
      skuId: sku
    });
    card.recipes[0]!.items[0]!.source = {
      sourceSheetIndex: 0,
      sourceSheetName: "Synthetic",
      sourceRowNumber: 2
    };
    return (
      await exportCostCardCsv(
        {
          cards: [card],
          inputCardCount: 1,
          inputItemRowCount: 1,
          validationErrors: [],
          validationErrorCount: 0,
          validationErrorsTruncated: false
        },
        { workDirectory: root }
      )
    ).cards[0]!;
  }
  async function replaceLargeCard() {
    const exported = await exportCard("spu1", "sku2", "滩羊肉锅", "大份", "2");
    const key = "cost-cards/synthetic/query-large-replacement.csv";
    await storage.putObjectAtKey({
      key,
      body: createReadStream(exported.localFilePath),
      contentLength: exported.byteSize,
      checksumSha256: exported.checksumSha256
    });
    await prisma.$transaction(async (tx) => {
      await lockAuthorizationPublication(tx, orgId);
      const old = await tx.costCard.findUniqueOrThrow({ where: { id: "cost_query_large" } });
      await tx.costCard.update({
        where: { id: old.id },
        data: {
          objectKey: key,
          contentHash: exported.contentHash,
          checksumSha256: exported.checksumSha256,
          byteSize: exported.byteSize,
          revision: { increment: 1 }
        }
      });
      await enqueueStorageGarbage(tx, {
        objectKey: old.objectKey,
        reason: "cost_card_replaced",
        availableAt: new Date(Date.now() + 86400_000)
      });
    });
  }
});
