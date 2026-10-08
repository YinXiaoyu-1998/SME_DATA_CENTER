import { createHash } from "node:crypto";
import { Prisma, PrismaClient, type PartitionDownloadRequest } from "@prisma/client";
import {
  loadPartitionDownloadLimits,
  parsePartitionStoreNameContains,
  type PartitionDownloadLimits
} from "@smedc/domain";
import { createDatabaseAdapter } from "./adapter.js";
import { retryIdempotentDatabaseOperation } from "./retry.js";
import { literalStoreNameScope, readablePartitionScope } from "./structured-partitions.js";
import { enqueueStorageGarbage, storageGarbageKeyHash } from "./storage-garbage.js";

export interface PartitionDownloadScope {
  dataset: "business" | "dishes";
  enterpriseKey: string;
  enterpriseName: string;
  startDate: string;
  endDate: string;
  storeNameContains?: string[];
  storeIds?: string[];
}
export interface DownloadActor {
  id: string;
  orgId: string;
  clearance: number;
  disabled: boolean;
}
export interface PartitionDownloadLease {
  runId: string;
  orgId: string;
  requestId: string;
  workerId: string;
  attemptNumber: number;
}
/** Internal snapshot: never expose object keys or confidentiality to clients. */
export interface PartitionDownloadEntry {
  id: string;
  storeKey: string;
  storeName: string;
  merchantId: string | null;
  enterpriseName: string;
  businessDate: string;
  objectKey: string;
  checksumSha256: string;
  byteSize: string;
  rowCount: string;
  confidentialityLevel: number;
}
export interface PartitionDownloadArtifact {
  objectKey: string;
  byteSize: bigint;
  checksumSha256: string;
  expiresAt: Date;
}
export interface PartitionDownloadStatus {
  requestId: string;
  status: "queued" | "running" | "succeeded" | "failed" | "expired";
  partitionCount: number;
  completedPartitionCount: number;
  totalRowCount: string;
  totalByteSize: string;
  retryAfterSeconds: number;
  errorCode: string | null;
  expiresAt: Date;
}
export interface CurrentPartitionDownload {
  request: PartitionDownloadStatus;
  requester: DownloadActor;
  scope: PartitionDownloadScope;
  manifest: PartitionDownloadEntry[];
  limits: PartitionDownloadLimits;
  artifact: PartitionDownloadArtifact | null;
}
export interface PartitionDownloadRepository {
  prepare(
    actor: DownloadActor,
    scope: PartitionDownloadScope,
    idempotencyKey: string
  ): Promise<PartitionDownloadStatus>;
  read(actor: DownloadActor, requestId: string): Promise<PartitionDownloadStatus>;
  validateCurrent(actor: DownloadActor, requestId: string): Promise<CurrentPartitionDownload>;
  markRunning(lease: PartitionDownloadLease): Promise<CurrentPartitionDownload | false>;
  recordProgress(lease: PartitionDownloadLease, completedPartitionCount: number): Promise<boolean>;
  fail(lease: PartitionDownloadLease, errorCode: string): Promise<boolean>;
  registerCandidate(lease: PartitionDownloadLease, objectKey: string): Promise<boolean>;
  publish(lease: PartitionDownloadLease, artifact: PartitionDownloadArtifact): Promise<boolean>;
  expire(now: Date): Promise<number>;
  disconnect(): Promise<void>;
}
export class PartitionDownloadRepositoryError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "PartitionDownloadRepositoryError";
  }
}
const error = (code: string) => new PartitionDownloadRepositoryError(code);
const active = ["queued", "running"] as const;
const defaults = loadPartitionDownloadLimits({});

