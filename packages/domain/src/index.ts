export const domainWorkspaceName = "@smedc/domain";
export * from "./cost-card-query.js";
export * from "./shelf-life.js";
export {
  FILE_UPLOAD_ADMIN_REQUIRED_CODE,
  FILE_UPLOAD_ADMIN_REQUIRED_MESSAGE,
  canEmployeeUploadFiles
} from "./file-upload.js";
export { PUBLIC_INPUT_LIMITS } from "./input-boundaries.js";
export {
  PHASE3_RUNTIME_LIMIT_DEFAULTS,
  parsePositiveSafeInteger,
  type PositiveSafeIntegerRule,
  type RuntimeLimitEnv
} from "./runtime-limits.js";
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
export { AUDIT_ACTIONS, type AuditActionName, type FileUploadSurface } from "./audit.js";
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
  RERANK_PROVIDER_NAMES,
  RETRIEVAL_CONFIG_STATUSES,
  buildRetrievalConfigSeed,
  loadActiveRetrievalConfig,
  toEvidenceSearchRetrievalMetadata,
  toIndexModelMetadata,
  type EvidenceSearchRetrievalMetadata,
  type EvidenceRelevanceCutoffReason,
  type EvidenceRelevancePolicy,
  type ExplicitRerankConfig,
  type IndexModelMetadata,
  type ModelProviderName,
  type RerankProviderName,
  type RetrievalConfigSeedInput,
  type RetrievalConfigStatusName,
  type RetrievalModelConfig
} from "./retrieval-config.js";
export {
  DEFAULT_LLM_EMBEDDING_MODEL,
  DEFAULT_LLM_MODEL,
  DEFAULT_LLM_PROVIDER,
  DEFAULT_DASHSCOPE_API_BASE_URL,
  DEFAULT_QDRANT_COLLECTION_EVIDENCE,
  DEFAULT_QDRANT_TIMEOUT_MS,
  DEFAULT_QDRANT_URL,
  DEFAULT_RETRIEVAL_CONFIG_VERSION,
  QDRANT_DENSE_DISTANCE,
  QDRANT_DENSE_VECTOR_NAME,
  QDRANT_DENSE_VECTOR_SIZE,
  QDRANT_BM25_MODEL,
  QDRANT_BM25_OPTIONS,
  QDRANT_BM25_VECTOR_NAME,
  OPENAI_COMPATIBLE_DENSE_VECTOR_SIZE,
  QDRANT_SPARSE_VECTOR_NAME,
  buildQdrantBm25Document,
  isQdrantBm25RetrievalVersion,
  parseRuntimeReadinessConfig,
  qdrantCollectionHasExpectedTenantIndex,
  qdrantCollectionMatchesExpectedSchema,
  qdrantEvidenceCollectionSchema,
  type ModelProviderRuntimeConfig,
  type QdrantEvidenceCollectionSchema,
  type QdrantBm25Document,
  type QdrantRuntimeConfig,
  type RuntimeEnv,
  type RuntimeReadinessConfig
} from "./retrieval-runtime.js";
export {
  COST_CARD_UPLOAD_REGISTRY,
  type CostCardUploadRegistry,
  STRUCTURED_DATASET_REGISTRIES,
  STRUCTURED_DATASETS,
  buildStructuredHeaderLookup,
  getStructuredRegistry,
  resolveStructuredHeaders,
  validateStructuredHeaders,
  type HeaderValidationError,
  type StructuredDatasetName,
  type StructuredDatasetRegistry,
  type StructuredFieldRegistryEntry,
  type StructuredFieldType,
  type StructuredPresentationProfile
} from "./structured-registry.js";
export {
  PARTITION_DATASETS,
  PARTITION_ERROR_CODES,
  PartitionContractError,
  isPartitionDataset,
  normalizeEnterpriseIdentity,
  partitionStoreIdentity,
  type PartitionDatasetName,
  type PartitionErrorCode,
  type PartitionManifest,
  type PartitionManifestEntry,
  type PartitionManifestRequest
} from "./structured-partitions.js";
export {
  STRUCTURED_QUERY_LIMITS,
  StructuredQueryValidationError,
  compileStructuredQuery,
  compilePublicStructuredQuery,
  createStructuredCursor,
  decodeStructuredCursor,
  type StructuredCompiledQuery,
  type StructuredQueryEmployeeScope,
  type StructuredQueryMode
} from "./structured-query.js";
export {
  compileStructuredCoverageQuery,
  type StructuredCompiledCoverageQuery,
  type StructuredCoverageSourceBase,
  type StructuredDatasetCoverage
} from "./structured-coverage.js";

export { getPublicStructuredRegistry } from "./structured-ledger-policy.js";

export { parsePartitionStoreNameContains } from "./partition-store-filter.js";

export * from "./partition-downloads.js";

export * from "./business-authorization.js";

export * from "./cost-cards.js";
