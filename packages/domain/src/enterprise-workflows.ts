import { z } from "zod";
import { PUBLIC_INPUT_LIMITS } from "./input-boundaries.js";

export const WORKFLOW_SCHEMA_VERSION = 1;
export const WORKFLOW_CAPABILITY_VERSION = "1.0.0";
export const WORKFLOW_MINIMUM_LAUNCHER_VERSION = "0.17.0";
// Installation readiness records and transfer proofs retain the version at which they were recorded.
export const WORKFLOW_V1_EVIDENCE_LAUNCHER_VERSION = "0.16.0";
export const WORKFLOW_DSH_MINIMUM_LAUNCHER_VERSION = "0.20.1";
export const ENTERPRISE_WORKFLOW_CAPABILITY = Object.freeze({
  id: "enterprise-workflows-v1",
  version: WORKFLOW_CAPABILITY_VERSION,
  configurationSchemaVersion: WORKFLOW_SCHEMA_VERSION,
  minimumLauncherVersion: WORKFLOW_MINIMUM_LAUNCHER_VERSION,
  dshMinimumLauncherVersion: WORKFLOW_DSH_MINIMUM_LAUNCHER_VERSION
});
export const WORKFLOW_TYPES = [
  "meituan-daily-ingestion",
  "meituan-review-operations",
  "weekly-business-report"
] as const;
export const WORKFLOW_LIMITS = Object.freeze({
  configBytes: 1_048_576,
  sourceIdentities: 2_000,
  recipientsPerPurpose: 20,
  emailChars: 254,
  brandFactsChars: 20_000,
  toneChars: 2_000,
  summaryItems: 100,
  summaryBytes: 262_144,
  leaseSeconds: 120,
  renewAfterSeconds: 30,
  runRetentionDays: 90
});
export const WORKFLOW_ERROR_CODES = [
  "WORKFLOW_CONFIGURATION_REQUIRED",
  "WORKFLOW_VERSION_INCOMPATIBLE",
  "WORKFLOW_SOURCE_MAPPING_CONFLICT",
  "WORKFLOW_ADMIN_REQUIRED",
  "WORKFLOW_PERMISSION_DENIED",
  "WORKFLOW_INSTALLATION_MISMATCH",
  "WORKFLOW_BUSY",
  "WORKFLOW_CONTROL_REVOKED",
  "WORKFLOW_ACTION_UNKNOWN",
  "WORKFLOW_VERSION_CONFLICT",
  "ORDER_SCOPE_CONFLICT",
  "ORDER_SCOPE_REQUIRED",
  "WORKFLOW_SOURCE_UNAVAILABLE"
] as const;
export const workflowIdSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z0-9_-]+$/);
export const workflowVersionSchema = z.number().int().nonnegative().max(4_294_967_295);
export const workflowHashSchema = z.string().regex(/^[a-f0-9]{64}$/);
export const workflowNameSchema = z
  .string()
  .min(1)
  .max(PUBLIC_INPUT_LIMITS.enterpriseNameChars)
  .refine((v) => v.trim().length > 0);
export const workflowEnterpriseKeySchema = z
  .string()
  .min(1)
  .max(128)
  .refine((v) => v.trim().length > 0);
export const workflowTypeSchema = z.enum(WORKFLOW_TYPES);
export const workflowDateSchema = z.iso.date();
export const workflowDateRangeSchema = z
  .object({ startDate: workflowDateSchema, endDate: workflowDateSchema })
  .strict()
  .refine((v) => v.startDate <= v.endDate, "Date range is reversed.");
export const workflowStoresSchema = z
  .array(workflowNameSchema)
  .min(1)
  .max(WORKFLOW_LIMITS.sourceIdentities)
  .refine((v) => new Set(v).size === v.length, "Duplicate exact store identity.");
export const workflowRecipientsSchema = z
  .array(z.email().max(WORKFLOW_LIMITS.emailChars))
  .max(WORKFLOW_LIMITS.recipientsPerPurpose)
  .refine((v) => new Set(v.map((s) => s.toLowerCase())).size === v.length, "Duplicate recipient.");
export function workflowPayloadFits(value: unknown, maxBytes: number): boolean {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength <= maxBytes;
}
export const workflowSourceIdentitySchema = z
  .object({
    product: z.enum(["meituan_erp", "meituan_reviews"]),
    channel: z.enum(["erp", "meituan", "dianping"]),
    accountRef: workflowNameSchema,
    sourceStoreId: workflowNameSchema.optional(),
    sourceStoreName: workflowNameSchema
  })
  .strict()
  .refine(
    (v) => (v.product === "meituan_erp" ? v.channel === "erp" : v.channel !== "erp"),
    "Source product/channel mismatch."
  );
