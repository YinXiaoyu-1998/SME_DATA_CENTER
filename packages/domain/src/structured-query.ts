import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { PUBLIC_INPUT_LIMITS } from "./input-boundaries.js";
import { PHASE3_ERROR_CODES, type Phase3ErrorCode } from "./retrieval-contracts.js";
import {
  STRUCTURED_DATASETS,
  getStructuredRegistry,
  type StructuredDatasetName,
  type StructuredDatasetRegistry,
  type StructuredFieldRegistryEntry,
  type StructuredFieldType
} from "./structured-registry.js";

export const STRUCTURED_QUERY_LIMITS = {
  defaultLimit: 50,
  maxRows: 200,
  maxAggregateGroups: 200,
  maxBooleanDepth: 3,
  maxConditions: 20,
  maxInValues: 100,
  maxSortFields: 2,
  maxGroupByFields: 4,
  maxAggregates: 12,
  maxSelectedFields: 50,
  cursorTtlSeconds: 900
} as const;

export type StructuredQueryMode = "detail" | "aggregate";

export interface StructuredQueryEmployeeScope {
  id?: string;
  clearance: number;
}

export interface StructuredQueryAuthorizationScope {
  orgId: string;
  employee: StructuredQueryEmployeeScope;
}

export interface StructuredCompiledQuery {
  dataset: StructuredDatasetName;
  mode: StructuredQueryMode;
  sql: string;
  params: Array<string | number>;
  selectedFields: string[];
  dynamicSelectedFields: string[];
  aggregateAliases: string[];
  limit: number;
  offset: number;
  shapeHash: string;
  authorizationScope: StructuredQueryAuthorizationScope;
}

export class StructuredQueryValidationError extends Error {
  readonly code: Phase3ErrorCode;
  readonly details: Record<string, unknown>;

  constructor(code: Phase3ErrorCode, message: string, details: Record<string, unknown> = {}) {
    super(message);
    this.name = "StructuredQueryValidationError";
    this.code = code;
    this.details = details;
  }
}

interface CompileStructuredQueryInput {
  orgId: string;
  employee: StructuredQueryEmployeeScope;
  query: unknown;
  cursorSecret: string;
  now?: Date;
}

interface NormalizedQuery {
  dataset: StructuredDatasetName;
  select: string[];
  filter: FilterNode | null;
  sort: SortSpec[];
  page: {
    limit: number;
    cursor: string | null;
  };
  groupBy: string[];
  aggregates: AggregateSpec[];
}

type ScalarValue = string | number | boolean | null;

interface FieldCondition {
  field: string;
  op: string;
  value: ScalarValue | ScalarValue[];
}

interface AndFilter {
  and: FilterNode[];
}

interface OrFilter {
  or: FilterNode[];
}

interface NotFilter {
  not: FilterNode;
}

type FilterNode = FieldCondition | AndFilter | OrFilter | NotFilter;

interface SortSpec {
  field: string;
  direction: "asc" | "desc";
}

type AggregateSpec =
  | { op: "count"; field?: string; as?: string }
  | { op: "countDistinct" | "sum" | "avg" | "min" | "max"; field: string; as?: string }
  | { op: "weightedAvg"; field: string; weightField: string; as?: string };

interface SqlFragment {
  sql: string;
  params: Array<string | number>;
}

interface CursorPayload {
  offset: number;
  shapeHash: string;
  expiresAt: number;
  signature: string;
}

const TOP_LEVEL_KEYS = new Set([
  "dataset",
  "select",
  "filter",
  "sort",
  "page",
  "groupBy",
  "aggregates"
]);

const AGGREGATE_OPERATORS = new Set([
  "count",
  "countDistinct",
  "sum",
  "avg",
  "min",
  "max",
  "weightedAvg"
]);
const COUNT_AGGREGATE_KEYS = new Set(["op", "field", "as"]);
const FIELD_AGGREGATE_KEYS = new Set(["op", "field", "as"]);
const WEIGHTED_AVERAGE_AGGREGATE_KEYS = new Set(["op", "field", "weightField", "as"]);
const SORT_KEYS = new Set(["field", "direction"]);
const PAGE_KEYS = new Set(["limit", "cursor"]);

