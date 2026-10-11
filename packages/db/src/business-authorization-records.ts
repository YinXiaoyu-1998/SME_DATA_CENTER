import type { Prisma } from "@prisma/client";
import type { BusinessCategoryRule, BusinessGrant, ResourceReadRequirement } from "@smedc/domain";

export const categoriesInclude = { dimensions: true } as const;
export const grantsInclude = {
  categories: true,
  stores: true,
  dimensions: { include: { values: true } }
} as const;
export const resourcesInclude = { scopes: { include: { dimensions: true } } } as const;
type ResourceRow = Prisma.BusinessResourceGetPayload<{ include: typeof resourcesInclude }>;
export function toBusinessCategoryRule(
  row: Prisma.BusinessCategoryGetPayload<{ include: typeof categoriesInclude }>
): BusinessCategoryRule {
  return {
    id: row.id,
    ...(row.key ? { key: row.key } : {}),
    kind: row.kind,
    confidentialityLevel: row.confidentialityLevel,
    ownerships: [
      ...(row.allowGroup ? ["group" as const] : []),
      ...(row.allowStore ? ["store" as const] : [])
    ],
    requiredDimensionIds: row.dimensions.map((d) => d.dimensionId).sort()
  };
}
export function toResourceReadRequirement(row: ResourceRow): ResourceReadRequirement {
  return {
    orgId: row.orgId,
    categoryId: row.categoryId,
    valid: row.valid,
    fileConfidentialityLevel: row.fileConfidentialityLevel,
    scopes: row.scopes.map((scope) => ({
      enterpriseKey: scope.enterpriseKey,
      ownership: scope.ownership,
      ...(scope.storeName !== null ? { storeName: scope.storeName } : {}),
      dimensions: Object.fromEntries(scope.dimensions.map((d) => [d.dimensionId, d.valueId]))
    }))
  };
}
export function toBusinessGrant(
  row: Prisma.BusinessGrantGetPayload<{ include: typeof grantsInclude }>
): BusinessGrant {
  return {
    id: row.id,
    orgId: row.orgId,
    enterpriseKey: row.enterpriseKey,
    categoryIds: row.categories.map((c) => c.categoryId),
    ownership: row.ownership,
    ...(row.ownership === "store"
      ? {
          stores: row.allStores
            ? { kind: "all" as const }
            : { kind: "fixed" as const, values: row.stores.map((store) => store.storeName) }
        }
      : {}),
    dimensions: Object.fromEntries(
      row.dimensions.map((d) => [
        d.dimensionId,
        d.allValues
          ? { kind: "all" as const }
          : { kind: "fixed" as const, values: d.values.map((value) => value.valueId) }
      ])
    )
  };
}

// Caller supplies the same transaction used for its category/state/account reads.
export async function loadBusinessGrants(
  tx: Prisma.TransactionClient,
  orgId: string,
  employeeId?: string
) {
  const rows = await tx.businessGrant.findMany({
    where: { orgId, ...(employeeId !== undefined ? { employeeId } : {}) },
    include: grantsInclude
  });
  const byEmployee = new Map<string, BusinessGrant[]>();
  for (const row of rows) {
    const grants = byEmployee.get(row.employeeId) ?? [];
    grants.push(toBusinessGrant(row));
    byEmployee.set(row.employeeId, grants);
  }
  return byEmployee;
}
