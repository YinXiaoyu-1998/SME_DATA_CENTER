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
import { createStagingUploadDomainCleanupAdapter } from "./staging-upload-domain-cleanup-adapter.js";

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

export interface RunStagingUploadDomainCleanupCliInput {
  argv: string[];
  createAdapter(): Promise<StagingUploadDomainCleanupAdapter>;
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

export async function runStagingUploadDomainCleanupCli(
  input: RunStagingUploadDomainCleanupCliInput
): Promise<StagingUploadDomainCleanupPlan> {
  const options = parseStagingUploadDomainCleanupArgs(input.argv);
  validateStagingUploadDomainCleanupOptions(options);
  const adapter = await input.createAdapter();

  return await runStagingUploadDomainCleanup({
    argv: input.argv,
    adapter,
    log: input.log
  });
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

if (isMainModule()) {
  await runStagingUploadDomainCleanupCli({
    argv: process.argv.slice(2),
    createAdapter: async () => createStagingUploadDomainCleanupAdapter(process.env),
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
