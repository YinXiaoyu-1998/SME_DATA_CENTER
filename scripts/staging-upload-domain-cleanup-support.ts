export const CLEANUP_CONFIRMATION = "delete-upload-domain";

export interface StagingUploadDomainCleanupOptions {
  dryRun: boolean;
  target: string | undefined;
  confirmation: string | undefined;
}

export interface QdrantPointTarget {
  collection: string;
  pointId: string;
}

export interface StagingUploadDomainCleanupInventory {
  documentIds: string[];
  processingRunIds: string[];
  documentChunkIds: string[];
  documentIndexIds: string[];
  importBatchIds: string[];
  importWindowClaimIds: string[];
  partitionImportJobIds: string[];
  structuredPartitionIds: string[];
  costCardIds: string[];
  costCardResourceIds: string[];
  storageGarbageIds: string[];
  quarantineCertificateIds: string[];
  vipRowIds: string[];
  dishCatalogRowIds: string[];
  uploadAuditLogIds: string[];
  storageObjectKeys: string[];
  qdrantPoints: QdrantPointTarget[];
}

export interface StagingUploadDomainCleanupPlan {
  mode: "dry-run" | "execute";
  deletionTargets: readonly string[];
  documentIds: string[];
  processingRunIds: string[];
  documentChunkIds: string[];
  documentIndexIds: string[];
  importBatchIds: string[];
  importWindowClaimIds: string[];
  partitionImportJobIds: string[];
  structuredPartitionIds: string[];
  costCardIds: string[];
  costCardResourceIds: string[];
  storageGarbageIds: string[];
  quarantineCertificateIds: string[];
  vipRowIds: string[];
  dishCatalogRowIds: string[];
  uploadAuditLogIds: string[];
  storageObjectKeys: string[];
  qdrantPoints: QdrantPointTarget[];
  safeLog: StagingUploadDomainCleanupSafeLog;
  preservedDomains: readonly string[];
}

export interface StagingUploadDomainCleanupSafeLog {
  mode: "dry-run" | "execute";
  documentIds: string[];
  processingRunIds: string[];
  importBatchIds: string[];
  qdrantPointIds: string[];
  counts: {
    documents: number;
    processingRuns: number;
    documentChunks: number;
    documentIndexes: number;
    importBatches: number;
    importWindowClaims: number;
    partitionImportJobs: number;
    structuredPartitions: number;
    costCards: number;
    costCardResources: number;
    storageGarbage: number;
    quarantineCertificates: number;
    vipRows: number;
    dishCatalogRows: number;
    uploadAuditLogs: number;
    storageObjects: number;
    qdrantPoints: number;
  };
}

export const PRESERVED_UPLOAD_DOMAIN_RECORDS = [
  "Organization",
  "Employee",
  "login identity and authorization records",
  "SkillEntry",
  "RetrievalConfig",
  "auth audit"
] as const;

export const UPLOAD_DOMAIN_DELETION_TARGETS = [
  "Qdrant points by exact collection/point identifier",
  "OSS objects by exact database-recorded key",
  "related upload audit events",
  "ProcessingRun",
  "DocumentChunk",
  "DocumentIndex",
  "ImportWindowClaim",
  "PartitionImportJob",
  "StructuredPartition",
  "CostCard BusinessResource (cascading scopes/dimensions)",
  "CostCard",
  "StorageGarbage",
  "QuarantineCertificate",
  "VipRow",
  "DishCatalogRow",
  "ImportBatch",
  "Document"
] as const;

export function parseStagingUploadDomainCleanupArgs(
  argv: string[]
): StagingUploadDomainCleanupOptions {
  let dryRun = true;
  let target: string | undefined;
  let confirmation: string | undefined;

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];

    if (argument === "--dry-run") {
      dryRun = true;
      continue;
    }
    if (argument === "--execute") {
      dryRun = false;
      continue;
    }
    if (argument === "--target" || argument === "--confirm") {
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) {
        throw new Error(`${argument} requires a value.`);
      }
      if (argument === "--target") {
        target = value;
      } else {
        confirmation = value;
      }
      index += 1;
      continue;
    }

    throw new Error(`Unknown staging upload-domain cleanup option: ${argument}`);
  }

  return { dryRun, target, confirmation };
}

