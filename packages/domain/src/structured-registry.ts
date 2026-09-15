export const STRUCTURED_DATASETS = [
  "dishes",
  "business",
  "vip",
  "dish_catalog",
  "delivery_ledger",
  "supplier_catalog"
] as const;

export type StructuredDatasetName = (typeof STRUCTURED_DATASETS)[number];

export type StructuredFieldType =
  "string" | "date" | "date_time" | "time_range" | "integer" | "decimal" | "percent";

export interface StructuredFieldCapabilities {
  filter: boolean;
  sort: boolean;
  group: boolean;
  aggregate: boolean;
}

type StructuredRowTableName =
  "vip_rows" | "dish_catalog_rows" | "delivery_ledger_rows" | "supplier_catalog_rows";

export interface StructuredFieldStorageMapping {
  table: StructuredRowTableName;
  column: "payload" | "source_document_id";
  jsonPath?: string;
}

export interface StructuredFieldRegistryEntry {
  canonicalName: string;
  sourceColumn: string;
  aliases: string[];
  type: StructuredFieldType;
  nullable: boolean;
  inputSource: "file" | "upload_metadata" | "derived" | "dynamic_lookup";
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
  storage?: StructuredFieldStorageMapping;
}

export interface StructuredDatasetRegistry {
  dataset: StructuredDatasetName;
  accessMode: "partition_extract" | "row_query";
  rowTable?: StructuredRowTableName;
  sheetPolicy: "strict_all_nonempty" | "import_matching_visible";
  metadataPolicy: "window" | "snapshot" | "derived_receipt" | "none";
  datePolicy?: "row_business_date" | "snapshot_metadata";
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

const SUPPLIER_CATALOG_COLUMNS = [
  ["供应商编码", "supplier_code"],
  ["供应商名称", "supplier_name"],
  ["供应商简称", "supplier_short_name"],
  ["供应商助记码", "supplier_mnemonic"],
  ["供应商类别", "supplier_category"],
  ["结算方式", "settlement_method"],
  ["税率", "tax_rate"],
  ["订单汇总规则", "order_summary_rule"],
  ["范围控制", "scope_control"],
  ["供货关系", "supply_relationship"],
  ["适用机构", "applicable_organization"],
  ["采购收货依赖供应商发货", "procurement_receipt_depends_on_supplier_delivery"],
  ["配送依赖供应商发货", "delivery_depends_on_supplier_delivery"],
  ["发货时录入批次", "record_batch_on_delivery"],
  ["同步收货数据", "synchronize_receipt_data"],
  ["批次允许编辑", "batch_editable"],
  ["供应商管理库存", "supplier_managed_inventory"],
  ["允许委外", "outsourcing_allowed"],
  ["控制下单时间", "order_time_control"],
  ["可下单时间", "orderable_time"],
  ["供应商对账模式", "supplier_reconciliation_mode"],
  ["允许关闭订单", "close_order_allowed"],
  ["启用状态", "enabled_status"],
  ["联系人", "contact_name"],
  ["联系人电话", "contact_phone"],
  ["邮箱地址", "email_address"],
  ["联系地址", "contact_address"],
  ["备注", "remarks"],
  ["单位名称", "unit_name"],
  ["纳税人识别号", "taxpayer_identification_number"],
  ["电话", "phone"],
  ["单位地址", "unit_address"],
  ["操作时间", "operated_at"]
] as const;
const SUPPLIER_CATALOG_SOURCE_COLUMNS = SUPPLIER_CATALOG_COLUMNS.map(([source]) => source);
const SUPPLIER_CATALOG_CANONICAL_OVERRIDES = Object.fromEntries(SUPPLIER_CATALOG_COLUMNS);

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
  一级组织机构: "organization_level_1",
  二级组织机构: "organization_level_2",
  三级组织机构: "organization_level_3",
  四级组织机构: "organization_level_4",
  是否是会员: "is_member",
  菜品名称: "product_name",
  时段: "time_slot",
  关联菜品名称: "matched_product_name",
  订单分类: "order_category",
  营业日: "business_date",
  营业周: "business_week",
  营业月: "business_month",
  菜品销售方式名称: "dish_sales_method_name",
  加料名称: "modifier_name",
  做法名称: "preparation_name",
  商户号: "merchant_id",
  组织机构编码: "organization_code",
  菜品销售数量: "dish_sales_quantity",
  菜品销售额: "dish_sales_amount",
  菜品优惠: "dish_discount_amount",
  菜品收入: "dish_revenue",
  菜品关联加料销售额: "dish_modifier_sales_amount",
  菜品关联加料收入: "dish_modifier_revenue",
  菜品关联做法销售额: "dish_preparation_sales_amount",
  菜品关联做法收入: "dish_preparation_revenue",
  菜品关联餐盒销售额: "dish_packaging_sales_amount",
  菜品关联做法优惠: "dish_preparation_discount_amount",
  菜品关联餐盒优惠: "dish_packaging_discount_amount",
  菜品关联正向订单量: "dish_positive_order_count",
  菜品关联逆向订单量: "dish_reverse_order_count",
  菜品总销售额: "dish_total_sales_amount",
  菜品总收入: "dish_total_revenue",
  菜品总优惠: "dish_total_discount_amount",
  菜品平均售价_菜品本身: "dish_average_unit_price",
  菜品平均售价_菜品及关联加料做法餐盒: "dish_total_average_unit_price",
  菜品平均收入_菜品本身: "dish_average_revenue",
  菜品平均收入_菜品及关联加料做法餐盒: "dish_total_average_revenue",
  销量占比: "dish_sales_quantity_share",
  菜品营业额占比: "dish_sales_amount_share",
  退菜数量: "returned_dish_quantity",
  退菜金额: "returned_dish_amount",
  "菜品总毛利额（折前）": "dish_total_gross_margin_before_discount",
  "菜品总毛利额（折后）": "dish_total_gross_margin_after_discount",
  出餐订单数: "serving_order_count",
  "菜品总毛利率（折前）": "dish_total_gross_margin_rate_before_discount",
  "菜品总毛利率（折后）": "dish_total_gross_margin_rate_after_discount"
};

