import { createHash } from "node:crypto";
import type { StructuredFieldRegistryEntry } from "./structured-registry.js";

export const COST_CARD_CSV_SCHEMA_VERSION = 1;
export const COST_CARD_CANONICALIZATION_VERSION = 1;
export const COST_CARD_MANIFEST_MAX_TTL_SECONDS = 900;
export const COST_CARD_REPLACED_OBJECT_GRACE_SECONDS = 24 * 60 * 60;
export const COST_CARD_PUBLICATION_MAX_CHANGES = 100;
export const COST_CARD_PUBLICATION_MAX_SUMMARY_BYTES = 32 * 1024;
export const COST_CARD_CATALOG_BATCH_SIZE = 500;
export const COST_CARD_PUBLICATION_TRANSACTION_TIMEOUT_MS = 120_000;

type Value = string | boolean | null;
export interface CostCardSourceLocation {
  sourceSheetIndex: number;
  sourceSheetName: string;
  sourceRowNumber: number;
}
export interface CostCardIdentity {
  enterpriseKey: string;
  sourceNamespace: "meituan";
  spuId: string;
  skuId: string;
}
export interface CostCardFields {
  spu_id: string;
  sku_id: string;
  dish_name: string;
  base_category_name: string | null;
  sale_price: string | null;
  specification_name: string | null;
  has_cost_card: boolean;
  source_dish_deleted: boolean;
}
export interface CostCardItem {
  item_code: string;
  item_name: string;
  item_spec: string | null;
  cost_unit: string;
  net_quantity: string | null;
  yield_rate: string | null;
  gross_quantity: string | null;
  consumption_unit_price_tax_included: string | null;
  consumption_amount_tax_included: string | null;
  is_main_material: boolean | null;
  is_semi_finished: boolean | null;
  is_prepared: boolean | null;
  uses_auxiliary_unit_deduction: boolean | null;
  base_unit: string | null;
  base_gross_quantity: string | null;
  substitute_material_text: string | null;
  source?: CostCardSourceLocation;
  /** Each row retains its own source rendering when equivalent store sets differ. */
  sourceStoresText?: string | null;
}
export interface CostCardRecipe {
  production_quantity: string | null;
  material_cost_tax_included: string | null;
  other_cost: string | null;
  target_gross_margin_rate: string | null;
  recipe_type: string;
  recipe_name: string;
  total_cost_tax_included: string | null;
  gross_margin_rate_tax_included: string | null;
  store_can_modify: boolean | null;
  remark: string | null;
  source_stores_text: string | null;
  stores: string[];
  items: CostCardItem[];
}
export interface CanonicalCostCard {
  identity: CostCardIdentity;
  card: CostCardFields;
  recipes: CostCardRecipe[];
}

const COLUMNS = [
  ["菜品SPU编码", "spu_id", "card", "string", false, 64],
  ["菜品SKU编码", "sku_id", "card", "string", false, 64],
  ["菜品名称", "dish_name", "card", "string", false, 512],
  ["菜品分类", "base_category_name", "card", "string", true, 255],
  ["加工份数", "production_quantity", "recipe", "decimal", true],
  ["售卖价", "sale_price", "card", "decimal", true],
  ["菜品规格", "specification_name", "card", "string", true, 255],
  ["是否配置成本卡", "has_cost_card", "card", "boolean", false],
  ["物品成本(含税)", "material_cost_tax_included", "recipe", "decimal", true],
  ["其他成本", "other_cost", "recipe", "decimal", true],
  ["目标毛利率", "target_gross_margin_rate", "recipe", "percent", true],
  ["配方类型", "recipe_type", "recipe", "string", false, 32767],
  ["配方名称", "recipe_name", "recipe", "string", false, 32767],
  ["合计成本(含税)", "total_cost_tax_included", "recipe", "decimal", true],
  ["成本卡毛利率(含税)", "gross_margin_rate_tax_included", "recipe", "percent", true],
  ["物品编码", "item_code", "item", "string", false, 32767],
  ["物品名称", "item_name", "item", "string", false, 32767],
  ["规格型号", "item_spec", "item", "string", true, 32767],
  ["成本单位", "cost_unit", "item", "string", false, 32767],
  ["净料量", "net_quantity", "item", "decimal", true],
  ["净料率", "yield_rate", "item", "percent", true],
  ["毛料量", "gross_quantity", "item", "decimal", true],
  ["消耗单价(含税)", "consumption_unit_price_tax_included", "item", "decimal", true],
  ["消耗金额(含税)", "consumption_amount_tax_included", "item", "decimal", true],
  ["是否主料", "is_main_material", "item", "boolean", true],
  ["是否半成品", "is_semi_finished", "item", "boolean", true],
  ["是否制备", "is_prepared", "item", "boolean", true],
  ["是否辅助单位扣减料", "uses_auxiliary_unit_deduction", "item", "boolean", true],
  ["基准单位", "base_unit", "item", "string", true, 32767],
  ["基准单位毛料量", "base_gross_quantity", "item", "decimal", true],
  ["替代料", "substitute_material_text", "item", "string", true, 32767],
  ["门店是否可修改", "store_can_modify", "recipe", "boolean", true],
  ["菜品是否删除", "source_dish_deleted", "card", "boolean", false],
  ["备注", "remark", "recipe", "string", true, 32767],
  ["适用门店", "source_stores_text", "recipe", "string", true, 32767]
] as const;

