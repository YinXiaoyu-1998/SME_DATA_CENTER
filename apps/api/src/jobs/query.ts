import { createHmac, timingSafeEqual } from "node:crypto";
import {
  ImportBatchStatus,
  PartitionImportJobStatus,
  Prisma,
  WorkflowRunState,
  type JobHistory,
  type WorkflowUploadLink
} from "@prisma/client";
import {
  jobIdempotencyHash,
  partitionJobSummary,
  safeJobErrorCode,
  workflowJobSummary
} from "@smedc/db";
import { ledgerStoreKeyFromMetadata } from "@smedc/ledger-archive";
import {
  normalizeEnterpriseIdentity,
  workflowAuthorizationScopeSchema,
  workflowUploadGrantCovers
} from "@smedc/domain";
import type { JobKind, JobQuery } from "@smedc/mcp-contract";
import { configuration, workflowStoreKeys } from "../enterprise-workflows/configuration.js";
import { fail, hash, type Actor, type Tx } from "../enterprise-workflows/repository.js";

export interface JobRow {
  id: string;
  kind: JobKind;
  enterpriseKey: string | null;
  workflowId?: string;
  status: string;
  createdAt: Date;
  finishedAt: Date | null;
  summary: unknown;
  archived?: boolean;
}

const importSelect = {
  id: true,
  dataset: true,
  naturalKey: true,
  startDate: true,
  endDate: true,
  status: true,
  createdAt: true,
  updatedAt: true,
  appliedAt: true,
  errorCode: true,
  sourceDocument: { select: { sourceMetadata: true, status: true } }
} satisfies Prisma.ImportBatchSelect;
type RowImport = Prisma.ImportBatchGetPayload<{ select: typeof importSelect }>;
const dateOnly = (date: Date | null) => date?.toISOString().slice(0, 10) ?? null;
function enterpriseOf(metadata: Prisma.JsonValue | null) {
  return metadata &&
    typeof metadata === "object" &&
    !Array.isArray(metadata) &&
    typeof metadata["enterpriseKey"] === "string"
    ? metadata["enterpriseKey"]
    : null;
}
function rowImport(job: RowImport): JobRow {
  const status = job.sourceDocument.status === "archived" ? "archived" : job.status;
  return {
    kind: "row_import",
    id: job.id,
    enterpriseKey: enterpriseOf(job.sourceDocument.sourceMetadata),
    status,
    createdAt: job.createdAt,
    finishedAt:
      job.appliedAt ?? (["failed", "rejected", "archived"].includes(status) ? job.updatedAt : null),
    summary: {
      dataset: job.dataset,
      receiptId: job.dataset === "delivery_ledger" ? job.naturalKey : null,
      window: { startDate: dateOnly(job.startDate), endDate: dateOnly(job.endDate) },
      errorCode: safeJobErrorCode(job.errorCode)
    }
  };
}
function partitionImport(
  job: Parameters<typeof partitionJobSummary>[0] & {
    id: string;
    enterpriseKey: string;
    status: string;
    createdAt: Date;
    finishedAt: Date | null;
  }
): JobRow {
  return {
    kind: "partition_import",
    id: job.id,
    enterpriseKey: job.enterpriseKey,
    status: job.status,
    createdAt: job.createdAt,
    finishedAt: job.finishedAt,
    summary: partitionJobSummary(job)
  };
}
function workflowRun(
  run: Parameters<typeof workflowJobSummary>[0] & {
    id: string;
    workflowId: string;
    workflow: { enterpriseKey: string };
    status: string;
    startedAt: Date;
    finishedAt: Date | null;
  }
): JobRow {
  return {
    kind: "workflow_run",
    id: run.id,
    workflowId: run.workflowId,
    enterpriseKey: run.workflow.enterpriseKey,
    status: run.status,
    createdAt: run.startedAt,
    finishedAt: run.finishedAt,
    summary: workflowJobSummary(run)
  };
}
function archived(job: JobHistory): JobRow {
  return {
    kind: job.kind as JobKind,
    id: job.jobId,
    ...(job.workflowId ? { workflowId: job.workflowId } : {}),
    enterpriseKey: job.enterpriseKey,
    status: job.status,
    createdAt: job.createdAt,
    finishedAt: job.finishedAt,
    summary: job.summary,
    archived: true
  };
}

