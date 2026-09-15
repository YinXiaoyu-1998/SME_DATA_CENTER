import { randomBytes } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, mkdtemp, readdir, rm, stat, statfs } from "node:fs/promises";
import path from "node:path";
import { PARTITION_ERROR_CODES, type PartitionDatasetName } from "@enterprise-hub/domain";
import {
  createPrismaStructuredPartitionRepository,
  type PartitionCandidate,
  type StructuredPartitionRepository
} from "@enterprise-hub/db";
import { createPartitionObjectKey, type StorageAdapter } from "@enterprise-hub/storage";
import {
  exportStructuredPartitions,
  StructuredPartitionExportError,
  type StructuredPartitionLimits
} from "@enterprise-hub/structured-ingestion";
import type { ClaimedProcessingRun } from "./worker.js";
import type { WorkerRuntimeLimits } from "./config/runtime-limits.js";

export interface PartitionImportRuntimeLimits extends StructuredPartitionLimits {
  workDirectory: string;
  minFreeBytes: number;
  jobRetentionDays: number;
}

export function partitionImportLimitsFromRuntime(
  runtime: WorkerRuntimeLimits
): PartitionImportRuntimeLimits {
  return {
    workDirectory: runtime.partitionImportWorkDirectory,
    minFreeBytes: runtime.partitionImportMinFreeBytes,
    jobRetentionDays: runtime.partitionImportJobRetentionDays,
    maxSourceBytes: runtime.partitionImportMaxSourceBytes,
    maxRows: runtime.partitionImportMaxRows,
    maxPartitions: runtime.partitionImportMaxPartitions,
    maxCanonicalBytes: runtime.partitionImportMaxCanonicalBytes,
    maxOpenFiles: runtime.partitionImportMaxOpenFiles,
    maxStructuredCellChars: 32_000,
    maxXlsxSheets: 100,
    maxXlsxUncompressedBytes: 12_884_901_888,
    maxXlsxZipEntries: 100_000,
    maxXlsxCompressionRatio: 1_000
  };
}

