import { createHash, randomBytes } from "node:crypto";
import { performance } from "node:perf_hooks";
import {
  PHASE3_ERROR_CODES,
  PHASE3_FILE_TYPES,
  PUBLIC_INPUT_LIMITS,
  STRUCTURED_DATASETS,
  getStructuredRegistry,
  type Phase3FileType,
  type StructuredDatasetName
} from "@smedc/domain";
import type { StructuredImportBatchRecord } from "../../structured-imports.js";

const MAX_CANONICAL_FILE_NAME_CHARS = 200;

export interface ParsedStructuredImportUpload {
  historicalSupplementReason?: string;
  file?: {
    fileName: string;
    contentType?: string;
    body: Buffer;
  };
  dataset?: string;
  enterpriseName?: string;
  startDate?: string | null;
  endDate?: string | null;
  snapshotDate?: string;
  idempotencyKey?: string;
  confidentialityLevel?: string;
  confidentialityLevelFieldCount: number;
}

export function createStructuredImportDocumentId(): string {
  return `doc_${randomBytes(12).toString("hex")}`;
}

export function validateStructuredImportMetadata(upload: ParsedStructuredImportUpload):
  | {
      ok: true;
      dataset: StructuredDatasetName;
      fileType: Extract<Phase3FileType, "xlsx" | "csv">;
      startDate: string | null;
      endDate: string | null;
      snapshotDate?: string;
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

  if (!upload.dataset || !(STRUCTURED_DATASETS as readonly string[]).includes(upload.dataset)) {
    return {
      ok: false,
      code: "INVALID_STRUCTURED_IMPORT_UPLOAD",
      message:
        "dataset must be dishes, business, vip, dish_catalog, delivery_ledger, or supplier_catalog."
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

  const metadataPolicy = getStructuredRegistry(
    upload.dataset as StructuredDatasetName
  ).metadataPolicy;
  let startDate: string | null;
  let endDate: string | null;
  let snapshotDate: string | undefined;

  if (metadataPolicy === "snapshot") {
    if (
      upload.startDate !== undefined ||
      upload.endDate !== undefined ||
      !upload.snapshotDate ||
      !isDateWindow(upload.snapshotDate, upload.snapshotDate)
    ) {
      return {
        ok: false,
        code: PHASE3_ERROR_CODES.invalidDateWindow,
        message: "dish_catalog requires snapshotDate and does not accept startDate or endDate."
      };
    }
    startDate = upload.snapshotDate;
    endDate = upload.snapshotDate;
    snapshotDate = upload.snapshotDate;
  } else if (metadataPolicy === "window") {
    if (
      upload.snapshotDate !== undefined ||
      !upload.startDate ||
      !upload.endDate ||
      !isDateWindow(upload.startDate, upload.endDate)
    ) {
      return {
        ok: false,
        code: PHASE3_ERROR_CODES.invalidDateWindow,
        message:
          "dishes, business, and vip require startDate and endDate and do not accept snapshotDate."
      };
    }
    startDate = upload.startDate;
    endDate = upload.endDate;
  } else {
    if (
      upload.startDate !== undefined ||
      upload.endDate !== undefined ||
      upload.snapshotDate !== undefined
    ) {
      return {
        ok: false,
        code: PHASE3_ERROR_CODES.invalidDateWindow,
        message: `${upload.dataset} does not accept startDate, endDate, or snapshotDate.`
      };
    }
    startDate = null;
    endDate = null;
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
    startDate,
    endDate,
    ...(snapshotDate ? { snapshotDate } : {})
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
  startDate?: string | null;
  endDate?: string | null;
  snapshotDate?: string;
  receiptId?: string;
  contentDigest?: string;
  fileHash?: string;
  fileType: "xlsx" | "csv";
}) {
  const enterpriseSegment =
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

  const registry = getStructuredRegistry(input.dataset);
  const metadataSegment =
    registry.metadataPolicy === "snapshot"
      ? (input.snapshotDate ?? "snapshot")
      : registry.metadataPolicy === "derived_receipt"
        ? `${canonicalValueSegment(input.receiptId ?? "receipt")}_${input.startDate ?? "undated"}`
        : registry.metadataPolicy === "none"
          ? (input.contentDigest ?? input.fileHash ?? "content")
          : `${input.startDate}_${input.endDate}`;
  const extension = `.${input.fileType}`;
  const fullStem = `${enterpriseSegment}_${input.dataset}_${metadataSegment}`;
  const fullName = `${fullStem}${extension}`;
  if (fullName.length <= MAX_CANONICAL_FILE_NAME_CHARS) return fullName;

  const hashSuffix = `_h${createHash("sha256").update(fullName).digest("hex").slice(0, 24)}`;
  const availableStemChars = MAX_CANONICAL_FILE_NAME_CHARS - extension.length - hashSuffix.length;
  return `${fullStem.slice(0, Math.max(0, availableStemChars))}${hashSuffix}${extension}`;
}

export function structuredImportFingerprint(input: {
  historicalSupplementReason?: string;
  dataset: StructuredDatasetName;
  enterpriseName: string;
  startDate?: string | null;
  endDate?: string | null;
  snapshotDate?: string;
  naturalKey?: string;
  confidentialityLevel: number;
  fileHash: string;
}): string {
  const registry = getStructuredRegistry(input.dataset);
  const semanticInput = {
    dataset: input.dataset,
    enterpriseName: input.enterpriseName,
    ...(input.historicalSupplementReason !== undefined
      ? { historicalSupplementReason: input.historicalSupplementReason }
      : {}),
    ...(registry.metadataPolicy === "snapshot"
      ? { snapshotDate: input.snapshotDate }
      : registry.metadataPolicy === "derived_receipt"
        ? { startDate: input.startDate, endDate: input.endDate, naturalKey: input.naturalKey }
        : registry.metadataPolicy === "window"
          ? { startDate: input.startDate, endDate: input.endDate }
          : {}),
    confidentialityLevel: input.confidentialityLevel,
    fileHash: input.fileHash
  };

  return createHash("sha256").update(JSON.stringify(semanticInput)).digest("hex");
}

export function hasStructuredImportCode(error: unknown): error is { code: string } {
  if (!error || typeof error !== "object" || !("code" in error)) {
    return false;
  }

  const code = (error as { code?: unknown }).code;

  return (
    code === "IDEMPOTENCY_KEY_CONFLICT" ||
    code === "ACTIVE_IMPORT_EXISTS" ||
    code === "IMPORT_IN_PROGRESS" ||
    code === "RECEIPT_ID_CONFLICT"
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

  if (code === "RECEIPT_ID_CONFLICT") {
    return "Receipt ID was reused with different import content.";
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
    importBatch: importBatchResponse(input.importBatch),
    ...(input.importBatch.dataset === "delivery_ledger" && input.importBatch.status === "applied"
      ? { affectedLedgerPartitions: input.importBatch.affectedLedgerPartitions ?? [] }
      : {})
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

export function structuredImportProgressResponse(importBatch: StructuredImportBatchRecord) {
  return {
    document: {
      documentId: importBatch.sourceDocumentId,
      documentKind: "structured",
      status: importBatch.sourceDocumentStatus
    },
    processing: {
      processingRunId: importBatch.processingRunId,
      status: importBatch.processingStatus
    },
    importBatch: {
      importBatchId: importBatch.id,
      sourceDocumentId: importBatch.sourceDocumentId,
      status: importBatch.status,
      hasValidationErrors: importBatch.validationErrorCount > 0
    }
  };
}

export function timingDurationMs(started: number): number {
  return Number((performance.now() - started).toFixed(3));
}

export function importBatchResponse(importBatch: StructuredImportBatchRecord) {
  const response = {
    importBatchId: importBatch.id,
    sourceDocumentId: importBatch.sourceDocumentId,
    dataset: importBatch.dataset,
    status: importBatch.status,
    sourceSheetSummary: importBatch.sourceSheetSummary,
    validationErrors: importBatch.validationErrors,
    validationErrorCount: importBatch.validationErrorCount,
    validationErrorsTruncated: importBatch.validationErrorsTruncated,
    totalRowCount: importBatch.totalRowCount,
    appliedRowCount: importBatch.appliedRowCount,
    queryableRowCount: importBatch.queryableRowCount,
    ...(importBatch.status === "applied" && importBatch.dataset === "delivery_ledger"
      ? { affectedLedgerPartitions: importBatch.affectedLedgerPartitions ?? [] }
      : {})
  };

  const metadataPolicy = getStructuredRegistry(importBatch.dataset).metadataPolicy;

  if (metadataPolicy === "snapshot") {
    return { ...response, snapshotDate: importBatch.startDate };
  }

  if (metadataPolicy === "derived_receipt") {
    return {
      ...response,
      startDate: importBatch.startDate,
      endDate: importBatch.endDate,
      ...(importBatch.naturalKey ? { naturalKey: importBatch.naturalKey } : {})
    };
  }

  return { ...response, startDate: importBatch.startDate, endDate: importBatch.endDate };
}

function canonicalValueSegment(value: string): string {
  return value
    .split("")
    .map((character) => {
      if (/^[A-Za-z0-9-]$/.test(character)) return character;
      return `u${character.codePointAt(0)?.toString(16) ?? "0"}`;
    })
    .join("");
}
