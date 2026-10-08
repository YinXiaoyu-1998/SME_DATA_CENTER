import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";

const UPLOAD_CONCURRENCY = 4;
const DOWNLOAD_CONCURRENCY = 6;
const EXTRACT_MAX_AGE_MS = 24 * 60 * 60 * 1000;

export interface PartitionTransferContext {
  serviceUrl: string;
  accessToken: string;
  launcherVersion: string;
  fetchImplementation: typeof fetch;
}

export async function uploadPartitionDataset(input: {
  context: PartitionTransferContext;
  filePath: string;
  name: string;
  mediaType: string;
  dataset: "business" | "dishes";
  enterpriseName: string;
  startDate: string;
  endDate: string;
  idempotencyKey: string;
  confidentialityLevel?: number;
}): Promise<unknown> {
  const before = await stat(input.filePath);
  if (!before.isFile()) throw new Error("Local partition upload source is not a regular file.");
  const checksum = await hashFile(input.filePath);
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
      confidentialityLevel: input.confidentialityLevel
    }
  })) as UploadSession;
  if (session.status !== "uploading") return session;
  try {
    const completed: Array<{ partNumber: number; etag: string }> = [];
    let page: UploadSession = session;
    while (true) {
      const results = await mapConcurrent(page.parts, UPLOAD_CONCURRENCY, async (part) => ({
        partNumber: part.partNumber,
        etag: await retryTransfer(() =>
          uploadPart(
            input.context.fetchImplementation,
            part.uploadUrl,
            input.filePath,
            part.partNumber,
            page.partSize,
            before.size
          )
        )
      }));
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
    await apiJson(
      input.context,
      `/v1/structured/partition-uploads/${encodeURIComponent(session.partitionImportJobId)}`,
      { method: "DELETE" }
    ).catch(() => undefined);
    throw error;
  }
}

export async function downloadPartitionDataset(input: {
  context: PartitionTransferContext;
  dataset: "business" | "dishes";
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
      files = await downloadManifest(input.context.fetchImplementation, directory, manifest);
    } catch (error) {
      if (!(error instanceof PartitionDownloadError) || error.status !== 403) throw error;
      await rm(directory, { recursive: true, force: true });
      await mkdir(directory, { recursive: true });
      manifest = await requestManifest(input);
      files = await downloadManifest(input.context.fetchImplementation, directory, manifest);
    }
    await writeFile(
      path.join(directory, "manifest.json"),
      `${JSON.stringify({ dataset: manifest.dataset, enterpriseName: manifest.enterpriseName, startDate: manifest.startDate, endDate: manifest.endDate, partitionCount: manifest.partitionCount, totalRowCount: manifest.totalRowCount, files }, null, 2)}\n`,
      "utf8"
    );
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
  return (await apiJson(input.context, "/v1/structured/partition-manifests", {
    method: "POST",
    body: {
      dataset: input.dataset,
      enterpriseName: input.enterpriseName,
      startDate: compactDateToIso(input.startDate),
      endDate: compactDateToIso(input.endDate),
      storeIds: input.storeIds,
      storeNameContains: input.storeNameContains
    }
  })) as RemoteManifest;
}

