import {
  workflowActionReceiptSchema,
  workflowRunSnapshotSchema,
  workflowRunSummarySchema
} from "@smedc/domain";
import { jobCorrectionSchema, jobMetadataPatchSchema, type JobKind } from "@smedc/mcp-contract";
import type { z } from "zod";
import {
  fail,
  hash,
  json,
  lockWorkflow,
  type Actor,
  type Tx
} from "../enterprise-workflows/repository.js";
import type { RequestAuditContext } from "../request-audit-context.js";
import { appliedReceiptForLink, canUseUploadLink, readJob, withJobMetadata } from "./query.js";

async function advanceMetadata(
  tx: Tx,
  actor: Actor,
  kind: JobKind,
  jobId: string,
  expectedVersion: number,
  patch: { note?: string | null; tags?: string[] } = {}
) {
  const key = { orgId: actor.orgId, kind, jobId };
  await tx.jobMetadata.createMany({ data: [{ ...key, tags: [] }], skipDuplicates: true });
  const changed = await tx.jobMetadata.updateMany({
    where: { ...key, version: expectedVersion },
    data: {
      version: { increment: 1 },
      ...(patch.note !== undefined ? { note: patch.note } : {}),
      ...(patch.tags !== undefined ? { tags: [...new Set(patch.tags)] } : {})
    }
  });
  if (changed.count !== 1) fail("JOB_VERSION_CONFLICT");
}

function auditJob(
  tx: Tx,
  actor: Actor,
  audit: RequestAuditContext,
  jobId: string,
  action: string,
  metadata: unknown
) {
  return tx.auditLog.create({
    data: {
      orgId: actor.orgId,
      actorUserAccountId: actor.id,
      action,
      targetType: "job",
      targetId: jobId,
      requestId: audit.requestId,
      clientIp: audit.sourceIp,
      clientSource: audit.clientSource,
      launcherVersion: audit.launcherVersion,
      metadata: json(metadata)
    }
  });
}

export async function patchJobMetadata(
  tx: Tx,
  actor: Actor,
  audit: RequestAuditContext,
  kind: JobKind,
  id: string,
  patch: z.infer<typeof jobMetadataPatchSchema>
) {
  const job = await readJob(tx, actor, kind, id);
  if (!job) fail("JOB_NOT_FOUND");
  if (job.workflowId) {
    await lockWorkflow(tx, actor, job.workflowId);
    if (!(await readJob(tx, actor, kind, id))) fail("JOB_NOT_FOUND");
  }
  const before = await tx.jobMetadata.findUnique({
    where: {
      orgId_kind_jobId: { orgId: actor.orgId, kind, jobId: id }
    }
  });
  await advanceMetadata(tx, actor, kind, id, patch.expectedVersion, patch);
  const [updated] = await withJobMetadata(tx, actor.orgId, [job]);
  await auditJob(tx, actor, audit, id, "job.metadata.updated", {
    kind,
    reason: patch.reason,
    previous: {
      version: before?.version ?? 0,
      note: before?.note ?? null,
      tags: before?.tags ?? []
    },
    current: updated!.metadata
  });
  return updated;
}

