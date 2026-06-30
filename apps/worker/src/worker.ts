import { createHash } from "node:crypto";
import { extname } from "node:path";
import { PrismaMariaDb } from "@prisma/adapter-mariadb";
import { DocumentStatus, Prisma, PrismaClient, ProcessingRunStatus } from "@prisma/client";
import { AUDIT_ACTIONS } from "@enterprise-hub/domain";
import type { StorageAdapter } from "@enterprise-hub/storage";

const SUPPORTED_TEXT_EXTENSIONS = new Set([".txt", ".md", ".csv", ".json"]);
const TEXT_INDEX_TYPE = "text";
const MAX_PROCESSING_FAILURES = 3;

export const PROCESSING_ERROR_CODES = {
  unsupportedFileType: "UNSUPPORTED_FILE_TYPE",
  storageReadFailed: "STORAGE_READ_FAILED"
} as const;

export interface ClaimedProcessingRun {
  id: string;
  orgId: string;
  documentId: string;
  retryCount: number;
  document: {
    id: string;
    orgId: string;
    uploaderId: string;
    status: string;
    storageObjectKey: string;
    originalFileName: string | null;
  };
}

export interface DocumentChunkWrite {
  documentId: string;
  chunkIndex: number;
  chunkText: string;
  chunkHash: string;
  indexType: string;
}

export interface CompleteProcessingRunInput {
  runId: string;
  documentId: string;
  chunks: DocumentChunkWrite[];
}

export interface FailProcessingRunInput {
  runId: string;
  documentId: string;
  errorCode: string;
  errorSummary: string;
  willRetry: boolean;
}

export interface ProcessingWorkerRepository {
  claimNextProcessingRun(): Promise<ClaimedProcessingRun | null>;
  completeProcessingRun(input: CompleteProcessingRunInput): Promise<void>;
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

export async function runWorkerOnce(input: {
  repository: ProcessingWorkerRepository;
  storage: StorageAdapter;
}): Promise<RunWorkerOnceResult> {
  const run = await input.repository.claimNextProcessingRun();

  if (!run) {
    return { processed: false };
  }

  try {
    const text = await extractSupportedText(run.document, input.storage);
    const chunks = chunkText(text).map((chunkText, chunkIndex) => ({
      documentId: run.documentId,
      chunkIndex,
      chunkText,
      chunkHash: createChunkHash(chunkText),
      indexType: TEXT_INDEX_TYPE
    }));

    await input.repository.completeProcessingRun({
      runId: run.id,
      documentId: run.documentId,
      chunks
    });

    return {
      processed: true,
      documentId: run.documentId,
      status: "active"
    };
  } catch (error) {
    const processingError = toProcessingError(error);
    const nextRetryCount = run.retryCount + 1;
    const willRetry = nextRetryCount < MAX_PROCESSING_FAILURES;

    await input.repository.failProcessingRun({
      runId: run.id,
      documentId: run.documentId,
      errorCode: processingError.code,
      errorSummary: processingError.summary,
      willRetry
    });

    return {
      processed: true,
      documentId: run.documentId,
      status: willRetry ? "retry_scheduled" : "processing_failed"
    };
  }
}

export function createPrismaProcessingWorkerRepository(
  databaseUrl = requireDatabaseUrl()
): ProcessingWorkerRepository {
  const adapter = new PrismaMariaDb(databaseUrl);
  const prisma = new PrismaClient({ adapter });

  return {
    async claimNextProcessingRun() {
      const now = new Date();

      return prisma.$transaction(async (tx) => {
        const run = await tx.processingRun.findFirst({
          where: {
            status: {
              in: [ProcessingRunStatus.queued, ProcessingRunStatus.retry_scheduled]
            },
            document: {
              status: {
                in: [DocumentStatus.pending_processing, DocumentStatus.processing]
              }
            }
          },
          orderBy: [{ createdAt: "asc" }, { id: "asc" }],
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
            status: run.status
          },
          data: {
            status: ProcessingRunStatus.running,
            startedAt: now,
            finishedAt: null
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
              processingRunId: run.id
            }
          }
        });

        return toClaimedProcessingRun(run, document);
      });
    },
    async completeProcessingRun(input) {
      const now = new Date();

      await prisma.$transaction(async (tx) => {
        if (input.chunks.length > 0) {
          await tx.documentChunk.createMany({
            data: input.chunks.map((chunk) => ({
              documentId: chunk.documentId,
              chunkIndex: chunk.chunkIndex,
              chunkText: chunk.chunkText,
              chunkHash: chunk.chunkHash,
              indexType: chunk.indexType
            })),
            skipDuplicates: true
          });
        }

        const run = await tx.processingRun.update({
          where: {
            id: input.runId
          },
          data: {
            status: ProcessingRunStatus.succeeded,
            errorCode: null,
            errorSummary: null,
            finishedAt: now
          }
        });

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
              chunkCount: input.chunks.length
            }
          }
        });
      });
    },
    async failProcessingRun(input) {
      const now = new Date();

      await prisma.$transaction(async (tx) => {
        const run = await tx.processingRun.update({
          where: {
            id: input.runId
          },
          data: {
            status: input.willRetry
              ? ProcessingRunStatus.retry_scheduled
              : ProcessingRunStatus.failed,
            retryCount: {
              increment: 1
            },
            errorCode: input.errorCode,
            errorSummary: input.errorSummary,
            finishedAt: now
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

async function extractSupportedText(
  document: ClaimedProcessingRun["document"],
  storage: StorageAdapter
): Promise<string> {
  const extension = extname(document.originalFileName ?? document.storageObjectKey).toLowerCase();

  if (!SUPPORTED_TEXT_EXTENSIONS.has(extension)) {
    throw new ProcessingError(
      PROCESSING_ERROR_CODES.unsupportedFileType,
      `Unsupported file type: ${extension || "unknown"}`
    );
  }

  try {
    const stream = await storage.getObjectStream(document.storageObjectKey);
    return (await streamToBuffer(stream)).toString("utf8");
  } catch (error) {
    if (error instanceof ProcessingError) {
      throw error;
    }

    throw new ProcessingError(
      PROCESSING_ERROR_CODES.storageReadFailed,
      error instanceof Error ? error.message : "Unable to read storage object."
    );
  }
}

function chunkText(text: string): string[] {
  return text
    .replace(/\r\n?/g, "\n")
    .split(/\n{2,}|\n/g)
    .map((chunk) => chunk.trim())
    .filter((chunk) => chunk.length > 0);
}

function createChunkHash(chunkText: string): string {
  return createHash("sha256").update(chunkText, "utf8").digest("hex");
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

  constructor(code: string, summary: string) {
    super(summary);
    this.code = code;
    this.summary = summary;
  }
}

function toProcessingError(error: unknown): ProcessingError {
  if (error instanceof ProcessingError) {
    return error;
  }

  return new ProcessingError(
    PROCESSING_ERROR_CODES.storageReadFailed,
    error instanceof Error ? error.message : "Processing failed."
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
    document: {
      id: document.id,
      orgId: document.orgId,
      uploaderId: document.uploaderId,
      status: document.status,
      storageObjectKey: document.storageObjectKey,
      originalFileName: document.originalFileName
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