export function compileStructuredQuery(
  input: CompileStructuredQueryInput
): StructuredCompiledQuery {
  const query = normalizeQuery(input.query);
  const registry = getStructuredRegistry(query.dataset);

  const fields = new Map(registry.fields.map((field) => [field.canonicalName, field]));
  const mode: StructuredQueryMode =
    query.aggregates.length > 0 || query.groupBy.length > 0 ? "aggregate" : "detail";
  validateSelectedFields(query, fields, mode);
  validateAggregates(query, fields);
  validateSort(query, fields, mode);
  validateFilter(query.filter, fields);

  const shapeHash = hashQueryShape({
    orgId: input.orgId,
    employeeId: input.employee.id ?? null,
    clearance: input.employee.clearance,
    query: { ...query, page: { limit: query.page.limit, cursor: null } }
  });
  const offset = query.page.cursor
    ? decodeStructuredCursor({
        cursor: query.page.cursor,
        expectedShapeHash: shapeHash,
        secret: input.cursorSecret,
        now: input.now
      }).offset
    : 0;

  const selectedFields =
    mode === "detail"
      ? query.select
      : [...query.groupBy, ...query.aggregates.map((aggregate) => aggregateAlias(aggregate))];
  const dynamicSelectedFields =
    mode === "detail"
      ? query.select.filter(
          (fieldName) => requireField(fields, fieldName).inputSource === "dynamic_lookup"
        )
      : [];
  const projection = buildProjection(query, fields, mode);
  const from = baseFromAndWhere({
    registry,
    employee: input.employee,
    orgId: input.orgId
  });
  const filter = query.filter ? compileFilter(query.filter, fields) : null;
  const whereSql = filter ? `${from.sql} AND (${filter.sql})` : from.sql;
  const params = [...projection.params, ...from.params, ...(filter?.params ?? [])];
  const order = buildOrderBy(query, fields, mode);

  if (mode === "aggregate") {
    const groupBy =
      query.groupBy.length > 0
        ? ` GROUP BY ${query.groupBy
            .map((fieldName) => quoteIdentifier(requireField(fields, fieldName).canonicalName))
            .join(", ")}`
        : "";

    return {
      dataset: query.dataset,
      mode,
      sql: `SELECT ${projection.sql} FROM ${registry.rowTable} r ${whereSql}${groupBy}${order.sql} LIMIT ? OFFSET ?`,
      params: [...params, ...order.params, query.page.limit, offset],
      selectedFields,
      dynamicSelectedFields,
      aggregateAliases: query.aggregates.map((aggregate) => aggregateAlias(aggregate)),
      limit: query.page.limit,
      offset,
      shapeHash,
      authorizationScope: {
        orgId: input.orgId,
        employee: { ...input.employee }
      }
    };
  }

  return {
    dataset: query.dataset,
    mode,
    sql: `SELECT ${projection.sql} FROM ${registry.rowTable} r ${whereSql}${order.sql} LIMIT ? OFFSET ?`,
    params: [...params, ...order.params, query.page.limit, offset],
    selectedFields,
    dynamicSelectedFields,
    aggregateAliases: [],
    limit: query.page.limit,
    offset,
    shapeHash,
    authorizationScope: {
      orgId: input.orgId,
      employee: { ...input.employee }
    }
  };
}

export function createStructuredCursor(input: {
  offset: number;
  shapeHash: string;
  secret: string;
  now?: Date;
}): string {
  const expiresAt =
    Math.floor((input.now?.getTime() ?? Date.now()) / 1000) +
    STRUCTURED_QUERY_LIMITS.cursorTtlSeconds;
  const unsigned = {
    offset: input.offset,
    shapeHash: input.shapeHash,
    expiresAt
  };
  const signature = signCursorPayload(unsigned, input.secret);

  return Buffer.from(JSON.stringify({ ...unsigned, signature }), "utf8").toString("base64url");
}

export function decodeStructuredCursor(input: {
  cursor: string;
  expectedShapeHash: string;
  secret: string;
  now?: Date;
}): { offset: number } {
  if (input.cursor.length > PUBLIC_INPUT_LIMITS.cursorChars) {
    throw new StructuredQueryValidationError(
      PHASE3_ERROR_CODES.invalidCursor,
      "Cursor is invalid."
    );
  }

  let payload: CursorPayload;

  try {
    payload = JSON.parse(Buffer.from(input.cursor, "base64url").toString("utf8")) as CursorPayload;
  } catch {
    throw new StructuredQueryValidationError(
      PHASE3_ERROR_CODES.invalidCursor,
      "Cursor is invalid."
    );
  }

  if (
    !Number.isInteger(payload.offset) ||
    payload.offset < 0 ||
    typeof payload.shapeHash !== "string" ||
    typeof payload.expiresAt !== "number" ||
    typeof payload.signature !== "string"
  ) {
    throw new StructuredQueryValidationError(
      PHASE3_ERROR_CODES.invalidCursor,
      "Cursor is invalid."
    );
  }

  const expectedSignature = signCursorPayload(
    {
      offset: payload.offset,
      shapeHash: payload.shapeHash,
      expiresAt: payload.expiresAt
    },
    input.secret
  );

  if (
    !safeEqual(payload.signature, expectedSignature) ||
    payload.shapeHash !== input.expectedShapeHash
  ) {
    throw new StructuredQueryValidationError(
      PHASE3_ERROR_CODES.invalidCursor,
      "Cursor does not match the query shape."
    );
  }

  const nowSeconds = Math.floor((input.now?.getTime() ?? Date.now()) / 1000);
  if (payload.expiresAt < nowSeconds) {
    throw new StructuredQueryValidationError(
      PHASE3_ERROR_CODES.cursorExpired,
      "Cursor has expired."
    );
  }

  return { offset: payload.offset };
}

