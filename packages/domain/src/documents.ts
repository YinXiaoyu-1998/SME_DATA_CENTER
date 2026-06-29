export const DOCUMENT_STATUSES = [
  "uploading",
  "pending_processing",
  "processing",
  "active",
  "processing_failed",
  "archived"
] as const;

export type DocumentStatusName = (typeof DOCUMENT_STATUSES)[number];

export const DOCUMENT_TYPES = [
  "raw_material",
  "structured_dataset",
  "analysis_artifact",
  "business_event",
  "management_knowledge"
] as const;

export type DocumentTypeName = (typeof DOCUMENT_TYPES)[number];

export function isDocumentType(value: string): value is DocumentTypeName {
  return DOCUMENT_TYPES.includes(value as DocumentTypeName);
}
