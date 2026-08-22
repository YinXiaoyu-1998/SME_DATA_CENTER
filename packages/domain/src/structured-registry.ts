export const STRUCTURED_DATASETS = ["dishes", "business", "vip", "dish_catalog"] as const;

export type StructuredDatasetName = (typeof STRUCTURED_DATASETS)[number];

export type StructuredFieldType =
  "string" | "date" | "date_time" | "time_range" | "integer" | "decimal" | "percent";

export interface StructuredFieldCapabilities {
  filter: boolean;
  sort: boolean;
  group: boolean;
  aggregate: boolean;
}

export interface StructuredFieldStorageMapping {
  table: "dish_rows" | "business_rows" | "vip_rows" | "dish_catalog_rows";
  column: "payload";
  jsonPath: string;
}

export interface StructuredFieldRegistryEntry {
  canonicalName: string;
  sourceColumn: string;
  aliases: string[];
  type: StructuredFieldType;
  nullable: boolean;
  inputSource: "file" | "upload_metadata";
  sensitivity: "normal" | "business_metric";
  lifecycle: "active";
  volatility: "stable_export" | "review_on_export_change";
  defaultReturn: boolean;
  operators: string[];
  capabilities: StructuredFieldCapabilities;
  indexStatus: "not_indexed" | "planned";
  valueLimits?: {
    maxLength?: number;
    decimalScale?: number;
  };
  storage: StructuredFieldStorageMapping;
}

export interface StructuredDatasetRegistry {
  dataset: StructuredDatasetName;
  version: string;
  rowTable: "dish_rows" | "business_rows" | "vip_rows" | "dish_catalog_rows";
  sheetPolicy: "strict_all_nonempty" | "import_matching_visible";
  datePolicy: "row_business_date" | "snapshot_metadata";
  fields: StructuredFieldRegistryEntry[];
}

export interface HeaderValidationError {
  code: "UNKNOWN_COLUMN" | "MISSING_REQUIRED_COLUMN" | "AMBIGUOUS_COLUMN" | "DUPLICATE_COLUMN";
  column: string;
  canonicalNames?: string[];
}

export type HeaderLookupValue =
  | {
      type: "field";
      field: Pick<StructuredFieldRegistryEntry, "canonicalName" | "sourceColumn" | "aliases">;
    }
  | {
      type: "ambiguous";
      canonicalNames: string[];
    };

const DISH_SOURCE_COLUMNS = [
  "下单时间",
  "门店",
  "省份",
  "城市",
  "区域",
  "一级组织机构",
  "二级组织机构",
  "三级组织机构",
  "四级组织机构",
  "是否是会员",
  "菜品名称",
  "时段",
  "关联菜品名称",
  "订单分类",
  "营业日",
  "营业周",
  "营业月",
  "菜品销售方式名称",
  "加料名称",
  "做法名称",
  "商户号",
  "组织机构编码",
  "菜品销售数量",
  "菜品销售额",
  "菜品优惠",
  "菜品收入",
  "菜品关联加料销售额",
  "菜品关联加料收入",
  "菜品关联做法销售额",
  "菜品关联做法收入",
  "菜品关联餐盒销售额",
  "菜品关联做法优惠",
  "菜品关联餐盒优惠",
  "菜品关联正向订单量",
  "菜品关联逆向订单量",
  "菜品总销售额",
  "菜品总收入",
  "菜品总优惠",
  "菜品平均售价_菜品本身",
  "菜品平均售价_菜品及关联加料做法餐盒",
  "菜品平均收入_菜品本身",
  "菜品平均收入_菜品及关联加料做法餐盒",
  "销量占比",
  "菜品营业额占比",
  "退菜数量",
  "退菜金额",
  "菜品总毛利额（折前）",
  "菜品总毛利额（折后）",
  "出餐订单数",
  "菜品总毛利率（折前）",
  "菜品总毛利率（折后）"
] as const;