export const workflowReviewSourceIdentitySchema = workflowSourceIdentitySchema.refine(
  (v) => v.product === "meituan_reviews",
  "Review actions require a review product source identity."
);
export type WorkflowSourceIdentity = z.infer<typeof workflowSourceIdentitySchema>;
export function workflowSourceIdentityKey(source: WorkflowSourceIdentity): string {
  return JSON.stringify([
    source.product,
    source.channel,
    source.accountRef,
    source.sourceStoreId === undefined
      ? ["name", source.sourceStoreName]
      : ["id", source.sourceStoreId]
  ]);
}
export const enterpriseIntegrationSchema = z
  .object({
    schemaVersion: z.literal(WORKFLOW_SCHEMA_VERSION),
    timezone: z.literal("Asia/Shanghai"),
    sourceAccounts: z
      .array(
        z
          .object({
            product: z.enum(["meituan_erp", "meituan_reviews"]),
            accountRef: workflowNameSchema,
            displayName: workflowNameSchema,
            sourceEnterpriseName: workflowNameSchema,
            sourceGroupName: workflowNameSchema.optional()
          })
          .strict()
      )
      .max(100),
    storeMappings: z
      .array(
        z.object({ source: workflowSourceIdentitySchema, storeName: workflowNameSchema }).strict()
      )
      .max(WORKFLOW_LIMITS.sourceIdentities),
    exclusions: z
      .array(
        z
          .object({ source: workflowSourceIdentitySchema, reason: z.string().min(1).max(2000) })
          .strict()
      )
      .max(WORKFLOW_LIMITS.sourceIdentities)
  })
  .strict()
  .superRefine((value, context) => {
    const accounts = new Set<string>();
    for (const account of value.sourceAccounts) {
      const key = JSON.stringify([account.product, account.accountRef]);
      if (accounts.has(key))
        context.addIssue({ code: "custom", message: "Duplicate source account." });
      accounts.add(key);
    }
    const seen = new Set<string>();
    for (const item of [...value.storeMappings, ...value.exclusions]) {
      const key = workflowSourceIdentityKey(item.source);
      if (seen.has(key))
        context.addIssue({
          code: "custom",
          message: "Source identity is mapped or excluded more than once."
        });
      seen.add(key);
      if (!accounts.has(JSON.stringify([item.source.product, item.source.accountRef])))
        context.addIssue({
          code: "custom",
          message: "Source identity requires a declared source account."
        });
    }
    if (
      seen.size > WORKFLOW_LIMITS.sourceIdentities ||
      !workflowPayloadFits(value, WORKFLOW_LIMITS.configBytes)
    )
      context.addIssue({ code: "custom", message: "Integration configuration exceeds limits." });
  });
export type EnterpriseIntegrationConfiguration = z.infer<typeof enterpriseIntegrationSchema>;

export const WORKFLOW_DATASETS = [
  "business",
  "dishes",
  "in_store_orders",
  "takeaway_orders",
  "delivery_ledger"
] as const;
export const workflowMailSchema = z
  .object({
    enabled: z.boolean(),
    recipients: workflowRecipientsSchema,
    allowedSender: z.email().max(WORKFLOW_LIMITS.emailChars).optional()
  })
  .strict()
  .refine(
    (v) => !v.enabled || (v.recipients.length > 0 && v.allowedSender !== undefined),
    "Enabled email needs explicit recipients and sender."
  );
