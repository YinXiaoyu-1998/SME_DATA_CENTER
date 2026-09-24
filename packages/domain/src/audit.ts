export const AUDIT_ACTIONS = {
  fileUploadDenied: "file_upload.denied",
  documentUploaded: "document.uploaded",
  documentProcessingStarted: "document.processing_started",
  documentActivated: "document.activated",
  documentProcessingFailed: "document.processing_failed",
  documentQueried: "document.queried",
  documentDownloaded: "document.downloaded",
  documentArchived: "document.archived",
  structuredImportStarted: "structured_import.started",
  structuredImportApplied: "structured_import.applied"
} as const;

export type AuditActionName = (typeof AUDIT_ACTIONS)[keyof typeof AUDIT_ACTIONS];

export type FileUploadSurface =
  "evidence_document" | "structured_dataset" | "quarantine_certificate";