const BUSINESS_SOURCE_COLUMNS = [
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
  "折扣率",
  "折前单均",
  "折后单均",
  "桌台数x营业天数",
  "消费桌数",
  "消费次数",
  "会员消费金额",
  "会员订单收入",
  "店内营业额",
  "店内营业收入",
  "店内优惠金额",
  "店内折前单均",
  "店内正向单订单量",
  "店内退单量",
  "店内已结账订单量",
  "店内退款金额",
  "外卖营业额",
  "店内订单量",
  "外卖营业收入",
  "外卖折扣金额",
  "外卖折前单均",
  "外卖折后单均",
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
  "美团外卖折前单均",
  "美团外卖折后单均",
  "美团外卖退款金额",
  "京东外卖营业额",
  "京东外卖营业收入",
  "京东外卖折扣金额",
  "京东外卖折前单均",
  "京东外卖折后单均",
  "京东外卖订单量",
  "京东外卖正向单订单量",
  "京东外卖退单量",
  "京东外卖已结账订单量",
  "京东外卖退款金额",
  "饿了么外卖营业额",
  "饿了么外卖营业收入",
  "饿了么外卖折扣金额",
  "饿了么外卖折前单均",
  "饿了么外卖折后单均",
  "饿了么外卖订单量",
  "饿了么外卖正向单订单量",
  "饿了么外卖退单量",
  "饿了么外卖已结账订单量",
  "饿了么外卖退款金额",
  "自提营业额",
  "自提营业收入",
  "自提折扣金额",
  "自提折前单均",
  "自提折后单均",
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
  "外卖营销会员单均营业额",
  "店内营销会员营业额",
  "店内非会员营业额",
  "店内营销会员营业收入",
  "店内营销会员单均营业额",
  "外卖营销会员营业额",
  "外卖已结账订单量",
  "店内折后单均",
  "店内非会员单均营业收入",
  "用餐人数",
  "营业天数"
] as const;

const DISH_CATALOG_SOURCE_COLUMNS = [
  "菜品编码（SPUID）",
  "菜品编码（SKUID）",
  "菜品名称",
  "品牌",
  "基础分类",
  "一级分类编码",
  "二级分类编码",
  "规格名称",
  "售卖价",
  "菜品别名"
] as const;

const DISH_CATALOG_CANONICAL_OVERRIDES: Record<string, string> = {
  "菜品编码（SPUID）": "spu_id",
  "菜品编码（SKUID）": "sku_id",
  菜品名称: "dish_name",
  品牌: "brand_name",
  基础分类: "base_category_name",
  一级分类编码: "level_1_category_code",
  二级分类编码: "level_2_category_code",
  规格名称: "specification_name",
  售卖价: "sale_price",
  菜品别名: "dish_alias"
};

const VIP_SOURCE_COLUMNS = [
  "日期",
  "周",
  "储值门店名称",
  "省份",
  "城市",
  "会员卡号",
  "会员卡类型名称",
  "会员卡等级名称",
  "会员卡种类名称",
  "会员ID",
  "会员手机号",
  "月份",
  "开卡门店名称",
  "商户号",
  "收款方式",
  "储值消费金额_本金(元)",
  "储值消费金额_赠金(元)",
  "储值消费金额_合计(元)",
  "净储值消费金额_本金(元)",
  "净储值消费金额_赠金(元)",
  "净储值消费金额_合计(元)",
  "储值金额_储值消费_本金(元)",
  "储值金额_储值消费_赠金(元)",
  "储值金额_储值消费_合计(元)",
  "储值金额_本金_消费退款(元)",
  "储值金额_赠金_消费退款(元)",
  "储值金额_合计_消费退款(元)",
  "储值金额_本金_充值(元)",
  "储值金额_赠金_充值(元)",
  "储值金额_合计_充值(元)",
  "储值金额_本金_充值退款(元)",
  "储值金额_赠金_充值退款(元)",
  "储值金额_合计_充值退款(元)",
  "净储值金额_本金_充值(元)",
  "净储值金额_赠金_充值(元)",
  "净储值金额_合计_充值(元)",
  "充值笔数",
  "充值退款笔数",
  "净储值金额_充值笔数",
  "期初余额_积分",
  "期初导入_积分",
  "储值积分_充值退款",
  "储值积分_减少场景（剔除消费）",
  "储值积分_消费",
  "储值积分_消费退款",
  "净储值积分_充值",
  "储值积分_储值",
  "净储值消费积分_合计",
  "期末余额_积分",
  "付费券包售卖会员数",
  "付费券包售卖流水数",
  "付费券包售卖数量",
  "付费券包售卖金额",
  "付费券包退货数量",
  "付费券包退货金额",
  "付费权益卡售卖会员数",
  "付费权益卡售卖流水数",
  "付费权益卡售卖数量",
  "付费权益卡售卖金额",
  "付费权益卡退货数量",
  "储值消费流水数",
  "储值消费流水数_退款",
  "付费权益卡退货金额",
  "期末储值余额_本金",
  "期末储值余额_赠金",
  "期末储值余额_合计"
] as const;

