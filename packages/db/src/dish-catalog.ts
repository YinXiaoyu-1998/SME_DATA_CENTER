import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { Prisma, type PrismaClient } from "@prisma/client";
import {
  boundedDishCatalogRowIndexes,
  DISH_CATALOG_ERROR_CODES,
  DishCatalogValidationError,
  isBusinessClearance,
  parseDishCatalogBatch,
  type DishCatalogRowInput,
  type ParsedDishCatalogBatch
} from "@smedc/domain";
import { ResourceAttributesError } from "./business-authorization.js";
import { categoriesInclude } from "./business-authorization-records.js";
import { requireCurrentUploadAdmin } from "./source-read-requirements.js";

type Tx = Prisma.TransactionClient;

/** One operator-initiated batch; requestId is recorded on the single audit row. */
export interface DishCatalogActor {
  orgId: string;
  id: string;
  requestId?: string;
}

/** Batch counters; rows.length === created + updated + unchanged. */
export interface DishCatalogWriteResult {
  received: number;
  created: number;
  updated: number;
  unchanged: number;
  removed: number;
}

export interface DishCatalogRepository {
  upsert(actor: DishCatalogActor, input: unknown): Promise<DishCatalogWriteResult>;
}

export class DishCatalogRepositoryError extends Error {
  constructor(
    readonly code: string,
    readonly details: { rowIndexes?: number[]; index?: number } = {}
  ) {
    super(code);
    this.name = "DishCatalogRepositoryError";
  }
}

/** One concurrent insert can win the unique SKU key after our FOR UPDATE found nothing. */
function isUniqueSkuConflict(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002";
}

/** Canonical snake_case payload; omitted optional fields are stored as explicit nulls. */
function catalogPayload(row: DishCatalogRowInput): Prisma.InputJsonValue {
  return {
    spu_id: row.spuId,
    sku_id: row.skuId,
    dish_name: row.dishName,
    brand_name: row.brandName,
    base_category_name: row.baseCategoryName,
    level_1_category_code: row.level1CategoryCode,
    level_2_category_code: row.level2CategoryCode,
    specification_name: row.specificationName,
    sale_price: row.salePrice,
    dish_alias: row.dishAlias
  };
}

function catalogResourceKey(enterpriseKey: string): string {
  return `dish-catalog:${enterpriseKey}`;
}

/** Use the same collation as the unique SKU key, including its trailing-space rules. */
async function validateStoredSkuIdentity(tx: Tx, batch: ParsedDishCatalogBatch) {
  const rowCount = batch.rows.length;
  const skuIds = [...batch.rows.map(({ skuId }) => skuId), ...batch.removeSkuIds];
  if (skuIds.length < 2) return;

  const collisions = await tx.$queryRaw<
    Array<{ position: number; writes: bigint; removals: bigint }>
  >`
    WITH request_skus AS (
      SELECT position, CONVERT(sku USING utf8mb4) COLLATE utf8mb4_unicode_ci AS sku
      FROM JSON_TABLE(${JSON.stringify(skuIds)}, '$[*]' COLUMNS (
        position FOR ORDINALITY, sku VARCHAR(128) PATH '$'
      )) AS request_items
    ), counts AS (
      SELECT position,
        COUNT(CASE WHEN position <= ${rowCount} THEN 1 END) OVER (PARTITION BY sku) AS writes,
        COUNT(CASE WHEN position > ${rowCount} THEN 1 END) OVER (PARTITION BY sku) AS removals
      FROM request_skus
    )
    SELECT position, writes, removals FROM counts WHERE writes + removals > 1
  `;
  const duplicateRows = [];
  const conflictingRows = [];
  const duplicateRemovals = [];
  for (const { position, writes, removals } of collisions) {
    const index = Number(position) - 1;
    if (index < rowCount) {
      if (Number(writes) > 1) duplicateRows.push(index);
      if (Number(removals) > 0) conflictingRows.push(index);
    } else if (Number(removals) > 1) duplicateRemovals.push(index - rowCount);
  }
  if (duplicateRemovals.length)
    throw new DishCatalogValidationError(
      DISH_CATALOG_ERROR_CODES.invalidInput,
      "Remove SKU IDs must be unique within a dish catalog batch.",
      { field: "removeSkuIds", rowIndexes: boundedDishCatalogRowIndexes(duplicateRemovals) }
    );
  if (duplicateRows.length)
    throw new DishCatalogValidationError(
      DISH_CATALOG_ERROR_CODES.duplicateSku,
      "SKU IDs must be unique within a dish catalog batch.",
      { field: "skuId", rowIndexes: boundedDishCatalogRowIndexes(duplicateRows) }
    );
  if (conflictingRows.length)
    throw new DishCatalogValidationError(
      DISH_CATALOG_ERROR_CODES.skuConflict,
      "A SKU cannot be written and removed in the same dish catalog batch.",
      { field: "skuId", rowIndexes: boundedDishCatalogRowIndexes(conflictingRows) }
    );
}