export function canonicalizePartitionDownloadScope(
  scope: PartitionDownloadScope
): PartitionDownloadScope {
  const date = (value: string) =>
    /^\d{4}-\d{2}-\d{2}$/.test(value) &&
    Number.isFinite(Date.parse(value)) &&
    new Date(value).toISOString().slice(0, 10) === value;
  if (
    !["business", "dishes"].includes(scope.dataset) ||
    !scope.enterpriseKey.trim() ||
    !scope.enterpriseName.trim() ||
    !date(scope.startDate) ||
    !date(scope.endDate) ||
    scope.startDate > scope.endDate
  )
    throw error("INVALID_PARTITION_DOWNLOAD_SCOPE");
  const terms = parsePartitionStoreNameContains(scope.storeNameContains);
  if (
    scope.storeIds &&
    (!scope.storeIds.length ||
      scope.storeIds.length > 2000 ||
      scope.storeIds.some((id) => !id.trim() || id.length > 255))
  )
    throw error("INVALID_PARTITION_DOWNLOAD_SCOPE");
  return {
    dataset: scope.dataset,
    enterpriseKey: scope.enterpriseKey.normalize("NFC").trim(),
    enterpriseName: scope.enterpriseName.normalize("NFC").trim(),
    startDate: scope.startDate,
    endDate: scope.endDate,
    ...(terms ? { storeNameContains: [...new Set(terms)].sort() } : {}),
    ...(scope.storeIds
      ? { storeIds: [...new Set(scope.storeIds.map((id) => id.normalize("NFC").trim()))].sort() }
      : {})
  };
}
export function partitionDownloadFingerprint(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
export function assertPartitionDownloadSize(count: number, bytes: bigint, limits = defaults): void {
  if (
    count > limits.partitionDownloadMaxPartitions ||
    bytes > BigInt(limits.partitionDownloadMaxBytes)
  )
    throw error("PARTITION_DOWNLOAD_LIMIT_EXCEEDED");
}
function publicStatus(row: PartitionDownloadRequest): PartitionDownloadStatus {
  return {
    requestId: row.id,
    status: row.status,
    partitionCount: row.partitionCount,
    completedPartitionCount: row.completedPartitionCount,
    totalRowCount: row.totalRowCount.toString(),
    totalByteSize: row.totalByteSize.toString(),
    retryAfterSeconds: active.includes(row.status as (typeof active)[number]) ? 2 : 0,
    errorCode: row.errorCode,
    expiresAt: row.expiresAt
  };
}
function internal(
  row: PartitionDownloadRequest,
  requester: DownloadActor
): CurrentPartitionDownload {
  return {
    request: publicStatus(row),
    requester,
    scope: row.scope as unknown as PartitionDownloadScope,
    manifest: row.manifest as unknown as PartitionDownloadEntry[],
    limits: row.limits as unknown as PartitionDownloadLimits,
    artifact:
      row.objectKey && row.byteSize !== null && row.checksumSha256
        ? {
            objectKey: row.objectKey,
            byteSize: row.byteSize,
            checksumSha256: row.checksumSha256,
            expiresAt: row.expiresAt
          }
        : null
  };
}

export function createPrismaPartitionDownloadRepository(
  options: {
    prisma?: PrismaClient;
    databaseUrl?: string;
    limits?: PartitionDownloadLimits;
    now?: () => Date;
    transactionTimeoutMs?: number;
  } = {}
): PartitionDownloadRepository {
  const ownsClient = !options.prisma;
  const prisma =
    options.prisma ??
    new PrismaClient({
      adapter: createDatabaseAdapter(options.databaseUrl ?? process.env["DATABASE_URL"] ?? "")
    });
  const limits = options.limits ?? defaults;
  const now = options.now ?? (() => new Date());
  // Validate injected configuration too; API and worker cannot silently exceed hard bounds.
  loadPartitionDownloadLimits({
    PARTITION_DOWNLOAD_MAX_PARTITIONS: String(limits.partitionDownloadMaxPartitions),
    PARTITION_DOWNLOAD_MAX_BYTES: String(limits.partitionDownloadMaxBytes),
    PARTITION_DOWNLOAD_MAX_ACTIVE_PER_ORG: String(limits.partitionDownloadMaxActivePerOrg),
    PARTITION_DOWNLOAD_MAX_ACTIVE_PER_REQUESTER: String(
      limits.partitionDownloadMaxActivePerRequester
    ),
    PARTITION_DOWNLOAD_RETENTION_SECONDS: String(limits.partitionDownloadRetentionSeconds),
    PARTITION_DOWNLOAD_URL_TTL_SECONDS: String(limits.partitionDownloadUrlTtlSeconds)
  });
  const transaction = <T>(fn: (tx: Prisma.TransactionClient) => Promise<T>) =>
    retryIdempotentDatabaseOperation(() =>
      prisma.$transaction(fn, {
        isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted,
        timeout: options.transactionTimeoutMs ?? 30000
      })
    );
  async function authority(
    tx: Prisma.TransactionClient,
    actor: Pick<DownloadActor, "id" | "orgId">
  ) {
    await tx.$queryRaw(
      Prisma.sql`SELECT id FROM employees WHERE id=${actor.id} AND org_id=${actor.orgId} FOR SHARE`
    );
    const employee = await tx.employee.findFirst({ where: { id: actor.id, orgId: actor.orgId } });
    if (!employee || employee.disabled) throw error("PARTITION_DOWNLOAD_FORBIDDEN");
    return {
      id: employee.id,
      orgId: employee.orgId,
      clearance: employee.clearance,
      disabled: employee.disabled
    };
  }
  async function manifest(
    tx: Prisma.TransactionClient,
    actor: DownloadActor,
    scope: PartitionDownloadScope,
    maximum: number
  ): Promise<PartitionDownloadEntry[]> {
    const rows = await tx.$queryRaw<
      Array<
        Omit<PartitionDownloadEntry, "businessDate" | "rowCount" | "byteSize"> & {
          businessDate: Date;
          rowCount: bigint;
          byteSize: bigint;
        }
      >
    >(Prisma.sql`
      SELECT id, store_key AS storeKey, store_name AS storeName, merchant_id AS merchantId,
      enterprise_name AS enterpriseName, business_date AS businessDate, object_key AS objectKey,
      checksum_sha256 AS checksumSha256, byte_size AS byteSize, row_count AS rowCount,
      confidentiality_level AS confidentialityLevel FROM structured_partitions
      WHERE ${readablePartitionScope({ orgId: actor.orgId, clearance: actor.clearance, dataset: scope.dataset, enterpriseKey: scope.enterpriseKey })}
      AND business_date >= ${new Date(scope.startDate)} AND business_date <= ${new Date(scope.endDate)}
      ${scope.storeIds ? Prisma.sql`AND merchant_id IN (${Prisma.join(scope.storeIds)})` : Prisma.empty}
      ${scope.storeNameContains ? Prisma.sql`AND ${literalStoreNameScope(scope.storeNameContains)}` : Prisma.empty}
      ORDER BY business_date, store_key, id LIMIT ${maximum + 1} FOR SHARE
    `);
    return rows.map((row) => ({
      ...row,
      businessDate: row.businessDate.toISOString().slice(0, 10),
      rowCount: String(row.rowCount),
      byteSize: String(row.byteSize)
    }));
  }
  // All paths that touch an existing request lock its processing run first, then request.
  // GC protects candidate objects through this same run's live lease.
  async function lockRequest(tx: Prisma.TransactionClient, requestId: string, orgId: string) {
    await tx.$queryRaw(
      Prisma.sql`SELECT id FROM processing_runs WHERE partition_download_request_id=${requestId} AND org_id=${orgId} FOR UPDATE`
    );
    await tx.$queryRaw(
      Prisma.sql`SELECT id FROM partition_download_requests WHERE id=${requestId} AND org_id=${orgId} FOR UPDATE`
    );
    return tx.partitionDownloadRequest.findFirst({ where: { id: requestId, orgId } });
  }
  function downloadOwner(orgId: string, requestId: string): Prisma.ProcessingRunWhereInput {
    return {
      orgId,
      partitionDownloadRequestId: requestId,
      jobType: "structured_partition_bundle",
      documentId: null,
      partitionImportJobId: null,
      ledgerArtifactRequestId: null,
      ledgerArtifactRequestItemId: null,
      ledgerPdfReconciliationRunId: null
    };
  }
  async function terminate(
    tx: Prisma.TransactionClient,
    row: PartitionDownloadRequest,
    status: "failed" | "expired",
    code: string
  ) {
    if (row.objectKey) await enqueueStorageGarbage(tx, { objectKey: row.objectKey, reason: code });
    await tx.processingRun.updateMany({
      where: {
        ...downloadOwner(row.orgId, row.id),
        status: { in: ["queued", "running", "retry_scheduled"] }
      },
      data: {
        status: "failed",
        errorCode: code,
        errorSummary: code,
        lockedBy: null,
        lockedUntil: null,
        finishedAt: now()
      }
    });
    return tx.partitionDownloadRequest.update({
      where: { id: row.id },
      data: { status, errorCode: code, objectKey: null, byteSize: null, checksumSha256: null }
    });
  }
  async function expireRow(
    tx: Prisma.TransactionClient,
    row: PartitionDownloadRequest,
    clock: Date
  ) {
    return row.status !== "expired" && row.expiresAt <= clock
      ? terminate(tx, row, "expired", "PARTITION_DOWNLOAD_EXPIRED")
      : row;
  }
  async function checkCurrent(
    tx: Prisma.TransactionClient,
    row: PartitionDownloadRequest,
    employee: DownloadActor
  ): Promise<PartitionDownloadRequest> {
    row = await expireRow(tx, row, now());
    if (row.status === "failed" || row.status === "expired") return row;
    const snapshot = internal(row, employee);
    const current = await manifest(
      tx,
      employee,
      snapshot.scope,
      snapshot.limits.partitionDownloadMaxPartitions
    );
    if (partitionDownloadFingerprint(current) !== row.manifestFingerprint)
      return terminate(tx, row, "failed", "PARTITION_DOWNLOAD_STALE");
    return row;
  }
  class LeaseLost extends Error {}
  async function fenced<T>(
    lease: PartitionDownloadLease,
    fn: (tx: Prisma.TransactionClient, row: PartitionDownloadRequest) => Promise<T>
  ): Promise<T | false> {
    return transaction(async (tx) => {
      const row = await lockRequest(tx, lease.requestId, lease.orgId);
      const run = await tx.processingRun.findFirst({
        where: {
          id: lease.runId,
          ...downloadOwner(lease.orgId, lease.requestId),
          status: "running",
          lockedBy: lease.workerId,
          attemptNumber: lease.attemptNumber,
          lockedUntil: { gt: now() }
        }
      });
      if (!run || !row || !active.includes(row.status as (typeof active)[number])) return false;
      if (row.expiresAt <= now()) {
        await expireRow(tx, row, now());
        return false;
      }
      const result = await fn(tx, row);
      if (!run.lockedUntil || run.lockedUntil <= now()) throw new LeaseLost();
      return result;
    }).catch((cause) => {
      if (cause instanceof LeaseLost) return false;
      throw cause;
    });
  }
  const repository: PartitionDownloadRepository = {
    prepare(actor, input, idempotencyKey) {
      const scope = canonicalizePartitionDownloadScope(input);
      if (
        !idempotencyKey.trim() ||
        idempotencyKey.length > 128 ||
        idempotencyKey !== idempotencyKey.trim()
      )
        throw error("INVALID_IDEMPOTENCY_KEY");
      const fingerprint = partitionDownloadFingerprint(scope);
      return transaction(async (tx) => {
        // Organization serialization covers both organization and requester quotas, including races.
        await tx.$queryRaw(
          Prisma.sql`SELECT id FROM organizations WHERE id=${actor.orgId} FOR UPDATE`
        );
        const employee = await authority(tx, actor);
        const existing = await tx.partitionDownloadRequest.findUnique({
          where: {
            orgId_requesterId_idempotencyKey: {
              orgId: employee.orgId,
              requesterId: employee.id,
              idempotencyKey
            }
          }
        });
        if (existing) {
          if (existing.requestFingerprint !== fingerprint) throw error("IDEMPOTENCY_CONFLICT");
          const locked = await lockRequest(tx, existing.id, employee.orgId);
          return publicStatus(await expireRow(tx, locked!, now()));
        }
        const entries = await manifest(tx, employee, scope, limits.partitionDownloadMaxPartitions);
        const bytes = entries.reduce((sum, row) => sum + BigInt(row.byteSize), 0n);
        assertPartitionDownloadSize(entries.length, bytes, limits);
        if (entries.length) {
          const where = {
            orgId: employee.orgId,
            status: { in: [...active] },
            expiresAt: { gt: now() }
          };
          if (
            (await tx.partitionDownloadRequest.count({ where })) >=
              limits.partitionDownloadMaxActivePerOrg ||
            (await tx.partitionDownloadRequest.count({
              where: { ...where, requesterId: employee.id }
            })) >= limits.partitionDownloadMaxActivePerRequester
          )
            throw error("PARTITION_DOWNLOAD_ACTIVE_LIMIT_EXCEEDED");
        }
        const row = await tx.partitionDownloadRequest.create({
          data: {
            orgId: employee.orgId,
            requesterId: employee.id,
            idempotencyKey,
            requestFingerprint: fingerprint,
            scope: scope as unknown as Prisma.InputJsonValue,
            manifest: entries as unknown as Prisma.InputJsonValue,
            manifestFingerprint: partitionDownloadFingerprint(entries),
            limits: limits as unknown as Prisma.InputJsonValue,
            status: entries.length ? "queued" : "succeeded",
            partitionCount: entries.length,
            totalRowCount: entries.reduce((sum, entry) => sum + BigInt(entry.rowCount), 0n),
            totalByteSize: bytes,
            expiresAt: new Date(now().getTime() + limits.partitionDownloadRetentionSeconds * 1000)
          }
        });
        if (entries.length)
          await tx.processingRun.create({
            data: {
              orgId: row.orgId,
              partitionDownloadRequestId: row.id,
              jobKey: `structured_partition_bundle:${row.id}`,
              jobType: "structured_partition_bundle"
            }
          });
        return publicStatus(row);
      });
    },
    async read(actor, requestId) {
      const result = await transaction(async (tx) => {
        const row = await lockRequest(tx, requestId, actor.orgId);
        if (!row || row.requesterId !== actor.id) throw error("PARTITION_DOWNLOAD_NOT_FOUND");
        let employee: DownloadActor;
        try {
          employee = await authority(tx, actor);
        } catch (cause) {
          if (!(cause instanceof PartitionDownloadRepositoryError)) throw cause;
          await terminate(tx, row, "failed", cause.code);
          return cause;
        }
        return publicStatus(await checkCurrent(tx, row, employee));
      });
      if (result instanceof PartitionDownloadRepositoryError) throw result;
      return result;
    },
    async validateCurrent(actor, requestId) {
      const result = await transaction(async (tx) => {
        const row = await lockRequest(tx, requestId, actor.orgId);
        if (!row || row.requesterId !== actor.id) throw error("PARTITION_DOWNLOAD_NOT_FOUND");
        let employee: DownloadActor;
        try {
          employee = await authority(tx, actor);
        } catch (cause) {
          if (!(cause instanceof PartitionDownloadRepositoryError)) throw cause;
          await terminate(tx, row, "failed", cause.code);
          return cause;
        }
        return internal(await checkCurrent(tx, row, employee), employee);
      });
      if (result instanceof PartitionDownloadRepositoryError) throw result;
      if (["failed", "expired"].includes(result.request.status))
        throw error(result.request.errorCode ?? "PARTITION_DOWNLOAD_FAILED");
      return result;
    },
    markRunning(lease) {
      return fenced(lease, async (tx, row) => {
        let employee: DownloadActor;
        try {
          employee = await authority(tx, { id: row.requesterId, orgId: row.orgId });
        } catch (cause) {
          if (!(cause instanceof PartitionDownloadRepositoryError)) throw cause;
          await terminate(tx, row, "failed", cause.code);
          return false;
        }
        row = await checkCurrent(tx, row, employee);
        if (!active.includes(row.status as (typeof active)[number])) return false;
        row = await tx.partitionDownloadRequest.update({
          where: { id: row.id },
          data: { status: "running" }
        });
        return internal(row, employee);
      });
    },
    recordProgress(lease, completedPartitionCount) {
      return fenced(lease, async (tx, row) => {
        if (
          !Number.isSafeInteger(completedPartitionCount) ||
          completedPartitionCount < row.completedPartitionCount ||
          completedPartitionCount > row.partitionCount
        )
          throw error("INVALID_PARTITION_DOWNLOAD_PROGRESS");
        await tx.partitionDownloadRequest.update({
          where: { id: row.id },
          data: { completedPartitionCount }
        });
        return true;
      });
    },
    fail(lease, errorCode) {
      return fenced(lease, async (tx, row) => {
        const safe = [
          "PARTITION_DOWNLOAD_STALE",
          "PARTITION_DOWNLOAD_FORBIDDEN",
          "PARTITION_DOWNLOAD_LIMIT_EXCEEDED",
          "PARTITION_DOWNLOAD_SOURCE_INVALID",
          "PARTITION_DOWNLOAD_FAILED"
        ].includes(errorCode)
          ? errorCode
          : "PARTITION_DOWNLOAD_FAILED";
        await terminate(tx, row, "failed", safe);
        return true;
      });
    },
    registerCandidate(lease, objectKey) {
      return fenced(lease, async (tx) => {
        if (
          !objectKey.startsWith(
            `partition-downloads/${lease.orgId}/${lease.requestId}/${lease.attemptNumber}/`
          ) ||
          objectKey.length > 1024
        )
          throw error("INVALID_PARTITION_DOWNLOAD_OBJECT_KEY");
        await enqueueStorageGarbage(tx, {
          objectKey,
          reason: "partition_download_candidate",
          processingRunId: lease.runId
        });
        return true;
      });
    },
    publish(lease, artifact) {
      return fenced(lease, async (tx, row) => {
        let employee: DownloadActor;
        try {
          employee = await authority(tx, { id: row.requesterId, orgId: row.orgId });
        } catch (cause) {
          if (!(cause instanceof PartitionDownloadRepositoryError)) throw cause;
          await terminate(tx, row, "failed", cause.code);
          return false;
        }
        row = await checkCurrent(tx, row, employee);
        if (!active.includes(row.status as (typeof active)[number])) return false;
        if (
          !artifact.objectKey.startsWith(
            `partition-downloads/${lease.orgId}/${lease.requestId}/${lease.attemptNumber}/`
          )
        )
          throw error("INVALID_PARTITION_DOWNLOAD_OBJECT_KEY");
        const garbage = await tx.storageGarbage.findUnique({
          where: { objectKeyHash: storageGarbageKeyHash(artifact.objectKey) }
        });
        if (
          !garbage ||
          garbage.objectKey !== artifact.objectKey ||
          garbage.processingRunId !== lease.runId
        )
          throw error("PARTITION_DOWNLOAD_CANDIDATE_REQUIRED");
        if (
          artifact.byteSize < 0n ||
          !/^[a-f0-9]{64}$/.test(artifact.checksumSha256) ||
          artifact.expiresAt <= now() ||
          artifact.expiresAt > row.expiresAt
        )
          throw error("INVALID_PARTITION_DOWNLOAD_ARTIFACT");
        // Recheck at the end: even a locked run can pass its wall-clock deadline during validation.
        const live = await tx.processingRun.updateMany({
          where: {
            id: lease.runId,
            status: "running",
            lockedBy: lease.workerId,
            attemptNumber: lease.attemptNumber,
            lockedUntil: { gt: now() }
          },
          data: {
            status: "succeeded",
            lockedBy: null,
            lockedUntil: null,
            finishedAt: now(),
            errorCode: null,
            errorSummary: null
          }
        });
        if (live.count !== 1) return false;
        await tx.partitionDownloadRequest.update({
          where: { id: row.id },
          data: {
            status: "succeeded",
            completedPartitionCount: row.partitionCount,
            objectKey: artifact.objectKey,
            byteSize: artifact.byteSize,
            checksumSha256: artifact.checksumSha256,
            expiresAt: artifact.expiresAt,
            errorCode: null
          }
        });
        await tx.storageGarbage.delete({ where: { id: garbage.id } });
        await enqueueStorageGarbage(tx, {
          objectKey: artifact.objectKey,
          reason: "partition_download_expired",
          availableAt: artifact.expiresAt
        });
        return true;
      });
    },
    async expire(clock) {
      const rows = await prisma.partitionDownloadRequest.findMany({
        where: { status: { not: "expired" }, expiresAt: { lte: clock } },
        select: { id: true, orgId: true },
        take: 100,
        orderBy: { expiresAt: "asc" }
      });
      let count = 0;
      for (const candidate of rows)
        count += await transaction(async (tx) => {
          const row = await lockRequest(tx, candidate.id, candidate.orgId);
          if (!row || row.status === "expired" || row.expiresAt > clock) return 0;
          await expireRow(tx, row, clock);
          return 1;
        });
      return count;
    },
    async disconnect() {
      if (ownsClient) await prisma.$disconnect();
    }
  };
  return repository;
}
