import { Prisma } from "@prisma/client";
import {
  WORKFLOW_V1_EVIDENCE_LAUNCHER_VERSION,
  workflowActionIdentitySchema,
  workflowLivePolicyAllows,
  type WorkflowLivePolicy,
  workflowActionReceiptSchema,
  workflowAuthorizationScopeSchema,
  workflowSourceIdentityKey,
  workflowReadinessCheckSchema,
  type WorkflowActionIdentity,
  type WorkflowActionIntent,
  type WorkflowActionReceipt,
  type WorkflowRunSnapshot,
  type AuthorizationSnapshot
} from "@smedc/domain";
import type { WorkflowOperationInputs } from "@smedc/mcp-contract";
import { launcherVersionAtLeast } from "../request-audit-context.js";
import { z } from "zod";
import {
  audit,
  fail,
  hash,
  json,
  requireRead,
  type Actor,
  type Tx,
  type Workflow
} from "./repository.js";
import { requireBinding } from "./runs.js";
import { getInstallation } from "./installations.js";
// Match business-analysis build_query_plan.py daily_history, including completed
// calendar months and Feb29 clamping when comparing the previous calendar year.
function weeklyBusinessHistoryWindow(endDate: string) {
  const end = new Date(endDate + "T00:00:00Z");
  const daysBefore = (days: number) => new Date(end.getTime() - days * 86400000);
  const previousYear = (value: Date) => {
    const result = new Date(value);
    const month = result.getUTCMonth();
    result.setUTCFullYear(result.getUTCFullYear() - 1);
    if (result.getUTCMonth() !== month) result.setUTCDate(0);
    return result;
  };
  const lastMonthEnd = new Date(end);
  lastMonthEnd.setUTCMonth(lastMonthEnd.getUTCMonth() + 1, 0);
  if (end.getTime() !== lastMonthEnd.getTime()) {
    lastMonthEnd.setUTCMonth(lastMonthEnd.getUTCMonth(), 0);
  }
  const monthlyTrendStart = new Date(lastMonthEnd);
  monthlyTrendStart.setUTCDate(1);
  monthlyTrendStart.setUTCMonth(monthlyTrendStart.getUTCMonth() - 11);
  const earliest = Math.min(
    ...[
      daysBefore(363),
      daysBefore(727),
      previousYear(daysBefore(364)),
      previousYear(monthlyTrendStart)
    ].map((date) => date.getTime())
  );
  return { startDate: new Date(earliest).toISOString().slice(0, 10), endDate };
}
export function deduplicationKeys(
  identity: WorkflowActionIdentity,
  readBinding?: { runId: string; actionId: string }
): string[] {
  if (identity.kind === "download")
    return [
      hash([
        "download",
        readBinding?.runId,
        readBinding?.actionId,
        { ...identity, storeNames: [...identity.storeNames].sort() }
      ])
    ];
  if (identity.kind === "review_publish")
    return [
      hash([
        identity.kind,
        workflowSourceIdentityKey(identity.source),
        identity.feedbackId,
        identity.purpose
      ])
    ];
  if (identity.kind === "email") {
    if (identity.purpose === "review_drafts")
      return [
        ...new Set(
          identity.reviewIdentities!.map((r) =>
            hash([
              "review_drafts",
              workflowSourceIdentityKey(r.source),
              r.feedbackId,
              r.recipient.toLowerCase()
            ])
          )
        )
      ].sort();
    return identity.recipients
      .map((r) =>
        hash([
          "email",
          identity.purpose,
          [...identity.storeNames].sort(),
          identity.window,
          r.toLowerCase(),
          identity.deliveryVersion
        ])
      )
      .sort();
  }
  if (identity.kind === "review_sync")
    return [
      hash([
        identity.kind,
        workflowSourceIdentityKey(identity.source),
        [...identity.storeNames].sort(),
        identity.window,
        identity.observedFactsHash
      ])
    ];
  return [hash({ ...identity, storeNames: [...identity.storeNames].sort() })];
}
function selected(actual: string[], allowed: string[]) {
  return actual.every((s) => allowed.includes(s));
}
export async function authorizeAction(
  tx: Tx,
  actor: Actor,
  auth: AuthorizationSnapshot,
  workflow: Workflow,
  snapshot: WorkflowRunSnapshot,
  intent: WorkflowActionIntent,
  livePolicy: WorkflowLivePolicy
) {
  if (auth.mode !== "enabled") fail("WORKFLOW_PERMISSION_DENIED");
  const identity = intent.identity;
  const config = snapshot.configuration;
  if (!workflowLivePolicyAllows(livePolicy, identity, config.type))
    fail("WORKFLOW_PERMISSION_DENIED");
  const stores = identity.kind === "review_publish" ? [identity.storeName] : identity.storeNames;
  if (config.type === "meituan-review-operations") {
    const ignored = (source: Parameters<typeof workflowSourceIdentityKey>[0], feedbackId: string) =>
      config.ignoredReviewIdentities.some(
        (excluded) =>
          workflowSourceIdentityKey(excluded.source) === workflowSourceIdentityKey(source) &&
          excluded.feedbackId === feedbackId
      );
    if (
      (identity.kind === "review_publish" && ignored(identity.source, identity.feedbackId)) ||
      (identity.kind === "email" &&
        identity.reviewIdentities?.some((review) => ignored(review.source, review.feedbackId)))
    )
      fail("WORKFLOW_PERMISSION_DENIED");
  }
  if (!selected(stores, config.storeNames)) fail("WORKFLOW_PERMISSION_DENIED");
  if (
    "window" in identity &&
    (identity.window.startDate < snapshot.window.startDate ||
      identity.window.endDate > snapshot.window.endDate)
  ) {
    // Only business history expands for weekly trends; other reads keep comparison windows.
    if (identity.kind !== "download" || config.type !== "weekly-business-report")
      fail("WORKFLOW_PERMISSION_DENIED");
    const allowed =
      identity.dataset === "business"
        ? [weeklyBusinessHistoryWindow(snapshot.window.endDate)]
        : [0, -7, -364].map((offset) => ({
            startDate: new Date(Date.parse(snapshot.window.startDate) + offset * 86400000)
              .toISOString()
              .slice(0, 10),
            endDate: new Date(Date.parse(snapshot.window.endDate) + offset * 86400000)
              .toISOString()
              .slice(0, 10)
          }));
    if (
      !allowed.some(
        (w) => identity.window.startDate >= w.startDate && identity.window.endDate <= w.endDate
      )
    )
      fail("WORKFLOW_PERMISSION_DENIED");
  }
  if (
    identity.kind === "upload" &&
    (config.type !== "meituan-daily-ingestion" || !config.datasets.includes(identity.dataset))
  )
    fail("WORKFLOW_PERMISSION_DENIED");
  if (identity.kind === "download") {
    if (config.type !== "weekly-business-report") fail("WORKFLOW_PERMISSION_DENIED");
    requireRead(auth, workflow, stores, [identity.dataset]);
  }
  const verifySource = (
    source: Parameters<typeof workflowSourceIdentityKey>[0],
    store?: string
  ) => {
    const mapping = snapshot.integration.storeMappings.find(
      (m) => workflowSourceIdentityKey(m.source) === workflowSourceIdentityKey(source)
    );
    if (!mapping || (store ? mapping.storeName !== store : !stores.includes(mapping.storeName)))
      fail("WORKFLOW_SOURCE_MAPPING_CONFLICT");
  };
  if (identity.kind === "review_publish" || identity.kind === "review_sync") {
    if (
      config.type !== "meituan-review-operations" ||
      !config.channels.includes(identity.source.channel as "meituan" | "dianping")
    )
      fail("WORKFLOW_PERMISSION_DENIED");
    if (identity.kind === "review_sync" && identity.storeNames.length !== 1)
      fail("WORKFLOW_SOURCE_MAPPING_CONFLICT");
    verifySource(
      identity.source,
      identity.kind === "review_publish" ? identity.storeName : undefined
    );
    if (
      identity.kind === "review_publish" &&
      (!config.publication.enabled || !config.publication.storeNames.includes(identity.storeName))
    )
      fail("WORKFLOW_PERMISSION_DENIED");
  }
  if (identity.kind === "email") {
    const mail =
      identity.purpose === "review_drafts" && config.type === "meituan-review-operations"
        ? config.draftNotification
        : identity.purpose === "weekly_report" && config.type === "weekly-business-report"
          ? config.delivery
          : null;
    if (
      identity.purpose !== "exception" &&
      (!mail?.enabled ||
        identity.sender.toLowerCase() !== mail.allowedSender?.toLowerCase() ||
        !selected(
          identity.recipients.map((s) => s.toLowerCase()),
          mail.recipients.map((s) => s.toLowerCase())
        ))
    )
      fail("WORKFLOW_PERMISSION_DENIED");
    for (const review of identity.reviewIdentities ?? []) {
      verifySource(review.source);
      if (
        config.type !== "meituan-review-operations" ||
        !config.channels.includes(review.source.channel as "meituan" | "dianping")
      )
        fail("WORKFLOW_PERMISSION_DENIED");
    }
    if (!intent.artifactHash || !intent.correlationMarker) fail("WORKFLOW_PERMISSION_DENIED");
  }
  if (identity.kind === "review_publish" && (!intent.artifactHash || !intent.correlationMarker))
    fail("WORKFLOW_PERMISSION_DENIED");
  const scopes = (
    await tx.workflowAuthorization.findMany({
      where: { orgId: actor.orgId, workflowId: workflow.id, revokedAt: null }
    })
  ).map((a) => workflowAuthorizationScopeSchema.parse(a.scope));
  const allowed = scopes.some((scope) => {
    if (scope.kind !== identity.kind || !selected(stores, scope.storeNames)) return false;
    if (
      (scope.kind === "upload" || scope.kind === "download") &&
      (identity.kind === "upload" || identity.kind === "download")
    )
      return (scope.datasets as string[]).includes(identity.dataset);
    if (
      (scope.kind === "review_publish" || scope.kind === "review_sync") &&
      (identity.kind === "review_publish" || identity.kind === "review_sync")
    )
      return (scope.channels as string[]).includes(identity.source.channel);
    if (scope.kind === "email" && identity.kind === "email")
      return (
        scope.purpose === identity.purpose &&
        scope.allowedSender.toLowerCase() === identity.sender.toLowerCase() &&
        scope.deliveryVersion === identity.deliveryVersion &&
        selected(
          identity.recipients.map((s) => s.toLowerCase()),
          scope.recipients.map((s) => s.toLowerCase())
        )
      );
    return false;
  });
  if (!allowed) fail("WORKFLOW_PERMISSION_DENIED");
}
export async function claimAction(
  tx: Tx,
  actor: Actor,
  workflow: Workflow,
  runId: string,
  intent: WorkflowActionIntent,
  now: Date
) {
  const keys = deduplicationKeys(intent.identity, { runId, actionId: intent.actionId });
  const rows = await tx.workflowActionDeduplication.findMany({
    where: { orgId: actor.orgId, workflowId: workflow.id, key: { in: keys } },
    include: { action: true }
  });
  if (rows.length) {
    const existing = rows[0]!.action;
    // A partial batch cannot authorize the unclaimed remainder. Caller must inspect and split it.
    return {
      actionId: existing.actionId,
      state: existing.state,
      permitted: false,
      conflictActionIds: [...new Set(rows.map((r) => r.actionId))],
      claimedItems: rows.length,
      requestedItems: keys.length,
      identityHash: hash(existing.identity),
      receipt: existing.receipt ? workflowActionReceiptSchema.parse(existing.receipt) : null
    };
  }
  const sameId = await tx.workflowAction.findUnique({
    where: {
      orgId_workflowId_actionId: {
        orgId: actor.orgId,
        workflowId: workflow.id,
        actionId: intent.actionId
      }
    }
  });
  if (sameId) {
    if (sameId.state !== "failed" || sameId.idempotencyKey !== hash(keys))
      fail("WORKFLOW_VERSION_CONFLICT");
    const receipt = workflowActionReceiptSchema.parse(sameId.receipt);
    if (
      receipt.state !== "failed" ||
      !["request_rejected", "manual_resolution", "provider_readback"].includes(receipt.evidence)
    )
      fail("WORKFLOW_ACTION_UNKNOWN");
    await tx.workflowAction.update({
      where: {
        orgId_workflowId_actionId: {
          orgId: actor.orgId,
          workflowId: workflow.id,
          actionId: intent.actionId
        }
      },
      data: {
        runId,
        state: "intent",
        identity: json(intent.identity),
        artifactHash: intent.artifactHash ?? null,
        correlationMarker: intent.correlationMarker ?? null,
        receipt: Prisma.JsonNull,
        createdAt: now
      }
    });
  } else
    await tx.workflowAction.create({
      data: {
        orgId: actor.orgId,
        workflowId: workflow.id,
        actionId: intent.actionId,
        runId,
        idempotencyKey: hash(keys),
        identity: json(intent.identity),
        artifactHash: intent.artifactHash,
        correlationMarker: intent.correlationMarker,
        createdAt: now
      }
    });
  await tx.workflowActionDeduplication.createMany({
    data: keys.map((key) => ({
      orgId: actor.orgId,
      workflowId: workflow.id,
      key,
      actionId: intent.actionId
    }))
  });
  return {
    actionId: intent.actionId,
    state: "intent",
    permitted: true,
    identityHash: hash(intent.identity)
  };
}
async function verifyServiceReceipt(
  tx: Tx,
  actor: Actor,
  workflow: Workflow,
  identity: WorkflowActionIdentity,
  receipt: WorkflowActionReceipt
) {
  if (receipt.state !== "confirmed" || !receipt.jobId) fail("WORKFLOW_ACTION_UNKNOWN");
  if (identity.kind === "upload") {
    if (identity.dataset === "delivery_ledger") {
      const batch = await tx.importBatch.findFirst({
        where: {
          orgId: actor.orgId,
          id: receipt.jobId,
          dataset: "delivery_ledger",
          status: "applied"
        },
        include: { sourceDocument: true }
      });
      if (
        !batch ||
        batch.sourceDocument.checksumSha256 !== identity.sourceHash ||
        !batch.appliedAt ||
        batch.archivedAt ||
        !batch.naturalKey ||
        batch.sourceDocument.status !== "active" ||
        batch.sourceDocument.archivedAt
      )
        fail("WORKFLOW_ACTION_UNKNOWN");
      // Receipt uploads derive dates from their original file, not caller date metadata.
      // Inspect only aggregate facts from the authoritative published receipt rows.
      const [facts] = await tx.$queryRaw<
        Array<{
          rowCount: bigint;
          invalidCount: bigint;
          firstDate: string | null;
          lastDate: string | null;
        }>
      >`
        SELECT COUNT(*) AS rowCount,
          COALESCE(SUM(CASE WHEN
            JSON_UNQUOTE(JSON_EXTRACT(payload, '$.store_name')) IS NULL OR
            CAST(JSON_UNQUOTE(JSON_EXTRACT(payload, '$.store_name')) AS BINARY) NOT IN (${Prisma.join(identity.storeNames)}) OR
            JSON_UNQUOTE(JSON_EXTRACT(payload, '$.receipt_id')) IS NULL OR
            CAST(JSON_UNQUOTE(JSON_EXTRACT(payload, '$.receipt_id')) AS BINARY) <> CAST(${batch.naturalKey} AS BINARY) OR
            JSON_UNQUOTE(JSON_EXTRACT(payload, '$.purchase_date')) IS NULL
            THEN 1 ELSE 0 END), 0) AS invalidCount,
          MIN(JSON_UNQUOTE(JSON_EXTRACT(payload, '$.purchase_date'))) AS firstDate,
          MAX(JSON_UNQUOTE(JSON_EXTRACT(payload, '$.purchase_date'))) AS lastDate
        FROM delivery_ledger_rows
        WHERE org_id = ${actor.orgId} AND import_batch_id = ${batch.id} AND source_document_id = ${batch.sourceDocumentId}
      `;
      if (
        !facts ||
        Number(facts.rowCount) !== batch.appliedRowCount ||
        Number(facts.rowCount) < 1 ||
        Number(facts.invalidCount) !== 0 ||
        facts.firstDate !== identity.window.startDate ||
        facts.lastDate !== identity.window.endDate
      )
        fail("WORKFLOW_ACTION_UNKNOWN");
      const resources = await tx.businessResource.findMany({
        where: {
          orgId: actor.orgId,
          sourceDocumentId: batch.sourceDocumentId,
          valid: true,
          kind: "source_fragment"
        },
        include: { scopes: true }
      });
      if (
        !resources.length ||
        resources.some(
          (r) =>
            !r.scopes.length ||
            r.scopes.some(
              (scope) =>
                scope.enterpriseKey !== workflow.enterpriseKey ||
                !scope.storeName ||
                !identity.storeNames.includes(scope.storeName)
            )
        )
      )
        fail("WORKFLOW_ACTION_UNKNOWN");
      return;
    }
    const job = await tx.partitionImportJob.findFirst({
      where: {
        orgId: actor.orgId,
        id: receipt.jobId,
        enterpriseKey: workflow.enterpriseKey,
        dataset: identity.dataset,
        sourceChecksumSha256: identity.sourceHash,
        status: "published"
      }
    });
    if (
      !job ||
      job.sourceStartDate.toISOString().slice(0, 10) !== identity.window.startDate ||
      job.sourceEndDate.toISOString().slice(0, 10) !== identity.window.endDate ||
      (identity.dataset === "in_store_orders" && job.orderScope !== "settled_only")
    )
      fail("WORKFLOW_ACTION_UNKNOWN");
    const partitions = await tx.structuredPartition.findMany({
      where: { orgId: actor.orgId, publishedByJobId: job.id },
      select: { storeName: true, businessDate: true }
    });
    if (
      partitions.length !== job.partitionCount ||
      !partitions.length ||
      partitions.some(
        (p) =>
          !identity.storeNames.includes(p.storeName) ||
          p.businessDate.toISOString().slice(0, 10) < identity.window.startDate ||
          p.businessDate.toISOString().slice(0, 10) > identity.window.endDate
      )
    )
      fail("WORKFLOW_ACTION_UNKNOWN");
    return;
  }
  // A completed server package does not prove the client downloaded or verified it.
  fail("WORKFLOW_ACTION_UNKNOWN");
}
export async function actionOperation(
  tx: Tx,
  actor: Actor,
  auth: AuthorizationSnapshot,
  workflow: Workflow,
  op: WorkflowOperationInputs["record_workflow_action"]["operation"],
  now: Date
) {
  if (op.kind === "get")
    return {
      actions: (
        await tx.workflowAction.findMany({
          where: { orgId: actor.orgId, workflowId: workflow.id, actionId: { in: op.actionIds } }
        })
      ).map((a) => ({
        actionId: a.actionId,
        runId: a.runId,
        state: a.state,
        identity: workflowActionIdentitySchema.parse(a.identity),
        identityHash: hash(a.identity),
        artifactHash: a.artifactHash,
        correlationMarker: a.correlationMarker,
        receipt: a.receipt ? workflowActionReceiptSchema.parse(a.receipt) : null
      }))
    };
  if (op.kind === "intent") {
    const bound = await requireBinding(tx, actor, workflow, op, now);
    for (const intent of op.actions) {
      await authorizeAction(tx, actor, auth, workflow, bound.snapshot, intent, bound.livePolicy);
      if (intent.identity.kind === "email") {
        const checks = z
          .array(workflowReadinessCheckSchema)
          .parse(bound.installation.readinessChecks ?? []);
        if (
          ["email_identity", "sent_mail_lookup"].some(
            (capability) =>
              !checks.some(
                (c) =>
                  c.capability === capability &&
                  c.status === "ready" &&
                  Date.parse(c.checkedAt) > now.getTime() - 86400000
              )
          )
        )
          fail("WORKFLOW_SOURCE_UNAVAILABLE");
      }
    }
    const actions = [];
    for (const intent of op.actions)
      actions.push(await claimAction(tx, actor, workflow, op.runId, intent, now));
    await audit(tx, actor, "intent", workflow.id, {
      runId: op.runId,
      actionIds: op.actions.map((a) => a.actionId)
    });
    return { actions };
  }
  // Recording evidence never authorizes another external action; allow an in-flight result after pause/expiry.
  const run = await tx.workflowRun.findFirst({
    where: { orgId: actor.orgId, workflowId: workflow.id, id: op.runId }
  });
  if (!run) fail("WORKFLOW_INSTALLATION_MISMATCH");
  const original =
    run.employeeId === actor.id &&
    run.installationId === op.installationId &&
    run.assignmentEpoch === op.assignmentEpoch;
  const assigned =
    workflow.assignedInstallationId === op.installationId &&
    workflow.assignmentEpoch === op.assignmentEpoch;
  if (!original && !assigned) fail("WORKFLOW_INSTALLATION_MISMATCH");
  if (assigned) await getInstallation(tx, actor, workflow, op.installationId);
  const receipts = op.kind === "record_receipts" ? op.receipts : [op.receipt];
  for (const receipt of receipts) {
    const action = await tx.workflowAction.findUnique({
      where: {
        orgId_workflowId_actionId: {
          orgId: actor.orgId,
          workflowId: workflow.id,
          actionId: receipt.actionId
        }
      }
    });
    if (
      !action ||
      (action.runId !== op.runId &&
        !(op.kind === "resolve_unknown" && assigned && action.state === "unknown"))
    )
      fail("WORKFLOW_ACTION_UNKNOWN");
    if (action.state === "confirmed") {
      if (receipt.state !== "confirmed" || hash(action.receipt) !== hash(receipt))
        fail("WORKFLOW_ACTION_UNKNOWN");
      continue;
    }
    if (op.kind === "resolve_unknown" && action.state !== "unknown" && action.state !== "intent")
      fail("WORKFLOW_ACTION_UNKNOWN");
    if (action.state === "unknown" && receipt.evidence === "request_rejected")
      fail("WORKFLOW_ACTION_UNKNOWN");
    const identity = workflowActionIdentitySchema.parse(action.identity);
    if (receipt.evidence === "service_status")
      await verifyServiceReceipt(tx, actor, workflow, identity, receipt);
    if (receipt.evidence === "launcher_transfer") {
      const bound = await requireBinding(tx, actor, workflow, op, now);
      await authorizeAction(
        tx,
        actor,
        auth,
        workflow,
        bound.snapshot,
        {
          actionId: action.actionId,
          identity
        },
        bound.livePolicy
      );
      const proof = receipt.launcherTransfer;
      if (
        identity.kind !== "download" ||
        receipt.state !== "confirmed" ||
        !proof ||
        proof.identityHash !== hash(action.identity) ||
        (identity.manifestHash && identity.manifestHash !== proof.manifestHash) ||
        proof.resultHash !== receipt.resultHash ||
        !launcherVersionAtLeast(proof.launcherVersion, WORKFLOW_V1_EVIDENCE_LAUNCHER_VERSION) ||
        proof.verifiedAt !== receipt.verifiedAt ||
        Date.parse(proof.verifiedAt) < action.createdAt.getTime() - 60000 ||
        Date.parse(proof.verifiedAt) > now.getTime() + 60000 ||
        proof.fileCount !== proof.partitionCount
      )
        fail("WORKFLOW_ACTION_UNKNOWN");
      if (proof.requestId) {
        const request = await tx.partitionDownloadRequest.findFirst({
          where: {
            orgId: actor.orgId,
            id: proof.requestId,
            requesterId: actor.id,
            status: "succeeded"
          }
        });
        if (!request) fail("WORKFLOW_ACTION_UNKNOWN");
        const scope = z
          .object({
            enterpriseKey: z.string(),
            dataset: z.string(),
            startDate: z.string(),
            endDate: z.string()
          })
          .passthrough()
          .parse(request.scope);
        const manifest = z
          .array(z.object({ storeName: z.string() }).passthrough())
          .parse(request.manifest);
        if (
          scope.enterpriseKey !== workflow.enterpriseKey ||
          scope.dataset !== identity.dataset ||
          scope.startDate !== identity.window.startDate ||
          scope.endDate !== identity.window.endDate ||
          manifest.some((entry) => !identity.storeNames.includes(entry.storeName)) ||
          request.partitionCount !== proof.partitionCount ||
          request.totalRowCount.toString() !== proof.totalRowCount
        )
          fail("WORKFLOW_ACTION_UNKNOWN");
      }
    }
    if (receipt.evidence === "smedc_readback") {
      const proof = receipt.smedcReadback;
      if (
        identity.kind !== "review_sync" ||
        receipt.state !== "confirmed" ||
        !proof ||
        proof.identityHash !== hash(action.identity) ||
        proof.observedFactsHash !== identity.observedFactsHash ||
        proof.resultHash !== receipt.resultHash ||
        proof.observedAt !== receipt.verifiedAt ||
        Date.parse(proof.observedAt) < action.createdAt.getTime() - 60000 ||
        Date.parse(proof.observedAt) > now.getTime() + 60000 ||
        proof.reviewCount !== proof.matchedCount ||
        proof.reviewCount !== proof.recordIds.length
      )
        fail("WORKFLOW_ACTION_UNKNOWN");
      requireRead(auth, workflow, identity.storeNames, ["store_reviews"]);
      // Verify the bounded row identities and current permissions. Full field comparison and
      // source-account/POI namespace binding remain authenticated client attestations.
      const rows = await tx.storeReview.findMany({
        where: {
          orgId: actor.orgId,
          enterpriseKey: workflow.enterpriseKey,
          id: { in: proof.recordIds },
          storeName: { in: identity.storeNames },
          source: identity.source.channel === "meituan" ? "美团评价" : "点评评价",
          reviewedAt: {
            gte: new Date(identity.window.startDate + "T00:00:00+08:00"),
            lte: new Date(identity.window.endDate + "T23:59:59.999+08:00")
          }
        },
        select: { id: true, enterpriseKey: true, storeName: true, source: true }
      });
      const requestedIds = new Set(proof.recordIds);
      if (
        rows.length !== proof.recordIds.length ||
        rows.some(
          (row) =>
            !requestedIds.has(row.id) ||
            row.enterpriseKey !== workflow.enterpriseKey ||
            !identity.storeNames.includes(row.storeName) ||
            row.source !== (identity.source.channel === "meituan" ? "美团评价" : "点评评价")
        )
      )
        fail("WORKFLOW_ACTION_UNKNOWN");
      const rowStores = new Map(rows.map((row) => [`store-review:${row.id}`, row.storeName]));
      const resources = await tx.businessResource.findMany({
        where: {
          orgId: actor.orgId,
          kind: "store_review",
          valid: true,
          categoryId: auth.categories.find((category) => category.key === "store_reviews")!.id,
          resourceKey: { in: rows.map((row) => `store-review:${row.id}`) }
        },
        include: { scopes: true }
      });
      if (
        resources.length !== rows.length ||
        resources.some(
          (resource) =>
            resource.scopes.length !== 1 ||
            resource.scopes[0]!.enterpriseKey !== workflow.enterpriseKey ||
            resource.scopes[0]!.ownership !== "store" ||
            resource.scopes[0]!.storeName !== rowStores.get(resource.resourceKey)
        )
      )
        fail("WORKFLOW_ACTION_UNKNOWN");
    }
    if (receipt.evidence === "provider_readback") {
      const proof = receipt.providerReadback;
      if (
        !proof ||
        !["email", "review_publish"].includes(identity.kind) ||
        proof.identityHash !== hash(action.identity) ||
        proof.artifactHash !== action.artifactHash ||
        proof.correlationMarker !== action.correlationMarker ||
        proof.providerReceiptId !== receipt.receiptId ||
        Date.parse(proof.observedAt) < action.createdAt.getTime() - 60000 ||
        Date.parse(proof.observedAt) > now.getTime() + 60000 ||
        (receipt.state === "confirmed"
          ? proof.outcome !== (identity.kind === "email" ? "sent" : "published")
          : receipt.state !== "failed" || proof.outcome !== "not_executed")
      )
        fail("WORKFLOW_ACTION_UNKNOWN");
    }
    if (
      receipt.state === "failed" &&
      !["request_rejected", "manual_resolution", "provider_readback"].includes(receipt.evidence)
    )
      fail("WORKFLOW_ACTION_UNKNOWN");
    if (receipt.evidence === "request_rejected" && receipt.state !== "failed")
      fail("WORKFLOW_ACTION_UNKNOWN");
    if (Date.parse(receipt.verifiedAt) > now.getTime() + 60000) fail("WORKFLOW_ACTION_UNKNOWN");
    await tx.workflowAction.update({
      where: {
        orgId_workflowId_actionId: {
          orgId: actor.orgId,
          workflowId: workflow.id,
          actionId: receipt.actionId
        }
      },
      data: {
        state: receipt.state,
        receipt: json(receipt),
        confirmedAt: receipt.state === "confirmed" ? now : null
      }
    });
    if (receipt.state === "failed")
      await tx.workflowActionDeduplication.deleteMany({
        where: { orgId: actor.orgId, workflowId: workflow.id, actionId: receipt.actionId }
      });
    await audit(tx, actor, "receipt", workflow.id, {
      runId: op.runId,
      actionId: receipt.actionId,
      state: receipt.state,
      verificationSource:
        receipt.evidence === "provider_readback"
          ? "client_provider_readback"
          : receipt.evidence === "launcher_transfer"
            ? "client_launcher_transfer"
            : receipt.evidence === "smedc_readback"
              ? "client_smedc_readback"
              : receipt.evidence,
      ...(receipt.reason ? { reason: receipt.reason } : {})
    });
  }
  return { recorded: receipts.length, receipts };
}
