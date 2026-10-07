import { createHash } from "node:crypto";
import { Prisma, type LedgerPdfPartition, type PrismaClient } from "@prisma/client";
import { retryIdempotentDatabaseOperation } from "@smedc/db";
import { lockLedgerSourceMutation } from "./changes.js";
import { ledgerStoreNameHash } from "./keys.js";
import {
  createPrismaLedgerArchiveRepository,
  type LedgerReconciliationLease
} from "./repository.js";
import { createLedgerArchiveService } from "./service.js";
import { readLedgerSourceMetadata, type LedgerSourceMetadata } from "./source-reader.js";
import type { LedgerPartitionKey } from "./types.js";

export type LedgerHead = { state: "found"; size: number; hash?: string } | { state: "not_found" };
export const LEDGER_RECONCILIATION_DEFAULTS = {
  enabled: false,
  time: "03:00",
  timeZone: "Asia/Shanghai",
  pageSize: 200,
  headConcurrency: 4
} as const;
export type LedgerReconciliationCounters = {
  scannedCount: number;
  healthyCount: number;
  abnormalCount: number;
  submittedCount: number;
  inflightSkippedCount: number;
  failedCount: number;
};
export type LedgerReconciliationState = {
  id: string;
  orgId: string;
  phase: "facts" | "index" | "completed";
  cursor: string | null;
} & LedgerReconciliationCounters;
export type LedgerReconciliationPage = {
  done: boolean;
  nextCursor: string | null;
  phase: LedgerReconciliationState["phase"];
};
export type LedgerReconciliationRepository = {
  getState(runId: string, lease: LedgerReconciliationLease): Promise<LedgerReconciliationState>;
  listKeys(
    state: LedgerReconciliationState,
    limit: number
  ): Promise<{ keys: LedgerPartitionKey[]; nextCursor: string | null }>;
  observe(
    key: LedgerPartitionKey
  ): Promise<{ partition: LedgerPdfPartition | null; source: LedgerSourceMetadata }>;
  reserveRepair(input: {
    key: LedgerPartitionKey;
    state: LedgerReconciliationState;
    lease: LedgerReconciliationLease;
    partition: LedgerPdfPartition | null;
    source: LedgerSourceMetadata;
    needsRepair: boolean;
  }): Promise<"healthy" | "submitted" | "inflight">;
  checkpoint(input: {
    state: LedgerReconciliationState;
    lease: LedgerReconciliationLease;
    phase: LedgerReconciliationState["phase"];
    cursor: string | null;
    counts: LedgerReconciliationCounters;
  }): Promise<void>;
};

/** Fixed business timezone, independent of the workstation/server's local timezone. */
export function mostRecentLedgerScheduleDate(input: {
  now: Date;
  time: string;
  timeZone: string;
}): string {
  if (
    input.timeZone !== "Asia/Shanghai" ||
    !/^([01]\d|2[0-3]):[0-5]\d$/.test(input.time) ||
    !Number.isFinite(input.now.getTime())
  )
    throw new Error("LEDGER_RECONCILIATION_CONFIG_INVALID");
  const local = new Date(input.now.getTime() + 8 * 60 * 60 * 1000);
  const minutes = local.getUTCHours() * 60 + local.getUTCMinutes();
  const [hour, minute] = input.time.split(":").map(Number);
  if (minutes < hour! * 60 + minute!) local.setUTCDate(local.getUTCDate() - 1);
  return local.toISOString().slice(0, 10);
}

export function ledgerNeedsRepair(
  partition: LedgerPdfPartition | null,
  source: LedgerSourceMetadata,
  head?: LedgerHead
): boolean {
  if (!partition) return source.rowCount > 0;
  if (
    partition.errorCode ||
    partition.publishedDataRevision !== partition.dataRevision ||
    partition.publishedSourceFingerprint !== source.sourceFingerprint
  )
    return true;
  if (source.rowCount === 0) return partition.currentObjectKey !== null || partition.rowCount !== 0;
  if (!partition.currentObjectKey || partition.byteSize === null || !partition.checksumSha256)
    return true;
  return (
    head?.state === "not_found" ||
    (head?.state === "found" &&
      (BigInt(head.size) !== partition.byteSize || head.hash !== partition.checksumSha256))
  );
}