// Same-account history is independent of an installation. Another account must hold the assignment.
async function assignedWorkflows(
  tx: Tx,
  actor: Actor,
  input: { enterpriseKey?: string; id?: string }
) {
  const workflows = await tx.enterpriseWorkflow.findMany({
    where: {
      orgId: actor.orgId,
      ...input,
      assignedInstallationId: { not: null },
      controlState: "active"
    },
    select: { id: true, assignedInstallationId: true }
  });
  if (!workflows.length) return [];
  const installations = await tx.workflowInstallation.findMany({
    where: {
      orgId: actor.orgId,
      userAccountId: actor.id,
      state: "enabled",
      OR: workflows.map((workflow) => ({
        workflowId: workflow.id,
        installationId: workflow.assignedInstallationId!
      }))
    },
    select: { workflowId: true }
  });
  return installations.map((installation) => installation.workflowId);
}

export async function readJob(
  tx: Tx,
  actor: Actor,
  kind: JobKind,
  id: string
): Promise<JobRow | null> {
  const orgId = actor.orgId;
  switch (kind) {
    case "row_import": {
      const job = await tx.importBatch.findFirst({
        where: { id, orgId, sourceDocument: { orgId, uploaderId: actor.id } },
        select: importSelect
      });
      return job ? rowImport(job) : null;
    }
    case "partition_import": {
      const job = await tx.partitionImportJob.findFirst({
        where: { id, orgId, uploaderId: actor.id }
      });
      if (job) return partitionImport(job);
      break;
    }
    case "workflow_run": {
      const run = await tx.workflowRun.findFirst({
        where: { id, orgId },
        include: { workflow: { select: { enterpriseKey: true } } }
      });
      if (run) {
        if (
          run.userAccountId !== actor.id &&
          !(await assignedWorkflows(tx, actor, { id: run.workflowId })).length
        )
          return null;
        return workflowRun(run);
      }
      break;
    }
  }
  const history = await tx.jobHistory.findUnique({
    where: { orgId_kind_jobId: { orgId, kind, jobId: id } }
  });
  if (
    !history ||
    (history.ownerId !== actor.id &&
      (!history.workflowId ||
        !(await assignedWorkflows(tx, actor, { id: history.workflowId })).length))
  )
    return null;
  return archived(history);
}

export async function withJobMetadata(tx: Tx, orgId: string, jobs: JobRow[]) {
  if (!jobs.length) return [];
  const rows = await tx.jobMetadata.findMany({
    where: { orgId, OR: jobs.map(({ kind, id }) => ({ kind, jobId: id })) }
  });
  const meta = new Map(rows.map((row) => [`${row.kind}:${row.jobId}`, row]));
  return jobs.map((job) => {
    const row = meta.get(`${job.kind}:${job.id}`);
    return {
      ...job,
      metadata: { version: row?.version ?? 0, tags: row?.tags ?? [], note: row?.note ?? null }
    };
  });
}