const DISH_CANONICAL_OVERRIDES: Record<string, string> = {
  下单时间: "order_time",
  门店: "store_name",
  省份: "province",
  城市: "city",
  区域: "district",
  是否是会员: "is_member",
  菜品名称: "product_name",
  时段: "time_slot",
  关联菜品名称: "matched_product_name",
  订单分类: "order_category",
  营业日: "business_date",
  营业周: "business_week",
  营业月: "business_month",
  菜品销售数量: "dish_sales_quantity",
  商户号: "merchant_id",
  组织机构编码: "organization_code"
};

const BUSINESS_CANONICAL_OVERRIDES: Record<string, string> = {
  营业日期: "business_date",
  周: "business_week",
  月: "business_month",
  门店名称: "store_name",
  城市: "city",
  商户号: "merchant_id",
  订单分类: "order_category",
  订单来源: "order_source",
  时段: "time_slot",
  餐段: "meal_period",
  是否是会员: "is_member",
  就餐方式: "dining_method",
  "营业额(元)": "gross_sales_amount",
  订单营业收入: "order_revenue",
  优惠金额: "discount_amount",
  有效订单量: "valid_order_count",
  正向订单量: "positive_order_count",
  逆向订单量: "reverse_order_count",
  折扣率: "discount_rate",
  用餐人数: "diner_count",
  营业天数: "business_day_count"
};

const VIP_CANONICAL_OVERRIDES: Record<string, string> = {
  日期: "business_date",
  周: "business_week",
  储值门店名称: "store_name",
  省份: "province",
  城市: "city",
  会员卡号: "member_card_no",
  会员卡类型名称: "member_card_type_name",
  会员卡等级名称: "member_card_level_name",
  会员卡种类名称: "member_card_kind_name",
  会员ID: "member_id",
  会员手机号: "member_phone",
  月份: "business_month",
  开卡门店名称: "opening_store_name",
  商户号: "merchant_id",
  收款方式: "payment_method",
  "储值消费金额_本金(元)": "recharge_consumption_amount_principal",
  "储值消费金额_赠金(元)": "recharge_consumption_amount_bonus",
  "储值消费金额_合计(元)": "recharge_consumption_amount_total",
  "净储值消费金额_本金(元)": "net_recharge_consumption_amount_principal",
  "净储值消费金额_赠金(元)": "net_recharge_consumption_amount_bonus",
  "净储值消费金额_合计(元)": "net_recharge_consumption_amount_total",
  "储值金额_储值消费_本金(元)": "recharge_amount_consumption_principal",
  "储值金额_储值消费_赠金(元)": "recharge_amount_consumption_bonus",
  "储值金额_储值消费_合计(元)": "recharge_amount_consumption_total",
  "储值金额_本金_消费退款(元)": "recharge_amount_principal_consumption_refund",
  "储值金额_赠金_消费退款(元)": "recharge_amount_bonus_consumption_refund",
  "储值金额_合计_消费退款(元)": "recharge_amount_total_consumption_refund",
  "储值金额_本金_充值(元)": "recharge_amount_principal_topup",
  "储值金额_赠金_充值(元)": "recharge_amount_bonus_topup",
  "储值金额_合计_充值(元)": "recharge_amount_total_topup",
  "储值金额_本金_充值退款(元)": "recharge_amount_principal_topup_refund",
  "储值金额_赠金_充值退款(元)": "recharge_amount_bonus_topup_refund",
  "储值金额_合计_充值退款(元)": "recharge_amount_total_topup_refund",
  "净储值金额_本金_充值(元)": "net_recharge_amount_principal_topup",
  "净储值金额_赠金_充值(元)": "net_recharge_amount_bonus_topup",
  "净储值金额_合计_充值(元)": "net_recharge_amount_total_topup",
  充值笔数: "topup_count",
  充值退款笔数: "topup_refund_count",
  净储值金额_充值笔数: "net_recharge_amount_topup_count",
  期初余额_积分: "opening_points_balance",
  期初导入_积分: "opening_imported_points",
  储值积分_充值退款: "recharge_points_topup_refund",
  "储值积分_减少场景（剔除消费）": "recharge_points_reduction_excluding_consumption",
  储值积分_消费: "recharge_points_consumption",
  储值积分_消费退款: "recharge_points_consumption_refund",
  净储值积分_充值: "net_recharge_points_topup",
  储值积分_储值: "recharge_points_recharge",
  净储值消费积分_合计: "net_recharge_consumption_points_total",
  期末余额_积分: "closing_points_balance",
  付费券包售卖会员数: "paid_coupon_pack_sold_member_count",
  付费券包售卖流水数: "paid_coupon_pack_sold_flow_count",
  付费券包售卖数量: "paid_coupon_pack_sold_quantity",
  付费券包售卖金额: "paid_coupon_pack_sold_amount",
  付费券包退货数量: "paid_coupon_pack_return_quantity",
  付费券包退货金额: "paid_coupon_pack_return_amount",
  付费权益卡售卖会员数: "paid_benefit_card_sold_member_count",
  付费权益卡售卖流水数: "paid_benefit_card_sold_flow_count",
  付费权益卡售卖数量: "paid_benefit_card_sold_quantity",
  付费权益卡售卖金额: "paid_benefit_card_sold_amount",
  付费权益卡退货数量: "paid_benefit_card_return_quantity",
  储值消费流水数: "recharge_consumption_flow_count",
  储值消费流水数_退款: "recharge_consumption_flow_refund_count",
  付费权益卡退货金额: "paid_benefit_card_return_amount",
  期末储值余额_本金: "closing_recharge_balance_principal",
  期末储值余额_赠金: "closing_recharge_balance_bonus",
  期末储值余额_合计: "closing_recharge_balance_total"
};

