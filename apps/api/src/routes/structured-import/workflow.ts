import { createHash, randomBytes } from "node:crypto";
import { performance } from "node:perf_hooks";
import {
  PHASE3_ERROR_CODES,
  PHASE3_FILE_TYPES,
  PUBLIC_INPUT_LIMITS,
  type Phase3FileType,
  type StructuredDatasetName
} from "@enterprise-hub/domain";
import type { StructuredImportBatchRecord } from "../../structured-imports.js";

export interface ParsedStructuredImportUpload {
  file?: {
    fileName: string;
    contentType?: string;
    body: Buffer;
  };
  dataset?: string;
  enterpriseName?: string;
  startDate?: string;
  endDate?: string;
  idempotencyKey?: string;
  labelKeys: string[];
}

export function createStructuredImportDocumentId(): string {
  return `doc_${randomBytes(12).toString("hex")}`;
}

export function uniqueSorted(values: string[]): string[] {
  return [...new Set(values.filter((value) => value.length > 0))].sort();
}

export function validateStructuredImportMetadata(upload: ParsedStructuredImportUpload):
  | {
      ok: true;
      dataset: StructuredDatasetName;
      fileType: Extract<Phase3FileType, "xlsx" | "csv">;
      startDate: string;
      endDate: string;
    }
  | {
      ok: false;
      code: string;
      message: string;
    } {
  if (!upload.file) {
    return {
      ok: false,
      code: "INVALID_STRUCTURED_IMPORT_UPLOAD",
      message: "File is required."
    };
  }

  if (upload.file.fileName.length > PUBLIC_INPUT_LIMITS.uploadFilenameChars) {
    return {
      ok: false,
      code: "INVALID_STRUCTURED_IMPORT_UPLOAD",
      message: "Filename exceeds the allowed limit."
    };
  }

  if (!upload.dataset || !["dishes", "business"].includes(upload.dataset)) {
    return {
      ok: false,
      code: "INVALID_STRUCTURED_IMPORT_UPLOAD",
      message: "dataset must be dishes or business."
    };
  }

  if (!upload.enterpriseName) {
    return {
      ok: false,
      code: "INVALID_STRUCTURED_IMPORT_UPLOAD",
      message: "enterprise_name is required."
    };
  }

  if (upload.enterpriseName.length > PUBLIC_INPUT_LIMITS.enterpriseNameChars) {
    return {
      ok: false,
      code: "INVALID_STRUCTURED_IMPORT_UPLOAD",
      message: "enterprise_name exceeds the allowed limit."
    };
  }

  if (!upload.idempotencyKey) {
    return {
      ok: false,
      code: "INVALID_STRUCTURED_IMPORT_UPLOAD",
      message: "idempotencyKey is required."
    };
  }

  if (upload.idempotencyKey.length > PUBLIC_INPUT_LIMITS.idempotencyKeyChars) {
    return {
      ok: false,
      code: "INVALID_STRUCTURED_IMPORT_UPLOAD",
      message: "idempotencyKey exceeds the allowed limit."
    };
  }

  if (!upload.startDate || !upload.endDate || !isDateWindow(upload.startDate, upload.endDate)) {
    return {
      ok: false,
      code: PHASE3_ERROR_CODES.invalidDateWindow,
      message: "startDate and endDate must be valid YYYYMMDD dates."
    };
  }

  if (upload.labelKeys.length === 0) {
    return {
      ok: false,
      code: "UNLABELED_DOCUMENT",
      message: "Structured import must have labels."
    };
  }

  if (
    upload.labelKeys.length > PUBLIC_INPUT_LIMITS.labelsPerRequest ||
    upload.labelKeys.some((labelKey) => labelKey.length > PUBLIC_INPUT_LIMITS.labelKeyChars)
  ) {
    return {
      ok: false,
      code: "INVALID_STRUCTURED_IMPORT_UPLOAD",
      message: "Labels exceed the allowed limit."
    };
  }

  const fileType = fileTypeFromName(upload.file.fileName);

  if (fileType !== "xlsx" && fileType !== "csv") {
    return {
      ok: false,
      code: PHASE3_ERROR_CODES.unsupportedFileType,
      message: "Structured imports support XLSX or CSV only."
    };
  }

  return {
    ok: true,
    dataset: upload.dataset as StructuredDatasetName,
    fileType,
    startDate: upload.startDate,
    endDate: upload.endDate
  };
}

function fileTypeFromName(fileName: string): Phase3FileType | null {
  const extension = fileName.split(".").pop()?.toLowerCase();

  if (extension && PHASE3_FILE_TYPES.includes(extension as Phase3FileType)) {
    return extension as Phase3FileType;
  }

  return null;
}

function isDateWindow(startDate: string, endDate: string): boolean {
  const start = parseYyyyMmDd(startDate);
  const end = parseYyyyMmDd(endDate);

  return Boolean(start && end && start.getTime() <= end.getTime());
}

