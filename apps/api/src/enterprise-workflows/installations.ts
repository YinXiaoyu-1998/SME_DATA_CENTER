import { z } from "zod";
import {
  WORKFLOW_CAPABILITY_VERSION,
  workflowReadinessCheckSchema,
  workflowHostSnapshotSchema
} from "@smedc/domain";
import { ENTERPRISE_WORKFLOW_LAUNCHER_VERSION, type WorkflowMcpInputs } from "@smedc/mcp-contract";
import { launcherVersionAtLeast } from "../request-audit-context.js";
import { audit, fail, hash, id, json, type Actor, type Tx, type Workflow } from "./repository.js";
import { configuration, integration } from "./configuration.js";
// Call only after readiness and assignment are checked in the locked workflow transaction.
async function activateOrderScope(tx: Tx, workflow: Workflow) {
  const config = await configuration(tx, workflow);
  if (config?.type !== "meituan-daily-ingestion" || !config.datasets.includes("in_store_orders"))
    return;
  await tx.enterpriseIntegration.update({
    where: {
      orgId_enterpriseKey: { orgId: workflow.orgId, enterpriseKey: workflow.enterpriseKey }
    },
    data: { orderScopeRequired: true }
  });
}
const takeoverSchema = z
  .object({
    kind: z.literal("takeover"),
    installationId: z.string(),
    assignmentEpoch: z.number(),
    oldInstallationId: z.string().nullable(),
    oldHostState: z.enum(["paused", "unavailable"]),
    unknownActionIds: z.array(z.string()).max(100),
    unknownActionCount: z.number().int().nonnegative(),
    unknownLatestChange: z.string().nullable()
  })
  .strict();
