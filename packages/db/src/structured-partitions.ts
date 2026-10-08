import { enqueueStorageGarbage, listDueStorageGarbage } from "./storage-garbage.js";
import { randomBytes } from "node:crypto";
import { createDatabaseAdapter } from "./adapter.js";
import { retryIdempotentDatabaseOperation } from "./retry.js";
import {
  PartitionDataset,
  PartitionImportJobStatus,
  Prisma,
  PrismaClient,
  ProcessingJobType,
  ProcessingRunStatus
} from "@prisma/client";

export interface CurrentPartitionState {
  id: string;
  objectKey: string;
  checksumSha256: string;
  confidentialityLevel: number;
  enterpriseName: string;
  merchantId: string | null;
  storeName: string;
  rowCount: bigint;
  byteSize: bigint;
}

export interface PartitionCandidate extends CurrentPartitionState {
  orgId: string;
  enterpriseKey: string;
  dataset: "business" | "dishes";
  storeKey: string;
  businessDate: string;
}

export function decidePartitionReplacement(
  current: CurrentPartitionState | null,
  candidate: PartitionCandidate
): {
  action: "insert" | "keep" | "update_metadata" | "replace";
  objectKey: string;
  garbageObjectKeys: string[];
} {
  if (!current) {
    return { action: "insert", objectKey: candidate.objectKey, garbageObjectKeys: [] };
  }
  if (current.checksumSha256 !== candidate.checksumSha256) {
    return {
      action: "replace",
      objectKey: candidate.objectKey,
      garbageObjectKeys: [current.objectKey]
    };
  }
  const metadataMatches =
    current.confidentialityLevel === candidate.confidentialityLevel &&
    current.enterpriseName === candidate.enterpriseName &&
    current.merchantId === candidate.merchantId &&
    current.storeName === candidate.storeName &&
    current.rowCount === candidate.rowCount &&
    current.byteSize === candidate.byteSize;
  return {
    action: metadataMatches ? "keep" : "update_metadata",
    objectKey: current.objectKey,
    garbageObjectKeys: [candidate.objectKey]
  };
}

export function partitionIdentityWhere(candidate: PartitionCandidate) {
  return {
    orgId: candidate.orgId,
    enterpriseKey: candidate.enterpriseKey,
    dataset: candidate.dataset,
    storeKey: candidate.storeKey,
    businessDate: new Date(`${candidate.businessDate}T00:00:00.000Z`)
  };
}

export interface PartitionImportJobRecord {
  id: string;
  orgId: string;
  uploaderId: string;
  dataset: "business" | "dishes";
  enterpriseKey: string;
  enterpriseName: string;
  confidentialityLevel: number;
  originalFileName: string;
  mediaType: string;
  sourceByteSize: bigint;
  sourceChecksumSha256: string;
  sourceStartDate: Date;
  sourceEndDate: Date;
  temporaryObjectKey: string | null;
  multipartUploadId: string | null;
  status:
    | "uploading"
    | "queued"
    | "processing"
    | "published"
    | "rejected"
    | "failed"
    | "cancelled"
    | "expired";
  totalRowCount: bigint;
  partitionCount: number;
  errorCode: string | null;
  errorSummary: string | null;
  validationErrors: unknown[];
  expiresAt: Date;
  publishedAt: Date | null;
  finishedAt: Date | null;
}