function parseYyyyMmDd(value: string): Date | null {
  if (!/^\d{8}$/.test(value)) {
    return null;
  }

  return parseDateParts(value.slice(0, 4), value.slice(4, 6), value.slice(6, 8));
}

function parseDateParts(yearValue: string, monthValue: string, dayValue: string): Date | null {
  const year = Number.parseInt(yearValue, 10);
  const month = Number.parseInt(monthValue, 10);
  const day = Number.parseInt(dayValue, 10);
  const date = new Date(Date.UTC(year, month - 1, day));

  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    return null;
  }

  return date;
}

export function canonicalStructuredImportFileName(input: {
  enterpriseName: string;
  dataset: StructuredDatasetName;
  startDate: string;
  endDate: string;
  fileType: "xlsx" | "csv";
}) {
  let enterpriseSegment =
    input.enterpriseName
      .trim()
      .split("")
      .map((character) => {
        if (/^[A-Za-z0-9-]$/.test(character)) {
          return character.toLowerCase();
        }

        return `u${character.codePointAt(0)?.toString(16) ?? "0"}`;
      })
      .join("_") || "enterprise";

  const suffix = `_${input.dataset}_${input.startDate}_${input.endDate}.${input.fileType}`;
  const maxEnterpriseSegmentChars = PUBLIC_INPUT_LIMITS.uploadFilenameChars - suffix.length;

  if (enterpriseSegment.length > maxEnterpriseSegmentChars) {
    const digest = createHash("sha256").update(input.enterpriseName).digest("hex").slice(0, 12);
    const hashSuffix = `_h${digest}`;
    enterpriseSegment = `${enterpriseSegment.slice(
      0,
      maxEnterpriseSegmentChars - hashSuffix.length
    )}${hashSuffix}`;
  }

  return `${enterpriseSegment}${suffix}`;
}

export function structuredImportFingerprint(input: {
  dataset: StructuredDatasetName;
  enterpriseName: string;
  startDate: string;
  endDate: string;
  labelKeys: string[];
  fileHash: string;
}): string {
  return createHash("sha256").update(JSON.stringify(input)).digest("hex");
}

export function hasStructuredImportCode(error: unknown): error is { code: string } {
  if (!error || typeof error !== "object" || !("code" in error)) {
    return false;
  }

  const code = (error as { code?: unknown }).code;

  return (
    code === "IDEMPOTENCY_KEY_CONFLICT" ||
    code === "ACTIVE_IMPORT_EXISTS" ||
    code === "IMPORT_IN_PROGRESS"
  );
}

export function structuredImportConflictMessage(code: string): string {
  if (code === "IDEMPOTENCY_KEY_CONFLICT") {
    return "Idempotency key was reused with different import content.";
  }

  if (code === "ACTIVE_IMPORT_EXISTS") {
    return "An active import already exists for this dataset date window.";
  }

  if (code === "IMPORT_IN_PROGRESS") {
    return "An import is already in progress for this dataset date window.";
  }

  return "Structured import conflict.";
}

function structuredImportResponse(input: {
  importBatch: StructuredImportBatchRecord;
  document: {
    documentId: string;
    fileType: "xlsx" | "csv";
    storageObjectKey: string;
    originalFileName: string;
    status: StructuredImportBatchRecord["sourceDocumentStatus"];
  };
}) {
  return {
    document: {
      documentId: input.document.documentId,
      documentKind: "structured",
      fileType: input.document.fileType,
      status: input.document.status,
      storageObjectKey: input.document.storageObjectKey,
      originalFileName: input.document.originalFileName
    },
    processing: {
      processingRunId: input.importBatch.processingRunId,
      status: input.importBatch.processingStatus
    },
    importBatch: importBatchResponse(input.importBatch)
  };
}

export function responseForReservedImport(importBatch: StructuredImportBatchRecord) {
  return structuredImportResponse({
    importBatch,
    document: {
      documentId: importBatch.sourceDocumentId,
      fileType: importBatch.sourceDocumentFileType,
      storageObjectKey: importBatch.storageObjectKey,
      originalFileName: importBatch.originalFileName,
      status: importBatch.sourceDocumentStatus
    }
  });
}

export function timingDurationMs(started: number): number {
  return Number((performance.now() - started).toFixed(3));
}

export function importBatchResponse(importBatch: StructuredImportBatchRecord) {
  return {
    importBatchId: importBatch.id,
    sourceDocumentId: importBatch.sourceDocumentId,
    dataset: importBatch.dataset,
    status: importBatch.status,
    startDate: importBatch.startDate,
    endDate: importBatch.endDate,
    sourceSheetSummary: importBatch.sourceSheetSummary,
    validationErrors: importBatch.validationErrors,
    validationErrorCount: importBatch.validationErrorCount,
    validationErrorsTruncated: importBatch.validationErrorsTruncated,
    totalRowCount: importBatch.totalRowCount,
    appliedRowCount: importBatch.appliedRowCount,
    queryableRowCount: importBatch.queryableRowCount
  };
}