export const STRUCTURED_DATASET_REGISTRIES = {
  dishes: createRegistry({
    dataset: "dishes",
    version: "dishes.2026-07-11.v1",
    rowTable: "dish_rows",
    sheetPolicy: "strict_all_nonempty",
    datePolicy: "row_business_date",
    sourceColumns: DISH_SOURCE_COLUMNS,
    canonicalOverrides: DISH_CANONICAL_OVERRIDES
  }),
  business: createRegistry({
    dataset: "business",
    version: "business.2026-07-11.v1",
    rowTable: "business_rows",
    sheetPolicy: "strict_all_nonempty",
    datePolicy: "row_business_date",
    sourceColumns: BUSINESS_SOURCE_COLUMNS,
    canonicalOverrides: BUSINESS_CANONICAL_OVERRIDES
  }),
  vip: createRegistry({
    dataset: "vip",
    version: "vip.2026-08-12.v1",
    rowTable: "vip_rows",
    sheetPolicy: "strict_all_nonempty",
    datePolicy: "row_business_date",
    sourceColumns: VIP_SOURCE_COLUMNS,
    canonicalOverrides: VIP_CANONICAL_OVERRIDES
  }),
  dish_catalog: createRegistry({
    dataset: "dish_catalog",
    version: "dish_catalog.2026-08-22.v1",
    rowTable: "dish_catalog_rows",
    sheetPolicy: "import_matching_visible",
    datePolicy: "snapshot_metadata",
    sourceColumns: DISH_CATALOG_SOURCE_COLUMNS,
    canonicalOverrides: DISH_CATALOG_CANONICAL_OVERRIDES,
    nullableCanonicalNames: new Set(["level_2_category_code", "specification_name", "dish_alias"]),
    metadataFields: [
      {
        canonicalName: "snapshot_date",
        sourceColumn: "snapshot_date",
        type: "date",
        nullable: false
      }
    ]
  })
} as const satisfies Record<StructuredDatasetName, StructuredDatasetRegistry>;