export interface CostCardUploadField {
  sourceColumn: string;
  canonicalName: string;
  scope: "card" | "recipe" | "item";
  type: "string" | "decimal" | "percent" | "boolean";
  nullable: boolean;
  maxLength?: number;
  aliases: string[];
}
export const COST_CARD_UPLOAD_SCHEMA: readonly CostCardUploadField[] = COLUMNS.map(
  ([sourceColumn, canonicalName, scope, type, nullable, maxLength]) => ({
    sourceColumn,
    canonicalName,
    scope,
    type,
    nullable,
    ...(maxLength === undefined ? {} : { maxLength }),
    aliases: []
  })
);

/** Separate from the upload schema: directory queries expose only scalar card fields. */
export interface CostCardDirectoryField extends Omit<StructuredFieldRegistryEntry, "type"> {
  type: "string" | "decimal" | "integer" | "boolean";
}
const DIRECTORY_METADATA = [
  ["cost_card_id", "string"],
  ["enterprise_name", "string"],
  ["source_namespace", "string"],
  ["revision", "string"],
  ["source_document_id", "string"],
  ["import_batch_id", "string"],
  ["item_row_count", "integer"],
  ["recipe_count", "integer"],
  ["byte_size", "integer"],
  ["csv_schema_version", "integer"]
] as const;
export const COST_CARD_DIRECTORY_REGISTRY = {
  dataset: "cost_cards" as const,
  accessMode: "catalog_query" as const,
  modes: ["detail"] as const,
  fields: [
    ...COST_CARD_UPLOAD_SCHEMA.filter((f) => f.scope === "card").map((f) => ({
      ...f,
      type: f.type as CostCardDirectoryField["type"]
    })),
    ...DIRECTORY_METADATA.map(([canonicalName, type]) => ({
      canonicalName,
      sourceColumn: canonicalName,
      aliases: [],
      type,
      nullable: false
    }))
  ].map((f): CostCardDirectoryField => ({
    canonicalName: f.canonicalName,
    sourceColumn: f.sourceColumn,
    aliases: f.aliases,
    type: f.type,
    nullable: f.nullable,
    inputSource: "file",
    sensitivity: "normal",
    lifecycle: "active",
    volatility: "stable_export",
    defaultReturn: true,
    operators:
      f.type === "string"
        ? [
            "eq",
            "in",
            ...(["dish_name", "specification_name", "base_category_name"].includes(f.canonicalName)
              ? ["contains", "starts_with"]
              : [])
          ]
        : f.type === "boolean"
          ? ["eq", "in"]
          : ["eq", "in", "gt", "gte", "lt", "lte"],
    capabilities: { filter: true, sort: true, group: false, aggregate: false },
    indexStatus: "not_indexed"
  }))
};

/** Exact base-10 normalization. Exponents are accepted for raw OOXML numerics only by callers. */
export function normalizeCostCardDecimal(value: string, percent = false): string {
  const text = value.trim();
  const match = /^([+-]?)(?:(\d+)(?:\.(\d*))?|\.(\d+))(%?)$/.exec(text);
  if (!match || (match[5] && !percent)) throw new Error("Expected an exact decimal value.");
  let integer = (match[2] ?? "0").replace(/^0+(?=\d)/, "");
  let fraction = match[3] ?? match[4] ?? "";
  if (match[5]) {
    const digits = integer.padStart(3, "0");
    fraction = digits.slice(-2) + fraction;
    integer = digits.slice(0, -2);
  }
  integer = integer.replace(/^0+(?=\d)/, "");
  fraction = fraction.replace(/0+$/, "");
  if (fraction.length > 6 || integer.length > (percent ? 6 : 14))
    throw new Error(`Decimal precision exceeds DECIMAL(${percent ? 12 : 20},6).`);
  const zero = integer === "0" && fraction === "";
  return `${match[1] === "-" && !zero ? "-" : ""}${integer}${fraction ? `.${fraction}` : ""}`;
}

export function normalizeCostCardValue(field: CostCardUploadField, value: unknown): Value {
  if (value === null || value === undefined || value === "") {
    if (!field.nullable) throw new Error(`${field.canonicalName} is required.`);
    return null;
  }
  if (typeof value === "number")
    throw new Error(`${field.canonicalName} must preserve source text.`);
  const text = String(value).trim();
  if (!text) {
    if (!field.nullable) throw new Error(`${field.canonicalName} is required.`);
    return null;
  }
  if (field.type === "boolean") {
    if (["是", "true"].includes(text)) return true;
    if (["否", "false"].includes(text)) return false;
    throw new Error(`${field.canonicalName} must be 是/否 or true/false.`);
  }
  if (field.type === "decimal" || field.type === "percent")
    return normalizeCostCardDecimal(text, field.type === "percent");
  if (text.length > (field.maxLength ?? 32767))
    throw new Error(`${field.canonicalName} is too long.`);
  return field.canonicalName === "source_stores_text" ? String(value) : text;
}