const BUSINESS_CANONICAL_OVERRIDES: Record<string, string> = {
  营业日期: "business_date",
  周: "business_week",
  月: "business_month",
  门店名称: "store_name",
  城市: "city",
  商户号: "merchant_id",
  一级组织机构名称: "organization_level_1_name",
  二级组织机构名称: "organization_level_2_name",
  三级组织机构名称: "organization_level_3_name",
  四级组织机构名称: "organization_level_4_name",
  订单分类: "order_category",
  订单来源: "order_source",
  时段: "time_slot",
  餐段: "meal_period",
  退单类型名称: "refund_type_name",
  是否是会员: "is_member",
  就餐方式: "dining_method",
  "营业额(元)": "gross_sales_amount",
  桌台数量: "table_count",
  桌台使用次数: "table_use_count",
  开台率: "open_rate",
  翻台率: "table_turnover_rate",
  有效订单量: "valid_order_count",
  订单营业收入: "order_revenue",
  优惠金额: "discount_amount",
  逆向订单量: "reverse_order_count",
  正向订单量: "positive_order_count",
  已结账订单量: "settled_order_count",
  折扣率: "discount_rate",
  折前单均: "average_order_value_before_discount",
  折后单均: "average_order_value_after_discount",
  桌台数x营业天数: "table_days",
  消费桌数: "served_table_count",
  消费次数: "consumption_count",
  会员消费金额: "member_consumption_amount",
  会员订单收入: "member_order_revenue",
  店内营业额: "dine_in_sales_amount",
  店内营业收入: "dine_in_revenue",
  店内优惠金额: "dine_in_discount_amount",
  店内折前单均: "dine_in_average_order_value_before_discount",
  店内正向单订单量: "dine_in_positive_order_count",
  店内退单量: "dine_in_refund_order_count",
  店内已结账订单量: "dine_in_settled_order_count",
  店内退款金额: "dine_in_refund_amount",
  外卖营业额: "delivery_sales_amount",
  店内订单量: "dine_in_order_count",
  外卖营业收入: "delivery_revenue",
  外卖折扣金额: "delivery_discount_amount",
  外卖折前单均: "delivery_average_order_value_before_discount",
  外卖折后单均: "delivery_average_order_value_after_discount",
  外卖订单量: "delivery_order_count",
  外卖正向单订单量: "delivery_positive_order_count",
  外卖退单量: "delivery_refund_order_count",
  外卖退款金额: "delivery_refund_amount",
  美团外卖营业额: "meituan_delivery_sales_amount",
  美团外卖营业收入: "meituan_delivery_revenue",
  美团外卖折扣金额: "meituan_delivery_discount_amount",
  美团外卖订单量: "meituan_delivery_order_count",
  美团外卖正向单订单量: "meituan_delivery_positive_order_count",
  美团外卖退单量: "meituan_delivery_refund_order_count",
  美团外卖已结账订单量: "meituan_delivery_settled_order_count",
  美团外卖折前单均: "meituan_delivery_average_order_value_before_discount",
  美团外卖折后单均: "meituan_delivery_average_order_value_after_discount",
  美团外卖退款金额: "meituan_delivery_refund_amount",
  京东外卖营业额: "jd_delivery_sales_amount",
  京东外卖营业收入: "jd_delivery_revenue",
  京东外卖折扣金额: "jd_delivery_discount_amount",
  京东外卖折前单均: "jd_delivery_average_order_value_before_discount",
  京东外卖折后单均: "jd_delivery_average_order_value_after_discount",
  京东外卖订单量: "jd_delivery_order_count",
  京东外卖正向单订单量: "jd_delivery_positive_order_count",
  京东外卖退单量: "jd_delivery_refund_order_count",
  京东外卖已结账订单量: "jd_delivery_settled_order_count",
  京东外卖退款金额: "jd_delivery_refund_amount",
  饿了么外卖营业额: "eleme_delivery_sales_amount",
  饿了么外卖营业收入: "eleme_delivery_revenue",
  饿了么外卖折扣金额: "eleme_delivery_discount_amount",
  饿了么外卖折前单均: "eleme_delivery_average_order_value_before_discount",
  饿了么外卖折后单均: "eleme_delivery_average_order_value_after_discount",
  饿了么外卖订单量: "eleme_delivery_order_count",
  饿了么外卖正向单订单量: "eleme_delivery_positive_order_count",
  饿了么外卖退单量: "eleme_delivery_refund_order_count",
  饿了么外卖已结账订单量: "eleme_delivery_settled_order_count",
  饿了么外卖退款金额: "eleme_delivery_refund_amount",
  自提营业额: "pickup_sales_amount",
  自提营业收入: "pickup_revenue",
  自提折扣金额: "pickup_discount_amount",
  自提订单量: "pickup_order_count",
  自提正向单订单量: "pickup_positive_order_count",
  自提已结账订单量: "pickup_settled_order_count",
  自提退单量: "pickup_refund_order_count",
  自提退款金额: "pickup_refund_amount",
  现金营业额: "cash_sales_amount",
  现金营业收入: "cash_revenue",
  现金优惠金额: "cash_discount_amount",
  现金支付次数: "cash_payment_count",
  扫码支付营业收入: "qr_payment_revenue",
  扫码支付营业额: "qr_payment_sales_amount",
  扫码支付优惠金额: "qr_payment_discount_amount",
  扫码支付支付次数: "qr_payment_count",
  扫码支付微信营业额: "qr_payment_wechat_sales_amount",
  扫码支付支付宝营业额: "qr_payment_alipay_sales_amount",
  扫码支付微信营业收入: "qr_payment_wechat_revenue",
  扫码支付支付宝营业收入: "qr_payment_alipay_revenue",
  扫码支付微信优惠金额: "qr_payment_wechat_discount_amount",
  扫码支付支付宝优惠金额: "qr_payment_alipay_discount_amount",
  扫码支付微信支付次数: "qr_payment_wechat_count",
  扫码支付支付宝支付次数: "qr_payment_alipay_count",
  团购营业额: "group_buy_sales_amount",
  美团团购营业额: "meituan_group_buy_sales_amount",
  抖音团购营业额: "douyin_group_buy_sales_amount",
  快手团购营业额: "kuaishou_group_buy_sales_amount",
  团购营业收入: "group_buy_revenue",
  美团团购营业收入: "meituan_group_buy_revenue",
  抖音团购营业收入: "douyin_group_buy_revenue",
  快手团购营业收入: "kuaishou_group_buy_revenue",
  团购优惠金额: "group_buy_discount_amount",
  美团团购优惠金额: "meituan_group_buy_discount_amount",
  抖音团购优惠金额: "douyin_group_buy_discount_amount",
  快手团购优惠金额: "kuaishou_group_buy_discount_amount",
  团购支付次数: "group_buy_payment_count",
  美团团购支付次数: "meituan_group_buy_payment_count",
  抖音团购支付次数: "douyin_group_buy_payment_count",
  快手团购支付次数: "kuaishou_group_buy_payment_count",
  抵用券营业额: "voucher_sales_amount",
  抵用券营业收入: "voucher_revenue",
  抵用券优惠金额: "voucher_discount_amount",
  抵用券支付次数: "voucher_payment_count",
  优惠券营业额: "coupon_sales_amount",
  优惠券营业收入: "coupon_revenue",
  优惠券优惠金额: "coupon_discount_amount",
  优惠券支付次数: "coupon_payment_count",
  自定义记账营业额: "custom_accounting_sales_amount",
  自定义记账营业收入: "custom_accounting_revenue",
  自定义记账优惠金额: "custom_accounting_discount_amount",
  自定义记账支付次数: "custom_accounting_payment_count",
  店内营销会员订单量: "dine_in_marketing_member_order_count",
  店内非会员订单量: "dine_in_non_member_order_count",
  外卖营销会员订单量: "delivery_marketing_member_order_count",
  店内营销会员营业额: "dine_in_marketing_member_sales_amount",
  店内非会员营业额: "dine_in_non_member_sales_amount",
  店内营销会员营业收入: "dine_in_marketing_member_revenue",
  外卖营销会员营业额: "delivery_marketing_member_sales_amount",
  外卖已结账订单量: "delivery_settled_order_count",
  用餐人数: "diner_count",
  营业天数: "business_day_count"
};