type PageKey = { at: string; id: string };
function cursorSignature(body: string, scope: string, secret: string) {
  return createHmac("sha256", secret).update(scope).update(".").update(body).digest("base64url");
}
function afterCursor(
  cursor: string | undefined,
  scope: string,
  secret: string
): PageKey | undefined {
  if (!cursor) return;
  const [body, signature, extra] = cursor.split(".");
  if (!body || !signature || extra !== undefined) fail("JOB_CURSOR_INVALID");
  const expected = cursorSignature(body, scope, secret);
  if (
    signature.length !== expected.length ||
    !/^[A-Za-z0-9_-]+$/.test(signature) ||
    !timingSafeEqual(Buffer.from(signature), Buffer.from(expected))
  )
    fail("JOB_CURSOR_INVALID");
  try {
    const key = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as PageKey;
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(key.id) || new Date(key.at).toISOString() !== key.at)
      fail("JOB_CURSOR_INVALID");
    return key;
  } catch {
    fail("JOB_CURSOR_INVALID");
  }
}
function pageCursor(key: PageKey, scope: string, secret: string) {
  const body = Buffer.from(JSON.stringify(key)).toString("base64url");
  return `${body}.${cursorSignature(body, scope, secret)}`;
}
function jobPageFilter<Created extends string, Id extends string>(
  created: Created,
  id: Id,
  after: PageKey | undefined,
  query: { startDate?: string; endDate?: string }
) {
  const start = query.startDate ? new Date(query.startDate) : undefined;
  const end = query.endDate ? new Date(`${query.endDate}T23:59:59.999Z`) : undefined;
  return {
    ...(start || end ? { [created]: { gte: start, lte: end } } : {}),
    ...(after
      ? {
          OR: [
            { [created]: { lt: new Date(after.at) } },
            { [created]: new Date(after.at), [id]: { lt: after.id } }
          ]
        }
      : {})
  };
}

async function listJobs(
  tx: Tx,
  actor: Actor,
  query: Extract<JobQuery, { mode: "list" }>,
  secret: string
) {
  const { cursor, limit = 50, ...filters } = query;
  const enterpriseKey = normalizeEnterpriseIdentity(query.enterpriseKey).enterpriseKey;
  const scope = hash({ actor, filters });
  const after = afterCursor(cursor, scope, secret);
  const orgId = actor.orgId;
  const take = limit + 1;
  const statuses = {
    row_import: ImportBatchStatus,
    partition_import: PartitionImportJobStatus,
    workflow_run: WorkflowRunState
  };
  if (query.status && !Object.hasOwn(statuses[query.kind], query.status))
    fail("JOB_VALIDATION_ERROR");
  const assigned =
    query.kind === "workflow_run" ? await assignedWorkflows(tx, actor, { enterpriseKey }) : [];
  let jobs: JobRow[];
  switch (query.kind) {
    case "row_import":
      jobs = (
        await tx.importBatch.findMany({
          where: {
            orgId,
            sourceDocument: {
              orgId,
              uploaderId: actor.id,
              sourceMetadata: { path: "$.enterpriseKey", equals: enterpriseKey },
              ...(query.status && query.status !== "archived"
                ? { status: { not: "archived" } }
                : {})
            },
            AND: [
              query.status === "archived"
                ? { OR: [{ status: "archived" }, { sourceDocument: { status: "archived" } }] }
                : { status: query.status as ImportBatchStatus | undefined },
              jobPageFilter("createdAt", "id", after, query)
            ]
          },
          select: importSelect,
          orderBy: [{ createdAt: "desc" }, { id: "desc" }],
          take
        })
      ).map(rowImport);
      break;
    case "partition_import":
      jobs = (
        await tx.partitionImportJob.findMany({
          where: {
            orgId,
            enterpriseKey,
            uploaderId: actor.id,
            status: query.status as PartitionImportJobStatus | undefined,
            ...jobPageFilter("createdAt", "id", after, query)
          },
          orderBy: [{ createdAt: "desc" }, { id: "desc" }],
          take
        })
      ).map(partitionImport);
      break;
    case "workflow_run":
      jobs = (
        await tx.workflowRun.findMany({
          where: {
            orgId,
            workflow: { enterpriseKey },
            status: query.status as WorkflowRunState | undefined,
            AND: [
              { OR: [{ userAccountId: actor.id }, { workflowId: { in: assigned } }] },
              jobPageFilter("startedAt", "id", after, query)
            ]
          },
          include: { workflow: { select: { enterpriseKey: true } } },
          orderBy: [{ startedAt: "desc" }, { id: "desc" }],
          take
        })
      ).map(workflowRun);
      break;
  }
  if (query.kind !== "row_import") {
    const history = await tx.jobHistory.findMany({
      where: {
        orgId,
        kind: query.kind,
        enterpriseKey,
        status: query.status,
        AND: [
          { OR: [{ ownerId: actor.id }, { workflowId: { in: assigned } }] },
          jobPageFilter("createdAt", "jobId", after, query)
        ]
      },
      orderBy: [{ createdAt: "desc" }, { jobId: "desc" }],
      take
    });
    const distinct = new Map(history.map((job) => [job.jobId, archived(job)]));
    for (const job of jobs) distinct.set(job.id, job);
    jobs = [...distinct.values()].sort(
      (a, b) =>
        b.createdAt.getTime() - a.createdAt.getTime() || (a.id > b.id ? -1 : a.id < b.id ? 1 : 0)
    );
  }
  const current = jobs.slice(0, limit);
  const last = current.at(-1);
  return {
    jobs: await withJobMetadata(tx, orgId, current),
    nextCursor:
      jobs.length > limit && last
        ? pageCursor({ at: last.createdAt.toISOString(), id: last.id }, scope, secret)
        : null
  };
}

