import { z } from "zod";
import {
  enterpriseIntegrationSchema,
  workflowActionIdentitySchema,
  workflowActionReceiptSchema,
  workflowAuthorizationScopeSchema,
  workflowChangeSchema,
  workflowConfigurationSchema,
  workflowDateRangeSchema,
  workflowHashSchema,
  workflowHostSnapshotSchema,
  workflowIdSchema,
  workflowMigrationChunkSchema,
  workflowMigrationManifestSchema,
  workflowReadinessCheckSchema,
  workflowRunSnapshotSchema,
  workflowRunSummarySchema,
  workflowTypeSchema,
  workflowVersionSchema
} from "@smedc/domain";
import { WORKFLOW_MCP_INPUT_SCHEMAS } from "@smedc/mcp-contract";

/** 自动任务面与权限面共用同一个组织路径参数。 */
export const workflowOrgParams = z
  .object({ orgId: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/) })
  .strict();

/** 每个工具沿用 MCP 面同一份输入 schema；浏览器面只是第二个认证面。 */
export const workflowListBody = WORKFLOW_MCP_INPUT_SCHEMAS.list_enterprise_workflows;
export const workflowGetBody = WORKFLOW_MCP_INPUT_SCHEMAS.get_enterprise_workflow;
export const workflowPrepareBody = WORKFLOW_MCP_INPUT_SCHEMAS.prepare_enterprise_workflow_change;
export const workflowSaveBody = WORKFLOW_MCP_INPUT_SCHEMAS.save_enterprise_workflow;
export const workflowInstallationBody = WORKFLOW_MCP_INPUT_SCHEMAS.manage_workflow_installation;
export const workflowRunBody = WORKFLOW_MCP_INPUT_SCHEMAS.manage_workflow_run;
export const workflowActionBody = WORKFLOW_MCP_INPUT_SCHEMAS.record_workflow_action;
export const workflowStatusBody = WORKFLOW_MCP_INPUT_SCHEMAS.get_workflow_status;

// ---- 响应 ----

// 服务端发出的时间与 Prisma BigInt 都已按 JSON 序列化，因此契约里是字符串。
const isoDateTime = z.iso.datetime();
const capability = z
  .object({
    id: z.string(),
    version: z.string(),
    configurationSchemaVersion: z.number().int(),
    minimumLauncherVersion: z.string()
  })
  .strict();
const integrationRow = z
  .object({
    orgId: z.string(),
    enterpriseKey: z.string(),
    version: workflowVersionSchema,
    schemaVersion: z.number().int(),
    configuration: enterpriseIntegrationSchema,
    orderScopeRequired: z.boolean(),
    updatedBy: z.string(),
    createdAt: isoDateTime,
    updatedAt: isoDateTime
  })
  .strict();
const authorizationRow = z
  .object({
    authorizationId: z.string(),
    scope: workflowAuthorizationScopeSchema,
    configurationVersion: workflowVersionSchema,
    controlVersion: workflowVersionSchema,
    grantedBy: z.string(),
    grantedAt: isoDateTime,
    revokedAt: isoDateTime.nullable()
  })
  .strict();
const installationRow = z
  .object({
    orgId: z.string(),
    workflowId: z.string(),
    installationId: z.string(),
    employeeId: z.string(),
    version: z.number().int(),
    deviceAlias: z.string(),
    host: z.string(),
    platform: z.string(),
    launcherVersion: z.string(),
    workflowPackageVersion: z.string(),
    state: z.enum(["not_installed", "pending", "paused", "enabled", "revoked"]),
    hostSnapshot: workflowHostSnapshotSchema.nullable(),
    readinessChecks: z.array(workflowReadinessCheckSchema).nullable(),
    firstRunVerification: z.string(),
    lastCheckedAt: isoDateTime.nullable(),
    createdAt: isoDateTime,
    updatedAt: isoDateTime
  })
  .strict();

/** 工作流视图：企业、配置、来源与有效授权。 */
export const workflowViewResponse = z
  .object({
    capability,
    workflowId: workflowIdSchema,
    enterpriseKey: z.string(),
    workflowType: workflowTypeSchema,
    version: workflowVersionSchema,
    controlVersion: workflowVersionSchema,
    controlState: z.enum(["active", "paused", "revoked"]),
    assignmentEpoch: workflowVersionSchema,
    assignedInstallationId: z.string().nullable(),
    lease: z.object({ runId: z.string().nullable(), expiresAt: isoDateTime.nullable() }).strict(),
    configuration: workflowConfigurationSchema.nullable(),
    integration: integrationRow,
    authorizations: z.array(authorizationRow)
  })
  .strict();

