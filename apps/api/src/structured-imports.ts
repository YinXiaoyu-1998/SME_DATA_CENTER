import { PrismaMariaDb } from "@prisma/adapter-mariadb";
import {
  DocumentKind,
  DocumentStatus,
  DocumentType,
  FileType,
  ImportBatchStatus,
  ImportDataset,
  Prisma,
  PrismaClient,
  ProcessingJobType,
  ProcessingRunStatus
} from "@prisma/client";
import type {
  ImportBatchStatusName,
  Phase3FileType,
  StructuredDatasetName
} from "@enterprise-hub/domain";

export interface StructuredImportRowInput {
  sourceRowNumber: number;
  payload: Record<string, unknown>;
}

export interface StructuredImportBatchRecord {
  id: string;
  orgId: string;
  sourceDocumentId: string;
  dataset: StructuredDatasetName;
  status: ImportBatchStatusName;
  startDate: string;
  endDate: string;
  sourceSheetSummary: unknown[];
  validationErrors: unknown[];
  totalRowCount: number;
  appliedRowCount: number;
  queryableRowCount: number;
}

export interface ApplyStructuredImportInput {
  orgId: string;
  actorEmployeeId: string;
  documentId: string;
  dataset: StructuredDatasetName;
  fileType: Extract<Phase3FileType, "xlsx" | "csv">;
  startDate: string;
  endDate: string;
  idempotencyKey: string;
  requestFingerprint: string;
  document: {
    title: string;
    storageObjectKey: string;
    originalFileName: string;
    contentType?: string;
    byteSize: number;
    checksumSha256: string;
    labelIds: string[];
    labels: string[];
  };
  sourceSheetSummary: unknown[];
  rows: StructuredImportRowInput[];
}

export interface StructuredImportRepository {
  importStructuredDataset(
    input: ApplyStructuredImportInput
  ): Promise<StructuredImportBatchRecord | null>;
  findImportBatch(
    orgId: string,
    importBatchId: string
  ): Promise<StructuredImportBatchRecord | null>;
  disconnect?(): Promise<void>;
}

export class StructuredImportError extends Error {
  constructor(
    readonly code: string,
    message = code
  ) {
    super(message);
  }
}

function requireDatabaseUrl(): string {
  const databaseUrl = process.env["DATABASE_URL"];

  if (!databaseUrl) {
    throw new Error(
      "DATABASE_URL is required to start the API with the Prisma structured import repository."
    );
  }

  return databaseUrl;
}

