import { createWriteStream } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { type Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import {
  LEDGER_BUNDLE_LIMITS,
  LEDGER_BUNDLE_MAX_ZIP_BYTES,
  decodeLedgerStoreFileSegment,
  ledgerPdfNameForSegment
} from "@smedc/domain";
import { z } from "zod";
import {
  TransferVerificationError,
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

const LEDGER_EXTRACTS_ROOT = "smedc-ledger-extracts";

const signedLinkSchema = z
  .object({
    requestId: z.string().min(1).max(128),
    downloadUrl: z.url(),
    expiresAt: z.iso.datetime({ offset: true }),
    byteSize: z.number().int(),
    checksumSha256: z.string().regex(/^[a-f0-9]{64}$/)
  })
  .strict();

export class LedgerPdfTransferError extends Error {
  constructor(
    readonly code:
      | "LEDGER_PDF_BUNDLE_URL_INVALID"
      | "LEDGER_PDF_BUNDLE_VERIFY_FAILED"
      | "LEDGER_PDF_BUNDLE_DOWNLOAD_TIMEOUT"
      | "LEDGER_PDF_BUNDLE_LIMIT_EXCEEDED",
    message: string
  ) {
    super(message);
    this.name = "LedgerPdfTransferError";
  }
}

export interface LedgerBundleFile {
  storeName: string;
  purchaseDate: string;
  fileName: string;
  relativePath: string;
  byteSize: number;
}

export interface LedgerBundleDownload {
  localDirectory: string;
  requestId: string;
  fileCount: number;
  files: string[];
}

/**
 * Fetch a prepared ledger PDF ZIP through the launcher, verify the archive against
 * the signed link metadata, extract the daily PDFs, and return a managed directory.
 * The signed URL is consumed here and never returned to the caller.
 */
export function downloadLedgerPdfBundle(input: {
  context: PartitionTransferContext;
  requestId: string;
}): Promise<LedgerBundleDownload> {
  return boundedInvocation(
    input.context,
    (context) => downloadLedgerPdfBundleInternal({ context, requestId: input.requestId }),
    LEDGER_BUNDLE_LIMITS.deadlineMs
  );
}

async function downloadLedgerPdfBundleInternal(input: {
  context: PartitionTransferContext;
  requestId: string;
}): Promise<LedgerBundleDownload> {
  const root = path.join(os.tmpdir(), LEDGER_EXTRACTS_ROOT);
  await cleanupStaleExtractDirectories(root);
  await mkdir(root, { recursive: true });
  const directory = await mkdtemp(path.join(root, "extract-"));
  const context = input.context;
  try {
    const payload = await apiJson(
      context,
      `/v1/ledger-pdfs/requests/${encodeURIComponent(input.requestId)}/download-url`,
      { method: "POST" }
    );
    const link = signedLinkSchema.safeParse(payload);
    if (
      !link.success ||
      link.data.requestId !== input.requestId ||
      Date.parse(link.data.expiresAt) <= Date.now()
    ) {
      throw new LedgerPdfTransferError(
        "LEDGER_PDF_BUNDLE_URL_INVALID",
        "Ledger PDF link is missing, mismatched, or expired."
      );
    }
    if (link.data.byteSize < 1 || link.data.byteSize > LEDGER_BUNDLE_MAX_ZIP_BYTES)
      throw bundleLimit(
        "Ledger PDF ZIP exceeds its allowed size range. Select fewer stores or dates."
      );
    const archive = path.join(directory, "bundle.zip");
    try {
      await downloadVerified(
        context,
        link.data.downloadUrl,
        archive,
        link.data.byteSize,
        link.data.checksumSha256
      );
    } catch (error) {
      if (error instanceof TransferVerificationError)
        throw new LedgerPdfTransferError("LEDGER_PDF_BUNDLE_VERIFY_FAILED", error.message);
      throw error;
    }
    const files = await extractArchive(archive, directory, context.signal!);
    await rm(archive, { force: true });
    const downloadedAt = new Date().toISOString();
    await writeFile(
      path.join(directory, "manifest.json"),
      `${JSON.stringify(
        {
          requestId: input.requestId,
          downloadedAt,
          byteSize: link.data.byteSize,
          checksumSha256: link.data.checksumSha256,
          fileCount: files.length,
          files
        },
        null,
        2
      )}\n`,
      { encoding: "utf8", signal: context.signal }
    );
    return {
      localDirectory: directory,
      requestId: input.requestId,
      fileCount: files.length,
      files: files.map((file) => file.relativePath)
    };
  } catch (error) {
    await rm(directory, { recursive: true, force: true }).catch(() => undefined);
    if (isTimeout(context.signal?.reason) || isTimeout(error)) {
      throw new LedgerPdfTransferError(
        "LEDGER_PDF_BUNDLE_DOWNLOAD_TIMEOUT",
        "Ledger PDF bundle download exceeded its time limit."
      );
    }
    context.signal?.throwIfAborted();
    throw error;
  }
}

function isTimeout(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "name" in error &&
    (error as { name?: unknown }).name === "TimeoutError"
  );
}

async function extractArchive(
  archive: string,
  directory: string,
  signal: AbortSignal
): Promise<LedgerBundleFile[]> {
  const zip = await new Promise<ZipReader>((resolve, reject) =>
    yauzl.open(
      archive,
      { lazyEntries: true, autoClose: false, strictFileNames: true, validateEntrySizes: true },
      (error, reader) => (error ? reject(invalidZip()) : resolve(reader))
    )
  );
  let activeStream: Readable | undefined;
  const stop = () => {
    activeStream?.destroy();
    zip.close();
  };
  signal.addEventListener("abort", stop, { once: true });
  try {
    signal.throwIfAborted();
    if (zip.entryCount < 1) throw unsafeEntry("empty archive");
    if (zip.entryCount > LEDGER_BUNDLE_LIMITS.files)
      throw bundleLimit("Ledger PDF ZIP contains too many PDFs. Select fewer stores or dates.");
    const entries = await abortable(
      new Promise<Map<string, ZipEntry>>((resolve, reject) => {
        const found = new Map<string, ZipEntry>();
        let bytes = 0;
        zip.on("error", () => reject(invalidZip()));
        zip.on("entry", (entry) => {
          try {
            validateEntry(entry);
            if (found.has(entry.fileName)) throw unsafeEntry("duplicate entry");
            bytes += entry.uncompressedSize;
            if (!Number.isSafeInteger(bytes) || bytes > LEDGER_BUNDLE_LIMITS.bytes)
              throw bundleLimit(
                "Ledger PDF content exceeds its size limit. Select fewer stores or dates."
              );
            found.set(entry.fileName, entry);
            zip.readEntry();
          } catch (error) {
            reject(error);
          }
        });
        zip.on("end", () => resolve(found));
        zip.readEntry();
      }),
      signal
    );
    const files: LedgerBundleFile[] = [];
    for (const [name, entry] of entries) {
      signal.throwIfAborted();
      const target = path.resolve(directory, name);
      if (!target.startsWith(`${path.resolve(directory)}${path.sep}`))
        throw unsafeEntry("path traversal");
      await mkdir(path.dirname(target), { recursive: true });
      activeStream = await new Promise<Readable>((resolve, reject) =>
        zip.openReadStream(entry, (error, stream) =>
          error ? reject(invalidZip()) : resolve(stream)
        )
      );
      await pipeline(activeStream, createWriteStream(target, { flags: "wx" }), { signal });
      const [storeSegment, purchaseDate, fileName] = name.split("/");
      files.push({
        storeName: decodeLedgerStoreFileSegment(storeSegment!),
        purchaseDate: purchaseDate!,
        fileName: fileName!,
        relativePath: name,
        byteSize: entry.uncompressedSize
      });
    }
    files.sort((left, right) => left.relativePath.localeCompare(right.relativePath));
    return files;
  } finally {
    signal.removeEventListener("abort", stop);
    activeStream?.destroy();
    zip.close();
  }
}

function validateEntry(entry: ZipEntry): void {
  const mode = (entry.externalFileAttributes >>> 16) & 0xf000;
  if (
    (mode !== 0 && mode !== 0x8000) ||
    (entry.externalFileAttributes & 0x10) !== 0 ||
    entry.compressionMethod !== 0 ||
    (entry.generalPurposeBitFlag & 1) !== 0 ||
    entry.compressedSize !== entry.uncompressedSize ||
    entry.uncompressedSize < 1
  )
    throw unsafeEntry("unsupported compression, attributes, or size");
  const name = entry.fileName;
  if (
    name.startsWith("/") ||
    name.includes("\\") ||
    name.includes("\0") ||
    name.split("/").some((segment) => segment === "" || segment === "." || segment === "..")
  )
    throw unsafeEntry("unsafe path");
  const parts = name.split("/");
  if (parts.length !== 3 || !/^\d{4}-\d{2}-\d{2}$/.test(parts[1]!))
    throw unsafeEntry("unexpected layout");
  if (parts[2] !== ledgerPdfNameForSegment(parts[0]!, parts[1]!))
    throw unsafeEntry("unexpected file name");
}

function unsafeEntry(reason: string): LedgerPdfTransferError {
  return new LedgerPdfTransferError(
    "LEDGER_PDF_BUNDLE_VERIFY_FAILED",
    `Ledger PDF archive contains an unsafe entry: ${reason}.`
  );
}

function invalidZip(): LedgerPdfTransferError {
  return new LedgerPdfTransferError(
    "LEDGER_PDF_BUNDLE_VERIFY_FAILED",
    "Ledger PDF ZIP is malformed or contains an unsafe path."
  );
}

function bundleLimit(message: string): LedgerPdfTransferError {
  return new LedgerPdfTransferError("LEDGER_PDF_BUNDLE_LIMIT_EXCEEDED", message);
}