export function getStructuredRegistry(dataset: StructuredDatasetName): StructuredDatasetRegistry {
  return STRUCTURED_DATASET_REGISTRIES[dataset];
}

export function buildStructuredHeaderLookup(
  fields: Array<Pick<StructuredFieldRegistryEntry, "canonicalName" | "sourceColumn" | "aliases">>
): Map<string, HeaderLookupValue> {
  const lookup = new Map<string, HeaderLookupValue>();

  for (const field of fields) {
    for (const rawAlias of [...new Set([field.sourceColumn, ...field.aliases])]) {
      const alias = normalizeHeader(rawAlias);
      const existing = lookup.get(alias);

      if (!existing) {
        lookup.set(alias, { type: "field", field });
        continue;
      }

      const canonicalNames =
        existing.type === "ambiguous"
          ? existing.canonicalNames
          : [existing.field.canonicalName, field.canonicalName];

      lookup.set(alias, {
        type: "ambiguous",
        canonicalNames: [...new Set(canonicalNames)].sort()
      });
    }
  }

  return lookup;
}

export function validateStructuredHeaders(
  dataset: StructuredDatasetName,
  headers: string[]
):
  | {
      ok: true;
      fields: string[];
    }
  | {
      ok: false;
      errors: HeaderValidationError[];
    } {
  const resolution = resolveStructuredHeaders(dataset, headers);

  if (!resolution.ok) {
    return resolution;
  }

  return {
    ok: true,
    fields: resolution.fields.map((field) => field.canonicalName)
  };
}

export function resolveStructuredHeaders(
  dataset: StructuredDatasetName,
  headers: string[]
):
  | { ok: true; fields: Array<{ canonicalName: string; sourceColumnIndex: number }> }
  | { ok: false; errors: HeaderValidationError[] } {
  const registry = getStructuredRegistry(dataset);
  const fileFields = registry.fields.filter((field) => field.inputSource === "file");
  const lookup = buildStructuredHeaderLookup(fileFields);
  const errors: HeaderValidationError[] = [];
  const seenCanonicalNames = new Set<string>();
  const seenHeaders = new Set<string>();

  const fields: Array<{ canonicalName: string; sourceColumnIndex: number }> = [];

  if (
    dataset === "dish_catalog" &&
    (headers.length !== fileFields.length || headers.some((header) => !normalizeHeader(header)))
  ) {
    errors.push({ code: "UNKNOWN_COLUMN", column: "" });
  }

  for (const [sourceColumnIndex, rawHeader] of headers.entries()) {
    const header = normalizeHeader(rawHeader);
    if (!header) continue;
    if (seenHeaders.has(header)) {
      errors.push({ code: "DUPLICATE_COLUMN", column: header });
      continue;
    }

    seenHeaders.add(header);
    const match = lookup.get(header);

    if (!match) {
      errors.push({ code: "UNKNOWN_COLUMN", column: header });
      continue;
    }

    if (match.type === "ambiguous") {
      errors.push({
        code: "AMBIGUOUS_COLUMN",
        column: header,
        canonicalNames: match.canonicalNames
      });
      continue;
    }

    if (seenCanonicalNames.has(match.field.canonicalName)) {
      errors.push({ code: "DUPLICATE_COLUMN", column: header });
      continue;
    }

    seenCanonicalNames.add(match.field.canonicalName);
    fields.push({ canonicalName: match.field.canonicalName, sourceColumnIndex });
  }

  for (const field of fileFields) {
    if (!seenCanonicalNames.has(field.canonicalName)) {
      errors.push({ code: "MISSING_REQUIRED_COLUMN", column: field.sourceColumn });
    }
  }

  if (errors.length > 0) {
    return { ok: false, errors };
  }

  return { ok: true, fields };
}

