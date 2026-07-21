import { setTimeout as delay } from "node:timers/promises";
import { PrismaMariaDb } from "@prisma/adapter-mariadb";
import { DocumentStatus, Prisma, PrismaClient, ProcessingRunStatus } from "@prisma/client";
import {
  AUDIT_ACTIONS,
  EvidenceParseError,
  PHASE3_RUNTIME_LIMIT_DEFAULTS
} from "@enterprise-hub/domain";
import type { StorageAdapter } from "@enterprise-hub/storage";

export const PROCESSING_ERROR_CODES = {
  unsupportedFileType: "UNSUPPORTED_FILE_TYPE",
  storageReadFailed: "STORAGE_READ_FAILED",
  evidenceIndexingFailed: "EVIDENCE_INDEXING_FAILED",
  unsupportedProcessingJobType: "UNSUPPORTED_PROCESSING_JOB_TYPE",
  leaseLost: "PROCESSING_LEASE_LOST"
} as const;

export interface ClaimedProcessingRun {
  id: string;
  orgId: string;
  documentId: string;
  retryCount: number;
  attemptNumber: number;
  jobType: string;
  lockedBy: string | null;
  lockedUntil: Date | null;
  document: {
    id: string;
    orgId: string;
    uploaderId: string;
    status: string;
    storageObjectKey: string;
    originalFileName: string | null;
    documentKind?: string | null;
    fileType?: string | null;
    contentVersion?: number;
  };
}

export interface DocumentChunkWrite {
  documentId: string;
  chunkIndex: number;
  chunkText: string;
  chunkHash: string;
  indexType: string;
}

export interface EvidenceDocumentChunkWrite extends DocumentChunkWrite {
  chunkId: string;
  qdrantPointId: string;
  contentVersion: number;
  retrievalConfigVersion: string;
  modelName: string;
  modelVersion: string;
  sourceLocation: Record<string, unknown>;
}

export interface EvidenceIndexingResult {
  retrievalConfigVersion: string;
  qdrantCollection: string;
  embeddingProvider: string;
  embeddingModel: string;
  embeddingVersion: string;
  embeddingDimension: number;
  lexicalIndexVersion: string;
  rerankProvider: string | null;
  rerankModel: string | null;
  rerankVersion: string | null;
  chunks: EvidenceDocumentChunkWrite[];
}

export interface EvidenceIndexer {
  indexDocument(input: {
    run: ClaimedProcessingRun;
    content: Buffer;
  }): Promise<EvidenceIndexingResult>;
}

export interface ClaimProcessingRunInput {
  workerId: string;
  now: Date;
  leaseSeconds: number;
}

export interface HeartbeatProcessingRunInput extends ClaimProcessingRunInput {
  runId: string;
}

export interface CompleteEvidenceIndexingInput {
  runId: string;
  documentId: string;
  workerId: string;
  now: Date;
  result: EvidenceIndexingResult;
  chunks: EvidenceDocumentChunkWrite[];
}

export interface FailProcessingRunInput {
  runId: string;
  documentId: string;
  workerId: string;
  now: Date;
  errorCode: string;
  errorSummary: string;
  willRetry: boolean;
  nextAvailableAt: Date;
}

export interface ProcessingWorkerRepository {
  claimNextProcessingRun(input: ClaimProcessingRunInput): Promise<ClaimedProcessingRun | null>;
  heartbeatProcessingRun?(input: HeartbeatProcessingRunInput): Promise<boolean>;
  completeEvidenceIndexing?(input: CompleteEvidenceIndexingInput): Promise<void>;
  failProcessingRun(input: FailProcessingRunInput): Promise<void>;
  disconnect?(): Promise<void>;
}

export type RunWorkerOnceResult =
  | {
      processed: false;
    }
  | {
      processed: true;
      documentId: string;
      status: "active" | "processing_failed" | "retry_scheduled";
    };