export async function correctWorkflowJob(
  tx: Tx,
  actor: Actor,
  audit: RequestAuditContext,
  id: string,
  correction: z.infer<typeof jobCorrectionSchema>
) {
  const orgId = actor.orgId;
  if (!(await readJob(tx, actor, "workflow_run", id))) fail("JOB_NOT_FOUND");
  const ref = await tx.workflowRun.findFirst({
    where: { id, orgId },
    select: { workflowId: true }
  });
  if (!ref) fail("JOB_CORRECTION_UNAVAILABLE");
  const workflow = await lockWorkflow(tx, actor, ref.workflowId);
  if (!(await readJob(tx, actor, "workflow_run", id))) fail("JOB_NOT_FOUND");
  await tx.$queryRaw`SELECT id FROM workflow_runs WHERE id = ${id} AND org_id = ${orgId} FOR UPDATE`;
  const run = await tx.workflowRun.findFirst({ where: { id, orgId, workflowId: workflow.id } });
  if (!run?.finishedAt || run.status !== "partial") fail("JOB_CORRECTION_UNAVAILABLE");
  const key = { orgId, workflowId: workflow.id, runId: id, actionId: correction.actionId };
  const link = await tx.workflowUploadLink.findUnique({
    where: { orgId_workflowId_runId_actionId: key }
  });
  const rejected = await tx.workflowAction.findFirst({ where: { ...key, state: "failed" } });
  if (
    !link ||
    link.result !== "receipt_conflict" ||
    workflowActionReceiptSchema.safeParse(rejected?.receipt).data?.evidence !==
      "request_rejected" ||
    !(await canUseUploadLink(tx, workflow, link))
  )
    fail("JOB_CORRECTION_EVIDENCE_REQUIRED");
  await tx.$queryRaw`
    SELECT b.id FROM import_batches b JOIN documents d ON d.org_id = b.org_id AND d.id = b.source_document_id
    WHERE b.org_id = ${orgId} AND b.id = ${link.jobId} FOR SHARE
  `;
  const receipt = await appliedReceiptForLink(tx, workflow.enterpriseKey, link);
  if (!receipt) fail("JOB_CORRECTION_EVIDENCE_REQUIRED");
  const snapshot = workflowRunSnapshotSchema.parse(run.snapshot);
  const before = workflowRunSummarySchema.parse(run.summary);
  const entries = before.unresolved.filter((entry) => entry.actionId === correction.actionId);
  if (
    snapshot.configuration.type !== "meituan-daily-ingestion" ||
    snapshot.window.startDate !== snapshot.window.endDate ||
    !Array.isArray(link.storeNames) ||
    link.storeNames.length !== 1 ||
    entries.length !== 1
  )
    fail("JOB_CORRECTION_EVIDENCE_REQUIRED");
  const [storeName] = link.storeNames;
  const index = before.observations.findIndex(
    (observation) =>
      observation.dataset === "delivery_ledger" &&
      observation.storeName === storeName &&
      observation.date === snapshot.window.startDate
  );
  const prior = before.observations[index];
  if (prior?.status !== "incomplete" || !prior.receiptCounts?.pending || !prior.evidenceHash)
    fail("JOB_CORRECTION_EVIDENCE_REQUIRED");
  const evidence = { ...receipt, importBatchId: link.jobId, actionId: link.actionId };
  const pending = prior.receiptCounts.pending - 1;
  const observations = [...before.observations];
  observations[index] = {
    ...prior,
    status: pending ? "incomplete" : "confirmed",
    receiptCounts: { ...prior.receiptCounts, skipped: prior.receiptCounts.skipped + 1, pending },
    evidenceHash: hash({ originalEvidenceHash: prior.evidenceHash, evidence })
  };
  const unresolved = before.unresolved.filter((entry) => entry.actionId !== correction.actionId);
  const completeScopes = new Set(
    observations
      .filter(
        ({ status, date }) =>
          date === snapshot.window.startDate && ["confirmed", "observed_zero"].includes(status)
      )
      .map(({ dataset, storeName }) => JSON.stringify([dataset, storeName]))
  );
  const countUnresolvedActions = await tx.workflowAction.count({
    where: { orgId, workflowId: workflow.id, runId: id, state: { in: ["intent", "unknown"] } }
  });
  const success =
    !unresolved.length &&
    !countUnresolvedActions &&
    snapshot.configuration.datasets.every((dataset) =>
      snapshot.configuration.storeNames.every((storeName) =>
        completeScopes.has(JSON.stringify([dataset, storeName]))
      )
    );
  const after = workflowRunSummarySchema.parse({
    ...before,
    observations,
    unresolved,
    status: success ? "succeeded" : "partial"
  });
  await advanceMetadata(tx, actor, "workflow_run", id, correction.expectedVersion);
  await tx.workflowRun.update({
    where: { id },
    data: { summary: json(after), status: after.status === "succeeded" ? "succeeded" : "partial" }
  });
  await auditJob(tx, actor, audit, id, "job.workflow.corrected", {
    kind: "workflow_run",
    reason: correction.reason,
    evidence,
    previous: { status: before.status, observation: prior, unresolved: entries[0] },
    current: { status: after.status, observation: observations[index] },
    version: correction.expectedVersion + 1
  });
  return { id, status: after.status, version: correction.expectedVersion + 1, evidence };
}
