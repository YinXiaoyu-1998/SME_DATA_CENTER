import { readdir } from "node:fs/promises";
import ExcelJS from "exceljs";
import type { StructuredDatasetName } from "@enterprise-hub/domain";
import { AUDIT_ACTIONS, getStructuredRegistry } from "@enterprise-hub/domain";
import type { RequestAuditContext } from "../request-audit-context.js";
import { createMultipartPayload } from "./multipart-fixtures.js";
import type { RecordedAuditLog, RecordedDocument } from "./document-fixtures.js";

export function validStructuredCsv(
  dataset: StructuredDatasetName,
  overrides: Record<string, string> = {}
) {
  const registry = getStructuredRegistry(dataset);
  const values = registry.fields.map((field, index) => {
    if (overrides[field.canonicalName] !== undefined) {
      return overrides[field.canonicalName];
    }

    if (field.canonicalName === "business_date") {
      return "2026-07-02";
    }

    if (field.type === "integer") {
      return String(index + 1);
    }

    if (field.type === "decimal" || field.type === "percent") {
      return `${index + 1}.5`;
    }

    if (field.type === "date") {
      return "2026-07-02";
    }

    if (field.type === "date_time") {
      return "2026-07-02 12:30:00";
    }

    return `value_${index + 1}`;
  });

  return `${registry.fields.map((field) => field.sourceColumn).join(",")}\n${values.join(",")}\n`;
}

export async function structuredWorkbook(input: {
  dataset: StructuredDatasetName;
  includeHiddenSheet?: boolean;
  includeExplanationSheet?: boolean;
  prefaceRows?: string[][];
  rowCount?: number;
  cellOverrides?: Record<string, unknown>;
}) {
  const registry = getStructuredRegistry(input.dataset);
  const workbook = new ExcelJS.Workbook();
  const headers = registry.fields.map((field) => field.sourceColumn);
  const row = registry.fields.map((field, index): unknown => {
    if (input.cellOverrides?.[field.canonicalName] !== undefined) {
      return input.cellOverrides[field.canonicalName];
    }
    if (field.canonicalName === "business_date") {
      return "2026-07-02";
    }

    if (field.type === "integer") {
      return String(index + 1);
    }

    if (field.type === "decimal" || field.type === "percent") {
      return `${index + 1}.5`;
    }

    if (field.type === "date") {
      return "2026-07-02";
    }

    if (field.type === "date_time") {
      return "2026-07-02 12:30:00";
    }

    return `value_${index + 1}`;
  });
  workbook
    .addWorksheet("Data")
    .addRows([
      ...(input.prefaceRows ?? []),
      headers,
      ...Array.from({ length: input.rowCount ?? 1 }, () => row)
    ]);

  if (input.includeHiddenSheet) {
    workbook.addWorksheet("HiddenData", { state: "hidden" }).addRows([headers, row]);
  }

  if (input.includeExplanationSheet) {
    workbook.addWorksheet("Explanation").addRows([["说明"], ["这个 sheet 不是结构化数据"]]);
  }

  return Buffer.from(await workbook.xlsx.writeBuffer());
}

export function createStructuredImportMultipart(input: {
  dataset?: StructuredDatasetName;
  enterpriseName?: string;
  startDate?: string | null;
  endDate?: string | null;
  snapshotDate?: string;
  idempotencyKey?: string;
  labelKeys?: string[];
  fileName?: string;
  contentType?: string;
  body?: Buffer;
}) {
  return createMultipartPayload([
    { name: "dataset", value: input.dataset ?? "dishes" },
    { name: "enterprise_name", value: input.enterpriseName ?? "保利店" },
    ...(input.startDate === null
      ? []
      : [{ name: "startDate", value: input.startDate ?? "20260701" }]),
    ...(input.endDate === null ? [] : [{ name: "endDate", value: input.endDate ?? "20260705" }]),
    ...(input.snapshotDate ? [{ name: "snapshotDate", value: input.snapshotDate }] : []),
    { name: "idempotencyKey", value: input.idempotencyKey ?? "import-key-1" },
    ...(input.labelKeys ?? ["store:baoli"]).map((labelKey) => ({
      name: "labelKeys[]",
      value: labelKey
    })),
    {
      name: "file",
      fileName: input.fileName ?? "original-dishes.csv",
      contentType: input.contentType ?? "text/csv",
      value: input.body ?? Buffer.from(validStructuredCsv(input.dataset ?? "dishes"), "utf8")
    }
  ]);
}