type Workflow = NonNullable<Awaited<ReturnType<typeof findWorkflow>>>;
function findWorkflow(tx: Tx, actor: Actor, workflowId: string) {
  return tx.enterpriseWorkflow.findFirst({ where: { id: workflowId, orgId: actor.orgId } });
}

async function uploadScopes(tx: Tx, workflow: Workflow) {
  const config = await configuration(tx, workflow);
  if (config?.type !== "meituan-daily-ingestion") return [];
  const scopeRows = await tx.workflowAuthorization.findMany({
    where: { orgId: workflow.orgId, workflowId: workflow.id, revokedAt: null }
  });
  const grants = scopeRows.map((row) => workflowAuthorizationScopeSchema.parse(row.scope));
  const names = config.storeNames;
  const aliases = await workflowStoreKeys(tx, workflow, [
    ...names,
    ...grants.flatMap((grant) => (grant.kind === "upload" ? grant.storeNames : []))
  ]);
  const storesAllowed = new Set(names.map((name) => aliases.get(name)).filter(Boolean));
  return grants
    .flatMap((grant) =>
      grant.kind !== "upload"
        ? []
        : [
            {
              datasets: config.datasets.filter((dataset) =>
                workflowUploadGrantCovers(grant, dataset)
              ),
              keys: grant.storeNames
                .map((name) => aliases.get(name))
                .filter((key): key is string => !!key && storesAllowed.has(key))
            }
          ]
    )
    .filter((scope) => scope.datasets.length && scope.keys.length);
}

// A link is visible through the original uploader's or current assignee's live upload scope.
export async function canUseUploadLink(tx: Tx, workflow: Workflow, link: WorkflowUploadLink) {
  const keys = Array.isArray(link.storeKeys) ? link.storeKeys : [];
  return (
    keys.length > 0 &&
    (await uploadScopes(tx, workflow)).some(
      (scope) =>
        (scope.datasets as string[]).includes(link.dataset) &&
        keys.every((key) => typeof key === "string" && scope.keys.includes(key))
    )
  );
}

