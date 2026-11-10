import { z } from "zod";
import {
  workflowLivePolicy,
  intersectWorkflowLivePolicy,
  workflowLivePolicySchema,
  WORKFLOW_LIMITS,
  workflowRunSnapshotSchema,
  workflowRunSummarySchema,
  workflowDateRangeSchema,
  type WorkflowRunSnapshot,
  type AuthorizationSnapshot
} from "@smedc/domain";
import type { WorkflowOperationInputs } from "@smedc/mcp-contract";
import {
  audit,
  fail,
  hash,
  id,
  json,
  publicType,
  requireRead,
  type Actor,
  type Tx,
  type Workflow
} from "./repository.js";
import {
  configuration,
  integration,
  validateConfiguration,
  workflowStoreKeys
} from "./configuration.js";
import { getInstallation, requireReady } from "./installations.js";
import { supportsWorkflowPackageVersion } from "./package-compatibility.js";
const backfillSchema = z
  .object({
    kind: z.literal("backfill"),
    installationId: z.string(),
    assignmentEpoch: z.number(),
    window: workflowDateRangeSchema,
    reason: z.string()
  })
  .strict();
export function scheduledWindow(type: string, now: Date) {
  const today = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).format(now);
  const date = new Date(`${today}T00:00:00Z`);
  const day = 86400000;
  const dateAt = (n: number) => new Date(date.getTime() + n * day).toISOString().slice(0, 10);
  if (type === "weekly_business_report") {
    const offset = (date.getUTCDay() + 6) % 7;
    return { startDate: dateAt(-offset - 7), endDate: dateAt(-offset - 1) };
  }
  return {
    startDate: dateAt(-1),
    endDate: type === "meituan_review_operations" ? today : dateAt(-1)
  };
}
export function requireRunRead(
  snapshot: AuthorizationSnapshot,
  workflow: Workflow,
  config: WorkflowRunSnapshot["configuration"]
) {
  if (config.type === "weekly-business-report")
    requireRead(snapshot, workflow, config.storeNames, ["business", "dishes"]);
}
export async function requireBinding(
  tx: Tx,
  actor: Actor,
  workflow: Workflow,
  binding: {
    installationId: string;
    runId: string;
    assignmentEpoch: number;
    controlVersion: number;
  },
  now: Date,
  requireLease = true
) {
  const install = await getInstallation(tx, actor, workflow, binding.installationId);
  if (workflow.controlState !== "active" || workflow.controlVersion !== binding.controlVersion)
    fail("WORKFLOW_CONTROL_REVOKED");
  if (
    workflow.assignedInstallationId !== binding.installationId ||
    workflow.assignmentEpoch !== binding.assignmentEpoch ||
    install.state !== "enabled"
  )
    fail("WORKFLOW_INSTALLATION_MISMATCH");
  const run = await tx.workflowRun.findFirst({
    where: { id: binding.runId, orgId: actor.orgId, workflowId: workflow.id }
  });
  if (
    !run ||
    run.installationId !== binding.installationId ||
    run.userAccountId !== actor.id ||
    run.assignmentEpoch !== binding.assignmentEpoch ||
    run.finishedAt
  )
    fail("WORKFLOW_INSTALLATION_MISMATCH");
  if (
    requireLease &&
    (workflow.leaseRunId !== run.id || !workflow.leaseExpiresAt || workflow.leaseExpiresAt <= now)
  )
    fail("WORKFLOW_BUSY");
  const snapshot = workflowRunSnapshotSchema.parse(run.snapshot);
  const current = await configuration(tx, workflow);
  if (!current) fail("WORKFLOW_CONFIGURATION_REQUIRED");
  const source = await integration(tx, workflow);
  const livePolicy = workflowLivePolicy(current, source.configuration);
  const storeKeys = await workflowStoreKeys(tx, workflow, livePolicy.stores);
  livePolicy.stores = livePolicy.stores.filter((name) => storeKeys.has(name));
  const original = workflowLivePolicy(snapshot.configuration, snapshot.integration);
  const previous =
    run.restrictivePolicy === null
      ? original
      : workflowLivePolicySchema.parse(run.restrictivePolicy);
  return {
    run,
    snapshot,
    installation: install,
    livePolicy: intersectWorkflowLivePolicy(previous, livePolicy)
  };
}
export const runView = (run: {
  id: string;
  snapshot: unknown;
  summary: unknown;
  [key: string]: unknown;
}) => {
  const publicRun = { ...run };
  delete publicRun.restrictivePolicy;
  return {
    ...publicRun,
    runId: run.id,
    snapshot: workflowRunSnapshotSchema.parse(run.snapshot),
    summary: run.summary === null ? null : workflowRunSummarySchema.parse(run.summary)
  };
};
export async function runOperation(
  tx: Tx,
  actor: Actor,
  auth: AuthorizationSnapshot,
  workflow: Workflow,
  op: WorkflowOperationInputs["manage_workflow_run"]["operation"],
  now: Date
) {
  if (!["release", "finish", "record_summary"].includes(op.kind) && auth.mode !== "enabled")
    fail("WORKFLOW_PERMISSION_DENIED");
  if (op.kind === "prepare_backfill") {
    await requireReady(tx, actor, workflow, op.installationId, now);
    if (
      workflow.assignedInstallationId !== op.installationId ||
      workflow.assignmentEpoch !== op.assignmentEpoch
    )
      fail("WORKFLOW_INSTALLATION_MISMATCH");
    const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai" }).format(now);
    if (
      op.window.endDate >= today ||
      (Date.parse(op.window.endDate) - Date.parse(op.window.startDate)) / 86400000 > 365
    )
      fail("WORKFLOW_PERMISSION_DENIED");
    const change = {
      kind: "backfill",
      installationId: op.installationId,
      assignmentEpoch: op.assignmentEpoch,
      window: op.window,
      reason: op.reason
    };
    const previewId = id();
    const confirmationDigest = hash({ previewId, actor, change });
    await tx.workflowChangePreview.create({
      data: {
        id: previewId,
        orgId: actor.orgId,
        enterpriseKey: workflow.enterpriseKey,
        workflowType: workflow.type,
        expectedVersion: workflow.version,
        expectedIntegrationVersion: (await integration(tx, workflow)).version,
        expectedControlVersion: workflow.controlVersion,
        change: json(change),
        confirmationDigest,
        preparedBy: actor.id,
        expiresAt: new Date(now.getTime() + 900000)
      }
    });
    await audit(tx, actor, "prepare_backfill", workflow.id, change);
    return {
      previewId,
      confirmationDigest,
      window: op.window,
      expiresAt: new Date(now.getTime() + 900000)
    };
  }
  if (op.kind === "start") {
    const installation = await requireReady(tx, actor, workflow, op.installationId, now);
    if (workflow.controlState !== "active" || workflow.controlVersion !== op.expectedControlVersion)
      fail("WORKFLOW_CONTROL_REVOKED");
    if (
      workflow.assignedInstallationId !== op.installationId ||
      workflow.assignmentEpoch !== op.assignmentEpoch ||
      installation.state !== "enabled"
    )
      fail("WORKFLOW_INSTALLATION_MISMATCH");
    const source = await integration(tx, workflow);
    const config = await configuration(tx, workflow);
    if (!config) fail("WORKFLOW_CONFIGURATION_REQUIRED");
    if (
      workflow.version !== op.expectedConfigurationVersion ||
      source.version !== op.expectedIntegrationVersion
    )
      fail("WORKFLOW_VERSION_CONFLICT");
    if (
      !supportsWorkflowPackageVersion(op.workflowPackageVersion) ||
      installation.workflowPackageVersion !== op.workflowPackageVersion
    )
      fail("WORKFLOW_VERSION_INCOMPATIBLE");
    await validateConfiguration(tx, workflow, config, source.configuration);
    requireRunRead(auth, workflow, config);
    if (workflow.leaseRunId && workflow.leaseExpiresAt && workflow.leaseExpiresAt > now)
      fail("WORKFLOW_BUSY");
    // Expiry permits resumption, never an automatic new window over an unfinished run.
    const unfinished = await tx.workflowRun.findFirst({
      where: { orgId: actor.orgId, workflowId: workflow.id, finishedAt: null }
    });
    if (unfinished) fail("WORKFLOW_BUSY");
    if (op.mode === "scheduled") {
      if (hash(op.window) !== hash(scheduledWindow(workflow.type, now)))
        fail("WORKFLOW_PERMISSION_DENIED");
    } else {
      const preview = await tx.workflowChangePreview.findFirst({
        where: {
          orgId: actor.orgId,
          enterpriseKey: workflow.enterpriseKey,
          workflowType: workflow.type,
          confirmationDigest: op.backfillConfirmationDigest,
          preparedBy: actor.id,
          consumedAt: null,
          expiresAt: { gt: now },
          expectedVersion: workflow.version,
          expectedIntegrationVersion: source.version,
          expectedControlVersion: workflow.controlVersion
        }
      });
      if (!preview) fail("WORKFLOW_PERMISSION_DENIED");
      const parsedChange = backfillSchema.safeParse(preview.change);
      if (!parsedChange.success) fail("WORKFLOW_PERMISSION_DENIED");
      const change = parsedChange.data;
      if (
        change.installationId !== op.installationId ||
        change.assignmentEpoch !== op.assignmentEpoch ||
        hash(change.window) !== hash(op.window)
      )
        fail("WORKFLOW_PERMISSION_DENIED");
      await tx.workflowChangePreview.update({
        where: { id: preview.id },
        data: { consumedAt: now }
      });
    }
    const snapshot = workflowRunSnapshotSchema.parse({
      workflowType: publicType(workflow.type),
      configurationVersion: workflow.version,
      integrationVersion: source.version,
      configuration: config,
      integration: source.configuration,
      workflowPackageVersion: op.workflowPackageVersion,
      window: op.window
    });
    const run = await tx.workflowRun.create({
      data: {
        orgId: actor.orgId,
        workflowId: workflow.id,
        installationId: op.installationId,
        userAccountId: actor.id,
        configurationVersion: workflow.version,
        integrationVersion: source.version,
        controlVersion: workflow.controlVersion,
        assignmentEpoch: workflow.assignmentEpoch,
        workflowPackageVersion: op.workflowPackageVersion,
        startDate: new Date(op.window.startDate),
        endDate: new Date(op.window.endDate),
        mode: op.mode,
        snapshot: json(snapshot),
        retainUntil: new Date(now.getTime() + WORKFLOW_LIMITS.runRetentionDays * 86400000),
        startedAt: now,
        renewedAt: now
      }
    });
    const leaseExpiresAt = new Date(now.getTime() + WORKFLOW_LIMITS.leaseSeconds * 1000);
    await tx.enterpriseWorkflow.update({
      where: { id: workflow.id },
      data: { leaseRunId: run.id, leaseExpiresAt }
    });
    await audit(tx, actor, "start", workflow.id, {
      runId: run.id,
      window: op.window,
      mode: op.mode
    });
    return {
      ...runView(run),
      leaseExpiresAt,
      renewAfterSeconds: WORKFLOW_LIMITS.renewAfterSeconds
    };
  }
  if (op.kind === "release") {
    const run = await tx.workflowRun.findFirst({
      where: {
        id: op.runId,
        orgId: actor.orgId,
        workflowId: workflow.id,
        userAccountId: actor.id,
        installationId: op.installationId,
        assignmentEpoch: op.assignmentEpoch
      }
    });
    if (
      !run ||
      workflow.assignedInstallationId !== op.installationId ||
      workflow.assignmentEpoch !== op.assignmentEpoch ||
      (workflow.leaseRunId && workflow.leaseRunId !== op.runId)
    )
      fail("WORKFLOW_INSTALLATION_MISMATCH");
    await tx.enterpriseWorkflow.update({
      where: { id: workflow.id },
      data: { leaseRunId: null, leaseExpiresAt: null }
    });
    await audit(tx, actor, "release", workflow.id, { runId: op.runId });
    return { released: true, runId: op.runId };
  }
  const bound = await requireBinding(tx, actor, workflow, op, now, op.kind !== "resume");
  requireRunRead(auth, workflow, bound.snapshot.configuration);
  if (op.kind === "renew" || op.kind === "resume") {
    if (
      op.kind === "resume" &&
      workflow.leaseRunId !== null &&
      workflow.leaseRunId !== op.runId &&
      workflow.leaseExpiresAt &&
      workflow.leaseExpiresAt > now
    )
      fail("WORKFLOW_BUSY");
    if (bound.snapshot.workflowPackageVersion !== bound.installation.workflowPackageVersion)
      fail("WORKFLOW_VERSION_INCOMPATIBLE");
    const leaseExpiresAt = new Date(now.getTime() + WORKFLOW_LIMITS.leaseSeconds * 1000);
    await tx.enterpriseWorkflow.update({
      where: { id: workflow.id },
      data: { leaseRunId: op.runId, leaseExpiresAt }
    });
    const run = await tx.workflowRun.update({
      where: { id: op.runId },
      data: { renewedAt: now, controlVersion: workflow.controlVersion }
    });
    return {
      ...runView(run),
      leaseExpiresAt,
      renewAfterSeconds: WORKFLOW_LIMITS.renewAfterSeconds
    };
  }
  if (op.kind === "finish" || op.kind === "record_summary") {
    for (const observation of op.summary.observations) {
      if (
        !bound.snapshot.configuration.storeNames.includes(observation.storeName) ||
        observation.date < bound.snapshot.window.startDate ||
        observation.date > bound.snapshot.window.endDate ||
        (bound.snapshot.configuration.type === "meituan-daily-ingestion" &&
          !bound.snapshot.configuration.datasets.includes(observation.dataset))
      )
        fail("WORKFLOW_PERMISSION_DENIED");
      if (observation.status === "observed_zero" && observation.dataset !== "delivery_ledger") {
        const present = await tx.structuredPartition.findFirst({
          where: {
            orgId: actor.orgId,
            enterpriseKey: workflow.enterpriseKey,
            dataset: observation.dataset,
            storeName: observation.storeName,
            businessDate: new Date(observation.date),
            rowCount: { gt: 0 }
          },
          select: { id: true }
        });
        if (present) fail("WORKFLOW_SOURCE_MAPPING_CONFLICT");
      }
    }
    if (op.summary.cleanup === "confirmed_files_cleaned") {
      if (
        bound.snapshot.configuration.cleanupPolicy === "complete_run_only" &&
        op.summary.status !== "succeeded"
      )
        fail("WORKFLOW_ACTION_UNKNOWN");
      if (
        !(await tx.workflowAction.count({
          where: {
            orgId: actor.orgId,
            workflowId: workflow.id,
            runId: op.runId,
            state: "confirmed"
          }
        }))
      )
        fail("WORKFLOW_ACTION_UNKNOWN");
    }
    const pending = await tx.workflowAction.count({
      where: {
        orgId: actor.orgId,
        workflowId: workflow.id,
        runId: op.runId,
        state: { in: ["intent", "unknown"] }
      }
    });
    if (
      pending &&
      (op.summary.status === "succeeded" || op.summary.cleanup === "confirmed_files_cleaned")
    )
      fail("WORKFLOW_ACTION_UNKNOWN");
    if (op.summary.status === "succeeded" && op.summary.unresolved.length)
      fail("WORKFLOW_ACTION_UNKNOWN");
    const result = await tx.workflowRun.update({
      where: { id: op.runId },
      data: {
        summary: json(op.summary),
        status: op.summary.status,
        phase: op.summary.phase,
        ...(op.kind === "finish"
          ? {
              finishedAt: now,
              retainUntil: new Date(now.getTime() + WORKFLOW_LIMITS.runRetentionDays * 86400000)
            }
          : {})
      }
    });
    if (op.kind === "finish")
      await tx.enterpriseWorkflow.update({
        where: { id: workflow.id },
        data: { leaseRunId: null, leaseExpiresAt: null }
      });
    await audit(tx, actor, op.kind, workflow.id, { runId: op.runId, status: op.summary.status });
    return runView(result);
  }
  fail("WORKFLOW_PERMISSION_DENIED");
}