function normalizeQuery(input: unknown): NormalizedQuery {
  const object = requirePlainObject(input, "Query body must be an object.");
  rejectUnknownKeys(object, TOP_LEVEL_KEYS);

  const dataset = object["dataset"];
  if (
    typeof dataset !== "string" ||
    !STRUCTURED_DATASETS.includes(dataset as StructuredDatasetName)
  ) {
    throw new StructuredQueryValidationError(
      PHASE3_ERROR_CODES.invalidQuery,
      "Dataset is invalid.",
      { dataset }
    );
  }

  const registry = getStructuredRegistry(dataset as StructuredDatasetName);
  const select = normalizeStringArray(
    object["select"],
    "select",
    STRUCTURED_QUERY_LIMITS.maxSelectedFields,
    false
  );
  const sort = normalizeSort(object["sort"]);
  const groupBy = normalizeStringArray(
    object["groupBy"],
    "groupBy",
    STRUCTURED_QUERY_LIMITS.maxGroupByFields,
    false
  );
  const aggregates = normalizeAggregates(object["aggregates"]);
  const mode: StructuredQueryMode =
    aggregates.length > 0 || groupBy.length > 0 ? "aggregate" : "detail";
  const effectiveSelect =
    select.length > 0
      ? select
      : mode === "detail"
        ? registry.fields.filter((field) => field.defaultReturn).map((field) => field.canonicalName)
        : [];
  const page = normalizePage(object["page"], mode);

  return {
    dataset: dataset as StructuredDatasetName,
    select: effectiveSelect,
    filter: object["filter"] === undefined ? null : normalizeFilter(object["filter"], 1).node,
    sort,
    page,
    groupBy,
    aggregates
  };
}

function rejectUnknownKeys(object: Record<string, unknown>, allowedKeys: Set<string>) {
  for (const key of Object.keys(object)) {
    if (!allowedKeys.has(key)) {
      throw new StructuredQueryValidationError(
        PHASE3_ERROR_CODES.invalidQuery,
        "Query contains unsupported keys.",
        { key }
      );
    }
  }
}

function requirePlainObject(input: unknown, message: string): Record<string, unknown> {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new StructuredQueryValidationError(PHASE3_ERROR_CODES.invalidQuery, message);
  }

  return input as Record<string, unknown>;
}

function normalizeStringArray(
  input: unknown,
  name: string,
  max: number,
  required: boolean
): string[] {
  if (input === undefined) {
    if (required) {
      throw new StructuredQueryValidationError(
        PHASE3_ERROR_CODES.invalidQuery,
        `${name} is required.`
      );
    }

    return [];
  }

  if (!Array.isArray(input) || input.some((value) => typeof value !== "string")) {
    throw new StructuredQueryValidationError(
      PHASE3_ERROR_CODES.invalidQuery,
      `${name} must be a string array.`
    );
  }

  if (input.length > max) {
    throw new StructuredQueryValidationError(
      PHASE3_ERROR_CODES.limitExceeded,
      `${name} exceeds the allowed limit.`,
      { limit: max }
    );
  }

  return [...new Set(input.map((value) => value.trim()).filter(Boolean))];
}

function normalizeSort(input: unknown): SortSpec[] {
  if (input === undefined) {
    return [];
  }

  if (!Array.isArray(input)) {
    throw new StructuredQueryValidationError(
      PHASE3_ERROR_CODES.invalidQuery,
      "sort must be an array."
    );
  }

  if (input.length > STRUCTURED_QUERY_LIMITS.maxSortFields) {
    throw new StructuredQueryValidationError(
      PHASE3_ERROR_CODES.limitExceeded,
      "sort exceeds the allowed limit."
    );
  }

  return input.map((item) => {
    const object = requirePlainObject(item, "sort item must be an object.");
    rejectUnknownKeys(object, SORT_KEYS);
    const field = object["field"];
    const direction = object["direction"] ?? "asc";

    if (typeof field !== "string" || (direction !== "asc" && direction !== "desc")) {
      throw new StructuredQueryValidationError(
        PHASE3_ERROR_CODES.invalidQuery,
        "sort item is invalid."
      );
    }

    return { field, direction };
  });
}

function normalizePage(input: unknown, mode: StructuredQueryMode) {
  if (input === undefined) {
    return { limit: STRUCTURED_QUERY_LIMITS.defaultLimit, cursor: null };
  }

  const object = requirePlainObject(input, "page must be an object.");
  rejectUnknownKeys(object, PAGE_KEYS);
  const limit = object["limit"] ?? STRUCTURED_QUERY_LIMITS.defaultLimit;
  const cursor = object["cursor"] ?? null;
  const maxLimit =
    mode === "aggregate"
      ? STRUCTURED_QUERY_LIMITS.maxAggregateGroups
      : STRUCTURED_QUERY_LIMITS.maxRows;

  if (!Number.isInteger(limit) || (limit as number) < 1 || (limit as number) > maxLimit) {
    throw new StructuredQueryValidationError(
      PHASE3_ERROR_CODES.limitExceeded,
      "Page limit exceeds the allowed limit.",
      { limit: maxLimit }
    );
  }

  if (cursor !== null && typeof cursor !== "string") {
    throw new StructuredQueryValidationError(
      PHASE3_ERROR_CODES.invalidCursor,
      "Cursor is invalid."
    );
  }

  return {
    limit: limit as number,
    cursor
  };
}

