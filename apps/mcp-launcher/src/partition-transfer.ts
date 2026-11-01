import {
  PARTITION_DATASETS,
  normalizeEnterpriseIdentity,
  parsePartitionStoreNameContains,
  type PartitionDatasetName
} from "@smedc/domain";
import { z } from "zod";
import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { Readable, Transform } from "node:stream";
import { fileURLToPath } from "node:url";

const unsignedInteger = z.union([
  z.number().int().nonnegative(),
  z.string().regex(/^(0|[1-9][0-9]*)$/)
]);

// Shared CSV metadata shape; range responses may encode large counts as strings.
export const partitionFileMetadataSchema = z.object({
  businessDate: z.iso.date(),
  storeId: z.string().nullable(),
  storeName: z.string(),
  rowCount: unsignedInteger,
  byteSize: unsignedInteger,
  checksumSha256: z.string().regex(/^[a-f0-9]{64}$/)
});
const remoteManifestSchema = z.object({
  dataset: z.enum(PARTITION_DATASETS),
  enterpriseName: z.string(),
  startDate: z.iso.date(),
  endDate: z.iso.date(),
  partitionCount: z.number().int().nonnegative(),
  totalRowCount: unsignedInteger,
  partitions: z.array(partitionFileMetadataSchema.extend({ presignedDownloadUrl: z.url() }))
});

const UPLOAD_CONCURRENCY = 4;
export const DOWNLOAD_CONCURRENCY = 6;
const EXTRACT_MAX_AGE_MS = 24 * 60 * 60 * 1000;

export interface PartitionTransferContext {
  serviceUrl: string;
  accessToken: string;
  launcherVersion: string;
  fetchImplementation: typeof fetch;
  signal?: AbortSignal;
  refreshAccessToken?: () => Promise<string>;
  diagnostic?: (event: {
    stage: "manifest" | "transfer" | "validation";
    elapsedMs: number;
    bytes?: number;
    files?: number;
    retry?: number;
    failed?: boolean;
  }) => void;
}

export function uploadPartitionDataset(
  input: Parameters<typeof uploadPartitionDatasetInternal>[0]
): Promise<unknown> {
  // Upload duration remains unbounded while progressing; API/stall deadlines and
  // caller cancellation still bound each operation.
  return uploadPartitionDatasetInternal(input);
}

export function downloadPartitionDataset(
  input: Parameters<typeof downloadPartitionDatasetInternal>[0]
): Promise<unknown> {
  return boundedInvocation(input.context, (context) =>
    downloadPartitionDatasetInternal({ ...input, context })
  );
}

async function uploadPartitionDatasetInternal(input: {
  context: PartitionTransferContext;
  filePath: string;
  name: string;
  mediaType: string;
  dataset: PartitionDatasetName;
  enterpriseName: string;
  startDate: string;
  endDate: string;
  idempotencyKey: string;
  confidentialityLevel?: number;
  historicalSupplementReason?: string;
}): Promise<unknown> {
  const before = await stat(input.filePath);
  if (!before.isFile()) throw new Error("Local partition upload source is not a regular file.");
  const checksum = await hashFile(input.filePath, input.context.signal);
  const session = (await apiJson(input.context, "/v1/structured/partition-uploads", {
    method: "POST",
    body: {
      dataset: input.dataset,
      enterpriseName: input.enterpriseName,
      startDate: compactDateToIso(input.startDate),
      endDate: compactDateToIso(input.endDate),
      originalFileName: input.name,
      mediaType: input.mediaType,
      sourceByteSize: before.size,
      sourceChecksumSha256: checksum,
      idempotencyKey: input.idempotencyKey,
      confidentialityLevel: input.confidentialityLevel,
      historicalSupplementReason: input.historicalSupplementReason
    }
  })) as UploadSession;
  if (session.status !== "uploading") return session;
  try {
    const completed: Array<{ partNumber: number; etag: string }> = [];
    let page: UploadSession = session;
    while (true) {
      const results = await mapConcurrent(
        input.context,
        page.parts,
        UPLOAD_CONCURRENCY,
        async (part, context) => ({
          partNumber: part.partNumber,
          etag: await retryTransfer(context, () =>
            uploadPart(
              context,
              part.uploadUrl,
              input.filePath,
              part.partNumber,
              page.partSize,
              before.size
            )
          )
        })
      );
      completed.push(...results);
      if (page.nextAfterPartNumber === null) break;
      page = (await apiJson(
        input.context,
        `/v1/structured/partition-uploads/${encodeURIComponent(session.partitionImportJobId)}/parts?afterPartNumber=${page.nextAfterPartNumber}`,
        { method: "GET" }
      )) as UploadSession;
    }
    const after = await stat(input.filePath);
    if (after.size !== before.size || after.mtimeMs !== before.mtimeMs)
      throw new Error("Local upload file changed during transfer.");
    return await apiJson(
      input.context,
      `/v1/structured/partition-uploads/${encodeURIComponent(session.partitionImportJobId)}/complete`,
      { method: "POST", body: { parts: completed.sort((a, b) => a.partNumber - b.partNumber) } }
    );
  } catch (error) {
    const cleanupContext = { ...input.context };
    delete cleanupContext.signal;
    await apiJson(
      cleanupContext,
      `/v1/structured/partition-uploads/${encodeURIComponent(session.partitionImportJobId)}`,
      { method: "DELETE" }
    ).catch(() => undefined);
    throw error;
  }
}