export async function appliedReceiptForLink(
  tx: Tx,
  enterpriseKey: string,
  link: WorkflowUploadLink
) {
  if (
    link.kind !== "row_import" ||
    !link.receiptId ||
    !Array.isArray(link.storeKeys) ||
    link.storeKeys.length !== 1 ||
    typeof link.storeKeys[0] !== "string"
  )
    return null;
  const [linkedStoreKey] = link.storeKeys;
  const batch = await tx.importBatch.findFirst({
    where: {
      id: link.jobId,
      orgId: link.orgId,
      dataset: "delivery_ledger",
      status: "applied",
      appliedAt: { not: null },
      archivedAt: null,
      sourceDocument: {
        orgId: link.orgId,
        status: "active",
        archivedAt: null,
        sourceMetadata: { path: "$.enterpriseKey", equals: enterpriseKey }
      }
    },
    select: {
      naturalKey: true,
      sourceDocumentId: true,
      appliedRowCount: true,
      startDate: true,
      sourceDocument: { select: { sourceMetadata: true } }
    }
  });
  if (!batch || batch.naturalKey !== link.receiptId || batch.appliedRowCount < 1) return null;
  const rows = await tx.deliveryLedgerRow.findMany({
    where: {
      orgId: link.orgId,
      importBatchId: link.jobId,
      sourceDocumentId: batch.sourceDocumentId
    },
    select: { payload: true }
  });
  const storeKey = ledgerStoreKeyFromMetadata(batch.sourceDocument.sourceMetadata);
  const date = dateOnly(batch.startDate);
  if (
    !date ||
    rows.length !== batch.appliedRowCount ||
    rows.some(
      ({ payload }) =>
        !payload ||
        typeof payload !== "object" ||
        Array.isArray(payload) ||
        (storeKey ?? payload["store_name"]) !== linkedStoreKey ||
        payload["receipt_id"] !== link.receiptId ||
        payload["purchase_date"] !== date
    )
  )
    return null;
  return { receiptId: link.receiptId, storeKey: linkedStoreKey, purchaseDate: date };
}

async function linkedJobs(
  tx: Tx,
  actor: Actor,
  query: Extract<JobQuery, { mode: "action" | "actions" }>,
  secret: string
) {
  const { orgId } = actor;
  const workflow = await findWorkflow(tx, actor, query.workflowId);
  if (!workflow) fail("JOB_NOT_FOUND");
  const run = await readJob(tx, actor, "workflow_run", query.runId);
  if (!run || run.enterpriseKey !== workflow.enterpriseKey) fail("JOB_NOT_FOUND");
  const assigned = (await assignedWorkflows(tx, actor, { id: workflow.id })).length > 0;
  const limit = query.mode === "actions" ? (query.limit ?? 20) : 1;
  const scope = hash({ actor, workflowId: workflow.id, runId: query.runId, mode: query.mode });
  const after = query.mode === "actions" ? afterCursor(query.cursor, scope, secret) : undefined;
  const scopes = await uploadScopes(tx, workflow);
  if (!scopes.length) return { jobs: [], nextCursor: null };
  const allowed = scopes.map(
    ({ datasets, keys }) =>
      Prisma.sql`(dataset IN (${Prisma.join(datasets)}) AND JSON_LENGTH(store_keys) > 0
      AND JSON_CONTAINS(CAST(${JSON.stringify(keys)} AS JSON), store_keys))`
  );
  const where = [
    Prisma.sql`org_id = ${orgId} AND workflow_id = ${workflow.id} AND run_id = ${query.runId}`,
    Prisma.sql`(${Prisma.join(allowed, " OR ")})`
  ];
  if (!assigned) where.push(Prisma.sql`actor_id = ${actor.id}`);
  if (query.mode === "action") where.push(Prisma.sql`action_id = ${query.actionId}`);
  if (after)
    where.push(Prisma.sql`(created_at < ${new Date(after.at)}
    OR (created_at = ${new Date(after.at)} AND action_id < ${after.id}))`);
  const refs = await tx.$queryRaw<{ actionId: string }[]>`
    SELECT action_id AS actionId FROM workflow_upload_links WHERE ${Prisma.join(where, " AND ")}
    ORDER BY created_at DESC, action_id DESC LIMIT ${limit + 1}
  `;
  const records = await tx.workflowUploadLink.findMany({
    where: {
      orgId,
      workflowId: workflow.id,
      runId: query.runId,
      actionId: { in: refs.map(({ actionId }) => actionId) }
    }
  });
  const byId = new Map(records.map((record) => [record.actionId, record]));
  const links = refs.map(({ actionId }) => byId.get(actionId)!);
  const jobs = [];
  for (const link of links.slice(0, limit)) {
    if (link.result === "receipt_conflict") {
      const receipt = await appliedReceiptForLink(tx, workflow.enterpriseKey, link);
      jobs.push({
        actionId: link.actionId,
        result: "receipt_conflict",
        receiptId: link.receiptId,
        job: receipt ? { kind: "row_import", id: link.jobId, status: "applied", ...receipt } : null
      });
    } else {
      const job = await readJob(tx, actor, link.kind as JobKind, link.jobId);
      if (job) jobs.push({ actionId: link.actionId, result: "accepted", job });
      else if (assigned) {
        const status =
          link.kind === "partition_import"
            ? ((
                await tx.partitionImportJob.findFirst({
                  where: { id: link.jobId, orgId },
                  select: { status: true }
                })
              )?.status ??
              (
                await tx.jobHistory.findUnique({
                  where: { orgId_kind_jobId: { orgId, kind: link.kind, jobId: link.jobId } },
                  select: { status: true }
                })
              )?.status)
            : (
                await tx.importBatch.findFirst({
                  where: { id: link.jobId, orgId },
                  select: { status: true }
                })
              )?.status;
        jobs.push({
          actionId: link.actionId,
          result: "accepted",
          job: status ? { id: link.jobId, kind: link.kind, status } : null
        });
      }
    }
  }
  const last = links[Math.min(links.length, limit) - 1];
  return {
    jobs,
    nextCursor:
      links.length > limit && last
        ? pageCursor({ at: last.createdAt.toISOString(), id: last.actionId }, scope, secret)
        : null
  };
}