export interface RunWorkerLoopInput {
  repository: ProcessingWorkerRepository;
  storage: StorageAdapter;
  evidenceIndexer?: EvidenceIndexer;
  workerId?: string;
  workerConcurrency?: number;
  leaseSeconds?: number;
  maxAttempts?: number;
  retryBaseMs?: number;
  retryMaxMs?: number;
  now?: () => Date;
  pollIntervalMs?: number;
  signal?: AbortSignal;
  onResult?: (result: RunWorkerOnceResult) => void;
  onError?: (error: unknown) => void;
}

export async function runWorkerOnce(input: {
  repository: ProcessingWorkerRepository;
  storage: StorageAdapter;
  evidenceIndexer?: EvidenceIndexer;
  workerId?: string;
  leaseSeconds?: number;
  maxAttempts?: number;
  retryBaseMs?: number;
  retryMaxMs?: number;
  now?: () => Date;
}): Promise<RunWorkerOnceResult> {
  const workerId = input.workerId ?? createWorkerId();
  const leaseSeconds = input.leaseSeconds ?? PHASE3_RUNTIME_LIMIT_DEFAULTS.workerLeaseSeconds;
  const maxAttempts = input.maxAttempts ?? PHASE3_RUNTIME_LIMIT_DEFAULTS.workerMaxAttempts;
  const retryBaseMs = input.retryBaseMs ?? PHASE3_RUNTIME_LIMIT_DEFAULTS.workerRetryBaseMs;
  const retryMaxMs = input.retryMaxMs ?? PHASE3_RUNTIME_LIMIT_DEFAULTS.workerRetryMaxMs;
  const now = input.now ?? (() => new Date());
  const run = await input.repository.claimNextProcessingRun({
    workerId,
    leaseSeconds,
    now: now()
  });

  if (!run) {
    return { processed: false };
  }

  const heartbeat = startHeartbeat({
    repository: input.repository,
    runId: run.id,
    workerId,
    leaseSeconds,
    now
  });

  try {
    if (run.jobType !== "evidence_document_index") {
      throw new ProcessingError(
        PROCESSING_ERROR_CODES.unsupportedProcessingJobType,
        `Unsupported processing job type: ${run.jobType}`,
        false
      );
    }

    if (!input.evidenceIndexer || !input.repository.completeEvidenceIndexing) {
      throw new ProcessingError(
        PROCESSING_ERROR_CODES.unsupportedFileType,
        "Evidence indexing is not configured.",
        false
      );
    }

    const content = await readDocumentContent(run.document, input.storage);
    const result = await input.evidenceIndexer.indexDocument({ run, content });
    await input.repository.completeEvidenceIndexing({
      runId: run.id,
      documentId: run.documentId,
      workerId,
      now: now(),
      result,
      chunks: result.chunks
    });

    return {
      processed: true,
      documentId: run.documentId,
      status: "active"
    };
  } catch (error) {
    const processingError = toProcessingError(error);
    if (processingError.code === PROCESSING_ERROR_CODES.leaseLost) {
      return {
        processed: true,
        documentId: run.documentId,
        status: "retry_scheduled"
      };
    }

    const failedAt = now();
    const willRetry = processingError.retryable && run.attemptNumber < maxAttempts;
    await input.repository.failProcessingRun({
      runId: run.id,
      documentId: run.documentId,
      workerId,
      now: failedAt,
      errorCode: processingError.code,
      errorSummary: processingError.summary,
      willRetry,
      nextAvailableAt: willRetry
        ? new Date(failedAt.getTime() + retryDelayMs(run.attemptNumber, retryBaseMs, retryMaxMs))
        : failedAt
    });

    return {
      processed: true,
      documentId: run.documentId,
      status: willRetry ? "retry_scheduled" : "processing_failed"
    };
  } finally {
    heartbeat.stop();
  }
}