function normalizeAggregates(input: unknown): AggregateSpec[] {
  if (input === undefined) {
    return [];
  }

  if (!Array.isArray(input)) {
    throw new StructuredQueryValidationError(
      PHASE3_ERROR_CODES.invalidAggregation,
      "aggregates must be an array."
    );
  }

  if (input.length > STRUCTURED_QUERY_LIMITS.maxAggregates) {
    throw new StructuredQueryValidationError(
      PHASE3_ERROR_CODES.limitExceeded,
      "aggregates exceeds the allowed limit."
    );
  }

  return input.map((item) => {
    const object = requirePlainObject(item, "aggregate item must be an object.");
    const op = object["op"];
    const field = object["field"];
    const weightField = object["weightField"];
    const alias = object["as"];

    if (typeof op !== "string" || !AGGREGATE_OPERATORS.has(op)) {
      throw new StructuredQueryValidationError(
        PHASE3_ERROR_CODES.invalidAggregation,
        "Aggregate operator is invalid."
      );
    }

    if (alias !== undefined && (typeof alias !== "string" || !isSafeAlias(alias))) {
      throw new StructuredQueryValidationError(
        PHASE3_ERROR_CODES.invalidAggregation,
        "Aggregate alias is invalid."
      );
    }

    if (op === "count") {
      rejectUnknownKeys(object, COUNT_AGGREGATE_KEYS);
      if (field !== undefined && typeof field !== "string") {
        throw new StructuredQueryValidationError(
          PHASE3_ERROR_CODES.invalidAggregation,
          "Aggregate field is invalid."
        );
      }
      if (field === "") {
        throw new StructuredQueryValidationError(
          PHASE3_ERROR_CODES.invalidAggregation,
          "Aggregate field is invalid."
        );
      }

      return { op, field, as: alias } satisfies AggregateSpec;
    }

    if (op === "weightedAvg") {
      rejectUnknownKeys(object, WEIGHTED_AVERAGE_AGGREGATE_KEYS);
      if (typeof field !== "string" || typeof weightField !== "string") {
        throw new StructuredQueryValidationError(
          PHASE3_ERROR_CODES.invalidAggregation,
          "Weighted aggregate fields are required."
        );
      }

      return { op, field, weightField, as: alias } satisfies AggregateSpec;
    }

    switch (op) {
      case "countDistinct":
      case "sum":
      case "avg":
      case "min":
      case "max": {
        rejectUnknownKeys(object, FIELD_AGGREGATE_KEYS);
        if (typeof field !== "string") {
          throw new StructuredQueryValidationError(
            PHASE3_ERROR_CODES.invalidAggregation,
            "Aggregate field is required."
          );
        }

        return { op, field, as: alias } satisfies AggregateSpec;
      }
    }

    throw new StructuredQueryValidationError(
      PHASE3_ERROR_CODES.invalidAggregation,
      "Aggregate operator is invalid."
    );
  });
}

function normalizeFilter(input: unknown, depth: number): { node: FilterNode; count: number } {
  if (depth > STRUCTURED_QUERY_LIMITS.maxBooleanDepth) {
    throw new StructuredQueryValidationError(
      PHASE3_ERROR_CODES.limitExceeded,
      "Filter boolean depth exceeds the allowed limit."
    );
  }

  const object = requirePlainObject(input, "filter must be an object.");
  const keys = Object.keys(object);

  if (keys.includes("and") || keys.includes("or")) {
    if (keys.length !== 1) {
      throw new StructuredQueryValidationError(
        PHASE3_ERROR_CODES.invalidQuery,
        "Boolean filter is invalid."
      );
    }

    const key = keys[0] as "and" | "or";
    const values = object[key];
    if (!Array.isArray(values) || values.length === 0) {
      throw new StructuredQueryValidationError(
        PHASE3_ERROR_CODES.invalidQuery,
        "Boolean filter is empty."
      );
    }

    let count = 0;
    const nodes = values.map((value) => {
      const child = normalizeFilter(value, depth + 1);
      count += child.count;
      return child.node;
    });

    if (count > STRUCTURED_QUERY_LIMITS.maxConditions) {
      throw new StructuredQueryValidationError(
        PHASE3_ERROR_CODES.limitExceeded,
        "Filter condition count exceeds the allowed limit."
      );
    }

    return { node: key === "and" ? { and: nodes } : { or: nodes }, count };
  }

  if (keys.includes("not")) {
    if (keys.length !== 1) {
      throw new StructuredQueryValidationError(
        PHASE3_ERROR_CODES.invalidQuery,
        "Not filter is invalid."
      );
    }

    const child = normalizeFilter(object["not"], depth + 1);
    return { node: { not: child.node }, count: child.count };
  }

  if (!keys.includes("field") || !keys.includes("op") || !keys.includes("value")) {
    throw new StructuredQueryValidationError(
      PHASE3_ERROR_CODES.invalidQuery,
      "Field condition is invalid."
    );
  }

  if (keys.some((key) => !["field", "op", "value"].includes(key))) {
    throw new StructuredQueryValidationError(
      PHASE3_ERROR_CODES.invalidQuery,
      "Field condition has unsupported keys."
    );
  }

  if (typeof object["field"] !== "string" || typeof object["op"] !== "string") {
    throw new StructuredQueryValidationError(
      PHASE3_ERROR_CODES.invalidQuery,
      "Field condition is invalid."
    );
  }

  return {
    node: {
      field: object["field"],
      op: object["op"],
      value: object["value"] as ScalarValue | ScalarValue[]
    },
    count: 1
  };
}