export const workflowListResponse = z
  .object({
    capability,
    needsConfiguration: z.boolean(),
    setupUrl: z.string(),
    workflows: z.array(workflowViewResponse),
    nextCursor: z.string().nullable()
  })
  .strict();

export const workflowGetResponse = workflowViewResponse;

const impact = z
  .object({
    affectedWorkflows: z.array(
      z.object({ workflowType: z.string(), storeNames: z.array(z.string()) }).strict()
    )
  })
  .strict();

/** 变更预览：原样回显变更输入，并给出一次性确认凭据与影响面。 */
export const workflowPrepareResponse = z
  .object({
    enterpriseKey: z.string(),
    workflowType: workflowTypeSchema,
    expectedVersion: workflowVersionSchema,
    expectedIntegrationVersion: workflowVersionSchema,
    expectedControlVersion: workflowVersionSchema,
    change: workflowChangeSchema,
    previewId: workflowIdSchema,
    confirmationDigest: workflowHashSchema,
    expiresAt: isoDateTime,
    impact: impact.optional()
  })
  .strict();

export const workflowSaveResponse = workflowViewResponse;

const takeoverPreview = z
  .object({
    previewId: workflowIdSchema,
    confirmationDigest: workflowHashSchema,
    kind: z.literal("takeover"),
    installationId: z.string(),
    assignmentEpoch: z.number().int(),
    oldInstallationId: z.string().nullable(),
    oldHostState: z.enum(["paused", "unavailable"]),
    unknownActionIds: z.array(z.string()),
    unknownActionCount: z.number().int(),
    unknownLatestChange: z.string().nullable(),
    leaseExpiresAt: isoDateTime.nullable()
  })
  .strict();

const takeoverResult = z
  .object({
    workflowId: z.string(),
    assignmentEpoch: z.number().int(),
    installationId: z.string(),
    unresolvedActionIds: z.array(z.string()),
    unresolvedActionCount: z.number().int(),
    nextActionCursor: z.string().nullable()
  })
  .strict();

const migrationTargets = z.array(
  z
    .object({
      workflowId: z.string(),
      version: z.number().int(),
      controlVersion: z.number().int(),
      assignmentEpoch: z.number().int()
    })
    .strict()
);

/** 迁移行：清单正文只保留结构，动作与异常在分页接口里传输。 */
const migrationView = z
  .object({
    id: z.string(),
    migrationId: z.string(),
    orgId: z.string(),
    enterpriseKey: z.string(),
    sourceSnapshotHash: workflowHashSchema,
    targetVersion: z.number().int(),
    version: z.number().int(),
    stage: z.enum(["preview", "validated", "imported", "host_switched", "verified"]),
    manifest: workflowMigrationManifestSchema,
    confirmationDigest: workflowHashSchema,
    createdBy: z.string(),
    createdAt: isoDateTime,
    updatedAt: isoDateTime,
    sealedAt: isoDateTime.nullable(),
    chunkCount: z.number().int(),
    recordCount: z.number().int(),
    chunksDigest: workflowHashSchema.nullable(),
    importedChunks: z.number().int(),
    validatedChunks: z.number().int(),
    targetVersions: migrationTargets
  })
  .strict();

const migrationChunk = z
  .object({
    sequence: z.number().int(),
    chunk: workflowMigrationChunkSchema,
    chunkHash: workflowHashSchema,
    recordCount: z.number().int(),
    importedAt: isoDateTime.nullable()
  })
  .strict();

const migrationGet = migrationView
  .extend({ chunks: z.array(migrationChunk), nextCursor: z.number().int().nullable() })
  .strict();

const migrationProgress = migrationView
  .extend({ complete: z.boolean(), nextSequence: z.number().int().nullable() })
  .strict();

/** 安装/迁移操作：按操作类型返回七种互斥形状之一。 */
export const workflowInstallationResponse = z.union([
  migrationGet,
  migrationProgress,
  takeoverPreview,
  takeoverResult,
  migrationView,
  installationRow
]);

