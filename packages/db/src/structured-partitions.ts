import {
  isOrderPartitionDataset,
  effectiveOrderScope,
  normalizeEnterpriseIdentity,
  validateOrderScopeDataset,
  type OrderScope,
  type DeclaredOrderScope,
  type PrepareOrderScopeTransition,
  type OrderScopeTransitionPreview,
  type OrderScopeTransitionConfirmation,
  type PartitionDatasetName,
  type AuthorizationSnapshot
} from "@smedc/domain";
import { compileStructuredReadScope } from "./business-authorization-sql.js";
import {
  bindHistoricalSupplementIntent,
  readHistoricalSupplementIntent,
  ResourceAttributesError
} from "./business-authorization.js";
import {
  lockAuthorizationPublication,
  persistPartitionReadRequirement,
  requireCurrentUploadAdmin
} from "./source-read-requirements.js";
import {
  canDeleteStorageGarbage,
  enqueueStorageGarbage,
  listDueStorageGarbage
} from "./storage-garbage.js";
import { createHash, randomBytes } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
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
  orderScope?: OrderScope | null;
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
  dataset: PartitionDatasetName;
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
    effectiveOrderScope(candidate.dataset, current.orderScope) ===
      effectiveOrderScope(candidate.dataset, candidate.orderScope) &&
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
  orderScope?: OrderScope | null;
  id: string;
  orgId: string;
  uploaderId: string;
  dataset: PartitionDatasetName;
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

export interface PartitionImportLease {
  runId: string;
  workerId: string;
  attemptNumber: number;
}

export interface StructuredPartitionRepository {
  prepareOrderScopeTransition?(
    input: PrepareOrderScopeTransition & { orgId: string; actorId: string }
  ): Promise<OrderScopeTransitionPreview>;
  reserveUpload(input: {
    orderScope?: DeclaredOrderScope;
    orderScopeTransition?: OrderScopeTransitionConfirmation;
    historicalSupplementReason?: string;
    id?: string;
    orgId: string;
    uploaderId: string;
    dataset: PartitionDatasetName;
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
    lease?: PartitionImportLease;
    orgId: string;
    jobId: string;
    status: "rejected" | "failed" | "cancelled" | "expired";
    errorCode?: string;
    errorSummary?: string;
    validationErrors?: unknown[];
    uploaderId?: string;
  }): Promise<boolean | void>;
  listExpiredUploads(now: Date, limit: number): Promise<ExpiredPartitionUpload[]>;
  publishSourceAtomically(input: {
    lease: PartitionImportLease;
    orgId: string;
    jobId: string;
    totalRowCount: bigint;
    candidates: PartitionCandidate[];
  }): Promise<{ garbageObjectKeys: string[] }>;
  listReadableManifestRows(input: {
    orgId: string;
    clearance: number;
    authorization?: AuthorizationSnapshot;
    dataset: PartitionDatasetName;
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
    authorization?: AuthorizationSnapshot;
    dataset: PartitionDatasetName;
    enterpriseKey?: string;
    storeNameContains?: string[];
  }): Promise<PartitionDatasetCoverage>;
  enqueueGarbage(objectKey: string, reason: string): Promise<void>;
  listDueGarbage(now: Date, limit: number): Promise<Array<{ id: string; objectKey: string }>>;
  canDeleteGarbage?(input: { id: string; objectKey: string; now: Date }): Promise<boolean>;
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
  dataset: PartitionDatasetName;
  enterprises: Array<{
    enterpriseKey: string;
    enterpriseName: string;
    startDate: Date;
    endDate: Date;
    partitionCount: number;
    totalRowCount: bigint;
    stores: Array<{ storeId: string | null; storeName: string }>;
    orderScopes?: Array<{
      orderScope: OrderScope;
      startDate: Date;
      endDate: Date;
      partitionCount: number;
      totalRowCount: bigint;
    }>;
  }>;
}

