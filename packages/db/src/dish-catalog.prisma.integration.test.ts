import { randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { compileStructuredCoverageQuery, normalizeEnterpriseIdentity } from "@smedc/domain";
import { createDatabaseAdapter } from "./adapter.js";
import { compileStructuredReadScope } from "./business-authorization-sql.js";
import { createBusinessAuthorizationRepository } from "./business-authorization.js";
import { createPrismaDishCatalogRepository } from "./dish-catalog.js";

const run = process.env["RUN_DISH_CATALOG_PRISMA_INTEGRATION"] === "1";
const url = process.env["DATABASE_URL"] ?? "";
if (run) {
  const parsed = new URL(url);
  if (
    !["localhost", "127.0.0.1"].includes(parsed.hostname) ||
    !/^\/smedc_integration_[a-f0-9]{32}$/.test(parsed.pathname) ||
    parsed.search ||
    parsed.hash
  )
    throw new Error("Dish catalog tests require a runner-owned loopback integration database");
}
export const dishCatalogIntegrationSuite = run ? describe : describe.skip;

const enterpriseName = "企业A";
const enterpriseKey = normalizeEnterpriseIdentity(enterpriseName).enterpriseKey;

dishCatalogIntegrationSuite("dish catalog current-state MySQL repository", () => {
  const prisma = new PrismaClient({ adapter: createDatabaseAdapter(url) });
  const repository = createPrismaDishCatalogRepository({ prisma });
  let orgId: string;
  let adminId: string;
  let employeeId: string;
  let kitchenId: string;
  let bbqId: string;
  let retiredDepartmentId: string;

  const actor = (id = adminId) => ({ orgId, id, requestId: "req-dish-catalog" });

  function row(skuId: string, overrides: Record<string, unknown> = {}) {
    return {
      spuId: "SPU-1",
      skuId,
      dishName: "烤串😀",
      brandName: "品牌",
      baseCategoryName: "烧烤",
      level1CategoryCode: "L1",
      level2CategoryCode: null,
      specificationName: null,
      salePrice: "12.50",
      dishAlias: null,
      departmentName: "厨房",
      ...overrides
    };
  }

  async function storedRow(skuId: string) {
    return prisma.dishCatalogEntry.findFirstOrThrow({
      where: { orgId, enterpriseKey, skuId }
    });
  }

  beforeEach(async () => {
    orgId = `dc_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
    adminId = `${orgId}_admin`;
    employeeId = `${orgId}_employee`;
    kitchenId = `${orgId}-kitchen`;
    bbqId = `${orgId}-bbq`;
    retiredDepartmentId = `${orgId}-retired`;
    await prisma.organization.create({ data: { id: orgId, name: "Synthetic dish catalog" } });
    await prisma.userAccount.createMany({
      data: [
        {
          orgId,
          id: adminId,
          email: `${adminId}@example.invalid`,
          displayName: "Admin",
          role: "admin",
          clearance: 3
        },
        {
          orgId,
          id: employeeId,
          email: `${employeeId}@example.invalid`,
          displayName: "Employee",
          role: "employee",
          clearance: 3
        }
      ]
    });
    await prisma.businessAuthorizationState.create({
      data: { orgId, mode: "enabled", version: 1n }
    });
    await prisma.businessCategory.create({
      data: {
        orgId,
        id: "catalog",
        key: "dish_catalog",
        name: "菜品目录",
        kind: "fixed",
        confidentialityLevel: 2,
        allowGroup: true,
        allowStore: false
      }
    });
    await prisma.businessEnterpriseIdentity.createMany({
      data: [
        { orgId, enterpriseName, enterpriseKey },
        {
          orgId,
          enterpriseName: "企业B",
          enterpriseKey: normalizeEnterpriseIdentity("企业B").enterpriseKey
        }
      ]
    });
    await prisma.businessDepartment.createMany({
      data: [
        { orgId, enterpriseKey, departmentId: kitchenId, name: "厨房" },
        { orgId, enterpriseKey, departmentId: bbqId, name: "烧烤部" },
        { orgId, enterpriseKey, departmentId: retiredDepartmentId, name: "已停用部", retired: true }
      ]
    });
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("creates, updates, skips unchanged rows, removes explicit SKUs and keeps timestamps meaningful", async () => {
    await expect(
      repository.upsert(actor(), {
        enterpriseName,
        rows: [row("SKU-A"), row("SKU-B")],
        sourceFileName: "菜单.xlsx"
      })
    ).resolves.toEqual({ received: 2, created: 2, updated: 0, unchanged: 0, removed: 0 });

    const firstA = await storedRow("SKU-A");
    expect(firstA.departmentId).toBe(kitchenId);
    expect(firstA.payload).toEqual({
      spu_id: "SPU-1",
      sku_id: "SKU-A",
      dish_name: "烤串😀",
      brand_name: "品牌",
      base_category_name: "烧烤",
      level_1_category_code: "L1",
      level_2_category_code: null,
      specification_name: null,
      sale_price: "12.5",
      dish_alias: null
    });

    await new Promise((resolve) => setTimeout(resolve, 5));

    await expect(
      repository.upsert(actor(), {
        enterpriseName,
        rows: [row("SKU-A"), row("SKU-B", { salePrice: "13", departmentName: "烧烤部" })]
      })
    ).resolves.toEqual({ received: 2, created: 0, updated: 1, unchanged: 1, removed: 0 });

    const unchangedA = await storedRow("SKU-A");
    expect(unchangedA.updatedAt).toEqual(firstA.updatedAt);
    expect(unchangedA.createdAt).toEqual(firstA.createdAt);
    const updatedB = await storedRow("SKU-B");
    expect(updatedB.updatedAt.getTime()).toBeGreaterThan(firstA.updatedAt.getTime());
    expect(updatedB.departmentId).toBe(bbqId);
    expect(updatedB.payload).toMatchObject({ sale_price: "13" });

    await expect(
      repository.upsert(actor(), {
        enterpriseName,
        rows: [row("SKU-C")],
        removeSkuIds: ["SKU-B", "SKU-MISSING"]
      })
    ).resolves.toEqual({ received: 3, created: 1, updated: 0, unchanged: 0, removed: 1 });

    await expect(
      prisma.dishCatalogEntry.findMany({ where: { orgId }, orderBy: { skuId: "asc" } })
    ).resolves.toMatchObject([{ skuId: "SKU-A" }, { skuId: "SKU-C" }]);
    expect((await storedRow("SKU-C")).createdAt).toEqual((await storedRow("SKU-C")).updatedAt);

    const audits = await prisma.auditLog.findMany({
      where: { orgId, action: "dish_catalog.upsert" },
      orderBy: { createdAt: "asc" }
    });
    expect(audits).toHaveLength(3);
    expect(audits[0]!.metadata).toMatchObject({
      received: 2,
      created: 2,
      updated: 0,
      unchanged: 0,
      removed: 0,
      sourceFileName: "菜单.xlsx"
    });
    expect(audits[2]!.metadata).toMatchObject({
      received: 3,
      created: 1,
      updated: 0,
      unchanged: 0,
      removed: 1
    });
    expect(audits[2]!.metadata).not.toHaveProperty("sourceFileName");
  });

  it("keeps one category resource and one group scope across writes and audits every batch", async () => {
    await repository.upsert(actor(), { enterpriseName, rows: [row("SKU-A")] });
    await repository.upsert(actor(), { enterpriseName, rows: [row("SKU-B")] });
    await repository.upsert(actor(), { enterpriseName, rows: [row("SKU-C")] });

    const resources = await prisma.businessResource.findMany({
      where: { orgId, kind: "structured" },
      include: { scopes: { include: { dimensions: true } } }
    });
    expect(resources).toHaveLength(1);
    expect(resources[0]).toMatchObject({
      resourceKey: `dish-catalog:${enterpriseKey}`,
      categoryId: "catalog",
      valid: true,
      documentId: null,
      sourceDocumentId: null
    });
    expect(resources[0]!.scopes).toHaveLength(1);
    expect(resources[0]!.scopes[0]).toMatchObject({
      enterpriseKey,
      ownership: "group",
      storeName: null
    });
    expect(resources[0]!.scopes[0]!.dimensions).toEqual([]);
    expect(resources[0]!.contentVersion).toBe(3n);

    const audits = await prisma.auditLog.findMany({
      where: { orgId, action: "dish_catalog.upsert" },
      orderBy: { createdAt: "asc" }
    });
    expect(audits).toHaveLength(3);
    expect(audits[0]).toMatchObject({
      actorUserAccountId: adminId,
      requestId: "req-dish-catalog",
      targetType: "dish_catalog",
      result: "succeeded"
    });
    expect(audits[0]!.metadata).toMatchObject({
      enterpriseName,
      enterpriseKey,
      received: 1,
      created: 1,
      updated: 0,
      unchanged: 0,
      removed: 0
    });
  });

  it("rejects missing, retired and ambiguous departments without writing anything", async () => {
    await expect(
      repository.upsert(actor(), {
        enterpriseName,
        rows: [row("SKU-A"), row("SKU-B", { departmentName: "不存在部" })]
      })
    ).rejects.toMatchObject({
      code: "DISH_CATALOG_DEPARTMENT_NOT_FOUND",
      details: { rowIndexes: [1] }
    });
    await expect(
      repository.upsert(actor(), {
        enterpriseName,
        rows: [row("SKU-A", { departmentName: "已停用部" })]
      })
    ).rejects.toMatchObject({
      code: "DISH_CATALOG_DEPARTMENT_NOT_FOUND",
      details: { rowIndexes: [0] }
    });
    await expect(prisma.dishCatalogEntry.count({ where: { orgId } })).resolves.toBe(0);
    await expect(prisma.businessResource.count({ where: { orgId } })).resolves.toBe(0);
    await expect(
      prisma.auditLog.count({ where: { orgId, action: "dish_catalog.upsert" } })
    ).resolves.toBe(0);

    // The unique department-name index (#338) prevents real duplicates; drop it only in this
    // runner-owned schema to exercise the defensive ambiguity guard.
    const [existingIndex] = await prisma.$queryRawUnsafe<Array<{ n: bigint }>>(
      "SELECT COUNT(*) AS n FROM information_schema.statistics WHERE table_schema = DATABASE() AND table_name = 'business_departments' AND index_name = 'business_departments_name_uq'"
    );
    if (Number(existingIndex?.n ?? 0) > 0)
      await prisma.$executeRawUnsafe(
        "ALTER TABLE business_departments DROP INDEX business_departments_name_uq"
      );
    try {
      await prisma.businessDepartment.createMany({
        data: [
          { orgId, enterpriseKey, departmentId: `${orgId}-dup-1`, name: "重复部" },
          { orgId, enterpriseKey, departmentId: `${orgId}-dup-2`, name: "重复部" }
        ]
      });
      await expect(
        repository.upsert(actor(), {
          enterpriseName,
          rows: [row("SKU-A", { departmentName: "重复部" })]
        })
      ).rejects.toMatchObject({
        code: "DISH_CATALOG_DEPARTMENT_AMBIGUOUS",
        details: { rowIndexes: [0] }
      });
      await expect(prisma.dishCatalogEntry.count({ where: { orgId } })).resolves.toBe(0);
    } finally {
      await prisma.businessDepartment.deleteMany({ where: { orgId, name: "重复部" } });
      if (Number(existingIndex?.n ?? 0) > 0)
        await prisma.$executeRawUnsafe(
          "ALTER TABLE business_departments ADD UNIQUE INDEX business_departments_name_uq (org_id, enterprise_key, name_key)"
        );
    }
  });

  it("requires an exact registered enterprise, a current admin, an enabled publication and a usable category", async () => {
    await expect(
      repository.upsert(actor(), { enterpriseName: "未登记企业", rows: [row("SKU-A")] })
    ).rejects.toMatchObject({ code: "DISH_CATALOG_ENTERPRISE_NOT_AVAILABLE" });

    await expect(
      repository.upsert(actor(employeeId), { enterpriseName, rows: [row("SKU-A")] })
    ).rejects.toMatchObject({ code: "UPLOAD_ADMIN_REQUIRED" });

    await prisma.businessAuthorizationState.update({
      where: { orgId },
      data: { mode: "legacy" }
    });
    await expect(
      repository.upsert(actor(), { enterpriseName, rows: [row("SKU-A")] })
    ).rejects.toMatchObject({ code: "AUTHORIZATION_NOT_ENABLED" });
    await prisma.businessAuthorizationState.update({
      where: { orgId },
      data: { mode: "enabled" }
    });

    await prisma.businessCategory.update({
      where: { orgId_id: { orgId, id: "catalog" } },
      data: { retired: true }
    });
    await expect(
      repository.upsert(actor(), { enterpriseName, rows: [row("SKU-A")] })
    ).rejects.toMatchObject({ code: "RESOURCE_CATEGORY_NOT_CONFIGURED" });

    await prisma.businessCategory.update({
      where: { orgId_id: { orgId, id: "catalog" } },
      data: { retired: false }
    });
    await prisma.businessDimension.create({
      data: { orgId, id: "region", name: "Region" }
    });
    await prisma.businessCategoryDimension.create({
      data: { orgId, categoryId: "catalog", dimensionId: "region" }
    });
    await expect(
      repository.upsert(actor(), { enterpriseName, rows: [row("SKU-A")] })
    ).rejects.toMatchObject({ code: "RESOURCE_CATEGORY_NOT_CONFIGURED" });

    await expect(prisma.dishCatalogEntry.count({ where: { orgId } })).resolves.toBe(0);
    await expect(prisma.businessResource.count({ where: { orgId } })).resolves.toBe(0);
  });

  it("enforces the department foreign key and one row per organization, enterprise and SKU", async () => {
    const base = {
      id: randomUUID().replaceAll("-", ""),
      orgId,
      enterpriseKey,
      payload: {}
    };
    await expect(
      prisma.dishCatalogEntry.create({
        data: { ...base, skuId: "SKU-FK", departmentId: "missing-department" }
      })
    ).rejects.toMatchObject({ code: "P2003" });

    await prisma.dishCatalogEntry.create({ data: { ...base, skuId: "SKU-UNIQUE" } });
    await expect(
      prisma.dishCatalogEntry.create({
        data: { ...base, id: randomUUID().replaceAll("-", ""), skuId: "SKU-UNIQUE" }
      })
    ).rejects.toMatchObject({ code: "P2002" });
  });

  it("authorizes catalog rows and coverage only through the granted enterprise resource", async () => {
    await repository.upsert(actor(), { enterpriseName, rows: [row("SKU-A")] });
    await repository.upsert(actor(), {
      enterpriseName: "企业B",
      rows: [row("SKU-B", { departmentName: null })]
    });

    const readerId = `${orgId}_reader`;
    await prisma.userAccount.create({
      data: {
        orgId,
        id: readerId,
        email: `${readerId}@example.invalid`,
        displayName: "Reader",
        role: "employee",
        clearance: 3
      }
    });
    await prisma.businessGrant.create({
      data: {
        orgId,
        id: "catalog-reader-grant",
        userAccountId: readerId,
        enterpriseKey,
        ownership: "group"
      }
    });
    await prisma.businessGrantCategory.create({
      data: { orgId, grantId: "catalog-reader-grant", categoryId: "catalog" }
    });

    const permissions = createBusinessAuthorizationRepository({ prisma });
    const readCatalog = async (userAccountId: string) => {
      const scope = compileStructuredReadScope(
        await permissions.loadAuthorizationSnapshot(userAccountId, orgId),
        "catalog",
        "dish_catalog"
      );
      return prisma.$queryRawUnsafe<Array<{ sku_id: string }>>(
        `SELECT r.sku_id FROM dish_catalog_entries r WHERE r.org_id = ? AND (${scope.sql}) ORDER BY r.sku_id`,
        orgId,
        ...scope.params
      );
    };

    await expect(readCatalog(readerId)).resolves.toEqual([{ sku_id: "SKU-A" }]);
    // An administrator without an ordinary grant cannot read the catalog.
    await expect(readCatalog(adminId)).resolves.toEqual([]);

    const readerScope = compileStructuredReadScope(
      await permissions.loadAuthorizationSnapshot(readerId, orgId),
      "catalog",
      "dish_catalog"
    );
    const coverage = compileStructuredCoverageQuery({
      orgId,
      employee: { id: readerId, clearance: 3 },
      dataset: "dish_catalog",
      businessAuthorization: readerScope
    });
    const [coverageRow] = await prisma.$queryRawUnsafe<
      Array<{ row_count: bigint; last_updated_at: Date | null }>
    >(coverage.sql!, ...coverage.params);
    expect(Number(coverageRow!.row_count)).toBe(1);
    expect(coverageRow!.last_updated_at).toBeInstanceOf(Date);

    // A category without a configured confidentiality level stops matching grants.
    await prisma.businessCategory.update({
      where: { orgId_id: { orgId, id: "catalog" } },
      data: { confidentialityLevel: null }
    });
    await expect(readCatalog(readerId)).resolves.toEqual([]);
  });

  it("keeps the catalog resource after every row is removed", async () => {
    await repository.upsert(actor(), { enterpriseName, rows: [row("SKU-A")] });
    await expect(
      repository.upsert(actor(), { enterpriseName, removeSkuIds: ["SKU-A"] })
    ).resolves.toEqual({ received: 1, created: 0, updated: 0, unchanged: 0, removed: 1 });
    await expect(prisma.dishCatalogEntry.count({ where: { orgId } })).resolves.toBe(0);
    await expect(
      prisma.businessResource.count({
        where: { orgId, resourceKey: `dish-catalog:${enterpriseKey}` }
      })
    ).resolves.toBe(1);
  });
});
