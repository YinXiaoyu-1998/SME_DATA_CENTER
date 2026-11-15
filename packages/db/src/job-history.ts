import { Prisma, type PartitionImportJob, type WorkflowRun } from "@prisma/client";
import { workflowRunSummarySchema } from "@smedc/domain";
import { createHash } from "node:crypto";

type PartitionJobFacts = Pick<
  PartitionImportJob,
  "dataset" | "sourceStartDate" | "sourceEndDate" | "totalRowCount" | "partitionCount" | "errorCode"
>;

export function partitionJobSummary(job: PartitionJobFacts) {
  return {
    dataset: job.dataset,
    window: {
      startDate: job.sourceStartDate.toISOString().slice(0, 10),
      endDate: job.sourceEndDate.toISOString().slice(0, 10)
    },
    totalRowCount: job.totalRowCount.toString(),
    partitionCount: job.partitionCount,
    errorCode: safeJobErrorCode(job.errorCode)
  };
}

export function workflowJobSummary(
  run: Pick<WorkflowRun, "startDate" | "endDate" | "phase" | "summary">
) {
  const parsed = workflowRunSummarySchema.safeParse(run.summary);
  const counts = parsed.success
    ? parsed.data.observations.flatMap(({ receiptCounts }) =>
        receiptCounts ? [receiptCounts] : []
      )
    : [];
  return {
    phase: run.phase,
    window: {
      startDate: run.startDate.toISOString().slice(0, 10),
      endDate: run.endDate.toISOString().slice(0, 10)
    },
    observations: parsed.success
      ? parsed.data.observations.reduce<Record<string, number>>((counts, observation) => {
          counts[observation.status] = (counts[observation.status] ?? 0) + 1;
          return counts;
        }, {})
      : null,
    receiptCounts: counts.length
      ? {
          measuredStoreDays: counts.length,
          source: counts.reduce((total, value) => total + value.source, 0),
          confirmed: counts.reduce((total, value) => total + value.confirmed, 0),
          skipped: counts.reduce((total, value) => total + value.skipped, 0),
          pending: counts.reduce((total, value) => total + value.pending, 0)
        }
      : null,
    unresolved: parsed.success
      ? parsed.data.unresolved.map(({ code, actionId }) => ({
          code,
          ...(actionId ? { actionId } : {})
        }))
      : null
  };
}

export function safeJobErrorCode(value: string | null) {
  return value && /^[A-Z][A-Z0-9_]{0,127}$/.test(value) ? value : null;
}

export function jobIdempotencyHash(key: string) {
  return createHash("sha256").update(key).digest("hex");
}

export async function retainPartitionJobs(
  tx: Prisma.TransactionClient,
  before: Date,
  limit: number
) {
  const candidates = await tx.$queryRaw<{ id: string }[]>`
    SELECT id FROM partition_import_jobs
    WHERE finished_at < ${before} AND status IN ('published','rejected','failed','cancelled','expired')
    ORDER BY finished_at, id LIMIT ${limit} FOR UPDATE
  `;
  const ids = candidates.map(({ id }) => id);
  if (!ids.length) return 0;
  const jobs = await tx.partitionImportJob.findMany({ where: { id: { in: ids } } });
  await tx.jobHistory.createMany({
    data: jobs.map((job) => ({
      orgId: job.orgId,
      kind: "partition_import",
      jobId: job.id,
      enterpriseKey: job.enterpriseKey,
      ownerId: job.uploaderId,
      status: job.status,
      idempotencyHash: jobIdempotencyHash(job.idempotencyKey),
      createdAt: job.createdAt,
      finishedAt: job.finishedAt!,
      summary: partitionJobSummary(job)
    })),
    skipDuplicates: true
  });
  await tx.orderScopeTransitionPreview.deleteMany({ where: { jobId: { in: ids } } });
  return (await tx.partitionImportJob.deleteMany({ where: { id: { in: ids } } })).count;
}

export async function retainWorkflowRuns(tx: Prisma.TransactionClient, now: Date) {
  const candidates = await tx.$queryRaw<{ id: string }[]>`
    SELECT id FROM workflow_runs
    WHERE finished_at IS NOT NULL AND retain_until < ${now}
    ORDER BY retain_until, id LIMIT 100 FOR UPDATE
  `;
  const ids = candidates.map(({ id }) => id);
  if (!ids.length) return 0;
  const runs = await tx.workflowRun.findMany({
    where: { id: { in: ids } },
    include: { workflow: { select: { enterpriseKey: true } } }
  });
  await tx.jobHistory.createMany({
    data: runs.map((run) => ({
      orgId: run.orgId,
      kind: "workflow_run",
      jobId: run.id,
      enterpriseKey: run.workflow.enterpriseKey,
      ownerId: run.userAccountId,
      workflowId: run.workflowId,
      status: run.status,
      createdAt: run.startedAt,
      finishedAt: run.finishedAt!,
      summary: workflowJobSummary(run)
    })),
    skipDuplicates: true
  });
  return (await tx.workflowRun.deleteMany({ where: { id: { in: ids } } })).count;
}
