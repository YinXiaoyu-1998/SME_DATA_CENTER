export const AUDIT_ACTIONS = {
  documentUploaded: "document.uploaded",
  documentProcessingStarted: "document.processing_started",
  documentActivated: "document.activated",
  documentProcessingFailed: "document.processing_failed",
  documentQueried: "document.queried",
  documentDownloaded: "document.downloaded",
  documentArchived: "document.archived",
  documentLabelsAdded: "document.labels_added"
} as const;

export type AuditActionName = (typeof AUDIT_ACTIONS)[keyof typeof AUDIT_ACTIONS];
