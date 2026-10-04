import { createHash } from "node:crypto";
import type {
  LedgerArchiveRepository,
  LedgerItemStatus,
  LedgerRequestStatus
} from "./repository.js";
import {
  assertLedgerDate,
  ledgerScopeDates,
  LEDGER_SCOPE_MAX_PARTITIONS,
  parseLedgerScope
} from "./scope.js";
import type { LedgerActor, LedgerPartitionKey, LedgerScope } from "./types.js";

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

export function createLedgerArchiveService(repository: LedgerArchiveRepository) {
  async function resolveScope(orgId: string, scope: LedgerScope) {
    const keys: LedgerPartitionKey[] = [];
    let cursor: string | undefined;
    do {
      const page = await repository.listPartitionKeys({ orgId, scope, cursor });
      keys.push(...page.keys);
      if (keys.length > LEDGER_SCOPE_MAX_PARTITIONS) throw new Error("LEDGER_SCOPE_LIMIT_EXCEEDED");
      cursor = page.nextCursor ?? undefined;
    } while (cursor);
    return keys;
  }

  return {
    async previewRefresh(input: { orgId: string; scope: LedgerScope }) {
      const scope = parseLedgerScope(input.scope);
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
    }) {
      validateSubmission(input.key.orgId, input.actor, input.idempotencyKey);
      assertLedgerDate(input.key.purchaseDate);
      if (!input.key.storeName || input.key.storeName.length > 512)
        throw new Error("LEDGER_PARTITION_KEY_INVALID");
      const actor = canonicalActor(input.actor);
      return repository.reserveRefresh({
        orgId: input.key.orgId,
        actor,
        idempotencyKey: input.idempotencyKey,
        scope: { storeNames: [input.key.storeName], dates: [input.key.purchaseDate] },
        keys: [input.key],
        onlyIfNeeded: input.onlyIfNeeded,
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
