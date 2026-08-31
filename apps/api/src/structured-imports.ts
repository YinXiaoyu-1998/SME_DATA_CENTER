import { randomBytes } from "node:crypto";
import { performance } from "node:perf_hooks";
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
  DocumentStatusName,
  ImportBatchStatusName,
  Phase3FileType,
  StructuredDatasetName
} from "@enterprise-hub/domain";
import { AUDIT_ACTIONS, getStructuredRegistry } from "@enterprise-hub/domain";
import type { RequestAuditContext } from "./request-audit-context.js";

export interface StructuredImportRowInput {
  sourceSheetIndex: number;
  sourceSheetName: string;
  sourceRowNumber: number;
  payload: Record<string, unknown>;
}

export interface StructuredImportTimingEvent {
  stage: string;
  durationMs: number;
  importBatchId?: string;
  sourceDocumentId?: string;
  dataset?: StructuredDatasetName;
  rowCount?: number;
  batchInsertSize?: number;
  batchIndex?: number;
  batchOffset?: number;
  batchRowCount?: number;
}

export interface StructuredImportBatchRecord {
  id: string;
  orgId: string;
  sourceDocumentId: string;
  sourceDocumentLabelKeys: string[];
  dataset: StructuredDatasetName;
  status: ImportBatchStatusName;
  startDate: string | null;
  endDate: string | null;
  naturalKey?: string | null;
  sourceSheetSummary: unknown[];
  validationErrors: unknown[];
  validationErrorCount: number;
  validationErrorsTruncated: boolean;
  totalRowCount: number;
  appliedRowCount: number;
  queryableRowCount: number;
  sourceDocumentStatus: DocumentStatusName;
  sourceDocumentFileType: Extract<Phase3FileType, "xlsx" | "csv">;
  storageObjectKey: string;
  originalFileName: string;
  processingRunId: string | null;
  processingStatus: string | null;
}

export interface ReserveStructuredImportInput {
  orgId: string;
  actorEmployeeId: string;
  documentId: string;
  dataset: StructuredDatasetName;
  fileType: Extract<Phase3FileType, "xlsx" | "csv">;
  startDate: string | null;
  endDate: string | null;
  naturalKey?: string;
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
  totalRowCount: number;
  audit: RequestAuditContext;
}

export interface ApplyReservedStructuredImportInput {
  orgId: string;
  actorEmployeeId: string;
  importBatchId: string;
  rows: StructuredImportRowInput[];
  audit: RequestAuditContext;
  onTiming?: (event: StructuredImportTimingEvent) => void;
}

export interface MarkStructuredImportStorageFailureInput {
  orgId: string;
  importBatchId: string;
  errorCode: string;
  errorSummary: string;
}

