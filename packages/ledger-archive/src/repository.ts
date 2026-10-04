import { Prisma, type PrismaClient, type LedgerArtifactRequest } from "@prisma/client";
import { retryIdempotentDatabaseOperation } from "@smedc/db";
import {
  assertLedgerPartitionObjectKeyFits,
  ledgerStoreNameHash,
  normalizeLedgerObjectKeyPrefix
} from "./keys.js";
import { LEDGER_PAGE_SIZE, ledgerScopeDates } from "./scope.js";
import { reduceLedgerRequestStatus } from "./service.js";
import type { LedgerActor, LedgerPartitionKey, LedgerRequestRef, LedgerScope } from "./types.js";

export type LedgerItemStatus =
  "queued" | "running" | "succeeded" | "empty" | "superseded" | "failed";
export type LedgerRequestStatus = "queued" | "running" | "succeeded" | "partial_failed" | "failed";
export type LedgerRequestScope = LedgerScope | { partitionKeys: LedgerPartitionKey[] };
export type LedgerRequestItemResult = {
  itemId: string;
  key: LedgerPartitionKey;
  partitionId: string;
  generation: number;
  dataRevision: number;
  status: LedgerItemStatus;
  errorCode: string | null;
  processingRunId: string | null;
  latestRequest: LedgerRequestRef | null;
};
export type LedgerRequestResult = {
  requestId: string;
  orgId: string;
  kind: "refresh" | "download";
  actor: LedgerActor;
  retryOfRequestId: string | null;
  status: LedgerRequestStatus;
  items: LedgerRequestItemResult[];
  counts: Record<LedgerItemStatus, number>;
  nextCursor: string | null;
};
export type ReserveLedgerRefreshInput = {
  orgId: string;
  actor: LedgerActor;
  idempotencyKey: string;
  requestFingerprint: string;
  scope: LedgerRequestScope;
  keys: LedgerPartitionKey[];
  onlyIfNeeded?: boolean;
  retryOfRequestId?: string;
};
export interface LedgerArchiveRepository {
  /** Normalized physical prefix from the actual storage adapter; defaults to empty. */
  readonly objectKeyPrefix?: string;
  listPartitionKeys(input: {
    orgId: string;
    scope?: LedgerScope;
    cursor?: string;
  }): Promise<{ keys: LedgerPartitionKey[]; nextCursor: string | null }>;
  findIdempotentRequest(input: {
    orgId: string;
    idempotencyKey: string;
    requestFingerprint: string;
  }): Promise<LedgerRequestRef | null>;
  reserveRefresh(input: ReserveLedgerRefreshInput): Promise<LedgerRequestRef | null>;
  getRequestStatus(input: {
    orgId: string;
    requestId: string;
    cursor?: string;
  }): Promise<LedgerRequestResult | null>;
  listFailedPartitionKeys(input: {
    orgId: string;
    requestId: string;
  }): Promise<LedgerPartitionKey[]>;
}

function date(value: string): Date {
  return new Date(`${value}T00:00:00.000Z`);
}
function dateString(value: Date): string {
  return value.toISOString().slice(0, 10);
}
function actorFields(actor: LedgerActor) {
  return {
    actorKind: actor.kind,
    actorEmployeeId: actor.kind === "employee" ? actor.employeeId : null,
    actorLabel: actor.kind === "operator" ? actor.label : null,
    reconciliationRunId: actor.kind === "system_reconciler" ? actor.reconciliationRunId : null
  };
}
function requestActor(request: LedgerArtifactRequest): LedgerActor {
  if (request.actorKind === "employee" && request.actorEmployeeId)
    return { kind: "employee", employeeId: request.actorEmployeeId };
  if (request.actorKind === "operator" && request.actorLabel)
    return { kind: "operator", label: request.actorLabel };
  if (request.actorKind === "system_reconciler" && request.reconciliationRunId)
    return { kind: "system_reconciler", reconciliationRunId: request.reconciliationRunId };
  throw new Error("LEDGER_ACTOR_INVALID");
}
function matchingRequest(
  request: LedgerArtifactRequest | null,
  fingerprint: string
): LedgerRequestRef | null {
  if (!request) return null;
  if (request.requestFingerprint !== fingerprint) throw new Error("LEDGER_IDEMPOTENCY_CONFLICT");
  return { requestId: request.id, status: request.status };
}
function encodeCursor(binding: string, position: string[]): string {
  return Buffer.from(JSON.stringify({ binding, position })).toString("base64url");
}
function decodeCursor(
  cursor: string | undefined,
  binding: string,
  length: number
): string[] | null {
  if (!cursor) return null;
  try {
    const value = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as {
      binding: unknown;
      position: unknown;
    };
    if (
      value.binding !== binding ||
      !Array.isArray(value.position) ||
      value.position.length !== length ||
      value.position.some((entry) => typeof entry !== "string")
    )
      throw new Error();
    return value.position as string[];
  } catch {
    throw new Error("LEDGER_CURSOR_INVALID");
  }
}