export interface StructuredPartitionRepository {
  reserveUpload(input: {
    id?: string;
    orgId: string;
    uploaderId: string;
    dataset: "business" | "dishes";
    enterpriseKey: string;
    enterpriseName: string;
    confidentialityLevel: number;
    idempotencyKey: string;
    requestFingerprint: string;
    originalFileName: string;
    mediaType: string;
    sourceByteSize: bigint;
    sourceChecksumSha256: string;
    sourceStartDate: string;
    sourceEndDate: string;
    expiresAt: Date;
    temporaryObjectKey: string;
    multipartUploadId: string;
  }): Promise<{ state: "created" | "existing"; job: PartitionImportJobRecord }>;
  queueCompletedUpload(input: {
    orgId: string;
    jobId: string;
    temporaryObjectKey: string;
  }): Promise<PartitionImportJobRecord>;
  findJobForStatus(orgId: string, jobId: string): Promise<PartitionImportJobRecord | null>;
  markJobProcessing(orgId: string, jobId: string): Promise<boolean>;
  finishJob(input: {
    orgId: string;
    jobId: string;
    status: "rejected" | "failed" | "cancelled" | "expired";
    errorCode?: string;
    errorSummary?: string;
    validationErrors?: unknown[];
  }): Promise<void>;
  listExpiredUploads(now: Date, limit: number): Promise<ExpiredPartitionUpload[]>;
  publishSourceAtomically(input: {
    orgId: string;
    jobId: string;
    totalRowCount: bigint;
    candidates: PartitionCandidate[];
  }): Promise<{ garbageObjectKeys: string[] }>;
  listReadableManifestRows(input: {
    orgId: string;
    clearance: number;
    dataset: "business" | "dishes";
    enterpriseKey: string;
    startDate: string;
    endDate: string;
    storeIds?: string[];
    storeNameContains?: string[];
    maxPartitions: number;
  }): Promise<PartitionManifestRow[]>;
  listCoverage?(input: {
    orgId: string;
    clearance: number;
    dataset: "business" | "dishes";
    enterpriseKey?: string;
    storeNameContains?: string[];
  }): Promise<PartitionDatasetCoverage>;
  enqueueGarbage(objectKey: string, reason: string): Promise<void>;
  listDueGarbage(now: Date, limit: number): Promise<Array<{ id: string; objectKey: string }>>;
  deleteGarbage(id: string): Promise<void>;
  markObjectDeleted(objectKey: string): Promise<void>;
  postponeGarbage(id: string, errorCode: string, availableAt: Date): Promise<void>;
  deleteTerminalJobs(before: Date, limit: number): Promise<number>;
  disconnect?(): Promise<void>;
}

export interface ExpiredPartitionUpload {
  id: string;
  orgId: string;
  temporaryObjectKey: string;
  multipartUploadId: string;
}

export interface PartitionDatasetCoverage {
  dataset: "business" | "dishes";
  enterprises: Array<{
    enterpriseKey: string;
    enterpriseName: string;
    startDate: Date;
    endDate: Date;
    partitionCount: number;
    totalRowCount: bigint;
    stores: Array<{ storeId: string | null; storeName: string }>;
  }>;
}

export interface StructuredPartitionRecord extends CurrentPartitionState {
  orgId: string;
  enterpriseKey: string;
  enterpriseName: string;
  dataset: "business" | "dishes";
  storeKey: string;
  businessDate: Date;
  publishedByJobId: string;
}

export type PartitionManifestRow = Pick<
  StructuredPartitionRecord,
  | "businessDate"
  | "merchantId"
  | "storeName"
  | "rowCount"
  | "byteSize"
  | "checksumSha256"
  | "objectKey"
>;

export class StructuredPartitionRepositoryError extends Error {
  constructor(
    readonly code: string,
    message = code
  ) {
    super(message);
    this.name = "StructuredPartitionRepositoryError";
  }
}

