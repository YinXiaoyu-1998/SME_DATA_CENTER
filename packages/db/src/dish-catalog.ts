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
  type DishComboReplacement
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

/** Each row and each explicit composition is one write operation in these counters. */
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

/** Canonical snake_case payload; omitted optional fields are stored as explicit nulls. */
function catalogPayload(row: DishCatalogRowInput) {
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

function invalidReference(index?: number) {
  return new DishCatalogRepositoryError(
    "DISH_CATALOG_INVALID_REFERENCE",
    index === undefined ? {} : { rowIndexes: [index] }
  );
}

async function replaceCompositions(
  tx: Tx,
  scope: { orgId: string; enterpriseKey: string },
  replacements: DishComboReplacement[],
  result: DishCatalogWriteResult,
  now: Date
) {
  // Mark every submitted parent before checking children, so order within a batch is irrelevant.
  const parents = await tx.dishCatalogEntry.findMany({
    where: { ...scope, skuId: { in: replacements.map((item) => item.skuId) } },
    select: { id: true, skuId: true, dishType: true, comboComposition: true }
  });
  const indexed = new Map(parents.map((row) => [row.skuId, row]));
  const edges = [];
  for (const [index, { skuId, composition }] of replacements.entries()) {
    const parent = indexed.get(skuId);
    if (!parent) throw invalidReference(index);
    if (parent.dishType === "combo" && isDeepStrictEqual(parent.comboComposition, composition)) {
      result.unchanged++;
      continue;
    }
    await tx.dishCatalogEntry.update({
      where: { id: parent.id },
      data: { dishType: "combo", comboComposition: composition, updatedAt: now }
    });
    await tx.dishComboReference.deleteMany({ where: { ...scope, parentSku: skuId } });
    const children = new Set(
      composition.groups.flatMap((group) => group.items.map((item) => item.skuId))
    );
    for (const childSku of children) edges.push({ ...scope, parentSku: skuId, childSku, index });
    result.updated++;
  }
  if (edges.length) {
    const children = await tx.dishCatalogEntry.findMany({
      where: {
        ...scope,
        dishType: "single",
        skuId: { in: [...new Set(edges.map((edge) => edge.childSku))] }
      },
      select: { skuId: true }
    });
    const known = new Set(children.map((row) => row.skuId));
    for (const edge of edges) if (!known.has(edge.childSku)) throw invalidReference(edge.index);
    await tx.dishComboReference.createMany({
      data: edges.map(({ orgId, enterpriseKey, parentSku, childSku }) => ({
        orgId,
        enterpriseKey,
        parentSku,
        childSku
      }))
    });
  }
}

function catalogResourceKey(enterpriseKey: string): string {
  return `dish-catalog:${enterpriseKey}`;
}

/** Use the same collation as the unique SKU key, including its trailing-space rules. */
async function validateStoredSkuIdentity(
  tx: Tx,
  writes: readonly { skuId: string }[],
  removals: readonly string[]
) {
  const rowCount = writes.length;
  const skuIds = [...writes.map(({ skuId }) => skuId), ...removals];
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
          await validateStoredSkuIdentity(tx, parsed.rows, parsed.removeSkuIds);

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
                  sku_id: string;
                  dish_type: string | null;
                  department_id: string | null;
                  payload: string | null;
                }>
              >(
                Prisma.sql`${Prisma.join(
                  skuIds.map(
                    (skuId) =>
                      Prisma.sql`SELECT ${skuId} AS requested_sku_id, id, sku_id, dish_type, department_id,
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
            received:
              parsed.rows.length + parsed.removeSkuIds.length + (parsed.compositions?.length ?? 0),
            created: 0,
            updated: 0,
            unchanged: 0,
            removed: 0
          };
          const now = new Date();
          for (const [index, row] of parsed.rows.entries()) {
            const desired = catalogPayload(row);
            const existing = existingBySku.get(row.skuId);
            const savedPayload = existing?.payload ? JSON.parse(existing.payload) : null;
            const departmentId =
              parsed.preserveManualFields && existing
                ? existing.department_id
                : (departmentIds[index] ?? null);
            if (parsed.preserveManualFields && existing)
              desired.dish_alias = savedPayload?.dish_alias ?? null;
            const dishType = parsed.preserveManualFields
              ? (existing?.dish_type ?? row.dishType ?? null)
              : (row.dishType ?? existing?.dish_type ?? null);
            if (
              existing &&
              existing.sku_id !== row.skuId &&
              (await tx.dishComboReference.count({
                where: {
                  orgId: actor.orgId,
                  enterpriseKey,
                  OR: [{ childSku: existing.sku_id }, { parentSku: existing.sku_id }]
                }
              }))
            )
              throw invalidReference(index);
            if (existing) {
              if (
                existing.dish_type === dishType &&
                existing.department_id === departmentId &&
                isDeepStrictEqual(savedPayload, desired)
              ) {
                result.unchanged++;
                continue;
              }
              await tx.dishCatalogEntry.update({
                where: { id: existing.id },
                data: {
                  skuId: row.skuId,
                  departmentId,
                  dishType,
                  ...(dishType === "single" ? { comboComposition: Prisma.DbNull } : {}),
                  payload: desired,
                  updatedAt: now
                }
              });
              if (dishType === "single" && existing.dish_type === "combo")
                await tx.dishComboReference.deleteMany({
                  where: { orgId: actor.orgId, enterpriseKey, parentSku: row.skuId }
                });
              result.updated++;
              continue;
            }
            const id = randomUUID().replaceAll("-", "");
            await tx.dishCatalogEntry.create({
              data: {
                id,
                orgId: actor.orgId,
                enterpriseKey,
                skuId: row.skuId,
                departmentId,
                dishType,
                payload: desired,
                createdAt: now,
                updatedAt: now
              }
            });
            result.created++;
          }

          const scope = { orgId: actor.orgId, enterpriseKey };
          if (parsed.compositions?.length) {
            const replacements = parsed.compositions;
            // SQL collation can equate two identifiers JS considers distinct.
            await validateStoredSkuIdentity(tx, replacements, parsed.removeSkuIds);
            await replaceCompositions(tx, scope, replacements, result, now);
          }

          if (parsed.removeSkuIds.length) {
            await tx.dishComboReference.deleteMany({
              where: { ...scope, parentSku: { in: parsed.removeSkuIds } }
            });
            if (
              await tx.dishComboReference.count({
                where: { ...scope, childSku: { in: parsed.removeSkuIds } }
              })
            )
              throw invalidReference();
            const removed = await tx.dishCatalogEntry.deleteMany({
              where: { orgId: actor.orgId, enterpriseKey, skuId: { in: parsed.removeSkuIds } }
            });
            result.removed = removed.count;
          }

          const markedCombos = [
            ...parsed.rows.filter((row) => row.dishType === "combo").map((row) => row.skuId),
            ...(parsed.compositions ?? []).map((item) => item.skuId)
          ];
          if (
            markedCombos.length &&
            (await tx.dishComboReference.findFirst({
              where: { ...scope, childSku: { in: markedCombos }, child: { dishType: "combo" } },
              select: { childSku: true }
            }))
          )
            throw invalidReference();

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