export function createPrismaLedgerArchiveRepository({
  prisma,
  objectKeyPrefix = ""
}: {
  prisma: PrismaClient;
  objectKeyPrefix?: string;
}): LedgerArchiveRepository {
  const normalizedPrefix = normalizeLedgerObjectKeyPrefix(objectKeyPrefix);
  async function findIdempotentRequest(input: {
    orgId: string;
    idempotencyKey: string;
    requestFingerprint: string;
  }) {
    const request = await prisma.ledgerArtifactRequest.findUnique({
      where: { orgId_idempotencyKey: { orgId: input.orgId, idempotencyKey: input.idempotencyKey } }
    });
    return matchingRequest(request, input.requestFingerprint);
  }

  return {
    objectKeyPrefix: normalizedPrefix,
    findIdempotentRequest,
    async listPartitionKeys(input) {
      const binding = JSON.stringify([input.orgId, input.scope ?? null]);
      const cursor = decodeCursor(input.cursor, binding, 2);
      const scopeFilter = input.scope
        ? Prisma.sql`AND CAST(store_name AS BINARY) IN (${Prisma.join(input.scope.storeNames)}) AND purchase_date IN (${Prisma.join(ledgerScopeDates(input.scope))})`
        : Prisma.empty;
      const cursorFilter = cursor
        ? Prisma.sql`AND (CAST(store_name AS BINARY) > CAST(${cursor[0]} AS BINARY) OR (CAST(store_name AS BINARY) = CAST(${cursor[0]} AS BINARY) AND purchase_date > ${cursor[1]}))`
        : Prisma.empty;
      // Union authoritative, applied facts with the index, so missing indexes and emptied old
      // partitions remain discoverable. Exact names are deliberately binary, never normalized.
      const rows = await prisma.$queryRaw<{ storeName: string; purchaseDate: string }[]>(Prisma.sql`
        SELECT store_name AS storeName, purchase_date AS purchaseDate FROM (
          SELECT DISTINCT JSON_UNQUOTE(JSON_EXTRACT(r.payload, '$.store_name')) COLLATE utf8mb4_0900_bin AS store_name,
            JSON_UNQUOTE(JSON_EXTRACT(r.payload, '$.purchase_date')) COLLATE utf8mb4_0900_bin AS purchase_date
          FROM delivery_ledger_rows r JOIN documents d ON d.id = r.source_document_id AND d.org_id = r.org_id
          JOIN import_batches b ON b.id = r.import_batch_id AND b.org_id = r.org_id
          WHERE r.org_id = ${input.orgId} AND d.status = 'active' AND b.status = 'applied'
          UNION
          SELECT store_name COLLATE utf8mb4_0900_bin, DATE_FORMAT(purchase_date, '%Y-%m-%d') COLLATE utf8mb4_0900_bin
          FROM ledger_pdf_partitions WHERE org_id = ${input.orgId}
        ) actual WHERE store_name IS NOT NULL AND purchase_date IS NOT NULL ${scopeFilter} ${cursorFilter}
        ORDER BY CAST(store_name AS BINARY), purchase_date LIMIT ${LEDGER_PAGE_SIZE + 1}
      `);
      const page = rows.slice(0, LEDGER_PAGE_SIZE);
      const last = page.at(-1);
      return {
        keys: page.map((row) => ({ orgId: input.orgId, ...row })),
        nextCursor:
          rows.length > LEDGER_PAGE_SIZE && last
            ? encodeCursor(binding, [last.storeName, last.purchaseDate])
            : null
      };
    },
    async reserveRefresh(input) {
      input.keys.forEach((key) => assertLedgerPartitionObjectKeyFits(key, normalizedPrefix));
      if (input.keys.some((key) => key.orgId !== input.orgId))
        throw new Error("LEDGER_ORG_MISMATCH");
      return retryIdempotentDatabaseOperation(() =>
        prisma.$transaction(
          async (tx) => {
            // A short per-org reservation lock serializes fresh partition creation and request
            // uniqueness across independent clients. Rendering and source reads never hold it.
            const organizations = await tx.$queryRaw<{ id: string }[]>(
              Prisma.sql`SELECT id FROM organizations WHERE id = ${input.orgId} FOR UPDATE`
            );
            if (!organizations.length) throw new Error("LEDGER_ORG_NOT_FOUND");
            const existing = await tx.ledgerArtifactRequest.findUnique({
              where: {
                orgId_idempotencyKey: { orgId: input.orgId, idempotencyKey: input.idempotencyKey }
              }
            });
            if (existing) return matchingRequest(existing, input.requestFingerprint);
            const unique = new Map(
              input.keys.map((key) => [JSON.stringify([key.storeName, key.purchaseDate]), key])
            );
            const keys = [...unique.values()].sort(
              (a, b) =>
                Buffer.compare(Buffer.from(a.storeName), Buffer.from(b.storeName)) ||
                a.purchaseDate.localeCompare(b.purchaseDate)
            );
            if (input.onlyIfNeeded && keys.length !== 1)
              throw new Error("LEDGER_PARTITION_KEY_INVALID");
            const partitions = [];
            for (const key of keys) {
              const identity = {
                orgId: key.orgId,
                storeNameHash: ledgerStoreNameHash(key.storeName),
                purchaseDate: date(key.purchaseDate)
              };
              const partition = await tx.ledgerPdfPartition.upsert({
                where: { orgId_storeNameHash_purchaseDate: identity },
                create: { ...identity, storeName: key.storeName },
                update: {}
              });
              // Check exact UTF-8 name even with a hash identity; never silently alias a collision.
              if (partition.storeName !== key.storeName)
                throw new Error("LEDGER_STORE_HASH_COLLISION");
              await tx.$queryRaw(
                Prisma.sql`SELECT id FROM ledger_pdf_partitions WHERE id = ${partition.id} AND org_id = ${input.orgId} FOR UPDATE`
              );
              const current = await tx.ledgerPdfPartition.findUniqueOrThrow({
                where: { id: partition.id }
              });
              if (input.onlyIfNeeded) {
                const inflight = await tx.ledgerArtifactRequestItem.findFirst({
                  where: {
                    orgId: input.orgId,
                    partitionId: current.id,
                    generation: current.requestedGeneration,
                    dataRevision: current.dataRevision,
                    status: { in: ["queued", "running"] },
                    processingRun: { status: { in: ["queued", "running", "retry_scheduled"] } }
                  },
                  include: { request: true }
                });
                if (inflight)
                  return { requestId: inflight.requestId, status: inflight.request.status };
                if (
                  current.currentObjectKey &&
                  current.publishedDataRevision === current.dataRevision &&
                  !current.errorCode
                )
                  return null;
              }
              partitions.push(
                await tx.ledgerPdfPartition.update({
                  where: { id: current.id },
                  data: { requestedGeneration: { increment: 1 } }
                })
              );
            }
            const request = await tx.ledgerArtifactRequest.create({
              data: {
                orgId: input.orgId,
                kind: "refresh",
                ...actorFields(input.actor),
                idempotencyKey: input.idempotencyKey,
                requestFingerprint: input.requestFingerprint,
                scope: input.scope,
                retryOfRequestId: input.retryOfRequestId,
                status: partitions.length ? "queued" : "succeeded"
              }
            });
            for (const partition of partitions) {
              const item = await tx.ledgerArtifactRequestItem.create({
                data: {
                  orgId: input.orgId,
                  requestId: request.id,
                  partitionId: partition.id,
                  generation: partition.requestedGeneration,
                  dataRevision: partition.dataRevision
                }
              });
              await tx.processingRun.create({
                data: {
                  orgId: input.orgId,
                  jobType: "ledger_pdf_generate",
                  jobKey: `ledger-pdf:${partition.id}:${item.generation}`,
                  priority: input.actor.kind === "system_reconciler" ? 20 : 10,
                  ledgerArtifactRequestItemId: item.id
                }
              });
            }
            await tx.auditLog.create({
              data: {
                orgId: input.orgId,
                actorEmployeeId: input.actor.kind === "employee" ? input.actor.employeeId : null,
                action: "ledger_pdf.refresh_requested",
                targetType: "ledger_artifact_request",
                targetId: request.id,
                metadata: {
                  actor: input.actor,
                  scope: input.scope,
                  idempotencyKey: input.idempotencyKey,
                  partitionCount: partitions.length,
                  retryOfRequestId: input.retryOfRequestId ?? null
                }
              }
            });
            return { requestId: request.id, status: request.status };
          },
          { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted, timeout: 60_000 }
        )
      );
    },
    async getRequestStatus(input) {
      const binding = JSON.stringify([input.orgId, input.requestId]);
      const cursor = decodeCursor(input.cursor, binding, 1);
      return prisma.$transaction(async (tx) => {
        const request = await tx.ledgerArtifactRequest.findFirst({
          where: { orgId: input.orgId, id: input.requestId }
        });
        if (!request) return null;
        const counts: Record<LedgerItemStatus, number> = {
          queued: 0,
          running: 0,
          succeeded: 0,
          empty: 0,
          superseded: 0,
          failed: 0
        };
        const statuses = await tx.ledgerArtifactRequestItem.groupBy({
          by: ["status"],
          where: { orgId: input.orgId, requestId: input.requestId },
          _count: true
        });
        for (const entry of statuses) counts[entry.status] = entry._count;
        const items = await tx.ledgerArtifactRequestItem.findMany({
          where: {
            orgId: input.orgId,
            requestId: input.requestId,
            ...(cursor ? { id: { gt: cursor[0] } } : {})
          },
          include: { partition: true, processingRun: { select: { id: true } } },
          orderBy: { id: "asc" },
          take: LEDGER_PAGE_SIZE + 1
        });
        const page = items.slice(0, LEDGER_PAGE_SIZE);
        const results: LedgerRequestItemResult[] = [];
        for (const item of page) {
          const latest =
            item.status === "superseded"
              ? await tx.ledgerArtifactRequestItem.findFirst({
                  where: {
                    orgId: input.orgId,
                    partitionId: item.partitionId,
                    generation: { gt: item.generation }
                  },
                  orderBy: { generation: "desc" },
                  include: { request: true }
                })
              : null;
          results.push({
            itemId: item.id,
            key: {
              orgId: input.orgId,
              storeName: item.partition.storeName,
              purchaseDate: dateString(item.partition.purchaseDate)
            },
            partitionId: item.partitionId,
            generation: item.generation,
            dataRevision: item.dataRevision,
            status: item.status,
            errorCode: item.errorCode,
            processingRunId: item.processingRun?.id ?? null,
            latestRequest: latest
              ? { requestId: latest.requestId, status: latest.request.status }
              : null
          });
        }
        const status =
          request.kind === "refresh"
            ? reduceLedgerRequestStatus(
                Object.entries(counts).flatMap(([status, count]) =>
                  count ? [status as LedgerItemStatus] : []
                )
              )
            : request.status;
        // Persistent request status is maintained by processors. Reads derive from all items,
        // not just this page, without mutating anything (including dry-run/status requests).
        return {
          requestId: request.id,
          orgId: request.orgId,
          kind: request.kind,
          actor: requestActor(request),
          retryOfRequestId: request.retryOfRequestId,
          status,
          counts,
          items: results,
          nextCursor:
            items.length > LEDGER_PAGE_SIZE && page.at(-1)
              ? encodeCursor(binding, [page.at(-1)!.id])
              : null
        };
      });
    },
    async listFailedPartitionKeys(input) {
      const request = await prisma.ledgerArtifactRequest.findFirst({
        where: { orgId: input.orgId, id: input.requestId, kind: "refresh" }
      });
      if (!request) throw new Error("LEDGER_REQUEST_NOT_FOUND");
      const items = await prisma.ledgerArtifactRequestItem.findMany({
        where: { orgId: input.orgId, requestId: input.requestId, status: "failed" },
        include: { partition: true },
        orderBy: { partitionId: "asc" }
      });
      return items.map((item) => ({
        orgId: input.orgId,
        storeName: item.partition.storeName,
        purchaseDate: dateString(item.partition.purchaseDate)
      }));
    }
  };
}
