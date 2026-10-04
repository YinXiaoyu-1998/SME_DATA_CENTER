import { createHash } from "node:crypto";
import { assertLedgerPartitionObjectKeyFits, normalizeLedgerObjectKeyPrefix } from "./keys.js";
import type {
  LedgerArchiveRepository,
  LedgerInternalSelection,
  LedgerItemStatus,
  LedgerReconciliationObservation,
  LedgerRequestStatus
} from "./repository.js";
import {
  assertLedgerDate,
  ledgerScopeDates,
  LEDGER_SCOPE_MAX_PARTITIONS,
  parseLedgerScope
} from "./scope.js";
import type { LedgerActor, LedgerPartitionKey, LedgerRequestRef, LedgerScope } from "./types.js";

export function reduceLedgerRequestStatus(statuses: LedgerItemStatus[]): LedgerRequestStatus {
  if (
    statuses.length === 0 ||
    statuses.every((status) => status === "empty" || status === "succeeded")
  )
    return "succeeded";
  if (statuses.every((status) => status === "queued")) return "queued";
  if (statuses.some((status) => status === "queued" || status === "running")) return "running";
  return statuses.some((status) => status === "empty" || status === "succeeded")
    ? "partial_failed"
    : "failed";
}

function fingerprint(value: object): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function validateSubmission(orgId: string, actor: LedgerActor, idempotencyKey: string) {
  if (!orgId || orgId.length > 64 || !idempotencyKey || idempotencyKey.length > 255)
    throw new Error("LEDGER_REQUEST_INVALID");
  if (
    (actor.kind === "employee" && (!actor.employeeId || actor.employeeId.length > 32)) ||
    (actor.kind === "operator" && (!actor.label || actor.label.length > 255)) ||
    (actor.kind === "system_reconciler" &&
      (!actor.reconciliationRunId || actor.reconciliationRunId.length > 32)) ||
    !["employee", "operator", "system_reconciler"].includes(actor.kind)
  )
    throw new Error("LEDGER_ACTOR_INVALID");
}

function canonicalActor(actor: LedgerActor): LedgerActor {
  if (actor.kind === "employee") return { kind: actor.kind, employeeId: actor.employeeId };
  if (actor.kind === "operator") return { kind: actor.kind, label: actor.label };
  return { kind: actor.kind, reconciliationRunId: actor.reconciliationRunId };
}

export function normalizeLedgerInternalSelection(
  selection: LedgerInternalSelection
): LedgerInternalSelection {
  const storeNames =
    selection.storeNames === null
      ? null
      : [...new Set(selection.storeNames)].sort((a, b) =>
          Buffer.compare(Buffer.from(a), Buffer.from(b))
        );
  if (storeNames && (!storeNames.length || storeNames.some((name) => !name || name.length > 512)))
    throw new Error("LEDGER_PARTITION_KEY_INVALID");
  if ("dates" in selection) {
    const dates = selection.dates === null ? null : [...new Set(selection.dates)].sort();
    if (dates && !dates.length) throw new Error("LEDGER_SCOPE_INVALID");
    dates?.forEach(assertLedgerDate);
    return { storeNames, dates };
  }
  assertLedgerDate(selection.startDate);
  assertLedgerDate(selection.endDate);
  if (selection.startDate > selection.endDate) throw new Error("LEDGER_SCOPE_INVALID");
  return { storeNames, startDate: selection.startDate, endDate: selection.endDate };
}

