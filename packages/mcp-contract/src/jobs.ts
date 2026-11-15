import { z } from "zod";
import { workflowDateSchema, workflowIdSchema, workflowVersionSchema } from "@smedc/domain";

const enterpriseKey = z.string().trim().min(1).max(191);
const receiptId = z.string().trim().min(1).max(255);
const importKind = z.enum(["row_import", "partition_import"]);
export const jobKindSchema = z.enum([...importKind.options, "workflow_run"]);
export type JobKind = z.infer<typeof jobKindSchema>;
export const jobRefSchema = z.strictObject({
  kind: jobKindSchema,
  id: workflowIdSchema
});
const workflowAction = z.strictObject({
  workflowId: workflowIdSchema,
  runId: workflowIdSchema,
  actionId: workflowIdSchema
});
export const workflowUploadBindingSchema = workflowAction.extend({
  installationId: workflowIdSchema,
  assignmentEpoch: workflowVersionSchema,
  controlVersion: workflowVersionSchema
});
export type WorkflowUploadBinding = z.infer<typeof workflowUploadBindingSchema>;

const page = {
  limit: z.number().int().min(1).max(100).optional(),
  cursor: z.string().min(1).max(1024).optional()
};
export const jobQuerySchema = z.discriminatedUnion("mode", [
  jobRefSchema.extend({ mode: z.literal("detail") }),
  z.strictObject({ mode: z.literal("receipt"), enterpriseKey, receiptId }),
  z.strictObject({
    mode: z.literal("idempotency"),
    kind: importKind,
    enterpriseKey,
    idempotencyKey: z.string().min(1).max(255)
  }),
  workflowAction.extend({ mode: z.literal("action") }),
  z.strictObject({
    mode: z.literal("actions"),
    workflowId: workflowIdSchema,
    runId: workflowIdSchema,
    ...page
  }),
  z
    .strictObject({
      mode: z.literal("list"),
      kind: jobKindSchema,
      enterpriseKey,
      status: z
        .string()
        .regex(/^[a-z_]{1,32}$/)
        .optional(),
      startDate: workflowDateSchema.optional(),
      endDate: workflowDateSchema.optional(),
      ...page
    })
    .refine(
      ({ startDate, endDate }) => !startDate || !endDate || startDate <= endDate,
      "Date range is reversed."
    )
]);
export const queryJobsInputSchema = z.strictObject({ query: jobQuerySchema });
export type JobQuery = z.infer<typeof jobQuerySchema>;

export const jobMetadataPatchSchema = z
  .strictObject({
    expectedVersion: workflowVersionSchema,
    reason: z.string().trim().min(1).max(500),
    note: z.string().max(1000).nullable().optional(),
    tags: z
      .array(z.string().regex(/^[a-z0-9][a-z0-9_-]{0,31}$/))
      .max(12)
      .optional()
  })
  .refine(({ note, tags }) => note !== undefined || tags !== undefined, "Provide a note or tags.");
export const jobCorrectionSchema = z.strictObject({
  type: z.literal("delivery_receipt_conflict"),
  actionId: workflowIdSchema,
  expectedVersion: workflowVersionSchema,
  reason: z.string().trim().min(1).max(500)
});