const configurationBase = {
  schemaVersion: z.literal(WORKFLOW_SCHEMA_VERSION),
  storeNames: workflowStoresSchema,
  notificationPolicy: z.literal("action_required")
};
export const workflowConfigurationSchema = z
  .discriminatedUnion("type", [
    z
      .object({
        ...configurationBase,
        type: z.literal("meituan-daily-ingestion"),
        datasets: z
          .array(z.enum(WORKFLOW_DATASETS))
          .min(1)
          .max(5)
          .refine((v) => new Set(v).size === v.length),
        orderScope: z.literal("settled_only"),
        cleanupPolicy: z.literal("confirmed_files_only")
      })
      .strict(),
    z
      .object({
        ...configurationBase,
        type: z.literal("meituan-review-operations"),
        executionPolicy: z
          .object({ id: z.literal("verified-review-operations"), version: z.literal(1) })
          .strict(),
        ignoredReviewIdentities: z
          .array(
            z
              .object({
                source: workflowReviewSourceIdentitySchema,
                feedbackId: workflowNameSchema,
                reason: z.string().min(1).max(2000),
                purpose: z.literal("exclude_source_record")
              })
              .strict()
          )
          .max(WORKFLOW_LIMITS.sourceIdentities)
          .default([]),
        channels: z
          .array(z.enum(["meituan", "dianping"]))
          .min(1)
          .max(2)
          .refine((v) => new Set(v).size === v.length),
        publication: z
          .object({
            enabled: z.boolean(),
            storeNames: z
              .array(workflowNameSchema)
              .max(WORKFLOW_LIMITS.sourceIdentities)
              .refine((v) => new Set(v).size === v.length)
          })
          .strict(),
        brandFacts: z.string().max(WORKFLOW_LIMITS.brandFactsChars),
        tone: z.string().max(WORKFLOW_LIMITS.toneChars),
        draftNotification: workflowMailSchema,
        cleanupPolicy: z.literal("complete_run_only")
      })
      .strict(),
    z
      .object({
        ...configurationBase,
        type: z.literal("weekly-business-report"),
        groups: z
          .array(z.object({ name: workflowNameSchema, storeNames: workflowStoresSchema }).strict())
          .max(100),
        delivery: workflowMailSchema,
        cleanupPolicy: z.literal("retain_final_report")
      })
      .strict()
  ])
  .superRefine((value, context) => {
    const selected = new Set(value.storeNames);
    if (value.type === "meituan-review-operations") {
      if (
        new Set(
          value.ignoredReviewIdentities.map((i) =>
            JSON.stringify([workflowSourceIdentityKey(i.source), i.feedbackId])
          )
        ).size !== value.ignoredReviewIdentities.length
      )
        context.addIssue({ code: "custom", message: "Duplicate ignored review identity." });
      if (
        value.publication.storeNames.some((s) => !selected.has(s)) ||
        (value.publication.enabled && !value.publication.storeNames.length)
      )
        context.addIssue({
          code: "custom",
          message: "Publication requires a nonempty subset of collection stores."
        });
    }
    if (value.type === "weekly-business-report") {
      if (
        new Set(value.groups.map((g) => g.name)).size !== value.groups.length ||
        new Set(value.groups.flatMap((g) => g.storeNames)).size !==
          value.groups.reduce((n, g) => n + g.storeNames.length, 0) ||
        value.groups.some((g) => g.storeNames.some((s) => !selected.has(s)))
      )
        context.addIssue({
          code: "custom",
          message: "Report groups need unique names, disjoint membership and selected stores."
        });
    }
    if (!workflowPayloadFits(value, WORKFLOW_LIMITS.configBytes))
      context.addIssue({
        code: "custom",
        message: "Workflow configuration exceeds payload limit."
      });
  });
export type WorkflowConfiguration = z.infer<typeof workflowConfigurationSchema>;

export const WORKFLOW_ACTION_KINDS = [
  "upload",
  "download",
  "review_sync",
  "review_publish",
  "email"
] as const;
export const WORKFLOW_MAIL_PURPOSES = ["review_drafts", "weekly_report", "exception"] as const;
export const workflowAuthorizationScopeSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("upload"),
      datasets: z.array(z.enum(WORKFLOW_DATASETS)).min(1).max(5),
      storeNames: workflowStoresSchema
    })
    .strict(),
  z
    .object({
      kind: z.literal("download"),
      datasets: z
        .array(z.enum(["business", "dishes", "in_store_orders", "takeaway_orders"]))
        .min(1)
        .max(4),
      storeNames: workflowStoresSchema
    })
    .strict(),
  z
    .object({
      kind: z.literal("review_sync"),
      channels: z
        .array(z.enum(["meituan", "dianping"]))
        .min(1)
        .max(2),
      storeNames: workflowStoresSchema
    })
    .strict(),
  z
    .object({
      kind: z.literal("review_publish"),
      channels: z
        .array(z.enum(["meituan", "dianping"]))
        .min(1)
        .max(2),
      storeNames: workflowStoresSchema
    })
    .strict(),
  z
    .object({
      kind: z.literal("email"),
      purpose: z.enum(WORKFLOW_MAIL_PURPOSES),
      storeNames: workflowStoresSchema,
      recipients: workflowRecipientsSchema.refine((v) => v.length > 0),
      allowedSender: z.email().max(WORKFLOW_LIMITS.emailChars),
      deliveryVersion: workflowVersionSchema
    })
    .strict()
]);
export const workflowAuthorizationSchema = z
  .object({
    authorizationId: workflowIdSchema,
    scope: workflowAuthorizationScopeSchema,
    grantedBy: workflowIdSchema,
    grantedAt: z.iso.datetime(),
    revokedAt: z.iso.datetime().nullable(),
    configurationVersion: workflowVersionSchema,
    controlVersion: workflowVersionSchema
  })
  .strict();