export interface StructuredPartitionRecord extends CurrentPartitionState {
  orgId: string;
  enterpriseKey: string;
  enterpriseName: string;
  dataset: PartitionDatasetName;
  storeKey: string;
  businessDate: Date;
  publishedByJobId: string;
}

export type PartitionManifestRow = Pick<
  StructuredPartitionRecord,
  | "orderScope"
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
    async prepareOrderScopeTransition(input) {
      const enterprise = normalizeEnterpriseIdentity(input.enterpriseName);
      const storeNames = [...new Set(input.storeNames)].sort();
      return prisma.$transaction(
        async (tx) => {
          await lockOrderScopeControl(tx, input.orgId);
          await requireCurrentUploadAdmin(tx, input.orgId, input.actorId);
          await requireOrderScopeStores(tx, input.orgId, enterprise.enterpriseKey, storeNames);
          const selection = {
            orgId: input.orgId,
            enterpriseKey: enterprise.enterpriseKey,
            startDate: parseBusinessDate(input.startDate),
            endDate: parseBusinessDate(input.endDate),
            storeNames
          };
          const snapshot = await orderScopeSnapshot(tx, selection);
          if (!snapshot.length || snapshot.every((row) => row.orderScope === input.orderScope))
            throw new StructuredPartitionRepositoryError(
              "ORDER_SCOPE_CONFLICT",
              "No current partitions require this source scope transition."
            );
          const id = createId("osc");
          const expiresAt = new Date(Date.now() + 30 * 60_000);
          const confirmationDigest = createHash("sha256")
            .update(
              JSON.stringify({
                id,
                orgId: input.orgId,
                actorId: input.actorId,
                enterpriseKey: enterprise.enterpriseKey,
                storeNames,
                startDate: input.startDate,
                endDate: input.endDate,
                orderScope: input.orderScope,
                sourceChecksumSha256: input.sourceChecksumSha256,
                snapshot,
                expiresAt: expiresAt.toISOString()
              })
            )
            .digest("hex");
          await tx.orderScopeTransitionPreview.deleteMany({
            where: { orgId: input.orgId, expiresAt: { lt: new Date() }, jobId: null }
          });
          if (
            (await tx.orderScopeTransitionPreview.count({
              where: { orgId: input.orgId, expiresAt: { gt: new Date() }, jobId: null }
            })) >= 100
          )
            throw new StructuredPartitionRepositoryError(
              "ORDER_SCOPE_PREVIEW_LIMIT",
              "Too many active transition previews; use or wait for existing previews."
            );
          await tx.orderScopeTransitionPreview.create({
            data: {
              id,
              orgId: input.orgId,
              actorId: input.actorId,
              ...enterprise,
              startDate: selection.startDate,
              endDate: selection.endDate,
              storeNames,
              orderScope: input.orderScope,
              sourceChecksumSha256: input.sourceChecksumSha256,
              snapshot,
              confirmationDigest,
              expiresAt
            }
          });
          return {
            previewId: id,
            confirmationDigest,
            expiresAt: expiresAt.toISOString(),
            enterpriseName: enterprise.enterpriseName,
            startDate: input.startDate,
            endDate: input.endDate,
            storeNames,
            orderScope: input.orderScope,
            sourceChecksumSha256: input.sourceChecksumSha256,
            partitions: snapshot.map(
              ({ id: partitionId, storeName, businessDate, version, orderScope }) => ({
                partitionId,
                storeName,
                businessDate,
                version,
                orderScope
              })
            )
          };
        },
        {
          isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
          timeout: transactionTimeoutMs
        }
      );
    },
    async reserveUpload(input) {
      if (!validateOrderScopeDataset(input.dataset, input.orderScope))
        throw new StructuredPartitionRepositoryError("INVALID_ORDER_SCOPE");
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
        const created = await prisma.$transaction(async (tx) => {
          if (input.dataset === "in_store_orders") await lockOrderScopeControl(tx, input.orgId);
          await requireCurrentUploadAdmin(tx, input.orgId, input.uploaderId);
          await requireOrderScopeDeclaration(
            tx,
            input.orgId,
            input.enterpriseKey,
            input.dataset,
            input.orderScope
          );
          let transition: Awaited<ReturnType<typeof confirmedOrderScopePreview>> | undefined;
          if (input.orderScopeTransition)
            transition = await confirmedOrderScopePreview(tx, {
              ...input,
              actorId: input.uploaderId
            });
          const historicalSupplement = await bindHistoricalSupplementIntent(
            tx,
            input.orgId,
            input.uploaderId,
            input.historicalSupplementReason,
            [input.sourceStartDate, input.sourceEndDate]
          );
          const job = await tx.partitionImportJob.create({
            data: {
              id: input.id ?? createId("pjob"),
              orgId: input.orgId,
              uploaderId: input.uploaderId,
              dataset: input.dataset as PartitionDataset,
              orderScope: effectiveOrderScope(input.dataset, input.orderScope),
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
          if (transition) {
            const bound = await tx.orderScopeTransitionPreview.updateMany({
              where: { id: transition.id, orgId: input.orgId, jobId: null },
              data: { jobId: job.id }
            });
            if (bound.count !== 1)
              throw new StructuredPartitionRepositoryError("ORDER_SCOPE_CONFLICT");
            await tx.auditLog.create({
              data: {
                orgId: input.orgId,
                actorEmployeeId: input.uploaderId,
                action: "partition.order_scope.confirmed",
                targetType: "partition_import_job",
                targetId: job.id,
                result: "succeeded",
                metadata: {
                  previewId: transition.id,
                  confirmationDigest: transition.confirmationDigest,
                  orderScope: input.orderScope!,
                  sourceChecksumSha256: input.sourceChecksumSha256
                }
              }
            });
          }
          if (historicalSupplement)
            await tx.auditLog.create({
              data: {
                orgId: input.orgId,
                actorEmployeeId: input.uploaderId,
                action: "partition.historical_supplement.requested",
                targetType: "partition_import_job",
                targetId: job.id,
                result: "succeeded",
                clientSource: "admin",
                metadata: { historicalSupplement: { ...historicalSupplement } }
              }
            });
          return job;
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
            if (job.dataset === "in_store_orders") await lockOrderScopeControl(tx, input.orgId);
            if (job.dataset === "in_store_orders")
              await requireCurrentUploadAdmin(tx, input.orgId, job.uploaderId);
            await requireOrderScopeDeclaration(
              tx,
              input.orgId,
              job.enterpriseKey,
              job.dataset,
              job.orderScope
            );
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
      return prisma.$transaction(async (tx) => {
        if (input.lease)
          await requirePartitionImportLease(tx, input.orgId, input.jobId, input.lease);
        const changed = await tx.partitionImportJob.updateMany({
          where: {
            id: input.jobId,
            orgId: input.orgId,
            ...(input.uploaderId
              ? { uploaderId: input.uploaderId, uploader: { orgId: input.orgId, disabled: false } }
              : {}),
            status: input.lease
              ? PartitionImportJobStatus.processing
              : PartitionImportJobStatus.uploading
          },
          data: {
            status: input.status as PartitionImportJobStatus,
            errorCode: input.errorCode ?? null,
            errorSummary: input.errorSummary ?? null,
            validationErrors: (input.validationErrors ?? []) as Prisma.InputJsonValue,
            finishedAt: new Date()
          }
        });
        return changed.count === 1;
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
            const authorizationState = await lockAuthorizationPublication(tx, input.orgId);
            await requirePartitionImportLease(tx, input.orgId, input.jobId, input.lease);
            if (job.dataset === "in_store_orders")
              await requireCurrentUploadAdmin(tx, input.orgId, job.uploaderId);
            await requireOrderScopeDeclaration(
              tx,
              input.orgId,
              job.enterpriseKey,
              job.dataset,
              job.orderScope
            );
            const transition = await tx.orderScopeTransitionPreview.findUnique({
              where: { jobId: job.id }
            });
            if (transition) {
              if (
                transition.orgId !== input.orgId ||
                transition.actorId !== job.uploaderId ||
                transition.enterpriseKey !== job.enterpriseKey ||
                transition.orderScope !== job.orderScope ||
                transition.sourceChecksumSha256 !== job.sourceChecksumSha256
              )
                throw new StructuredPartitionRepositoryError("ORDER_SCOPE_CONFLICT");
              await verifyOrderScopeSnapshot(tx, transition, input.candidates);
            }
            if (
              job.dataset === "in_store_orders" &&
              input.candidates.some(
                (candidate) =>
                  candidate.dataset !== job.dataset ||
                  candidate.enterpriseKey !== job.enterpriseKey ||
                  effectiveOrderScope(candidate.dataset, candidate.orderScope) !==
                    effectiveOrderScope(job.dataset, job.orderScope)
              )
            )
              throw new StructuredPartitionRepositoryError(
                "ORDER_SCOPE_CONFLICT",
                "Candidate source scope differs from its accepted upload."
              );
            const historicalRequest = await tx.auditLog.findFirst({
              where: {
                orgId: input.orgId,
                targetType: "partition_import_job",
                targetId: job.id,
                action: "partition.historical_supplement.requested",
                result: "succeeded"
              },
              orderBy: { createdAt: "asc" }
            });
            const metadata = historicalRequest?.metadata;
            const historicalSupplement = readHistoricalSupplementIntent(
              metadata && typeof metadata === "object" && !Array.isArray(metadata)
                ? metadata["historicalSupplement"]
                : undefined
            );
            if (
              historicalSupplement &&
              (historicalSupplement.actorEmployeeId !== job.uploaderId ||
                historicalRequest?.actorEmployeeId !== job.uploaderId)
            )
              throw new ResourceAttributesError("RESOURCE_HISTORICAL_INTENT_INVALID");
            if (!input.candidates.length || input.totalRowCount <= 0n)
              throw new StructuredPartitionRepositoryError("PARTITION_INVALID_SOURCE");
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
              if (
                current &&
                candidate.dataset === "in_store_orders" &&
                effectiveOrderScope(candidate.dataset, current.orderScope) !==
                  effectiveOrderScope(candidate.dataset, candidate.orderScope) &&
                !transition
              )
                throw new StructuredPartitionRepositoryError(
                  "ORDER_SCOPE_CONFLICT",
                  "A different or historical unknown source scope requires a confirmed transition preview."
                );
              const decision = decidePartitionReplacement(current, candidate);
              for (const objectKey of decision.garbageObjectKeys) garbage.add(objectKey);

              if (decision.action === "insert") {
                await tx.structuredPartition.create({ data: partitionCreate(candidate, job.id) });
              } else if (decision.action === "update_metadata") {
                await tx.structuredPartition.update({
                  where: { id: current!.id },
                  data: { ...partitionMetadata(candidate, job.id), version: { increment: 1 } }
                });
              } else if (decision.action === "replace") {
                await tx.structuredPartition.update({
                  where: { id: current!.id },
                  data: {
                    ...partitionMetadata(candidate, job.id),
                    objectKey: candidate.objectKey,
                    version: { increment: 1 }
                  }
                });
              }
              {
                const persisted = await tx.structuredPartition.findUniqueOrThrow({
                  where: {
                    orgId_enterpriseKey_dataset_storeKey_businessDate: {
                      ...identity,
                      dataset: identity.dataset as PartitionDataset
                    }
                  }
                });
                await persistPartitionReadRequirement(
                  tx,
                  {
                    orgId: input.orgId,
                    partitionId: persisted.id,
                    dataset: persisted.dataset,
                    enterpriseKey: persisted.enterpriseKey,
                    storeName: persisted.storeName,
                    workerId: job.id,
                    businessDate: persisted.businessDate.toISOString().slice(0, 10),
                    historicalSupplement
                  },
                  authorizationState
                );
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
      if (
        isOrderPartitionDataset(input.dataset) ||
        input.storeNameContains !== undefined ||
        input.authorization?.mode === "enabled" ||
        input.authorization?.mode === "suspended"
      ) {
        return prisma.$queryRaw<PartitionManifestRow[]>(Prisma.sql`
          SELECT CASE WHEN dataset = 'in_store_orders' THEN COALESCE(order_scope, 'legacy_unknown') ELSE NULL END AS orderScope, business_date AS businessDate, merchant_id AS merchantId, store_name AS storeName,
            row_count AS rowCount, byte_size AS byteSize, checksum_sha256 AS checksumSha256, object_key AS objectKey
          FROM structured_partitions WHERE ${readablePartitionScope(input)}
            AND business_date >= ${parseBusinessDate(input.startDate)}
            AND business_date <= ${parseBusinessDate(input.endDate)}
            ${input.storeIds?.length ? Prisma.sql`AND merchant_id IN (${Prisma.join(input.storeIds)})` : Prisma.empty}
            ${input.storeNameContains ? Prisma.sql`AND ${literalStoreNameScope(input.storeNameContains)}` : Prisma.empty}
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
          orderScope: true,
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
      if (
        isOrderPartitionDataset(input.dataset) ||
        input.storeNameContains !== undefined ||
        input.authorization?.mode === "enabled" ||
        input.authorization?.mode === "suspended"
      ) {
        const where = Prisma.sql`${readablePartitionScope(input)} ${input.storeNameContains ? Prisma.sql`AND ${literalStoreNameScope(input.storeNameContains)}` : Prisma.empty}`;
        const [enterprises, stores, scopes] = await Promise.all([
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
          ),
          input.dataset === "in_store_orders"
            ? prisma.$queryRaw<
                Array<{
                  enterpriseKey: string;
                  orderScope: OrderScope;
                  startDate: Date;
                  endDate: Date;
                  partitionCount: bigint;
                  totalRowCount: Prisma.Decimal;
                }>
              >(Prisma.sql`
            SELECT enterprise_key AS enterpriseKey, COALESCE(order_scope, 'legacy_unknown') AS orderScope,
              MIN(business_date) AS startDate, MAX(business_date) AS endDate,
              COUNT(*) AS partitionCount, SUM(row_count) AS totalRowCount
            FROM structured_partitions WHERE ${where}
            GROUP BY enterprise_key, COALESCE(order_scope, 'legacy_unknown') ORDER BY enterprise_key, orderScope
          `)
            : Promise.resolve([])
        ]);
        return {
          dataset: input.dataset,
          enterprises: enterprises.map((enterprise) => ({
            ...enterprise,
            ...(input.dataset === "in_store_orders"
              ? {
                  orderScopes: scopes
                    .filter((scope) => scope.enterpriseKey === enterprise.enterpriseKey)
                    .map(({ orderScope, startDate, endDate, partitionCount, totalRowCount }) => ({
                      orderScope,
                      startDate,
                      endDate,
                      partitionCount: Number(partitionCount),
                      totalRowCount: BigInt(totalRowCount.toString())
                    }))
                }
              : {}),
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

    async canDeleteGarbage(input) {
      return prisma.$transaction((tx) => canDeleteStorageGarbage(tx, input), {
        isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted
      });
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
      await prisma.orderScopeTransitionPreview.deleteMany({
        where: { jobId: { in: jobs.map((job) => job.id) } }
      });
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
  orderScope?: OrderScope | null;
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
    orderScope: effectiveOrderScope(job.dataset, job.orderScope),
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
    orderScope: effectiveOrderScope(candidate.dataset, candidate.orderScope),
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
  authorization?: AuthorizationSnapshot;
  dataset: PartitionDatasetName;
  enterpriseKey?: string;
}): Prisma.Sql {
  // New categories have no legacy entitlement, even when an older tenant is still preparing.
  const authorization = input.authorization;
  const permission =
    authorization &&
    (isOrderPartitionDataset(input.dataset) ||
      authorization.mode === "enabled" ||
      authorization.mode === "suspended")
      ? compileStructuredReadScope(authorization, "partition", input.dataset)
      : null;
  const scope = permission
    ? Prisma.sql(permission.sql.split("?"), ...permission.params)
    : isOrderPartitionDataset(input.dataset)
      ? Prisma.sql`0 = 1`
      : Prisma.sql`confidentiality_level <= ${input.clearance}`;
  return Prisma.sql`org_id = ${input.orgId} AND ${scope} AND dataset = ${input.dataset}
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

async function lockOrderScopeControl(tx: Prisma.TransactionClient, orgId: string) {
  await tx.$queryRaw`SELECT org_id FROM business_authorization_states WHERE org_id = ${orgId} FOR UPDATE`;
}
async function requireOrderScopeDeclaration(
  tx: Prisma.TransactionClient,
  orgId: string,
  enterpriseKey: string,
  dataset: string,
  scope?: OrderScope | null
) {
  if (dataset !== "in_store_orders") return;
  const integration = await tx.$queryRaw<
    Array<{ required: boolean }>
  >`SELECT order_scope_required AS required FROM enterprise_integrations WHERE org_id = ${orgId} AND enterprise_key = ${enterpriseKey} FOR SHARE`;
  if (integration[0]?.required && (!scope || scope === "legacy_unknown"))
    throw new StructuredPartitionRepositoryError(
      "ORDER_SCOPE_REQUIRED",
      "This enterprise requires an explicit in-store order source scope."
    );
}
async function requireOrderScopeStores(
  tx: Prisma.TransactionClient,
  orgId: string,
  enterpriseKey: string,
  storeNames: string[]
) {
  const enterprise = await tx.businessEnterpriseIdentity.findUnique({
    where: { orgId_enterpriseKey: { orgId, enterpriseKey } }
  });
  const stores = await tx.businessStore.findMany({
    where: { orgId, enterpriseKey, name: { in: storeNames }, retired: false },
    select: { name: true }
  });
  if (!enterprise || storeNames.some((name) => !stores.some((store) => store.name === name)))
    throw new StructuredPartitionRepositoryError(
      "ORDER_SCOPE_CONFLICT",
      "Transition stores must match the registered enterprise and exact active store names."
    );
}
async function orderScopeSnapshot(
  tx: Prisma.TransactionClient,
  selection: {
    orgId: string;
    enterpriseKey: string;
    startDate: Date;
    endDate: Date;
    storeNames: string[];
  }
) {
  const rows = await tx.structuredPartition.findMany({
    where: {
      orgId: selection.orgId,
      enterpriseKey: selection.enterpriseKey,
      dataset: "in_store_orders",
      storeName: { in: selection.storeNames },
      businessDate: { gte: selection.startDate, lte: selection.endDate }
    },
    orderBy: [{ businessDate: "asc" }, { storeKey: "asc" }],
    take: 2001,
    select: {
      id: true,
      storeKey: true,
      storeName: true,
      businessDate: true,
      version: true,
      orderScope: true,
      checksumSha256: true
    }
  });
  if (rows.length > 2000)
    throw new StructuredPartitionRepositoryError(
      "ORDER_SCOPE_PREVIEW_LIMIT",
      "Narrow the transition range to at most 2000 partitions."
    );
  return rows
    .filter((row) => selection.storeNames.includes(row.storeName))
    .map((row) => ({
      ...row,
      businessDate: row.businessDate.toISOString().slice(0, 10),
      orderScope: effectiveOrderScope("in_store_orders", row.orderScope)!
    }));
}
type StoredOrderScopePreview = Prisma.OrderScopeTransitionPreviewGetPayload<Record<string, never>>;
async function verifyOrderScopeSnapshot(
  tx: Prisma.TransactionClient,
  preview: StoredOrderScopePreview,
  candidates?: PartitionCandidate[]
) {
  const storeNames = preview.storeNames as string[];
  const current = await orderScopeSnapshot(tx, { ...preview, storeNames });
  if (!isDeepStrictEqual(current, preview.snapshot))
    throw new StructuredPartitionRepositoryError(
      "ORDER_SCOPE_CONFLICT",
      "Current partition versions changed; prepare and confirm a new transition."
    );
  if (candidates) {
    const startDate = preview.startDate.toISOString().slice(0, 10);
    const endDate = preview.endDate.toISOString().slice(0, 10);
    if (
      candidates.some(
        (candidate) =>
          candidate.orgId !== preview.orgId ||
          candidate.enterpriseKey !== preview.enterpriseKey ||
          candidate.dataset !== "in_store_orders" ||
          candidate.orderScope !== preview.orderScope ||
          !storeNames.includes(candidate.storeName) ||
          candidate.businessDate < startDate ||
          candidate.businessDate > endDate
      ) ||
      current.some(
        (row) =>
          !candidates.some(
            (candidate) =>
              candidate.storeKey === row.storeKey && candidate.businessDate === row.businessDate
          )
      )
    )
      throw new StructuredPartitionRepositoryError(
        "ORDER_SCOPE_CONFLICT",
        "The complete source must include every previewed partition and stay inside the confirmed scope."
      );
  }
}
async function confirmedOrderScopePreview(
  tx: Prisma.TransactionClient,
  input: {
    orgId: string;
    actorId: string;
    dataset: string;
    enterpriseKey: string;
    orderScope?: DeclaredOrderScope;
    sourceChecksumSha256: string;
    sourceStartDate: string;
    sourceEndDate: string;
    orderScopeTransition?: OrderScopeTransitionConfirmation;
  }
) {
  const confirmation = input.orderScopeTransition!;
  const preview = await tx.orderScopeTransitionPreview.findFirst({
    where: { id: confirmation.previewId, orgId: input.orgId, actorId: input.actorId }
  });
  if (
    !preview ||
    preview.jobId ||
    preview.expiresAt <= new Date() ||
    input.dataset !== "in_store_orders" ||
    preview.enterpriseKey !== input.enterpriseKey ||
    preview.orderScope !== input.orderScope ||
    preview.sourceChecksumSha256 !== input.sourceChecksumSha256 ||
    preview.startDate.toISOString().slice(0, 10) !== input.sourceStartDate ||
    preview.endDate.toISOString().slice(0, 10) !== input.sourceEndDate ||
    preview.confirmationDigest !== confirmation.confirmationDigest
  )
    throw new StructuredPartitionRepositoryError(
      "ORDER_SCOPE_CONFLICT",
      "Transition confirmation does not match this source and current administrator."
    );
  await requireOrderScopeStores(
    tx,
    input.orgId,
    input.enterpriseKey,
    preview.storeNames as string[]
  );
  await verifyOrderScopeSnapshot(tx, preview);
  return preview;
}

async function requirePartitionImportLease(
  tx: Prisma.TransactionClient,
  orgId: string,
  jobId: string,
  lease: PartitionImportLease
) {
  await tx.$queryRaw`SELECT id FROM processing_runs WHERE id = ${lease.runId} FOR UPDATE`;
  const now = new Date();
  const claimed = await tx.processingRun.updateMany({
    where: {
      id: lease.runId,
      orgId,
      partitionImportJobId: jobId,
      jobType: "structured_partition_import",
      status: "running",
      lockedBy: lease.workerId,
      attemptNumber: lease.attemptNumber,
      lockedUntil: { gt: now }
    },
    data: { lastHeartbeatAt: now }
  });
  if (claimed.count !== 1)
    throw new StructuredPartitionRepositoryError(
      "PROCESSING_LEASE_LOST",
      "Partition import is no longer leased by this worker attempt."
    );
}
