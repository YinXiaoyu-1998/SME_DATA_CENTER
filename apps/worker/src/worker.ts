import {
  createPrismaPdfEvidenceAttemptRepository,
  type PdfEvidenceAttemptRepository
} from "./evidence-artifacts.js";
import { setTimeout as delay } from "node:timers/promises";
import { createDatabaseAdapter } from "@smedc/db";
import {
  DocumentStatus,
  ImportBatchStatus,
  ImportDataset,
  Prisma,
  PrismaClient,
  ProcessingRunStatus
} from "@prisma/client";
import { AUDIT_ACTIONS, EvidenceParseError, PHASE3_RUNTIME_LIMIT_DEFAULTS } from "@smedc/domain";
import type { StructuredDatasetName } from "@smedc/domain";
import type { StorageAdapter } from "@smedc/storage";
import {
  parseStructuredFile,
  type StructuredIngestionLimits,
  type StructuredParseResult
} from "@smedc/structured-ingestion";

export const PROCESSING_ERROR_CODES = {
  unsupportedFileType: "UNSUPPORTED_FILE_TYPE",
  storageReadFailed: "STORAGE_READ_FAILED",
  evidenceIndexingFailed: "EVIDENCE_INDEXING_FAILED",
  structuredImportFailed: "STRUCTURED_IMPORT_FAILED",
  partitionImportFailed: "PARTITION_IMPORT_FAILED",
  structuredImportRejected: "STRUCTURED_IMPORT_REJECTED",
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
  isEvidenceReindex?: boolean;
  structuredImport?: {
    importBatchId: string;
    dataset: StructuredDatasetName;
    startDate?: string;
    endDate?: string;
  };
  partitionImport?: {
    jobId: string;
    dataset: "business" | "dishes";
    enterpriseKey: string;
    enterpriseName: string;
    confidentialityLevel: number;
    originalFileName: string;
    sourceByteSize: bigint;
    sourceChecksumSha256: string;
    sourceStartDate: string;
    sourceEndDate: string;
    temporaryObjectKey: string;
  };
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
    checksumSha256?: string | null;
    confidentialityLevel: number;
  } | null;
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
  parserFingerprint?: string;
  parsedObjectKey?: string;
  parseSummary?: Record<string, unknown>;
  pdfAttemptId?: string;
}

export interface EvidenceIndexer {
  indexDocument(input: {
    run: ClaimedProcessingRun;
    content: Buffer;
    signal?: AbortSignal;
  }): Promise<EvidenceIndexingResult>;
  releaseCandidate?(result: EvidenceIndexingResult): void;
  resolveCandidate?(result: EvidenceIndexingResult): Promise<"owned" | "cleaned">;
  recoverArtifacts?(): Promise<void>;
}

export interface ClaimProcessingRunInput {
  workerId: string;
  now: Date;
  leaseSeconds: number;
  jobScope?: "general" | "pdf";
}

export interface HeartbeatProcessingRunInput extends ClaimProcessingRunInput {
  runId: string;
  attemptNumber?: number;
}

export interface CompleteEvidenceIndexingInput {
  attemptNumber?: number;
  runId: string;
  documentId: string;
  workerId: string;
  now: Date;
  result: EvidenceIndexingResult;
  chunks: EvidenceDocumentChunkWrite[];
}

export interface FailProcessingRunInput {
  attemptNumber?: number;
  runId: string;
  documentId: string;
  workerId: string;
  now: Date;
  errorCode: string;
  errorSummary: string;
  willRetry: boolean;
  nextAvailableAt: Date;
}

export interface BeginStructuredImportApplyInput {
  runId: string;
  documentId: string;
  importBatchId: string;
  dataset: StructuredDatasetName;
  workerId: string;
  now: Date;
}

export interface CompleteStructuredImportInput extends BeginStructuredImportApplyInput {
  result: StructuredParseResult;
  batchInsertSize: number;
}

export interface RejectStructuredImportInput extends BeginStructuredImportApplyInput {
  result: StructuredParseResult;
}

export interface ProcessingWorkerRepository {
  pdfArtifacts?: PdfEvidenceAttemptRepository;
  claimNextProcessingRun(input: ClaimProcessingRunInput): Promise<ClaimedProcessingRun | null>;
  heartbeatProcessingRun?(input: HeartbeatProcessingRunInput): Promise<boolean>;
  completeEvidenceIndexing?(input: CompleteEvidenceIndexingInput): Promise<void>;
  beginStructuredImportApply?(input: BeginStructuredImportApplyInput): Promise<void>;
  completeStructuredImport?(input: CompleteStructuredImportInput): Promise<void>;
  rejectStructuredImport?(input: RejectStructuredImportInput): Promise<void>;
  completePartitionProcessing?(input: {
    runId: string;
    workerId: string;
    now: Date;
  }): Promise<void>;
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
      status: "active" | "processing_failed" | "retry_scheduled" | "rejected";
    };

