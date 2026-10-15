import { createHash } from "node:crypto";
import {
  COST_CARD_DIRECTORY_REGISTRY,
  normalizeCostCardDecimal,
  type CostCardSelection
} from "./cost-cards.js";
import { normalizeEnterpriseIdentity } from "./structured-partitions.js";
import { PHASE3_ERROR_CODES } from "./retrieval-contracts.js";
import {
  decodeStructuredCursor,
  normalizeStructuredDirectoryQuery,
  STRUCTURED_QUERY_LIMITS,
  StructuredQueryValidationError,
  type StructuredCompiledQuery,
  type StructuredQueryEmployeeScope
} from "./structured-query.js";

export interface CostCardQueryInput {
  orgId: string;
  employee: StructuredQueryEmployeeScope;
  query: unknown;
  cursorSecret: string;
  now?: Date;
  businessAuthorization?: { version: string; sql: string; params: Array<string | number> };
}
type Fragment = { sql: string; params: Array<string | number> };
const fields = new Map(
  COST_CARD_DIRECTORY_REGISTRY.fields.map((field) => [field.canonicalName, field])
);
function invalid(message: string): never {
  throw new StructuredQueryValidationError(PHASE3_ERROR_CODES.invalidQuery, message);
}
function column(field: string): string {
  if (!fields.has(field)) invalid("Field is not in the cost-card directory registry.");
  return `c.${field === "cost_card_id" ? "id" : field}`;
}
function literalLike(text: string): string {
  return text.replaceAll("!", "!!").replaceAll("%", "!%").replaceAll("_", "!_");
}
const maxLengths: Record<string, number> = {
  spu_id: 64,
  sku_id: 64,
  dish_name: 512,
  specification_name: 255,
  base_category_name: 255,
  enterprise_name: 255,
  source_namespace: 128,
  cost_card_id: 32,
  source_document_id: 32,
  import_batch_id: 32,
  revision: 20
};
function scalar(fieldName: string, value: unknown): string | number | null {
  const field = fields.get(fieldName)!;
  if (value === null) return null;
  if (field.type === "decimal") {
    if (typeof value !== "string")
      invalid("Cost-card decimal filters require exact decimal strings.");
    try {
      return normalizeCostCardDecimal(value);
    } catch {
      invalid("Cost-card decimal filter is invalid.");
    }
  }
  if (field.type === "integer") {
    if (typeof value !== "number" || !Number.isSafeInteger(value))
      invalid("Directory count filters require safe integers.");
    return value;
  }
  if (field.type === "boolean") {
    if (typeof value !== "boolean") invalid("Directory boolean filters require booleans.");
    return value ? 1 : 0;
  }
  if (typeof value !== "string" || value.length > (maxLengths[fieldName] ?? 512))
    invalid("Directory text filter is invalid.");
  return value;
}
function condition(fieldName: string, op: string, value: unknown): Fragment {
  const target = column(fieldName);
  const field = fields.get(fieldName)!;
  if (!field.operators.includes(op)) invalid("Operator is not supported by the directory field.");
  const targetExpression = field.type === "string" ? `CAST(${target} AS BINARY)` : target;
  if (op === "contains" || op === "starts_with") {
    const text = scalar(fieldName, value);
    if (typeof text !== "string") invalid("Name search requires a string.");
    return {
      sql: `${targetExpression} LIKE CAST(? AS BINARY) ESCAPE '!'`,
      params: [`${op === "contains" ? "%" : ""}${literalLike(text)}%`]
    };
  }
  const placeholder =
    field.type === "string"
      ? "CAST(? AS BINARY)"
      : field.type === "decimal"
        ? "CAST(? AS DECIMAL(20,6))"
        : "?";
  if (op === "in") {
    if (!Array.isArray(value) || value.length > STRUCTURED_QUERY_LIMITS.maxInValues)
      invalid("Directory in filter requires a bounded array.");
    const values = value.map((item) => scalar(fieldName, item));
    const nonNull = values.filter((item): item is string | number => item !== null);
    const parts = [];
    if (nonNull.length)
      parts.push(`${targetExpression} IN (${nonNull.map(() => placeholder).join(", ")})`);
    if (values.includes(null)) parts.push(`${target} IS NULL`);
    return { sql: parts.length ? `(${parts.join(" OR ")})` : "0 = 1", params: nonNull };
  }
  const parsed = scalar(fieldName, value);
  if (parsed === null) {
    if (op !== "eq") invalid("Null values support equality only.");
    return { sql: `${target} IS NULL`, params: [] };
  }
  const operators: Record<string, string> = { eq: "=", gt: ">", gte: ">=", lt: "<", lte: "<=" };
  const operator = operators[op];
  if (!operator) invalid("Directory operator is invalid.");
  return { sql: `${targetExpression} ${operator} ${placeholder}`, params: [parsed] };
}
type Filter = ReturnType<typeof normalizeStructuredDirectoryQuery>["filter"];
function filter(node: Filter): Fragment {
  if (node === null) return { sql: "1 = 1", params: [] };
  if ("not" in node) {
    const inner = filter(node.not);
    return { sql: `NOT (${inner.sql})`, params: inner.params };
  }
  if ("and" in node || "or" in node) {
    const children = ("and" in node ? node.and : node.or).map(filter);
    return {
      sql: children.map((child) => `(${child.sql})`).join("and" in node ? " AND " : " OR "),
      params: children.flatMap((child) => child.params)
    };
  }
  return condition(node.field, node.op, node.value);
}
export function compileCostCardQuery(input: CostCardQueryInput): StructuredCompiledQuery {
  if (!input.businessAuthorization)
    throw new StructuredQueryValidationError(
      PHASE3_ERROR_CODES.datasetForbidden,
      "Current cost-card authorization is required."
    );
  const query = normalizeStructuredDirectoryQuery(input.query, {
    ...COST_CARD_DIRECTORY_REGISTRY,
    fields: [...COST_CARD_DIRECTORY_REGISTRY.fields],
    sheetPolicy: "cost_card_candidates",
    metadataPolicy: "none"
  });
  const where = filter(query.filter);
  const shapeHash = createHash("sha256")
    .update(
      JSON.stringify({
        orgId: input.orgId,
        employeeId: input.employee.id,
        clearance: input.employee.clearance,
        authorization: input.businessAuthorization,
        query: { ...query, page: { limit: query.page.limit, cursor: null } }
      })
    )
    .digest("hex");
  const offset = query.page.cursor
    ? decodeStructuredCursor({
        cursor: query.page.cursor,
        expectedShapeHash: shapeHash,
        secret: input.cursorSecret,
        now: input.now
      }).offset
    : 0;
  const projection = query.select
    .map(
      (name) =>
        `${name === "sale_price" || name === "revision" ? `CAST(${column(name)} AS CHAR)` : column(name)} AS \`${name}\``
    )
    .join(", ");
  const sort = query.sort.map((item) => `${column(item.field)} ${item.direction.toUpperCase()}`);
  if (!query.sort.some((item) => item.field === "cost_card_id")) sort.push("c.id ASC");
  return {
    dataset: "cost_cards",
    mode: "detail",
    sql: `SELECT ${projection} FROM cost_cards c WHERE CAST(c.org_id AS BINARY) = CAST(? AS BINARY) AND c.archived_at IS NULL AND (${input.businessAuthorization.sql}) AND (${where.sql}) ORDER BY ${sort.join(", ")} LIMIT ? OFFSET ?`,
    params: [
      input.orgId,
      ...input.businessAuthorization.params,
      ...where.params,
      query.page.limit,
      offset
    ],
    selectedFields: query.select,
    dynamicSelectedFields: [],
    aggregateAliases: [],
    limit: query.page.limit,
    offset,
    shapeHash,
    authorizationScope: { orgId: input.orgId, employee: input.employee }
  };
}