export interface StructuredImportRepository {
  reserveStructuredImport(input: ReserveStructuredImportInput): Promise<{
    state: "created" | "resumable" | "existing";
    importBatch: StructuredImportBatchRecord;
  }>;
  applyReservedStructuredImport(
    input: ApplyReservedStructuredImportInput
  ): Promise<StructuredImportBatchRecord>;
  enqueueReservedStructuredImport(input: {
    orgId: string;
    importBatchId: string;
  }): Promise<StructuredImportBatchRecord>;
  markStructuredImportStorageFailure(
    input: MarkStructuredImportStorageFailureInput
  ): Promise<StructuredImportBatchRecord>;
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

function isUniqueConstraintError(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002";
}

const importBatchInclude = {
  sourceDocument: {
    select: {
      status: true,
      fileType: true,
      storageObjectKey: true,
      originalFileName: true,
      documentLabels: {
        select: {
          label: {
            select: {
              key: true
            }
          }
        }
      },
      processingRuns: {
        where: { jobType: ProcessingJobType.structured_import },
        orderBy: { createdAt: "desc" },
        take: 1,
        select: { id: true, status: true }
      }
    }
  }
} as const satisfies Prisma.ImportBatchInclude;

function requireDatabaseUrl(): string {
  const databaseUrl = process.env["DATABASE_URL"];

  if (!databaseUrl) {
    throw new Error(
      "DATABASE_URL is required to start the API with the Prisma structured import repository."
    );
  }

  return databaseUrl;
}

function createImportBatchId(): string {
  return `imp_${randomBytes(12).toString("hex")}`;
}

function createStructuredRowId(): string {
  return `row_${randomBytes(12).toString("hex")}`;
}

function elapsedMs(started: number): number {
  return Number((performance.now() - started).toFixed(3));
}

async function measureStructuredImportStage<T>(
  input: Pick<ApplyReservedStructuredImportInput, "importBatchId" | "rows" | "onTiming">,
  stage: string,
  workload: () => Promise<T>,
  extra: Omit<StructuredImportTimingEvent, "stage" | "durationMs"> = {}
): Promise<T> {
  const started = performance.now();
  try {
    return await workload();
  } finally {
    input.onTiming?.({
      stage,
      durationMs: elapsedMs(started),
      importBatchId: input.importBatchId,
      rowCount: input.rows.length,
      ...extra
    });
  }
}

async function insertStructuredRows(
  tx: Prisma.TransactionClient,
  input: {
    dataset: StructuredDatasetName;
    orgId: string;
    sourceDocumentId: string;
    importBatchId: string;
    rows: StructuredImportRowInput[];
    batchInsertSize: number;
    onTiming?: (event: StructuredImportTimingEvent) => void;
  }
): Promise<void> {
  const tableName = getStructuredRegistry(input.dataset).rowTable;
  const batchSize = input.batchInsertSize;

  for (
    let offset = 0, batchIndex = 0;
    offset < input.rows.length;
    offset += batchSize, batchIndex += 1
  ) {
    const started = performance.now();
    const batch = input.rows.slice(offset, offset + batchSize);
    const values = batch.map(
      (row) =>
        Prisma.sql`(${createStructuredRowId()}, ${input.orgId}, ${input.sourceDocumentId}, ${input.importBatchId}, ${row.sourceSheetIndex}, ${row.sourceSheetName}, ${row.sourceRowNumber}, ${JSON.stringify(row.payload)})`
    );

    await tx.$executeRaw`
      INSERT INTO ${Prisma.raw(tableName)}
        (id, org_id, source_document_id, import_batch_id, source_sheet_index, source_sheet_name, source_row_number, payload)
      VALUES ${Prisma.join(values)}
    `;
    input.onTiming?.({
      stage: "apply.insert_rows_batch",
      durationMs: elapsedMs(started),
      importBatchId: input.importBatchId,
      sourceDocumentId: input.sourceDocumentId,
      dataset: input.dataset,
      rowCount: input.rows.length,
      batchInsertSize: batchSize,
      batchIndex,
      batchOffset: offset,
      batchRowCount: batch.length
    });
  }
}

export function createPrismaStructuredImportRepository(options: {
  databaseUrl?: string;
  transactionTimeoutMs: number;
  batchInsertSize: number;
}): StructuredImportRepository {
  const databaseUrl = options.databaseUrl ?? requireDatabaseUrl();
  const adapter = new PrismaMariaDb(databaseUrl);
  const prisma = new PrismaClient({ adapter });

  async function resolveExistingReservation(input: ReserveStructuredImportInput): Promise<{
    state: "resumable" | "existing";
    importBatch: StructuredImportBatchRecord;
  } | null> {
    const existingIdempotencyBatch = await prisma.importBatch.findUnique({
      where: {
        orgId_idempotencyKey: {
          orgId: input.orgId,
          idempotencyKey: input.idempotencyKey
        }
      },
      include: importBatchInclude
    });

    if (existingIdempotencyBatch) {
      if (existingIdempotencyBatch.requestFingerprint !== input.requestFingerprint) {
        throw new StructuredImportError("IDEMPOTENCY_KEY_CONFLICT");
      }

      return {
        state:
          existingIdempotencyBatch.sourceDocument.processingRuns.length > 0
            ? "existing"
            : "resumable",
        importBatch: toImportBatchRecord(existingIdempotencyBatch)
      };
    }

    if (input.dataset === "delivery_ledger" && input.naturalKey !== undefined) {
      const existingNaturalKeyBatch = await prisma.importBatch.findUnique({
        where: {
          orgId_dataset_naturalKey: {
            orgId: input.orgId,
            dataset: input.dataset as ImportDataset,
            naturalKey: input.naturalKey
          }
        },
        include: importBatchInclude
      });

      if (existingNaturalKeyBatch) {
        if (existingNaturalKeyBatch.requestFingerprint !== input.requestFingerprint) {
          throw new StructuredImportError("RECEIPT_ID_CONFLICT");
        }

        return {
          state:
            existingNaturalKeyBatch.sourceDocument.processingRuns.length > 0
              ? "existing"
              : "resumable",
          importBatch: toImportBatchRecord(existingNaturalKeyBatch)
        };
      }
    }

    const metadataPolicy = getStructuredRegistry(input.dataset).metadataPolicy;
    if (metadataPolicy !== "window" && metadataPolicy !== "snapshot") return null;

    const existingClaim = await prisma.importWindowClaim.findUnique({
      where: {
        orgId_dataset_startDate_endDate: {
          orgId: input.orgId,
          dataset: input.dataset as ImportDataset,
          startDate: parseDateWindowDate(input.startDate!),
          endDate: parseDateWindowDate(input.endDate!)
        }
      },
      include: {
        importBatch: {
          include: importBatchInclude
        }
      }
    });

    if (existingClaim?.importBatch) {
      if (existingClaim.importBatch.status === ImportBatchStatus.applied) {
        if (existingClaim.importBatch.sourceDocument.status === DocumentStatus.archived) {
          await prisma.importWindowClaim.deleteMany({
            where: {
              id: existingClaim.id,
              importBatchId: existingClaim.importBatch.id
            }
          });
          return null;
        }
        throw new StructuredImportError("ACTIVE_IMPORT_EXISTS");
      }

      if (
        existingClaim.importBatch.status === ImportBatchStatus.rejected ||
        existingClaim.importBatch.status === ImportBatchStatus.failed
      ) {
        await prisma.importWindowClaim.delete({ where: { id: existingClaim.id } });
        return null;
      }

      throw new StructuredImportError("IMPORT_IN_PROGRESS");
    }

    return null;
  }

  return {
    async findImportBatch(orgId, importBatchId) {
      const batch = await prisma.importBatch.findFirst({
        where: {
          id: importBatchId,
          orgId
        },
        include: importBatchInclude
      });

      return batch ? toImportBatchRecord(batch) : null;
    },
    async reserveStructuredImport(input) {
      const existing = await resolveExistingReservation(input);
      if (existing) return existing;
      const importBatchId = createImportBatchId();
      try {
        const batch = await prisma.$transaction(
          async (tx) => {
            await tx.document.create({
              data: {
                id: input.documentId,
                orgId: input.orgId,
                title: input.document.title,
                documentType: DocumentType.structured_dataset,
                documentKind: DocumentKind.structured,
                fileType: input.fileType as FileType,
                status: DocumentStatus.uploading,
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
                  endDate: input.endDate,
                  ...(input.dataset === "delivery_ledger" && input.naturalKey !== undefined
                    ? { naturalKey: input.naturalKey }
                    : {})
                },
                documentLabels: {
                  create: input.document.labelIds.map((labelId) => ({
                    labelId
                  }))
                }
              }
            });

            await tx.importBatch.create({
              data: {
                id: importBatchId,
                orgId: input.orgId,
                sourceDocumentId: input.documentId,
                dataset: input.dataset as ImportDataset,
                startDate: input.startDate ? parseDateWindowDate(input.startDate) : null,
                endDate: input.endDate ? parseDateWindowDate(input.endDate) : null,
                idempotencyKey: input.idempotencyKey,
                requestFingerprint: input.requestFingerprint,
                naturalKey: input.naturalKey,
                status: ImportBatchStatus.pending,
                sourceSheetSummary: [],
                validationErrors: [],
                validationErrorCount: 0,
                totalRowCount: 0,
                appliedRowCount: 0
              }
            });

            if (
              getStructuredRegistry(input.dataset).metadataPolicy === "window" ||
              getStructuredRegistry(input.dataset).metadataPolicy === "snapshot"
            ) {
              await tx.importWindowClaim.create({
                data: {
                  orgId: input.orgId,
                  dataset: input.dataset as ImportDataset,
                  startDate: parseDateWindowDate(input.startDate!),
                  endDate: parseDateWindowDate(input.endDate!),
                  importBatchId
                }
              });
            }

            await tx.auditLog.create({
              data: {
                orgId: input.orgId,
                actorEmployeeId: input.actorEmployeeId,
                action: AUDIT_ACTIONS.structuredImportStarted,
                targetType: "import_batch",
                targetId: importBatchId,
                result: "succeeded",
                metadata: {
                  dataset: input.dataset,
                  startDate: input.startDate,
                  endDate: input.endDate,
                  ...(input.dataset === "delivery_ledger" && input.naturalKey !== undefined
                    ? { naturalKey: input.naturalKey }
                    : {}),
                  rowCount: input.totalRowCount,
                  sourceDocumentId: input.documentId
                },
                requestId: input.audit.requestId,
                clientIp: input.audit.sourceIp,
                clientSource: input.audit.clientSource,
                launcherVersion: input.audit.launcherVersion
              }
            });

            return tx.importBatch.findUniqueOrThrow({
              where: { id: importBatchId },
              include: importBatchInclude
            });
          },
          { timeout: options.transactionTimeoutMs }
        );
        return { state: "created" as const, importBatch: toImportBatchRecord(batch) };
      } catch (error) {
        if (isUniqueConstraintError(error)) {
          const raced = await resolveExistingReservation(input);
          if (raced) return raced;
        }
        throw error;
      }
    },
    async applyReservedStructuredImport(input) {
      const applyStarted = performance.now();
      try {
        const transactionStarted = performance.now();
        const applied = await prisma.$transaction(
          async (tx) => {
            const existing = await measureStructuredImportStage(input, "apply.find_import", () =>
              tx.importBatch.findFirst({
                where: { id: input.importBatchId, orgId: input.orgId },
                include: importBatchInclude
              })
            );
            if (!existing) throw new Error("Reserved import batch was not found.");
            if (existing.status === ImportBatchStatus.applied) return toImportBatchRecord(existing);

            const baseTiming = {
              importBatchId: input.importBatchId,
              sourceDocumentId: existing.sourceDocumentId,
              dataset: existing.dataset,
              rowCount: input.rows.length,
              batchInsertSize: options.batchInsertSize
            };
            const claimed = await measureStructuredImportStage(
              input,
              "apply.claim_import",
              () =>
                tx.importBatch.updateMany({
                  where: {
                    id: input.importBatchId,
                    orgId: input.orgId,
                    status: {
                      in: [ImportBatchStatus.pending, ImportBatchStatus.failed]
                    }
                  },
                  data: {
                    status: ImportBatchStatus.applying,
                    errorCode: null,
                    errorSummary: null
                  }
                }),
              baseTiming
            );
            if (claimed.count !== 1) return null;

            await measureStructuredImportStage(
              input,
              "apply.delete_existing_rows",
              () => {
                if (existing.dataset === ImportDataset.dishes) {
                  return tx.dishRow.deleteMany({ where: { importBatchId: input.importBatchId } });
                }
                if (existing.dataset === ImportDataset.business) {
                  return tx.businessRow.deleteMany({
                    where: { importBatchId: input.importBatchId }
                  });
                }
                if (existing.dataset === ImportDataset.vip) {
                  return tx.vipRow.deleteMany({ where: { importBatchId: input.importBatchId } });
                }
                if (existing.dataset === ImportDataset.dish_catalog) {
                  return tx.dishCatalogRow.deleteMany({
                    where: { importBatchId: input.importBatchId }
                  });
                }
                if (existing.dataset === ImportDataset.delivery_ledger) {
                  return tx.deliveryLedgerRow.deleteMany({
                    where: { importBatchId: input.importBatchId }
                  });
                }
                if (existing.dataset === ImportDataset.supplier_catalog) {
                  return tx.supplierCatalogRow.deleteMany({
                    where: { importBatchId: input.importBatchId }
                  });
                }
                throw new Error(`Unsupported structured dataset: ${String(existing.dataset)}`);
              },
              baseTiming
            );
            await measureStructuredImportStage(
              input,
              "apply.insert_rows_total",
              () =>
                insertStructuredRows(tx, {
                  dataset: existing.dataset,
                  orgId: input.orgId,
                  sourceDocumentId: existing.sourceDocumentId,
                  importBatchId: input.importBatchId,
                  rows: input.rows,
                  batchInsertSize: options.batchInsertSize,
                  onTiming: input.onTiming
                }),
              baseTiming
            );
            const now = new Date();
            await measureStructuredImportStage(
              input,
              "apply.activate_document",
              () =>
                tx.document.update({
                  where: { id: existing.sourceDocumentId },
                  data: { status: DocumentStatus.active }
                }),
              baseTiming
            );
            await measureStructuredImportStage(
              input,
              "apply.create_processing_run",
              () =>
                tx.processingRun.create({
                  data: {
                    orgId: input.orgId,
                    documentId: existing.sourceDocumentId,
                    jobKey: `structured_import:applied:${input.importBatchId}`,
                    status: ProcessingRunStatus.succeeded,
                    jobType: ProcessingJobType.structured_import,
                    startedAt: now,
                    finishedAt: now
                  }
                }),
              baseTiming
            );
            const batch = await measureStructuredImportStage(
              input,
              "apply.finalize_import_batch",
              () =>
                tx.importBatch.update({
                  where: { id: input.importBatchId },
                  data: {
                    status: ImportBatchStatus.applied,
                    appliedRowCount: input.rows.length,
                    totalRowCount: input.rows.length,
                    appliedAt: now
                  },
                  include: importBatchInclude
                }),
              baseTiming
            );
            await measureStructuredImportStage(
              input,
              "apply.audit",
              () =>
                tx.auditLog.create({
                  data: {
                    orgId: input.orgId,
                    actorEmployeeId: input.actorEmployeeId,
                    action: AUDIT_ACTIONS.structuredImportApplied,
                    targetType: "import_batch",
                    targetId: input.importBatchId,
                    result: "succeeded",
                    metadata: {
                      dataset: batch.dataset,
                      startDate: formatDateWindowDate(batch.startDate),
                      endDate: formatDateWindowDate(batch.endDate),
                      ...(batch.dataset === "delivery_ledger" && batch.naturalKey !== null
                        ? { naturalKey: batch.naturalKey }
                        : {}),
                      appliedRowCount: input.rows.length,
                      sourceDocumentId: batch.sourceDocumentId
                    },
                    requestId: input.audit.requestId,
                    clientIp: input.audit.sourceIp,
                    clientSource: input.audit.clientSource,
                    launcherVersion: input.audit.launcherVersion
                  }
                }),
              {
                ...baseTiming,
                sourceDocumentId: batch.sourceDocumentId,
                dataset: batch.dataset
              }
            );
            return toImportBatchRecord(batch);
          },
          { timeout: options.transactionTimeoutMs }
        );
        input.onTiming?.({
          stage: "apply.transaction",
          durationMs: elapsedMs(transactionStarted),
          importBatchId: input.importBatchId,
          rowCount: input.rows.length,
          batchInsertSize: options.batchInsertSize
        });
        if (applied) return applied;
        const authoritative = await measureStructuredImportStage(
          input,
          "apply.find_authoritative",
          () =>
            prisma.importBatch.findFirst({
              where: { id: input.importBatchId, orgId: input.orgId },
              include: importBatchInclude
            })
        );
        if (authoritative?.status === ImportBatchStatus.applied) {
          return toImportBatchRecord(authoritative);
        }
        throw new Error("Reserved import batch cannot be applied.");
      } finally {
        input.onTiming?.({
          stage: "apply.total",
          durationMs: elapsedMs(applyStarted),
          importBatchId: input.importBatchId,
          rowCount: input.rows.length,
          batchInsertSize: options.batchInsertSize
        });
      }
    },
    async enqueueReservedStructuredImport(input) {
      try {
        const batch = await prisma.$transaction(
          async (tx) => {
            const existing = await tx.importBatch.findFirst({
              where: { id: input.importBatchId, orgId: input.orgId },
              include: importBatchInclude
            });

            if (!existing) {
              throw new Error("Reserved import batch was not found.");
            }

            if (existing.sourceDocument.processingRuns.length > 0) {
              return existing;
            }

            await tx.document.update({
              where: { id: existing.sourceDocumentId },
              data: { status: DocumentStatus.pending_processing }
            });
            await tx.processingRun.create({
              data: {
                orgId: input.orgId,
                documentId: existing.sourceDocumentId,
                jobKey: `structured_import:${existing.id}`,
                status: ProcessingRunStatus.queued,
                jobType: ProcessingJobType.structured_import
              }
            });
            return tx.importBatch.findUniqueOrThrow({
              where: { id: existing.id },
              include: importBatchInclude
            });
          },
          { timeout: options.transactionTimeoutMs }
        );
        return toImportBatchRecord(batch);
      } catch (error) {
        if (isUniqueConstraintError(error)) {
          const authoritative = await prisma.importBatch.findFirst({
            where: { id: input.importBatchId, orgId: input.orgId },
            include: importBatchInclude
          });
          if (authoritative?.sourceDocument.processingRuns.length) {
            return toImportBatchRecord(authoritative);
          }
        }
        throw error;
      }
    },
    async markStructuredImportStorageFailure(input) {
      const batch = await prisma.$transaction(
        async (tx) => {
          const claimed = await tx.importBatch.updateMany({
            where: {
              id: input.importBatchId,
              orgId: input.orgId,
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
          const existing = await tx.importBatch.findFirstOrThrow({
            where: { id: input.importBatchId, orgId: input.orgId },
            include: importBatchInclude
          });
          if (claimed.count !== 1) return existing;
          await tx.document.update({
            where: { id: existing.sourceDocumentId },
            data: { status: DocumentStatus.processing_failed }
          });
          await tx.processingRun.create({
            data: {
              orgId: input.orgId,
              documentId: existing.sourceDocumentId,
              jobKey: `structured_import:storage_failure:${input.importBatchId}:${randomBytes(6).toString("hex")}`,
              status: ProcessingRunStatus.failed,
              jobType: ProcessingJobType.structured_import,
              errorCode: input.errorCode,
              errorSummary: input.errorSummary,
              startedAt: new Date(),
              finishedAt: new Date()
            }
          });
          return tx.importBatch.findUniqueOrThrow({
            where: { id: input.importBatchId },
            include: importBatchInclude
          });
        },
        { timeout: options.transactionTimeoutMs }
      );
      return toImportBatchRecord(batch);
    },
    async disconnect() {
      await prisma.$disconnect();
    }
  };
}

function toImportBatchRecord(
  batch: Prisma.ImportBatchGetPayload<{
    include: typeof importBatchInclude;
  }>
): StructuredImportBatchRecord {
  const archived = batch.sourceDocument.status === DocumentStatus.archived;
  const processingRun = batch.sourceDocument.processingRuns[0];
  const validationErrors = arrayJson(batch.validationErrors);

  return {
    id: batch.id,
    orgId: batch.orgId,
    sourceDocumentId: batch.sourceDocumentId,
    sourceDocumentLabelKeys: batch.sourceDocument.documentLabels.map(
      (documentLabel) => documentLabel.label.key
    ),
    dataset: batch.dataset,
    status: archived ? "archived" : batch.status,
    startDate: formatDateWindowDate(batch.startDate),
    endDate: formatDateWindowDate(batch.endDate),
    naturalKey: batch.naturalKey,
    sourceSheetSummary: arrayJson(batch.sourceSheetSummary),
    validationErrors,
    validationErrorCount: batch.validationErrorCount,
    validationErrorsTruncated: batch.validationErrorCount > validationErrors.length,
    totalRowCount: batch.totalRowCount,
    appliedRowCount: batch.appliedRowCount,
    queryableRowCount: archived ? 0 : batch.appliedRowCount,
    sourceDocumentStatus: batch.sourceDocument.status,
    sourceDocumentFileType: batch.sourceDocument.fileType as Extract<
      Phase3FileType,
      "xlsx" | "csv"
    >,
    storageObjectKey: batch.sourceDocument.storageObjectKey,
    originalFileName: batch.sourceDocument.originalFileName ?? "file",
    processingRunId: processingRun?.id ?? null,
    processingStatus: processingRun?.status ?? null
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

function formatDateWindowDate(value: Date | null): string | null {
  if (!value) return null;

  const year = value.getUTCFullYear();
  const month = String(value.getUTCMonth() + 1).padStart(2, "0");
  const day = String(value.getUTCDate()).padStart(2, "0");

  return `${year}${month}${day}`;
}
