import type { Prisma } from "@prisma/client";
import {
  canReadResource,
  isBusinessClearance,
  validateBusinessScope,
  type AuthorizationSnapshot,
  type StoreReviewEnterpriseOptions
} from "@smedc/domain";
/** Caller must load snapshot and directory in the same repeatable-read transaction. No truncation. */
export async function loadStoreReviewEnterpriseOptions(
  tx: Prisma.TransactionClient,
  snapshot: AuthorizationSnapshot
): Promise<StoreReviewEnterpriseOptions> {
  const result: StoreReviewEnterpriseOptions = { complete: true, write: [], read: [] };
  if (snapshot.disabled || snapshot.mode !== "enabled") return result;
  const category = snapshot.categories.find((c) => c.kind === "fixed" && c.key === "store_reviews");
  if (!category || !isBusinessClearance(category.confidentialityLevel)) return result;
  const categoryRow = await tx.businessCategory.findUnique({
    where: { orgId_id: { orgId: snapshot.orgId, id: category.id } },
    select: { retired: true }
  });
  const enterprises = await tx.businessEnterpriseIdentity.findMany({
    where: { orgId: snapshot.orgId },
    orderBy: { enterpriseKey: "asc" }
  });
  const stores = await tx.businessStore.findMany({ where: { orgId: snapshot.orgId } });
  for (const enterprise of enterprises) {
    const matching = stores.filter((s) => s.enterpriseKey === enterprise.enterpriseKey);
    const scope = (name: string) => ({
      enterpriseKey: enterprise.enterpriseKey,
      ownership: "store" as const,
      storeName: name,
      dimensions: {}
    });
    const identity = {
      enterpriseKey: enterprise.enterpriseKey,
      enterpriseName: enterprise.enterpriseName
    };
    if (
      snapshot.role === "admin" &&
      categoryRow &&
      !categoryRow.retired &&
      matching.some((s) => !s.retired && validateBusinessScope(scope(s.name), category))
    )
      result.write.push(identity);
    if (
      matching.some(
        (s) =>
          canReadResource(snapshot, {
            orgId: snapshot.orgId,
            categoryId: category.id,
            valid: true,
            scopes: [scope(s.name)]
          }).allowed
      )
    )
      result.read.push(identity);
  }
  return result;
}
