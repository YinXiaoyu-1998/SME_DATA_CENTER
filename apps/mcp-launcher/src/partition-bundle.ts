import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { Transform, type Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { z } from "zod";
import { PARTITION_DATASETS } from "@smedc/domain";
import {
  abortable,
  apiJson,
  boundedInvocation,
  cleanupStaleExtractDirectories,
  downloadVerified,
  type PartitionTransferContext
} from "./partition-transfer.js";

// yauzl has no bundled types; keep the small runtime boundary explicit.
interface ZipEntry {
  fileName: string;
  uncompressedSize: number;
  compressedSize: number;
  compressionMethod: number;
  externalFileAttributes: number;
  generalPurposeBitFlag: number;
}
interface ZipReader {
  entryCount: number;
  on(event: "entry", listener: (entry: ZipEntry) => void): void;
  on(event: "error", listener: (error: Error) => void): void;
  on(event: "end", listener: () => void): void;
  readEntry(): void;
  openReadStream(entry: ZipEntry, callback: (error: Error | null, stream: Readable) => void): void;
  close(): void;
}
const yauzl = createRequire(import.meta.url)("yauzl") as {
  open(
    file: string,
    options: Record<string, boolean>,
    callback: (error: Error | null, reader: ZipReader) => void
  ): void;
};
const decimal = z.string().regex(/^(0|[1-9][0-9]*)$/);
const sha = z.string().regex(/^[a-f0-9]{64}$/);
const filterShape = {
  storeIds: z.array(z.string()).optional(),
  storeNameContains: z.array(z.string()).optional()
};
const scopeSchema = z
  .object({
    dataset: z.enum(PARTITION_DATASETS),
    enterpriseName: z.string(),
    startDate: z.iso.date(),
    endDate: z.iso.date(),
    ...filterShape
  })
  .strict();
const fileSchema = z
  .object({
    fileName: z.string(),
    businessDate: z.iso.date(),
    storeId: z.string().nullable(),
    storeName: z.string(),
    rowCount: decimal,
    byteSize: decimal,
    checksumSha256: sha
  })
  .strict();
const manifestSchema = z
  .object({
    version: z.literal(1),
    dataset: z.enum(PARTITION_DATASETS),
    enterpriseName: z.string(),
    startDate: z.iso.date(),
    endDate: z.iso.date(),
    filter: z.object(filterShape).strict(),
    partitionCount: z.number().int().min(0).max(2000),
    totalRowCount: decimal,
    files: z.array(fileSchema).max(2000)
  })
  .strict();
const metadataSchema = z
  .object({
    requestId: z.string(),
    status: z.literal("succeeded"),
    scope: scopeSchema,
    partitionCount: z.number().int().min(0).max(2000),
    totalRowCount: decimal,
    totalByteSize: decimal,
    expiresAt: z.iso.datetime({ offset: true }),
    archiveBounds: z
      .object({
        maxRawByteSize: decimal,
        maxManifestByteSize: z.literal(8388608),
        maxZipByteSize: decimal
      })
      .strict(),
    downloadUrl: z.url().optional(),
    byteSize: decimal.optional(),
    checksumSha256: sha.optional(),
    urlExpiresAt: z.iso.datetime({ offset: true }).optional()
  })
  .strict();
type Metadata = z.infer<typeof metadataSchema>;
type Manifest = z.infer<typeof manifestSchema>;

export function downloadPartitionBundle(input: {
  context: PartitionTransferContext;
  requestId: string;
}) {
  return boundedInvocation(input.context, async (context) => {
    const root = path.join(os.tmpdir(), "smedc-partition-extracts");
    await cleanupStaleExtractDirectories(root);
    await mkdir(root, { recursive: true });
    const directory = await mkdtemp(path.join(root, "extract-"));
    let stage: "manifest" | "transfer" | "validation" = "manifest";
    let stageStarted = Date.now();
    try {
      const metadata = metadataSchema.parse(
        await apiJson(
          context,
          `/v1/structured/partition-downloads/${encodeURIComponent(input.requestId)}/url`,
          { method: "POST" }
        )
      );
      validateMetadata(metadata, input.requestId);
      let manifest: Manifest;
      if (metadata.partitionCount === 0) {
        const { storeIds, storeNameContains, ...scope } = metadata.scope;
        manifest = {
          version: 1,
          ...scope,
          filter: {
            ...(storeIds ? { storeIds } : {}),
            ...(storeNameContains ? { storeNameContains } : {})
          },
          partitionCount: 0,
          totalRowCount: "0",
          files: []
        };
      } else {
        const archive = path.join(directory, "bundle.zip");
        stage = "transfer";
        stageStarted = Date.now();
        await downloadVerified(
          context,
          metadata.downloadUrl!,
          archive,
          Number(metadata.byteSize),
          metadata.checksumSha256!
        );
        stage = "validation";
        stageStarted = Date.now();
        manifest = await extractArchive(archive, directory, metadata, context.signal!);
        await rm(archive);
      }
      context.signal?.throwIfAborted();
      const localManifest = {
        ...manifest,
        totalRowCount: Number(manifest.totalRowCount),
        files: manifest.files.map((file) => ({
          ...file,
          byteSize: Number(file.byteSize),
          rowCount: Number(file.rowCount)
        }))
      };
      await writeFile(
        path.join(directory, "manifest.json"),
        `${JSON.stringify(localManifest, null, 2)}\n`,
        { encoding: "utf8", signal: context.signal }
      );
      context.diagnostic?.({
        stage: "validation",
        elapsedMs: Date.now() - stageStarted,
        bytes: Number(metadata.totalByteSize),
        files: manifest.files.length
      });
      return {
        localDirectory: directory,
        dataset: manifest.dataset,
        enterpriseName: manifest.enterpriseName,
        startDate: manifest.startDate,
        endDate: manifest.endDate,
        partitionCount: manifest.partitionCount,
        totalRowCount: localManifest.totalRowCount,
        files: manifest.files.map((file) => file.fileName)
      };
    } catch (error) {
      await rm(directory, { recursive: true, force: true });
      context.diagnostic?.({ stage, elapsedMs: Date.now() - stageStarted, failed: true });
      throw error;
    }
  });
}

function validateMetadata(metadata: Metadata, requestId: string) {
  const raw = BigInt(metadata.archiveBounds.maxRawByteSize);
  const zip = BigInt(metadata.archiveBounds.maxZipByteSize);
  if (
    metadata.requestId !== requestId ||
    Date.parse(metadata.expiresAt) <= Date.now() ||
    metadata.scope.startDate > metadata.scope.endDate ||
    raw > 1073741824n ||
    raw < 1n ||
    BigInt(metadata.totalByteSize) > raw ||
    zip > raw + 8388608n + BigInt(metadata.partitionCount + 1) * 512n + 4096n
  )
    throw new Error("Invalid partition download metadata bounds or scope.");
  const fields = [
    metadata.downloadUrl,
    metadata.byteSize,
    metadata.checksumSha256,
    metadata.urlExpiresAt
  ];
  if (metadata.partitionCount === 0) {
    if (
      fields.some((value) => value !== undefined) ||
      metadata.totalByteSize !== "0" ||
      metadata.totalRowCount !== "0"
    )
      throw new Error("Invalid empty partition download metadata.");
  } else if (
    fields.some((value) => value === undefined) ||
    BigInt(metadata.byteSize!) < 1n ||
    BigInt(metadata.byteSize!) > zip ||
    Date.parse(metadata.urlExpiresAt!) <= Date.now() ||
    Date.parse(metadata.urlExpiresAt!) > Date.parse(metadata.expiresAt)
  )
    throw new Error("Invalid partition ZIP metadata.");
}

async function extractArchive(
  archive: string,
  directory: string,
  metadata: Metadata,
  signal: AbortSignal
): Promise<Manifest> {
  const zip = await new Promise<ZipReader>((resolve, reject) =>
    yauzl.open(
      archive,
      { lazyEntries: true, autoClose: false, strictFileNames: true, validateEntrySizes: true },
      (error, reader) => (error ? reject(error) : resolve(reader))
    )
  );
  let activeStream: Readable | undefined;
  const stop = () => {
    activeStream?.destroy(new Error("Partition extraction cancelled."));
    zip.close();
  };
  signal.addEventListener("abort", stop, { once: true });
  try {
    signal.throwIfAborted();
    if (zip.entryCount !== metadata.partitionCount + 1 || zip.entryCount > 2001)
      throw new Error("ZIP file count does not match metadata.");
    const entries = await abortable(
      new Promise<Map<string, ZipEntry>>((resolve, reject) => {
        const entries = new Map<string, ZipEntry>();
        let bytes = 0n;
        zip.on("error", reject);
        zip.on("entry", (entry) => {
          try {
            const mode = (entry.externalFileAttributes >>> 16) & 0xf000;
            if (
              !/^(manifest\.json|(?:business|dishes|settled_orders)_[0-9]{8}_[a-f0-9]{64}\.csv)$/.test(
                entry.fileName
              ) ||
              entries.has(entry.fileName) ||
              (mode !== 0 && mode !== 0x8000) ||
              (entry.externalFileAttributes & 0x10) !== 0 ||
              entry.compressionMethod !== 0 ||
              (entry.generalPurposeBitFlag & 1) !== 0 ||
              entry.compressedSize !== entry.uncompressedSize
            )
              throw new Error("Unsafe or duplicate ZIP entry.");
            if (
              entry.fileName === "manifest.json" &&
              entry.uncompressedSize > metadata.archiveBounds.maxManifestByteSize
            )
              throw new Error("ZIP manifest exceeds bound.");
            if (entry.fileName !== "manifest.json") bytes += BigInt(entry.uncompressedSize);
            if (
              bytes > BigInt(metadata.archiveBounds.maxRawByteSize) ||
              bytes > BigInt(metadata.totalByteSize)
            )
              throw new Error("ZIP uncompressed bytes exceed bound.");
            entries.set(entry.fileName, entry);
            zip.readEntry();
          } catch (error) {
            reject(error);
          }
        });
        zip.on("end", () => resolve(entries));
        zip.readEntry();
      }),
      signal
    );
    const open = async (entry: ZipEntry) => {
      signal.throwIfAborted();
      activeStream = await new Promise<Readable>((resolve, reject) =>
        zip.openReadStream(entry, (error, stream) => (error ? reject(error) : resolve(stream)))
      );
      if (signal.aborted) {
        activeStream.destroy();
        signal.throwIfAborted();
      }
      return activeStream;
    };
    const manifestEntry = entries.get("manifest.json");
    if (!manifestEntry) throw new Error("ZIP manifest is missing.");
    const chunks: Buffer[] = [];
    let manifestBytes = 0;
    for await (const chunk of await open(manifestEntry)) {
      manifestBytes += (chunk as Buffer).length;
      if (manifestBytes > metadata.archiveBounds.maxManifestByteSize)
        throw new Error("ZIP manifest exceeds bound.");
      chunks.push(chunk as Buffer);
    }
    const manifest = manifestSchema.parse(JSON.parse(Buffer.concat(chunks).toString("utf8")));
    validateManifest(manifest, metadata, entries);
    for (const file of manifest.files) {
      const hash = createHash("sha256");
      let bytes = 0;
      const verify = new Transform({
        transform(chunk: Buffer, _encoding, callback) {
          bytes += chunk.length;
          if (BigInt(bytes) > BigInt(file.byteSize)) {
            callback(new Error("CSV byte size exceeds manifest."));
            return;
          }
          hash.update(chunk);
          callback(null, chunk);
        }
      });
      await pipeline(
        await open(entries.get(file.fileName)!),
        verify,
        createWriteStream(path.join(directory, file.fileName), { flags: "wx" }),
        { signal }
      );
      if (BigInt(bytes) !== BigInt(file.byteSize) || hash.digest("hex") !== file.checksumSha256)
        throw new Error("CSV checksum or size does not match manifest.");
    }
    return manifest;
  } finally {
    signal.removeEventListener("abort", stop);
    activeStream?.destroy();
    zip.close();
  }
}

function validateManifest(manifest: Manifest, metadata: Metadata, entries: Map<string, ZipEntry>) {
  const scope = metadata.scope;
  const same = (a?: string[], b?: string[]) =>
    JSON.stringify(a ? [...a].sort() : []) === JSON.stringify(b ? [...b].sort() : []);
  if (
    manifest.dataset !== scope.dataset ||
    manifest.enterpriseName !== scope.enterpriseName ||
    manifest.startDate !== scope.startDate ||
    manifest.endDate !== scope.endDate ||
    !same(manifest.filter.storeIds, scope.storeIds) ||
    !same(manifest.filter.storeNameContains, scope.storeNameContains) ||
    manifest.partitionCount !== metadata.partitionCount ||
    manifest.files.length !== metadata.partitionCount ||
    manifest.totalRowCount !== metadata.totalRowCount
  )
    throw new Error("ZIP manifest does not match authenticated scope.");
  let bytes = 0n;
  let rows = 0n;
  const seen = new Set<string>();
  for (const file of manifest.files) {
    const entry = entries.get(file.fileName);
    if (
      seen.has(file.fileName) ||
      !entry ||
      !new RegExp(
        `^${scope.dataset}_${file.businessDate.replaceAll("-", "")}_[a-f0-9]{64}\\.csv$`
      ).test(file.fileName) ||
      file.businessDate < scope.startDate ||
      file.businessDate > scope.endDate ||
      (scope.storeIds && !scope.storeIds.includes(file.storeId ?? "")) ||
      (scope.storeNameContains &&
        !scope.storeNameContains.some((name) => file.storeName.includes(name))) ||
      BigInt(file.rowCount) > BigInt(file.byteSize) ||
      BigInt(file.byteSize) !== BigInt(entry.uncompressedSize)
    )
      throw new Error("ZIP file does not match manifest scope.");
    seen.add(file.fileName);
    bytes += BigInt(file.byteSize);
    rows += BigInt(file.rowCount);
  }
  if (bytes !== BigInt(metadata.totalByteSize) || rows !== BigInt(metadata.totalRowCount))
    throw new Error("ZIP manifest totals do not match authenticated metadata.");
}
