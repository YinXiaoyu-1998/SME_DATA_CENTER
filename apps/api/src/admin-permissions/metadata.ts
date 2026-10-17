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
      // The management page and review tools must agree on what constitutes an enterprise.
      return prisma.businessEnterpriseIdentity.findMany({
        where: { orgId },
        select: { enterpriseKey: true, enterpriseName: true },
        orderBy: { enterpriseKey: "asc" }
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