export interface RunWorkerLoopInput {
  repository: ProcessingWorkerRepository;
  storage: StorageAdapter;
  evidenceIndexer?: EvidenceIndexer;
  partitionImporter?: {
    process(input: {
      run: ClaimedProcessingRun;
      storage: StorageAdapter;
    }): Promise<"published" | "rejected">;
    cleanupTerminal?(input: { run: ClaimedProcessingRun; storage: StorageAdapter }): Promise<void>;
  };
  structuredIngestionLimits?: StructuredIngestionLimits;
  structuredImportBatchInsertSize?: number;
  workerId?: string;
  workerConcurrency?: number;
  jobScope?: "general" | "pdf";
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
  partitionImporter?: RunWorkerLoopInput["partitionImporter"];
  structuredIngestionLimits?: StructuredIngestionLimits;
  structuredImportBatchInsertSize?: number;
  workerId?: string;
  jobScope?: "general" | "pdf";
  signal?: AbortSignal;
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
  input.signal?.throwIfAborted();
  const run = await input.repository.claimNextProcessingRun({
    workerId,
    leaseSeconds,
    jobScope: input.jobScope ?? "general",
    now: now()
  });

  if (!run) {
    return { processed: false };
  }

  const attemptController = new AbortController();
  const signal = input.signal
    ? AbortSignal.any([input.signal, attemptController.signal])
    : attemptController.signal;
  const assertCurrent = () => {
    if (signal.aborted) throw new ProcessingLeaseLostError(run.id);
  };
  const heartbeat = startHeartbeat({
    repository: input.repository,
    runId: run.id,
    attemptNumber: run.attemptNumber,
    workerId,
    leaseSeconds,
    now,
    lockedUntil: run.lockedUntil,
    abort: () => attemptController.abort(new ProcessingLeaseLostError(run.id))
  });