/** Idempotent per-enterprise catalog resource and its single group scope. */
async function persistCatalogResource(
  tx: Tx,
  orgId: string,
  enterpriseKey: string,
  categoryId: string
) {
  const resourceKey = catalogResourceKey(enterpriseKey);
  const where = {
    orgId_kind_resourceKey: { orgId, kind: "structured" as const, resourceKey }
  };
  const existing = await tx.businessResource.findUnique({
    where,
    include: { scopes: { include: { dimensions: true } } }
  });
  if (
    existing &&
    (existing.categoryId !== categoryId ||
      existing.documentId !== null ||
      existing.sourceDocumentId !== null ||
      existing.scopes.length !== 1 ||
      existing.scopes[0]!.ownership !== "group" ||
      existing.scopes[0]!.enterpriseKey !== enterpriseKey ||
      existing.scopes[0]!.storeName !== null ||
      existing.scopes[0]!.dimensions.length !== 0)
  )
    throw new DishCatalogRepositoryError("RESOURCE_IDENTITY_IMMUTABLE");
  if (existing) {
    await tx.businessResource.update({
      where,
      data: {
        valid: true,
        ...(!existing.valid ? { authorizationVersion: { increment: 1 } } : {}),
        contentVersion: { increment: 1 }
      }
    });
    return;
  }

  await tx.businessResource.create({
    data: {
      orgId,
      id: randomUUID().replaceAll("-", ""),
      kind: "structured",
      resourceKey,
      categoryId,
      valid: true,
      scopes: {
        create: {
          id: randomUUID().replaceAll("-", ""),
          enterpriseKey,
          ownership: "group",
          storeName: null
        }
      }
    }
  });
}

