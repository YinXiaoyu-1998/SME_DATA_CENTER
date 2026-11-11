import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { Prisma, type PrismaClient } from "@prisma/client";
import {
  DISH_CATALOG_LIMITS,
  isBusinessClearance,
  normalizeEnterpriseIdentity,
  parseDishCatalogBatch,
  type DishCatalogRowInput
} from "@smedc/domain";
import { categoriesInclude } from "./business-authorization-records.js";
import {
  lockAuthorizationPublication,
  requireCurrentUploadAdmin
} from "./source-read-requirements.js";

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

function boundedIndexes(indexes: number[]): number[] {
  return [...new Set(indexes)]
    .sort((left, right) => left - right)
    .slice(0, DISH_CATALOG_LIMITS.maxRowIndexes);
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
  const resource = await tx.businessResource.upsert({
    where,
    create: {
      orgId,
      id: randomUUID().replaceAll("-", ""),
      kind: "structured",
      resourceKey,
      categoryId,
      valid: true
    },
    update: {
      valid: true,
      authorizationVersion: { increment: 1 },
      contentVersion: { increment: 1 }
    }
  });
  if (!existing)
    await tx.businessResourceScope.create({
      data: {
        orgId,
        id: randomUUID().replaceAll("-", ""),
        resourceId: resource.id,
        enterpriseKey,
        ownership: "group",
        storeName: null
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
          const state = await lockAuthorizationPublication(tx, actor.orgId);
          await tx.$queryRaw(
            Prisma.sql`SELECT id FROM employees WHERE org_id = ${actor.orgId} AND id = ${actor.id} FOR SHARE`
          );
          await requireCurrentUploadAdmin(tx, actor.orgId, actor.id);
          if (state.mode !== "enabled")
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

          const identity = normalizeEnterpriseIdentity(parsed.enterpriseName);
          const enterprises = await tx.businessEnterpriseIdentity.findMany({
            where: { orgId: actor.orgId }
          });
          if (
            !enterprises.some(
              (enterprise) =>
                enterprise.enterpriseKey === identity.enterpriseKey &&
                enterprise.enterpriseName === identity.enterpriseName
            )
          )
            throw new DishCatalogRepositoryError("DISH_CATALOG_ENTERPRISE_NOT_AVAILABLE");
          const enterpriseKey = identity.enterpriseKey;

          // Resolve every department name once, exactly and only among current departments.
          const departmentNames = [
            ...new Set(
              parsed.rows
                .map((row) => row.departmentName)
                .filter((name): name is string => name !== null)
            )
          ];
          const departmentIdsByName = new Map<string, string[]>();
          if (departmentNames.length) {
            const departments = await tx.$queryRawUnsafe<
              Array<{ name: string; department_id: string }>
            >(
              `SELECT name, department_id FROM business_departments WHERE org_id = ? AND enterprise_key = ? AND retired = FALSE AND (${departmentNames.map(() => "CAST(name AS BINARY) = CAST(? AS BINARY)").join(" OR ")})`,
              actor.orgId,
              enterpriseKey,
              ...departmentNames
            );
            for (const department of departments) {
              const ids = departmentIdsByName.get(department.name) ?? [];
              ids.push(department.department_id);
              departmentIdsByName.set(department.name, ids);
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
              rowIndexes: boundedIndexes(missing)
            });
          if (ambiguous.length)
            throw new DishCatalogRepositoryError("DISH_CATALOG_DEPARTMENT_AMBIGUOUS", {
              rowIndexes: boundedIndexes(ambiguous)
            });

          await persistCatalogResource(tx, actor.orgId, enterpriseKey, category.id);

          const skuIds = parsed.rows.map((row) => row.skuId);
          const existingRows = skuIds.length
            ? await tx.$queryRawUnsafe<
                Array<{
                  id: string;
                  sku_id: string;
                  department_id: string | null;
                  payload: string | null;
                }>
              >(
                `SELECT id, sku_id, department_id, CAST(payload AS CHAR CHARACTER SET utf8mb4) AS payload FROM dish_catalog_entries WHERE org_id = ? AND enterprise_key = ? AND CAST(sku_id AS BINARY) IN (${skuIds.map(() => "CAST(? AS BINARY)").join(", ")}) FOR UPDATE`,
                actor.orgId,
                enterpriseKey,
                ...skuIds
              )
            : [];
          const existingBySku = new Map(
            existingRows.map((row) => [
              row.sku_id,
              {
                id: row.id,
                departmentId: row.department_id,
                payload: row.payload === null ? null : JSON.parse(row.payload)
              }
            ])
          );

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
            if (
              existing &&
              existing.departmentId === departmentId &&
              isDeepStrictEqual(existing.payload, desired)
            ) {
              result.unchanged++;
              continue;
            }
            if (existing) {
              await tx.dishCatalogEntry.update({
                where: { id: existing.id },
                data: { departmentId, payload: desired, updatedAt: now }
              });
              result.updated++;
              continue;
            }
            await tx.dishCatalogEntry.create({
              data: {
                id: randomUUID().replaceAll("-", ""),
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
          }

          if (parsed.removeSkuIds.length) {
            const removed = await tx.dishCatalogEntry.deleteMany({
              where: { orgId: actor.orgId, enterpriseKey, skuId: { in: parsed.removeSkuIds } }
            });
            result.removed = removed.count;
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
