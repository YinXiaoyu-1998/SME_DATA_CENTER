import type { PrismaClient } from "@prisma/client";
import type { BusinessScopeItem } from "@smedc/domain";

export interface PermissionDocument {
  id: string;
  title: string;
  status: string;
  categoryId: string | null;
  fileConfidentialityLevel: number | null;
  valid: boolean;
  scopes: BusinessScopeItem[];
}
export interface PermissionsUiMetadata {
  listEnterprises(orgId: string): Promise<Array<{ enterpriseKey: string; enterpriseName: string }>>;
  listDocuments(
    orgId: string,
    query: { search?: string; cursor?: string }
  ): Promise<{ documents: PermissionDocument[]; nextCursor: string | null }>;
}
export function createPrismaPermissionsUiMetadata(prisma: PrismaClient): PermissionsUiMetadata {
  return {
    async listEnterprises(orgId) {
      const [stores, grants, scopes, partitions, declarations] = await Promise.all([
        prisma.businessStore.findMany({
          where: { orgId },
          select: { enterpriseKey: true },
          distinct: ["enterpriseKey"]
        }),
        prisma.businessGrant.findMany({
          where: { orgId },
          select: { enterpriseKey: true },
          distinct: ["enterpriseKey"]
        }),
        prisma.businessResourceScope.findMany({
          where: { orgId },
          select: { enterpriseKey: true },
          distinct: ["enterpriseKey"]
        }),
        prisma.structuredPartition.findMany({
          where: { orgId },
          select: { enterpriseKey: true, enterpriseName: true },
          distinct: ["enterpriseKey", "enterpriseName"]
        }),
        prisma.businessEnterpriseIdentity.findMany({
          where: { orgId },
          select: { enterpriseKey: true, enterpriseName: true }
        })
      ]);
      const names = new Map<string, Set<string>>();
      for (const row of partitions) {
        const candidates = names.get(row.enterpriseKey) ?? new Set<string>();
        candidates.add(row.enterpriseName);
        names.set(row.enterpriseKey, candidates);
      }
      const keys = new Set(
        [...stores, ...grants, ...scopes, ...partitions, ...declarations].map(
          (row) => row.enterpriseKey
        )
      );
      return [...keys].sort().map((enterpriseKey) => {
        const candidates = names.get(enterpriseKey);
        // A conflicting historical name is not silently merged or guessed.
        return {
          enterpriseKey,
          enterpriseName:
            declarations.find((item) => item.enterpriseKey === enterpriseKey)?.enterpriseName ??
            (candidates?.size === 1 ? [...candidates][0]! : enterpriseKey)
        };
      });
    },
    async listDocuments(orgId, query) {
      const rows = await prisma.document.findMany({
        where: {
          orgId,
          documentKind: "evidence",
          archivedAt: null,
          ...(query.cursor ? { id: { gt: query.cursor } } : {}),
          ...(query.search
            ? { OR: [{ title: { contains: query.search } }, { id: query.search }] }
            : {})
        },
        orderBy: { id: "asc" },
        take: 51,
        select: {
          id: true,
          title: true,
          status: true,
          businessResources: {
            where: { orgId, kind: "evidence" },
            orderBy: { id: "asc" },
            take: 1,
            select: {
              categoryId: true,
              fileConfidentialityLevel: true,
              valid: true,
              scopes: {
                select: {
                  enterpriseKey: true,
                  ownership: true,
                  storeName: true,
                  dimensions: { select: { dimensionId: true, valueId: true } }
                }
              }
            }
          }
        }
      });
      return {
        documents: rows.slice(0, 50).map(({ id, title, status, businessResources }) => {
          const resource = businessResources[0];
          return {
            id,
            title,
            status,
            categoryId: resource?.categoryId ?? null,
            fileConfidentialityLevel: resource?.fileConfidentialityLevel ?? null,
            valid: resource?.valid ?? false,
            scopes:
              resource?.scopes.map((scope) => ({
                enterpriseKey: scope.enterpriseKey,
                ownership: scope.ownership,
                ...(scope.storeName !== null ? { storeName: scope.storeName } : {}),
                dimensions: Object.fromEntries(
                  scope.dimensions.map((dimension) => [dimension.dimensionId, dimension.valueId])
                )
              })) ?? []
          };
        }),
        nextCursor: rows.length > 50 ? rows[49]!.id : null
      };
    }
  };
}