export function createPrismaStructuredImportRepository(
  databaseUrl = requireDatabaseUrl()
): StructuredImportRepository {
  const adapter = new PrismaMariaDb(databaseUrl);
  const prisma = new PrismaClient({ adapter });

  return {
    async findImportBatch(orgId, importBatchId) {
      const batch = await prisma.importBatch.findFirst({
        where: {
          id: importBatchId,
          orgId
        },
        include: {
          sourceDocument: {
            select: {
              status: true
            }
          }
        }
      });

      return batch ? toImportBatchRecord(batch) : null;
    },
    async importStructuredDataset(input) {
      const existingIdempotencyBatch = await prisma.importBatch.findUnique({
        where: {
          orgId_idempotencyKey: {
            orgId: input.orgId,
            idempotencyKey: input.idempotencyKey
          }
        },
        include: {
          sourceDocument: {
            select: {
              status: true
            }
          }
        }
      });

      if (existingIdempotencyBatch) {
        if (existingIdempotencyBatch.requestFingerprint !== input.requestFingerprint) {
          throw new StructuredImportError("IDEMPOTENCY_KEY_CONFLICT");
        }

        return toImportBatchRecord(existingIdempotencyBatch);
      }

      const existingClaim = await prisma.importWindowClaim.findUnique({
        where: {
          orgId_dataset_startDate_endDate: {
            orgId: input.orgId,
            dataset: input.dataset as ImportDataset,
            startDate: parseDateWindowDate(input.startDate),
            endDate: parseDateWindowDate(input.endDate)
          }
        },
        include: {
          importBatch: {
            include: {
              sourceDocument: {
                select: {
                  status: true
                }
              }
            }
          }
        }
      });

      if (existingClaim?.importBatch) {
        if (["pending", "validating", "applying"].includes(existingClaim.importBatch.status)) {
          throw new StructuredImportError("IMPORT_IN_PROGRESS");
        }

        if (
          existingClaim.importBatch.status === ImportBatchStatus.applied &&
          existingClaim.importBatch.sourceDocument.status === DocumentStatus.active
        ) {
          throw new StructuredImportError("ACTIVE_IMPORT_EXISTS");
        }
      }

      const batch = await prisma.$transaction(async (tx) => {
        await tx.document.create({
          data: {
            id: input.documentId,
            orgId: input.orgId,
            title: input.document.title,
            documentType: DocumentType.structured_dataset,
            documentKind: DocumentKind.structured,
            fileType: input.fileType as FileType,
            status: DocumentStatus.active,
            storageObjectKey: input.document.storageObjectKey,
            originalFileName: input.document.originalFileName,
            contentType: input.document.contentType,
            byteSize: input.document.byteSize,
            checksumSha256: input.document.checksumSha256,
            uploaderId: input.actorEmployeeId,
            sourceSystem: "structured_import",
            sourceMetadata: {
              dataset: input.dataset,
              startDate: input.startDate,
              endDate: input.endDate
            },
            documentLabels: {
              create: input.document.labelIds.map((labelId) => ({
                labelId
              }))
            },
            processingRuns: {
              create: {
                orgId: input.orgId,
                status: ProcessingRunStatus.succeeded,
                jobType: ProcessingJobType.structured_import,
                startedAt: new Date(),
                finishedAt: new Date()
              }
            }
          }
        });

        const createdBatch = await tx.importBatch.create({
          data: {
            orgId: input.orgId,
            sourceDocumentId: input.documentId,
            dataset: input.dataset as ImportDataset,
            startDate: parseDateWindowDate(input.startDate),
            endDate: parseDateWindowDate(input.endDate),
            idempotencyKey: input.idempotencyKey,
            requestFingerprint: input.requestFingerprint,
            status: ImportBatchStatus.applying,
            sourceSheetSummary: input.sourceSheetSummary as Prisma.InputJsonValue,
            validationErrors: [],
            totalRowCount: input.rows.length,
            appliedRowCount: 0
          }
        });

        await tx.importWindowClaim.create({
          data: {
            orgId: input.orgId,
            dataset: input.dataset as ImportDataset,
            startDate: parseDateWindowDate(input.startDate),
            endDate: parseDateWindowDate(input.endDate),
            importBatchId: createdBatch.id
          }
        });

        if (input.dataset === "dishes") {
          await tx.dishRow.createMany({
            data: input.rows.map((row) => ({
              orgId: input.orgId,
              sourceDocumentId: input.documentId,
              importBatchId: createdBatch.id,
              sourceRowNumber: row.sourceRowNumber,
              payload: row.payload as Prisma.InputJsonValue
            }))
          });
        } else {
          await tx.businessRow.createMany({
            data: input.rows.map((row) => ({
              orgId: input.orgId,
              sourceDocumentId: input.documentId,
              importBatchId: createdBatch.id,
              sourceRowNumber: row.sourceRowNumber,
              payload: row.payload as Prisma.InputJsonValue
            }))
          });
        }

        return tx.importBatch.update({
          where: {
            id: createdBatch.id
          },
          data: {
            status: ImportBatchStatus.applied,
            appliedRowCount: input.rows.length
          },
          include: {
            sourceDocument: {
              select: {
                status: true
              }
            }
          }
        });
      });

      return toImportBatchRecord(batch);
    },
    async disconnect() {
      await prisma.$disconnect();
    }
  };
}

function toImportBatchRecord(
  batch: Prisma.ImportBatchGetPayload<{
    include: {
      sourceDocument: {
        select: {
          status: true;
        };
      };
    };
  }>
): StructuredImportBatchRecord {
  const archived = batch.sourceDocument.status === DocumentStatus.archived;

  return {
    id: batch.id,
    orgId: batch.orgId,
    sourceDocumentId: batch.sourceDocumentId,
    dataset: batch.dataset,
    status: archived ? "archived" : batch.status,
    startDate: formatDateWindowDate(batch.startDate),
    endDate: formatDateWindowDate(batch.endDate),
    sourceSheetSummary: arrayJson(batch.sourceSheetSummary),
    validationErrors: arrayJson(batch.validationErrors),
    totalRowCount: batch.totalRowCount,
    appliedRowCount: batch.appliedRowCount,
    queryableRowCount: archived ? 0 : batch.appliedRowCount
  };
}

function arrayJson(value: Prisma.JsonValue | null): unknown[] {
  return Array.isArray(value) ? value : [];
}

function parseDateWindowDate(value: string): Date {
  return new Date(
    Date.UTC(
      Number.parseInt(value.slice(0, 4), 10),
      Number.parseInt(value.slice(4, 6), 10) - 1,
      Number.parseInt(value.slice(6, 8), 10)
    )
  );
}

function formatDateWindowDate(value: Date): string {
  const year = value.getUTCFullYear();
  const month = String(value.getUTCMonth() + 1).padStart(2, "0");
  const day = String(value.getUTCDate()).padStart(2, "0");

  return `${year}${month}${day}`;
}
