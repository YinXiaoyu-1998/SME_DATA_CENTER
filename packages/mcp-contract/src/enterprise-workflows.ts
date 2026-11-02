import { z } from "zod";
import {
  WORKFLOW_LIMITS,
  WORKFLOW_MINIMUM_LAUNCHER_VERSION,
  workflowEnterpriseKeySchema,
  workflowIdSchema,
  workflowTypeSchema,
  workflowVersionSchema,
  workflowHashSchema,
  workflowChangeSchema,
  workflowInstallationSchema,
  workflowHostSnapshotSchema,
  workflowReadinessCheckSchema,
  workflowRunBindingSchema,
  workflowDateRangeSchema,
  workflowActionIntentSchema,
  workflowActionReceiptSchema,
  workflowRunSummarySchema,
  workflowMigrationManifestSchema,
  workflowMigrationChunkSchema,
  workflowPayloadFits
} from "@smedc/domain";

export const ENTERPRISE_WORKFLOW_LAUNCHER_VERSION = WORKFLOW_MINIMUM_LAUNCHER_VERSION;
const selector = { enterpriseKey: workflowEnterpriseKeySchema, workflowType: workflowTypeSchema };
const expected = {
  expectedVersion: workflowVersionSchema,
  expectedIntegrationVersion: workflowVersionSchema,
  expectedControlVersion: workflowVersionSchema
};
const binding = workflowRunBindingSchema.shape;
const receiptBatch = z
  .array(workflowActionReceiptSchema)
  .min(1)
  .max(WORKFLOW_LIMITS.summaryItems)
  .refine(
    (v) => workflowPayloadFits(v, WORKFLOW_LIMITS.summaryBytes),
    "Receipt batch exceeds byte limit."
  );
const intentBatch = z
  .array(workflowActionIntentSchema)
  .min(1)
  .max(WORKFLOW_LIMITS.summaryItems)
  .refine(
    (v) =>
      new Set(v.map((a) => a.actionId)).size === v.length &&
      workflowPayloadFits(v, WORKFLOW_LIMITS.summaryBytes),
    "Action batch exceeds limits or repeats action IDs."
  );