async function downloadPartitionDatasetInternal(input: {
  context: PartitionTransferContext;
  dataset: PartitionDatasetName;
  enterpriseName: string;
  startDate: string;
  endDate: string;
  storeIds?: string[];
  storeNameContains?: string[];
}): Promise<unknown> {
  const root = path.join(os.tmpdir(), "smedc-partition-extracts");
  await cleanupStaleExtractDirectories(root);
  await mkdir(root, { recursive: true });
  const directory = await mkdtemp(path.join(root, "extract-"));
  try {
    let manifest = await requestManifest(input);
    let files;
    try {
      files = await downloadManifest(input.context, directory, manifest);
    } catch (error) {
      if (!(error instanceof PartitionDownloadError) || error.status !== 403) throw error;
      await rm(directory, { recursive: true, force: true });
      await mkdir(directory, { recursive: true });
      manifest = await requestManifest(input);
      files = await downloadManifest(input.context, directory, manifest);
    }
    input.context.signal?.throwIfAborted();
    await writeFile(
      path.join(directory, "manifest.json"),
      `${JSON.stringify({ dataset: manifest.dataset, enterpriseName: manifest.enterpriseName, startDate: manifest.startDate, endDate: manifest.endDate, partitionCount: manifest.partitionCount, totalRowCount: manifest.totalRowCount, files }, null, 2)}\n`,
      { encoding: "utf8", signal: input.context.signal }
    );
    input.context.signal?.throwIfAborted();
    return {
      localDirectory: directory,
      dataset: manifest.dataset,
      enterpriseName: manifest.enterpriseName,
      startDate: manifest.startDate,
      endDate: manifest.endDate,
      partitionCount: manifest.partitionCount,
      totalRowCount: manifest.totalRowCount,
      files: files.map((file) => file.fileName)
    };
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}

async function requestManifest(
  input: Parameters<typeof downloadPartitionDataset>[0]
): Promise<RemoteManifest> {
  const scope = {
    dataset: input.dataset,
    enterpriseName: normalizeEnterpriseIdentity(input.enterpriseName).enterpriseName,
    startDate: compactDateToIso(input.startDate),
    endDate: compactDateToIso(input.endDate),
    storeIds: input.storeIds?.length ? input.storeIds.map((id) => id.trim()) : undefined,
    storeNameContains: parsePartitionStoreNameContains(input.storeNameContains)
  };
  const response = await apiJson(input.context, "/v1/structured/partition-manifests", {
    method: "POST",
    body: scope
  });
  // apiJson already caps the full metadata body at 8 MiB; validate before any file transfer.
  const parsed = remoteManifestSchema.safeParse(response);
  if (!parsed.success) throw new Error("Invalid partition manifest metadata.");
  const manifest = parsed.data;
  if (
    manifest.dataset !== scope.dataset ||
    manifest.enterpriseName !== scope.enterpriseName ||
    manifest.startDate !== scope.startDate ||
    manifest.endDate !== scope.endDate ||
    manifest.startDate > manifest.endDate
  )
    throw new Error("Partition manifest does not match requested scope.");
  let rows = 0n;
  for (const partition of manifest.partitions) {
    if (!partitionFileMatchesScope(partition, scope))
      throw new Error("Partition manifest file does not match requested scope.");
    if (
      !Number.isSafeInteger(Number(partition.byteSize)) ||
      BigInt(partition.rowCount) > BigInt(partition.byteSize)
    )
      throw new Error("Invalid partition manifest file counts.");
    rows += BigInt(partition.rowCount);
  }
  if (
    manifest.partitionCount !== manifest.partitions.length ||
    BigInt(manifest.totalRowCount) !== rows
  )
    throw new Error("Partition manifest totals do not match its files.");
  return manifest;
}

export function partitionFileMatchesScope(
  file: { businessDate: string; storeId: string | null; storeName: string },
  scope: { startDate: string; endDate: string; storeIds?: string[]; storeNameContains?: string[] }
): boolean {
  return (
    file.businessDate >= scope.startDate &&
    file.businessDate <= scope.endDate &&
    (scope.storeIds === undefined || scope.storeIds.includes(file.storeId ?? "")) &&
    (scope.storeNameContains === undefined ||
      scope.storeNameContains.some((name) => file.storeName.includes(name)))
  );
}

async function downloadManifest(
  context: PartitionTransferContext,
  directory: string,
  manifest: RemoteManifest
) {
  return mapConcurrent(
    context,
    manifest.partitions,
    DOWNLOAD_CONCURRENCY,
    async (partition, context) => {
      const storeDigest = createHash("sha256")
        .update(`${partition.storeId ?? "name"}:${partition.storeName}`)
        .digest("hex")
        .slice(0, 16);
      const fileName = `${manifest.dataset}_${partition.businessDate.replaceAll("-", "")}_${storeDigest}.csv`;
      await downloadVerified(
        context,
        partition.presignedDownloadUrl,
        path.join(directory, fileName),
        Number(partition.byteSize),
        partition.checksumSha256
      );
      return {
        fileName,
        businessDate: partition.businessDate,
        storeId: partition.storeId,
        storeName: partition.storeName,
        rowCount: partition.rowCount,
        byteSize: partition.byteSize,
        checksumSha256: partition.checksumSha256
      };
    }
  );
}

export async function cleanupStaleExtractDirectories(
  root: string,
  now = Date.now()
): Promise<void> {
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return;
  }
  await Promise.all(
    entries
      .filter((entry) => entry.isDirectory() && entry.name.startsWith("extract-"))
      .map(async (entry) => {
        const candidate = path.join(root, entry.name);
        if (now - (await stat(candidate)).mtimeMs > EXTRACT_MAX_AGE_MS)
          await rm(candidate, { recursive: true, force: true });
      })
  );
}