export async function runWorkerLoop(input: RunWorkerLoopInput): Promise<void> {
  const pollIntervalMs = input.pollIntervalMs ?? PHASE3_RUNTIME_LIMIT_DEFAULTS.workerPollIntervalMs;
  const workerConcurrency =
    input.workerConcurrency ?? PHASE3_RUNTIME_LIMIT_DEFAULTS.workerConcurrency;
  const workerIds = Array.from(
    { length: workerConcurrency },
    (_, index) => input.workerId ?? createWorkerId(index + 1)
  );

  while (!input.signal?.aborted) {
    try {
      const results = await Promise.all(
        workerIds.map((workerId) =>
          runWorkerOnce({
            repository: input.repository,
            storage: input.storage,
            evidenceIndexer: input.evidenceIndexer,
            workerId,
            leaseSeconds: input.leaseSeconds,
            maxAttempts: input.maxAttempts,
            retryBaseMs: input.retryBaseMs,
            retryMaxMs: input.retryMaxMs,
            now: input.now
          })
        )
      );

      for (const result of results) {
        input.onResult?.(result);
      }

      if (results.every((result) => !result.processed)) {
        await waitForNextPoll(pollIntervalMs, input.signal);
      }
    } catch (error) {
      input.onError?.(error);
      await waitForNextPoll(pollIntervalMs, input.signal);
    }
  }
}

