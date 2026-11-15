import { workflowActionIdentitySchema, type StructuredDatasetName } from "@smedc/domain";
import type { WorkflowUploadBinding } from "@smedc/mcp-contract";
import { authorizeAction } from "./actions.js";
import { workflowStoreKeys } from "./configuration.js";
import {
  fail,
  json,
  loadWorkflowAuthorization,
  lockWorkflow,
  type Actor,
  type Tx
} from "./repository.js";
import { requireBinding } from "./runs.js";

export function workflowUploadLink(
  actor: Actor,
  binding: WorkflowUploadBinding,
  input: {
    kind: "row_import" | "partition_import";
    enterpriseKey: string;
    dataset: StructuredDatasetName;
    sourceHash: string;
    window: { startDate: string; endDate: string };
    orderScope?: string;
    receipt?: { id: string; storeName: string };
  }
) {
  return async (tx: Tx, jobId: string, result: "accepted" | "receipt_conflict" = "accepted") => {
    const auth = await loadWorkflowAuthorization(tx, actor);
    const workflow = await lockWorkflow(tx, actor, binding.workflowId);
    const now = new Date();
    const { snapshot, livePolicy } = await requireBinding(tx, actor, workflow, binding, now);
    const key = {
      orgId: actor.orgId,
      workflowId: workflow.id,
      runId: binding.runId,
      actionId: binding.actionId
    };
    const action = await tx.workflowAction.findFirst({
      where: { ...key, state: { in: ["intent", "unknown"] } }
    });
    if (!action || workflow.enterpriseKey !== input.enterpriseKey)
      fail("WORKFLOW_PERMISSION_DENIED");
    const identity = workflowActionIdentitySchema.parse(action.identity);
    if (
      identity.kind !== "upload" ||
      identity.dataset !== input.dataset ||
      identity.sourceHash !== input.sourceHash ||
      identity.orderScope !== input.orderScope ||
      identity.window.startDate !== input.window.startDate ||
      identity.window.endDate !== input.window.endDate
    )
      fail("WORKFLOW_PERMISSION_DENIED");
    await authorizeAction(
      tx,
      actor,
      auth,
      workflow,
      snapshot,
      { actionId: binding.actionId, identity },
      livePolicy
    );

    const storeKeys = await workflowStoreKeys(tx, workflow, [
      ...identity.storeNames,
      ...(input.receipt ? [input.receipt.storeName] : [])
    ]);
    const keys = identity.storeNames.map((name) => storeKeys.get(name));
    if (
      keys.some((storeKey) => storeKey === undefined) ||
      (input.receipt && (keys.length !== 1 || keys[0] !== storeKeys.get(input.receipt.storeName)))
    )
      fail("WORKFLOW_SOURCE_MAPPING_CONFLICT");

    const existing = await tx.workflowUploadLink.findUnique({
      where: { orgId_workflowId_runId_actionId: key }
    });
    if (existing) {
      if (existing.jobId !== jobId || existing.kind !== input.kind || existing.result !== result)
        fail("WORKFLOW_VERSION_CONFLICT");
      return;
    }
    await tx.workflowUploadLink.create({
      data: {
        ...key,
        kind: input.kind,
        jobId,
        result,
        dataset: input.dataset,
        actorId: actor.id,
        receiptId: input.receipt?.id,
        storeNames: json(identity.storeNames),
        storeKeys: json(keys)
      }
    });
  };
}

export function workflowUploadError(error: unknown) {
  if (!(error instanceof Error) || !/^WORKFLOW_[A-Z_]+$/.test(error.message)) return;
  return {
    code: error.message,
    status: /ADMIN_REQUIRED|PERMISSION_DENIED/.test(error.message) ? 403 : 409
  };
}