async function downloadManifest(
  fetchImplementation: typeof fetch,
  directory: string,
  manifest: RemoteManifest
) {
  return mapConcurrent(manifest.partitions, DOWNLOAD_CONCURRENCY, async (partition) => {
    const storeDigest = createHash("sha256")
      .update(`${partition.storeId ?? "name"}:${partition.storeName}`)
      .digest("hex")
      .slice(0, 16);
    const fileName = `${manifest.dataset}_${partition.businessDate.replaceAll("-", "")}_${storeDigest}.csv`;
    await downloadVerified(
      fetchImplementation,
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
  });
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
interface RemoteManifest {
  dataset: "business" | "dishes";
  enterpriseName: string;
  startDate: string;
  endDate: string;
  partitionCount: number;
  totalRowCount: number | string;
  partitions: Array<{
    businessDate: string;
    storeId: string | null;
    storeName: string;
    rowCount: number | string;
    byteSize: number | string;
    checksumSha256: string;
    presignedDownloadUrl: string;
  }>;
}

async function apiJson(
  context: PartitionTransferContext,
  pathname: string,
  input: { method: "GET" | "POST" | "DELETE"; body?: unknown }
): Promise<unknown> {
  const response = await context.fetchImplementation(new URL(pathname, `${context.serviceUrl}/`), {
    method: input.method,
    headers: {
      authorization: `Bearer ${context.accessToken}`,
      "x-smedc-launcher-version": context.launcherVersion,
      ...(input.body ? { "content-type": "application/json" } : {})
    },
    ...(input.body ? { body: JSON.stringify(input.body) } : {})
  });
  const text = await response.text();
  const body = text ? (JSON.parse(text) as unknown) : {};
  if (!response.ok)
    throw Object.assign(new Error(`SMEDC request failed with ${response.status}.`), {
      code: String(response.status),
      body
    });
  return body;
}

async function uploadPart(
  fetchImplementation: typeof fetch,
  url: string,
  filePath: string,
  partNumber: number,
  partSize: number,
  totalSize: number
): Promise<string> {
  const start = (partNumber - 1) * partSize;
  const end = Math.min(totalSize, start + partSize) - 1;
  if (url.startsWith("file://")) {
    await pipeline(
      createReadStream(filePath, { start, end }),
      createWriteStream(fileURLToPath(url))
    );
    return `local-${partNumber}`;
  }
  const response = await fetchImplementation(url, {
    method: "PUT",
    headers: { "content-length": String(end - start + 1) },
    body: createReadStream(filePath, { start, end }) as unknown as BodyInit,
    duplex: "half"
  } as RequestInit & { duplex: "half" });
  if (!response.ok)
    throw new Error(`Partition upload part ${partNumber} failed with ${response.status}.`);
  const etag = response.headers.get("etag");
  if (!etag) throw new Error(`Partition upload part ${partNumber} did not return an ETag.`);
  return etag;
}

async function downloadVerified(
  fetchImplementation: typeof fetch,
  url: string,
  target: string,
  expectedSize: number,
  expectedHash: string
): Promise<void> {
  if (url.startsWith("file://"))
    await pipeline(createReadStream(fileURLToPath(url)), createWriteStream(target));
  else {
    const response = await fetchImplementation(url);
    if (!response.ok || !response.body) throw new PartitionDownloadError(response.status);
    await pipeline(Readable.fromWeb(response.body as never), createWriteStream(target));
  }
  const actual = await stat(target);
  if (actual.size !== expectedSize || (await hashFile(target)) !== expectedHash)
    throw new Error("Downloaded partition size or checksum did not match its manifest.");
}

class PartitionDownloadError extends Error {
  constructor(readonly status: number) {
    super(`Partition download failed with ${status}.`);
    this.name = "PartitionDownloadError";
  }
}

async function hashFile(filePath: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(filePath)) hash.update(chunk);
  return hash.digest("hex");
}

async function mapConcurrent<T, R>(
  items: T[],
  concurrency: number,
  worker: (item: T) => Promise<R>
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;
  const workers = await Promise.allSettled(
    Array.from({ length: Math.min(concurrency, items.length) }, async () => {
      while (cursor < items.length) {
        const index = cursor++;
        results[index] = await worker(items[index]!);
      }
    })
  );
  const failed = workers.find(
    (result): result is PromiseRejectedResult => result.status === "rejected"
  );
  if (failed) throw failed.reason;
  return results;
}

async function retryTransfer<T>(operation: () => Promise<T>): Promise<T> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      if (attempt < 3) await new Promise((resolve) => setTimeout(resolve, attempt * 250));
    }
  }
  throw lastError;
}

function compactDateToIso(value: string): string {
  return `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}`;
}