export async function queryJobs(tx: Tx, actor: Actor, query: JobQuery, secret: string) {
  if (query.mode === "list") return listJobs(tx, actor, query, secret);
  if (query.mode === "action" || query.mode === "actions")
    return linkedJobs(tx, actor, query, secret);
  const orgId = actor.orgId;
  let job: JobRow | null = null;
  if (query.mode === "detail") {
    job = await readJob(tx, actor, query.kind, query.id);
  } else {
    const enterpriseKey = normalizeEnterpriseIdentity(query.enterpriseKey).enterpriseKey;
    if (query.mode === "receipt" || query.kind === "row_import") {
      const batch = await tx.importBatch.findFirst({
        where: {
          orgId,
          ...(query.mode === "receipt"
            ? { dataset: "delivery_ledger", naturalKey: query.receiptId }
            : { idempotencyKey: query.idempotencyKey }),
          sourceDocument: {
            orgId,
            uploaderId: actor.id,
            sourceMetadata: { path: "$.enterpriseKey", equals: enterpriseKey }
          }
        },
        select: { ...importSelect, idempotencyKey: true }
      });
      if (
        batch &&
        (query.mode === "receipt"
          ? batch.naturalKey === query.receiptId
          : batch.idempotencyKey === query.idempotencyKey)
      )
        job = rowImport(batch);
    } else {
      const batch = await tx.partitionImportJob.findFirst({
        where: { orgId, enterpriseKey, uploaderId: actor.id, idempotencyKey: query.idempotencyKey }
      });
      if (batch?.idempotencyKey === query.idempotencyKey) job = partitionImport(batch);
      else {
        const record = await tx.jobHistory.findFirst({
          where: {
            orgId,
            kind: query.kind,
            enterpriseKey,
            ownerId: actor.id,
            idempotencyHash: jobIdempotencyHash(query.idempotencyKey)
          },
          orderBy: [{ createdAt: "desc" }, { jobId: "desc" }]
        });
        if (record) job = archived(record);
      }
    }
  }
  return { jobs: await withJobMetadata(tx, orgId, job ? [job] : []), nextCursor: null };
}
