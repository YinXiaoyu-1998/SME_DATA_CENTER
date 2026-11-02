import { ENTERPRISE_WORKFLOW_CAPABILITY } from "@smedc/domain";
import { migrationOperation } from "./migrations.js";
import { actionOperation, authorizeAction } from "./actions.js";
import { requireBinding } from "./runs.js";
import { installOperation } from "./installations.js";
import { scheduledWindow, runOperation, runView } from "./runs.js";
import type { PrismaClient } from "@prisma/client";
import { WORKFLOW_MCP_INPUT_SCHEMAS, type WorkflowMcpToolName } from "@smedc/mcp-contract";
import { dbType, transaction, lockWorkflow, fail, type Actor } from "./repository.js";
import { ensureWorkflow, prepareChange, saveChange, view } from "./configuration.js";
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
          const latest = await tx.workflowRun.findFirst({
            where: { orgId: actor.orgId, workflowId: workflow.id, mode: "scheduled" },
            orderBy: { startedAt: "desc" }
          });
          const expectedWindow = scheduledWindow(workflow.type, now);
          return {
            ...(await view(tx, workflow)),
            observedAt: now,
            expectedWindow,
            possibleMissedWindow:
              !latest || latest.endDate.toISOString().slice(0, 10) < expectedWindow.endDate,
            pendingActions: actions.slice(0, limit),
            nextActionCursor: actions.length > limit ? actions[limit - 1]!.actionId : null,
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
