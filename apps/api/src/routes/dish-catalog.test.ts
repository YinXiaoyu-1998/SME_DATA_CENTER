import { describe, expect, it, vi } from "vitest";
import { DISH_CATALOG_LIMITS } from "@smedc/domain";
import { DishCatalogRepositoryError } from "@smedc/db";
import { buildApiServer } from "../server.js";
import { createDishCatalogService, DISH_CATALOG_BATCH_BYTES } from "../dish-catalog.js";

const row = {
  spuId: "spu_1",
  skuId: "sku_1",
  dishName: "合成菜品",
  brandName: "合成品牌",
  baseCategoryName: "主食",
  level1CategoryCode: "L1",
  salePrice: "12.50"
};

function fixture() {
  const repository = {
    upsert: vi.fn(async () => ({
      received: 3,
      created: 1,
      updated: 0,
      unchanged: 1,
      removed: 1
    }))
  };
  const app = buildApiServer({
    logger: false,
    runtimeEnv: {},
    cursorSigningSecret: "test-secret",
    authenticateAccessToken: async () => ({
      id: "admin",
      orgId: "org",
      role: "admin",
      disabled: false,
      clearance: 3,
      displayName: "Admin",
      email: "admin@example.invalid",
      organizationName: "Synthetic"
    }),
    dishCatalogService: createDishCatalogService({ repository })
  });
  return { app, repository };
}

const headers = { authorization: "Bearer synthetic", "content-type": "application/json" };

