import { ENTERPRISE_WORKFLOW_CAPABILITY, workflowHostSnapshotSchema } from "@smedc/domain";
import { migrationOperation, migrationSummaries } from "./migrations.js";
import { actionOperation, authorizeAction } from "./actions.js";
import { requireBinding } from "./runs.js";
import { installOperation } from "./installations.js";
import { scheduledWindow, runOperation, runView } from "./runs.js";
import type { PrismaClient } from "@prisma/client";
import { WORKFLOW_MCP_INPUT_SCHEMAS, type WorkflowMcpToolName } from "@smedc/mcp-contract";
import { dbType, transaction, lockWorkflow, fail, type Actor } from "./repository.js";
import { ensureWorkflow, prepareChange, saveChange, view } from "./configuration.js";
// Recognize only bounded, unambiguous daily/weekly cadence. This never schedules a job
// or predicts today's next trigger; unsupported calendar rules remain unknown.
function confirmedCycleDays(type: string, schedule: string): number | null {
  const list = (value: string | undefined, max: number, min = 0) => {
    if (!value || !/^\d+(,\d+)*$/.test(value)) return null;
    const values = value.split(",").map(Number);
    return new Set(values).size === values.length && values.every((n) => n >= min && n <= max)
      ? values.length
      : null;
  };
  const cron = schedule.trim().split(/\s+/);
  if (
    cron.length === 5 &&
    (cron[0] === "*" || list(cron[0], 59)) &&
    (cron[1] === "*" || list(cron[1], 23)) &&
    cron[2] === "*" &&
    cron[3] === "*"
  ) {
    if (type === "weekly_business_report")
      return /^\d$/.test(cron[4]!) && Number(cron[4]) <= 7 ? 7 : null;
    return cron[4] === "*" ? 1 : null;
  }
  if (!schedule.startsWith("RRULE:")) return null;
  const parts = schedule
    .slice(6)
    .split(";")
    .map((part) => part.split("="));
  const allowed = ["FREQ", "BYHOUR", "BYMINUTE", "BYSECOND", "BYDAY", "BYSETPOS"];
  if (
    parts.some((part) => part.length !== 2 || !allowed.includes(part[0]!)) ||
    new Set(parts.map((part) => part[0])).size !== parts.length
  )
    return null;
  const rule = Object.fromEntries(parts) as Record<string, string>;
  const hours = list(rule["BYHOUR"], 23);
  const minutes = list(rule["BYMINUTE"], 59);
  const seconds = rule["BYSECOND"] === undefined ? 1 : list(rule["BYSECOND"], 59);
  if (!hours || !minutes || !seconds) return null;
  if (rule["BYSETPOS"] !== undefined && !list(rule["BYSETPOS"], hours * minutes * seconds, 1))
    return null;
  const days = rule["BYDAY"]?.split(",");
  const weekdays = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"];
  if (days && (new Set(days).size !== days.length || days.some((day) => !weekdays.includes(day))))
    return null;
  const allDays = days?.length === 7;
  if (type === "weekly_business_report")
    return rule["FREQ"] === "WEEKLY" && days?.length === 1 ? 7 : null;
  return (rule["FREQ"] === "DAILY" && (!days || allDays)) ||
    (rule["FREQ"] === "WEEKLY" && allDays && rule["BYSETPOS"] === undefined)
    ? 1
    : null;
}
export function createEnterpriseWorkflowService(options: {
  prisma: PrismaClient;
  now?: () => Date;
  disconnect?: () => Promise<void>;
  setupUrl?: (orgId: string, enterpriseKey?: string) => string;
}) {
  async function pruneRetention(now = options.now?.() ?? new Date()) {
    const expired = await options.prisma.workflowRun.findMany({
      where: { retainUntil: { lt: now }, finishedAt: { not: null } },
      select: { id: true },
      take: 100
    });
    if (expired.length)
      await options.prisma.workflowRun.deleteMany({
        where: {
          id: { in: expired.map((r) => r.id) },
          retainUntil: { lt: now },
          finishedAt: { not: null }
        }
      });
    return { pruned: expired.length };
  }
  return {
    pruneRetention,
    disconnect: options.disconnect,
    async execute(tool: WorkflowMcpToolName, raw: unknown, actor: Actor): Promise<unknown> {
      return transaction(options.prisma, actor, async (tx, auth) => {
        const now = options.now?.() ?? new Date();
        if (tool === "list_enterprise_workflows") {
          const input = WORKFLOW_MCP_INPUT_SCHEMAS[tool].parse(raw);
          const limit = input.limit ?? 25;
          const rows = await tx.enterpriseWorkflow.findMany({
            where: {
              orgId: actor.orgId,
              ...(input.enterpriseKey ? { enterpriseKey: input.enterpriseKey } : {}),
              ...(input.cursor ? { id: { gt: input.cursor } } : {})
            },
            orderBy: { id: "asc" },
            take: limit + 1
          });
          return {
            capability: ENTERPRISE_WORKFLOW_CAPABILITY,
            needsConfiguration:
              (await tx.enterpriseWorkflow.count({
                where: {
                  orgId: actor.orgId,
                  version: { gt: 0 },
                  ...(input.enterpriseKey ? { enterpriseKey: input.enterpriseKey } : {})
                }
              })) === 0,
            setupUrl:
              options.setupUrl?.(actor.orgId, input.enterpriseKey) ??
              `/admin/permissions/${encodeURIComponent(actor.orgId)}/workflows${input.enterpriseKey ? `/${encodeURIComponent(input.enterpriseKey)}` : ""}`,
            workflows: await Promise.all(rows.slice(0, limit).map((w) => view(tx, w))),
            nextCursor: rows.length > limit ? rows[limit - 1]!.id : null
          };
        }
        if (tool === "prepare_enterprise_workflow_change") {
          const input = WORKFLOW_MCP_INPUT_SCHEMAS[tool].parse(raw);
          const workflow = await ensureWorkflow(tx, actor, input);
          return prepareChange(tx, actor, await lockWorkflow(tx, actor, workflow.id), input, now);
        }
        if (tool === "get_enterprise_workflow" || tool === "save_enterprise_workflow") {
          const input = WORKFLOW_MCP_INPUT_SCHEMAS[tool].parse(raw);
          const found = await tx.enterpriseWorkflow.findUnique({
            where: {
              orgId_enterpriseKey_type: {
                orgId: actor.orgId,
                enterpriseKey: input.enterpriseKey,
                type: dbType(input.workflowType)
              }
            }
          });
          if (!found) fail("WORKFLOW_CONFIGURATION_REQUIRED");
          const workflow = await lockWorkflow(tx, actor, found.id);
          return tool === "get_enterprise_workflow"
            ? view(tx, workflow)
            : saveChange(
                tx,
                actor,
                workflow,
                WORKFLOW_MCP_INPUT_SCHEMAS.save_enterprise_workflow.parse(raw),
                now
              );
        }
        if (tool === "manage_workflow_installation") {
          const input = WORKFLOW_MCP_INPUT_SCHEMAS[tool].parse(raw);
          const workflow = await lockWorkflow(tx, actor, input.workflowId);
          return input.operation.kind.startsWith("migration_")
            ? migrationOperation(tx, actor, workflow, input.operation, now)
            : installOperation(tx, actor, workflow, input.operation, now);
        }
        if (tool === "manage_workflow_run") {
          const input = WORKFLOW_MCP_INPUT_SCHEMAS[tool].parse(raw);
          const workflow = await lockWorkflow(tx, actor, input.workflowId);
          if (input.operation.kind === "check_actions") {
            const bound = await requireBinding(tx, actor, workflow, input.operation, now);
            for (const intent of input.operation.actions)
              await authorizeAction(tx, actor, auth, workflow, bound.snapshot, intent);
            return { allowed: true, intentRequired: true };
          }
          return runOperation(tx, actor, auth, workflow, input.operation, now);
        }
        if (tool === "record_workflow_action") {
          const input = WORKFLOW_MCP_INPUT_SCHEMAS[tool].parse(raw);
          return actionOperation(
            tx,
            actor,
            auth,
            await lockWorkflow(tx, actor, input.workflowId),
            input.operation,
            now
          );
        }
        if (tool === "get_workflow_status") {
          const input = WORKFLOW_MCP_INPUT_SCHEMAS[tool].parse(raw);
          const workflow = await lockWorkflow(tx, actor, input.workflowId);
          const limit = input.limit ?? 25;
          const runs = await tx.workflowRun.findMany({
            where: {
              orgId: actor.orgId,
              workflowId: workflow.id,
              OR: [{ finishedAt: null }, { retainUntil: { gte: now } }],
              ...(input.runId ? { id: input.runId } : {}),
              ...(input.cursor ? { id: { lt: input.cursor } } : {})
            },
            orderBy: { id: "desc" },
            take: limit + 1
          });
          const actions = await tx.workflowAction.findMany({
            where: {
              orgId: actor.orgId,
              workflowId: workflow.id,
              state: { in: ["intent", "unknown"] },
              ...(input.actionCursor ? { actionId: { gt: input.actionCursor } } : {})
            },
            orderBy: { actionId: "asc" },
            take: limit + 1,
            select: { actionId: true, runId: true, state: true, updatedAt: true }
          });
          const expectedWindow = scheduledWindow(workflow.type, now);
          let possibleMissedWindow = false;
          if (workflow.controlState === "active" && workflow.assignedInstallationId) {
            const installation = await tx.workflowInstallation.findUnique({
              where: {
                orgId_workflowId_installationId: {
                  orgId: actor.orgId,
                  workflowId: workflow.id,
                  installationId: workflow.assignedInstallationId
                }
              }
            });
            const host = workflowHostSnapshotSchema.safeParse(installation?.hostSnapshot);
            if (
              installation?.state === "enabled" &&
              host.success &&
              host.data.state === "enabled"
            ) {
              const cycleDays = confirmedCycleDays(workflow.type, host.data.cron);
              if (cycleDays) {
                const latest = await tx.workflowRun.findFirst({
                  where: {
                    orgId: actor.orgId,
                    workflowId: workflow.id,
                    mode: "scheduled",
                    installationId: installation.installationId,
                    assignmentEpoch: workflow.assignmentEpoch,
                    controlVersion: workflow.controlVersion,
                    configurationVersion: workflow.version
                  },
                  orderBy: { startedAt: "desc" }
                });
                // A whole prior cycle has elapsed whatever today's trigger time. Require
                // history under the same enabled schedule/control; preparation alone is not a missed run.
                if (latest && Date.parse(host.data.verifiedAt) <= latest.startedAt.getTime()) {
                  const priorWindow = scheduledWindow(
                    workflow.type,
                    new Date(now.getTime() - cycleDays * 86400000)
                  );
                  possibleMissedWindow =
                    latest.endDate.toISOString().slice(0, 10) < priorWindow.endDate;
                }
              }
            }
          }
          return {
            ...(await view(tx, workflow)),
            observedAt: now,
            expectedWindow,
            possibleMissedWindow,
            pendingActions: actions.slice(0, limit),
            nextActionCursor: actions.length > limit ? actions[limit - 1]!.actionId : null,
            ...(await migrationSummaries(tx, actor, workflow, input.migrationCursor, limit)),
            installations: await tx.workflowInstallation.findMany({
              where: { orgId: actor.orgId, workflowId: workflow.id },
              take: 100,
              orderBy: { updatedAt: "desc" }
            }),
            runs: runs.slice(0, limit).map(runView),
            nextCursor: runs.length > limit ? runs[limit - 1]!.id : null
          };
        }
        fail("WORKFLOW_CONFIGURATION_REQUIRED");
      });
    }
  };
}
export type EnterpriseWorkflowService = ReturnType<typeof createEnterpriseWorkflowService>;
