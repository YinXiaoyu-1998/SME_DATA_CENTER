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
  test("routes only business and dishes through partition extracts", () => {
    expect(getStructuredRegistry("business").accessMode).toBe("partition_extract");
    expect(getStructuredRegistry("dishes").accessMode).toBe("partition_extract");

    for (const dataset of ["vip", "dish_catalog", "delivery_ledger", "supplier_catalog"] as const) {
      expect(getStructuredRegistry(dataset).accessMode).toBe("row_query");
    }
  });

  test("registers delivery-ledger and supplier-catalog dataset contracts", () => {
    expect(STRUCTURED_DATASETS).toEqual([
      "dishes",
      "business",
      "vip",
      "dish_catalog",
      "delivery_ledger",
      "supplier_catalog",
      "cost_cards"
    ]);

    expect(getStructuredRegistry("delivery_ledger")).toMatchObject({
      dataset: "delivery_ledger",
      rowTable: "delivery_ledger_rows",
      metadataPolicy: "derived_receipt"
    });
    expect(getStructuredRegistry("supplier_catalog")).toMatchObject({
      dataset: "supplier_catalog",
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

  test("publishes paper-ledger Chinese aliases for delivery-ledger fields", () => {
    const ledger = getStructuredRegistry("delivery_ledger");
    const aliasesByField = Object.fromEntries(
      ledger.fields.map((field) => [field.canonicalName, field.aliases])
    );

    expect(aliasesByField).toMatchObject({
      entry_id: expect.arrayContaining(["entry_id", "序号"]),
      item_name: expect.arrayContaining(["物品名称", "食品名称"]),
      specification: expect.arrayContaining(["规格型号", "规格"]),
      purchase_quantity: expect.arrayContaining(["收货数量", "进货数量"]),
      purchase_amount: expect.arrayContaining(["收货金额", "进货金额"]),
      production_date_or_batch: expect.arrayContaining([
        "production_date_or_batch",
        "生产日期或生产批号"
      ]),
      shelf_life: expect.arrayContaining(["shelf_life", "保质期"]),
      supplier_name: expect.arrayContaining(["送货机构", "供货单位名称"]),
      supplier_unit_address: expect.arrayContaining(["supplier_unit_address", "供货单位地址"]),
      supplier_contact_phone: expect.arrayContaining([
        "supplier_contact_phone",
        "供货单位联系方式"
      ]),
      purchase_date: expect.arrayContaining(["收货日期", "进货日期"])
    });
  });

  test("publishes the exact food-purchase ledger v2 presentation profile", () => {
    const ledger = getStructuredRegistry("delivery_ledger");

    expect(ledger.presentation).toEqual({
      id: "food-purchase-ledger-cn-v2",
      title: "食品经营单位进货台帐",
      columns: [
        { canonicalName: "receipt_id", displayName: "收货单号" },
        { canonicalName: "item_name", displayName: "食品名称" },
        { canonicalName: "specification", displayName: "规格" },
        { canonicalName: "purchase_quantity", displayName: "进货数量" },
        { canonicalName: "purchase_amount", displayName: "进货金额" },
        { canonicalName: "production_date_or_batch", displayName: "生产日期或生产批号" },
        { canonicalName: "shelf_life", displayName: "保质期" },
        { canonicalName: "supplier_name", displayName: "供货单位名称" },
        { canonicalName: "supplier_unit_address", displayName: "供货单位地址" },
        { canonicalName: "supplier_contact_phone", displayName: "供货单位联系方式" },
        { canonicalName: "purchase_date", displayName: "进货日期" }
      ]
    });
    expect(ledger.presentation?.columns.map((column) => column.canonicalName)).not.toContain(
      "entry_id"
    );
    expect(ledger.presentation?.columns.map((column) => column.displayName)).not.toContain("序号");
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

  test("publishes source document ID only for datasets backed by row storage", () => {
    for (const dataset of ["vip", "dish_catalog", "delivery_ledger", "supplier_catalog"] as const) {
      const registry = getStructuredRegistry(dataset);
      expect(registry.fields[0]).toMatchObject({
        canonicalName: "source_document_id",
        sourceColumn: "source_document_id",
        inputSource: "derived",
        defaultReturn: false,
        capabilities: { filter: false, sort: false, group: false, aggregate: false },
        storage: {
          table: registry.rowTable,
          column: "source_document_id"
        }
      });
    }
    for (const dataset of ["dishes", "business"] as const) {
      const registry = getStructuredRegistry(dataset);
      expect(registry.rowTable).toBeUndefined();
      expect(registry.fields.some((field) => field.canonicalName === "source_document_id")).toBe(
        false
      );
      expect(registry.fields.every((field) => field.storage === undefined)).toBe(true);
    }
  });

  test("cover every reviewed dishes and business export column", () => {
    expect(getStructuredRegistry("dishes").fields).toHaveLength(51);
    expect(getStructuredRegistry("business").fields).toHaveLength(152);
    expect(getStructuredRegistry("vip").fields).toHaveLength(67);
  });

  test("publishes report fields with explicit semantic names and numeric aggregation", () => {
    const expected = [
      ["business", "桌台数量", "table_count", "integer"],
      ["business", "桌台使用次数", "table_use_count", "integer"],
      ["business", "桌台数x营业天数", "table_days", "integer"],
      ["business", "消费桌数", "served_table_count", "integer"],
      ["business", "消费次数", "consumption_count", "integer"],
      ["business", "店内营业收入", "dine_in_revenue", "decimal"],
      ["business", "外卖营业收入", "delivery_revenue", "decimal"],
      ["dishes", "菜品销售额", "dish_sales_amount", "decimal"],
      ["dishes", "菜品收入", "dish_revenue", "decimal"],
      ["dishes", "菜品总销售额", "dish_total_sales_amount", "decimal"],
      ["dishes", "菜品总收入", "dish_total_revenue", "decimal"]
    ] as const;

    for (const [dataset, sourceColumn, canonicalName, type] of expected) {
      expect(getStructuredRegistry(dataset).fields).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            sourceColumn,
            canonicalName,
            type,
            capabilities: expect.objectContaining({ aggregate: true })
          })
        ])
      );
    }
  });

  test("publishes explicit semantic fields for every retained business workflow input", () => {
    const retainedBusinessWorkflowSourceColumns = [
      "营业日期",
      "周",
      "月",
      "门店名称",
      "城市",
      "商户号",
      "一级组织机构名称",
      "二级组织机构名称",
      "三级组织机构名称",
      "四级组织机构名称",
      "订单分类",
      "订单来源",
      "时段",
      "餐段",
      "退单类型名称",
      "是否是会员",
      "就餐方式",
      "营业额(元)",
      "桌台数量",
      "桌台使用次数",
      "开台率",
      "翻台率",
      "有效订单量",
      "订单营业收入",
      "优惠金额",
      "逆向订单量",
      "正向订单量",
      "已结账订单量",
      "桌台数x营业天数",
      "消费桌数",
      "消费次数",
      "会员消费金额",
      "会员订单收入",
      "店内营业额",
      "店内营业收入",
      "店内优惠金额",
      "店内正向单订单量",
      "店内退单量",
      "店内已结账订单量",
      "店内退款金额",
      "外卖营业额",
      "店内订单量",
      "外卖营业收入",
      "外卖折扣金额",
      "外卖订单量",
      "外卖正向单订单量",
      "外卖退单量",
      "外卖退款金额",
      "美团外卖营业额",
      "美团外卖营业收入",
      "美团外卖折扣金额",
      "美团外卖订单量",
      "美团外卖正向单订单量",
      "美团外卖退单量",
      "美团外卖已结账订单量",
      "美团外卖退款金额",
      "京东外卖营业额",
      "京东外卖营业收入",
      "京东外卖折扣金额",
      "京东外卖订单量",
      "京东外卖正向单订单量",
      "京东外卖退单量",
      "京东外卖已结账订单量",
      "京东外卖退款金额",
      "饿了么外卖营业额",
      "饿了么外卖营业收入",
      "饿了么外卖折扣金额",
      "饿了么外卖订单量",
      "饿了么外卖正向单订单量",
      "饿了么外卖退单量",
      "饿了么外卖已结账订单量",
      "饿了么外卖退款金额",
      "自提营业额",
      "自提营业收入",
      "自提折扣金额",
      "自提订单量",
      "自提正向单订单量",
      "自提已结账订单量",
      "自提退单量",
      "自提退款金额",
      "现金营业额",
      "现金营业收入",
      "现金优惠金额",
      "现金支付次数",
      "扫码支付营业收入",
      "扫码支付营业额",
      "扫码支付优惠金额",
      "扫码支付支付次数",
      "扫码支付微信营业额",
      "扫码支付支付宝营业额",
      "扫码支付微信营业收入",
      "扫码支付支付宝营业收入",
      "扫码支付微信优惠金额",
      "扫码支付支付宝优惠金额",
      "扫码支付微信支付次数",
      "扫码支付支付宝支付次数",
      "团购营业额",
      "美团团购营业额",
      "抖音团购营业额",
      "快手团购营业额",
      "团购营业收入",
      "美团团购营业收入",
      "抖音团购营业收入",
      "快手团购营业收入",
      "团购优惠金额",
      "美团团购优惠金额",
      "抖音团购优惠金额",
      "快手团购优惠金额",
      "团购支付次数",
      "美团团购支付次数",
      "抖音团购支付次数",
      "快手团购支付次数",
      "抵用券营业额",
      "抵用券营业收入",
      "抵用券优惠金额",
      "抵用券支付次数",
      "优惠券营业额",
      "优惠券营业收入",
      "优惠券优惠金额",
      "优惠券支付次数",
      "自定义记账营业额",
      "自定义记账营业收入",
      "自定义记账优惠金额",
      "自定义记账支付次数",
      "店内营销会员订单量",
      "店内非会员订单量",
      "外卖营销会员订单量",
      "店内营销会员营业额",
      "店内非会员营业额",
      "店内营销会员营业收入",
      "外卖营销会员营业额",
      "外卖已结账订单量",
      "用餐人数"
    ];
    const numericSourceColumns = new Set(retainedBusinessWorkflowSourceColumns.slice(17));
    const registry = getStructuredRegistry("business");

    for (const sourceColumn of retainedBusinessWorkflowSourceColumns) {
      const field = registry.fields.find((candidate) => candidate.sourceColumn === sourceColumn);
      expect(field, sourceColumn).toBeDefined();
      expect(field?.canonicalName, sourceColumn).not.toMatch(/^business_\d{3}_/);
    }

    for (const sourceColumn of numericSourceColumns) {
      const field = registry.fields.find((candidate) => candidate.sourceColumn === sourceColumn);
      expect(field?.type, sourceColumn).toBeOneOf(["integer", "decimal", "percent"]);
      expect(field?.capabilities.aggregate, sourceColumn).toBe(true);
    }
  });

  test("marks report grouping dimensions as groupable in the v2 business and dishes registries", () => {
    const expected = [
      ["business", "business_date"],
      ["business", "business_week"],
      ["business", "business_month"],
      ["business", "store_name"],
      ["business", "city"],
      ["business", "merchant_id"],
      ["business", "order_category"],
      ["business", "order_source"],
      ["business", "meal_period"],
      ["business", "time_slot"],
      ["business", "is_member"],
      ["business", "dining_method"],
      ["dishes", "business_date"],
      ["dishes", "business_week"],
      ["dishes", "business_month"],
      ["dishes", "store_name"],
      ["dishes", "product_name"],
      ["dishes", "matched_product_name"],
      ["dishes", "order_category"],
      ["dishes", "time_slot"],
      ["dishes", "merchant_id"],
      ["dishes", "organization_code"]
    ] as const;

    for (const [dataset, canonicalName] of expected) {
      expect(getStructuredRegistry(dataset).fields).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            canonicalName,
            capabilities: expect.objectContaining({ group: true })
          })
        ])
      );
    }
  });

  test("registers the catalog snapshot schema and its metadata policy", () => {
    const catalog = getStructuredRegistry("dish_catalog");

    expect(catalog).toMatchObject({
      dataset: "dish_catalog",
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

  test("defines partition field semantics without obsolete MySQL payload mappings", () => {
    const dishes = getStructuredRegistry("dishes");
    const quantity = dishes.fields.find((field) => field.canonicalName === "dish_sales_quantity");
    const product = dishes.fields.find((field) => field.canonicalName === "matched_product_name");

    expect(quantity).toMatchObject({
      sourceColumn: "菜品销售数量",
      type: "decimal",
      nullable: true,
      capabilities: expect.objectContaining({ aggregate: true, sort: true })
    });
    expect(quantity?.storage).toBeUndefined();
    expect(product?.aliases).toContain("关联菜品名称");

    const business = getStructuredRegistry("business");
    expect(business.fields.find((field) => field.canonicalName === "business_date")).toMatchObject({
      sourceColumn: "营业日期",
      type: "date"
    });
    expect(
      business.fields.find((field) => field.canonicalName === "business_date")?.storage
    ).toBeUndefined();
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