function createRegistry(input: {
  dataset: StructuredDatasetName;
  version: string;
  rowTable: "dish_rows" | "business_rows" | "vip_rows" | "dish_catalog_rows";
  sheetPolicy: StructuredDatasetRegistry["sheetPolicy"];
  datePolicy: StructuredDatasetRegistry["datePolicy"];
  sourceColumns: readonly string[];
  canonicalOverrides: Record<string, string>;
  nullableCanonicalNames?: ReadonlySet<string>;
  metadataFields?: Array<
    Pick<StructuredFieldRegistryEntry, "canonicalName" | "sourceColumn" | "type" | "nullable">
  >;
}): StructuredDatasetRegistry {
  return {
    dataset: input.dataset,
    version: input.version,
    rowTable: input.rowTable,
    sheetPolicy: input.sheetPolicy,
    datePolicy: input.datePolicy,
    fields: [
      ...(input.metadataFields ?? []).map((field) => ({
        ...field,
        aliases: [field.sourceColumn],
        inputSource: "upload_metadata" as const,
        sensitivity: "normal" as const,
        lifecycle: "active" as const,
        volatility: "stable_export" as const,
        defaultReturn: true,
        operators: operatorsForType(field.type),
        capabilities: {
          filter: true,
          sort: true,
          group: true,
          aggregate: false
        },
        indexStatus: "planned" as const,
        valueLimits: valueLimitsForType(field.type),
        storage: {
          table: input.rowTable,
          column: "payload" as const,
          jsonPath: `$.${field.canonicalName}`
        }
      })),
      ...input.sourceColumns.map((sourceColumn, index) => {
        const canonicalName =
          input.canonicalOverrides[sourceColumn] ??
          `${input.dataset}_${String(index + 1).padStart(3, "0")}_${fallbackAsciiName(sourceColumn)}`;
        const type = inferFieldType(input.dataset, sourceColumn);
        const isMeasure = isMeasureColumn(sourceColumn, type);

        return {
          canonicalName,
          sourceColumn,
          aliases: aliasesFor(input.dataset, sourceColumn),
          type,
          nullable:
            input.nullableCanonicalNames?.has(canonicalName) ?? canonicalName !== "business_date",
          inputSource: "file" as const,
          sensitivity: isMeasure ? ("business_metric" as const) : ("normal" as const),
          lifecycle: "active" as const,
          volatility: "review_on_export_change" as const,
          defaultReturn:
            input.dataset === "dish_catalog" ||
            index < 20 ||
            ["business_date", "matched_product_name"].includes(canonicalName),
          operators: operatorsForType(type),
          capabilities: {
            filter: true,
            sort: type !== "string" || index < 25,
            group: !isMeasure,
            aggregate: isMeasure
          },
          indexStatus: "planned" as const,
          valueLimits: valueLimitsForType(type),
          storage: {
            table: input.rowTable,
            column: "payload" as const,
            jsonPath: `$.${canonicalName}`
          }
        };
      })
    ]
  };
}

function aliasesFor(dataset: StructuredDatasetName, sourceColumn: string): string[] {
  const aliasesByDataset: Record<StructuredDatasetName, Record<string, string[]>> = {
    dishes: {
      下单时间: ["订单时间"],
      门店: ["门店名称"],
      营业日: ["营业日期"]
    },
    business: {
      营业日期: ["营业日"],
      门店名称: ["门店"]
    },
    vip: {
      日期: ["营业日期", "营业日"],
      周: ["营业周"],
      月份: ["月"],
      储值门店名称: ["门店名称"]
    },
    dish_catalog: {}
  };
  return [sourceColumn, ...(aliasesByDataset[dataset][sourceColumn] ?? [])];
}

function inferFieldType(dataset: StructuredDatasetName, sourceColumn: string): StructuredFieldType {
  if (dataset === "vip") {
    if (sourceColumn === "日期") {
      return "date";
    }
    if (
      /积分|笔数|流水数|会员数|数量|次数|金额|余额|收入|优惠|折扣|营业额|售价/.test(sourceColumn)
    ) {
      return "decimal";
    }
    return "string";
  }

  if (dataset === "dish_catalog") {
    return sourceColumn === "售卖价" ? "decimal" : "string";
  }

  if (["营业日", "营业日期"].includes(sourceColumn)) {
    return "date";
  }

  if (sourceColumn === "下单时间") {
    return "date_time";
  }

  if (sourceColumn === "时段") {
    return "time_range";
  }

  if (sourceColumn.includes("率") || sourceColumn.includes("占比")) {
    return "percent";
  }

  if (sourceColumn.includes("销售数量")) {
    return "decimal";
  }

  if (
    dataset === "dishes" &&
    (sourceColumn.includes("数量") ||
      sourceColumn.includes("次数") ||
      sourceColumn.includes("订单数") ||
      sourceColumn.includes("桌数") ||
      sourceColumn.includes("人数") ||
      sourceColumn.includes("营业天数") ||
      sourceColumn.includes("桌台数量") ||
      sourceColumn.includes("支付次数"))
  ) {
    return "integer";
  }

  if (
    sourceColumn.includes("额") ||
    sourceColumn.includes("收入") ||
    sourceColumn.includes("优惠") ||
    sourceColumn.includes("单均") ||
    sourceColumn.includes("金额") ||
    sourceColumn.includes("售价") ||
    sourceColumn.includes("折扣")
  ) {
    return "decimal";
  }

  return "string";
}