export async function getInstallation(
  tx: Tx,
  actor: Actor,
  workflow: Workflow,
  installationId: string,
  allowRevoked = false
) {
  const row = await tx.workflowInstallation.findUnique({
    where: {
      orgId_workflowId_installationId: {
        orgId: actor.orgId,
        workflowId: workflow.id,
        installationId
      }
    }
  });
  if (
    !row ||
    row.installationId !== installationId ||
    row.employeeId !== actor.id ||
    (row.state === "revoked" && !allowRevoked)
  )
    fail("WORKFLOW_INSTALLATION_MISMATCH");
  return row;
}
export async function requireReady(
  tx: Tx,
  actor: Actor,
  workflow: Workflow,
  installationId: string,
  now: Date,
  allowRevoked = false
) {
  const row = await getInstallation(tx, actor, workflow, installationId, allowRevoked);
  const config = await configuration(tx, workflow);
  if (!config) fail("WORKFLOW_CONFIGURATION_REQUIRED");
  if (
    !launcherVersionAtLeast(row.launcherVersion, ENTERPRISE_WORKFLOW_LAUNCHER_VERSION) ||
    row.workflowPackageVersion !== WORKFLOW_CAPABILITY_VERSION
  )
    fail("WORKFLOW_VERSION_INCOMPATIBLE");
  if (!row.hostSnapshot) fail("WORKFLOW_SOURCE_UNAVAILABLE");
  workflowHostSnapshotSchema.parse(row.hostSnapshot);
  const checks = z.array(workflowReadinessCheckSchema).parse(row.readinessChecks ?? []);
  const required = [
    "configuration",
    "permissions",
    "workspace",
    "dependencies",
    "host_schedule",
    "host_timezone",
    "host_model"
  ];
  if (config.type === "meituan-daily-ingestion") required.push("download", "meituan_erp");
  if (config.type === "meituan-review-operations") required.push("meituan_reviews");
  if (config.type === "weekly-business-report") required.push("download");
  // Mail readiness gates mail actions separately; local report preparation remains usable.
  if (
    required.some(
      (capability) =>
        !checks.some(
          (c) =>
            c.capability === capability &&
            c.status === "ready" &&
            Date.parse(c.checkedAt) <= now.getTime() + 60000 &&
            Date.parse(c.checkedAt) > now.getTime() - 86400000
        )
    )
  )
    fail("WORKFLOW_SOURCE_UNAVAILABLE");
  return row;
}
export async function installOperation(
  tx: Tx,
  actor: Actor,
  workflow: Workflow,
  op: WorkflowMcpInputs["manage_workflow_installation"]["operation"],
  now: Date
) {
  if (op.kind === "register") {
    const old = await tx.workflowInstallation.findUnique({
      where: {
        orgId_workflowId_installationId: {
          orgId: actor.orgId,
          workflowId: workflow.id,
          installationId: op.installation.installationId
        }
      }
    });
    if (old && old.employeeId !== actor.id) fail("WORKFLOW_INSTALLATION_MISMATCH");
    const { hostSnapshot, ...data } = op.installation;
    const same =
      old &&
      Object.entries(data).every(([key, value]) => old[key as keyof typeof old] === value) &&
      (!hostSnapshot || hash(old.hostSnapshot) === hash(hostSnapshot));
    if (same) return old;
    const result = await tx.workflowInstallation.upsert({
      where: {
        orgId_workflowId_installationId: {
          orgId: actor.orgId,
          workflowId: workflow.id,
          installationId: data.installationId
        }
      },
      create: {
        ...data,
        orgId: actor.orgId,
        workflowId: workflow.id,
        employeeId: actor.id,
        ...(hostSnapshot ? { hostSnapshot: json(hostSnapshot) } : {})
      },
      update: {
        ...data,
        ...(hostSnapshot ? { hostSnapshot: json(hostSnapshot) } : {}),
        version: { increment: 1 },
        readinessChecks: []
      }
    });
    await audit(tx, actor, "register", workflow.id, { installationId: data.installationId });
    return result;
  }
  if (op.kind === "record_checks" || op.kind === "record_host" || op.kind === "set_state") {
    const old = await getInstallation(
      tx,
      actor,
      workflow,
      op.installationId,
      op.kind !== "set_state"
    );
    if (
      op.kind === "record_checks" &&
      new Set(op.checks.map((c) => c.capability)).size !== op.checks.length
    )
      fail("WORKFLOW_SOURCE_UNAVAILABLE");
    if (op.kind === "record_checks" && op.firstRunVerification === "verified") {
      const verifiedRun = await tx.workflowRun.findFirst({
        where: {
          orgId: actor.orgId,
          workflowId: workflow.id,
          installationId: op.installationId,
          configurationVersion: workflow.version,
          integrationVersion: (await integration(tx, workflow)).version,
          workflowPackageVersion: old.workflowPackageVersion,
          status: "succeeded",
          finishedAt: { not: null }
        },
        select: { id: true }
      });
      if (!verifiedRun) fail("WORKFLOW_SOURCE_UNAVAILABLE");
    }
    if (op.kind === "set_state") {
      if (old.version !== op.expectedVersion) fail("WORKFLOW_VERSION_CONFLICT");
      if (op.state === "enabled") {
        await requireReady(tx, actor, workflow, op.installationId, now);
        if (
          workflow.assignedInstallationId !== op.installationId ||
          workflow.controlState !== "active"
        )
          fail("WORKFLOW_INSTALLATION_MISMATCH");
        await activateOrderScope(tx, workflow);
      }
    }
    const row = await tx.workflowInstallation.update({
      where: {
        orgId_workflowId_installationId: {
          orgId: actor.orgId,
          workflowId: workflow.id,
          installationId: op.installationId
        }
      },
      data: {
        version: { increment: 1 },
        ...(op.kind === "record_host"
          ? { hostSnapshot: json(op.hostSnapshot) }
          : op.kind === "record_checks"
            ? {
                readinessChecks: json(op.checks),
                firstRunVerification: op.firstRunVerification,
                lastCheckedAt: now
              }
            : { state: op.state })
      }
    });
    await audit(tx, actor, op.kind, workflow.id, { installationId: op.installationId });
    return row;
  }
  if (op.kind === "prepare_takeover" || op.kind === "takeover") {
    await requireReady(tx, actor, workflow, op.installationId, now, true);
    if (workflow.assignmentEpoch !== op.expectedAssignmentEpoch) fail("WORKFLOW_VERSION_CONFLICT");
    if (workflow.leaseRunId && workflow.leaseExpiresAt && workflow.leaseExpiresAt > now)
      fail("WORKFLOW_BUSY");
    const unknownActionIds = (
      await tx.workflowAction.findMany({
        where: {
          orgId: actor.orgId,
          workflowId: workflow.id,
          state: { in: ["intent", "unknown"] }
        },
        orderBy: { actionId: "asc" },
        select: { actionId: true },
        take: 100
      })
    ).map((a) => a.actionId);
    const pending = await tx.workflowAction.aggregate({
      where: { orgId: actor.orgId, workflowId: workflow.id, state: { in: ["intent", "unknown"] } },
      _count: true,
      _max: { updatedAt: true }
    });
    const unknownActionCount = pending._count;
    const unknownLatestChange = pending._max.updatedAt?.toISOString() ?? null;
    if (op.kind === "prepare_takeover") {
      if (workflow.assignedInstallationId && op.oldHostState === "paused") {
        const old = await tx.workflowInstallation.findUnique({
          where: {
            orgId_workflowId_installationId: {
              orgId: actor.orgId,
              workflowId: workflow.id,
              installationId: workflow.assignedInstallationId
            }
          }
        });
        if (
          !old?.hostSnapshot ||
          workflowHostSnapshotSchema.parse(old.hostSnapshot).state !== "paused"
        )
          fail("WORKFLOW_BUSY");
      }
      const change = takeoverSchema.parse({
        kind: "takeover",
        installationId: op.installationId,
        assignmentEpoch: workflow.assignmentEpoch,
        oldInstallationId: workflow.assignedInstallationId,
        oldHostState: op.oldHostState,
        unknownActionIds,
        unknownActionCount,
        unknownLatestChange
      });
      const previewId = id();
      const confirmationDigest = hash({ actor, previewId, change });
      await tx.workflowChangePreview.create({
        data: {
          id: previewId,
          orgId: actor.orgId,
          enterpriseKey: workflow.enterpriseKey,
          workflowType: workflow.type,
          expectedVersion: workflow.version,
          expectedIntegrationVersion: (await integration(tx, workflow)).version,
          expectedControlVersion: workflow.controlVersion,
          preparedBy: actor.id,
          change: json(change),
          confirmationDigest,
          expiresAt: new Date(now.getTime() + 900000)
        }
      });
      return { previewId, confirmationDigest, ...change, leaseExpiresAt: workflow.leaseExpiresAt };
    }
    const preview = await tx.workflowChangePreview.findFirst({
      where: {
        id: op.previewId,
        orgId: actor.orgId,
        enterpriseKey: workflow.enterpriseKey,
        workflowType: workflow.type,
        preparedBy: actor.id,
        confirmationDigest: op.confirmationDigest,
        consumedAt: null,
        expiresAt: { gt: now },
        expectedVersion: workflow.version,
        expectedControlVersion: workflow.controlVersion,
        expectedIntegrationVersion: (await integration(tx, workflow)).version
      }
    });
    if (!preview) fail("WORKFLOW_VERSION_CONFLICT");
    const parsedChange = takeoverSchema.safeParse(preview.change);
    if (!parsedChange.success) fail("WORKFLOW_VERSION_CONFLICT");
    const change = parsedChange.data;
    if (
      change.installationId !== op.installationId ||
      change.assignmentEpoch !== workflow.assignmentEpoch ||
      change.oldInstallationId !== workflow.assignedInstallationId ||
      hash(change.unknownActionIds) !== hash(unknownActionIds) ||
      change.unknownActionCount !== unknownActionCount ||
      change.unknownLatestChange !== unknownLatestChange
    )
      fail("WORKFLOW_VERSION_CONFLICT");
    if (change.oldHostState === "paused" && workflow.assignedInstallationId) {
      const old = await tx.workflowInstallation.findUnique({
        where: {
          orgId_workflowId_installationId: {
            orgId: actor.orgId,
            workflowId: workflow.id,
            installationId: workflow.assignedInstallationId
          }
        }
      });
      if (
        !old?.hostSnapshot ||
        workflowHostSnapshotSchema.parse(old.hostSnapshot).state !== "paused"
      )
        fail("WORKFLOW_BUSY");
    }
    if (workflow.assignedInstallationId && workflow.assignedInstallationId !== op.installationId)
      await tx.workflowInstallation.updateMany({
        where: {
          orgId: actor.orgId,
          workflowId: workflow.id,
          installationId: workflow.assignedInstallationId
        },
        data: { state: "revoked", version: { increment: 1 } }
      });
    const result = await tx.enterpriseWorkflow.update({
      where: { id: workflow.id },
      data: {
        assignedInstallationId: op.installationId,
        assignmentEpoch: { increment: 1 },
        leaseRunId: null,
        leaseExpiresAt: null
      }
    });
    await tx.workflowRun.updateMany({
      where: { orgId: actor.orgId, workflowId: workflow.id, finishedAt: null },
      data: {
        installationId: op.installationId,
        employeeId: actor.id,
        assignmentEpoch: result.assignmentEpoch,
        controlVersion: workflow.controlVersion
      }
    });
    await tx.workflowAction.updateMany({
      where: { orgId: actor.orgId, workflowId: workflow.id, state: "intent" },
      data: { state: "unknown" }
    });
    await tx.workflowInstallation.updateMany({
      where: { orgId: actor.orgId, workflowId: workflow.id, installationId: op.installationId },
      data: {
        state: workflow.controlState === "active" ? "enabled" : "paused",
        version: { increment: 1 }
      }
    });
    if (workflow.controlState === "active") await activateOrderScope(tx, workflow);
    await tx.workflowChangePreview.update({ where: { id: preview.id }, data: { consumedAt: now } });
    await audit(tx, actor, "takeover", workflow.id, {
      installationId: op.installationId,
      oldInstallationId: change.oldInstallationId,
      unknownActionIds
    });
    return {
      workflowId: workflow.id,
      assignmentEpoch: result.assignmentEpoch,
      installationId: op.installationId,
      unresolvedActionIds: unknownActionIds,
      unresolvedActionCount: unknownActionCount,
      nextActionCursor:
        unknownActionCount > unknownActionIds.length ? unknownActionIds.at(-1) : null
    };
  }
  fail("WORKFLOW_CONFIGURATION_REQUIRED");
}