export function createPartitionImporter(input: {
  limits: PartitionImportRuntimeLimits;
  repository?: StructuredPartitionRepository;
}) {
  const repository = input.repository ?? createPrismaStructuredPartitionRepository();
  return {
    async process({ run, storage }: { run: ClaimedProcessingRun; storage: StorageAdapter }) {
      const job = run.partitionImport;
      if (!job) throw new Error("Partition import job is missing from the claimed run.");
      const transfer = requirePartitionStorage(storage);
      await mkdir(input.limits.workDirectory, { recursive: true });
      const free = await statfs(input.limits.workDirectory);
      if (BigInt(free.bavail) * BigInt(free.bsize) < BigInt(input.limits.minFreeBytes)) {
        throw new PartitionWorkerError(
          PARTITION_ERROR_CODES.limitExceeded,
          "Worker temporary disk has insufficient free space.",
          true
        );
      }
      const workDirectory = await mkdtemp(path.join(input.limits.workDirectory, `${job.jobId}-`));
      const extension =
        path.extname(job.originalFileName).toLowerCase() === ".csv" ? ".csv" : ".xlsx";
      const sourcePath = path.join(workDirectory, `source${extension}`);
      const uploadedKeys: string[] = [];
      let published = false;
      let candidateCleanupIsSafe = true;
      try {
        const source = await transfer.downloadObjectToFile(job.temporaryObjectKey, sourcePath);
        if (
          source.size !== Number(job.sourceByteSize) ||
          source.hash !== job.sourceChecksumSha256
        ) {
          throw new StructuredPartitionExportError(
            PARTITION_ERROR_CODES.sourceChecksumMismatch,
            "Downloaded source checksum did not match its upload session."
          );
        }
        let exported;
        try {
          exported = await exportStructuredPartitions({
            dataset: job.dataset,
            sourcePath,
            outputDirectory: workDirectory,
            limits: {
              maxSourceBytes: input.limits.maxSourceBytes,
              maxRows: input.limits.maxRows,
              maxPartitions: input.limits.maxPartitions,
              maxCanonicalBytes: input.limits.maxCanonicalBytes,
              maxOpenFiles: input.limits.maxOpenFiles,
              maxStructuredCellChars: input.limits.maxStructuredCellChars,
              maxXlsxSheets: input.limits.maxXlsxSheets,
              maxXlsxUncompressedBytes: input.limits.maxXlsxUncompressedBytes,
              maxXlsxZipEntries: input.limits.maxXlsxZipEntries,
              maxXlsxCompressionRatio: input.limits.maxXlsxCompressionRatio
            }
          });
        } catch (error) {
          if (!(error instanceof StructuredPartitionExportError)) throw error;
          await repository.finishJob({
            orgId: run.orgId,
            jobId: job.jobId,
            status: "rejected",
            errorCode: error.code,
            errorSummary: error.message
          });
          await deleteOrEnqueue(
            storage,
            repository,
            job.temporaryObjectKey,
            "partition_source_terminal"
          );
          return "rejected" as const;
        }

        const outsideDeclaredRange = exported.partitions.find(
          (partition) =>
            partition.businessDate < job.sourceStartDate ||
            partition.businessDate > job.sourceEndDate
        );
        if (outsideDeclaredRange) {
          const error = new StructuredPartitionExportError(
            PARTITION_ERROR_CODES.sourceDateOutOfRange,
            `Source contains business date ${outsideDeclaredRange.businessDate} outside the declared range.`
          );
          await repository.finishJob({
            orgId: run.orgId,
            jobId: job.jobId,
            status: "rejected",
            errorCode: error.code,
            errorSummary: error.message
          });
          await deleteOrEnqueue(
            storage,
            repository,
            job.temporaryObjectKey,
            "partition_source_terminal"
          );
          return "rejected" as const;
        }

        const candidates: PartitionCandidate[] = [];
        for (const partition of exported.partitions) {
          const id = `part_${randomBytes(12).toString("hex")}`;
          const objectKey = createPartitionObjectKey({
            orgId: run.orgId,
            jobId: job.jobId,
            partitionId: id
          });
          await transfer.putObjectAtKey({
            key: objectKey,
            body: createReadStream(partition.filePath),
            contentLength: Number(partition.byteSize),
            checksumSha256: partition.checksumSha256,
            contentType: "text/csv; charset=utf-8"
          });
          const verified = await storage.statObject(objectKey);
          if (
            verified.size !== Number(partition.byteSize) ||
            verified.hash !== partition.checksumSha256
          )
            throw new Error("Uploaded canonical partition could not be verified.");
          uploadedKeys.push(objectKey);
          candidates.push({
            id,
            orgId: run.orgId,
            enterpriseKey: job.enterpriseKey,
            enterpriseName: job.enterpriseName,
            dataset: job.dataset as PartitionDatasetName,
            storeKey: partition.storeKey,
            merchantId: partition.merchantId,
            storeName: partition.storeName,
            businessDate: partition.businessDate,
            objectKey,
            rowCount: partition.rowCount,
            byteSize: partition.byteSize,
            checksumSha256: partition.checksumSha256,
            confidentialityLevel: job.confidentialityLevel
          });
        }
        candidateCleanupIsSafe = false;
        try {
          await repository.publishSourceAtomically({
            orgId: run.orgId,
            jobId: job.jobId,
            totalRowCount: exported.totalRowCount,
            candidates
          });
        } catch (error) {
          const authoritative = await repository.findJobForStatus(run.orgId, job.jobId);
          if (authoritative?.status === "published") {
            published = true;
            await deleteOrEnqueue(
              storage,
              repository,
              job.temporaryObjectKey,
              "partition_source_terminal"
            );
            return "published" as const;
          }
          candidateCleanupIsSafe = authoritative?.status === "processing";
          throw error;
        }
        published = true;
        await deleteOrEnqueue(
          storage,
          repository,
          job.temporaryObjectKey,
          "partition_source_terminal"
        );
        return "published" as const;
      } catch (error) {
        if (!published && candidateCleanupIsSafe) {
          await Promise.all(
            uploadedKeys.map((key) =>
              deleteOrEnqueue(storage, repository, key, "partition_candidate_abandoned")
            )
          );
        }
        if (error instanceof PartitionWorkerError) throw error;
        throw new PartitionWorkerError(
          "PARTITION_IMPORT_FAILED",
          error instanceof Error ? error.message : "Partition import failed.",
          true
        );
      } finally {
        await rm(workDirectory, { recursive: true, force: true });
      }
    },
    async cleanupTerminal({
      run,
      storage
    }: {
      run: ClaimedProcessingRun;
      storage: StorageAdapter;
    }) {
      const objectKey = run.partitionImport?.temporaryObjectKey;
      if (objectKey)
        await deleteOrEnqueue(storage, repository, objectKey, "partition_source_terminal");
    },
    async maintain({ storage, now = new Date() }: { storage: StorageAdapter; now?: Date }) {
      await cleanupStaleWorkDirectories(input.limits.workDirectory, now);
      await cleanupExpiredUploads(storage, repository, now);
      const garbage = await repository.listDueGarbage(now, 100);
      for (const item of garbage) {
        try {
          await storage.deleteObject(item.objectKey);
          await repository.deleteGarbage(item.id);
        } catch (error) {
          await repository.postponeGarbage(
            item.id,
            error instanceof Error ? error.name : "STORAGE_DELETE_FAILED",
            new Date(now.getTime() + 5 * 60 * 1000)
          );
        }
      }
      await repository.deleteTerminalJobs(
        new Date(now.getTime() - input.limits.jobRetentionDays * 24 * 60 * 60 * 1000),
        100
      );
    },
    async disconnect() {
      await repository.disconnect?.();
    }
  };
}