export function createPrismaProcessingWorkerRepository(
  databaseUrl = requireDatabaseUrl()
): ProcessingWorkerRepository {
  const adapter = new PrismaMariaDb(databaseUrl);
  const prisma = new PrismaClient({ adapter });

  return {
    async claimNextProcessingRun(input) {
      const lockedUntil = addSeconds(input.now, input.leaseSeconds);

      return prisma.$transaction(async (tx) => {
        const run = await tx.processingRun.findFirst({
          where: {
            OR: [
              {
                status: ProcessingRunStatus.queued,
                availableAt: { lte: input.now }
              },
              {
                status: ProcessingRunStatus.retry_scheduled,
                availableAt: { lte: input.now }
              },
              {
                status: ProcessingRunStatus.running,
                lockedUntil: { lt: input.now }
              }
            ],
            document: {
              status: {
                in: [DocumentStatus.pending_processing, DocumentStatus.processing]
              }
            }
          },
          orderBy: [{ availableAt: "asc" }, { createdAt: "asc" }, { id: "asc" }],
          include: {
            document: true
          }
        });

        if (!run) {
          return null;
        }

        const claimed = await tx.processingRun.updateMany({
          where: {
            id: run.id,
            OR: [
              {
                status: run.status,
                availableAt: { lte: input.now }
              },
              {
                status: ProcessingRunStatus.running,
                lockedUntil: { lt: input.now }
              }
            ]
          },
          data: {
            status: ProcessingRunStatus.running,
            attemptNumber: {
              increment: 1
            },
            lockedBy: input.workerId,
            lockedUntil,
            lastHeartbeatAt: input.now,
            startedAt: input.now,
            finishedAt: null,
            errorCode: null,
            errorSummary: null
          }
        });

        if (claimed.count !== 1) {
          return null;
        }

        const document = await tx.document.update({
          where: {
            id: run.documentId
          },
          data: {
            status: DocumentStatus.processing
          }
        });

        await tx.auditLog.create({
          data: {
            orgId: run.orgId,
            actorEmployeeId: null,
            action: AUDIT_ACTIONS.documentProcessingStarted,
            targetType: "document",
            targetId: run.documentId,
            result: "succeeded",
            metadata: {
              processingRunId: run.id,
              workerId: input.workerId,
              lockedUntil: lockedUntil.toISOString()
            }
          }
        });

        const claimedRun = await tx.processingRun.findUniqueOrThrow({
          where: { id: run.id },
          include: { document: true }
        });

        return toClaimedProcessingRun(claimedRun, document);
      });
    },
    async heartbeatProcessingRun(input) {
      const result = await prisma.processingRun.updateMany({
        where: activeLeaseWhere(input),
        data: {
          lockedUntil: addSeconds(input.now, input.leaseSeconds),
          lastHeartbeatAt: input.now
        }
      });
      return result.count === 1;
    },
    async completeEvidenceIndexing(input) {
      await prisma.$transaction(async (tx) => {
        const claimed = await tx.processingRun.updateMany({
          where: activeLeaseWhere(input),
          data: {
            status: ProcessingRunStatus.succeeded,
            lockedBy: null,
            lockedUntil: null,
            errorCode: null,
            errorSummary: null,
            finishedAt: input.now
          }
        });
        if (claimed.count !== 1) {
          throw new ProcessingLeaseLostError(input.runId);
        }
        const run = await tx.processingRun.findUniqueOrThrow({
          where: {
            id: input.runId
          }
        });

        const retrievalConfig = await tx.retrievalConfig.upsert({
          where: {
            version: input.result.retrievalConfigVersion
          },
          create: {
            version: input.result.retrievalConfigVersion,
            status: "active",
            chunkerName: "phase3.structure-aware",
            denseEmbeddingProvider: input.result.embeddingProvider,
            denseEmbeddingModel: input.result.embeddingModel,
            denseVectorDimension: input.result.embeddingDimension,
            sparseModel: input.result.lexicalIndexVersion,
            rerankProvider: input.result.rerankProvider,
            rerankModel: input.result.rerankModel,
            qdrantCollection: input.result.qdrantCollection,
            configJson: retrievalConfigJson(input.result)
          },
          update: {
            status: "active",
            denseEmbeddingProvider: input.result.embeddingProvider,
            denseEmbeddingModel: input.result.embeddingModel,
            denseVectorDimension: input.result.embeddingDimension,
            sparseModel: input.result.lexicalIndexVersion,
            rerankProvider: input.result.rerankProvider,
            rerankModel: input.result.rerankModel,
            qdrantCollection: input.result.qdrantCollection,
            configJson: retrievalConfigJson(input.result)
          }
        });

        const document = await tx.document.findUniqueOrThrow({
          where: {
            id: input.documentId
          }
        });

        const documentIndex = await tx.documentIndex.upsert({
          where: {
            documentId_retrievalConfigId_contentVersion: {
              documentId: input.documentId,
              retrievalConfigId: retrievalConfig.id,
              contentVersion: document.contentVersion
            }
          },
          create: {
            orgId: run.orgId,
            documentId: input.documentId,
            retrievalConfigId: retrievalConfig.id,
            contentVersion: document.contentVersion,
            status: "ready",
            qdrantCollection: input.result.qdrantCollection,
            indexedChunkCount: input.chunks.length,
            startedAt: run.startedAt,
            readyAt: input.now
          },
          update: {
            status: "ready",
            indexedChunkCount: input.chunks.length,
            errorCode: null,
            errorSummary: null,
            readyAt: input.now
          }
        });

        if (input.chunks.length > 0) {
          await tx.documentChunk.createMany({
            data: input.chunks.map((chunk) => ({
              documentId: chunk.documentId,
              documentIndexId: documentIndex.id,
              chunkId: chunk.chunkId,
              chunkIndex: chunk.chunkIndex,
              chunkText: chunk.chunkText,
              chunkHash: chunk.chunkHash,
              indexType: chunk.indexType,
              modelName: chunk.modelName,
              modelVersion: chunk.modelVersion,
              contentVersion: chunk.contentVersion,
              retrievalConfigVersion: chunk.retrievalConfigVersion,
              qdrantPointId: chunk.qdrantPointId,
              sourceLocation: chunk.sourceLocation as Prisma.InputJsonValue
            })),
            skipDuplicates: true
          });
        }

        await tx.document.update({
          where: {
            id: input.documentId
          },
          data: {
            status: DocumentStatus.active
          }
        });

        await tx.auditLog.create({
          data: {
            orgId: run.orgId,
            actorEmployeeId: null,
            action: AUDIT_ACTIONS.documentActivated,
            targetType: "document",
            targetId: input.documentId,
            result: "succeeded",
            metadata: {
              processingRunId: input.runId,
              workerId: input.workerId,
              chunkCount: input.chunks.length,
              retrievalConfigVersion: input.result.retrievalConfigVersion,
              qdrantCollection: input.result.qdrantCollection
            }
          }
        });
      });
    },
    async failProcessingRun(input) {
      await prisma.$transaction(async (tx) => {
        const claimed = await tx.processingRun.updateMany({
          where: activeLeaseWhere(input),
          data: {
            status: input.willRetry
              ? ProcessingRunStatus.retry_scheduled
              : ProcessingRunStatus.failed,
            retryCount: {
              increment: 1
            },
            lockedBy: null,
            lockedUntil: null,
            availableAt: input.nextAvailableAt,
            errorCode: input.errorCode,
            errorSummary: input.errorSummary,
            finishedAt: input.now
          }
        });
        if (claimed.count !== 1) {
          throw new ProcessingLeaseLostError(input.runId);
        }
        const run = await tx.processingRun.findUniqueOrThrow({
          where: {
            id: input.runId
          }
        });

        await tx.document.update({
          where: {
            id: input.documentId
          },
          data: {
            status: input.willRetry
              ? DocumentStatus.pending_processing
              : DocumentStatus.processing_failed
          }
        });

        if (!input.willRetry) {
          await tx.auditLog.create({
            data: {
              orgId: run.orgId,
              actorEmployeeId: null,
              action: AUDIT_ACTIONS.documentProcessingFailed,
              targetType: "document",
              targetId: input.documentId,
              result: "failed",
              metadata: {
                processingRunId: input.runId,
                workerId: input.workerId,
                errorCode: input.errorCode,
                errorSummary: input.errorSummary
              }
            }
          });
        }
      });
    },
    async disconnect() {
      await prisma.$disconnect();
    }
  };
}