export function createPrismaDishCatalogRepository({
  prisma
}: {
  prisma: PrismaClient;
}): DishCatalogRepository {
  return {
    async upsert(actor, input) {
      // Re-validate at the persistence boundary so HTTP and MCP share one batch contract.
      const parsed = parseDishCatalogBatch(input);
      return prisma.$transaction(
        async (tx) => {
          // Serialize with permission changes without mutating the version on an unchanged replay.
          const [state] = await tx.$queryRaw<Array<{ mode: string }>>`
            SELECT mode FROM business_authorization_states WHERE org_id = ${actor.orgId} FOR UPDATE
          `;
          await tx.$queryRaw(
            Prisma.sql`SELECT id FROM employees WHERE org_id = ${actor.orgId} AND id = ${actor.id} FOR SHARE`
          );
          try {
            await requireCurrentUploadAdmin(tx, actor.orgId, actor.id);
          } catch (error) {
            if (error instanceof ResourceAttributesError && error.code === "UPLOAD_ADMIN_REQUIRED")
              throw new DishCatalogRepositoryError(error.code);
            throw error;
          }
          if (state?.mode !== "enabled")
            throw new DishCatalogRepositoryError("AUTHORIZATION_NOT_ENABLED");
          const category = await tx.businessCategory.findUnique({
            where: { orgId_key: { orgId: actor.orgId, key: "dish_catalog" } },
            include: categoriesInclude
          });
          if (
            !category ||
            !isBusinessClearance(category.confidentialityLevel) ||
            category.retired ||
            category.dimensions.length
          )
            throw new DishCatalogRepositoryError("RESOURCE_CATEGORY_NOT_CONFIGURED");

          const [enterprise] = await tx.$queryRaw<Array<{ enterpriseKey: string }>>`
            SELECT enterprise_key AS enterpriseKey FROM business_enterprise_identities
            WHERE org_id = ${actor.orgId} AND CAST(enterprise_name AS BINARY) = CAST(${parsed.enterpriseName} AS BINARY)
            FOR UPDATE
          `;
          if (!enterprise)
            throw new DishCatalogRepositoryError("DISH_CATALOG_ENTERPRISE_NOT_AVAILABLE");
          const { enterpriseKey } = enterprise;
          await validateStoredSkuIdentity(tx, parsed);

          // Resolve every department name once, exactly and only among current departments.
          // Comparisons use the column collation (utf8mb4_unicode_ci) so case/accent variants
          // resolve to the same department ID, and each row reports the submitted name so the
          // mapping back to the request never depends on a stored or JS-normalized string.
          const departmentNames = [
            ...new Set(
              parsed.rows
                .map((row) => row.departmentName)
                .filter((name): name is string => name !== null)
            )
          ];
          const departmentIdsByName = new Map<string, string[]>();
          if (departmentNames.length) {
            const lookups = departmentNames.map(
              (name) =>
                Prisma.sql`SELECT ${name} AS requested_name, department_id
                            FROM business_departments
                           WHERE org_id = ${actor.orgId}
                             AND enterprise_key = ${enterpriseKey}
                             AND retired = FALSE
                             AND name = ${name}`
            );
            const departments = await tx.$queryRaw<
              Array<{ requested_name: string; department_id: string }>
            >(Prisma.sql`${Prisma.join(lookups, " UNION ALL ")}`);
            for (const department of departments) {
              const ids = departmentIdsByName.get(department.requested_name) ?? [];
              ids.push(department.department_id);
              departmentIdsByName.set(department.requested_name, ids);
            }
          }
          const missing: number[] = [];
          const ambiguous: number[] = [];
          const departmentIds = parsed.rows.map((row, index) => {
            if (row.departmentName === null) return null;
            const ids = departmentIdsByName.get(row.departmentName) ?? [];
            if (ids.length === 0) missing.push(index);
            else if (ids.length > 1) ambiguous.push(index);
            return ids[0] ?? null;
          });
          if (missing.length)
            throw new DishCatalogRepositoryError("DISH_CATALOG_DEPARTMENT_NOT_FOUND", {
              rowIndexes: boundedDishCatalogRowIndexes(missing)
            });
          if (ambiguous.length)
            throw new DishCatalogRepositoryError("DISH_CATALOG_DEPARTMENT_AMBIGUOUS", {
              rowIndexes: boundedDishCatalogRowIndexes(ambiguous)
            });

          // Read existing rows through the column collation, keyed by the submitted SKU so a
          // case/accent variant maps to the stored row instead of a second insert.
          const skuIds = parsed.rows.map((row) => row.skuId);
          const existingRows = skuIds.length
            ? await tx.$queryRaw<
                Array<{
                  requested_sku_id: string;
                  id: string;
                  department_id: string | null;
                  payload: string | null;
                }>
              >(
                Prisma.sql`${Prisma.join(
                  skuIds.map(
                    (skuId) =>
                      Prisma.sql`SELECT ${skuId} AS requested_sku_id, id, department_id,
                                        CAST(payload AS CHAR CHARACTER SET utf8mb4) AS payload
                                   FROM dish_catalog_entries
                                  WHERE org_id = ${actor.orgId}
                                    AND enterprise_key = ${enterpriseKey}
                                    AND sku_id = ${skuId}`
                  ),
                  " UNION ALL "
                )} FOR UPDATE`
              )
            : [];
          const existingBySku = new Map(existingRows.map((row) => [row.requested_sku_id, row]));

          const result: DishCatalogWriteResult = {
            received: parsed.rows.length + parsed.removeSkuIds.length,
            created: 0,
            updated: 0,
            unchanged: 0,
            removed: 0
          };
          const now = new Date();
          for (const [index, row] of parsed.rows.entries()) {
            const desired = catalogPayload(row);
            const departmentId = departmentIds[index] ?? null;
            const existing = existingBySku.get(row.skuId);
            if (existing) {
              if (
                existing.department_id === departmentId &&
                isDeepStrictEqual(
                  existing.payload === null ? null : JSON.parse(existing.payload),
                  desired
                )
              ) {
                result.unchanged++;
                continue;
              }
              await tx.dishCatalogEntry.update({
                where: { id: existing.id },
                data: { skuId: row.skuId, departmentId, payload: desired, updatedAt: now }
              });
              result.updated++;
              continue;
            }
            const id = randomUUID().replaceAll("-", "");
            try {
              await tx.dishCatalogEntry.create({
                data: {
                  id,
                  orgId: actor.orgId,
                  enterpriseKey,
                  skuId: row.skuId,
                  departmentId,
                  payload: desired,
                  createdAt: now,
                  updatedAt: now
                }
              });
              result.created++;
            } catch (error) {
              if (!isUniqueSkuConflict(error)) throw error;
              // FOR UPDATE cannot lock a row that does not exist yet: a concurrent batch can
              // insert the same SKU between our read and this create. Its insert has committed
              // by the time InnoDB reports the duplicate, so converge to the update path
              // (last write wins) instead of surfacing a 500.
              const conflicted = await tx.dishCatalogEntry.findFirst({
                where: { orgId: actor.orgId, enterpriseKey, skuId: row.skuId }
              });
              if (!conflicted) throw error;
              if (
                conflicted.departmentId === departmentId &&
                isDeepStrictEqual(conflicted.payload, desired)
              ) {
                result.unchanged++;
                continue;
              }
              await tx.dishCatalogEntry.update({
                where: { id: conflicted.id },
                data: { skuId: row.skuId, departmentId, payload: desired, updatedAt: now }
              });
              result.updated++;
            }
          }

          if (parsed.removeSkuIds.length) {
            const removed = await tx.dishCatalogEntry.deleteMany({
              where: { orgId: actor.orgId, enterpriseKey, skuId: { in: parsed.removeSkuIds } }
            });
            result.removed = removed.count;
          }

          if (result.created + result.updated + result.removed > 0) {
            await persistCatalogResource(tx, actor.orgId, enterpriseKey, category.id);
            await tx.businessAuthorizationState.update({
              where: { orgId: actor.orgId },
              data: { version: { increment: 1 } }
            });
          }

          await tx.auditLog.create({
            data: {
              orgId: actor.orgId,
              actorUserAccountId: actor.id,
              action: "dish_catalog.upsert",
              targetType: "dish_catalog",
              targetId: enterpriseKey,
              result: "succeeded",
              ...(actor.requestId === undefined ? {} : { requestId: actor.requestId }),
              metadata: {
                enterpriseName: parsed.enterpriseName,
                enterpriseKey,
                received: result.received,
                created: result.created,
                updated: result.updated,
                unchanged: result.unchanged,
                removed: result.removed,
                ...(parsed.sourceFileName === undefined
                  ? {}
                  : { sourceFileName: parsed.sourceFileName })
              }
            }
          });
          return result;
        },
        { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted, timeout: 120000 }
      );
    }
  };
}