export function createPrismaStructuredPartitionRepository(
  options: {
    databaseUrl?: string;
    transactionTimeoutMs?: number;
    prisma?: PrismaClient;
  } = {}
): StructuredPartitionRepository {
  const ownsClient = !options.prisma;
  const prisma =
    options.prisma ??
    new PrismaClient({
      adapter: createDatabaseAdapter(
        options.databaseUrl ??
          process.env["DATABASE_URL"] ??
          (() => {
            throw new Error("DATABASE_URL is required for the partition repository.");
          })()
      )
    });
  const transactionTimeoutMs = options.transactionTimeoutMs ?? 120_000;

  return {
    async reserveUpload(input) {
      if (input.confidentialityLevel < 0 || input.confidentialityLevel > 3)
        throw new StructuredPartitionRepositoryError(
          "INVALID_CONFIDENTIALITY_LEVEL",
          "Confidentiality level must be between 0 and 3."
        );
      const existing = await prisma.partitionImportJob.findUnique({
        where: {
          orgId_idempotencyKey: { orgId: input.orgId, idempotencyKey: input.idempotencyKey }
        }
      });
      if (existing)
        return existingReservation(existing, input.requestFingerprint, input.uploaderId);
      try {
        const created = await prisma.partitionImportJob.create({
          data: {
            id: input.id ?? createId("pjob"),
            orgId: input.orgId,
            uploaderId: input.uploaderId,
            dataset: input.dataset as PartitionDataset,
            enterpriseKey: input.enterpriseKey,
            enterpriseName: input.enterpriseName,
            confidentialityLevel: input.confidentialityLevel,
            idempotencyKey: input.idempotencyKey,
            requestFingerprint: input.requestFingerprint,
            originalFileName: input.originalFileName,
            mediaType: input.mediaType,
            sourceByteSize: input.sourceByteSize,
            sourceChecksumSha256: input.sourceChecksumSha256,
            sourceStartDate: parseBusinessDate(input.sourceStartDate),
            sourceEndDate: parseBusinessDate(input.sourceEndDate),
            expiresAt: input.expiresAt,
            temporaryObjectKey: input.temporaryObjectKey,
            multipartUploadId: input.multipartUploadId
          }
        });
        return { state: "created", job: toJobRecord(created) };
      } catch (error) {
        if (!isUniqueConstraintError(error)) throw error;
        const authoritative = await prisma.partitionImportJob.findUniqueOrThrow({
          where: {
            orgId_idempotencyKey: { orgId: input.orgId, idempotencyKey: input.idempotencyKey }
          }
        });
        return existingReservation(authoritative, input.requestFingerprint, input.uploaderId);
      }
    },

    async queueCompletedUpload(input) {
      return retryIdempotentDatabaseOperation(async () =>
        prisma.$transaction(
          async (tx) => {
            const job = await tx.partitionImportJob.findFirstOrThrow({
              where: { id: input.jobId, orgId: input.orgId }
            });
            if (job.status !== PartitionImportJobStatus.uploading) return toJobRecord(job);
            const updated = await tx.partitionImportJob.update({
              where: { id: job.id },
              data: {
                temporaryObjectKey: input.temporaryObjectKey,
                multipartUploadId: null,
                status: PartitionImportJobStatus.queued
              }
            });
            await tx.processingRun.create({
              data: {
                orgId: input.orgId,
                partitionImportJobId: job.id,
                jobKey: `structured_partition_import:${job.id}`,
                status: ProcessingRunStatus.queued,
                jobType: ProcessingJobType.structured_partition_import
              }
            });
            return toJobRecord(updated);
          },
          { timeout: transactionTimeoutMs }
        )
      );
    },

    async findJobForStatus(orgId, jobId) {
      const job = await prisma.partitionImportJob.findFirst({ where: { id: jobId, orgId } });
      return job ? toJobRecord(job) : null;
    },

    async markJobProcessing(orgId, jobId) {
      const changed = await prisma.partitionImportJob.updateMany({
        where: { id: jobId, orgId, status: PartitionImportJobStatus.queued },
        data: { status: PartitionImportJobStatus.processing }
      });
      return changed.count === 1;
    },

    async finishJob(input) {
      await prisma.partitionImportJob.updateMany({
        where: {
          id: input.jobId,
          orgId: input.orgId,
          status: {
            in: [
              PartitionImportJobStatus.uploading,
              PartitionImportJobStatus.queued,
              PartitionImportJobStatus.processing
            ]
          }
        },
        data: {
          status: input.status as PartitionImportJobStatus,
          errorCode: input.errorCode ?? null,
          errorSummary: input.errorSummary ?? null,
          validationErrors: (input.validationErrors ?? []) as Prisma.InputJsonValue,
          finishedAt: new Date()
        }
      });
    },

    async listExpiredUploads(now, limit) {
      return prisma.partitionImportJob.findMany({
        where: {
          status: PartitionImportJobStatus.uploading,
          expiresAt: { lte: now },
          temporaryObjectKey: { not: null },
          multipartUploadId: { not: null }
        },
        orderBy: { expiresAt: "asc" },
        take: limit,
        select: {
          id: true,
          orgId: true,
          temporaryObjectKey: true,
          multipartUploadId: true
        }
      }) as Promise<ExpiredPartitionUpload[]>;
    },

    async publishSourceAtomically(input) {
      const identities = new Set<string>();
      for (const candidate of input.candidates) {
        if (candidate.orgId !== input.orgId)
          throw new StructuredPartitionRepositoryError("PARTITION_ORG_MISMATCH");
        const key = `${candidate.enterpriseKey}\u0000${candidate.dataset}\u0000${candidate.storeKey}\u0000${candidate.businessDate}`;
        if (identities.has(key))
          throw new StructuredPartitionRepositoryError("PARTITION_DUPLICATE_CANDIDATE");
        identities.add(key);
      }
      const sorted = [...input.candidates].sort((left, right) =>
        identityLockKey(left).localeCompare(identityLockKey(right))
      );
      return retryIdempotentDatabaseOperation(async () =>
        prisma.$transaction(
          async (tx) => {
            const job = await tx.partitionImportJob.findFirstOrThrow({
              where: {
                id: input.jobId,
                orgId: input.orgId,
                status: PartitionImportJobStatus.processing
              }
            });
            const garbage = new Set<string>();
            for (const candidate of sorted) {
              const identity = partitionIdentityWhere(candidate);
              await tx.$queryRaw(
                Prisma.sql`SELECT id FROM structured_partitions WHERE org_id = ${identity.orgId} AND enterprise_key = ${identity.enterpriseKey} AND dataset = ${identity.dataset} AND store_key = ${identity.storeKey} AND business_date = ${identity.businessDate} FOR UPDATE`
              );
              const current = await tx.structuredPartition.findUnique({
                where: {
                  orgId_enterpriseKey_dataset_storeKey_businessDate: {
                    ...identity,
                    dataset: identity.dataset as PartitionDataset
                  }
                }
              });
              const decision = decidePartitionReplacement(current, candidate);
              for (const objectKey of decision.garbageObjectKeys) garbage.add(objectKey);

              if (decision.action === "insert") {
                await tx.structuredPartition.create({ data: partitionCreate(candidate, job.id) });
              } else if (decision.action === "update_metadata") {
                await tx.structuredPartition.update({
                  where: { id: current!.id },
                  data: partitionMetadata(candidate, job.id)
                });
              } else if (decision.action === "replace") {
                await tx.structuredPartition.update({
                  where: { id: current!.id },
                  data: { ...partitionMetadata(candidate, job.id), objectKey: candidate.objectKey }
                });
              }
            }
            for (const objectKey of garbage) {
              await enqueueStorageGarbage(tx, { objectKey, reason: "partition_replaced" });
            }
            if (job.temporaryObjectKey) {
              await enqueueStorageGarbage(tx, {
                objectKey: job.temporaryObjectKey,
                reason: "partition_source_terminal"
              });
            }
            const now = new Date();
            await tx.partitionImportJob.update({
              where: { id: job.id },
              data: {
                status: PartitionImportJobStatus.published,
                totalRowCount: input.totalRowCount,
                partitionCount: input.candidates.length,
                publishedAt: now,
                finishedAt: now,
                temporaryObjectKey: null,
                multipartUploadId: null,
                errorCode: null,
                errorSummary: null,
                validationErrors: Prisma.DbNull
              }
            });
            return { garbageObjectKeys: [...garbage] };
          },
          {
            isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
            timeout: transactionTimeoutMs
          }
        )
      );
    },

    async listReadableManifestRows(input) {
      if (input.storeNameContains !== undefined) {
        return prisma.$queryRaw<PartitionManifestRow[]>(Prisma.sql`
          SELECT business_date AS businessDate, merchant_id AS merchantId, store_name AS storeName,
            row_count AS rowCount, byte_size AS byteSize, checksum_sha256 AS checksumSha256, object_key AS objectKey
          FROM structured_partitions WHERE ${readablePartitionScope(input)}
            AND business_date >= ${parseBusinessDate(input.startDate)}
            AND business_date <= ${parseBusinessDate(input.endDate)}
            ${input.storeIds?.length ? Prisma.sql`AND merchant_id IN (${Prisma.join(input.storeIds)})` : Prisma.empty}
            AND ${literalStoreNameScope(input.storeNameContains)}
          ORDER BY business_date ASC, store_key ASC LIMIT ${input.maxPartitions + 1}
        `);
      }
      const rows = await prisma.structuredPartition.findMany({
        where: {
          orgId: input.orgId,
          confidentialityLevel: { lte: input.clearance },
          dataset: input.dataset as PartitionDataset,
          enterpriseKey: input.enterpriseKey,
          businessDate: {
            gte: parseBusinessDate(input.startDate),
            lte: parseBusinessDate(input.endDate)
          },
          ...(input.storeIds?.length ? { merchantId: { in: input.storeIds } } : {})
        },
        orderBy: [{ businessDate: "asc" }, { storeKey: "asc" }],
        take: input.maxPartitions + 1,
        select: {
          businessDate: true,
          merchantId: true,
          storeName: true,
          rowCount: true,
          byteSize: true,
          checksumSha256: true,
          objectKey: true
        }
      });
      return rows;
    },

    async listCoverage(input) {
      if (input.storeNameContains !== undefined) {
        const where = Prisma.sql`${readablePartitionScope(input)} AND ${literalStoreNameScope(input.storeNameContains)}`;
        const [enterprises, stores] = await Promise.all([
          prisma.$queryRaw<
            Array<{
              enterpriseKey: string;
              enterpriseName: string;
              startDate: Date;
              endDate: Date;
              partitionCount: bigint;
              totalRowCount: Prisma.Decimal;
            }>
          >(Prisma.sql`SELECT enterprise_key AS enterpriseKey, MAX(enterprise_name) AS enterpriseName,
            MIN(business_date) AS startDate, MAX(business_date) AS endDate,
            COUNT(*) AS partitionCount, SUM(row_count) AS totalRowCount
            FROM structured_partitions WHERE ${where} GROUP BY enterprise_key ORDER BY enterprise_key ASC`),
          prisma.$queryRaw<
            Array<{ enterpriseKey: string; storeId: string | null; storeName: string }>
          >(
            Prisma.sql`SELECT enterprise_key AS enterpriseKey, MAX(merchant_id) AS storeId, MAX(store_name) AS storeName
              FROM structured_partitions WHERE ${where} GROUP BY enterprise_key, store_key ORDER BY enterprise_key ASC, store_key ASC`
          )
        ]);
        return {
          dataset: input.dataset,
          enterprises: enterprises.map((enterprise) => ({
            ...enterprise,
            partitionCount: Number(enterprise.partitionCount),
            totalRowCount: BigInt(enterprise.totalRowCount.toString()),
            stores: stores
              .filter((store) => store.enterpriseKey === enterprise.enterpriseKey)
              .map(({ storeId, storeName }) => ({ storeId, storeName }))
          }))
        };
      }
      const where = {
        orgId: input.orgId,
        dataset: input.dataset as PartitionDataset,
        confidentialityLevel: { lte: input.clearance },
        ...(input.enterpriseKey !== undefined ? { enterpriseKey: input.enterpriseKey } : {})
      };
      const [enterpriseRows, storeRows] = await Promise.all([
        prisma.structuredPartition.groupBy({
          by: ["enterpriseKey"],
          where,
          _min: { businessDate: true },
          _max: { businessDate: true, enterpriseName: true },
          _count: { _all: true },
          _sum: { rowCount: true },
          orderBy: { enterpriseKey: "asc" }
        }),
        prisma.structuredPartition.groupBy({
          by: ["enterpriseKey", "storeKey"],
          where,
          _max: { merchantId: true, storeName: true },
          orderBy: [{ enterpriseKey: "asc" }, { storeKey: "asc" }]
        })
      ]);
      return {
        dataset: input.dataset,
        enterprises: enterpriseRows.map((enterprise) => ({
          enterpriseKey: enterprise.enterpriseKey,
          enterpriseName: enterprise._max.enterpriseName!,
          startDate: enterprise._min.businessDate!,
          endDate: enterprise._max.businessDate!,
          partitionCount: enterprise._count._all,
          totalRowCount: enterprise._sum.rowCount ?? 0n,
          stores: storeRows
            .filter((store) => store.enterpriseKey === enterprise.enterpriseKey)
            .map((store) => ({
              storeId: store._max.merchantId,
              storeName: store._max.storeName!
            }))
        }))
      };
    },

    async enqueueGarbage(objectKey, reason) {
      await enqueueStorageGarbage(prisma, { objectKey, reason });
    },

    async listDueGarbage(now, limit) {
      return listDueStorageGarbage(prisma, now, limit);
    },

    async deleteGarbage(id) {
      // Keep candidate tombstones: a paused expired uploader can still finish a late write.
      await prisma.storageGarbage.updateMany({
        where: { id, repeatDeletion: true },
        data: {
          availableAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
          lastErrorCode: null
        }
      });
      await prisma.storageGarbage.deleteMany({ where: { id, repeatDeletion: false } });
    },

    async markObjectDeleted(objectKey) {
      await prisma.storageGarbage.deleteMany({ where: { objectKey } });
    },

    async postponeGarbage(id, errorCode, availableAt) {
      await prisma.storageGarbage.updateMany({
        where: { id },
        data: { attemptCount: { increment: 1 }, lastErrorCode: errorCode, availableAt }
      });
    },

    async deleteTerminalJobs(before, limit) {
      const jobs = await prisma.partitionImportJob.findMany({
        where: {
          status: {
            in: [
              PartitionImportJobStatus.published,
              PartitionImportJobStatus.rejected,
              PartitionImportJobStatus.failed,
              PartitionImportJobStatus.cancelled,
              PartitionImportJobStatus.expired
            ]
          },
          finishedAt: { lt: before }
        },
        orderBy: { finishedAt: "asc" },
        take: limit,
        select: { id: true }
      });
      if (!jobs.length) return 0;
      const deleted = await prisma.partitionImportJob.deleteMany({
        where: { id: { in: jobs.map((job) => job.id) } }
      });
      return deleted.count;
    },

    async disconnect() {
      if (ownsClient) await prisma.$disconnect();
    }
  };
}