async function readDocumentContent(
  document: ClaimedProcessingRun["document"],
  storage: StorageAdapter
): Promise<Buffer> {
  try {
    return streamToBuffer(await storage.getObjectStream(document.storageObjectKey));
  } catch (error) {
    throw new ProcessingError(
      PROCESSING_ERROR_CODES.storageReadFailed,
      error instanceof Error ? error.message : "Unable to read storage object.",
      true
    );
  }
}

async function streamToBuffer(stream: NodeJS.ReadableStream): Promise<Buffer> {
  const chunks: Buffer[] = [];

  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
  }

  return Buffer.concat(chunks);
}

class ProcessingError extends Error {
  readonly code: string;
  readonly summary: string;
  readonly retryable: boolean;

  constructor(code: string, summary: string, retryable: boolean) {
    super(summary);
    this.code = code;
    this.summary = summary;
    this.retryable = retryable;
  }
}

export class ProcessingLeaseLostError extends Error {
  constructor(runId: string) {
    super(`Processing run ${runId} is no longer leased by this worker.`);
    this.name = "ProcessingLeaseLostError";
  }
}

function toProcessingError(error: unknown): ProcessingError {
  if (error instanceof ProcessingError) {
    return error;
  }

  if (error instanceof ProcessingLeaseLostError) {
    return new ProcessingError(PROCESSING_ERROR_CODES.leaseLost, error.message, false);
  }

  if (error instanceof EvidenceParseError) {
    return new ProcessingError(error.code, error.message, false);
  }

  if (isDeterministicEvidenceError(error)) {
    const code =
      typeof error === "object" && error !== null && "code" in error
        ? String((error as { code: unknown }).code)
        : PROCESSING_ERROR_CODES.evidenceIndexingFailed;
    return new ProcessingError(
      code,
      error instanceof Error ? error.message : "Evidence indexing failed.",
      false
    );
  }

  return new ProcessingError(
    PROCESSING_ERROR_CODES.evidenceIndexingFailed,
    error instanceof Error ? error.message : "Processing failed.",
    true
  );
}