export function cleanupDefaultStaleExtractDirectories(): Promise<void> {
  return cleanupStaleExtractDirectories(path.join(os.tmpdir(), "smedc-partition-extracts"));
}

interface UploadSession {
  partitionImportJobId: string;
  status: string;
  partSize: number;
  parts: Array<{ partNumber: number; uploadUrl: string }>;
  nextAfterPartNumber: number | null;
}
type RemoteManifest = z.infer<typeof remoteManifestSchema>;

export async function apiJson(
  context: PartitionTransferContext,
  pathname: string,
  input: { method: "GET" | "POST" | "DELETE"; body?: unknown }
): Promise<unknown> {
  const deadline = transferDeadline(context.signal, 30_000);
  const started = Date.now();
  try {
    for (let attempt = 0; ; attempt++) {
      const response = await fetchResponse(
        context,
        new URL(pathname, `${context.serviceUrl}/`),
        {
          method: input.method,
          signal: deadline.signal,
          headers: {
            authorization: `Bearer ${context.accessToken}`,
            "x-smedc-launcher-version": context.launcherVersion,
            ...(input.body ? { "content-type": "application/json" } : {})
          },
          ...(input.body ? { body: JSON.stringify(input.body) } : {})
        },
        deadline.signal
      );
      if (response.status === 401 && attempt === 0 && context.refreshAccessToken) {
        await response.body?.cancel();
        const token = await abortable(context.refreshAccessToken(), deadline.signal);
        if (token === context.accessToken)
          throw new Error("Access token refresh did not replace rejected credentials.");
        context.accessToken = token;
        continue;
      }
      const reader = response.body?.getReader();
      const chunks: Uint8Array[] = [];
      let bytes = 0;
      try {
        while (reader) {
          const chunk = await abortable(reader.read(), deadline.signal);
          if (chunk.done) break;
          bytes += chunk.value.byteLength;
          if (bytes > 8388608) throw new Error("SMEDC metadata exceeds its size limit.");
          chunks.push(chunk.value);
        }
      } finally {
        void reader?.cancel().catch(() => undefined);
      }
      const text = Buffer.concat(chunks).toString("utf8");
      const body = text ? (JSON.parse(text) as unknown) : {};
      if (!response.ok)
        throw Object.assign(new Error(`SMEDC request failed with ${response.status}.`), {
          code: String(response.status),
          body
        });
      context.diagnostic?.({ stage: "manifest", elapsedMs: Date.now() - started });
      return body;
    }
  } finally {
    deadline.dispose();
  }
}