const runRow = z
  .object({
    id: z.string(),
    orgId: z.string(),
    workflowId: z.string(),
    installationId: z.string(),
    employeeId: z.string(),
    configurationVersion: z.number().int(),
    integrationVersion: z.number().int(),
    controlVersion: z.number().int(),
    assignmentEpoch: z.number().int(),
    workflowPackageVersion: z.string(),
    startDate: isoDateTime,
    endDate: isoDateTime,
    mode: z.string(),
    phase: z.string(),
    status: z.enum(["running", "succeeded", "partial", "needs_attention", "failed", "unknown"]),
    snapshot: workflowRunSnapshotSchema,
    summary: workflowRunSummarySchema.nullable(),
    startedAt: isoDateTime,
    renewedAt: isoDateTime,
    finishedAt: isoDateTime.nullable(),
    retainUntil: isoDateTime,
    runId: z.string()
  })
  .strict();

const runWithLease = runRow
  .extend({ leaseExpiresAt: isoDateTime, renewAfterSeconds: z.number().int() })
  .strict();

const backfillPreview = z
  .object({
    previewId: workflowIdSchema,
    confirmationDigest: workflowHashSchema,
    window: workflowDateRangeSchema,
    expiresAt: isoDateTime
  })
  .strict();

const runRelease = z.object({ released: z.literal(true), runId: z.string() }).strict();
const actionCheck = z
  .object({ allowed: z.literal(true), intentRequired: z.literal(true) })
  .strict();

/** 运行操作：回填预览、开始/续租、释放、结束与动作校验各自独立。 */
export const workflowRunResponse = z.union([
  backfillPreview,
  runWithLease,
  runRelease,
  actionCheck,
  runRow
]);

const actionInventory = z
  .object({
    actions: z.array(
      z
        .object({
          actionId: z.string(),
          runId: z.string(),
          state: z.enum(["intent", "confirmed", "failed", "unknown"]),
          identity: workflowActionIdentitySchema,
          identityHash: workflowHashSchema,
          artifactHash: workflowHashSchema.nullable(),
          correlationMarker: z.string().nullable(),
          receipt: workflowActionReceiptSchema.nullable()
        })
        .strict()
    )
  })
  .strict();

const actionIntent = z
  .object({
    actions: z.array(
      z
        .object({
          actionId: z.string(),
          state: z.literal("intent"),
          permitted: z.literal(true),
          identityHash: workflowHashSchema
        })
        .strict()
    )
  })
  .strict();

const actionReceipts = z
  .object({ recorded: z.number().int(), receipts: z.array(workflowActionReceiptSchema) })
  .strict();

/** 动作记录：读取库存、登记意图、登记回执三种形状。 */
export const workflowActionResponse = z.union([actionInventory, actionIntent, actionReceipts]);

const pendingAction = z
  .object({
    actionId: z.string(),
    runId: z.string(),
    state: z.enum(["intent", "confirmed", "failed", "unknown"]),
    updatedAt: isoDateTime
  })
  .strict();

const migrationSummary = z
  .object({
    migrationId: z.string(),
    stage: z.enum(["preview", "validated", "imported", "host_switched", "verified"]),
    version: z.number().int(),
    sourceSnapshotHash: workflowHashSchema,
    targetVersion: z.number().int(),
    chunkCount: z.number().int(),
    recordCount: z.number().int(),
    chunksDigest: workflowHashSchema.nullable(),
    validatedChunks: z.number().int(),
    importedChunks: z.number().int(),
    createdAt: isoDateTime,
    updatedAt: isoDateTime,
    workflowIds: z.array(z.string())
  })
  .strict();

/** 状态：视图 + 观察窗口 + 未决动作、安装、运行与迁移分页。 */
export const workflowStatusResponse = workflowViewResponse
  .extend({
    observedAt: isoDateTime,
    expectedWindow: workflowDateRangeSchema,
    possibleMissedWindow: z.boolean(),
    pendingActions: z.array(pendingAction),
    nextActionCursor: z.string().nullable(),
    runActionRefs: z.array(pendingAction).optional(),
    nextRunActionCursor: z.string().nullable().optional(),
    migrations: z.array(migrationSummary),
    nextMigrationCursor: z.string().nullable(),
    installations: z.array(installationRow),
    runs: z.array(runRow),
    nextCursor: z.string().nullable()
  })
  .strict();
