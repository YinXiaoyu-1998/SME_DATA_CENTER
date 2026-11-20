import { z } from "zod";

import { DISH_CATALOG_LIMITS, dishCatalogTextSchema } from "./dish-catalog.js";

const exactText = (max: number) =>
  dishCatalogTextSchema(max, { required: true }).refine((v) => v.trim().length > 0);
const scope = {
  enterpriseName: exactText(DISH_CATALOG_LIMITS.enterpriseNameChars),
  storeName: exactText(255)
};
const target = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("sku"), skuId: exactText(DISH_CATALOG_LIMITS.skuIdChars) }).strict(),
  z.object({ kind: z.literal("department"), departmentId: exactText(36) }).strict()
]);
export const updateComboSaleMappingInput = z
  .object({
    ...scope,
    sourceName: exactText(DISH_CATALOG_LIMITS.dishNameChars),
    specification: dishCatalogTextSchema(DISH_CATALOG_LIMITS.specificationNameChars)
      .nullable()
      .describe(
        "Exact specification, empty for an explicitly blank specification, or null for all specifications."
      ),
    operation: z.discriminatedUnion("kind", [
      z.object({ kind: z.literal("confirm"), target, basis: exactText(512) }).strict(),
      z.object({ kind: z.literal("revoke") }).strict()
    ])
  })
  .strict();
export const queryComboSaleMappingsInput = z
  .object({
    ...scope,
    afterId: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
    limit: z.number().int().min(1).max(100).optional()
  })
  .strict();
export type UpdateComboSaleMapping = z.infer<typeof updateComboSaleMappingInput>;
export type QueryComboSaleMappings = z.infer<typeof queryComboSaleMappingsInput>;
export interface ComboSaleMappingRow {
  id: string;
  sourceName: string;
  specification: string | null;
  target: z.infer<typeof target>;
  basis: string;
  valid: boolean;
  departmentId: string | null;
  departmentName: string | null;
}