describe("authenticated dish catalog upsert route", () => {
  it("requires authentication, keeps no-store and returns the atomic batch counts", async () => {
    const { app, repository } = fixture();
    try {
      expect(
        (
          await app.inject({
            method: "POST",
            url: "/v1/dish-catalog/upsert",
            headers: { "content-type": "application/json" },
            payload: { enterpriseName: "合成企业", rows: [row] }
          })
        ).statusCode
      ).toBe(401);
      expect(repository.upsert).not.toHaveBeenCalled();

      const response = await app.inject({
        method: "POST",
        url: "/v1/dish-catalog/upsert",
        headers,
        payload: {
          enterpriseName: "合成企业",
          rows: [row, { ...row, skuId: "sku_2", salePrice: "0", departmentName: null }],
          removeSkuIds: ["sku_3"],
          sourceFileName: "catalog.xlsx"
        }
      });

      expect(response.statusCode).toBe(200);
      expect(response.headers["cache-control"]).toBe("no-store");
      expect(response.json()).toEqual({
        received: 3,
        created: 1,
        updated: 0,
        unchanged: 1,
        removed: 1
      });
      expect(repository.upsert).toHaveBeenCalledOnce();
      expect(repository.upsert).toHaveBeenCalledWith(
        { id: "admin", orgId: "org", requestId: expect.any(String) },
        {
          enterpriseName: "合成企业",
          rows: [
            {
              ...row,
              level2CategoryCode: null,
              specificationName: null,
              salePrice: "12.5",
              dishAlias: null,
              departmentName: null
            },
            {
              ...row,
              skuId: "sku_2",
              level2CategoryCode: null,
              specificationName: null,
              salePrice: "0",
              dishAlias: null,
              departmentName: null
            }
          ],
          removeSkuIds: ["sku_3"],
          sourceFileName: "catalog.xlsx"
        }
      );
    } finally {
      await app.close();
    }
  });

  it("echoes only fixed field names and bounded row indexes", async () => {
    const { app, repository } = fixture();
    try {
      const unknownRowField = await app.inject({
        method: "POST",
        url: "/v1/dish-catalog/upsert",
        headers,
        payload: {
          enterpriseName: "合成企业",
          rows: [{ ...row, "Private customer body": "value" }]
        }
      });
      expect(unknownRowField.statusCode).toBe(400);
      expect(unknownRowField.json().error).toMatchObject({
        code: "DISH_CATALOG_INVALID_INPUT",
        requestId: expect.any(String),
        details: { rowIndexes: [0] }
      });
      expect(unknownRowField.body).not.toContain("Private customer body");

      const unknownTopLevel = await app.inject({
        method: "POST",
        url: "/v1/dish-catalog/upsert",
        headers,
        payload: { enterpriseName: "合成企业", rows: [row], secretNote: "private" }
      });
      expect(unknownTopLevel.statusCode).toBe(400);
      expect(unknownTopLevel.json().error.details).toEqual({});
      expect(unknownTopLevel.body).not.toContain("secretNote");

      const fixedField = await app.inject({
        method: "POST",
        url: "/v1/dish-catalog/upsert",
        headers,
        payload: {
          enterpriseName: "合成企业",
          rows: [{ ...row, dishName: "x".repeat(DISH_CATALOG_LIMITS.dishNameChars + 1) }]
        }
      });
      expect(fixedField.statusCode).toBe(400);
      expect(fixedField.json().error.details).toEqual({ field: "dishName", rowIndexes: [0] });

      const invalidRows = await app.inject({
        method: "POST",
        url: "/v1/dish-catalog/upsert",
        headers,
        payload: {
          enterpriseName: "合成企业",
          rows: Array.from({ length: 60 }, (_, index) => ({
            ...row,
            skuId: `sku_${index}`,
            dishName: ""
          }))
        }
      });
      expect(invalidRows.statusCode).toBe(400);
      expect(invalidRows.json().error.details.rowIndexes).toEqual(
        Array.from({ length: DISH_CATALOG_LIMITS.maxRowIndexes }, (_, index) => index)
      );
      expect(repository.upsert).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it("maps repository authorization and conflict failures to public statuses", async () => {
    const { app, repository } = fixture();
    try {
      for (const [code, status] of [
        ["UPLOAD_ADMIN_REQUIRED", 403],
        ["AUTHORIZATION_NOT_ENABLED", 403],
        ["RESOURCE_CATEGORY_NOT_CONFIGURED", 403],
        ["DISH_CATALOG_DEPARTMENT_NOT_FOUND", 400],
        ["DISH_CATALOG_DEPARTMENT_AMBIGUOUS", 400],
        ["DISH_CATALOG_ENTERPRISE_NOT_AVAILABLE", 400]
      ] as const) {
        repository.upsert.mockRejectedValueOnce(
          new DishCatalogRepositoryError(code, {
            rowIndexes: Array.from({ length: 60 }, (_, index) => index)
          })
        );
        const response = await app.inject({
          method: "POST",
          url: "/v1/dish-catalog/upsert",
          headers,
          payload: { enterpriseName: "合成企业", rows: [row] }
        });
        expect(response.statusCode, code).toBe(status);
        expect(response.json().error.code).toBe(code);
        if (status === 400)
          expect(response.json().error.details.rowIndexes).toHaveLength(
            DISH_CATALOG_LIMITS.maxRowIndexes
          );
      }

      repository.upsert.mockRejectedValueOnce(
        new DishCatalogRepositoryError("RESOURCE_IDENTITY_IMMUTABLE")
      );
      const invariant = await app.inject({
        method: "POST",
        url: "/v1/dish-catalog/upsert",
        headers,
        payload: { enterpriseName: "合成企业", rows: [row] }
      });
      expect(invariant.statusCode).toBe(500);
      expect(invariant.json().error.code).toBe("INTERNAL_ERROR");
      expect(invariant.body).not.toContain("RESOURCE_IDENTITY_IMMUTABLE");

      repository.upsert.mockRejectedValueOnce(new Error("database exploded"));
      const unknown = await app.inject({
        method: "POST",
        url: "/v1/dish-catalog/upsert",
        headers,
        payload: { enterpriseName: "合成企业", rows: [row] }
      });
      expect(unknown.statusCode).toBe(500);
      expect(unknown.json().error.code).toBe("INTERNAL_ERROR");
      expect(unknown.body).not.toContain("database exploded");
    } finally {
      await app.close();
    }
  });

  it("rejects malformed transport and domain batches before any side effect", async () => {
    const { app, repository } = fixture();
    try {
      const missingBody = await app.inject({
        method: "POST",
        url: "/v1/dish-catalog/upsert",
        headers: { authorization: headers.authorization }
      });
      expect(missingBody.statusCode).toBe(400);
      expect(missingBody.json().error.code).toBe("DISH_CATALOG_INVALID_INPUT");

      const malformed = await app.inject({
        method: "POST",
        url: "/v1/dish-catalog/upsert",
        headers,
        payload: "{"
      });
      expect(malformed.statusCode).toBe(400);
      expect(malformed.json().error.code).toBe("INVALID_REQUEST");

      const emptyBatch = await app.inject({
        method: "POST",
        url: "/v1/dish-catalog/upsert",
        headers,
        payload: { enterpriseName: "合成企业", rows: [], removeSkuIds: [] }
      });
      expect(emptyBatch.statusCode).toBe(400);
      expect(emptyBatch.json().error.code).toBe("DISH_CATALOG_INVALID_INPUT");
      expect(repository.upsert).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });
});

it("rejects request bodies above 16 MiB without invoking the repository", async () => {
  const { app, repository } = fixture();
  try {
    expect(DISH_CATALOG_BATCH_BYTES).toBe(16 * 1024 * 1024);
    const response = await app.inject({
      method: "POST",
      url: "/v1/dish-catalog/upsert",
      headers,
      payload: JSON.stringify({
        enterpriseName: "合成企业",
        rows: [row],
        padding: "x".repeat(DISH_CATALOG_BATCH_BYTES)
      })
    });
    expect(response.statusCode).toBe(413);
    expect(response.json().error.code).toBe("PAYLOAD_TOO_LARGE");
    expect(repository.upsert).not.toHaveBeenCalled();
  } finally {
    await app.close();
  }
});