export function costCardStores(text: string | null): string[] {
  return [
    ...new Set(
      (text ?? "")
        .split(/[,，;；\r\n、]+/)
        .map((v) => v.trim())
        .filter(Boolean)
    )
  ].sort();
}

export function costCardScopedValues(
  row: Record<string, unknown>,
  scope: CostCardUploadField["scope"]
): Record<string, Value> {
  return Object.fromEntries(
    COST_CARD_UPLOAD_SCHEMA.filter((f) => f.scope === scope).map((f) => [
      f.canonicalName,
      normalizeCostCardValue(f, row[f.canonicalName])
    ])
  );
}

export function costCardFromRows(
  rows: readonly Record<string, unknown>[],
  identity: CostCardIdentity
): CanonicalCostCard {
  if (!rows.length) throw new Error("Cost card requires at least one item row.");
  const recipes = new Map<string, CostCardRecipe>();
  const card = costCardScopedValues(rows[0]!, "card") as unknown as CostCardFields;
  for (const row of rows) {
    const fields = costCardScopedValues(row, "recipe") as unknown as Omit<
      CostCardRecipe,
      "stores" | "items"
    >;
    const key = JSON.stringify([fields.recipe_type, fields.recipe_name]);
    let recipe = recipes.get(key);
    if (!recipe) {
      recipe = { ...fields, stores: costCardStores(fields.source_stores_text), items: [] };
      recipes.set(key, recipe);
    }
    recipe.items.push(costCardScopedValues(row, "item") as unknown as CostCardItem);
  }
  return { identity, card, recipes: [...recipes.values()] };
}

export function canonicalizeCostCard(card: CanonicalCostCard): string {
  const recipes = card.recipes
    .map((recipe) => {
      const fields = costCardScopedValues({ ...recipe }, "recipe");
      delete fields.source_stores_text;
      return {
        ...fields,
        stores: costCardStores(recipe.source_stores_text),
        items: recipe.items
          .map((item) => costCardScopedValues({ ...item }, "item"))
          .sort(compareCanonical)
      };
    })
    .sort(compareCanonical);
  return JSON.stringify({
    identity: {
      enterpriseKey: card.identity.enterpriseKey,
      sourceNamespace: card.identity.sourceNamespace,
      spuId: card.identity.spuId,
      skuId: card.identity.skuId
    },
    card: costCardScopedValues({ ...card.card }, "card"),
    recipes
  });
}
function compareCanonical(a: unknown, b: unknown): number {
  const first = JSON.stringify(a),
    second = JSON.stringify(b);
  return first < second ? -1 : first > second ? 1 : 0;
}
export function hashCostCard(card: CanonicalCostCard): string {
  return createHash("sha256").update(canonicalizeCostCard(card)).digest("hex");
}
export type CostCardChangeField =
  | "card.created"
  | keyof CostCardFields
  | "recipes.added"
  | "recipes.removed"
  | "recipes.fields"
  | "recipes.items"
  | "recipes.stores"
  | "archived_at";
export interface CostCardCounts {
  inserted: number;
  updated: number;
  unchanged: number;
  restored: number;
}
export interface CostCardChange {
  costCardId: string;
  identity: CostCardIdentity;
  operation: "inserted" | "updated" | "restored";
  changedFields: CostCardChangeField[];
}
export interface CostCardPublication {
  inputCardCount: number;
  inputItemRowCount: number;
  counts: CostCardCounts;
  changes: CostCardChange[];
  changesTruncated: boolean;
}
/** Fields combine with AND; values within an array combine with OR. */
export interface CostCardSelection {
  enterpriseName?: string;
  costCardIds?: string[];
  spuIds?: string[];
  skuIds?: string[];
  dishName?: string;
  dishNameContains?: string;
  specificationName?: string;
  baseCategoryName?: string;
}
export interface CostCardManifestEntry {
  costCardId: string;
  revision: string;
  enterpriseName: string;
  sourceNamespace: "meituan";
  spuId: string;
  skuId: string;
  dishName: string;
  specificationName: string | null;
  schemaVersion: number;
  itemRowCount: number;
  byteSize: number;
  checksumSha256: string;
  sourceDocumentId: string;
  importBatchId: string;
  presignedDownloadUrl: string;
}
export interface CostCardManifest {
  expiresAt: string;
  cardCount: number;
  totalItemRowCount: number;
  cards: CostCardManifestEntry[];
}
export type LocalCostCardManifest = Omit<CostCardManifest, "cards"> & {
  cards: Omit<CostCardManifestEntry, "presignedDownloadUrl">[];
};
