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

/** Null in old in-store rows is historical uncertainty, never an all-statuses claim. */
export function effectiveOrderScope(dataset: string, scope?: OrderScope | null): OrderScope | null {
  return dataset === "in_store_orders" ? (scope ?? "legacy_unknown") : null;
}

export const orderScopeTransitionConfirmationSchema = z
  .object({
    previewId: z.string().min(1).max(32),
    confirmationDigest: z.string().regex(/^[a-f0-9]{64}$/)
  })
  .strict();
export type OrderScopeTransitionConfirmation = z.infer<
  typeof orderScopeTransitionConfirmationSchema
>;
export const prepareOrderScopeTransitionSchema = z
  .object({
    enterpriseName: z
      .string()
      .min(1)
      .max(255)
      .refine((value) => value.trim().length > 0),
    startDate: z.iso.date(),
    endDate: z.iso.date(),
    storeNames: z
      .array(
        z
          .string()
          .min(1)
          .max(255)
          .refine((value) => value.trim().length > 0)
      )
      .min(1)
      .max(1000),
    orderScope: declaredOrderScopeSchema,
    sourceChecksumSha256: z.string().regex(/^[a-f0-9]{64}$/)
  })
  .strict()
  .refine((value) => value.startDate <= value.endDate, { message: "Invalid date range" });
export type PrepareOrderScopeTransition = z.infer<typeof prepareOrderScopeTransitionSchema>;
export interface OrderScopeTransitionPreview {
  previewId: string;
  confirmationDigest: string;
  expiresAt: string;
  enterpriseName: string;
  startDate: string;
  endDate: string;
  storeNames: string[];
  orderScope: DeclaredOrderScope;
  sourceChecksumSha256: string;
  partitions: Array<{
    partitionId: string;
    storeName: string;
    businessDate: string;
    version: number;
    orderScope: OrderScope;
  }>;
}
