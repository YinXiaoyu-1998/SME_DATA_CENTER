import { randomUUID } from "node:crypto";
import type { Prisma } from "@prisma/client";
import { FIXED_BUSINESS_CATEGORY_OWNERSHIP, FIXED_BUSINESS_CATEGORY_KEYS } from "@smedc/domain";

/** Caller holds the organization's authorization version lock. Never overwrite tenant choices. */
export async function initializeFixedBusinessCategories(
  tx: Prisma.TransactionClient,
  orgId: string
) {
  return tx.businessCategory.createMany({
    data: FIXED_BUSINESS_CATEGORY_KEYS.map((key) => ({
      orgId,
      id: randomUUID().replaceAll("-", ""),
      key,
      name:
        key === "in_store_orders"
          ? "店内订单明细"
          : key === "takeaway_orders"
            ? "平台外卖订单明细"
            : key,
      kind: "fixed" as const,
      confidentialityLevel: null,
      allowGroup: FIXED_BUSINESS_CATEGORY_OWNERSHIP[key] === "group",
      allowStore: FIXED_BUSINESS_CATEGORY_OWNERSHIP[key] === "store"
    })),
    skipDuplicates: true
  });
}