function validateSelectedFields(
  query: NormalizedQuery,
  fields: Map<string, StructuredFieldRegistryEntry>,
  mode: StructuredQueryMode
) {
  if (mode === "aggregate" && query.select.length > 0) {
    throw new StructuredQueryValidationError(
      PHASE3_ERROR_CODES.invalidQuery,
      "select cannot be used with aggregate queries."
    );
  }

  for (const fieldName of query.select) {
    requireField(fields, fieldName);
  }

  for (const fieldName of query.groupBy) {
    const field = requireField(fields, fieldName);
    if (!field.capabilities.group) {
      throw new StructuredQueryValidationError(
        PHASE3_ERROR_CODES.unsupportedCapability,
        "Field does not support grouping.",
        { field: fieldName }
      );
    }
  }
}

function validateAggregates(
  query: NormalizedQuery,
  fields: Map<string, StructuredFieldRegistryEntry>
) {
  if (query.groupBy.length > 0 && query.aggregates.length === 0) {
    throw new StructuredQueryValidationError(
      PHASE3_ERROR_CODES.invalidAggregation,
      "Aggregate queries require at least one aggregate."
    );
  }

  for (const aggregate of query.aggregates) {
    if (aggregate.op === "count") {
      if (aggregate.field) {
        const field = requireField(fields, aggregate.field);
        if (!field.capabilities.aggregate && !field.capabilities.group) {
          throw new StructuredQueryValidationError(
            PHASE3_ERROR_CODES.unsupportedCapability,
            "Field does not support counting.",
            { field: aggregate.field }
          );
        }
      }
      continue;
    }

    const field = requireField(fields, aggregate.field);
    if (aggregate.op === "countDistinct") {
      if (!field.capabilities.group && !field.capabilities.aggregate) {
        throw new StructuredQueryValidationError(
          PHASE3_ERROR_CODES.unsupportedCapability,
          "Field does not support countDistinct.",
          { field: aggregate.field }
        );
      }
      continue;
    }

    if (aggregate.op === "weightedAvg") {
      validateWeightedAggregateField(field, aggregate.field);
      const weightField = requireField(fields, aggregate.weightField);
      validateWeightedAggregateField(weightField, aggregate.weightField);
      continue;
    }

    if (!field.capabilities.aggregate) {
      throw new StructuredQueryValidationError(
        PHASE3_ERROR_CODES.unsupportedCapability,
        "Field does not support aggregation.",
        { field: aggregate.field }
      );
    }
  }

  requireUniqueAggregateAliases(query.aggregates, query.groupBy);
}

function validateSort(
  query: NormalizedQuery,
  fields: Map<string, StructuredFieldRegistryEntry>,
  mode: StructuredQueryMode
) {
  if (mode === "aggregate") {
    const groupFields = new Set(query.groupBy);
    const aggregateAliases = uniqueAggregateAliases(query.aggregates, groupFields);

    for (const item of query.sort) {
      if (groupFields.has(item.field)) {
        continue;
      }

      if (aggregateAliases.has(item.field)) {
        continue;
      }

      throw new StructuredQueryValidationError(
        PHASE3_ERROR_CODES.invalidField,
        "Aggregate sort field must be a group field or aggregate alias.",
        { field: item.field }
      );
    }

    return;
  }

  for (const item of query.sort) {
    const field = requireField(fields, item.field);
    if (!field.capabilities.sort) {
      throw new StructuredQueryValidationError(
        PHASE3_ERROR_CODES.unsupportedCapability,
        "Field does not support sorting.",
        { field: item.field }
      );
    }
  }
}

function validateWeightedAggregateField(field: StructuredFieldRegistryEntry, fieldName: string) {
  if (
    field.storage.column !== "payload" ||
    !field.capabilities.aggregate ||
    !["integer", "decimal", "percent"].includes(field.type)
  ) {
    throw new StructuredQueryValidationError(
      PHASE3_ERROR_CODES.unsupportedCapability,
      "Field does not support weighted aggregation.",
      { field: fieldName }
    );
  }
}

