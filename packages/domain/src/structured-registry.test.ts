import { describe, expect, test } from "vitest";
import {
  STRUCTURED_DATASET_REGISTRIES,
  STRUCTURED_DATASETS,
  buildStructuredHeaderLookup,
  getStructuredRegistry,
  resolveStructuredHeaders,
  validateStructuredHeaders
} from "./structured-registry.js";

describe("structured field registries", () => {
  test("registers delivery-ledger and supplier-catalog dataset contracts", () => {
    expect(STRUCTURED_DATASETS).toEqual([
      "dishes",
      "business",
      "vip",
      "dish_catalog",
      "delivery_ledger",
      "supplier_catalog"
    ]);

    expect(getStructuredRegistry("delivery_ledger")).toMatchObject({
      dataset: "delivery_ledger",
      version: "delivery_ledger.2026-08-29.v1",
      rowTable: "delivery_ledger_rows",
      metadataPolicy: "derived_receipt"
    });
    expect(getStructuredRegistry("supplier_catalog")).toMatchObject({
      dataset: "supplier_catalog",
      version: "supplier_catalog.2026-08-29.v1",
      rowTable: "supplier_catalog_rows",
      metadataPolicy: "none"
    });
  });

  test("publishes the complete delivery-ledger field contract", () => {
    const ledger = getStructuredRegistry("delivery_ledger");

    expect(ledger.fields.map((field) => field.canonicalName)).toEqual([
      "source_document_id",
      "entry_id",
      "purchase_date",
      "store_name",
      "receipt_id",
      "supplier_name",
      "item_name",
      "specification",
      "purchase_quantity",
      "purchase_amount",
      "production_date_or_batch",
      "shelf_life",
      "supplier_contact_phone",
      "supplier_unit_address"
    ]);
    expect(ledger.fields).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          canonicalName: "source_document_id",
          inputSource: "derived",
          defaultReturn: false,
          capabilities: { filter: false, sort: false, group: false, aggregate: false },
          storage: {
            table: "delivery_ledger_rows",
            column: "source_document_id"
          }
        }),
        expect.objectContaining({
          canonicalName: "entry_id",
          inputSource: "derived",
          type: "string"
        }),
        expect.objectContaining({
          canonicalName: "purchase_date",
          sourceColumn: "收货日期",
          inputSource: "derived",
          type: "date"
        }),
        expect.objectContaining({
          canonicalName: "item_name",
          sourceColumn: "物品名称",
          inputSource: "file",
          type: "string"
        }),
        expect.objectContaining({
          canonicalName: "purchase_quantity",
          sourceColumn: "收货数量",
          inputSource: "file",
          type: "decimal"
        }),
        expect.objectContaining({
          canonicalName: "production_date_or_batch",
          inputSource: "derived",
          nullable: true
        }),
        expect.objectContaining({
          canonicalName: "shelf_life",
          inputSource: "derived",
          nullable: true
        })
      ])
    );
  });

  test("preserves every controlled supplier source column with stable lookup fields", () => {
    const supplier = getStructuredRegistry("supplier_catalog");

    expect(
      supplier.fields
        .filter((field) => field.inputSource === "file")
        .map((field) => field.sourceColumn)
    ).toEqual([
      "供应商编码",
      "供应商名称",
      "供应商简称",
      "供应商助记码",
      "供应商类别",
      "结算方式",
      "税率",
      "订单汇总规则",
      "范围控制",
      "供货关系",
      "适用机构",
      "采购收货依赖供应商发货",
      "配送依赖供应商发货",
      "发货时录入批次",
      "同步收货数据",
      "批次允许编辑",
      "供应商管理库存",
      "允许委外",
      "控制下单时间",
      "可下单时间",
      "供应商对账模式",
      "允许关闭订单",
      "启用状态",
      "联系人",
      "联系人电话",
      "邮箱地址",
      "联系地址",
      "备注",
      "单位名称",
      "纳税人识别号",
      "电话",
      "单位地址",
      "操作时间"
    ]);
    expect(supplier.fields).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ canonicalName: "supplier_code", sourceColumn: "供应商编码" }),
        expect.objectContaining({ canonicalName: "supplier_name", sourceColumn: "供应商名称" }),
        expect.objectContaining({ canonicalName: "contact_phone", sourceColumn: "联系人电话" }),
        expect.objectContaining({ canonicalName: "unit_address", sourceColumn: "单位地址" })
      ])
    );
  });

  test("limits dynamic delivery supplier fields to result enrichment", () => {
    const ledger = getStructuredRegistry("delivery_ledger");

    for (const canonicalName of ["supplier_contact_phone", "supplier_unit_address"]) {
      expect(ledger.fields.find((field) => field.canonicalName === canonicalName)).toMatchObject({
        inputSource: "dynamic_lookup",
        capabilities: { filter: false, sort: false, group: false, aggregate: false }
      });
    }
  });

  test("publishes source document ID as a detail-only system field for every dataset", () => {
    for (const dataset of STRUCTURED_DATASETS) {
      expect(getStructuredRegistry(dataset).fields[0]).toMatchObject({
        canonicalName: "source_document_id",
        sourceColumn: "source_document_id",
        inputSource: "derived",
        defaultReturn: false,
        capabilities: { filter: false, sort: false, group: false, aggregate: false },
        storage: {
          table: getStructuredRegistry(dataset).rowTable,
          column: "source_document_id"
        }
      });
    }
  });

  test("cover every reviewed dishes and business export column", () => {
    expect(getStructuredRegistry("dishes").fields).toHaveLength(52);
    expect(getStructuredRegistry("business").fields).toHaveLength(153);
    expect(getStructuredRegistry("vip").fields).toHaveLength(67);
  });

  test("registers the catalog snapshot schema and its metadata policy", () => {
    const catalog = getStructuredRegistry("dish_catalog");

    expect(catalog).toMatchObject({
      dataset: "dish_catalog",
      version: "dish_catalog.2026-08-22.v1",
      rowTable: "dish_catalog_rows",
      sheetPolicy: "import_matching_visible",
      metadataPolicy: "snapshot"
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
    expect(catalog.fields).toHaveLength(12);
    expect(
      catalog.fields
        .filter((field) => field.canonicalName !== "source_document_id")
        .map(({ canonicalName, sourceColumn, type, nullable, inputSource }) => ({
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
    const validFields = STRUCTURED_DATASET_REGISTRIES.dishes.fields.filter(
      (field) => field.inputSource === "file"
    );
    const validHeaders = validFields.map((field) => field.sourceColumn);

    expect(validateStructuredHeaders("dishes", validHeaders)).toEqual({
      ok: true,
      fields: validFields.map((field) => field.canonicalName)
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
    const headers = STRUCTURED_DATASET_REGISTRIES.dishes.fields
      .filter((field) => field.inputSource === "file")
      .map((field) => field.sourceColumn);
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

  test("requires the catalog header to be the exact nonblank controlled set in any order", () => {
    const headers = getStructuredRegistry("dish_catalog")
      .fields.filter((field) => field.inputSource === "file")
      .map((field) => field.sourceColumn);
    const reordered = [...headers].reverse();

    expect(validateStructuredHeaders("dish_catalog", reordered)).toMatchObject({ ok: true });
    expect(
      validateStructuredHeaders("dish_catalog", [...headers.slice(0, 4), "", ...headers.slice(4)])
    ).toMatchObject({ ok: false });
    expect(
      validateStructuredHeaders("dish_catalog", ["未知列", ...headers.slice(1)])
    ).toMatchObject({ ok: false });
    expect(
      validateStructuredHeaders("dish_catalog", [headers[1]!, ...headers.slice(1)])
    ).toMatchObject({ ok: false });
    expect(validateStructuredHeaders("dish_catalog", headers.slice(1))).toMatchObject({
      ok: false
    });
  });

  test("accepts the reviewed vip member export header and rejects missing columns", () => {
    const validFields = STRUCTURED_DATASET_REGISTRIES.vip.fields.filter(
      (field) => field.inputSource === "file"
    );
    const validHeaders = validFields.map((field) => field.sourceColumn);

    expect(validateStructuredHeaders("vip", validHeaders)).toEqual({
      ok: true,
      fields: validFields.map((field) => field.canonicalName)
    });

    expect(validateStructuredHeaders("vip", validHeaders.slice(1))).toMatchObject({
      ok: false,
      errors: [expect.objectContaining({ code: "MISSING_REQUIRED_COLUMN", column: "日期" })]
    });
  });
});