async function cleanupExpiredUploads(
  storage: StorageAdapter,
  repository: StructuredPartitionRepository,
  now: Date
): Promise<void> {
  const uploads = await repository.listExpiredUploads(now, 100);
  for (const upload of uploads) {
    if (!storage.abortMultipartUpload) continue;
    let cleaned = false;
    try {
      await storage.abortMultipartUpload({
        key: upload.temporaryObjectKey,
        uploadId: upload.multipartUploadId
      });
      cleaned = true;
    } catch (abortError) {
      try {
        await storage.statObject(upload.temporaryObjectKey);
        await storage.deleteObject(upload.temporaryObjectKey);
        cleaned = true;
      } catch (objectError) {
        cleaned = isMissingMultipartUpload(abortError) && isMissingStorageObject(objectError);
      }
    }
    if (cleaned) {
      await repository.finishJob({
        orgId: upload.orgId,
        jobId: upload.id,
        status: "expired",
        errorCode: PARTITION_ERROR_CODES.uploadExpired,
        errorSummary: "Upload session expired before completion."
      });
    }
  }
}

function isMissingStorageObject(error: unknown): boolean {
  return errorProperty(error, "code") === "ENOENT" || errorHttpStatus(error) === 404;
}

function isMissingMultipartUpload(error: unknown): boolean {
  return (
    ["ENOENT", "NoSuchUpload"].includes(errorProperty(error, "code")) ||
    ["NoSuchUpload", "NotFound"].includes(errorProperty(error, "name")) ||
    errorHttpStatus(error) === 404
  );
}

function errorProperty(error: unknown, property: "code" | "name"): string {
  return error && typeof error === "object" && property in error
    ? String((error as Record<string, unknown>)[property])
    : "";
}

function errorHttpStatus(error: unknown): number | undefined {
  if (!error || typeof error !== "object" || !("$metadata" in error)) return undefined;
  const metadata = (error as { $metadata?: unknown }).$metadata;
  return metadata && typeof metadata === "object" && "httpStatusCode" in metadata
    ? Number((metadata as { httpStatusCode?: unknown }).httpStatusCode)
    : undefined;
}

async function cleanupStaleWorkDirectories(root: string, now: Date): Promise<void> {
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return;
  }
  await Promise.all(
    entries
      .filter((entry) => entry.isDirectory() && entry.name.startsWith("pjob_"))
      .map(async (entry) => {
        const directory = path.join(root, entry.name);
        if (now.getTime() - (await stat(directory)).mtimeMs > 24 * 60 * 60 * 1000) {
          await rm(directory, { recursive: true, force: true });
        }
      })
  );
}

export class PartitionWorkerError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly retryable: boolean
  ) {
    super(message);
    this.name = "PartitionWorkerError";
  }
}

function requirePartitionStorage(
  storage: StorageAdapter
): Required<Pick<StorageAdapter, "downloadObjectToFile" | "putObjectAtKey">> & StorageAdapter {
  if (!storage.downloadObjectToFile || !storage.putObjectAtKey)
    throw new Error("Configured storage does not support partition transfers.");
  return storage as Required<Pick<StorageAdapter, "downloadObjectToFile" | "putObjectAtKey">> &
    StorageAdapter;
}

async function deleteOrEnqueue(
  storage: StorageAdapter,
  repository: StructuredPartitionRepository,
  objectKey: string,
  reason: string
): Promise<void> {
  try {
    await storage.deleteObject(objectKey);
    await repository.markObjectDeleted(objectKey);
  } catch {
    await repository.enqueueGarbage(objectKey, reason);
  }
}
