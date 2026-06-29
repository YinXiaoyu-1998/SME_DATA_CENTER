export const AUDIT_ACTIONS = {
  documentUploaded: "document.uploaded"
} as const;

export type AuditActionName = (typeof AUDIT_ACTIONS)[keyof typeof AUDIT_ACTIONS];