export function createInMemoryStructuredImportRepository(
  documents: RecordedDocument[],
  auditLogs: RecordedAuditLog[]
) {
  type StoredRow = {
    dataset: StructuredDatasetName;
    sourceDocumentId: string;
  };
  type StoredBatch = {
    id: string;
    orgId: string;
    dataset: StructuredDatasetName;
    startDate: string;
    endDate: string;
    idempotencyKey: string;
    requestFingerprint: string;
    status: string;
    sourceDocumentId: string;
    totalRowCount: number;
    appliedRowCount: number;
    sourceSheetSummary: unknown[];
    validationErrors: unknown[];
    validationErrorCount: number;
    processingRunId: string | null;
    processingStatus: string | null;
  };

  const batches: StoredBatch[] = [];
  const rows: StoredRow[] = [];
  const inProgressWindows = new Set<string>();
  let nextApplyFailure: Error | null = null;
  let nextEnqueueFailure: Error | null = null;

  function windowKey(input: {
    dataset: StructuredDatasetName;
    startDate: string;
    endDate: string;
  }) {
    return `${input.dataset}:${input.startDate}:${input.endDate}`;
  }

  return {
    batches,
    rows,
    failNextApply(message = "simulated apply failure") {
      nextApplyFailure = new Error(message);
    },
    failNextEnqueue(message = "simulated enqueue failure") {
      nextEnqueueFailure = new Error(message);
    },
    markWindowInProgress(input: {
      dataset: StructuredDatasetName;
      startDate: string;
      endDate: string;
    }) {
      inProgressWindows.add(windowKey(input));
    },
    storedRowCount(dataset: StructuredDatasetName) {
      return rows.filter((row) => row.dataset === dataset).length;
    },
    queryableRowCount(dataset: StructuredDatasetName) {
      const documentStatus = new Map(documents.map((document) => [document.id, document.status]));
      return rows.filter(
        (row) => row.dataset === dataset && documentStatus.get(row.sourceDocumentId) === "active"
      ).length;
    },
    async findImportBatch(orgId: string, importBatchId: string) {
      const batch = batches.find(
        (candidate) => candidate.id === importBatchId && candidate.orgId === orgId
      );

      if (!batch) {
        return null;
      }

      const sourceDocument = documents.find((document) => document.id === batch.sourceDocumentId);
      const queryableRowCount = this.queryableRowCount(batch.dataset);

      return {
        ...batch,
        sourceDocumentLabelKeys: sourceDocument?.labels ?? [],
        status: sourceDocument?.status === "archived" ? "archived" : batch.status,
        queryableRowCount,
        sourceDocumentStatus: sourceDocument?.status ?? "processing_failed",
        sourceDocumentFileType: sourceDocument?.fileType ?? "csv",
        storageObjectKey: sourceDocument?.storageObjectKey ?? "",
        originalFileName: sourceDocument?.originalFileName ?? "file",
        validationErrorsTruncated: batch.validationErrorCount > batch.validationErrors.length,
        processingRunId: batch.processingRunId,
        processingStatus: batch.processingStatus
      };
    },
    async reserveStructuredImport(input: {
      orgId: string;
      actorEmployeeId: string;
      documentId: string;
      dataset: StructuredDatasetName;
      fileType: "xlsx" | "csv";
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
      totalRowCount: number;
      audit: RequestAuditContext;
    }) {
      const existingIdempotencyBatch = batches.find(
        (batch) => batch.orgId === input.orgId && batch.idempotencyKey === input.idempotencyKey
      );

      if (existingIdempotencyBatch) {
        if (existingIdempotencyBatch.requestFingerprint !== input.requestFingerprint) {
          throw Object.assign(new Error("IDEMPOTENCY_KEY_CONFLICT"), {
            code: "IDEMPOTENCY_KEY_CONFLICT"
          });
        }

        return {
          state: existingIdempotencyBatch.processingRunId ? "existing" : "resumable",
          importBatch: await this.findImportBatch(input.orgId, existingIdempotencyBatch.id)
        };
      }

      if (inProgressWindows.has(windowKey(input))) {
        throw Object.assign(new Error("IMPORT_IN_PROGRESS"), {
          code: "IMPORT_IN_PROGRESS"
        });
      }

      const existingWindowBatch = batches.find(
        (batch) =>
          batch.orgId === input.orgId &&
          batch.dataset === input.dataset &&
          batch.startDate === input.startDate &&
          batch.endDate === input.endDate &&
          !["rejected", "failed"].includes(batch.status) &&
          documents.find((document) => document.id === batch.sourceDocumentId)?.status !==
            "archived"
      );

      if (existingWindowBatch) {
        throw Object.assign(
          new Error(
            existingWindowBatch.status === "applied" ? "ACTIVE_IMPORT_EXISTS" : "IMPORT_IN_PROGRESS"
          ),
          {
            code:
              existingWindowBatch.status === "applied"
                ? "ACTIVE_IMPORT_EXISTS"
                : "IMPORT_IN_PROGRESS"
          }
        );
      }

      const batch: StoredBatch = {
        id: `imp_${batches.length + 1}`,
        orgId: input.orgId,
        dataset: input.dataset,
        startDate: input.startDate,
        endDate: input.endDate,
        idempotencyKey: input.idempotencyKey,
        requestFingerprint: input.requestFingerprint,
        status: "pending",
        sourceDocumentId: input.documentId,
        totalRowCount: 0,
        appliedRowCount: 0,
        sourceSheetSummary: [],
        validationErrors: [],
        validationErrorCount: 0,
        processingRunId: null,
        processingStatus: null
      };
      batches.push(batch);
      documents.push({
        id: input.documentId,
        orgId: input.orgId,
        uploaderId: input.actorEmployeeId,
        status: "uploading",
        title: input.document.title,
        documentType: "structured_dataset",
        documentKind: "structured",
        fileType: input.fileType,
        sourceSystem: "structured_import",
        sourceTime: null,
        storageObjectKey: input.document.storageObjectKey,
        originalFileName: input.document.originalFileName,
        contentType: input.document.contentType ?? null,
        byteSize: input.document.byteSize,
        checksumSha256: input.document.checksumSha256,
        labels: input.document.labels,
        processingRunStatus: null,
        documentIndexStatus: null,
        createdAt: new Date(),
        sourceMetadata: {
          dataset: input.dataset,
          importBatchId: batch.id
        },
        chunks: []
      });
      auditLogs.push({
        action: AUDIT_ACTIONS.structuredImportStarted,
        actorEmployeeId: input.actorEmployeeId,
        targetType: "import_batch",
        targetId: batch.id,
        result: "succeeded",
        metadata: {
          dataset: input.dataset,
          startDate: input.startDate,
          endDate: input.endDate,
          rowCount: input.totalRowCount,
          sourceDocumentId: input.documentId
        },
        requestId: input.audit.requestId,
        clientIp: input.audit.sourceIp,
        clientSource: input.audit.clientSource,
        launcherVersion: input.audit.launcherVersion
      });

      return {
        state: "created",
        importBatch: await this.findImportBatch(input.orgId, batch.id)
      };
    },
    async enqueueReservedStructuredImport(input: { orgId: string; importBatchId: string }) {
      const batch = batches.find(
        (candidate) => candidate.id === input.importBatchId && candidate.orgId === input.orgId
      );
      if (!batch) throw new Error("Reserved import batch was not found.");
      if (batch.processingRunId) return this.findImportBatch(input.orgId, batch.id);
      if (nextEnqueueFailure) {
        const failure = nextEnqueueFailure;
        nextEnqueueFailure = null;
        throw failure;
      }
      batch.processingRunId = `run_${batch.id}`;
      batch.processingStatus = "queued";
      const document = documents.find((candidate) => candidate.id === batch.sourceDocumentId);
      if (!document) throw new Error("Reserved source document was not found.");
      document.status = "pending_processing";
      document.processingRunStatus = "queued";
      return this.findImportBatch(input.orgId, batch.id);
    },
    async applyReservedStructuredImport(input: {
      orgId: string;
      actorEmployeeId: string;
      importBatchId: string;
      rows: Array<{
        payload: Record<string, unknown>;
        sourceSheetIndex: number;
        sourceSheetName: string;
        sourceRowNumber: number;
      }>;
      audit: RequestAuditContext;
    }) {
      const batch = batches.find(
        (candidate) => candidate.id === input.importBatchId && candidate.orgId === input.orgId
      );
      if (!batch) throw new Error("Reserved import batch was not found.");
      if (batch.status === "applied") return this.findImportBatch(input.orgId, batch.id);
      if (nextApplyFailure) {
        const failure = nextApplyFailure;
        nextApplyFailure = null;
        throw failure;
      }
      rows.splice(
        0,
        rows.length,
        ...rows.filter((row) => row.sourceDocumentId !== batch.sourceDocumentId),
        ...input.rows.map(() => ({
          dataset: batch.dataset,
          sourceDocumentId: batch.sourceDocumentId
        }))
      );
      batch.status = "applied";
      batch.totalRowCount = input.rows.length;
      batch.appliedRowCount = input.rows.length;
      const document = documents.find((candidate) => candidate.id === batch.sourceDocumentId);
      if (!document) throw new Error("Reserved source document was not found.");
      document.status = "active";
      document.processingRunStatus = "succeeded";
      auditLogs.push({
        action: AUDIT_ACTIONS.structuredImportApplied,
        actorEmployeeId: input.actorEmployeeId,
        targetType: "import_batch",
        targetId: batch.id,
        result: "succeeded",
        metadata: {
          dataset: batch.dataset,
          startDate: batch.startDate,
          endDate: batch.endDate,
          appliedRowCount: input.rows.length,
          sourceDocumentId: batch.sourceDocumentId
        },
        requestId: input.audit.requestId,
        clientIp: input.audit.sourceIp,
        clientSource: input.audit.clientSource,
        launcherVersion: input.audit.launcherVersion
      });
      return this.findImportBatch(input.orgId, batch.id);
    },
    async markStructuredImportStorageFailure(input: {
      orgId: string;
      importBatchId: string;
      errorCode: string;
      errorSummary: string;
    }) {
      const batch = batches.find(
        (candidate) => candidate.id === input.importBatchId && candidate.orgId === input.orgId
      );
      if (!batch) throw new Error("Reserved import batch was not found.");
      batch.status = "failed";
      const document = documents.find((candidate) => candidate.id === batch.sourceDocumentId);
      if (!document) throw new Error("Reserved source document was not found.");
      document.status = "processing_failed";
      document.processingRunStatus = "failed";
      return this.findImportBatch(input.orgId, batch.id);
    }
  };
}

export async function storedObjectCount(root: string | undefined): Promise<number> {
  if (!root) return 0;
  const entries = await readdir(root, { recursive: true, withFileTypes: true });
  return entries.filter((entry) => entry.isFile() && !entry.name.endsWith(".metadata.json")).length;
}
