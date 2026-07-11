export const domainWorkspaceName = "@enterprise-hub/domain";
export {
  canEmployeeAccessDocument,
  type DocumentAccessInput,
  type DocumentPermissionTarget,
  type EmployeePermissionSubject
} from "./permissions.js";
export {
  AUTH_ERROR_CODES,
  type AuthenticatedEmployee,
  type AuthErrorCode,
  type EmployeeRoleName
} from "./auth.js";
export {
  DOCUMENT_STATUSES,
  DOCUMENT_TYPES,
  isDocumentType,
  type DocumentStatusName,
  type DocumentTypeName
} from "./documents.js";
export { AUDIT_ACTIONS, type AuditActionName } from "./audit.js";
export { SKILL_ENTRY_STATUSES, type SkillEntryStatusName } from "./skills.js";
export {
  EVIDENCE_BLOCK_TYPES,
  EvidenceParseError,
  type EvidenceBlockType,
  type EvidenceSourceLocation,
  type EvidenceWarning,
  type ParsedEvidenceBlock,
  type ParsedEvidenceDocument
} from "./evidence.js";
export {
  DOCUMENT_INDEX_STATUSES,
  DOCUMENT_KINDS,
  IMPORT_BATCH_STATUSES,
  PHASE3_ERROR_CODES,
  PHASE3_FILE_TYPES,
  PROCESSING_JOB_TYPES,
  isAllowedFileTypeForDocumentKind,
  isDocumentKind,
  isPhase3FileType,
  type DocumentIndexStatusName,
  type DocumentKindName,
  type ImportBatchStatusName,
  type Phase3ErrorCode,
  type Phase3FileType,
  type ProcessingJobTypeName
} from "./retrieval-contracts.js";
export {
  MODEL_PROVIDER_NAMES,
  RETRIEVAL_CONFIG_STATUSES,
  buildRetrievalConfigSeed,
  loadActiveRetrievalConfig,
  toEvidenceSearchRetrievalMetadata,
  toIndexModelMetadata,
  type EvidenceSearchRetrievalMetadata,
  type ExplicitRerankConfig,
  type IndexModelMetadata,
  type ModelProviderName,
  type RetrievalConfigSeedInput,
  type RetrievalConfigStatusName,
  type RetrievalModelConfig
} from "./retrieval-config.js";
export {
  DEFAULT_LLM_EMBEDDING_MODEL,
  DEFAULT_LLM_MODEL,
  DEFAULT_LLM_PROVIDER,
  DEFAULT_QDRANT_COLLECTION_EVIDENCE,
  DEFAULT_QDRANT_TIMEOUT_MS,
  DEFAULT_QDRANT_URL,
  DEFAULT_RETRIEVAL_CONFIG_VERSION,
  QDRANT_DENSE_DISTANCE,
  QDRANT_DENSE_VECTOR_NAME,
  QDRANT_DENSE_VECTOR_SIZE,
  QDRANT_SPARSE_VECTOR_NAME,
  parseRuntimeReadinessConfig,
  qdrantCollectionMatchesExpectedSchema,
  qdrantEvidenceCollectionSchema,
  type ModelProviderRuntimeConfig,
  type QdrantEvidenceCollectionSchema,
  type QdrantRuntimeConfig,
  type RuntimeEnv,
  type RuntimeReadinessConfig
} from "./retrieval-runtime.js";
export {
  STRUCTURED_DATASET_REGISTRIES,
  STRUCTURED_DATASETS,
  buildStructuredHeaderLookup,
  getStructuredRegistry,
  validateStructuredHeaders,
  type HeaderValidationError,
  type StructuredDatasetName,
  type StructuredDatasetRegistry,
  type StructuredFieldRegistryEntry,
  type StructuredFieldType
} from "./structured-registry.js";
