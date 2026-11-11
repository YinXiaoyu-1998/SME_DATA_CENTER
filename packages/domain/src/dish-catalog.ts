import { PUBLIC_INPUT_LIMITS } from "./input-boundaries.js";

export const DISH_CATALOG_LIMITS = Object.freeze({
  enterpriseNameChars: PUBLIC_INPUT_LIMITS.enterpriseNameChars,
  maxBatchEntries: 1000,
  maxRowIndexes: 50,
  spuIdChars: 128,
  skuIdChars: 128,
  dishNameChars: 512,
  brandNameChars: 255,
  baseCategoryNameChars: 255,
  level1CategoryCodeChars: 128,
  level2CategoryCodeChars: 128,
  specificationNameChars: 255,
  salePriceChars: 21,
  dishAliasChars: 512,
  departmentNameChars: 255,
  sourceFileNameChars: 255
});

export const DISH_CATALOG_ERROR_CODES = Object.freeze({
  invalidInput: "DISH_CATALOG_INVALID_INPUT",
  duplicateSku: "DISH_CATALOG_DUPLICATE_SKU",
  skuConflict: "DISH_CATALOG_SKU_CONFLICT",
  batchTooLarge: "DISH_CATALOG_BATCH_TOO_LARGE"
});

export type DishCatalogErrorCode =
  (typeof DISH_CATALOG_ERROR_CODES)[keyof typeof DISH_CATALOG_ERROR_CODES];

export interface DishCatalogValidationDetails {
  field?: string;
  rowIndexes?: number[];
}

export class DishCatalogValidationError extends Error {
  readonly code: DishCatalogErrorCode;
  readonly details: DishCatalogValidationDetails;

  constructor(
    code: DishCatalogErrorCode,
    message: string,
    details: DishCatalogValidationDetails = {}
  ) {
    super(message);
    this.name = "DishCatalogValidationError";
    this.code = code;
    this.details = { rowIndexes: [], ...details };
  }
}

export interface DishCatalogRowInput {
  spuId: string;
  skuId: string;
  dishName: string;
  brandName: string;
  baseCategoryName: string;
  level1CategoryCode: string;
  level2CategoryCode: string | null;
  specificationName: string | null;
  salePrice: string;
  dishAlias: string | null;
  departmentName: string | null;
}

export interface ParsedDishCatalogBatch {
  enterpriseName: string;
  rows: DishCatalogRowInput[];
  removeSkuIds: string[];
  sourceFileName?: string;
}

const BATCH_KEYS = new Set(["enterpriseName", "rows", "removeSkuIds", "sourceFileName"]);
const ROW_KEYS = new Set([
  "spuId",
  "skuId",
  "dishName",
  "brandName",
  "baseCategoryName",
  "level1CategoryCode",
  "level2CategoryCode",
  "specificationName",
  "salePrice",
  "dishAlias",
  "departmentName"
]);
const SALE_PRICE_PATTERN = /^(\d{1,14})(?:\.(\d{1,6}))?$/;

export function normalizeDishCatalogSalePrice(value: unknown): string {
  if (typeof value !== "string") {
    throw invalid("salePrice", "Sale price must be a decimal string.");
  }

  const match = SALE_PRICE_PATTERN.exec(value);
  if (!match) {
    throw invalid("salePrice", "Sale price must be a decimal string.");
  }

  const whole = match[1]!.replace(/^0+(?=\d)/, "");
  const fraction = (match[2] ?? "").replace(/0+$/, "");

  return fraction ? `${whole}.${fraction}` : whole;
}

export function parseDishCatalogBatch(value: unknown): ParsedDishCatalogBatch {
  const object = requireObject(value, BATCH_KEYS);
  const enterpriseName = requireText(
    object["enterpriseName"],
    "enterpriseName",
    DISH_CATALOG_LIMITS.enterpriseNameChars,
    false
  );
  const sourceFileName =
    object["sourceFileName"] === undefined
      ? undefined
      : requireText(
          object["sourceFileName"],
          "sourceFileName",
          DISH_CATALOG_LIMITS.sourceFileNameChars,
          true
        );
  const rawRows = object["rows"] ?? [];
  const rawRemoveSkuIds = object["removeSkuIds"] ?? [];

  if (!Array.isArray(rawRows)) throw invalid("rows", "rows must be an array.");
  if (!Array.isArray(rawRemoveSkuIds))
    throw invalid("removeSkuIds", "removeSkuIds must be an array.");

  const received = rawRows.length + rawRemoveSkuIds.length;
  if (received === 0) {
    throw invalid("rows", "A dish catalog batch requires at least one entry.");
  }
  if (received > DISH_CATALOG_LIMITS.maxBatchEntries) {
    throw new DishCatalogValidationError(
      DISH_CATALOG_ERROR_CODES.batchTooLarge,
      "A dish catalog batch may contain at most 1000 entries."
    );
  }

  const removeSkuIds = parseRemoveSkuIds(rawRemoveSkuIds);
  const rows: DishCatalogRowInput[] = [];
  const invalidRowIndexes: number[] = [];
  let firstInvalidField: string | undefined;

  for (const [index, rawRow] of rawRows.entries()) {
    try {
      rows.push(parseRow(rawRow));
    } catch (error) {
      if (!(error instanceof DishCatalogValidationError)) throw error;
      invalidRowIndexes.push(index);
      firstInvalidField ??= error.details.field;
    }
  }

  if (invalidRowIndexes.length > 0) {
    throw new DishCatalogValidationError(
      DISH_CATALOG_ERROR_CODES.invalidInput,
      "Dish catalog rows are invalid.",
      { field: firstInvalidField, rowIndexes: boundedIndexes(invalidRowIndexes) }
    );
  }

  const skuIndexes = new Map<string, number[]>();
  for (const [index, row] of rows.entries()) {
    const indexes = skuIndexes.get(row.skuId);
    if (indexes) indexes.push(index);
    else skuIndexes.set(row.skuId, [index]);
  }

  const duplicateIndexes = [...skuIndexes.values()].filter((indexes) => indexes.length > 1).flat();
  if (duplicateIndexes.length > 0) {
    throw new DishCatalogValidationError(
      DISH_CATALOG_ERROR_CODES.duplicateSku,
      "SKU IDs must be unique within a dish catalog batch.",
      { field: "skuId", rowIndexes: boundedIndexes(duplicateIndexes) }
    );
  }

  const removedSkuIds = new Set(removeSkuIds);
  const conflictIndexes = rows
    .map((row, index) => (removedSkuIds.has(row.skuId) ? index : -1))
    .filter((index) => index >= 0);
  if (conflictIndexes.length > 0) {
    throw new DishCatalogValidationError(
      DISH_CATALOG_ERROR_CODES.skuConflict,
      "A SKU cannot be written and removed in the same dish catalog batch.",
      { field: "skuId", rowIndexes: boundedIndexes(conflictIndexes) }
    );
  }

  return {
    enterpriseName,
    rows,
    removeSkuIds,
    ...(sourceFileName === undefined ? {} : { sourceFileName })
  };
}