const selectionFields = {
  enterpriseName: 255,
  dishName: 512,
  dishNameContains: 512,
  specificationName: 255,
  baseCategoryName: 255
};
const selectionArrays = { costCardIds: 32, spuIds: 64, skuIds: 64 };
export function parseCostCardSelection(input: unknown): CostCardSelection {
  if (!input || typeof input !== "object" || Array.isArray(input))
    invalid("Cost-card selection must be an object.");
  const record = input as Record<string, unknown>;
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) {
    if (Object.hasOwn(selectionFields, key)) {
      if (
        typeof value !== "string" ||
        !value.trim() ||
        value.length > selectionFields[key as keyof typeof selectionFields]
      )
        invalid("Cost-card selection text is invalid.");
      result[key] = value;
    } else if (Object.hasOwn(selectionArrays, key)) {
      if (
        !Array.isArray(value) ||
        value.length === 0 ||
        value.length > STRUCTURED_QUERY_LIMITS.maxInValues ||
        value.some(
          (item) =>
            typeof item !== "string" ||
            !item.trim() ||
            item.length > selectionArrays[key as keyof typeof selectionArrays]
        )
      )
        invalid("Cost-card selection requires a nonempty bounded string array.");
      result[key] = [...new Set(value)];
    } else invalid("Cost-card selection contains unsupported fields.");
  }
  return result as CostCardSelection;
}
export function compileCostCardSelection(input: CostCardSelection): Fragment {
  const selection = parseCostCardSelection(input);
  const fragments: Fragment[] = [];
  if (selection.enterpriseName !== undefined)
    fragments.push({
      sql: "CAST(c.enterprise_key AS BINARY) = CAST(? AS BINARY)",
      params: [normalizeEnterpriseIdentity(selection.enterpriseName).enterpriseKey]
    });
  if (selection.costCardIds) fragments.push(condition("cost_card_id", "in", selection.costCardIds));
  if (selection.spuIds) fragments.push(condition("spu_id", "in", selection.spuIds));
  if (selection.skuIds) fragments.push(condition("sku_id", "in", selection.skuIds));
  if (selection.dishName !== undefined)
    fragments.push(condition("dish_name", "eq", selection.dishName));
  if (selection.dishNameContains !== undefined)
    fragments.push(condition("dish_name", "contains", selection.dishNameContains));
  if (selection.specificationName !== undefined)
    fragments.push(condition("specification_name", "eq", selection.specificationName));
  if (selection.baseCategoryName !== undefined)
    fragments.push(condition("base_category_name", "eq", selection.baseCategoryName));
  return {
    sql: fragments.map((fragment) => `(${fragment.sql})`).join(" AND ") || "1 = 1",
    params: fragments.flatMap((fragment) => fragment.params)
  };
}
