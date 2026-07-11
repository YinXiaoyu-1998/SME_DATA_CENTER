import { describe, expect, test } from "vitest";
import {
  STRUCTURED_DATASET_REGISTRIES,
  buildStructuredHeaderLookup,
  getStructuredRegistry,
  validateStructuredHeaders
} from "./structured-registry.js";

describe("structured field registries", () => {
  test("cover every reviewed dishes and business export column", () => {
    expect(getStructuredRegistry("dishes").fields).toHaveLength(51);
    expect(getStructuredRegistry("business").fields).toHaveLength(152);
  });

  test("define public names, exact aliases, value semantics, and MySQL payload mappings", () => {
    const dishes = getStructuredRegistry("dishes");
    const quantity = dishes.fields.find((field) => field.canonicalName === "dish_sales_quantity");
    const product = dishes.fields.find((field) => field.canonicalName === "matched_product_name");

    expect(quantity).toMatchObject({
      sourceColumn: "菜品销售数量",
      type: "decimal",
      nullable: true,
      capabilities: expect.objectContaining({ aggregate: true, sort: true }),
      storage: {
        table: "dish_rows",
        column: "payload",
        jsonPath: "$.dish_sales_quantity"
      }
    });
    expect(product?.aliases).toContain("关联菜品名称");

    const business = getStructuredRegistry("business");
    expect(business.fields.find((field) => field.canonicalName === "business_date")).toMatchObject({
      sourceColumn: "营业日期",
      type: "date",
      storage: {
        table: "business_rows",
        column: "payload",
        jsonPath: "$.business_date"
      }
    });
    expect(business.fields.some((field) => field.type === "percent")).toBe(true);
  });

  test("reject unknown, missing, ambiguous, and fuzzy-renamed headers", () => {
    const validHeaders = STRUCTURED_DATASET_REGISTRIES.dishes.fields.map(
      (field) => field.sourceColumn
    );

    expect(validateStructuredHeaders("dishes", validHeaders)).toEqual({
      ok: true,
      fields: STRUCTURED_DATASET_REGISTRIES.dishes.fields.map((field) => field.canonicalName)
    });

    expect(validateStructuredHeaders("dishes", [...validHeaders, "不存在的列"])).toMatchObject({
      ok: false,
      errors: [expect.objectContaining({ code: "UNKNOWN_COLUMN", column: "不存在的列" })]
    });

    expect(validateStructuredHeaders("dishes", validHeaders.slice(1))).toMatchObject({
      ok: false,
      errors: [expect.objectContaining({ code: "MISSING_REQUIRED_COLUMN", column: "下单时间" })]
    });

    expect(
      validateStructuredHeaders(
        "dishes",
        validHeaders.map((header) => (header === "菜品销售数量" ? "菜品销售数量（份）" : header))
      )
    ).toMatchObject({
      ok: false,
      errors: expect.arrayContaining([
        expect.objectContaining({ code: "UNKNOWN_COLUMN", column: "菜品销售数量（份）" })
      ])
    });

    const lookup = buildStructuredHeaderLookup([
      { canonicalName: "a", sourceColumn: "列A", aliases: ["重复"] },
      { canonicalName: "b", sourceColumn: "列B", aliases: ["重复"] }
    ]);
    expect(lookup.get("重复")).toEqual({ type: "ambiguous", canonicalNames: ["a", "b"] });
  });
});