async function uploadPart(
  context: PartitionTransferContext,
  url: string,
  filePath: string,
  partNumber: number,
  partSize: number,
  totalSize: number
): Promise<string> {
  const start = (partNumber - 1) * partSize;
  const end = Math.min(totalSize, start + partSize) - 1;
  const idle = transferDeadline(context.signal, 30_000);
  const source = createReadStream(filePath, { start, end });
  const progressSource = (async function* () {
    for await (const chunk of source) {
      idle.reset();
      yield chunk;
    }
  })();
  try {
    if (url.startsWith("file://")) {
      await pipeline(progressSource, createWriteStream(fileURLToPath(url)), {
        signal: idle.signal
      });
      return `local-${partNumber}`;
    }
    const response = await fetchResponse(
      context,
      url,
      {
        method: "PUT",
        signal: idle.signal,
        headers: { "content-length": String(end - start + 1) },
        body: progressSource as unknown as BodyInit,
        duplex: "half"
      } as RequestInit & { duplex: "half" },
      idle.signal
    );
    await response.body?.cancel();
    if (!response.ok) throw new PartitionDownloadError(response.status);
    const etag = response.headers.get("etag");
    if (!etag) throw new Error(`Partition upload part ${partNumber} did not return an ETag.`);
    return etag;
  } finally {
    source.destroy();
    idle.dispose();
  }
}

export async function downloadVerified(
  context: PartitionTransferContext,
  url: string,
  target: string,
  expectedSize: number,
  expectedHash: string
): Promise<void> {
  if (
    !Number.isSafeInteger(expectedSize) ||
    expectedSize < 0 ||
    !/^[a-f0-9]{64}$/.test(expectedHash)
  )
    throw new Error("Invalid download size or checksum.");
  await retryTransfer(context, async () => {
    const started = Date.now();
    const idle = transferDeadline(context.signal, 30_000);
    let source: Readable | undefined;
    try {
      if (url.startsWith("file://")) source = createReadStream(fileURLToPath(url));
      else {
        const response = await fetchResponse(context, url, { signal: idle.signal }, idle.signal);
        if (!response.ok || !response.body) {
          await response.body?.cancel();
          throw new PartitionDownloadError(response.status);
        }
        source = Readable.fromWeb(response.body as never);
      }
      let size = 0;
      const hash = createHash("sha256");
      const verify = new Transform({
        transform(chunk: Buffer, _encoding, callback) {
          idle.reset();
          size += chunk.length;
          if (size > expectedSize) {
            callback(new Error("Downloaded partition size exceeded its manifest."));
            return;
          }
          hash.update(chunk);
          callback(null, chunk);
        }
      });
      await pipeline(source, verify, createWriteStream(target), { signal: idle.signal });
      if (size !== expectedSize || hash.digest("hex") !== expectedHash)
        throw new Error("Downloaded partition size or checksum did not match its manifest.");
      context.diagnostic?.({
        stage: "transfer",
        elapsedMs: Date.now() - started,
        bytes: size,
        files: 1
      });
    } catch (error) {
      if (idle.signal.aborted) throw idle.signal.reason;
      throw error;
    } finally {
      source?.destroy();
      idle.dispose();
    }
  });
}