export type WorkflowAuthorization = z.infer<typeof workflowAuthorizationSchema>;
export const workflowChangeSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("integration"), configuration: enterpriseIntegrationSchema }).strict(),
  z
    .object({ kind: z.literal("configuration"), configuration: workflowConfigurationSchema })
    .strict(),
  z
    .object({
      kind: z.literal("authorization"),
      grant: z.array(workflowAuthorizationScopeSchema).max(20),
      revokeAuthorizationIds: z.array(workflowIdSchema).max(100)
    })
    .strict(),
  z
    .object({
      kind: z.literal("control"),
      state: z.enum(["active", "paused", "revoked"]),
      reason: z.string().min(1).max(2000)
    })
    .strict()
]);
export const workflowChangePreviewSchema = z
  .object({
    previewId: workflowIdSchema,
    enterpriseKey: workflowEnterpriseKeySchema,
    workflowType: workflowTypeSchema,
    expectedVersion: workflowVersionSchema,
    expectedIntegrationVersion: workflowVersionSchema,
    expectedControlVersion: workflowVersionSchema,
    change: workflowChangeSchema,
    confirmationDigest: workflowHashSchema,
    expiresAt: z.iso.datetime()
  })
  .strict();
export type WorkflowChange = z.infer<typeof workflowChangeSchema>;
export type WorkflowChangePreview = z.infer<typeof workflowChangePreviewSchema>;
export const WORKFLOW_INSTALLATION_STATES = [
  "not_installed",
  "pending",
  "paused",
  "enabled",
  "revoked"
] as const;
export const WORKFLOW_READINESS_STATES = [
  "ready",
  "needs_configuration",
  "needs_login",
  "permission_denied",
  "unsupported",
  "unavailable"
] as const;
export const workflowReadinessCheckSchema = z
  .object({
    capability: z.enum([
      "configuration",
      "permissions",
      "meituan_erp",
      "meituan_reviews",
      "download",
      "workspace",
      "dependencies",
      "email_identity",
      "sent_mail_lookup",
      "smtp_submission",
      "host_schedule",
      "host_timezone",
      "host_model",
      "assignment",
      "file_format"
    ]),
    status: z.enum(WORKFLOW_READINESS_STATES),
    nextStep: z.string().max(2000),
    checkedAt: z.iso.datetime(),
    sampleStatus: z.enum(["verified", "no_sample", "not_checked"]).optional()
  })
  .strict();
const workflowHostSchema = z.enum(["codex", "dsh"]);
export const workflowHostSnapshotSchema = z
  .object({
    host: workflowHostSchema,
    platform: z.literal("macos"),
    taskId: workflowIdSchema,
    projectRef: workflowIdSchema,
    cron: z.string().min(1).max(255),
    timezone: z.literal("Asia/Shanghai"),
    model: workflowNameSchema,
    reasoningEffort: z.enum(["minimal", "low", "medium", "high", "xhigh", "max", "ultra"]),
    state: z.enum(["paused", "enabled"]),
    verifiedAt: z.iso.datetime()
  })
  .strict();
export const workflowInstallationSchema = z
  .object({
    installationId: workflowIdSchema,
    deviceAlias: workflowNameSchema,
    host: workflowHostSchema,
    platform: z.literal("macos"),
    launcherVersion: z.string().regex(/^\d+\.\d+\.\d+$/),
    workflowPackageVersion: z.string().regex(/^\d+\.\d+\.\d+$/),
    hostSnapshot: workflowHostSnapshotSchema.optional()
  })
  .strict()
  .refine(
    (v) => !v.hostSnapshot || v.hostSnapshot.host === v.host,
    "Host snapshot must match installation."
  );