function parseRemoveSkuIds(values: unknown[]): string[] {
  const result: string[] = [];
  const seen = new Map<string, number[]>();

  for (const [index, value] of values.entries()) {
    try {
      const skuId = requireText(value, "removeSkuIds", DISH_CATALOG_LIMITS.skuIdChars, false);
      const indexes = seen.get(skuId);
      if (indexes) indexes.push(index);
      else seen.set(skuId, [index]);
      result.push(skuId);
    } catch (error) {
      if (!(error instanceof DishCatalogValidationError)) throw error;
      throw new DishCatalogValidationError(
        DISH_CATALOG_ERROR_CODES.invalidInput,
        "Remove SKU IDs are invalid.",
        { field: "removeSkuIds", rowIndexes: [index] }
      );
    }
  }

  const duplicateIndexes = [...seen.values()].filter((indexes) => indexes.length > 1).flat();
  if (duplicateIndexes.length > 0) {
    throw new DishCatalogValidationError(
      DISH_CATALOG_ERROR_CODES.invalidInput,
      "Remove SKU IDs must be unique within a dish catalog batch.",
      { field: "removeSkuIds", rowIndexes: boundedIndexes(duplicateIndexes) }
    );
  }

  return result;
}

function parseRow(value: unknown): DishCatalogRowInput {
  const object = requireObject(value, ROW_KEYS);

  return {
    spuId: requireText(object["spuId"], "spuId", DISH_CATALOG_LIMITS.spuIdChars, false),
    skuId: requireText(object["skuId"], "skuId", DISH_CATALOG_LIMITS.skuIdChars, false),
    dishName: requireText(object["dishName"], "dishName", DISH_CATALOG_LIMITS.dishNameChars, false),
    brandName: requireText(
      object["brandName"],
      "brandName",
      DISH_CATALOG_LIMITS.brandNameChars,
      false
    ),
    baseCategoryName: requireText(
      object["baseCategoryName"],
      "baseCategoryName",
      DISH_CATALOG_LIMITS.baseCategoryNameChars,
      false
    ),
    level1CategoryCode: requireText(
      object["level1CategoryCode"],
      "level1CategoryCode",
      DISH_CATALOG_LIMITS.level1CategoryCodeChars,
      false
    ),
    level2CategoryCode: optionalText(
      object["level2CategoryCode"],
      "level2CategoryCode",
      DISH_CATALOG_LIMITS.level2CategoryCodeChars
    ),
    specificationName: optionalText(
      object["specificationName"],
      "specificationName",
      DISH_CATALOG_LIMITS.specificationNameChars
    ),
    salePrice: normalizeDishCatalogSalePrice(object["salePrice"]),
    dishAlias: optionalText(object["dishAlias"], "dishAlias", DISH_CATALOG_LIMITS.dishAliasChars),
    departmentName: optionalText(
      object["departmentName"],
      "departmentName",
      DISH_CATALOG_LIMITS.departmentNameChars
    )
  };
}

function requireObject(value: unknown, allowedKeys: Set<string>): Record<string, unknown> {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value))
  ) {
    throw invalid("", "Expected an object.");
  }

  const object = value as Record<string, unknown>;
  for (const key of Object.keys(object)) {
    if (!allowedKeys.has(key)) throw invalid(key, "Unknown field.");
  }

  return object;
}

function requireText(value: unknown, field: string, max: number, allowEmpty: boolean): string {
  if (typeof value !== "string" || (!allowEmpty && value.length === 0) || !textFits(value, max)) {
    throw invalid(field, "Invalid string field.");
  }

  return value;
}

function optionalText(value: unknown, field: string, max: number): string | null {
  if (value === undefined || value === null) return null;
  return requireText(value, field, max, true);
}

/** Count Unicode characters without normalizing or trimming the business value. */
function textFits(value: string, max: number): boolean {
  const characters = Array.from(value);
  return (
    characters.length <= max &&
    characters.every((character) => character.length !== 1 || !/[\uD800-\uDFFF]/u.test(character))
  );
}

function boundedIndexes(indexes: number[]): number[] {
  return [...new Set(indexes)]
    .sort((left, right) => left - right)
    .slice(0, DISH_CATALOG_LIMITS.maxRowIndexes);
}

function invalid(field: string, message: string): DishCatalogValidationError {
  return new DishCatalogValidationError(DISH_CATALOG_ERROR_CODES.invalidInput, message, {
    field,
    rowIndexes: []
  });
}