function existingReservation(
  existing: Parameters<typeof toJobRecord>[0] & { requestFingerprint: string },
  requestFingerprint: string,
  uploaderId: string
): { state: "existing"; job: PartitionImportJobRecord } {
  if (existing.requestFingerprint !== requestFingerprint || existing.uploaderId !== uploaderId)
    throw new StructuredPartitionRepositoryError(
      "IDEMPOTENCY_KEY_REUSED",
      "Idempotency key was already used for a different partition upload."
    );
  return { state: "existing", job: toJobRecord(existing) };
}

function toJobRecord(job: {
  id: string;
  orgId: string;
  uploaderId: string;
  dataset: PartitionDataset;
  enterpriseKey: string;
  enterpriseName: string;
  confidentialityLevel: number;
  originalFileName: string;
  mediaType: string;
  sourceByteSize: bigint;
  sourceChecksumSha256: string;
  sourceStartDate: Date;
  sourceEndDate: Date;
  temporaryObjectKey: string | null;
  multipartUploadId: string | null;
  status: PartitionImportJobStatus;
  totalRowCount: bigint;
  partitionCount: number;
  errorCode: string | null;
  errorSummary: string | null;
  validationErrors: Prisma.JsonValue | null;
  expiresAt: Date;
  publishedAt: Date | null;
  finishedAt: Date | null;
}): PartitionImportJobRecord {
  return {
    ...job,
    dataset: job.dataset,
    status: job.status,
    validationErrors: Array.isArray(job.validationErrors) ? job.validationErrors : []
  };
}

