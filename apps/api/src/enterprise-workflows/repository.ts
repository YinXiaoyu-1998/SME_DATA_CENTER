import { Prisma, type PrismaClient } from "@prisma/client";
import { createHash, randomUUID } from "node:crypto";
import { loadBusinessGrants, toBusinessCategoryRule } from "@smedc/db";
import {
  workflowCanonicalJson,
  canReadResource,
  type AuthenticatedEmployee,
  type AuthorizationSnapshot,
  type WorkflowType
} from "@smedc/domain";
export type Tx = Prisma.TransactionClient;
export type Actor = Pick<AuthenticatedEmployee, "id" | "orgId">;
export const json = (v: unknown) => JSON.parse(JSON.stringify(v)) as Prisma.InputJsonValue;
export const hash = (v: unknown): string =>
  createHash("sha256").update(workflowCanonicalJson(v)).digest("hex");
export const id = () => randomUUID().replaceAll("-", "");
export const dbType = (type: WorkflowType) =>
  type.replaceAll("-", "_") as
    "meituan_daily_ingestion" | "meituan_review_operations" | "weekly_business_report";
export const publicType = (type: string) => type.replaceAll("_", "-") as WorkflowType;
export function fail(code: string): never {
  throw new Error(code);
}
export async function transaction<T>(
  prisma: PrismaClient,
  actor: Actor,
  fn: (tx: Tx, snapshot: AuthorizationSnapshot) => Promise<T>
) {
  return prisma.$transaction(
    async (tx) => {
      await tx.$queryRaw`SELECT org_id FROM business_authorization_states WHERE org_id = ${actor.orgId} FOR SHARE`;
      await tx.$queryRaw`SELECT id FROM employees WHERE org_id = ${actor.orgId} AND id = ${actor.id} FOR SHARE`;
      const employee = await tx.userAccount.findFirst({
        where: { id: actor.id, orgId: actor.orgId, role: "admin", disabled: false }
      });
      if (!employee) fail("WORKFLOW_ADMIN_REQUIRED");
      const state = await tx.businessAuthorizationState.findUnique({
        where: { orgId: actor.orgId }
      });
      const categories = await tx.businessCategory.findMany({
        where: { orgId: actor.orgId },
        include: { dimensions: true }
      });
      const snapshot: AuthorizationSnapshot = {
        orgId: actor.orgId,
        userAccountId: actor.id,
        role: employee.role,
        disabled: employee.disabled,
        clearance: employee.clearance,
        mode: state?.mode ?? "legacy",
        authorizationVersion: String(state?.version ?? 0),
        categories: categories.map(toBusinessCategoryRule),
        grants: (await loadBusinessGrants(tx, actor.orgId, actor.id)).get(actor.id) ?? []
      };
      return fn(tx, snapshot);
    },
    { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted, timeout: 15000 }
  );
}
export async function lockWorkflow(tx: Tx, actor: Actor, workflowId: string) {
  const identity = await tx.enterpriseWorkflow.findFirst({
    where: { orgId: actor.orgId, id: workflowId },
    select: { enterpriseKey: true }
  });
  if (!identity) fail("WORKFLOW_CONFIGURATION_REQUIRED");
  // All mutations share authorization -> enterprise integration -> workflow lock order.
  await tx.$queryRaw`SELECT enterprise_key FROM enterprise_integrations WHERE org_id = ${actor.orgId} AND enterprise_key = ${identity.enterpriseKey} FOR UPDATE`;
  await tx.$queryRaw`SELECT id FROM enterprise_workflows WHERE org_id = ${actor.orgId} AND id = ${workflowId} FOR UPDATE`;
  const workflow = await tx.enterpriseWorkflow.findFirst({
    where: { orgId: actor.orgId, id: workflowId }
  });
  if (!workflow || workflow.id !== workflowId) fail("WORKFLOW_CONFIGURATION_REQUIRED");
  return workflow;
}
export type Workflow = Awaited<ReturnType<typeof lockWorkflow>>;
export function requireRead(
  snapshot: AuthorizationSnapshot,
  workflow: Workflow,
  stores: string[],
  datasets: string[]
) {
  for (const dataset of datasets) {
    const category = snapshot.categories.find((c) => c.key === dataset);
    if (
      !category ||
      !canReadResource(snapshot, {
        orgId: workflow.orgId,
        categoryId: category.id,
        valid: true,
        scopes: stores.map((storeName) => ({
          enterpriseKey: workflow.enterpriseKey,
          ownership: "store",
          storeName,
          dimensions: {}
        }))
      }).allowed
    )
      fail("WORKFLOW_PERMISSION_DENIED");
  }
}
export async function audit(
  tx: Tx,
  actor: Actor,
  action: string,
  targetId: string,
  metadata: unknown = {}
) {
  await tx.auditLog.create({
    data: {
      orgId: actor.orgId,
      actorUserAccountId: actor.id,
      action: `workflow.${action}`,
      targetType: "enterprise_workflow",
      targetId,
      metadata: json(metadata)
    }
  });
}