export type WorkflowInstallation = z.infer<typeof workflowInstallationSchema>;
export const WORKFLOW_RUN_PHASES = [
  "preparing",
  "collecting",
  "validating",
  "processing",
  "delivering",
  "verifying",
  "cleaning",
  "finished"
] as const;
export const WORKFLOW_RUN_STATUSES = [
  "running",
  "succeeded",
  "partial",
  "needs_attention",
  "failed",
  "unknown"
] as const;
export const WORKFLOW_ACTION_STATES = ["intent", "confirmed", "failed", "unknown"] as const;
export const workflowRunBindingSchema = z
  .object({
    installationId: workflowIdSchema,
    runId: workflowIdSchema,
    assignmentEpoch: workflowVersionSchema,
    controlVersion: workflowVersionSchema
  })
  .strict();
export const workflowRunSnapshotSchema = z
  .object({
    workflowType: workflowTypeSchema,
    window: workflowDateRangeSchema,
    integrationVersion: workflowVersionSchema,
    configurationVersion: workflowVersionSchema,
    workflowPackageVersion: z.string().regex(/^\d+\.\d+\.\d+$/),
    integration: enterpriseIntegrationSchema,
    configuration: workflowConfigurationSchema
  })
  .strict()
  .refine((v) => v.workflowType === v.configuration.type, "Snapshot workflow type mismatch.");
export type WorkflowRunSnapshot = z.infer<typeof workflowRunSnapshotSchema>;
const actionScope = { storeNames: workflowStoresSchema, window: workflowDateRangeSchema };
export const workflowActionIdentitySchema = z.discriminatedUnion("kind", [
  z
    .object({
      ...actionScope,
      kind: z.literal("upload"),
      dataset: z.enum(WORKFLOW_DATASETS),
      orderScope: z.literal("settled_only").optional(),
      sourceHash: workflowHashSchema,
      metadataHash: workflowHashSchema
    })
    .strict()
    .refine(
      (v) => (v.dataset === "in_store_orders") === (v.orderScope !== undefined),
      "Workflow in-store uploads require settled_only; other datasets reject orderScope."
    ),
  z
    .object({
      ...actionScope,
      kind: z.literal("download"),
      dataset: z.enum(["business", "dishes", "in_store_orders", "takeaway_orders"]),
      manifestHash: workflowHashSchema.optional()
    })
    .strict(),
  z
    .object({
      ...actionScope,
      kind: z.literal("review_sync"),
      source: workflowReviewSourceIdentitySchema,
      observedFactsHash: workflowHashSchema
    })
    .strict(),
  z
    .object({
      kind: z.literal("review_publish"),
      storeName: workflowNameSchema,
      source: workflowReviewSourceIdentitySchema,
      feedbackId: workflowNameSchema,
      purpose: z.literal("customer_reply")
    })
    .strict(),
  z
    .object({
      ...actionScope,
      kind: z.literal("email"),
      purpose: z.enum(WORKFLOW_MAIL_PURPOSES),
      recipients: workflowRecipientsSchema.refine((v) => v.length > 0),
      sender: z.email().max(WORKFLOW_LIMITS.emailChars),
      deliveryVersion: workflowVersionSchema,
      reviewIdentities: z
        .array(
          z
            .object({
              source: workflowReviewSourceIdentitySchema,
              feedbackId: workflowNameSchema,
              recipient: z.email().max(WORKFLOW_LIMITS.emailChars)
            })
            .strict()
        )
        .max(WORKFLOW_LIMITS.summaryItems)
        .optional()
    })
    .strict()
    .refine(
      (v) =>
        v.purpose === "review_drafts"
          ? !!v.reviewIdentities?.length &&
            v.reviewIdentities.every((r) => v.recipients.includes(r.recipient)) &&
            new Set(
              v.reviewIdentities.map((r) =>
                JSON.stringify([
                  workflowSourceIdentityKey(r.source),
                  r.feedbackId,
                  r.recipient.toLowerCase()
                ])
              )
            ).size === v.reviewIdentities.length &&
            new Set(
              v.reviewIdentities.map((r) =>
                JSON.stringify([workflowSourceIdentityKey(r.source), r.feedbackId])
              )
            ).size *
              v.recipients.length ===
              v.reviewIdentities.length
          : v.reviewIdentities === undefined,
      "Review notifications require per-review/per-recipient identities."
    )
]);
export type WorkflowActionIdentity = z.infer<typeof workflowActionIdentitySchema>;
export const workflowActionIntentSchema = z
  .object({
    actionId: workflowIdSchema,
    identity: workflowActionIdentitySchema,
    artifactHash: workflowHashSchema.optional(),
    correlationMarker: workflowIdSchema.optional()
  })
  .strict()
  .refine(
    (v) =>
      !["email", "review_publish"].includes(v.identity.kind) ||
      (v.artifactHash !== undefined && v.correlationMarker !== undefined),
    "External publication and email require artifactHash and correlationMarker."
  );