function requireUniqueAggregateAliases(
  aggregates: AggregateSpec[],
  reservedAliases: Iterable<string> = []
) {
  const seen = new Set<string>();

  for (const alias of reservedAliases) {
    seen.add(alias);
  }

  for (const aggregate of aggregates) {
    const alias = aggregateAlias(aggregate);
    if (seen.has(alias)) {
      throw new StructuredQueryValidationError(
        PHASE3_ERROR_CODES.invalidAggregation,
        "Aggregate aliases must be unique.",
        { alias }
      );
    }
    seen.add(alias);
  }
}

function uniqueAggregateAliases(
  aggregates: AggregateSpec[],
  reservedAliases: Iterable<string> = []
): Set<string> {
  requireUniqueAggregateAliases(aggregates, reservedAliases);
  return new Set(aggregates.map((aggregate) => aggregateAlias(aggregate)));
}

function validateFilter(
  node: FilterNode | null,
  fields: Map<string, StructuredFieldRegistryEntry>
) {
  if (!node) {
    return;
  }

  if ("and" in node) {
    for (const child of node.and) {
      validateFilter(child, fields);
    }
    return;
  }

  if ("or" in node) {
    for (const child of node.or) {
      validateFilter(child, fields);
    }
    return;
  }

  if ("not" in node) {
    validateFilter(node.not, fields);
    return;
  }

  const field = requireField(fields, node.field);
  if (!field.capabilities.filter) {
    throw new StructuredQueryValidationError(
      PHASE3_ERROR_CODES.unsupportedCapability,
      "Field does not support filtering.",
      { field: node.field }
    );
  }

  if (!field.operators.includes(node.op)) {
    throw new StructuredQueryValidationError(
      PHASE3_ERROR_CODES.unsupportedOperator,
      "Operator is not supported for this field.",
      { field: node.field, operator: node.op }
    );
  }

  validateConditionValue(field, node.op, node.value);
}

function validateConditionValue(
  field: StructuredFieldRegistryEntry,
  op: string,
  value: ScalarValue | ScalarValue[]
) {
  if (op === "between") {
    if (!Array.isArray(value) || value.length !== 2) {
      throw new StructuredQueryValidationError(
        PHASE3_ERROR_CODES.typeMismatch,
        "between requires two values."
      );
    }

    value.forEach((item) => validateScalarType(field.type, item));
    return;
  }

  if (op === "in") {
    if (!Array.isArray(value)) {
      throw new StructuredQueryValidationError(
        PHASE3_ERROR_CODES.typeMismatch,
        "in requires an array."
      );
    }

    if (value.length > STRUCTURED_QUERY_LIMITS.maxInValues) {
      throw new StructuredQueryValidationError(
        PHASE3_ERROR_CODES.limitExceeded,
        "in value count exceeds the allowed limit."
      );
    }

    value.forEach((item) => validateScalarType(field.type, item));
    return;
  }

  if (Array.isArray(value)) {
    throw new StructuredQueryValidationError(
      PHASE3_ERROR_CODES.typeMismatch,
      "Operator requires one scalar value."
    );
  }

  validateScalarType(field.type, value);
}

function validateScalarType(type: StructuredFieldType, value: ScalarValue) {
  if (value === null) {
    return;
  }

  if (["integer", "decimal", "percent"].includes(type)) {
    if (typeof value !== "number" || !Number.isFinite(value)) {
      throw new StructuredQueryValidationError(
        PHASE3_ERROR_CODES.typeMismatch,
        "Numeric value is required."
      );
    }
    return;
  }

  if (typeof value !== "string") {
    throw new StructuredQueryValidationError(
      PHASE3_ERROR_CODES.typeMismatch,
      "String value is required."
    );
  }

  if (value.length > PUBLIC_INPUT_LIMITS.structuredQueryStringScalarChars) {
    throw new StructuredQueryValidationError(
      PHASE3_ERROR_CODES.limitExceeded,
      "String value exceeds the allowed limit."
    );
  }

  if ((type === "date" || type === "date_time") && Number.isNaN(Date.parse(value))) {
    throw new StructuredQueryValidationError(
      PHASE3_ERROR_CODES.typeMismatch,
      "Date value is invalid."
    );
  }
}