export class PartitionDownloadError extends Error {
  constructor(readonly status: number) {
    super(`Partition download failed with ${status}.`);
    this.name = "PartitionDownloadError";
  }
}

async function hashFile(filePath: string, signal?: AbortSignal): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(filePath, { signal })) hash.update(chunk);
  return hash.digest("hex");
}

export async function mapConcurrent<T, R>(
  context: PartitionTransferContext,
  items: T[],
  concurrency: number,
  worker: (item: T, context: PartitionTransferContext) => Promise<R>
): Promise<R[]> {
  const controller = new AbortController();
  const signal = context.signal
    ? AbortSignal.any([context.signal, controller.signal])
    : controller.signal;
  const results = new Array<R>(items.length);
  let cursor = 0;
  let failure: unknown;
  await Promise.allSettled(
    Array.from({ length: Math.min(concurrency, items.length) }, async () => {
      while (cursor < items.length) {
        signal.throwIfAborted();
        const index = cursor++;
        try {
          results[index] = await worker(items[index]!, { ...context, signal });
        } catch (error) {
          if (!controller.signal.aborted) {
            failure = error;
            controller.abort(error);
          }
          throw error;
        }
      }
    })
  );
  if (failure) throw failure;
  signal.throwIfAborted();
  return results;
}

async function retryTransfer<T>(
  context: PartitionTransferContext,
  operation: () => Promise<T>
): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    context.signal?.throwIfAborted();
    try {
      return await operation();
    } catch (error) {
      context.signal?.throwIfAborted();
      const transient =
        error instanceof PartitionDownloadError
          ? error.status >= 500 && error.status <= 599
          : error instanceof TypeError ||
            (error instanceof Error &&
              "code" in error &&
              ["ECONNRESET", "ETIMEDOUT", "EPIPE"].includes(String(error.code)));
      if (attempt >= 2 || !transient) throw error;
      context.diagnostic?.({ stage: "transfer", elapsedMs: 0, retry: attempt + 1 });
      await new Promise<void>((resolve, reject) => {
        const aborted = () => {
          clearTimeout(timer);
          reject(context.signal?.reason);
        };
        const timer = setTimeout(
          () => {
            context.signal?.removeEventListener("abort", aborted);
            resolve();
          },
          250 * (attempt + 1)
        );
        context.signal?.addEventListener("abort", aborted, { once: true });
      });
    }
  }
}

export async function boundedInvocation<T>(
  context: PartitionTransferContext,
  operation: (context: PartitionTransferContext) => Promise<T>
): Promise<T> {
  const deadline = transferDeadline(context.signal, 240_000);
  try {
    return await operation({ ...context, signal: deadline.signal });
  } finally {
    deadline.dispose();
  }
}

export function transferDeadline(parent: AbortSignal | undefined, milliseconds: number) {
  const controller = new AbortController();
  const signal = parent ? AbortSignal.any([parent, controller.signal]) : controller.signal;
  let timer: ReturnType<typeof setTimeout>;
  const reset = () => {
    clearTimeout(timer);
    timer = setTimeout(
      () =>
        controller.abort(new DOMException("Partition transfer deadline exceeded.", "TimeoutError")),
      milliseconds
    );
    timer.unref?.();
  };
  reset();
  return { signal, reset, dispose: () => clearTimeout(timer) };
}

async function fetchResponse(
  context: PartitionTransferContext,
  url: string | URL,
  init: RequestInit,
  signal: AbortSignal
): Promise<Response> {
  signal.throwIfAborted();
  const pending = context.fetchImplementation(url, init);
  try {
    return await abortable(pending, signal);
  } catch (error) {
    // Cancellation can win just as fetch resolves, before a stream owns the body.
    // Dispose even a late response so that no transfer continues after cleanup.
    void pending.then(
      (response) => {
        void response.body?.cancel().catch(() => undefined);
      },
      () => undefined
    );
    throw error;
  }
}

export function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  return new Promise<T>((resolve, reject) => {
    const aborted = () => reject(signal.reason);
    signal.addEventListener("abort", aborted, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", aborted));
  });
}

function compactDateToIso(value: string): string {
  return `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}`;
}
