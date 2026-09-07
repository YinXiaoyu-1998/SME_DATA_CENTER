export const DOCUMENT_KINDS = ["evidence", "structured", "quarantine_certificate"] as const;

export type DocumentKindName = (typeof DOCUMENT_KINDS)[number];

export const PHASE3_FILE_TYPES = [
  "md",
  "txt",
  "docx",
  "xlsx",
  "csv",
  "jpg",
  "jpeg",
  "png"
] as const;

export type Phase3FileType = (typeof PHASE3_FILE_TYPES)[number];

const FILE_TYPES_BY_DOCUMENT_KIND: Record<DocumentKindName, readonly Phase3FileType[]> = {
  evidence: ["md", "txt", "docx"],
  structured: ["xlsx", "csv"],
  quarantine_certificate: ["jpg", "jpeg", "png"]
};

export const PROCESSING_JOB_TYPES = ["evidence_document_index", "structured_import"] as const;

export type ProcessingJobTypeName = (typeof PROCESSING_JOB_TYPES)[number];

export const DOCUMENT_INDEX_STATUSES = [
  "pending",
  "indexing",
  "ready",
  "failed",
  "superseded"
] as const;

export type DocumentIndexStatusName = (typeof DOCUMENT_INDEX_STATUSES)[number];

export const IMPORT_BATCH_STATUSES = [
  "pending",
  "validating",
  "applying",
  "applied",
  "failed",
  "rejected",
  "archived"
] as const;

export type ImportBatchStatusName = (typeof IMPORT_BATCH_STATUSES)[number];

export const PHASE3_ERROR_CODES = {
  unsupportedFileType: "UNSUPPORTED_FILE_TYPE",
  invalidDocumentKindFileType: "INVALID_DOCUMENT_KIND_FILE_TYPE",
  validationFailed: "VALIDATION_FAILED",
  invalidQuery: "INVALID_QUERY",
  invalidField: "INVALID_FIELD",
  unsupportedOperator: "UNSUPPORTED_OPERATOR",
  unsupportedCapability: "UNSUPPORTED_CAPABILITY",
  typeMismatch: "TYPE_MISMATCH",
  invalidAggregation: "INVALID_AGGREGATION",
  invalidDateWindow: "INVALID_DATE_WINDOW",
  limitExceeded: "LIMIT_EXCEEDED",
  queryTooExpensive: "QUERY_TOO_EXPENSIVE",
  invalidCursor: "INVALID_CURSOR",
  cursorExpired: "CURSOR_EXPIRED",
  datasetForbidden: "DATASET_FORBIDDEN",
  activeImportExists: "ACTIVE_IMPORT_EXISTS",
  importInProgress: "IMPORT_IN_PROGRESS",
  idempotencyKeyConflict: "IDEMPOTENCY_KEY_CONFLICT",
  receiptIdConflict: "RECEIPT_ID_CONFLICT",
  processingFailed: "PROCESSING_FAILED",
  temporarilyUnavailable: "TEMPORARILY_UNAVAILABLE",
  internalError: "INTERNAL_ERROR"
} as const;

export type Phase3ErrorCode = (typeof PHASE3_ERROR_CODES)[keyof typeof PHASE3_ERROR_CODES];

export function isDocumentKind(value: string): value is DocumentKindName {
  return DOCUMENT_KINDS.includes(value as DocumentKindName);
}

export function isPhase3FileType(value: string): value is Phase3FileType {
  return PHASE3_FILE_TYPES.includes(value as Phase3FileType);
}

export function isAllowedFileTypeForDocumentKind(
  documentKind: DocumentKindName,
  fileType: string
): fileType is Phase3FileType {
  return FILE_TYPES_BY_DOCUMENT_KIND[documentKind].includes(fileType as Phase3FileType);
}
