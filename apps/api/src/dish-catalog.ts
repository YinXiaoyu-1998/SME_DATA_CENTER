import {
  DishCatalogValidationError,
  boundedDishCatalogRowIndexes,
  parseDishCatalogBatch
} from "@smedc/domain";
import {
  DishCatalogRepositoryError,
  type DishCatalogRepository,
  type DishCatalogWriteResult
} from "@smedc/db";

/** Whole-request UTF-8 JSON cap; the transport rejects larger bodies before parsing. */
export const DISH_CATALOG_BATCH_BYTES = 16 * 1024 * 1024;

/** Fixed public row/batch field names; caller text is never echoed back as a field name. */
const DISH_CATALOG_FIELDS = new Set([
  "enterpriseName",
  "rows",
  "removeSkuIds",
  "sourceFileName",
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

const BAD_REQUEST_REPOSITORY_CODES = new Set([
  "DISH_CATALOG_DEPARTMENT_NOT_FOUND",
  "DISH_CATALOG_DEPARTMENT_AMBIGUOUS",
  "DISH_CATALOG_ENTERPRISE_NOT_AVAILABLE"
]);

const FORBIDDEN_REPOSITORY_CODES = new Set([
  "UPLOAD_ADMIN_REQUIRED",
  "AUTHORIZATION_NOT_ENABLED",
  "RESOURCE_CATEGORY_NOT_CONFIGURED"
]);

export interface DishCatalogPublicDetails {
  field?: string;
  rowIndexes?: number[];
  [key: string]: unknown;
}

/** Public HTTP status, code and bounded details for one failed dish catalog write. */
export class DishCatalogRequestError extends Error {
  constructor(
    readonly statusCode: 400 | 403,
    readonly code: string,
    message: string,
    readonly details: DishCatalogPublicDetails = {}
  ) {
    super(message);
    this.name = "DishCatalogRequestError";
  }
}

function publicDetails(details: {
  field?: string;
  rowIndexes?: number[];
}): DishCatalogPublicDetails {
  const rowIndexes = boundedDishCatalogRowIndexes(details.rowIndexes ?? []);
  return {
    ...(details.field !== undefined && DISH_CATALOG_FIELDS.has(details.field)
      ? { field: details.field }
      : {}),
    ...(rowIndexes.length ? { rowIndexes } : {})
  };
}

function forbiddenMessage(code: string): string {
  if (code === "UPLOAD_ADMIN_REQUIRED") return "A current active administrator is required.";
  if (code === "AUTHORIZATION_NOT_ENABLED") return "Business authorization is not enabled.";
  return "The dish catalog category is not configured.";
}

function badRequestMessage(code: string): string {
  if (code === "DISH_CATALOG_DEPARTMENT_NOT_FOUND")
    return "A department name does not match an active department of this enterprise.";
  if (code === "DISH_CATALOG_DEPARTMENT_AMBIGUOUS")
    return "A department name is ambiguous; fix the department directory before writing.";
  return "The enterprise is not available to this organization.";
}

/** Translate a recognized domain/repository failure; unknown failures stay internal. */
function publicDishCatalogError(error: unknown): DishCatalogRequestError | undefined {
  if (error instanceof DishCatalogValidationError)
    return new DishCatalogRequestError(
      400,
      error.code,
      "Invalid dish catalog input.",
      publicDetails(error.details)
    );

  if (error instanceof DishCatalogRepositoryError) {
    if (FORBIDDEN_REPOSITORY_CODES.has(error.code))
      return new DishCatalogRequestError(
        403,
        error.code,
        forbiddenMessage(error.code),
        publicDetails(error.details)
      );
    if (BAD_REQUEST_REPOSITORY_CODES.has(error.code))
      return new DishCatalogRequestError(
        400,
        error.code,
        badRequestMessage(error.code),
        publicDetails(error.details)
      );
  }

  return undefined;
}

export function createDishCatalogService({ repository }: { repository: DishCatalogRepository }) {
  return {
    async upsert({
      auth,
      input,
      requestId
    }: {
      auth: { id: string; orgId: string };
      input: unknown;
      requestId?: string;
    }): Promise<DishCatalogWriteResult> {
      try {
        const batch = parseDishCatalogBatch(input);
        return await repository.upsert(
          {
            id: auth.id,
            orgId: auth.orgId,
            ...(requestId === undefined ? {} : { requestId })
          },
          batch
        );
      } catch (error) {
        const publicError = publicDishCatalogError(error);
        if (publicError) throw publicError;
        // Unknown failures keep the global 500 handler so they are logged once.
        throw error;
      }
    }
  };
}
export type DishCatalogService = ReturnType<typeof createDishCatalogService>;