/** One bounded page; failures never mean a missing object and never trigger a blind repair. */
export async function reconcileLedgerPage(input: {
  runId: string;
  lease: LedgerReconciliationLease;
  repository: LedgerReconciliationRepository;
  storage: { headObject(key: string): Promise<LedgerHead> };
  limit?: number;
  signal?: AbortSignal;
}): Promise<LedgerReconciliationPage> {
  const limit = input.limit ?? 200;
  if (!Number.isInteger(limit) || limit < 1 || limit > 200)
    throw new Error("LEDGER_PAGE_LIMIT_INVALID");
  const state = await input.repository.getState(input.runId, input.lease);
  if (state.phase === "completed") return { done: true, nextCursor: null, phase: "completed" };
  const page = await input.repository.listKeys(state, limit);
  const counts: LedgerReconciliationCounters = {
    scannedCount: 0,
    healthyCount: 0,
    abnormalCount: 0,
    submittedCount: 0,
    inflightSkippedCount: 0,
    failedCount: 0
  };
  let position = 0;
  await Promise.all(
    Array.from({ length: Math.min(4, page.keys.length) }, async () => {
      while (position < page.keys.length) {
        if (input.signal?.aborted) throw new Error("LEDGER_RECONCILIATION_ABORTED");
        const key = page.keys[position++]!;
        let checked = false;
        // A changed pointer/source can be observed once more, then safely deferred to tomorrow.
        for (let attempt = 0; attempt < 2; attempt++) {
          try {
            const { partition, source } = await input.repository.observe(key);
            const head = partition?.currentObjectKey
              ? await input.storage.headObject(partition.currentObjectKey)
              : undefined;
            const needsRepair = ledgerNeedsRepair(partition, source, head);
            const outcome = await input.repository.reserveRepair({
              key,
              state,
              lease: input.lease,
              partition,
              source,
              needsRepair
            });
            counts.scannedCount++;
            if (needsRepair) counts.abnormalCount++;
            if (outcome === "healthy") counts.healthyCount++;
            else if (outcome === "submitted") counts.submittedCount++;
            else counts.inflightSkippedCount++;
            checked = true;
            break;
          } catch (error) {
            const code = error instanceof Error ? error.message : "";
            if (
              code === "LEDGER_RECONCILIATION_LEASE_LOST" ||
              code === "LEDGER_RECONCILIATION_ABORTED"
            )
              throw error;
            if (code === "LEDGER_OBSERVATION_STALE" && attempt === 0) continue;
            counts.scannedCount++;
            counts.failedCount++;
            checked = true;
            break;
          }
        }
        if (!checked) throw new Error("LEDGER_RECONCILIATION_CHECK_FAILED");
      }
    })
  );
  const phase = page.nextCursor ? state.phase : "completed";
  await input.repository.checkpoint({
    state,
    lease: input.lease,
    phase,
    cursor: page.nextCursor,
    counts
  });
  return { done: phase === "completed", nextCursor: page.nextCursor, phase };
}

function cursorString(value: Prisma.JsonValue | null): string | null {
  if (value === null) return null;
  if (typeof value !== "string") throw new Error("LEDGER_RECONCILIATION_CURSOR_INVALID");
  return value;
}
function stateFrom(
  run: {
    id: string;
    orgId: string;
    phase: string;
    cursor: Prisma.JsonValue | null;
  } & LedgerReconciliationCounters
): LedgerReconciliationState {
  if (!["facts", "index", "completed"].includes(run.phase))
    throw new Error("LEDGER_RECONCILIATION_PHASE_INVALID");
  return {
    ...run,
    phase: run.phase as LedgerReconciliationState["phase"],
    cursor: cursorString(run.cursor)
  };
}
function identity(key: LedgerPartitionKey) {
  return {
    orgId: key.orgId,
    storeNameHash: ledgerStoreNameHash(key.storeName),
    purchaseDate: new Date(`${key.purchaseDate}T00:00:00Z`)
  };
}

