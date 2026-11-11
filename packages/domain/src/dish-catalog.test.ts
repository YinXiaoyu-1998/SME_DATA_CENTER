import { describe, expect, it } from "vitest";
import {
  DISH_CATALOG_ERROR_CODES,
  DISH_CATALOG_LIMITS,
  DishCatalogValidationError,
  normalizeDishCatalogSalePrice,
  parseDishCatalogBatch
} from "./dish-catalog.js";

function row(overrides: Record<string, unknown> = {}) {
  return {
    spuId: "SPU-1",
    skuId: "SKU-1",
    dishName: "招牌烧烤",
    brandName: "示例品牌",
    baseCategoryName: "烧烤",
    level1CategoryCode: "L1",
    salePrice: "12.50",
    ...overrides
  };
}

function parseError(input: unknown): DishCatalogValidationError {
  try {
    parseDishCatalogBatch(input);
  } catch (error) {
    expect(error).toBeInstanceOf(DishCatalogValidationError);
    return error as DishCatalogValidationError;
  }
  throw new Error("Expected dish catalog validation to fail.");
}

describe("dish catalog batch validation", () => {
  it("preserves business values and canonicalizes only the sale price", () => {
    const parsed = parseDishCatalogBatch({
      enterpriseName: " 示例企业 ",
      sourceFileName: "菜单 2026-11.xlsx",
      rows: [
        row({
          spuId: "SPU 001",
          skuId: "SKU-1",
          dishName: "  招牌烧烤 ",
          salePrice: "001.2000",
          departmentName: "烧烤部"
        }),
        row({
          skuId: "SKU-2",
          dishName: "凉菜",
          salePrice: "0.000",
          level2CategoryCode: null,
          specificationName: "小份",
          dishAlias: ""
        })
      ],
      removeSkuIds: ["SKU-3"]
    });

    expect(parsed.enterpriseName).toBe(" 示例企业 ");
    expect(parsed.sourceFileName).toBe("菜单 2026-11.xlsx");
    expect(parsed.removeSkuIds).toEqual(["SKU-3"]);
    expect(parsed.rows[0]).toEqual({
      spuId: "SPU 001",
      skuId: "SKU-1",
      dishName: "  招牌烧烤 ",
      brandName: "示例品牌",
      baseCategoryName: "烧烤",
      level1CategoryCode: "L1",
      level2CategoryCode: null,
      specificationName: null,
      salePrice: "1.2",
      dishAlias: null,
      departmentName: "烧烤部"
    });
    expect(parsed.rows[1]).toMatchObject({
      salePrice: "0",
      level2CategoryCode: null,
      specificationName: "小份",
      dishAlias: "",
      departmentName: null
    });
  });

  it("rejects unknown top-level and row fields", () => {
    const topLevel = parseError({ enterpriseName: "示例企业", rows: [], unexpected: true });
    expect(topLevel.code).toBe(DISH_CATALOG_ERROR_CODES.invalidInput);
    expect(topLevel.details).toEqual({ field: "unexpected", rowIndexes: [] });

    const rowLevel = parseError({
      enterpriseName: "示例企业",
      rows: [row({ skuCode: "SKU-1" })]
    });
    expect(rowLevel.code).toBe(DISH_CATALOG_ERROR_CODES.invalidInput);
    expect(rowLevel.details).toEqual({ field: "skuCode", rowIndexes: [0] });
  });

  it("rejects missing, empty, oversized and malformed row fields with bounded indexes", () => {
    for (const [overrides, field] of [
      [{ skuId: undefined }, "skuId"],
      [{ skuId: "" }, "skuId"],
      [{ dishName: "x".repeat(DISH_CATALOG_LIMITS.dishNameChars + 1) }, "dishName"],
      [{ salePrice: "12.1234567" }, "salePrice"],
      [{ salePrice: "-1" }, "salePrice"],
      [
        { level2CategoryCode: "x".repeat(DISH_CATALOG_LIMITS.level2CategoryCodeChars + 1) },
        "level2CategoryCode"
      ]
    ] as const) {
      const error = parseError({ enterpriseName: "示例企业", rows: [row(overrides)] });
      expect(error.code, field).toBe(DISH_CATALOG_ERROR_CODES.invalidInput);
      expect(error.details, field).toEqual({ field, rowIndexes: [0] });
    }
  });

  it("rejects oversized enterprise and source file names", () => {
    const enterprise = parseError({
      enterpriseName: "企".repeat(DISH_CATALOG_LIMITS.enterpriseNameChars + 1),
      rows: [row()]
    });
    expect(enterprise.details).toEqual({
      field: "enterpriseName",
      rowIndexes: []
    });

    const sourceFile = parseError({
      enterpriseName: "示例企业",
      sourceFileName: "x".repeat(DISH_CATALOG_LIMITS.sourceFileNameChars + 1),
      rows: [row()]
    });
    expect(sourceFile.details).toEqual({
      field: "sourceFileName",
      rowIndexes: []
    });
  });

  it("canonicalizes canonical decimal text without floating point", () => {
    expect(normalizeDishCatalogSalePrice("0")).toBe("0");
    expect(normalizeDishCatalogSalePrice("0001.230000")).toBe("1.23");
    expect(normalizeDishCatalogSalePrice("0.000100")).toBe("0.0001");
    expect(normalizeDishCatalogSalePrice("12345678901234.123456")).toBe("12345678901234.123456");

    for (const value of ["", "-1", "1.", ".5", "1.1234567", "123456789012345", "1e3"]) {
      expect(() => normalizeDishCatalogSalePrice(value), value).toThrowError(
        expect.objectContaining({ code: DISH_CATALOG_ERROR_CODES.invalidInput })
      );
    }
  });

  it("bounds reported row indexes to fifty", () => {
    const rows = Array.from({ length: 60 }, (_, index) =>
      row({ skuId: `SKU-${index}`, salePrice: "not-a-decimal" })
    );
    const error = parseError({ enterpriseName: "示例企业", rows });

    expect(error.code).toBe(DISH_CATALOG_ERROR_CODES.invalidInput);
    expect(error.details).toEqual({
      field: "salePrice",
      rowIndexes: Array.from({ length: DISH_CATALOG_LIMITS.maxRowIndexes }, (_, index) => index)
    });
  });

  it("rejects duplicate SKUs inside the batch", () => {
    const error = parseError({
      enterpriseName: "示例企业",
      rows: [row({ skuId: "SKU-1" }), row({ skuId: "SKU-2" }), row({ skuId: "SKU-1" })]
    });

    expect(error.code).toBe(DISH_CATALOG_ERROR_CODES.duplicateSku);
    expect(error.details).toEqual({ field: "skuId", rowIndexes: [0, 2] });
  });

  it("rejects the same SKU being written and removed", () => {
    const error = parseError({
      enterpriseName: "示例企业",
      rows: [row({ skuId: "SKU-1" }), row({ skuId: "SKU-2" }), row({ skuId: "SKU-1" })],
      removeSkuIds: ["SKU-2"]
    });

    expect(error.code).toBe(DISH_CATALOG_ERROR_CODES.duplicateSku);

    const conflict = parseError({
      enterpriseName: "示例企业",
      rows: [row({ skuId: "SKU-1" }), row({ skuId: "SKU-2" })],
      removeSkuIds: ["SKU-2"]
    });
    expect(conflict.code).toBe(DISH_CATALOG_ERROR_CODES.skuConflict);
    expect(conflict.details).toEqual({ field: "skuId", rowIndexes: [1] });
  });

  it("rejects duplicate remove SKUs", () => {
    const error = parseError({
      enterpriseName: "示例企业",
      rows: [row()],
      removeSkuIds: ["SKU-9", "SKU-9"]
    });

    expect(error.code).toBe(DISH_CATALOG_ERROR_CODES.invalidInput);
    expect(error.details).toEqual({ field: "removeSkuIds", rowIndexes: [0, 1] });
  });

  it("accepts one thousand combined entries and rejects one thousand and one", () => {
    const rows = Array.from({ length: 600 }, (_, index) =>
      row({ skuId: `SKU-${String(index).padStart(4, "0")}` })
    );
    const removeSkuIds = Array.from({ length: 400 }, (_, index) => `OLD-${index}`);
    const parsed = parseDishCatalogBatch({ enterpriseName: "示例企业", rows, removeSkuIds });
    expect(parsed.rows).toHaveLength(600);
    expect(parsed.removeSkuIds).toHaveLength(400);

    const tooLarge = parseError({
      enterpriseName: "示例企业",
      rows: [...rows, row({ skuId: "SKU-EXTRA" })],
      removeSkuIds
    });
    expect(tooLarge.code).toBe(DISH_CATALOG_ERROR_CODES.batchTooLarge);

    const empty = parseError({ enterpriseName: "示例企业" });
    expect(empty.code).toBe(DISH_CATALOG_ERROR_CODES.invalidInput);
    expect(empty.details).toEqual({ field: "rows", rowIndexes: [] });
  });
});