  try {
    if (run.jobType === "evidence_document_index") {
      if (!input.evidenceIndexer || !input.repository.completeEvidenceIndexing) {
        throw new ProcessingError(
          PROCESSING_ERROR_CODES.unsupportedFileType,
          "Evidence indexing is not configured.",
          false
        );
      }

      if (!run.document)
        throw new ProcessingError(
          PROCESSING_ERROR_CODES.unsupportedFileType,
          "Processing document is missing.",
          false
        );
      const content = await readDocumentContent(run.document, input.storage);
      assertCurrent();
      const result = await input.evidenceIndexer.indexDocument({ run, content, signal });
      try {
        assertCurrent();
        await input.repository.completeEvidenceIndexing({
          runId: run.id,
          attemptNumber: run.attemptNumber,
          documentId: run.documentId,
          workerId,
          now: now(),
          result,
          chunks: result.chunks
        });
      } catch (error) {
        // A thrown COMMIT may have succeeded; the attempt row serializes reconciliation.
        if (
          !result.pdfAttemptId ||
          !input.evidenceIndexer.resolveCandidate ||
          (await input.evidenceIndexer.resolveCandidate(result)) !== "owned"
        )
          throw error;
      }

      input.evidenceIndexer.releaseCandidate?.(result);
      return {
        processed: true,
        documentId: run.documentId,
        status: "active"
      };
    }

    if (run.jobType === "structured_import") {
      if (
        !run.structuredImport ||
        !run.document ||
        !input.repository.beginStructuredImportApply ||
        !input.repository.completeStructuredImport ||
        !input.repository.rejectStructuredImport
      ) {
        throw new ProcessingError(
          PROCESSING_ERROR_CODES.unsupportedFileType,
          "Structured import processing is not configured.",
          false
        );
      }
      const structuredImport = run.structuredImport;

      const transition = () => ({
        runId: run.id,
        documentId: run.documentId,
        importBatchId: structuredImport.importBatchId,
        dataset: structuredImport.dataset,
        workerId,
        now: now()
      });
      const fileType = structuredFileType(run.document.fileType);
      if (!fileType) {
        await input.repository.rejectStructuredImport({
          ...transition(),
          result: unsupportedStructuredFileResult()
        });
        return {
          processed: true,
          documentId: run.documentId,
          status: "rejected"
        };
      }

      const content = await readDocumentContent(run.document, input.storage);
      const result = await parseStructuredFile({
        dataset: structuredImport.dataset,
        content,
        fileType,
        startDate: structuredImport.startDate,
        endDate: structuredImport.endDate,
        fileName: run.document.originalFileName ?? "structured-import",
        limits: input.structuredIngestionLimits ?? structuredIngestionLimits(),
        validationMode: "collect"
      });

      if (result.validationErrorCount > 0) {
        await input.repository.rejectStructuredImport({ ...transition(), result });
        return {
          processed: true,
          documentId: run.documentId,
          status: "rejected"
        };
      }

      await input.repository.beginStructuredImportApply(transition());
      await input.repository.completeStructuredImport({
        ...transition(),
        result,
        batchInsertSize:
          input.structuredImportBatchInsertSize ??
          PHASE3_RUNTIME_LIMIT_DEFAULTS.structuredImportBatchInsertSize
      });
      return {
        processed: true,
        documentId: run.documentId,
        status: "active"
      };
    }

    if (run.jobType === "structured_partition_import") {
      if (
        !run.partitionImport ||
        !input.partitionImporter ||
        !input.repository.completePartitionProcessing
      ) {
        throw new ProcessingError(
          PROCESSING_ERROR_CODES.unsupportedFileType,
          "Partition import processing is not configured.",
          false
        );
      }
      const outcome = await input.partitionImporter.process({ run, storage: input.storage });
      await input.repository.completePartitionProcessing({ runId: run.id, workerId, now: now() });
      return {
        processed: true,
        documentId: run.partitionImport.jobId,
        status: outcome === "published" ? "active" : "rejected"
      };
    }

    {
      throw new ProcessingError(
        PROCESSING_ERROR_CODES.unsupportedProcessingJobType,
        `Unsupported processing job type: ${run.jobType}`,
        false
      );
    }
  } catch (error) {
    const processingError = toProcessingError(
      signal.aborted &&
        !(
          error instanceof Error &&
          "code" in error &&
          error.code === "PDF_ARTIFACT_RECOVERY_REQUIRED"
        )
        ? new ProcessingLeaseLostError(run.id)
        : error,
      run.jobType
    );
    if (processingError.code === PROCESSING_ERROR_CODES.leaseLost) {
      return {
        processed: true,
        documentId: run.documentId,
        status: "retry_scheduled"
      };
    }

    const failedAt = now();
    const willRetry = processingError.retryable && run.attemptNumber < maxAttempts;
    try {
      await input.repository.failProcessingRun({
        runId: run.id,
        attemptNumber: run.attemptNumber,
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
      if (!willRetry && run.jobType === "structured_partition_import") {
        await input.partitionImporter
          ?.cleanupTerminal?.({ run, storage: input.storage })
          .catch(() => undefined);
      }
    } catch (failureError) {
      if (toProcessingError(failureError, run.jobType).code === PROCESSING_ERROR_CODES.leaseLost) {
        if (processingError.code === "PDF_ARTIFACT_RECOVERY_REQUIRED") throw error;
        return {
          processed: true,
          documentId: run.documentId,
          status: "retry_scheduled"
        };
      }
      throw failureError;
    }

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
    input.workerConcurrency ??
    (input.jobScope === "pdf" ? 1 : PHASE3_RUNTIME_LIMIT_DEFAULTS.workerConcurrency);
  if (input.jobScope === "pdf" && workerConcurrency !== 1)
    throw new Error("PDF worker concurrency must be 1.");
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
            partitionImporter: input.partitionImporter,
            structuredIngestionLimits: input.structuredIngestionLimits,
            structuredImportBatchInsertSize: input.structuredImportBatchInsertSize,
            workerId,
            jobScope: input.jobScope,
            signal: input.signal,
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

export interface PrismaProcessingWorkerRepositoryOptions {
  structuredImportTransactionTimeoutMs?: number;
  evidenceRetrievalConfigVersion?: string;
}

export function createPrismaProcessingWorkerRepository(
  databaseUrl = requireDatabaseUrl(),
  options: PrismaProcessingWorkerRepositoryOptions = {}
): ProcessingWorkerRepository {
  const adapter = createDatabaseAdapter(databaseUrl);
  const prisma = new PrismaClient({ adapter });
  const structuredImportTransactionTimeoutMs =
    options.structuredImportTransactionTimeoutMs ??
    PHASE3_RUNTIME_LIMIT_DEFAULTS.structuredImportTransactionTimeoutMs;
  const evidenceRetrievalConfigVersion = options.evidenceRetrievalConfigVersion;

  return {
    pdfArtifacts: createPrismaPdfEvidenceAttemptRepository(prisma),
    async claimNextProcessingRun(input) {
      const lockedUntil = addSeconds(input.now, input.leaseSeconds);

      return prisma.$transaction(async (tx) => {
        const run = await tx.processingRun.findFirst({
          where: {
            AND: [
              input.jobScope === "pdf"
                ? { jobType: "evidence_document_index", document: { fileType: "pdf" } }
                : {
                    OR: [
                      { document: { fileType: { not: "pdf" } } },
                      { document: { fileType: null } },
                      { documentId: null }
                    ]
                  },
              {
                OR: [
                  {
                    jobType: "structured_partition_import",
                    partitionImportJob: { status: { in: ["queued", "processing"] } }
                  },
                  {
                    jobType: { not: "structured_partition_import" },
                    document: {
                      status: {
                        in: [DocumentStatus.pending_processing, DocumentStatus.processing]
                      }
                    }
                  },
                  {
                    jobType: "evidence_document_index",
                    document: {
                      fileType: "pdf",
                      status: DocumentStatus.active,
                      archivedAt: null,
                      documentKind: "evidence"
                    }
                  },
                  ...(evidenceRetrievalConfigVersion
                    ? [
                        {
                          jobType: "evidence_document_index" as const,
                          jobKey: { endsWith: `:${evidenceRetrievalConfigVersion}` },
                          document: {
                            status: DocumentStatus.active,
                            archivedAt: null,
                            documentKind: "evidence" as const
                          }
                        }
                      ]
                    : [])
                ]
              }
            ],
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
            ]
          },
          orderBy: [{ availableAt: "asc" }, { createdAt: "asc" }, { id: "asc" }],
          include: {
            document: true,
            partitionImportJob: true
          }
        });

        if (!run) {
          return null;
        }

        const claimed = await tx.processingRun.updateMany({
          where: {
            id: run.id,
            OR: [
              ...(run.status === ProcessingRunStatus.running
                ? []
                : [
                    {
                      status: run.status,
                      availableAt: { lte: input.now }
                    }
                  ]),
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

        const isEvidenceReindex =
          run.document?.status === DocumentStatus.active &&
          Boolean(
            run.document?.fileType === "pdf" ||
            (evidenceRetrievalConfigVersion &&
              isEvidenceReindexJobForConfig(run.jobKey, evidenceRetrievalConfigVersion))
          );
        const document = run.documentId
          ? isEvidenceReindex
            ? run.document
            : await tx.document.update({
                where: { id: run.documentId },
                data: { status: DocumentStatus.processing }
              })
          : null;

        if (run.jobType === "structured_partition_import") {
          if (!run.partitionImportJobId || !run.partitionImportJob?.temporaryObjectKey) {
            throw new Error(`Partition import job is not claimable for processing run ${run.id}.`);
          }
          await tx.partitionImportJob.update({
            where: { id: run.partitionImportJobId },
            data: { status: "processing", errorCode: null, errorSummary: null }
          });
        }

        let structuredImport: ClaimedProcessingRun["structuredImport"];
        if (run.jobType === "structured_import") {
          if (!run.documentId) {
            throw new Error(`Structured import document is missing for processing run ${run.id}.`);
          }
          const batch = await tx.importBatch.findFirst({
            where: {
              sourceDocumentId: run.documentId,
              orgId: run.orgId,
              status: {
                in: [
                  ImportBatchStatus.pending,
                  ImportBatchStatus.validating,
                  ImportBatchStatus.applying,
                  ImportBatchStatus.failed
                ]
              }
            }
          });
          if (!batch) {
            throw new Error(
              `Structured import batch is not claimable for processing run ${run.id}.`
            );
          }
          await tx.importBatch.update({
            where: { id: batch.id },
            data: {
              status: ImportBatchStatus.validating,
              errorCode: null,
              errorSummary: null
            }
          });
          structuredImport = {
            importBatchId: batch.id,
            dataset: batch.dataset,
            ...(batch.startDate ? { startDate: formatDateWindow(batch.startDate) } : {}),
            ...(batch.endDate ? { endDate: formatDateWindow(batch.endDate) } : {})
          };
          await tx.auditLog.create({
            data: {
              orgId: run.orgId,
              actorEmployeeId: null,
              action: "structured_import.validating",
              targetType: "import_batch",
              targetId: batch.id,
              result: "succeeded",
              metadata: {
                processingRunId: run.id,
                workerId: input.workerId,
                dataset: batch.dataset,
                sourceDocumentId: batch.sourceDocumentId
              }
            }
          });
        }

        if (run.documentId) {
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
        }

        const claimedRun = await tx.processingRun.findUniqueOrThrow({
          where: { id: run.id },
          include: { document: true, partitionImportJob: true }
        });

        return toClaimedProcessingRun(claimedRun, document, structuredImport, isEvidenceReindex);
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
    async completePartitionProcessing(input) {
      const result = await prisma.processingRun.updateMany({
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
      if (result.count !== 1) throw new ProcessingLeaseLostError(input.runId);
    },
    async completeEvidenceIndexing(input) {
      await prisma.$transaction(async (tx) => {
        if (input.result.pdfAttemptId) {
          const attempt = await tx.pdfEvidenceAttempt.updateMany({
            where: {
              id: input.result.pdfAttemptId,
              runId: input.runId,
              documentId: input.documentId,
              state: "staged",
              parsedObjectKey: input.result.parsedObjectKey,
              parserFingerprint: input.result.parserFingerprint
            },
            data: { state: "active", nextRecoveryAt: new Date(input.now.getTime() + 86_400_000) }
          });
          if (attempt.count !== 1) throw new ProcessingLeaseLostError(input.runId);
        }
        const claimed = await tx.processingRun.updateMany({
          where: activeLeaseWhere(input),
          data: input.result.pdfAttemptId
            ? { lastHeartbeatAt: input.now }
            : {
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

        if (run.documentId !== input.documentId) throw new ProcessingLeaseLostError(input.runId);
        if (input.result.pdfAttemptId) {
          const attempt = await tx.pdfEvidenceAttempt.findUniqueOrThrow({
            where: { id: input.result.pdfAttemptId }
          });
          if (
            attempt.orgId !== run.orgId ||
            attempt.attemptNumber !== run.attemptNumber ||
            attempt.retrievalConfigVersion !== input.result.retrievalConfigVersion ||
            attempt.collection !== input.result.qdrantCollection ||
            JSON.stringify(attempt.pointIds) !==
              JSON.stringify(input.chunks.map((chunk) => chunk.qdrantPointId))
          )
            throw new ProcessingLeaseLostError(input.runId);
        }
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

        if (
          input.result.pdfAttemptId &&
          input.chunks.some(
            (chunk) =>
              chunk.documentId !== input.documentId ||
              chunk.contentVersion !== document.contentVersion ||
              chunk.retrievalConfigVersion !== input.result.retrievalConfigVersion
          )
        )
          throw new ProcessingLeaseLostError(input.runId);
        const pdfFields = input.result.pdfAttemptId
          ? {
              parserFingerprint: input.result.parserFingerprint,
              parsedObjectKey: input.result.parsedObjectKey,
              parseSummary: input.result.parseSummary as Prisma.InputJsonValue
            }
          : {};
        const documentIndex = await tx.documentIndex.upsert({
          where: {
            documentId_retrievalConfigId_contentVersion: {
              documentId: input.documentId,
              retrievalConfigId: retrievalConfig.id,
              contentVersion: document.contentVersion
            }
          },
          create: {
            ...pdfFields,
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
            ...pdfFields,
            status: "ready",
            indexedChunkCount: input.chunks.length,
            errorCode: null,
            errorSummary: null,
            readyAt: input.now
          }
        });

        if (input.result.pdfAttemptId) {
          await tx.documentChunk.deleteMany({ where: { documentIndexId: documentIndex.id } });
          await tx.pdfEvidenceAttempt.updateMany({
            where: {
              documentId: input.documentId,
              orgId: run.orgId,
              contentVersion: document.contentVersion,
              retrievalConfigVersion: input.result.retrievalConfigVersion,
              state: "active",
              id: { not: input.result.pdfAttemptId }
            },
            data: { state: "cleanup", nextRecoveryAt: new Date(input.now.getTime() + 60_000) }
          });
        }
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
            skipDuplicates: !input.result.pdfAttemptId
          });
        }

        if (input.result.pdfAttemptId) {
          const published = await tx.document.updateMany({
            where: {
              id: input.documentId,
              orgId: run.orgId,
              contentVersion: document.contentVersion,
              archivedAt: null,
              status: { in: [DocumentStatus.processing, DocumentStatus.active] }
            },
            data: { status: DocumentStatus.active }
          });
          if (published.count !== 1) throw new ProcessingLeaseLostError(input.runId);
        } else {
          await tx.document.update({
            where: { id: input.documentId },
            data: { status: DocumentStatus.active }
          });
        }

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
        if (input.result.pdfAttemptId) {
          const finished = await tx.processingRun.updateMany({
            where: activeLeaseWhere({ ...input, now: new Date() }),
            data: {
              status: ProcessingRunStatus.succeeded,
              lockedBy: null,
              lockedUntil: null,
              errorCode: null,
              errorSummary: null,
              finishedAt: new Date()
            }
          });
          if (finished.count !== 1) throw new ProcessingLeaseLostError(input.runId);
        }
      });
    },
    async beginStructuredImportApply(input) {
      await prisma.$transaction(async (tx) => {
        const leased = await tx.processingRun.updateMany({
          where: activeLeaseWhere(input),
          data: { lastHeartbeatAt: input.now }
        });
        if (leased.count !== 1) throw new ProcessingLeaseLostError(input.runId);

        const batch = await tx.importBatch.updateMany({
          where: {
            id: input.importBatchId,
            sourceDocumentId: input.documentId,
            status: ImportBatchStatus.validating
          },
          data: { status: ImportBatchStatus.applying }
        });
        if (batch.count !== 1) {
          throw new Error(`Structured import batch ${input.importBatchId} cannot begin applying.`);
        }

        await tx.auditLog.create({
          data: {
            orgId: (await tx.processingRun.findUniqueOrThrow({ where: { id: input.runId } })).orgId,
            actorEmployeeId: null,
            action: "structured_import.applying",
            targetType: "import_batch",
            targetId: input.importBatchId,
            result: "succeeded",
            metadata: {
              processingRunId: input.runId,
              workerId: input.workerId,
              dataset: input.dataset,
              sourceDocumentId: input.documentId
            }
          }
        });
      });
    },
    async completeStructuredImport(input) {
      const publishStructuredImport = async (tx: Prisma.TransactionClient) => {
        const leased = await tx.processingRun.updateMany({
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
        if (leased.count !== 1) throw new ProcessingLeaseLostError(input.runId);

        const run = await tx.processingRun.findUniqueOrThrow({ where: { id: input.runId } });
        const batch = await tx.importBatch.findFirst({
          where: {
            id: input.importBatchId,
            sourceDocumentId: input.documentId,
            orgId: run.orgId,
            status: ImportBatchStatus.applying
          }
        });
        if (!batch)
          throw new Error(`Structured import batch ${input.importBatchId} cannot complete.`);

        if (batch.dataset === ImportDataset.vip) {
          await tx.vipRow.deleteMany({ where: { importBatchId: batch.id } });
          await insertStructuredRows(tx, "vip", batch, input.result.rows, input.batchInsertSize);
        } else if (batch.dataset === ImportDataset.dish_catalog) {
          await tx.dishCatalogRow.deleteMany({ where: { importBatchId: batch.id } });
          await insertStructuredRows(
            tx,
            "dish_catalog",
            batch,
            input.result.rows,
            input.batchInsertSize
          );
        } else if (batch.dataset === ImportDataset.delivery_ledger) {
          await tx.deliveryLedgerRow.deleteMany({ where: { importBatchId: batch.id } });
          await insertStructuredRows(
            tx,
            "delivery_ledger",
            batch,
            input.result.rows,
            input.batchInsertSize
          );
        } else if (batch.dataset === ImportDataset.supplier_catalog) {
          await tx.supplierCatalogRow.deleteMany({ where: { importBatchId: batch.id } });
          await insertStructuredRows(
            tx,
            "supplier_catalog",
            batch,
            input.result.rows,
            input.batchInsertSize
          );
        } else {
          throw new Error(`Unsupported structured dataset: ${String(batch.dataset)}`);
        }

        await tx.importBatch.update({
          where: { id: batch.id },
          data: {
            status: ImportBatchStatus.applied,
            appliedAt: input.now,
            sourceSheetSummary: persistedSourceSheetSummary(batch.dataset, input.result),
            validationErrors: [],
            validationErrorCount: 0,
            totalRowCount: input.result.rows.length,
            appliedRowCount: input.result.rows.length,
            errorCode: null,
            errorSummary: null
          }
        });
        await tx.document.update({
          where: { id: input.documentId },
          data: { status: DocumentStatus.active }
        });
        await tx.auditLog.create({
          data: {
            orgId: run.orgId,
            actorEmployeeId: null,
            action: AUDIT_ACTIONS.structuredImportApplied,
            targetType: "import_batch",
            targetId: batch.id,
            result: "succeeded",
            metadata: {
              processingRunId: input.runId,
              workerId: input.workerId,
              dataset: batch.dataset,
              sourceDocumentId: input.documentId,
              appliedRowCount: input.result.rows.length,
              sheetCount: input.result.sheetSummary.length
            }
          }
        });
      };
      await prisma.$transaction(publishStructuredImport, {
        timeout: structuredImportTransactionTimeoutMs
      });
    },
    async rejectStructuredImport(input) {
      await prisma.$transaction(async (tx) => {
        const leased = await tx.processingRun.updateMany({
          where: activeLeaseWhere(input),
          data: {
            status: ProcessingRunStatus.failed,
            lockedBy: null,
            lockedUntil: null,
            errorCode: PROCESSING_ERROR_CODES.structuredImportRejected,
            errorSummary: "Structured import validation failed.",
            finishedAt: input.now
          }
        });
        if (leased.count !== 1) throw new ProcessingLeaseLostError(input.runId);

        const run = await tx.processingRun.findUniqueOrThrow({ where: { id: input.runId } });
        const batch = await tx.importBatch.findFirst({
          where: {
            id: input.importBatchId,
            sourceDocumentId: input.documentId,
            orgId: run.orgId,
            status: { in: [ImportBatchStatus.validating, ImportBatchStatus.applying] }
          }
        });
        if (!batch)
          throw new Error(`Structured import batch ${input.importBatchId} cannot reject.`);

        const updated = await tx.importBatch.updateMany({
          where: {
            id: input.importBatchId,
            sourceDocumentId: input.documentId,
            orgId: run.orgId,
            status: { in: [ImportBatchStatus.validating, ImportBatchStatus.applying] }
          },
          data: {
            status: ImportBatchStatus.rejected,
            sourceSheetSummary: persistedSourceSheetSummary(batch.dataset, input.result),
            validationErrors: input.result.validationErrors as unknown as Prisma.InputJsonValue,
            validationErrorCount: input.result.validationErrorCount,
            totalRowCount: input.result.rows.length,
            appliedRowCount: 0,
            errorCode: PROCESSING_ERROR_CODES.structuredImportRejected,
            errorSummary: "Structured import validation failed."
          }
        });
        if (updated.count !== 1)
          throw new Error(`Structured import batch ${input.importBatchId} cannot reject.`);

        await tx.document.update({
          where: { id: input.documentId },
          data: { status: DocumentStatus.processing_failed }
        });
        await tx.auditLog.create({
          data: {
            orgId: run.orgId,
            actorEmployeeId: null,
            action: "structured_import.rejected",
            targetType: "import_batch",
            targetId: input.importBatchId,
            result: "failed",
            metadata: {
              processingRunId: input.runId,
              workerId: input.workerId,
              dataset: batch.dataset,
              sourceDocumentId: input.documentId,
              validationErrorCount: input.result.validationErrorCount,
              validationErrorsTruncated: input.result.validationErrorsTruncated
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

        if (run.jobType === "structured_import" && input.willRetry) {
          await tx.importBatch.updateMany({
            where: {
              sourceDocumentId: input.documentId,
              orgId: run.orgId,
              status: {
                in: [
                  ImportBatchStatus.pending,
                  ImportBatchStatus.validating,
                  ImportBatchStatus.applying,
                  ImportBatchStatus.failed
                ]
              }
            },
            data: {
              status: ImportBatchStatus.pending
            }
          });
        }

        if (run.jobType === "structured_import" && !input.willRetry) {
          const batch = await tx.importBatch.findFirst({
            where: {
              sourceDocumentId: input.documentId,
              orgId: run.orgId,
              status: {
                in: [
                  ImportBatchStatus.pending,
                  ImportBatchStatus.validating,
                  ImportBatchStatus.applying,
                  ImportBatchStatus.failed
                ]
              }
            },
            select: { id: true }
          });
          await tx.importBatch.updateMany({
            where: {
              sourceDocumentId: input.documentId,
              orgId: run.orgId,
              status: {
                in: [
                  ImportBatchStatus.pending,
                  ImportBatchStatus.validating,
                  ImportBatchStatus.applying,
                  ImportBatchStatus.failed
                ]
              }
            },
            data: {
              status: ImportBatchStatus.failed,
              errorCode: input.errorCode,
              errorSummary: input.errorSummary
            }
          });
          await tx.auditLog.create({
            data: {
              orgId: run.orgId,
              actorEmployeeId: null,
              action: "structured_import.failed",
              targetType: "import_batch",
              targetId: batch?.id ?? input.documentId,
              result: "failed",
              metadata: {
                processingRunId: input.runId,
                workerId: input.workerId,
                errorCode: input.errorCode
              }
            }
          });
        }

        if (run.jobType === "structured_partition_import" && run.partitionImportJobId) {
          await tx.partitionImportJob.update({
            where: { id: run.partitionImportJobId },
            data: {
              status: input.willRetry ? "queued" : "failed",
              errorCode: input.errorCode,
              errorSummary: input.errorSummary,
              ...(input.willRetry ? {} : { finishedAt: input.now })
            }
          });
        }

        const preserveActiveEvidence =
          run.documentId &&
          run.jobType === "evidence_document_index" &&
          (isVersionedEvidenceReindexJob(run.jobKey) ||
            Boolean(
              await tx.document.findFirst({
                where: { id: run.documentId, fileType: "pdf" },
                select: { id: true }
              })
            )) &&
          Boolean(
            await tx.document.findFirst({
              where: { id: run.documentId, status: DocumentStatus.active },
              select: { id: true }
            })
          );

        if (run.documentId && !preserveActiveEvidence) {
          await tx.document.update({
            where: { id: run.documentId },
            data: {
              status: input.willRetry
                ? DocumentStatus.pending_processing
                : DocumentStatus.processing_failed
            }
          });
        }

        if (!input.willRetry && run.documentId) {
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
  document: NonNullable<ClaimedProcessingRun["document"]>,
  storage: StorageAdapter
): Promise<Buffer> {
  try {
    return await streamToBuffer(await storage.getObjectStream(document.storageObjectKey));
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

function toProcessingError(error: unknown, jobType?: string): ProcessingError {
  if (error instanceof ProcessingError) {
    return error;
  }

  if (error instanceof ProcessingLeaseLostError) {
    return new ProcessingError(PROCESSING_ERROR_CODES.leaseLost, error.message, false);
  }

  if (error instanceof EvidenceParseError) {
    return new ProcessingError(error.code, error.message, false);
  }

  if (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    "retryable" in error &&
    typeof error.code === "string" &&
    typeof error.retryable === "boolean"
  ) {
    return new ProcessingError(
      error.code,
      error instanceof Error ? error.message : "Partition import failed.",
      error.retryable
    );
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

  const code =
    jobType === "structured_partition_import"
      ? PROCESSING_ERROR_CODES.partitionImportFailed
      : jobType === "structured_import"
        ? PROCESSING_ERROR_CODES.structuredImportFailed
        : PROCESSING_ERROR_CODES.evidenceIndexingFailed;
  return new ProcessingError(
    code,
    error instanceof Error ? error.message : "Processing failed.",
    true
  );
}

function toClaimedProcessingRun(
  run: Prisma.ProcessingRunGetPayload<{
    include: { document: true; partitionImportJob: true };
  }>,
  document: Prisma.DocumentGetPayload<Record<string, never>> | null,
  structuredImport?: ClaimedProcessingRun["structuredImport"],
  isEvidenceReindex = false
): ClaimedProcessingRun {
  return {
    id: run.id,
    orgId: run.orgId,
    documentId: run.documentId ?? run.partitionImportJobId ?? run.id,
    retryCount: run.retryCount,
    attemptNumber: run.attemptNumber,
    jobType: run.jobType,
    lockedBy: run.lockedBy,
    lockedUntil: run.lockedUntil,
    isEvidenceReindex,
    structuredImport,
    ...(run.partitionImportJob?.temporaryObjectKey
      ? {
          partitionImport: {
            jobId: run.partitionImportJob.id,
            dataset: run.partitionImportJob.dataset,
            enterpriseKey: run.partitionImportJob.enterpriseKey,
            enterpriseName: run.partitionImportJob.enterpriseName,
            confidentialityLevel: run.partitionImportJob.confidentialityLevel,
            originalFileName: run.partitionImportJob.originalFileName,
            sourceByteSize: run.partitionImportJob.sourceByteSize,
            sourceChecksumSha256: run.partitionImportJob.sourceChecksumSha256,
            sourceStartDate: run.partitionImportJob.sourceStartDate.toISOString().slice(0, 10),
            sourceEndDate: run.partitionImportJob.sourceEndDate.toISOString().slice(0, 10),
            temporaryObjectKey: run.partitionImportJob.temporaryObjectKey
          }
        }
      : {}),
    document: document
      ? {
          id: document.id,
          orgId: document.orgId,
          uploaderId: document.uploaderId,
          status: document.status,
          storageObjectKey: document.storageObjectKey,
          originalFileName: document.originalFileName,
          documentKind: document.documentKind,
          fileType: document.fileType,
          contentVersion: document.contentVersion,
          checksumSha256: document.checksumSha256,
          confidentialityLevel: document.confidentialityLevel
        }
      : null
  };
}

export function isEvidenceReindexJobForConfig(
  jobKey: string,
  retrievalConfigVersion: string
): boolean {
  return isVersionedEvidenceReindexJob(jobKey) && jobKey.endsWith(`:${retrievalConfigVersion}`);
}

function isVersionedEvidenceReindexJob(jobKey: string): boolean {
  return /^evidence_document_index:[^:]+:\d+:phase3\.retrieval\.[^:]+$/u.test(jobKey);
}

function requireDatabaseUrl(): string {
  const databaseUrl = process.env["DATABASE_URL"];

  if (!databaseUrl) {
    throw new Error("DATABASE_URL is required to run the processing worker.");
  }

  return databaseUrl;
}

async function insertStructuredRows(
  tx: Prisma.TransactionClient,
  dataset: StructuredDatasetName,
  batch: { id: string; orgId: string; sourceDocumentId: string },
  rows: StructuredParseResult["rows"],
  batchInsertSize: number
): Promise<void> {
  for (let offset = 0; offset < rows.length; offset += batchInsertSize) {
    const data = rows.slice(offset, offset + batchInsertSize).map((row) => ({
      orgId: batch.orgId,
      sourceDocumentId: batch.sourceDocumentId,
      importBatchId: batch.id,
      sourceSheetIndex: row.sourceSheetIndex,
      sourceSheetName: row.sourceSheetName,
      sourceRowNumber: row.sourceRowNumber,
      payload: row.payload as Prisma.InputJsonValue
    }));
    if (dataset === "vip") {
      await tx.vipRow.createMany({ data });
    } else if (dataset === "dish_catalog") {
      await tx.dishCatalogRow.createMany({ data });
    } else if (dataset === "delivery_ledger") {
      await tx.deliveryLedgerRow.createMany({ data });
    } else if (dataset === "supplier_catalog") {
      await tx.supplierCatalogRow.createMany({ data });
    } else {
      throw new Error(`Unsupported structured dataset: ${String(dataset)}`);
    }
  }
}

function persistedSourceSheetSummary(
  dataset: ImportDataset,
  result: Pick<StructuredParseResult, "sheetSummary" | "ignoredSheets">
): Prisma.InputJsonValue {
  if (dataset !== ImportDataset.dish_catalog) {
    return result.sheetSummary as unknown as Prisma.InputJsonValue;
  }

  return [
    ...result.sheetSummary.map((sheet) => ({ ...sheet, status: "imported" as const })),
    ...result.ignoredSheets.map((sheet) => ({ ...sheet, status: "ignored" as const }))
  ] as Prisma.InputJsonValue;
}

function structuredFileType(fileType: string | null | undefined): "csv" | "xlsx" | null {
  if (fileType === "csv" || fileType === "xlsx") return fileType;
  return null;
}

function unsupportedStructuredFileResult(): StructuredParseResult {
  return {
    sheetSummary: [],
    ignoredSheets: [],
    rows: [],
    validationErrors: [
      {
        code: "INVALID_FILE",
        message: "Structured file type is not supported.",
        sheetName: null,
        sheetIndex: null,
        rowNumber: null,
        column: null
      }
    ],
    validationErrorCount: 1,
    validationErrorsTruncated: false
  };
}

function structuredIngestionLimits(): StructuredIngestionLimits {
  return {
    maxStructuredImportRows: PHASE3_RUNTIME_LIMIT_DEFAULTS.maxStructuredImportRows,
    maxXlsxSheets: PHASE3_RUNTIME_LIMIT_DEFAULTS.maxXlsxSheets,
    maxStructuredCellChars: PHASE3_RUNTIME_LIMIT_DEFAULTS.maxStructuredCellChars,
    maxXlsxUncompressedBytes: PHASE3_RUNTIME_LIMIT_DEFAULTS.maxXlsxUncompressedBytes,
    maxXlsxZipEntries: PHASE3_RUNTIME_LIMIT_DEFAULTS.maxXlsxZipEntries,
    maxXlsxCompressionRatio: PHASE3_RUNTIME_LIMIT_DEFAULTS.maxXlsxCompressionRatio
  };
}

function formatDateWindow(value: Date): string {
  return `${value.getUTCFullYear()}${String(value.getUTCMonth() + 1).padStart(2, "0")}${String(
    value.getUTCDate()
  ).padStart(2, "0")}`;
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

function activeLeaseWhere(input: {
  runId: string;
  workerId: string;
  now: Date;
  attemptNumber?: number;
}) {
  return {
    id: input.runId,
    ...(input.attemptNumber === undefined ? {} : { attemptNumber: input.attemptNumber }),
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
  attemptNumber: number;
  workerId: string;
  leaseSeconds: number;
  now: () => Date;
  lockedUntil: Date | null;
  abort: () => void;
}) {
  let stopped = false;
  let heartbeatTimer: ReturnType<typeof setTimeout> | undefined;
  let expiryTimer: ReturnType<typeof setTimeout>;
  const loseLease = () => {
    stopped = true;
    clearTimeout(heartbeatTimer);
    clearTimeout(expiryTimer);
    input.abort();
  };
  const armExpiry = (until: Date) => {
    clearTimeout(expiryTimer);
    expiryTimer = setTimeout(
      () => {
        if (!stopped) loseLease();
      },
      Math.max(0, until.getTime() - input.now().getTime())
    );
  };
  const beat = async () => {
    if (stopped) return;
    try {
      const heartbeatAt = input.now();
      const renewed = await input.repository.heartbeatProcessingRun?.({
        runId: input.runId,
        attemptNumber: input.attemptNumber,
        workerId: input.workerId,
        leaseSeconds: input.leaseSeconds,
        now: heartbeatAt
      });
      if (stopped) return;
      if (renewed !== true) {
        loseLease();
        return;
      }
      armExpiry(addSeconds(heartbeatAt, input.leaseSeconds));
      heartbeatTimer = setTimeout(
        () => {
          void beat();
        },
        Math.max(1, (input.leaseSeconds * 1_000) / 3)
      );
    } catch {
      if (!stopped) loseLease();
    }
  };
  armExpiry(input.lockedUntil ?? addSeconds(input.now(), input.leaseSeconds));
  if (input.repository.heartbeatProcessingRun)
    heartbeatTimer = setTimeout(
      () => {
        void beat();
      },
      Math.max(1, (input.leaseSeconds * 1_000) / 3)
    );
  return {
    stop() {
      stopped = true;
      clearTimeout(heartbeatTimer);
      clearTimeout(expiryTimer);
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
