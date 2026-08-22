import { describe, expect, test } from "vitest";
import {
  STRUCTURED_DATASET_REGISTRIES,
  buildStructuredHeaderLookup,
  getStructuredRegistry,
  resolveStructuredHeaders,
  validateStructuredHeaders
} from "./structured-registry.js";

describe("structured field registries", () => {
  test("cover every reviewed dishes and business export column", () => {
    expect(getStructuredRegistry("dishes").fields).toHaveLength(51);
    expect(getStructuredRegistry("business").fields).toHaveLength(152);
    expect(getStructuredRegistry("vip").fields).toHaveLength(66);
  });

  test("registers the catalog snapshot schema and its metadata date policy", () => {
    const catalog = getStructuredRegistry("dish_catalog");

    expect(catalog).toMatchObject({
      dataset: "dish_catalog",
      version: "dish_catalog.2026-08-22.v1",
      rowTable: "dish_catalog_rows",
      sheetPolicy: "import_matching_visible",
      datePolicy: "snapshot_metadata"
    });
    expect(catalog.fields).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          canonicalName: "snapshot_date",
          sourceColumn: "snapshot_date",
          type: "date",
          nullable: false,
          inputSource: "upload_metadata",
          defaultReturn: true
        }),
        expect.objectContaining({
          canonicalName: "sku_id",
          sourceColumn: "菜品编码（SKUID）",
          type: "string",
          nullable: false
        }),
        expect.objectContaining({
          canonicalName: "sale_price",
          sourceColumn: "售卖价",
          type: "decimal",
          nullable: false,
          capabilities: expect.objectContaining({ aggregate: true, filter: true, sort: true })
        })
      ])
    );
    expect(catalog.fields).toHaveLength(11);
    expect(
      catalog.fields.map(({ canonicalName, sourceColumn, type, nullable, inputSource }) => ({
        canonicalName,
        sourceColumn,
        type,
        nullable,
        inputSource
      }))
    ).toEqual([
      {
        canonicalName: "snapshot_date",
        sourceColumn: "snapshot_date",
        type: "date",
        nullable: false,
        inputSource: "upload_metadata"
      },
      {
        canonicalName: "spu_id",
        sourceColumn: "菜品编码（SPUID）",
        type: "string",
        nullable: false,
        inputSource: "file"
      },
      {
        canonicalName: "sku_id",
        sourceColumn: "菜品编码（SKUID）",
        type: "string",
        nullable: false,
        inputSource: "file"
      },
      {
        canonicalName: "dish_name",
        sourceColumn: "菜品名称",
        type: "string",
        nullable: false,
        inputSource: "file"
      },
      {
        canonicalName: "brand_name",
        sourceColumn: "品牌",
        type: "string",
        nullable: false,
        inputSource: "file"
      },
      {
        canonicalName: "base_category_name",
        sourceColumn: "基础分类",
        type: "string",
        nullable: false,
        inputSource: "file"
      },
      {
        canonicalName: "level_1_category_code",
        sourceColumn: "一级分类编码",
        type: "string",
        nullable: false,
        inputSource: "file"
      },
      {
        canonicalName: "level_2_category_code",
        sourceColumn: "二级分类编码",
        type: "string",
        nullable: true,
        inputSource: "file"
      },
      {
        canonicalName: "specification_name",
        sourceColumn: "规格名称",
        type: "string",
        nullable: true,
        inputSource: "file"
      },
      {
        canonicalName: "sale_price",
        sourceColumn: "售卖价",
        type: "decimal",
        nullable: false,
        inputSource: "file"
      },
      {
        canonicalName: "dish_alias",
        sourceColumn: "菜品别名",
        type: "string",
        nullable: true,
        inputSource: "file"
      }
    ]);
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

    const vip = getStructuredRegistry("vip");
    expect(vip.fields.find((field) => field.canonicalName === "business_date")).toMatchObject({
      sourceColumn: "日期",
      type: "date",
      aliases: ["日期", "营业日期", "营业日"],
      storage: {
        table: "vip_rows",
        column: "payload",
        jsonPath: "$.business_date"
      }
    });
    expect(vip.fields.find((field) => field.canonicalName === "member_card_no")).toMatchObject({
      sourceColumn: "会员卡号",
      type: "string",
      capabilities: expect.objectContaining({ filter: true, group: true, aggregate: false })
    });
    expect(vip.fields.find((field) => field.canonicalName === "topup_count")).toMatchObject({
      sourceColumn: "充值笔数",
      type: "decimal"
    });
    expect(
      vip.fields.find((field) => field.canonicalName === "opening_points_balance")
    ).toMatchObject({
      sourceColumn: "期初余额_积分",
      type: "decimal"
    });
    expect(
      vip.fields.find((field) => field.canonicalName === "closing_recharge_balance_total")
    ).toMatchObject({
      sourceColumn: "期末储值余额_合计",
      type: "decimal"
    });
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

  test("resolves reordered headers to their actual source indices", () => {
    const headers = STRUCTURED_DATASET_REGISTRIES.dishes.fields.map((field) => field.sourceColumn);
    const quantityIndex = headers.indexOf("菜品销售数量");
    const productIndex = headers.indexOf("关联菜品名称");
    [headers[quantityIndex], headers[productIndex]] = [
      headers[productIndex]!,
      headers[quantityIndex]!
    ];

    expect(resolveStructuredHeaders("dishes", headers)).toEqual({
      ok: true,
      fields: expect.arrayContaining([
        { canonicalName: "dish_sales_quantity", sourceColumnIndex: productIndex },
        { canonicalName: "matched_product_name", sourceColumnIndex: quantityIndex }
      ])
    });
  });

  test("accepts the reviewed vip member export header and rejects missing columns", () => {
    const validHeaders = STRUCTURED_DATASET_REGISTRIES.vip.fields.map(
      (field) => field.sourceColumn
    );

    expect(validateStructuredHeaders("vip", validHeaders)).toEqual({
      ok: true,
      fields: STRUCTURED_DATASET_REGISTRIES.vip.fields.map((field) => field.canonicalName)
    });

    expect(validateStructuredHeaders("vip", validHeaders.slice(1))).toMatchObject({
      ok: false,
      errors: [expect.objectContaining({ code: "MISSING_REQUIRED_COLUMN", column: "日期" })]
    });
  });
});