export function createLedgerArchiveService(repository: LedgerArchiveRepository) {
  const objectKeyPrefix = normalizeLedgerObjectKeyPrefix(repository.objectKeyPrefix ?? "");
  function validateScopeObjectKeys(orgId: string, scope: LedgerScope) {
    // Every normalized date has the same fixed width, so one date proves each store path.
    const purchaseDate = ledgerScopeDates(scope)[0]!;
    scope.storeNames.forEach((storeName) =>
      assertLedgerPartitionObjectKeyFits({ orgId, storeName, purchaseDate }, objectKeyPrefix)
    );
  }
  async function resolveScope(orgId: string, scope: LedgerScope) {
    const keys: LedgerPartitionKey[] = [];
    let cursor: string | undefined;
    do {
      const page = await repository.listPartitionKeys({ orgId, scope, cursor });
      page.keys.forEach((key) => assertLedgerPartitionObjectKeyFits(key, objectKeyPrefix));
      keys.push(...page.keys);
      if (keys.length > LEDGER_SCOPE_MAX_PARTITIONS) throw new Error("LEDGER_SCOPE_LIMIT_EXCEEDED");
      cursor = page.nextCursor ?? undefined;
    } while (cursor);
    return keys;
  }

  async function* previewAllPartitions(input: {
    orgId: string;
    selection: LedgerInternalSelection;
    cursor?: string;
  }) {
    if (!input.orgId || input.orgId.length > 64) throw new Error("LEDGER_REQUEST_INVALID");
    const selection = normalizeLedgerInternalSelection(input.selection);
    let cursor = input.cursor;
    do {
      const page = await repository.listPartitionKeys({
        orgId: input.orgId,
        ...(cursor ? { cursor } : {})
      });
      const keys = page.keys.filter(
        (key) =>
          (selection.storeNames === null || selection.storeNames.includes(key.storeName)) &&
          ("dates" in selection
            ? selection.dates == null || selection.dates.includes(key.purchaseDate)
            : key.purchaseDate >= selection.startDate && key.purchaseDate <= selection.endDate)
      );
      keys.forEach((key) => {
        assertLedgerDate(key.purchaseDate);
        assertLedgerPartitionObjectKeyFits(key, objectKeyPrefix);
      });
      yield { keys, nextCursor: page.nextCursor };
      cursor = page.nextCursor ?? undefined;
    } while (cursor);
  }
  async function* previewFailedRequest(input: {
    orgId: string;
    requestId: string;
    cursor?: string;
  }) {
    let cursor = input.cursor;
    do {
      const page = await repository.getRequestStatus({
        orgId: input.orgId,
        requestId: input.requestId,
        ...(cursor ? { cursor } : {})
      });
      if (!page || page.kind !== "refresh") throw new Error("LEDGER_REQUEST_NOT_FOUND");
      const keys = page.items.filter((item) => item.status === "failed").map((item) => item.key);
      keys.forEach((key) => assertLedgerPartitionObjectKeyFits(key, objectKeyPrefix));
      yield { keys, nextCursor: page.nextCursor };
      cursor = page.nextCursor ?? undefined;
    } while (cursor);
  }
  async function requestInternal(input: {
    orgId: string;
    selection: LedgerInternalSelection | { retryOfRequestId: string };
    actor: LedgerActor;
    idempotencyKey: string;
    signal?: AbortSignal;
    onReserved?: (request: LedgerRequestRef) => void;
  }) {
    validateSubmission(input.orgId, input.actor, input.idempotencyKey);
    if (!repository.beginInternalRefresh || !repository.appendInternalRefreshPage)
      throw new Error("LEDGER_INTERNAL_REFRESH_UNSUPPORTED");
    const actor = canonicalActor(input.actor);
    const selection =
      "retryOfRequestId" in input.selection
        ? input.selection
        : normalizeLedgerInternalSelection(input.selection);
    const retryOfRequestId =
      "retryOfRequestId" in selection ? selection.retryOfRequestId : undefined;
    const requestFingerprint = fingerprint({
      kind: "internal_refresh",
      orgId: input.orgId,
      actor,
      selection
    });
    if (
      retryOfRequestId &&
      !(await repository.findIdempotentRequest({ ...input, requestFingerprint }))
    ) {
      const parent = await repository.getRequestStatus({
        orgId: input.orgId,
        requestId: retryOfRequestId
      });
      if (!parent || parent.kind !== "refresh") throw new Error("LEDGER_REQUEST_NOT_FOUND");
      if (!parent.counts.failed) throw new Error("LEDGER_REQUEST_NO_FAILED_ITEMS");
    }
    let state = await repository.beginInternalRefresh({
      ...input,
      actor,
      selection,
      ...(retryOfRequestId ? { retryOfRequestId } : {}),
      requestFingerprint
    });
    if (!state.complete) input.onReserved?.({ requestId: state.requestId, status: state.status });
    while (!state.complete && !input.signal?.aborted) {
      const pages = retryOfRequestId
        ? previewFailedRequest({
            orgId: input.orgId,
            requestId: retryOfRequestId,
            ...(state.cursor ? { cursor: state.cursor } : {})
          })
        : previewAllPartitions({
            orgId: input.orgId,
            selection: selection as LedgerInternalSelection,
            ...(state.cursor ? { cursor: state.cursor } : {})
          });
      // Read exactly one page, then restart from the committed cursor (including a CAS loser).
      const page = (await pages.next()).value;
      if (!page) throw new Error("LEDGER_ENUMERATION_INVALID");
      state = await repository.appendInternalRefreshPage({
        orgId: input.orgId,
        requestId: state.requestId,
        expectedCursor: state.cursor,
        ...page
      });
    }
    return { requestId: state.requestId, status: state.status };
  }
  return {
    previewAllPartitions,
    previewFailedRequest,
    requestAllPartitions(input: {
      orgId: string;
      selection: LedgerInternalSelection;
      actor: LedgerActor;
      idempotencyKey: string;
      signal?: AbortSignal;
      onReserved?: (request: LedgerRequestRef) => void;
    }) {
      return requestInternal(input);
    },
    retryFailedRequest(input: {
      orgId: string;
      requestId: string;
      actor: LedgerActor;
      idempotencyKey: string;
      signal?: AbortSignal;
      onReserved?: (request: LedgerRequestRef) => void;
    }) {
      return requestInternal({ ...input, selection: { retryOfRequestId: input.requestId } });
    },
    async previewRefresh(input: { orgId: string; scope: LedgerScope }) {
      const scope = parseLedgerScope(input.scope);
      validateScopeObjectKeys(input.orgId, scope);
      const keys = await resolveScope(input.orgId, scope);
      return {
        scope,
        storeCount: new Set(keys.map((key) => key.storeName)).size,
        partitionCount: keys.length,
        estimatedTaskCount: keys.length,
        keys
      };
    },
    async requestRefresh(input: {
      orgId: string;
      scope: LedgerScope;
      actor: LedgerActor;
      idempotencyKey: string;
    }) {
      validateSubmission(input.orgId, input.actor, input.idempotencyKey);
      const scope = parseLedgerScope(input.scope);
      validateScopeObjectKeys(input.orgId, scope);
      const actor = canonicalActor(input.actor);
      const requestFingerprint = fingerprint({
        kind: "refresh",
        orgId: input.orgId,
        actor,
        storeNames: scope.storeNames,
        dates: ledgerScopeDates(scope)
      });
      const existing = await repository.findIdempotentRequest({ ...input, requestFingerprint });
      if (existing) return existing;
      const request = await repository.reserveRefresh({
        ...input,
        actor,
        scope,
        keys: await resolveScope(input.orgId, scope),
        requestFingerprint
      });
      if (!request) throw new Error("LEDGER_REQUEST_NOT_RESERVED");
      return request;
    },
    async requestPartitionRefresh(input: {
      key: LedgerPartitionKey;
      actor: LedgerActor;
      idempotencyKey: string;
      onlyIfNeeded: boolean;
      reconciliationObservation?: LedgerReconciliationObservation;
    }) {
      validateSubmission(input.key.orgId, input.actor, input.idempotencyKey);
      assertLedgerDate(input.key.purchaseDate);
      if (!input.key.storeName || input.key.storeName.length > 512)
        throw new Error("LEDGER_PARTITION_KEY_INVALID");
      assertLedgerPartitionObjectKeyFits(input.key, objectKeyPrefix);
      const actor = canonicalActor(input.actor);
      return repository.reserveRefresh({
        orgId: input.key.orgId,
        actor,
        idempotencyKey: input.idempotencyKey,
        scope: { storeNames: [input.key.storeName], dates: [input.key.purchaseDate] },
        keys: [input.key],
        onlyIfNeeded: input.onlyIfNeeded,
        reconciliationObservation: input.reconciliationObservation,
        requestFingerprint: fingerprint({
          kind: "refresh",
          orgId: input.key.orgId,
          actor,
          key: {
            orgId: input.key.orgId,
            storeName: input.key.storeName,
            purchaseDate: input.key.purchaseDate
          },
          onlyIfNeeded: input.onlyIfNeeded
        })
      });
    },
    getRequestStatus(input: { orgId: string; requestId: string; cursor?: string }) {
      return repository.getRequestStatus(input);
    },
    async retryFailed(input: {
      orgId: string;
      requestId: string;
      actor: LedgerActor;
      idempotencyKey: string;
    }) {
      validateSubmission(input.orgId, input.actor, input.idempotencyKey);
      const actor = canonicalActor(input.actor);
      const requestFingerprint = fingerprint({
        kind: "refresh",
        orgId: input.orgId,
        actor,
        retryOfRequestId: input.requestId
      });
      const existing = await repository.findIdempotentRequest({ ...input, requestFingerprint });
      if (existing) return existing;
      const keys = await repository.listFailedPartitionKeys(input);
      if (keys.length === 0) throw new Error("LEDGER_REQUEST_NO_FAILED_ITEMS");
      keys.forEach((key) => assertLedgerPartitionObjectKeyFits(key, objectKeyPrefix));
      const request = await repository.reserveRefresh({
        orgId: input.orgId,
        actor,
        keys,
        idempotencyKey: input.idempotencyKey,
        retryOfRequestId: input.requestId,
        scope: { partitionKeys: keys },
        requestFingerprint
      });
      if (!request) throw new Error("LEDGER_REQUEST_NOT_RESERVED");
      return request;
    }
  };
}