export const workflowActionReceiptSchema = z
  .object({
    actionId: workflowIdSchema,
    state: z.enum(["confirmed", "failed", "unknown"]),
    evidence: z.enum([
      "service_status",
      "launcher_transfer",
      "provider_readback",
      "smtp_accepted",
      "smedc_readback",
      "manual_resolution",
      "request_rejected",
      "transport_unknown"
    ]),
    receiptId: workflowNameSchema.optional(),
    jobId: workflowNameSchema.optional(),
    resultHash: workflowHashSchema.optional(),
    reason: z.string().max(2000).optional(),
    verifiedAt: z.iso.datetime(),
    launcherTransfer: z
      .object({
        identityHash: workflowHashSchema,
        manifestHash: workflowHashSchema,
        resultHash: workflowHashSchema,
        launcherVersion: z.string().regex(/^\d+\.\d+\.\d+$/),
        verifiedAt: z.iso.datetime(),
        partitionCount: z.number().int().nonnegative().max(100000),
        fileCount: z.number().int().nonnegative().max(100000),
        totalByteSize: z.string().regex(/^\d{1,20}$/),
        totalRowCount: z.string().regex(/^\d{1,20}$/),
        requestId: workflowIdSchema.optional()
      })
      .strict()
      .optional(),
    smedcReadback: z
      .object({
        identityHash: workflowHashSchema,
        observedFactsHash: workflowHashSchema,
        resultHash: workflowHashSchema,
        recordIds: z
          .array(workflowIdSchema)
          .min(1)
          .max(1000)
          .refine((ids) => new Set(ids).size === ids.length, "Readback identities must be unique."),
        observedAt: z.iso.datetime(),
        outcome: z.literal("matched"),
        reviewCount: z.number().int().positive().max(1000),
        matchedCount: z.number().int().positive().max(1000)
      })
      .strict()
      .optional(),
    providerReadback: z
      .object({
        identityHash: workflowHashSchema,
        artifactHash: workflowHashSchema,
        correlationMarker: workflowIdSchema,
        providerReceiptId: workflowNameSchema,
        observedAt: z.iso.datetime(),
        outcome: z.enum(["published", "sent", "not_executed"])
      })
      .strict()
      .optional(),
    smtpAcceptance: z
      .object({
        identityHash: workflowHashSchema,
        artifactHash: workflowHashSchema,
        correlationMarker: workflowIdSchema,
        messageId: workflowNameSchema,
        responseCode: z.literal(250)
      })
      .strict()
      .optional()
  })
  .strict()
  .superRefine((v, c) => {
    if (
      v.state === "confirmed" &&
      (![
        "service_status",
        "launcher_transfer",
        "provider_readback",
        "smtp_accepted",
        "smedc_readback",
        "manual_resolution"
      ].includes(v.evidence) ||
        (!v.receiptId && !v.jobId))
    )
      c.addIssue({
        code: "custom",
        message: "Confirmed actions require a verified receipt or job identity."
      });
    if (v.evidence === "manual_resolution" && !v.reason?.trim())
      c.addIssue({ code: "custom", message: "Manual resolution requires an audited reason." });
    if (v.evidence === "transport_unknown" && v.state !== "unknown")
      c.addIssue({
        code: "custom",
        message: "Transport uncertainty cannot establish a terminal result."
      });
    if (
      v.evidence === "smtp_accepted"
        ? v.state !== "confirmed" || !v.smtpAcceptance || v.receiptId !== v.smtpAcceptance.messageId
        : v.smtpAcceptance !== undefined
    )
      c.addIssue({
        code: "custom",
        message: "SMTP acceptance requires a matching message receipt."
      });
  });