function buildProjection(
  query: NormalizedQuery,
  fields: Map<string, StructuredFieldRegistryEntry>,
  mode: StructuredQueryMode
): SqlFragment {
  if (mode === "aggregate") {
    const parts: string[] = [];
    const params: Array<string | number> = [];

    for (const fieldName of query.groupBy) {
      const field = requireField(fields, fieldName);
      parts.push(`${jsonValueExpression()} AS ${quoteIdentifier(field.canonicalName)}`);
      params.push(requireJsonPath(field));
    }

    for (const aggregate of query.aggregates) {
      const fragment = aggregateExpression(aggregate, fields);
      parts.push(fragment.sql);
      params.push(...fragment.params);
    }

    return { sql: parts.join(", "), params };
  }

  const storedFields = query.select.filter(
    (fieldName) => requireField(fields, fieldName).inputSource !== "dynamic_lookup"
  );
  const parts = storedFields.map((fieldName) => {
    const field = requireField(fields, fieldName);
    if (field.storage.column === "source_document_id") {
      return `r.source_document_id AS ${quoteIdentifier(field.canonicalName)}`;
    }
    return `${jsonValueExpression()} AS ${quoteIdentifier(field.canonicalName)}`;
  });
  const params = storedFields
    .map((fieldName) => requireField(fields, fieldName))
    .filter((field) => field.storage.column === "payload")
    .map((field) => requireJsonPath(field));

  if (
    query.select.some(
      (fieldName) => requireField(fields, fieldName).inputSource === "dynamic_lookup"
    )
  ) {
    parts.push(`${jsonValueExpression()} AS ${quoteIdentifier("structured_query_supplier_name")}`);
    params.push(requireJsonPath(requireField(fields, "supplier_name")));
  }

  return {
    sql: parts.join(", "),
    params
  };
}

function baseFromAndWhere(input: {
  registry: StructuredDatasetRegistry;
  employee: StructuredQueryEmployeeScope;
  orgId: string;
}): SqlFragment {
  const params: Array<string | number> = [
    input.orgId,
    input.orgId,
    input.orgId,
    input.registry.dataset,
    "applied",
    "structured",
    "active"
  ];
  const clauses = [
    "JOIN import_batches ib ON ib.id = r.import_batch_id",
    "JOIN documents d ON d.id = r.source_document_id",
    "WHERE r.org_id = ?",
    "AND ib.org_id = ?",
    "AND d.org_id = ?",
    "AND ib.dataset = ?",
    "AND ib.status = ?",
    "AND ib.archived_at IS NULL",
    "AND d.document_kind = ?",
    "AND d.status = ?",
    "AND d.archived_at IS NULL"
  ];

  clauses.push("AND d.confidentiality_level <= ?");
  params.push(input.employee.clearance);

  return {
    sql: clauses.join(" "),
    params
  };
}

function compileFilter(
  node: FilterNode,
  fields: Map<string, StructuredFieldRegistryEntry>
): SqlFragment {
  if ("and" in node) {
    const fragments = node.and.map((child) => compileFilter(child, fields));
    return joinFragments(fragments, "AND");
  }

  if ("or" in node) {
    const fragments = node.or.map((child) => compileFilter(child, fields));
    return joinFragments(fragments, "OR");
  }

  if ("not" in node) {
    const fragment = compileFilter(node.not, fields);
    return { sql: `NOT (${fragment.sql})`, params: fragment.params };
  }

  const field = requireField(fields, node.field);
  const expression = typedFieldExpression(field);

  switch (node.op) {
    case "eq":
      return {
        sql: `${expression} = ?`,
        params: [requireJsonPath(field), scalarParam(node.value)]
      };
    case "contains":
      return {
        sql: `${expression} LIKE ?`,
        params: [requireJsonPath(field), `%${String(node.value)}%`]
      };
    case "starts_with":
      return {
        sql: `${expression} LIKE ?`,
        params: [requireJsonPath(field), `${String(node.value)}%`]
      };
    case "between": {
      const values = node.value as ScalarValue[];
      const [start, end] = values as [ScalarValue, ScalarValue];
      return {
        sql: `${expression} BETWEEN ? AND ?`,
        params: [requireJsonPath(field), scalarParam(start), scalarParam(end)]
      };
    }
    case "in": {
      const values = node.value as ScalarValue[];
      return {
        sql: `${expression} IN (${values.map(() => "?").join(", ")})`,
        params: [requireJsonPath(field), ...values.map(scalarParam)]
      };
    }
    case "gt":
    case "gte":
    case "lt":
    case "lte": {
      const operators = { gt: ">", gte: ">=", lt: "<", lte: "<=" };
      return {
        sql: `${expression} ${operators[node.op]} ?`,
        params: [requireJsonPath(field), scalarParam(node.value)]
      };
    }
    default:
      throw new StructuredQueryValidationError(
        PHASE3_ERROR_CODES.unsupportedOperator,
        "Operator is not supported."
      );
  }
}

function buildOrderBy(
  query: NormalizedQuery,
  fields: Map<string, StructuredFieldRegistryEntry>,
  mode: StructuredQueryMode
): SqlFragment {
  if (mode === "aggregate") {
    const sort =
      query.sort.length > 0
        ? query.sort
        : query.groupBy.map((field) => ({ field, direction: "asc" as const }));
    if (sort.length === 0) {
      return { sql: "", params: [] };
    }

    return {
      sql: ` ORDER BY ${sort
        .map((item) => `${quoteIdentifier(item.field)} ${item.direction.toUpperCase()}`)
        .join(", ")}`,
      params: []
    };
  }

  const sort = query.sort.length > 0 ? query.sort : [];
  return {
    sql: ` ORDER BY ${[
      ...sort.map(
        (item) =>
          `${typedFieldExpression(requireField(fields, item.field))} ${item.direction.toUpperCase()}`
      ),
      "r.source_row_number ASC",
      "r.id ASC"
    ].join(", ")}`,
    params: sort.map((item) => requireJsonPath(requireField(fields, item.field)))
  };
}