const installationOperation = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("migration_append"),
      migrationId: workflowIdSchema,
      expectedVersion: workflowVersionSchema,
      sequence: workflowVersionSchema,
      chunk: workflowMigrationChunkSchema,
      chunkHash: workflowHashSchema
    })
    .strict(),
  z
    .object({
      kind: z.literal("migration_seal"),
      migrationId: workflowIdSchema,
      expectedVersion: workflowVersionSchema,
      chunkCount: z.number().int().min(1),
      recordCount: z.number().int().nonnegative(),
      chunksDigest: workflowHashSchema
    })
    .strict(),
  z
    .object({
      kind: z.literal("migration_get"),
      migrationId: workflowIdSchema,
      cursor: workflowVersionSchema.optional(),
      limit: z.literal(1).optional()
    })
    .strict(),
  z.object({ kind: z.literal("register"), installation: workflowInstallationSchema }).strict(),
  z
    .object({
      kind: z.literal("record_checks"),
      installationId: workflowIdSchema,
      checks: z.array(workflowReadinessCheckSchema).max(WORKFLOW_LIMITS.summaryItems),
      firstRunVerification: z.enum(["not_run", "verified", "failed", "partial"])
    })
    .strict(),
  z
    .object({
      kind: z.literal("record_host"),
      installationId: workflowIdSchema,
      hostSnapshot: workflowHostSnapshotSchema
    })
    .strict(),
  z
    .object({
      kind: z.literal("prepare_takeover"),
      installationId: workflowIdSchema,
      expectedAssignmentEpoch: workflowVersionSchema,
      oldHostState: z.enum(["paused", "unavailable"])
    })
    .strict(),
  z
    .object({
      kind: z.literal("takeover"),
      installationId: workflowIdSchema,
      expectedAssignmentEpoch: workflowVersionSchema,
      previewId: workflowIdSchema,
      confirmationDigest: workflowHashSchema
    })
    .strict(),
  z
    .object({
      kind: z.literal("set_state"),
      installationId: workflowIdSchema,
      expectedVersion: workflowVersionSchema,
      state: z.enum(["paused", "enabled", "revoked"]),
      reason: z.string().min(1).max(2000)
    })
    .strict(),
  z
    .object({ kind: z.literal("migration_preview"), manifest: workflowMigrationManifestSchema })
    .strict(),
  z
    .object({
      kind: z.literal("migration_advance"),
      migrationId: workflowIdSchema,
      sourceSnapshotHash: workflowHashSchema,
      expectedVersion: workflowVersionSchema,
      stage: z.enum(["validated", "imported", "host_switched", "verified"]),
      confirmationDigest: workflowHashSchema
    })
    .strict()
]);
const runOperation = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("prepare_backfill"),
      installationId: workflowIdSchema,
      assignmentEpoch: workflowVersionSchema,
      window: workflowDateRangeSchema,
      reason: z.string().trim().min(1).max(2000)
    })
    .strict(),
  z
    .object({
      kind: z.literal("start"),
      installationId: workflowIdSchema,
      assignmentEpoch: workflowVersionSchema,
      expectedConfigurationVersion: workflowVersionSchema,
      expectedIntegrationVersion: workflowVersionSchema,
      expectedControlVersion: workflowVersionSchema,
      workflowPackageVersion: z.string().regex(/^\d+\.\d+\.\d+$/),
      window: workflowDateRangeSchema,
      mode: z.enum(["scheduled", "backfill"]),
      backfillConfirmationDigest: workflowHashSchema.optional()
    })
    .strict()
    .refine(
      (v) => (v.mode === "backfill") === (v.backfillConfirmationDigest !== undefined),
      "Backfills require an explicit confirmation."
    ),
  z.object({ kind: z.literal("renew"), ...binding }).strict(),
  z.object({ kind: z.literal("resume"), ...binding }).strict(),
  z.object({ kind: z.literal("check_actions"), ...binding, actions: intentBatch }).strict(),
  z
    .object({ kind: z.literal("record_summary"), ...binding, summary: workflowRunSummarySchema })
    .strict(),
  z
    .object({
      kind: z.literal("finish"),
      ...binding,
      summary: workflowRunSummarySchema.refine(
        (v) => v.status !== "running" && v.phase === "finished",
        "Finish requires a terminal summary."
      )
    })
    .strict(),
  z.object({ kind: z.literal("release"), ...binding }).strict()
]);
const actionOperation = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("intent"), ...binding, actions: intentBatch }).strict(),
  z.object({ kind: z.literal("record_receipts"), ...binding, receipts: receiptBatch }).strict(),
  z
    .object({
      kind: z.literal("resolve_unknown"),
      ...binding,
      receipt: workflowActionReceiptSchema.refine(
        (v) =>
          v.state !== "unknown" &&
          [
            "service_status",
            "launcher_transfer",
            "provider_readback",
            "smedc_readback",
            "manual_resolution"
          ].includes(v.evidence),
        "Unknown actions require trusted readback or audited manual resolution."
      )
    })
    .strict(),
  z
    .object({
      kind: z.literal("get"),
      actionIds: z.array(workflowIdSchema).min(1).max(WORKFLOW_LIMITS.summaryItems)
    })
    .strict()
]);
export const WORKFLOW_MCP_INPUT_SCHEMAS = {
  list_enterprise_workflows: z
    .object({
      enterpriseKey: workflowEnterpriseKeySchema.optional(),
      limit: z.number().int().min(1).max(100).optional(),
      cursor: workflowIdSchema.optional()
    })
    .strict(),
  get_enterprise_workflow: z.object(selector).strict(),
  prepare_enterprise_workflow_change: z
    .object({ ...selector, ...expected, change: workflowChangeSchema })
    .strict(),
  save_enterprise_workflow: z
    .object({
      ...selector,
      ...expected,
      previewId: workflowIdSchema,
      confirmationDigest: workflowHashSchema
    })
    .strict(),
  manage_workflow_installation: z
    .object({ workflowId: workflowIdSchema, operation: installationOperation })
    .strict(),
  manage_workflow_run: z.object({ workflowId: workflowIdSchema, operation: runOperation }).strict(),
  record_workflow_action: z
    .object({ workflowId: workflowIdSchema, operation: actionOperation })
    .strict(),
  get_workflow_status: z
    .object({
      workflowId: workflowIdSchema,
      runId: workflowIdSchema.optional(),
      limit: z.number().int().min(1).max(100).optional(),
      cursor: workflowIdSchema.optional(),
      actionCursor: workflowIdSchema.optional(),
      migrationCursor: workflowIdSchema.optional()
    })
    .strict()
} as const;
export const WORKFLOW_MCP_TOOL_NAMES = Object.keys(WORKFLOW_MCP_INPUT_SCHEMAS) as Array<
  keyof typeof WORKFLOW_MCP_INPUT_SCHEMAS
>;
export type WorkflowMcpToolName = keyof typeof WORKFLOW_MCP_INPUT_SCHEMAS;
export type WorkflowMcpInputs = {
  [K in WorkflowMcpToolName]: z.infer<(typeof WORKFLOW_MCP_INPUT_SCHEMAS)[K]>;
};
export const WORKFLOW_TOOL_READ_ONLY = new Set<WorkflowMcpToolName>([
  "list_enterprise_workflows",
  "get_enterprise_workflow",
  "get_workflow_status"
]);