export function createPrismaLedgerReconciliation({
  prisma,
  objectKeyPrefix,
  now = () => new Date()
}: {
  prisma: PrismaClient;
  objectKeyPrefix?: string;
  now?: () => Date;
}) {
  const archive = createLedgerArchiveService(
    createPrismaLedgerArchiveRepository({ prisma, objectKeyPrefix })
  );
  async function assertLease(
    tx: Prisma.TransactionClient,
    orgId: string,
    reconciliationRunId: string,
    lease: LedgerReconciliationLease
  ) {
    await tx.$queryRaw(
      Prisma.sql`SELECT id FROM processing_runs WHERE id = ${lease.runId} FOR UPDATE`
    );
    const run = await tx.processingRun.findFirst({
      where: {
        id: lease.runId,
        orgId,
        ledgerPdfReconciliationRunId: reconciliationRunId,
        jobType: "ledger_pdf_reconcile",
        status: "running",
        lockedBy: lease.lockedBy,
        attemptNumber: lease.attemptNumber,
        lockedUntil: { gt: now() }
      }
    });
    if (!run) throw new Error("LEDGER_RECONCILIATION_LEASE_LOST");
  }
  const repository: LedgerReconciliationRepository = {
    async getState(runId, lease) {
      const run = await prisma.ledgerPdfReconciliationRun.findUniqueOrThrow({
        where: { id: runId }
      });
      const leased = await prisma.processingRun.findFirst({
        where: {
          id: lease.runId,
          orgId: run.orgId,
          ledgerPdfReconciliationRunId: runId,
          jobType: "ledger_pdf_reconcile",
          status: "running",
          lockedBy: lease.lockedBy,
          attemptNumber: lease.attemptNumber,
          lockedUntil: { gt: now() }
        }
      });
      if (!leased) throw new Error("LEDGER_RECONCILIATION_LEASE_LOST");
      return stateFrom(run);
    },
    async listKeys(state, limit) {
      let after: [string, string] | null = null;
      if (state.cursor) {
        try {
          const parsed = JSON.parse(Buffer.from(state.cursor, "base64url").toString()) as unknown[];
          if (
            parsed.length !== 3 ||
            parsed[0] !== state.orgId ||
            typeof parsed[1] !== "string" ||
            typeof parsed[2] !== "string"
          )
            throw new Error();
          after = [parsed[1], parsed[2]];
        } catch {
          throw new Error("LEDGER_CURSOR_INVALID");
        }
      }
      const filter = after
        ? Prisma.sql`AND (CAST(p.store_name AS BINARY) > CAST(${after[0]} AS BINARY) OR (CAST(p.store_name AS BINARY) = CAST(${after[0]} AS BINARY) AND p.purchase_date > ${after[1]}))`
        : Prisma.empty;
      // Source mutations create/update this index in their own transaction. Matching published
      // revisions need no source reads or storage HEAD; successful publication clears the marker.
      // Keep the existing cursor shape so unfinished pre-upgrade pages can resume safely.
      const found = await prisma.$queryRaw<
        { storeName: string; purchaseDate: string }[]
      >(Prisma.sql`
        SELECT p.store_name AS storeName, DATE_FORMAT(p.purchase_date, '%Y-%m-%d') AS purchaseDate
        FROM ledger_pdf_partitions p WHERE p.org_id = ${state.orgId} ${filter}
          AND (p.published_data_revision IS NULL OR p.published_data_revision <> p.data_revision
            OR p.error_code IS NOT NULL)
        ORDER BY CAST(p.store_name AS BINARY), p.purchase_date LIMIT ${limit + 1}`);
      const keys = found.slice(0, limit).map((row) => ({ orgId: state.orgId, ...row }));
      const last = keys.at(-1);
      return {
        keys,
        nextCursor:
          found.length > limit && last
            ? Buffer.from(
                JSON.stringify([state.orgId, last.storeName, last.purchaseDate])
              ).toString("base64url")
            : null
      };
    },
    async observe(key) {
      // Fingerprint and pointer share a repeatable-read snapshot without holding a lock over HEAD.
      return prisma.$transaction(
        async (tx) => {
          const partition = await tx.ledgerPdfPartition.findUnique({
            where: { orgId_storeNameHash_purchaseDate: identity(key) }
          });
          if (partition && partition.storeName !== key.storeName)
            throw new Error("LEDGER_STORE_HASH_COLLISION");
          return { partition, source: await readLedgerSourceMetadata(tx, key) };
        },
        { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead, timeout: 30_000 }
      );
    },
    async reserveRepair(input) {
      const idempotencyKey = `reconcile:${input.state.id}:${createHash("sha256")
        .update(JSON.stringify([input.key.storeName, input.key.purchaseDate]))
        .digest("hex")}`;
      const partition = input.partition;
      const request = await archive.requestPartitionRefresh({
        key: input.key,
        actor: { kind: "system_reconciler", reconciliationRunId: input.state.id },
        idempotencyKey,
        onlyIfNeeded: true,
        reconciliationObservation: {
          dataRevision: partition?.dataRevision ?? 0,
          requestedGeneration: partition?.requestedGeneration ?? 0,
          publishedGeneration: partition?.publishedGeneration ?? null,
          publishedDataRevision: partition?.publishedDataRevision ?? null,
          publishedSourceFingerprint: partition?.publishedSourceFingerprint ?? null,
          currentObjectKey: partition?.currentObjectKey ?? null,
          checksumSha256: partition?.checksumSha256 ?? null,
          byteSize: partition?.byteSize ?? null,
          errorCode: partition?.errorCode ?? null,
          rowCount: partition?.rowCount ?? null,
          sourceFingerprint: input.source.sourceFingerprint,
          needsRepair: input.needsRepair,
          lease: input.lease,
          now
        }
      });
      if (!request) return "healthy";
      const own = await prisma.ledgerArtifactRequest.findFirst({
        where: {
          id: request.requestId,
          orgId: input.key.orgId,
          reconciliationRunId: input.state.id,
          idempotencyKey
        }
      });
      return own ? "submitted" : "inflight";
    },
    async checkpoint(input) {
      await prisma.$transaction(
        async (tx) => {
          await lockLedgerSourceMutation(tx, input.state.orgId);
          await assertLease(tx, input.state.orgId, input.state.id, input.lease);
          const current = await tx.ledgerPdfReconciliationRun.findUniqueOrThrow({
            where: { id: input.state.id }
          });
          if (
            current.phase !== input.state.phase ||
            cursorString(current.cursor) !== input.state.cursor
          )
            throw new Error("LEDGER_RECONCILIATION_CHECKPOINT_STALE");
          const done = input.phase === "completed";
          const failedCount = current.failedCount + input.counts.failedCount;
          await tx.ledgerPdfReconciliationRun.update({
            where: { id: current.id },
            data: {
              phase: input.phase,
              cursor: input.cursor ?? Prisma.DbNull,
              ...Object.fromEntries(
                Object.entries(input.counts).map(([name, value]) => [name, { increment: value }])
              ),
              status: done ? (failedCount ? "partial_failed" : "succeeded") : "running",
              startedAt: current.startedAt ?? now(),
              finishedAt: done ? now() : null,
              errorCode: failedCount ? "LEDGER_RECONCILIATION_CHECK_FAILED" : null
            }
          });
          const mutationTime = now();
          const changed = await tx.processingRun.updateMany({
            where: {
              id: input.lease.runId,
              orgId: input.state.orgId,
              ledgerPdfReconciliationRunId: input.state.id,
              status: "running",
              lockedBy: input.lease.lockedBy,
              attemptNumber: input.lease.attemptNumber,
              lockedUntil: { gt: mutationTime }
            },
            data: {
              status: done ? "succeeded" : "queued",
              availableAt: now(),
              lockedBy: null,
              lockedUntil: null,
              lastHeartbeatAt: null,
              finishedAt: done ? now() : null,
              errorCode: failedCount ? "LEDGER_RECONCILIATION_CHECK_FAILED" : null,
              errorSummary: failedCount ? "One or more ledger metadata checks failed." : null
            }
          });
          if (changed.count !== 1) throw new Error("LEDGER_RECONCILIATION_LEASE_LOST");
        },
        { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted, timeout: 30_000 }
      );
    }
  };
  return {
    repository,
    async ensureDailyReconciliation(input: {
      enabled: boolean;
      time?: string;
      timeZone?: string;
      now?: Date;
      orgId?: string;
    }) {
      if (!input.enabled) return;
      const scheduleDate = new Date(
        `${mostRecentLedgerScheduleDate({ now: input.now ?? now(), time: input.time ?? "03:00", timeZone: input.timeZone ?? "Asia/Shanghai" })}T00:00:00Z`
      );
      const unfinishedWhere: Prisma.LedgerPdfReconciliationRunWhereInput = {
        phase: { not: "completed" },
        status: { in: ["queued", "running"] }
      };
      let orgCursor: string | undefined;
      do {
        const organizations = await prisma.organization.findMany({
          // Durable jobs resume themselves. Only lock organizations needing a new or missing job.
          // Re-read under the organization lock below: another scheduler may win this read race.
          where: {
            ...(input.orgId ? { id: input.orgId } : orgCursor ? { id: { gt: orgCursor } } : {}),
            OR: [
              {
                ledgerPdfReconciliationRuns: {
                  some: { ...unfinishedWhere, processingRun: { is: null } }
                }
              },
              {
                AND: [
                  { ledgerPdfReconciliationRuns: { none: unfinishedWhere } },
                  { ledgerPdfReconciliationRuns: { none: { scheduleDate } } }
                ]
              }
            ]
          },
          select: { id: true },
          orderBy: { id: "asc" },
          take: 200
        });
        for (const org of organizations) {
          await retryIdempotentDatabaseOperation(() =>
            prisma.$transaction(
              async (tx) => {
                await lockLedgerSourceMutation(tx, org.id);
                const unfinished = await tx.ledgerPdfReconciliationRun.findFirst({
                  where: {
                    orgId: org.id,
                    phase: { not: "completed" },
                    status: { in: ["queued", "running"] }
                  },
                  orderBy: [{ scheduleDate: "asc" }, { id: "asc" }]
                });
                const run =
                  unfinished ??
                  (await tx.ledgerPdfReconciliationRun.upsert({
                    where: { orgId_scheduleDate: { orgId: org.id, scheduleDate } },
                    create: { orgId: org.id, scheduleDate },
                    update: {}
                  }));
                if (run.phase !== "completed" && ["queued", "running"].includes(run.status))
                  await tx.processingRun.upsert({
                    where: { jobKey: `ledger-reconcile:${run.id}` },
                    create: {
                      orgId: org.id,
                      jobKey: `ledger-reconcile:${run.id}`,
                      jobType: "ledger_pdf_reconcile",
                      ledgerPdfReconciliationRunId: run.id,
                      priority: 20
                    },
                    update: {}
                  });
              },
              { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted, timeout: 30_000 }
            )
          );
        }
        orgCursor =
          !input.orgId && organizations.length === 200 ? organizations.at(-1)!.id : undefined;
      } while (orgCursor);
    },
    reconcileLedgerPage(input: {
      runId: string;
      lease: LedgerReconciliationLease;
      storage: { headObject(key: string): Promise<LedgerHead> };
      limit?: number;
      signal?: AbortSignal;
    }) {
      return reconcileLedgerPage({ ...input, repository });
    },
    async getReconciliationStatus(runId: string) {
      const run = await prisma.ledgerPdfReconciliationRun.findUniqueOrThrow({
        where: { id: runId }
      });
      const groups = await prisma.ledgerArtifactRequestItem.groupBy({
        by: ["status"],
        where: {
          orgId: run.orgId,
          reconciliationTargets: { some: { reconciliationRunId: runId } }
        },
        _count: { _all: true }
      });
      const count = (statuses: string[]) =>
        groups
          .filter((group) => statuses.includes(group.status))
          .reduce((sum, group) => sum + group._count._all, 0);
      const repairTargetCount = count([
        "queued",
        "running",
        "succeeded",
        "empty",
        "superseded",
        "failed"
      ]);
      const repairPending = count(["queued", "running"]);
      const repairedCount = count(["succeeded", "empty"]);
      const repairFailedCount = count(["failed"]);
      const repairSupersededCount = count(["superseded"]);
      return {
        ...stateFrom(run),
        status: run.status,
        scanCompleted: run.phase === "completed",
        repairsCompleted:
          run.phase === "completed" && run.failedCount === 0 && repairedCount === repairTargetCount,
        repairTargetCount,
        repairSupersededCount,
        repairedCount,
        repairFailedCount,
        repairPending,
        errorCode: run.errorCode
      };
    }
  };
}