function isMeasureColumn(sourceColumn: string, type: StructuredFieldType): boolean {
  if (["integer", "decimal", "percent"].includes(type)) {
    return true;
  }

  return /金额|营业额|收入|优惠|订单量|数量|次数|毛利|单均/.test(sourceColumn);
}

function operatorsForType(type: StructuredFieldType): string[] {
  if (["date", "date_time"].includes(type)) {
    return ["eq", "between", "gte", "lte", "in"];
  }

  if (["integer", "decimal", "percent"].includes(type)) {
    return ["eq", "between", "gt", "gte", "lt", "lte", "in"];
  }

  return ["eq", "contains", "starts_with", "in"];
}

function valueLimitsForType(
  type: StructuredFieldType
): StructuredFieldRegistryEntry["valueLimits"] {
  if (type === "decimal" || type === "percent") {
    return { decimalScale: 4 };
  }

  if (type === "string") {
    return { maxLength: 512 };
  }

  return undefined;
}

function normalizeHeader(header: string): string {
  return header.trim().replace(/\s+/g, " ");
}

function fallbackAsciiName(sourceColumn: string): string {
  const knownTokens: Array<[string, string]> = [
    ["一级组织机构", "org_level_1"],
    ["二级组织机构", "org_level_2"],
    ["三级组织机构", "org_level_3"],
    ["四级组织机构", "org_level_4"],
    ["菜品", "dish"],
    ["美团", "meituan"],
    ["饿了么", "eleme"],
    ["京东", "jd"],
    ["外卖", "takeout"],
    ["店内", "dine_in"],
    ["自提", "pickup"],
    ["扫码支付", "qr_pay"],
    ["微信", "wechat"],
    ["支付宝", "alipay"],
    ["团购", "group_buy"],
    ["抖音", "douyin"],
    ["快手", "kuaishou"],
    ["抵用券", "voucher"],
    ["优惠券", "coupon"],
    ["自定义记账", "custom_accounting"],
    ["营业额", "gross_sales"],
    ["营业收入", "revenue"],
    ["优惠金额", "discount_amount"],
    ["折扣金额", "discount_amount"],
    ["支付次数", "payment_count"],
    ["订单量", "order_count"],
    ["退款金额", "refund_amount"],
    ["退单量", "refund_order_count"],
    ["折前单均", "avg_before_discount"],
    ["折后单均", "avg_after_discount"],
    ["毛利率", "gross_margin_rate"],
    ["毛利额", "gross_margin_amount"],
    ["销售数量", "sales_quantity"],
    ["销售额", "sales_amount"],
    ["收入", "revenue"],
    ["优惠", "discount"],
    ["正向", "positive"],
    ["逆向", "reverse"],
    ["会员", "member"],
    ["非会员", "non_member"],
    ["营销", "marketing"],
    ["餐盒", "meal_box"],
    ["加料", "add_on"],
    ["做法", "preparation"],
    ["退菜", "returned_dish"],
    ["出餐", "served"],
    ["桌台", "table"],
    ["开台率", "table_open_rate"],
    ["翻台率", "table_turnover_rate"],
    ["消费", "consumption"],
    ["分类", "category"],
    ["来源", "source"],
    ["名称", "name"],
    ["编码", "code"]
  ];

  const parts = knownTokens
    .filter(([token]) => sourceColumn.includes(token))
    .map(([, replacement]) => replacement);

  return parts.length > 0 ? [...new Set(parts)].join("_") : "field";
}