function toClaimedProcessingRun(
  run: Prisma.ProcessingRunGetPayload<{ include: { document: true } }>,
  document: Prisma.DocumentGetPayload<Record<string, never>>
): ClaimedProcessingRun {
  return {
    id: run.id,
    orgId: run.orgId,
    documentId: run.documentId,
    retryCount: run.retryCount,
    attemptNumber: run.attemptNumber,
    jobType: run.jobType,
    lockedBy: run.lockedBy,
    lockedUntil: run.lockedUntil,
    document: {
      id: document.id,
      orgId: document.orgId,
      uploaderId: document.uploaderId,
      status: document.status,
      storageObjectKey: document.storageObjectKey,
      originalFileName: document.originalFileName,
      documentKind: document.documentKind,
      fileType: document.fileType,
      contentVersion: document.contentVersion
    }
  };
}

function requireDatabaseUrl(): string {
  const databaseUrl = process.env["DATABASE_URL"];

  if (!databaseUrl) {
    throw new Error("DATABASE_URL is required to run the processing worker.");
  }

  return databaseUrl;
}

function retrievalConfigJson(result: EvidenceIndexingResult): Prisma.InputJsonObject {
  return {
    retrievalConfigVersion: result.retrievalConfigVersion,
    embeddingProvider: result.embeddingProvider,
    embeddingModel: result.embeddingModel,
    embeddingVersion: result.embeddingVersion,
    embeddingDimension: result.embeddingDimension,
    lexicalIndexVersion: result.lexicalIndexVersion,
    rerankProvider: result.rerankProvider,
    rerankModel: result.rerankModel,
    rerankVersion: result.rerankVersion
  };
}

async function waitForNextPoll(pollIntervalMs: number, signal: AbortSignal | undefined) {
  try {
    await delay(pollIntervalMs, undefined, { signal });
  } catch (error) {
    if (isAbortError(error)) {
      return;
    }

    throw error;
  }
}

function activeLeaseWhere(input: { runId: string; workerId: string; now: Date }) {
  return {
    id: input.runId,
    status: ProcessingRunStatus.running,
    lockedBy: input.workerId,
    lockedUntil: { gt: input.now }
  };
}

function addSeconds(value: Date, seconds: number) {
  return new Date(value.getTime() + seconds * 1_000);
}

function retryDelayMs(attemptNumber: number, retryBaseMs: number, retryMaxMs: number) {
  return Math.min(retryBaseMs * 2 ** Math.max(attemptNumber - 1, 0), retryMaxMs);
}

function createWorkerId(slot?: number) {
  const suffix = `${process.pid}-${Math.random().toString(16).slice(2, 10)}`;
  return slot === undefined ? `worker:${suffix}` : `worker:${slot}:${suffix}`;
}

function startHeartbeat(input: {
  repository: ProcessingWorkerRepository;
  runId: string;
  workerId: string;
  leaseSeconds: number;
  now: () => Date;
}) {
  if (!input.repository.heartbeatProcessingRun) {
    return { stop() {} };
  }

  const interval = setInterval(
    () => {
      void input.repository
        .heartbeatProcessingRun?.({
          runId: input.runId,
          workerId: input.workerId,
          leaseSeconds: input.leaseSeconds,
          now: input.now()
        })
        .catch(() => undefined);
    },
    Math.max(1, Math.floor((input.leaseSeconds * 1_000) / 3))
  );

  return {
    stop() {
      clearInterval(interval);
    }
  };
}

function isAbortError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "name" in error &&
    (error as { name?: unknown }).name === "AbortError"
  );
}

function isDeterministicEvidenceError(error: unknown) {
  return (
    typeof error === "object" &&
    error !== null &&
    "retryable" in error &&
    (error as { retryable?: unknown }).retryable === false
  );
}