const DISH_EXPLICIT_TYPES: Record<string, StructuredFieldType> = {
  菜品销售数量: "decimal",
  菜品关联正向订单量: "integer",
  菜品关联逆向订单量: "integer",
  退菜数量: "decimal",
  出餐订单数: "integer"
};

const BUSINESS_EXPLICIT_TYPES: Record<string, StructuredFieldType> = {
  桌台数量: "integer",
  桌台使用次数: "integer",
  有效订单量: "decimal",
  逆向订单量: "decimal",
  正向订单量: "decimal",
  已结账订单量: "decimal",
  桌台数x营业天数: "integer",
  消费桌数: "integer",
  消费次数: "integer",
  店内正向单订单量: "decimal",
  店内退单量: "decimal",
  店内已结账订单量: "decimal",
  店内订单量: "decimal",
  外卖订单量: "decimal",
  外卖正向单订单量: "decimal",
  外卖退单量: "decimal",
  美团外卖订单量: "decimal",
  美团外卖正向单订单量: "decimal",
  美团外卖退单量: "decimal",
  美团外卖已结账订单量: "decimal",
  京东外卖订单量: "decimal",
  京东外卖正向单订单量: "decimal",
  京东外卖退单量: "decimal",
  京东外卖已结账订单量: "decimal",
  饿了么外卖订单量: "decimal",
  饿了么外卖正向单订单量: "decimal",
  饿了么外卖退单量: "decimal",
  饿了么外卖已结账订单量: "decimal",
  自提订单量: "decimal",
  自提正向单订单量: "decimal",
  自提已结账订单量: "decimal",
  自提退单量: "decimal",
  现金支付次数: "decimal",
  扫码支付支付次数: "decimal",
  扫码支付微信支付次数: "decimal",
  扫码支付支付宝支付次数: "decimal",
  团购支付次数: "decimal",
  美团团购支付次数: "decimal",
  抖音团购支付次数: "decimal",
  快手团购支付次数: "decimal",
  抵用券支付次数: "decimal",
  优惠券支付次数: "decimal",
  自定义记账支付次数: "decimal",
  店内营销会员订单量: "decimal",
  店内非会员订单量: "decimal",
  外卖营销会员订单量: "decimal",
  外卖已结账订单量: "decimal",
  用餐人数: "integer",
  营业天数: "integer"
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

const DELIVERY_LEDGER_FIELD_DEFINITIONS = [
  ["source_document_id", "source_document_id", "string", false, "derived", []],
  ["entry_id", "entry_id", "string", false, "derived", ["序号"]],
  ["purchase_date", "收货日期", "date", false, "derived", ["进货日期"]],
  ["store_name", "订货机构", "string", false, "derived", []],
  ["receipt_id", "单据号", "string", false, "derived", []],
  ["supplier_name", "送货机构", "string", false, "derived", ["供货单位名称"]],
  ["item_name", "物品名称", "string", false, "file", ["食品名称"]],
  ["specification", "规格型号", "string", false, "file", ["规格"]],
  ["purchase_quantity", "收货数量", "decimal", false, "file", ["进货数量"]],
  ["purchase_amount", "收货金额", "decimal", false, "file", ["进货金额"]],
  [
    "production_date_or_batch",
    "production_date_or_batch",
    "string",
    true,
    "derived",
    ["生产日期或生产批号"]
  ],
  ["shelf_life", "shelf_life", "string", true, "derived", ["保质期"]],
  [
    "supplier_contact_phone",
    "supplier_contact_phone",
    "string",
    true,
    "dynamic_lookup",
    ["供货单位联系方式"]
  ],
  [
    "supplier_unit_address",
    "supplier_unit_address",
    "string",
    true,
    "dynamic_lookup",
    ["供货单位地址"]
  ]
] satisfies Array<
  [string, string, StructuredFieldType, boolean, "file" | "derived" | "dynamic_lookup", string[]]
>;
const DELIVERY_LEDGER_FIELDS: StructuredFieldRegistryEntry[] =
  DELIVERY_LEDGER_FIELD_DEFINITIONS.map(
    ([canonicalName, sourceColumn, type, nullable, inputSource, aliases]) =>
      createDeliveryLedgerField({
        canonicalName,
        sourceColumn,
        type,
        nullable,
        inputSource,
        aliases
      })
  );

export const STRUCTURED_DATASET_REGISTRIES = {
  dishes: createRegistry({
    dataset: "dishes",
    accessMode: "partition_extract",
    sheetPolicy: "strict_all_nonempty",
    metadataPolicy: "window",
    datePolicy: "row_business_date",
    sourceColumns: DISH_SOURCE_COLUMNS,
    canonicalOverrides: DISH_CANONICAL_OVERRIDES,
    explicitTypes: DISH_EXPLICIT_TYPES
  }),
  business: createRegistry({
    dataset: "business",
    accessMode: "partition_extract",
    sheetPolicy: "strict_all_nonempty",
    metadataPolicy: "window",
    datePolicy: "row_business_date",
    sourceColumns: BUSINESS_SOURCE_COLUMNS,
    canonicalOverrides: BUSINESS_CANONICAL_OVERRIDES,
    explicitTypes: BUSINESS_EXPLICIT_TYPES
  }),
  vip: createRegistry({
    dataset: "vip",
    accessMode: "row_query",
    rowTable: "vip_rows",
    sheetPolicy: "strict_all_nonempty",
    metadataPolicy: "window",
    datePolicy: "row_business_date",
    sourceColumns: VIP_SOURCE_COLUMNS,
    canonicalOverrides: VIP_CANONICAL_OVERRIDES
  }),
  dish_catalog: createRegistry({
    dataset: "dish_catalog",
    accessMode: "row_query",
    rowTable: "dish_catalog_rows",
    sheetPolicy: "import_matching_visible",
    metadataPolicy: "snapshot",
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
  }),
  delivery_ledger: {
    dataset: "delivery_ledger",
    accessMode: "row_query",
    rowTable: "delivery_ledger_rows",
    sheetPolicy: "strict_all_nonempty",
    metadataPolicy: "derived_receipt",
    fields: DELIVERY_LEDGER_FIELDS
  },
  supplier_catalog: createRegistry({
    dataset: "supplier_catalog",
    accessMode: "row_query",
    rowTable: "supplier_catalog_rows",
    sheetPolicy: "import_matching_visible",
    metadataPolicy: "none",
    sourceColumns: SUPPLIER_CATALOG_SOURCE_COLUMNS,
    canonicalOverrides: SUPPLIER_CATALOG_CANONICAL_OVERRIDES,
    nullableCanonicalNames: new Set(
      Object.values(SUPPLIER_CATALOG_CANONICAL_OVERRIDES).filter(
        (canonicalName) => canonicalName !== "supplier_name"
      )
    )
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
  if (dataset === "supplier_catalog" && headers.some((header) => !normalizeHeader(header))) {
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
    if (dataset === "supplier_catalog" && field.nullable) continue;
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
  accessMode: StructuredDatasetRegistry["accessMode"];
  rowTable?: StructuredRowTableName;
  sheetPolicy: StructuredDatasetRegistry["sheetPolicy"];
  metadataPolicy: StructuredDatasetRegistry["metadataPolicy"];
  datePolicy?: StructuredDatasetRegistry["datePolicy"];
  sourceColumns: readonly string[];
  canonicalOverrides: Record<string, string>;
  explicitTypes?: Record<string, StructuredFieldType>;
  nullableCanonicalNames?: ReadonlySet<string>;
  metadataFields?: Array<
    Pick<StructuredFieldRegistryEntry, "canonicalName" | "sourceColumn" | "type" | "nullable">
  >;
}): StructuredDatasetRegistry {
  return {
    dataset: input.dataset,
    accessMode: input.accessMode,
    ...(input.rowTable ? { rowTable: input.rowTable } : {}),
    sheetPolicy: input.sheetPolicy,
    metadataPolicy: input.metadataPolicy,
    datePolicy: input.datePolicy,
    fields: [
      ...(input.rowTable ? [createSourceDocumentIdField(input.rowTable)] : []),
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
        ...(input.rowTable
          ? {
              storage: {
                table: input.rowTable,
                column: "payload" as const,
                jsonPath: `$.${field.canonicalName}`
              }
            }
          : {})
      })),
      ...input.sourceColumns.map((sourceColumn, index) => {
        const canonicalName =
          input.canonicalOverrides[sourceColumn] ??
          `${input.dataset}_${String(index + 1).padStart(3, "0")}_${fallbackAsciiName(sourceColumn)}`;
        const type =
          input.explicitTypes?.[sourceColumn] ?? inferFieldType(input.dataset, sourceColumn);
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
          ...(input.rowTable
            ? {
                storage: {
                  table: input.rowTable,
                  column: "payload" as const,
                  jsonPath: `$.${canonicalName}`
                }
              }
            : {})
        };
      })
    ]
  };
}