export type WorkflowActionReceipt = z.infer<typeof workflowActionReceiptSchema>;
export const workflowObservationSchema = z
  .object({
    dataset: z.enum(WORKFLOW_DATASETS),
    storeName: workflowNameSchema,
    date: workflowDateSchema,
    status: z.enum(["observed_zero", "no_source", "unreadable", "incomplete", "confirmed"]),
    evidenceHash: workflowHashSchema.optional()
  })
  .strict()
  .refine(
    (v) => v.status !== "observed_zero" || v.evidenceHash !== undefined,
    "Observed zero requires source evidence."
  );
export const workflowRunSummarySchema = z
  .object({
    phase: z.enum(WORKFLOW_RUN_PHASES),
    status: z.enum(WORKFLOW_RUN_STATUSES),
    observations: z.array(workflowObservationSchema).max(WORKFLOW_LIMITS.summaryItems),
    unresolved: z
      .array(
        z
          .object({
            code: z.enum(WORKFLOW_ERROR_CODES),
            actionId: workflowIdSchema.optional(),
            nextStep: z.string().max(2000)
          })
          .strict()
      )
      .max(WORKFLOW_LIMITS.summaryItems),
    cleanup: z.enum(["pending", "confirmed_files_cleaned", "retained", "blocked"])
  })
  .strict()
  .refine(
    (v) =>
      v.observations.length + v.unresolved.length <= WORKFLOW_LIMITS.summaryItems &&
      workflowPayloadFits(v, WORKFLOW_LIMITS.summaryBytes),
    "Summary exceeds item/byte limit."
  );
export const WORKFLOW_MIGRATION_STAGES = [
  "preview",
  "validated",
  "imported",
  "host_switched",
  "verified"
] as const;
// Portable work/evidence metadata never grants execution or claims an external action succeeded.
export const workflowRecoveryItemSchema = z
  .object({
    itemId: workflowIdSchema,
    kind: z.enum(["business", "evidence"]),
    disposition: z.enum(["open", "waived", "resolved"]),
    stage: z.enum(WORKFLOW_RUN_PHASES),
    scope: z.discriminatedUnion("kind", [
      z
        .object({ kind: z.literal("dataset"), dataset: z.enum(WORKFLOW_DATASETS), ...actionScope })
        .strict(),
      z
        .object({
          kind: z.literal("reviews"),
          source: workflowReviewSourceIdentitySchema,
          storeName: workflowNameSchema,
          window: workflowDateRangeSchema,
          feedbackId: workflowNameSchema.optional()
        })
        .strict(),
      z.object({ kind: z.literal("report"), ...actionScope }).strict(),
      z
        .object({
          kind: z.literal("unknown_scope"),
          reason: z.enum([
            "scope_not_preserved",
            "missing_local_evidence",
            "ambiguous_source_identity"
          ])
        })
        .strict()
    ]),
    evidenceRef: workflowIdSchema.optional(),
    evidenceHash: workflowHashSchema.optional(),
    resolutionReason: z
      .string()
      .min(1)
      .max(2000)
      .refine((value) => value.trim().length > 0)
      .optional()
  })
  .strict()
  .refine(
    (v) => v.disposition === "open" || v.resolutionReason !== undefined,
    "Waived or resolved recovery items require an explicit reason."
  );