function partitionCreate(candidate: PartitionCandidate, jobId: string) {
  return {
    id: candidate.id,
    ...partitionIdentityWhere(candidate),
    dataset: candidate.dataset as PartitionDataset,
    ...partitionMetadata(candidate, jobId),
    objectKey: candidate.objectKey
  };
}

function partitionMetadata(candidate: PartitionCandidate, jobId: string) {
  return {
    enterpriseName: candidate.enterpriseName,
    merchantId: candidate.merchantId,
    storeName: candidate.storeName,
    rowCount: candidate.rowCount,
    byteSize: candidate.byteSize,
    checksumSha256: candidate.checksumSha256,
    confidentialityLevel: candidate.confidentialityLevel,
    publishedByJobId: jobId
  };
}

function identityLockKey(candidate: PartitionCandidate): string {
  return `${candidate.orgId}\u0000${candidate.enterpriseKey}\u0000${candidate.dataset}\u0000${candidate.storeKey}\u0000${candidate.businessDate}`;
}

function parseBusinessDate(value: string): Date {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value))
    throw new StructuredPartitionRepositoryError("INVALID_BUSINESS_DATE");
  const date = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value)
    throw new StructuredPartitionRepositoryError("INVALID_BUSINESS_DATE");
  return date;
}

function createId(prefix: string): string {
  return `${prefix}_${randomBytes(12).toString("hex")}`;
}

function isUniqueConstraintError(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002";
}

export function readablePartitionScope(input: {
  orgId: string;
  clearance: number;
  dataset: "business" | "dishes";
  enterpriseKey?: string;
}): Prisma.Sql {
  return Prisma.sql`org_id = ${input.orgId} AND confidentiality_level <= ${input.clearance} AND dataset = ${input.dataset}
    ${input.enterpriseKey !== undefined ? Prisma.sql`AND enterprise_key = ${input.enterpriseKey}` : Prisma.empty}`;
}

export function literalStoreNameScope(terms: string[]): Prisma.Sql {
  // LOCATE has no wildcard syntax; binary operands make case and accents literal regardless of table collation.
  if (terms.length === 0)
    throw new StructuredPartitionRepositoryError("INVALID_PARTITION_STORE_NAME_FILTER");
  return Prisma.sql`(${Prisma.join(
    terms.map(
      (term) => Prisma.sql`LOCATE(CAST(${term} AS BINARY), CAST(store_name AS BINARY)) > 0`
    ),
    " OR "
  )})`;
}