function aggregateExpression(
  aggregate: AggregateSpec,
  fields: Map<string, StructuredFieldRegistryEntry>
): SqlFragment {
  const alias = quoteIdentifier(aggregateAlias(aggregate));

  if (aggregate.op === "count" && !aggregate.field) {
    return { sql: `COUNT(*) AS ${alias}`, params: [] };
  }

  const field = requireField(fields, aggregate.field ?? "");
  const expression = typedFieldExpression(field);

  switch (aggregate.op) {
    case "count":
      return { sql: `COUNT(${expression}) AS ${alias}`, params: [requireJsonPath(field)] };
    case "countDistinct":
      return { sql: `COUNT(DISTINCT ${expression}) AS ${alias}`, params: [requireJsonPath(field)] };
    case "sum":
      return { sql: `SUM(${expression}) AS ${alias}`, params: [requireJsonPath(field)] };
    case "avg":
      return { sql: `AVG(${expression}) AS ${alias}`, params: [requireJsonPath(field)] };
    case "min":
      return { sql: `MIN(${expression}) AS ${alias}`, params: [requireJsonPath(field)] };
    case "max":
      return { sql: `MAX(${expression}) AS ${alias}`, params: [requireJsonPath(field)] };
    case "weightedAvg": {
      const weightField = requireField(fields, aggregate.weightField);
      const weightExpression = typedFieldExpression(weightField);
      return {
        sql: `SUM(${expression} * ${weightExpression}) / NULLIF(SUM(${weightExpression}), 0) AS ${alias}`,
        params: [requireJsonPath(field), requireJsonPath(weightField), requireJsonPath(weightField)]
      };
    }
  }
}

function jsonValueExpression(): string {
  return `JSON_UNQUOTE(JSON_EXTRACT(r.payload, ?))`;
}

function typedFieldExpression(field: StructuredFieldRegistryEntry): string {
  const expression = jsonValueExpression();

  switch (field.type) {
    case "integer":
    case "decimal":
    case "percent":
      return `CAST(${expression} AS DECIMAL(20, 6))`;
    case "date":
      return `STR_TO_DATE(${expression}, '%Y-%m-%d')`;
    case "date_time":
      return `STR_TO_DATE(${expression}, '%Y-%m-%dT%H:%i:%s')`;
    case "string":
    case "time_range":
      return expression;
  }
}

function aggregateAlias(aggregate: AggregateSpec): string {
  return aggregate.as ?? (aggregate.field ? `${aggregate.op}_${aggregate.field}` : "count");
}

function joinFragments(fragments: SqlFragment[], operator: "AND" | "OR"): SqlFragment {
  return {
    sql: fragments.map((fragment) => `(${fragment.sql})`).join(` ${operator} `),
    params: fragments.flatMap((fragment) => fragment.params)
  };
}

function requireField(
  fields: Map<string, StructuredFieldRegistryEntry>,
  fieldName: string
): StructuredFieldRegistryEntry {
  const field = fields.get(fieldName);

  if (!field) {
    throw new StructuredQueryValidationError(
      PHASE3_ERROR_CODES.invalidField,
      "Field is not in the dataset registry.",
      { field: fieldName }
    );
  }

  return field;
}

function requireJsonPath(field: StructuredFieldRegistryEntry): string {
  if (!field.storage.jsonPath) {
    throw new StructuredQueryValidationError(
      PHASE3_ERROR_CODES.unsupportedCapability,
      "Field does not use JSON payload storage.",
      { field: field.canonicalName }
    );
  }

  return field.storage.jsonPath;
}

function hashQueryShape(query: unknown): string {
  return createHash("sha256").update(stableJson(query)).digest("hex");
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableJson).join(",")}]`;
  }

  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => `${JSON.stringify(key)}:${stableJson(child)}`)
      .join(",")}}`;
  }

  return JSON.stringify(value);
}

function signCursorPayload(payload: Omit<CursorPayload, "signature">, secret: string): string {
  return createHmac("sha256", secret).update(stableJson(payload)).digest("base64url");
}

function safeEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);

  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

function scalarParam(value: ScalarValue | ScalarValue[]): string | number {
  if (Array.isArray(value)) {
    throw new StructuredQueryValidationError(
      PHASE3_ERROR_CODES.typeMismatch,
      "Scalar value is required."
    );
  }

  if (typeof value === "boolean") {
    return value ? 1 : 0;
  }

  if (value === null) {
    return "null";
  }

  return value;
}

function quoteIdentifier(identifier: string): string {
  if (!isSafeAlias(identifier)) {
    throw new StructuredQueryValidationError(
      PHASE3_ERROR_CODES.invalidQuery,
      "Identifier is not allowed."
    );
  }

  return `\`${identifier}\``;
}

function isSafeAlias(value: string): boolean {
  return /^[a-z][a-z0-9_]{0,63}$/.test(value);
}