export type WorkflowRecoveryItem = z.infer<typeof workflowRecoveryItemSchema>;
export const workflowMigrationManifestSchema = z
  .object({
    sourceSnapshotHash: workflowHashSchema,
    targetVersion: workflowVersionSchema,
    integration: enterpriseIntegrationSchema,
    workflows: z
      .array(
        z
          .object({
            workflowId: workflowIdSchema,
            configuration: workflowConfigurationSchema,
            authorizations: z.array(workflowAuthorizationScopeSchema).max(20),
            hostSnapshot: workflowHostSnapshotSchema,
            completedActions: z
              .array(
                z
                  .object({
                    legacyKeyHash: workflowHashSchema,
                    intent: workflowActionIntentSchema,
                    receipt: workflowActionReceiptSchema
                  })
                  .strict()
                  .refine(
                    (v) =>
                      v.intent.actionId === v.receipt.actionId && v.receipt.state === "confirmed",
                    "Completed migration actions require confirmed matching receipts."
                  )
              )
              .max(WORKFLOW_LIMITS.summaryItems),
            recoveryItems: z
              .array(workflowRecoveryItemSchema)
              .max(WORKFLOW_LIMITS.summaryItems)
              .refine(
                (items) => new Set(items.map((item) => item.itemId)).size === items.length,
                "Recovery item IDs must be unique within a page."
              )
              .optional(),
            unresolved: z
              .array(
                z
                  .object({
                    code: z.enum([
                      "source_conflict",
                      "missing_receipt",
                      "unknown_action",
                      "missing_local_evidence"
                    ]),
                    sourceRef: workflowIdSchema,
                    evidenceHash: workflowHashSchema.optional(),
                    intent: workflowActionIntentSchema.optional(),
                    receipt: workflowActionReceiptSchema.optional()
                  })
                  .strict()
                  .refine(
                    (v) =>
                      v.code !== "unknown_action" ||
                      (v.intent !== undefined &&
                        v.receipt !== undefined &&
                        v.receipt.state === "unknown" &&
                        v.intent.actionId === v.receipt.actionId),
                    "Unknown migrated actions require matching intent and unknown receipt."
                  )
              )
              .max(WORKFLOW_LIMITS.summaryItems)
          })
          .strict()
      )
      .min(1)
      .max(3)
  })
  .strict()
  .refine(
    (v) =>
      new Set(v.workflows.map((w) => w.configuration.type)).size === v.workflows.length &&
      v.workflows.reduce(
        (count, workflow) =>
          count +
          workflow.completedActions.length +
          workflow.unresolved.length +
          (workflow.recoveryItems?.length ?? 0),
        0
      ) <= WORKFLOW_LIMITS.summaryItems &&
      workflowPayloadFits(
        v.workflows.map((w) => ({
          completedActions: w.completedActions,
          unresolved: w.unresolved,
          ...(w.recoveryItems !== undefined ? { recoveryItems: w.recoveryItems } : {})
        })),
        WORKFLOW_LIMITS.summaryBytes
      ) &&
      workflowPayloadFits(v, WORKFLOW_LIMITS.configBytes),
    "Migration requires unique workflow types within the payload limit."
  );
export type WorkflowMigrationManifest = z.infer<typeof workflowMigrationManifestSchema>;

export type WorkflowType = (typeof WORKFLOW_TYPES)[number];
export type WorkflowErrorCode = (typeof WORKFLOW_ERROR_CODES)[number];
export type WorkflowAuthorizationScope = z.infer<typeof workflowAuthorizationScopeSchema>;
export type WorkflowActionIntent = z.infer<typeof workflowActionIntentSchema>;
export type WorkflowRunSummary = z.infer<typeof workflowRunSummarySchema>;
export type WorkflowReadinessCheck = z.infer<typeof workflowReadinessCheckSchema>;
export type WorkflowHostSnapshot = z.infer<typeof workflowHostSnapshotSchema>;
export type WorkflowInstallationState = (typeof WORKFLOW_INSTALLATION_STATES)[number];
export type WorkflowRunState = (typeof WORKFLOW_RUN_STATUSES)[number];
export type WorkflowActionState = (typeof WORKFLOW_ACTION_STATES)[number];
export type WorkflowMigrationStage = (typeof WORKFLOW_MIGRATION_STAGES)[number];

// Each transport page is bounded; the complete migration is a sealed sequence of pages.
export const workflowMigrationChunkSchema = z
  .array(
    workflowMigrationManifestSchema.shape.workflows.element.pick({
      workflowId: true,
      completedActions: true,
      unresolved: true,
      recoveryItems: true
    })
  )
  .min(1)
  .max(3)
  .refine(
    (v) =>
      new Set(v.map((w) => w.workflowId)).size === v.length &&
      v.reduce(
        (n, w) =>
          n + w.completedActions.length + w.unresolved.length + (w.recoveryItems?.length ?? 0),
        0
      ) <= WORKFLOW_LIMITS.summaryItems &&
      workflowPayloadFits(v, WORKFLOW_LIMITS.summaryBytes),
    "Migration page exceeds limits or repeats workflow IDs."
  );
export type WorkflowMigrationChunk = z.infer<typeof workflowMigrationChunkSchema>;

// Stable across JSON database key ordering; transport and clients use this for digests.
export function workflowCanonicalJson(value: unknown): string {
  const normalize = (item: unknown): unknown => {
    if (Array.isArray(item)) return item.map(normalize);
    if (item !== null && typeof item === "object")
      return Object.fromEntries(
        Object.entries(item)
          .filter(([, v]) => v !== undefined)
          .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
          .map(([key, v]) => [key, normalize(v)])
      );
    return item;
  };
  return JSON.stringify(normalize(value));
}
