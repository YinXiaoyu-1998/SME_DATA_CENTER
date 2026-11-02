import { z } from "zod";

export const ORDER_SCOPES = ["settled_only", "all_statuses", "legacy_unknown"] as const;
export const DECLARED_ORDER_SCOPES = ["settled_only", "all_statuses"] as const;
export const orderScopeSchema = z.enum(ORDER_SCOPES);
export const declaredOrderScopeSchema = z.enum(DECLARED_ORDER_SCOPES);
export type OrderScope = z.infer<typeof orderScopeSchema>;
export type DeclaredOrderScope = z.infer<typeof declaredOrderScopeSchema>;
export function validateOrderScopeDataset(dataset: string, orderScope: unknown): boolean {
  return (
    orderScope === undefined ||
    (dataset === "in_store_orders" && declaredOrderScopeSchema.safeParse(orderScope).success)
  );
}