export function buildStagingUploadDomainCleanupPlan(input: {
  options: StagingUploadDomainCleanupOptions;
  inventory: StagingUploadDomainCleanupInventory;
}): StagingUploadDomainCleanupPlan {
  validateStagingUploadDomainCleanupOptions(input.options);
  validateInventory(input.inventory);

  const mode = input.options.dryRun ? "dry-run" : "execute";
  const documentIds = sortIds(input.inventory.documentIds);
  const processingRunIds = sortIds(input.inventory.processingRunIds);
  const documentChunkIds = sortIds(input.inventory.documentChunkIds);
  const documentIndexIds = sortIds(input.inventory.documentIndexIds);
  const importBatchIds = sortIds(input.inventory.importBatchIds);
  const importWindowClaimIds = sortIds(input.inventory.importWindowClaimIds);
  const partitionImportJobIds = sortIds(input.inventory.partitionImportJobIds);
  const structuredPartitionIds = sortIds(input.inventory.structuredPartitionIds);
  const costCardIds = sortIds(input.inventory.costCardIds);
  const costCardResourceIds = sortIds(input.inventory.costCardResourceIds);
  const storageGarbageIds = sortIds(input.inventory.storageGarbageIds);
  const quarantineCertificateIds = sortIds(input.inventory.quarantineCertificateIds);
  const vipRowIds = sortIds(input.inventory.vipRowIds);
  const dishCatalogRowIds = sortIds(input.inventory.dishCatalogRowIds);
  const uploadAuditLogIds = sortIds(input.inventory.uploadAuditLogIds);
  const storageObjectKeys = [...input.inventory.storageObjectKeys].sort();
  const qdrantPoints = [...input.inventory.qdrantPoints].sort(compareQdrantPointTargets);

  return {
    mode,
    deletionTargets: UPLOAD_DOMAIN_DELETION_TARGETS,
    documentIds,
    processingRunIds,
    documentChunkIds,
    documentIndexIds,
    importBatchIds,
    importWindowClaimIds,
    partitionImportJobIds,
    structuredPartitionIds,
    costCardIds,
    costCardResourceIds,
    storageGarbageIds,
    quarantineCertificateIds,
    vipRowIds,
    dishCatalogRowIds,
    uploadAuditLogIds,
    storageObjectKeys,
    qdrantPoints,
    safeLog: {
      mode,
      documentIds,
      processingRunIds,
      importBatchIds,
      qdrantPointIds: qdrantPoints.map((point) => point.pointId),
      counts: {
        documents: documentIds.length,
        processingRuns: processingRunIds.length,
        documentChunks: documentChunkIds.length,
        documentIndexes: documentIndexIds.length,
        importBatches: importBatchIds.length,
        importWindowClaims: importWindowClaimIds.length,
        partitionImportJobs: partitionImportJobIds.length,
        structuredPartitions: structuredPartitionIds.length,
        costCards: costCardIds.length,
        costCardResources: costCardResourceIds.length,
        storageGarbage: storageGarbageIds.length,
        quarantineCertificates: quarantineCertificateIds.length,
        vipRows: vipRowIds.length,
        dishCatalogRows: dishCatalogRowIds.length,
        uploadAuditLogs: uploadAuditLogIds.length,
        storageObjects: storageObjectKeys.length,
        qdrantPoints: qdrantPoints.length
      }
    },
    preservedDomains: PRESERVED_UPLOAD_DOMAIN_RECORDS
  };
}

export function validateStagingUploadDomainCleanupOptions(
  options: StagingUploadDomainCleanupOptions
): void {
  if (options.target !== "staging") {
    throw new Error("Staging upload-domain cleanup requires --target staging.");
  }
  if (!options.dryRun && options.confirmation !== CLEANUP_CONFIRMATION) {
    throw new Error(
      `Destructive staging upload-domain cleanup requires --confirm ${CLEANUP_CONFIRMATION}.`
    );
  }
}

function validateInventory(inventory: StagingUploadDomainCleanupInventory): void {
  validateUniqueNonEmpty(inventory.documentIds, "document ID");
  validateUniqueNonEmpty(inventory.processingRunIds, "processing run ID");
  validateUniqueNonEmpty(inventory.documentChunkIds, "document chunk ID");
  validateUniqueNonEmpty(inventory.documentIndexIds, "document index ID");
  validateUniqueNonEmpty(inventory.importBatchIds, "import batch ID");
  validateUniqueNonEmpty(inventory.importWindowClaimIds, "import-window claim ID");
  validateUniqueNonEmpty(inventory.partitionImportJobIds, "partition import job ID");
  validateUniqueNonEmpty(inventory.structuredPartitionIds, "structured partition ID");
  validateUniqueNonEmpty(inventory.costCardIds, "cost card ID");
  validateUniqueNonEmpty(inventory.costCardResourceIds, "cost card resource ID");
  validateUniqueNonEmpty(inventory.storageGarbageIds, "storage garbage ID");
  validateUniqueNonEmpty(inventory.quarantineCertificateIds, "quarantine certificate ID");
  validateUniqueNonEmpty(inventory.vipRowIds, "VIP row ID");
  validateUniqueNonEmpty(inventory.dishCatalogRowIds, "dish catalog row ID");
  validateUniqueNonEmpty(inventory.uploadAuditLogIds, "upload audit log ID");
  validateUniqueNonEmpty(inventory.storageObjectKeys, "storage object key");

  validateNonEmpty(
    inventory.qdrantPoints.map((point) => point.collection),
    "Qdrant collection"
  );
  validateNonEmpty(
    inventory.qdrantPoints.map((point) => point.pointId),
    "Qdrant point ID"
  );
  const pointTargets = inventory.qdrantPoints.map(
    (point) => `${point.collection}:${point.pointId}`
  );
  validateUniqueNonEmpty(pointTargets, "Qdrant point target");
}

function validateUniqueNonEmpty(values: string[], label: string): void {
  const seen = new Set<string>();
  for (const value of values) {
    if (!value.trim()) {
      throw new Error(`Staging upload-domain cleanup has an empty ${label}.`);
    }
    if (seen.has(value)) {
      throw new Error(`Staging upload-domain cleanup has a duplicate ${label}.`);
    }
    seen.add(value);
  }
}

function validateNonEmpty(values: string[], label: string): void {
  for (const value of values) {
    if (!value.trim()) {
      throw new Error(`Staging upload-domain cleanup has an empty ${label}.`);
    }
  }
}

function sortIds(ids: string[]): string[] {
  return [...ids].sort();
}

function compareQdrantPointTargets(left: QdrantPointTarget, right: QdrantPointTarget): number {
  return `${left.collection}:${left.pointId}`.localeCompare(`${right.collection}:${right.pointId}`);
}