function createDeliveryLedgerField(input: {
  canonicalName: string;
  sourceColumn: string;
  type: StructuredFieldType;
  nullable: boolean;
  inputSource: "file" | "derived" | "dynamic_lookup";
  aliases: string[];
}): StructuredFieldRegistryEntry {
  const isDynamic = input.inputSource === "dynamic_lookup";
  const isSourceDocumentId = input.canonicalName === "source_document_id";

  return {
    ...input,
    aliases: [...new Set([input.sourceColumn, ...input.aliases])],
    sensitivity: input.type === "decimal" ? ("business_metric" as const) : ("normal" as const),
    lifecycle: "active",
    volatility: "stable_export",
    defaultReturn: !isSourceDocumentId,
    operators: isDynamic ? [] : operatorsForType(input.type),
    capabilities:
      isDynamic || isSourceDocumentId
        ? { filter: false, sort: false, group: false, aggregate: false }
        : {
            filter: true,
            sort: true,
            group: input.type === "string" || input.type === "date",
            aggregate: input.type === "decimal"
          },
    indexStatus: "planned",
    valueLimits: valueLimitsForType(input.type),
    storage: isSourceDocumentId
      ? {
          table: "delivery_ledger_rows",
          column: "source_document_id"
        }
      : {
          table: "delivery_ledger_rows",
          column: "payload",
          jsonPath: `$.${input.canonicalName}`
        }
  };
}

function createSourceDocumentIdField(
  rowTable: StructuredRowTableName
): StructuredFieldRegistryEntry {
  return {
    canonicalName: "source_document_id",
    sourceColumn: "source_document_id",
    aliases: ["source_document_id"],
    type: "string",
    nullable: false,
    inputSource: "derived",
    sensitivity: "normal",
    lifecycle: "active",
    volatility: "stable_export",
    defaultReturn: false,
    operators: operatorsForType("string"),
    capabilities: { filter: false, sort: false, group: false, aggregate: false },
    indexStatus: "not_indexed",
    valueLimits: valueLimitsForType("string"),
    storage: {
      table: rowTable,
      column: "source_document_id"
    }
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
    dish_catalog: {},
    delivery_ledger: {},
    supplier_catalog: {}
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

  if (dataset === "supplier_catalog") {
    if (sourceColumn === "税率") {
      return "decimal";
    }
    if (sourceColumn === "操作时间") {
      return "date_time";
    }
    return "string";
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
