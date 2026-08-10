import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  buildStagingUploadDomainCleanupPlan,
  parseStagingUploadDomainCleanupArgs,
  validateStagingUploadDomainCleanupOptions,
  type QdrantPointTarget,
  type StagingUploadDomainCleanupInventory,
  type StagingUploadDomainCleanupPlan,
  type StagingUploadDomainCleanupSafeLog
} from "./staging-upload-domain-cleanup-support.js";

type PostCleanupCounts = StagingUploadDomainCleanupSafeLog["counts"];

export interface StagingUploadDomainCleanupAdapter {
  collectInventory(): Promise<StagingUploadDomainCleanupInventory>;
  deleteQdrantPoints(targets: QdrantPointTarget[]): Promise<void>;
  deleteOssObjects(objectKeys: string[]): Promise<void>;
  deleteUploadAuditLogs(ids: string[]): Promise<void>;
  deleteDocumentLabels(documentIds: string[]): Promise<void>;
  deleteProcessingRuns(ids: string[]): Promise<void>;
  deleteDocumentChunks(ids: string[]): Promise<void>;
  deleteDocumentIndexes(ids: string[]): Promise<void>;
  deleteImportWindowClaims(ids: string[]): Promise<void>;
  deleteDishRows(ids: string[]): Promise<void>;
  deleteBusinessRows(ids: string[]): Promise<void>;
  deleteImportBatches(ids: string[]): Promise<void>;
  deleteDocuments(ids: string[]): Promise<void>;
  verifyPostCleanup(plan: StagingUploadDomainCleanupPlan): Promise<PostCleanupCounts>;
}

export interface RunStagingUploadDomainCleanupInput {
  argv: string[];
  adapter: StagingUploadDomainCleanupAdapter;
  log(value: unknown): void;
}

export async function runStagingUploadDomainCleanup(
  input: RunStagingUploadDomainCleanupInput
): Promise<StagingUploadDomainCleanupPlan> {
  const options = parseStagingUploadDomainCleanupArgs(input.argv);
  validateStagingUploadDomainCleanupOptions(options);
  const plan = buildStagingUploadDomainCleanupPlan({
    options,
    inventory: await input.adapter.collectInventory()
  });

  input.log(plan.safeLog);

  if (plan.mode === "dry-run") {
    return plan;
  }

  await input.adapter.deleteQdrantPoints(plan.qdrantPoints);
  await input.adapter.deleteOssObjects(plan.storageObjectKeys);
  await input.adapter.deleteUploadAuditLogs(plan.uploadAuditLogIds);
  await input.adapter.deleteDocumentLabels(plan.documentIds);
  await input.adapter.deleteProcessingRuns(plan.processingRunIds);
  await input.adapter.deleteDocumentChunks(plan.documentChunkIds);
  await input.adapter.deleteDocumentIndexes(plan.documentIndexIds);
  await input.adapter.deleteImportWindowClaims(plan.importWindowClaimIds);
  await input.adapter.deleteDishRows(plan.dishRowIds);
  await input.adapter.deleteBusinessRows(plan.businessRowIds);
  await input.adapter.deleteImportBatches(plan.importBatchIds);
  await input.adapter.deleteDocuments(plan.documentIds);

  const postCleanupCounts = await input.adapter.verifyPostCleanup(plan);
  assertZeroPostCleanupCounts(postCleanupCounts);
  input.log({ mode: plan.mode, postCleanupCounts });

  return plan;
}

function assertZeroPostCleanupCounts(counts: PostCleanupCounts): void {
  const remaining = Object.entries(counts).filter(([, count]) => count !== 0);
  if (remaining.length > 0) {
    throw new Error(
      `Staging upload-domain cleanup left records behind: ${remaining
        .map(([name, count]) => `${name}=${count}`)
        .join(", ")}.`
    );
  }
}

interface AdapterModule {
  createStagingUploadDomainCleanupAdapter?: () =>
    StagingUploadDomainCleanupAdapter | Promise<StagingUploadDomainCleanupAdapter>;
}

async function loadAdapter(
  modulePath: string | undefined
): Promise<StagingUploadDomainCleanupAdapter> {
  if (!modulePath) {
    throw new Error(
      "Set STAGING_UPLOAD_DOMAIN_CLEANUP_ADAPTER to a reviewed operator adapter module before running cleanup."
    );
  }

  const resolvedPath = path.resolve(process.cwd(), modulePath);
  const module = (await import(pathToFileURL(resolvedPath).href)) as AdapterModule;
  if (!module.createStagingUploadDomainCleanupAdapter) {
    throw new Error(
      "The staging upload-domain cleanup adapter must export createStagingUploadDomainCleanupAdapter."
    );
  }

  return await module.createStagingUploadDomainCleanupAdapter();
}

if (isMainModule()) {
  const adapter = await loadAdapter(process.env["STAGING_UPLOAD_DOMAIN_CLEANUP_ADAPTER"]);
  await runStagingUploadDomainCleanup({
    argv: process.argv.slice(2),
    adapter,
    log: (value) => console.log(JSON.stringify(value))
  });
}

function isMainModule(): boolean {
  const entrypoint = process.argv[1];
  if (!entrypoint) {
    return false;
  }

  return import.meta.url === pathToFileURL(entrypoint).href;
}
