export const AUDIT_ACTIONS = {
  documentUploaded: "document.uploaded",
  documentProcessingStarted: "document.processing_started",
  documentActivated: "document.activated",
  documentProcessingFailed: "document.processing_failed"
} as const;

export type AuditActionName = (typeof AUDIT_ACTIONS)[keyof typeof AUDIT_ACTIONS];
