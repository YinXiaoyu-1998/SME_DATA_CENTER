import type { PartitionDatasetName } from "@smedc/domain";
import { createHash, randomUUID } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import JSZip from "jszip";
import type { PartitionDownloadManifest } from "@smedc/domain";
import {
  assertPartitionDownloadSize,
  type PartitionDownloadEntry,
  type PartitionDownloadLease,
  type PartitionDownloadRepository
} from "@smedc/db";
import type { StorageAdapter } from "@smedc/storage";

export interface PartitionDownloadBuildLimits {
  scratchRoot?: string;
  deadlineMs?: number;
}
/** Full store-key digest; same-name stores retain distinct identities. Duplicate paths fail closed. */
export function partitionDownloadFileName(
  dataset: PartitionDatasetName,
  entry: Pick<PartitionDownloadEntry, "storeKey" | "businessDate">
): string {
  const digest = createHash("sha256").update(entry.storeKey, "utf8").digest("hex");
  return `${dataset}_${entry.businessDate.replaceAll("-", "")}_${digest}.csv`;
}
export class PartitionDownloadBuildFailed extends Error {}
export class PartitionDownloadRetryableError extends Error {
  readonly code = "PARTITION_DOWNLOAD_FAILED";
  readonly retryable = true;
  constructor() {
    super("PARTITION_DOWNLOAD_FAILED");
  }
}
const deterministicCodes = new Set([
  "PARTITION_DOWNLOAD_STALE",
  "PARTITION_DOWNLOAD_FORBIDDEN",
  "PARTITION_DOWNLOAD_LIMIT_EXCEEDED",
  "PARTITION_DOWNLOAD_SOURCE_INVALID"
]);
export async function buildPartitionDownload(input: {
  requestId: string;
  lease: PartitionDownloadLease;
  repository: PartitionDownloadRepository;
  storage: StorageAdapter;
  limits?: PartitionDownloadBuildLimits;
  signal?: AbortSignal;
}): Promise<"succeeded" | "superseded"> {
  if (input.requestId !== input.lease.requestId) throw new Error("PARTITION_DOWNLOAD_FAILED");
  const controller = new AbortController();
  const abort = () => controller.abort(new Error("PARTITION_DOWNLOAD_FAILED"));
  input.signal?.addEventListener("abort", abort, { once: true });
  if (input.signal?.aborted) abort();
  const deadline = setTimeout(abort, input.limits?.deadlineMs ?? 600_000);
  deadline.unref();
  const streams = new Set<Readable>();
  const stopStreams = () => {
    for (const stream of streams) stream.destroy(controller.signal.reason as Error);
  };
  controller.signal.addEventListener("abort", stopStreams);
  // Storage adapters do not accept a signal. Fence late writes through registered GC candidates.
  async function bounded<T>(work: () => Promise<T>): Promise<T> {
    controller.signal.throwIfAborted();
    return new Promise<T>((resolve, reject) => {
      const cancel = () => reject(controller.signal.reason);
      controller.signal.addEventListener("abort", cancel, { once: true });
      work()
        .then(resolve, reject)
        .finally(() => controller.signal.removeEventListener("abort", cancel));
    });
  }
  let directory: string | undefined;
  try {
    const current = await bounded(() => input.repository.markRunning(input.lease));
    if (!current) return "superseded";
    // Empty scopes are finalized at preparation and never create a processing run.
    if (!current.manifest.length) return "succeeded";
    assertPartitionDownloadSize(
      current.manifest.length,
      current.manifest.reduce((n, entry) => n + BigInt(entry.byteSize), 0n),
      current.limits
    );
    const manifest: PartitionDownloadManifest = {
      version: 1,
      dataset: current.scope.dataset,
      enterpriseName: current.scope.enterpriseName,
      startDate: current.scope.startDate,
      endDate: current.scope.endDate,
      filter: {
        ...(current.scope.storeIds ? { storeIds: current.scope.storeIds } : {}),
        ...(current.scope.storeNameContains
          ? { storeNameContains: current.scope.storeNameContains }
          : {})
      },
      partitionCount: current.manifest.length,
      totalRowCount: current.request.totalRowCount,
      files: current.manifest.map((entry) => ({
        fileName: partitionDownloadFileName(current.scope.dataset, entry),
        businessDate: entry.businessDate,
        storeId: entry.merchantId,
        storeName: entry.storeName,
        rowCount: entry.rowCount,
        byteSize: entry.byteSize,
        checksumSha256: entry.checksumSha256
      }))
    };
    if (new Set(manifest.files.map((file) => file.fileName)).size !== manifest.files.length)
      throw new Error("PARTITION_DOWNLOAD_SOURCE_INVALID");
    const metadata = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, "utf8");
    if (metadata.length > 8 * 1024 * 1024) throw new Error("PARTITION_DOWNLOAD_LIMIT_EXCEEDED");
    const root = input.limits?.scratchRoot ?? tmpdir();
    await mkdir(root, { recursive: true });
    directory = await mkdtemp(join(root, "smedc-partition-zip-"));
    const outputFile = join(directory, "bundle.zip");
    const zip = new JSZip();
    const options = { binary: true, createFolders: false, date: new Date("2000-01-01T00:00:00Z") };
    zip.file("manifest.json", metadata, options);
    let totalBytes = 0;
    let completed = 0;
    for (const [index, entry] of current.manifest.entries()) {
      const stream = Readable.from(
        (async function* () {
          const source = await bounded(async () => {
            const source = (await input.storage.getObjectStream(entry.objectKey)) as Readable;
            // Even an adapter resolving after cancellation must release its response stream.
            if (controller.signal.aborted) {
              source.destroy();
              controller.signal.throwIfAborted();
            }
            source.on("error", () => undefined);
            streams.add(source);
            return source;
          });
          let bytes = 0;
          const hash = createHash("sha256");
          try {
            for await (const chunk of source) {
              controller.signal.throwIfAborted();
              const buffer = Buffer.from(chunk as Uint8Array);
              bytes += buffer.length;
              totalBytes += buffer.length;
              if (bytes > Number(entry.byteSize))
                throw new Error("PARTITION_DOWNLOAD_SOURCE_INVALID");
              if (totalBytes > current.limits.partitionDownloadMaxBytes)
                throw new Error("PARTITION_DOWNLOAD_LIMIT_EXCEEDED");
              hash.update(buffer);
              yield buffer;
            }
            if (bytes !== Number(entry.byteSize) || hash.digest("hex") !== entry.checksumSha256)
              throw new Error("PARTITION_DOWNLOAD_SOURCE_INVALID");
            completed++;
            if (
              !(await bounded(() =>
                input.repository.recordProgress(
                  input.lease,
                  Math.max(current.request.completedPartitionCount, completed)
                )
              ))
            )
              throw new Error("PARTITION_DOWNLOAD_LEASE_LOST");
          } finally {
            source.destroy();
            streams.delete(source);
          }
        })()
      );
      stream.on("error", () => undefined);
      streams.add(stream);
      zip.file(manifest.files[index]!.fileName, stream, options);
    }
    let zipBytes = 0;
    const zipHash = createHash("sha256");
    // STORE has no compression expansion; allowance covers local/central headers and metadata.
    const maxZipBytes =
      current.limits.partitionDownloadMaxBytes +
      metadata.length +
      (current.manifest.length + 1) * 512 +
      4096;
    await pipeline(
      zip.generateNodeStream({ streamFiles: true, compression: "STORE" }),
      new Transform({
        transform(chunk: Buffer, _encoding, callback) {
          zipBytes += chunk.length;
          if (zipBytes > maxZipBytes)
            return callback(new Error("PARTITION_DOWNLOAD_LIMIT_EXCEEDED"));
          zipHash.update(chunk);
          callback(null, chunk);
        }
      }),
      createWriteStream(outputFile, { mode: 0o600 }),
      { signal: controller.signal }
    );
    const checksumSha256 = zipHash.digest("hex");
    const objectKey = `partition-downloads/${input.lease.orgId}/${input.requestId}/${input.lease.attemptNumber}/${randomUUID()}.zip`;
    if (!input.storage.putObjectAtKey) throw new Error("PARTITION_DOWNLOAD_FAILED");
    if (!(await bounded(() => input.repository.registerCandidate(input.lease, objectKey))))
      return "superseded";
    const upload = createReadStream(outputFile);
    upload.on("error", () => undefined);
    streams.add(upload);
    await bounded(() =>
      input.storage.putObjectAtKey!({
        key: objectKey,
        body: upload,
        contentLength: zipBytes,
        checksumSha256,
        contentType: "application/zip"
      })
    );
    controller.signal.throwIfAborted();
    return (await bounded(() =>
      input.repository.publish(input.lease, {
        objectKey,
        byteSize: BigInt(zipBytes),
        checksumSha256,
        expiresAt: current.request.expiresAt
      })
    ))
      ? "succeeded"
      : "superseded";
  } catch (cause) {
    if (cause instanceof Error && cause.message === "PARTITION_DOWNLOAD_LEASE_LOST")
      return "superseded";
    // Unknown I/O/storage/deadline failures belong to the fenced worker retry
    // lifecycle. Only deterministic validation and authorization failures finalize here.
    if (!(cause instanceof Error && deterministicCodes.has(cause.message)))
      throw new PartitionDownloadRetryableError();
    const code = cause.message;
    if (!(await input.repository.fail(input.lease, code))) return "superseded";
    // Repository already finalized the run; the runtime maps this safe error to a failed result.
    throw new PartitionDownloadBuildFailed(code);
  } finally {
    clearTimeout(deadline);
    input.signal?.removeEventListener("abort", abort);
    controller.signal.removeEventListener("abort", stopStreams);
    for (const stream of streams) stream.destroy();
    if (directory) await rm(directory, { recursive: true, force: true });
  }
}
