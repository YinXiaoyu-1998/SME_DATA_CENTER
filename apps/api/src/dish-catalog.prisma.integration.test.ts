import { randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { afterAll, describe, expect, it } from "vitest";
import {
  createBusinessAuthorizationRepository,
  createDatabaseAdapter,
  createPrismaDishCatalogRepository
} from "@smedc/db";
import { normalizeEnterpriseIdentity, type AuthenticatedEmployee } from "@smedc/domain";
import { createBusinessAuthorizationService } from "./business-authorization.js";
import { createDishCatalogService } from "./dish-catalog.js";
import { createActionMcpToolHandlers } from "./mcp/action-tools.js";
import { buildApiServer } from "./server.js";
import { createPrismaStructuredCoverageRepository } from "./structured-coverage.js";
import { createPrismaStructuredQueryRepository } from "./structured-query.js";

const run = process.env["RUN_DISH_CATALOG_HTTP_INTEGRATION"] === "1";
const url = process.env["DATABASE_URL"] ?? "";
if (run) {
  const parsed = new URL(url);
  if (
    !["localhost", "127.0.0.1"].includes(parsed.hostname) ||
    !/^\/smedc_integration_[a-f0-9]{32}$/.test(parsed.pathname) ||
    parsed.search ||
    parsed.hash
  )
    throw new Error("Dish catalog HTTP tests require a runner-owned loopback integration database");
}
const suite = run ? describe : describe.skip;

const enterpriseName = "菜品目录集成企业";
const otherEnterpriseName = "菜品目录集成企业B";

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

suite("dish catalog current-state HTTP seam", () => {
  const prisma = new PrismaClient({ adapter: createDatabaseAdapter(url) });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  async function fixture() {
    const orgId = `dish_http_${randomUUID().replaceAll("-", "").slice(0, 10)}`;
    const adminId = `${orgId}_admin`;
    const readerId = `${orgId}_reader`;
    const enterpriseKey = normalizeEnterpriseIdentity(enterpriseName).enterpriseKey;
    const otherEnterpriseKey = normalizeEnterpriseIdentity(otherEnterpriseName).enterpriseKey;
    const kitchenId = `${orgId}-kitchen`;
    const bbqId = `${orgId}-bbq`;
    const admin: AuthenticatedEmployee = {
      id: adminId,
      orgId,
      organizationName: "Synthetic",
      displayName: "Admin",
      email: `${adminId}@example.invalid`,
      role: "admin",
      disabled: false,
      clearance: 3
    };
    const reader: AuthenticatedEmployee = {
      ...admin,
      id: readerId,
      displayName: "Reader",
      email: `${readerId}@example.invalid`,
      role: "employee"
    };

    await prisma.organization.create({ data: { id: orgId, name: "Synthetic dish catalog HTTP" } });
    await prisma.userAccount.createMany({
      data: [
        {
          orgId,
          id: adminId,
          email: admin.email,
          displayName: admin.displayName,
          role: "admin",
          clearance: 3
        },
        {
          orgId,
          id: readerId,
          email: reader.email,
          displayName: reader.displayName,
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
        { orgId, enterpriseName: otherEnterpriseName, enterpriseKey: otherEnterpriseKey }
      ]
    });
    await prisma.businessDepartment.createMany({
      data: [
        // Stored with an accent; the API request below uses a case/accent variant.
        { orgId, enterpriseKey, departmentId: kitchenId, name: "Café" },
        { orgId, enterpriseKey, departmentId: bbqId, name: "烧烤部" }
      ]
    });
    const grantId = `${orgId}_grant`;
    await prisma.businessGrant.create({
      data: {
        orgId,
        id: grantId,
        userAccountId: readerId,
        enterpriseKey,
        ownership: "group"
      }
    });
    await prisma.businessGrantCategory.create({
      data: { orgId, grantId, categoryId: "catalog" }
    });

    const permissions = createBusinessAuthorizationRepository({ prisma });
    const app = buildApiServer({
      logger: false,
      runtimeEnv: {
        DATABASE_URL: url,
        SMEDC_API_ORIGIN: "https://dish-catalog.example.invalid",
        SMEDC_WEB_ORIGIN: "https://dish-catalog.example.invalid"
      },
      cursorSigningSecret: "synthetic-dish-catalog-secret",
      authenticateAccessToken: async (token) => {
        if (token === "admin-token") return admin;
        if (token === "reader-token") return reader;
        return null;
      },
      businessAuthorizationService: createBusinessAuthorizationService(permissions),
      dishCatalogService: createDishCatalogService({
        repository: createPrismaDishCatalogRepository({ prisma })
      }),
      structuredQueryRepository: createPrismaStructuredQueryRepository(url),
      structuredCoverageRepository: createPrismaStructuredCoverageRepository(url)
    });

    const headers = (token: string) => ({
      authorization: `Bearer ${token}`,
      "content-type": "application/json"
    });

    return { app, orgId, enterpriseKey, kitchenId, otherEnterpriseName, headers };
  }

  it("writes, queries and reports coverage through the public routes", async () => {
    const { app, orgId, enterpriseKey, kitchenId, headers } = await fixture();
    try {
      const upsert = (payload: Record<string, unknown>) =>
        app.inject({
          method: "POST",
          url: "/v1/dish-catalog/upsert",
          headers: headers("admin-token"),
          payload
        });

      const created = await upsert({
        enterpriseName,
        rows: [
          row("SKU-A", { dishName: "菜品A", departmentName: "CAFE", salePrice: "12.50" }),
          row("SKU-B", { dishName: "菜品B", departmentName: "烧烤部", salePrice: "0" })
        ],
        removeSkuIds: ["SKU-MISSING"],
        sourceFileName: "菜单.xlsx"
      });
      expect(created.statusCode).toBe(200);
      expect(created.json()).toEqual({
        received: 3,
        created: 2,
        updated: 0,
        unchanged: 0,
        removed: 0
      });

      // The case/accent variant resolves to the stored department; the unchanged row keeps its time.
      const changed = await upsert({
        enterpriseName,
        rows: [
          row("SKU-A", { dishName: "菜品A", departmentName: "Café", salePrice: "13" }),
          row("SKU-B", { dishName: "菜品B", departmentName: "烧烤部", salePrice: "0" })
        ]
      });
      expect(changed.statusCode).toBe(200);
      expect(changed.json()).toEqual({
        received: 2,
        created: 0,
        updated: 1,
        unchanged: 1,
        removed: 0
      });

      // A catalog in another enterprise is written but must stay invisible to an A-only grant.
      const other = await upsert({
        enterpriseName: otherEnterpriseName,
        rows: [row("SKU-OTHER", { departmentName: null })]
      });
      expect(other.statusCode).toBe(200);
      expect(other.json()).toMatchObject({ created: 1 });

      const query = await app.inject({
        method: "POST",
        url: "/v1/structured/query",
        headers: headers("reader-token"),
        payload: {
          dataset: "dish_catalog",
          select: [
            "sku_id",
            "dish_name",
            "sale_price",
            "department_id",
            "department_name",
            "updated_at"
          ]
        }
      });
      expect(query.statusCode).toBe(200);
      const rows = query.json().rows as Array<Record<string, unknown>>;
      expect(rows.map((item) => item["sku_id"])).toEqual(["SKU-A", "SKU-B"]);
      expect(rows[0]).toMatchObject({
        sku_id: "SKU-A",
        dish_name: "菜品A",
        department_id: kitchenId,
        department_name: "Café"
      });
      expect(Number(rows[0]!["sale_price"])).toBe(13);
      expect(Number(rows[1]!["sale_price"])).toBe(0);
      expect(typeof rows[0]!["updated_at"]).toBe("string");

      const coverage = await app.inject({
        method: "GET",
        url: "/v1/structured/datasets/dish_catalog/coverage",
        headers: { authorization: "Bearer reader-token" }
      });
      expect(coverage.statusCode).toBe(200);
      expect(coverage.json()).toMatchObject({
        dataset: "dish_catalog",
        metadataPolicy: "current",
        rowCount: 2
      });
      expect(typeof coverage.json().lastUpdatedAt).toBe("string");

      // Writing requires admin; it grants no ordinary read access.
      const adminQuery = await app.inject({
        method: "POST",
        url: "/v1/structured/query",
        headers: headers("admin-token"),
        payload: { dataset: "dish_catalog", select: ["sku_id"] }
      });
      expect(adminQuery.statusCode).toBe(200);
      expect(adminQuery.json().rows).toEqual([]);
      const adminCoverage = await app.inject({
        method: "GET",
        url: "/v1/structured/datasets/dish_catalog/coverage",
        headers: { authorization: "Bearer admin-token" }
      });
      expect(adminCoverage.json()).toEqual({
        dataset: "dish_catalog",
        metadataPolicy: "current",
        rowCount: 0,
        lastUpdatedAt: null
      });

      const removed = await upsert({ enterpriseName, removeSkuIds: ["SKU-B"] });
      expect(removed.statusCode).toBe(200);
      expect(removed.json()).toEqual({
        received: 1,
        created: 0,
        updated: 0,
        unchanged: 0,
        removed: 1
      });

      const afterRemoval = await app.inject({
        method: "GET",
        url: "/v1/structured/datasets/dish_catalog/coverage",
        headers: { authorization: "Bearer reader-token" }
      });
      expect(afterRemoval.json()).toMatchObject({ rowCount: 1 });

      // The per-enterprise catalog resource and its single group scope anchor both reads.
      const resources = await prisma.businessResource.findMany({
        where: { orgId, resourceKey: `dish-catalog:${enterpriseKey}` },
        include: { scopes: true }
      });
      expect(resources).toHaveLength(1);
      expect(resources[0]!.scopes).toHaveLength(1);
      expect(resources[0]!.scopes[0]).toMatchObject({
        enterpriseKey,
        ownership: "group",
        storeName: null
      });
    } finally {
      await app.close();
    }
  });

  it("keeps null fields and replayed cursors intact, and hides a retired category", async () => {
    const { app, orgId, headers } = await fixture();
    try {
      const payload = {
        enterpriseName,
        rows: [
          row("SKU-A", { departmentName: null }),
          row("SKU-B", {
            departmentName: null,
            dishAlias: "null"
          })
        ]
      };
      const upsert = () =>
        app.inject({
          method: "POST",
          url: "/v1/dish-catalog/upsert",
          headers: headers("admin-token"),
          payload
        });
      const read = (cursor?: string) =>
        app.inject({
          method: "POST",
          url: "/v1/structured/query",
          headers: headers("reader-token"),
          payload: {
            dataset: "dish_catalog",
            select: ["sku_id", "dish_alias"],
            page: { limit: 1, cursor }
          }
        });
      expect((await upsert()).statusCode).toBe(200);
      const first = await read();
      expect(first.json().rows).toEqual([{ sku_id: "SKU-A", dish_alias: null }]);
      const cursor = first.json().nextCursor as string;
      expect(cursor).toEqual(expect.any(String));
      expect((await upsert()).json()).toMatchObject({ unchanged: 2 });
      const second = await read(cursor);
      expect(second.statusCode).toBe(200);
      expect(second.json().rows).toEqual([{ sku_id: "SKU-B", dish_alias: "null" }]);

      await prisma.businessCategory.update({
        where: { orgId_id: { orgId, id: "catalog" } },
        data: { retired: true }
      });
      expect((await read()).json().rows).toEqual([]);
      const coverage = await app.inject({
        method: "GET",
        url: "/v1/structured/datasets/dish_catalog/coverage",
        headers: { authorization: "Bearer reader-token" }
      });
      expect(coverage.json()).toMatchObject({ rowCount: 0, lastUpdatedAt: null });
    } finally {
      await app.close();
    }
  });

  it("rejects non-admins, altered enterprise names and null arrays with public errors", async () => {
    const { app, headers } = await fixture();
    try {
      const upsert = (token: string, payload: Record<string, unknown>) =>
        app.inject({
          method: "POST",
          url: "/v1/dish-catalog/upsert",
          headers: headers(token),
          payload
        });
      const denied = await upsert("reader-token", { enterpriseName, removeSkuIds: ["SKU-A"] });
      expect(denied.statusCode).toBe(403);
      expect(denied.json().error.code).toBe("UPLOAD_ADMIN_REQUIRED");
      for (const name of [` ${enterpriseName} `, " "]) {
        const invalid = await upsert("admin-token", {
          enterpriseName: name,
          removeSkuIds: ["SKU-A"]
        });
        expect(invalid.statusCode).toBe(400);
        expect(invalid.json().error.code).toBe("DISH_CATALOG_ENTERPRISE_NOT_AVAILABLE");
      }
      const invalid = await upsert("admin-token", {
        enterpriseName,
        rows: null,
        removeSkuIds: ["SKU-A"]
      });
      expect(invalid.statusCode).toBe(400);
      expect(invalid.json().error).toMatchObject({
        code: "DISH_CATALOG_INVALID_INPUT",
        details: { field: "rows" }
      });
    } finally {
      await app.close();
    }
  });

  it("returns specific bounded errors through HTTP and MCP", async () => {
    const { app, headers } = await fixture();
    try {
      const duplicateRows = Array.from({ length: 60 }, (_, index) =>
        row("SKU-DUP", { dishName: `菜品${index}` })
      );
      const duplicate = await app.inject({
        method: "POST",
        url: "/v1/dish-catalog/upsert",
        headers: headers("admin-token"),
        payload: { enterpriseName, rows: duplicateRows }
      });
      expect(duplicate.statusCode).toBe(400);
      expect(duplicate.json().error).toMatchObject({
        code: "DISH_CATALOG_DUPLICATE_SKU",
        details: { field: "skuId" }
      });
      expect(duplicate.json().error.details.rowIndexes).toHaveLength(50);

      const conflict = await app.inject({
        method: "POST",
        url: "/v1/dish-catalog/upsert",
        headers: headers("admin-token"),
        payload: { enterpriseName, rows: [row("SKU-CONFLICT")], removeSkuIds: ["SKU-CONFLICT"] }
      });
      expect(conflict.statusCode).toBe(400);
      expect(conflict.json().error).toMatchObject({
        code: "DISH_CATALOG_SKU_CONFLICT",
        details: { field: "skuId", rowIndexes: [0] }
      });

      const invalidRows = Array.from({ length: 60 }, (_, index) =>
        row(`SKU-INVALID-${index}`, { dishName: "" })
      );
      const invalid = await app.inject({
        method: "POST",
        url: "/v1/dish-catalog/upsert",
        headers: headers("admin-token"),
        payload: { enterpriseName, rows: invalidRows }
      });
      expect(invalid.statusCode).toBe(400);
      expect(invalid.json().error).toMatchObject({
        code: "DISH_CATALOG_INVALID_INPUT",
        details: { field: "dishName" }
      });
      expect(invalid.json().error.details.rowIndexes).toHaveLength(50);

      const handlers = createActionMcpToolHandlers({
        bearerToken: "admin-token",
        audit: {
          requestId: "req_mcp_dish_catalog",
          sourceIp: "127.0.0.1",
          clientSource: "mcp_launcher",
          launcherVersion: null
        },
        delegationProof: "synthetic-delegation-proof",
        async inject(request) {
          const response = await app.inject({
            method: request.method,
            url: request.url,
            headers: request.headers,
            ...(request.payload === undefined ? {} : { payload: request.payload as object })
          });
          return {
            statusCode: response.statusCode,
            payload: response.body
          };
        }
      });

      // The MCP contract must not collapse these semantics into "Invalid dish catalog batch.".
      const mcpDuplicate = await handlers.upsert_dish_catalog?.(
        { enterpriseName, rows: duplicateRows },
        {} as never
      );
      expect(mcpDuplicate?.isError).toBe(true);
      const duplicateBody = JSON.parse(mcpDuplicate!.content[0]!.text) as {
        error: { code: string; details?: { field?: string; rowIndexes?: number[] } };
      };
      expect(duplicateBody.error).toMatchObject({
        code: "DISH_CATALOG_DUPLICATE_SKU",
        details: { field: "skuId" }
      });
      expect(duplicateBody.error.details?.rowIndexes).toHaveLength(50);

      const mcpConflict = await handlers.upsert_dish_catalog?.(
        {
          enterpriseName,
          rows: [row("SKU-CONFLICT")],
          removeSkuIds: ["SKU-CONFLICT"]
        },
        {} as never
      );
      expect(mcpConflict?.isError).toBe(true);
      expect(JSON.parse(mcpConflict!.content[0]!.text)).toMatchObject({
        error: {
          code: "DISH_CATALOG_SKU_CONFLICT",
          details: { field: "skuId", rowIndexes: [0] }
        }
      });
    } finally {
      await app.close();
    }
  });
});
