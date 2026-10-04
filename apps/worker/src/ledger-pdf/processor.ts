import { createHash, randomUUID } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { Transform, type Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { PrismaClient } from "@prisma/client";
import { createDatabaseAdapter } from "@smedc/db";
import {
  createLedgerPdfObjectKey,
  createPrismaLedgerPublicationArchive,
  LedgerPublicationError,
  type LedgerLeaseToken,
  type LedgerPartitionKey,
  type LedgerSnapshot,
  type PublishLedgerPdfInput,
  type RenderedLedgerPdf
} from "@smedc/ledger-archive";
import type { StorageAdapter } from "@smedc/storage";
import type { ClaimedProcessingRun } from "../worker.js";
import { renderLedgerPdf } from "./renderer.js";

export interface LedgerGenerationArchive {
  getGeneration(input: {
    runId: string;
    orgId: string;
  }): Promise<{ partitionId: string; generation: number; key: LedgerPartitionKey }>;
  readLedgerSnapshot(key: LedgerPartitionKey): Promise<LedgerSnapshot>;
  registerCandidate(input: {
    orgId: string;
    leaseToken: LedgerLeaseToken;
    objectKey: string;
  }): Promise<void>;
  publishLedgerPdf(input: PublishLedgerPdfInput): Promise<"published" | "superseded">;
  leaseIsActive(
    token: Pick<LedgerLeaseToken, "runId" | "attemptNumber"> & { lockedBy?: string }
  ): Promise<boolean>;
}
export type LedgerPdfRenderer = typeof renderLedgerPdf;

async function fileDigest(path: string) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}
function checkAbort(signal?: AbortSignal) {
  if (signal?.aborted) throw new LedgerPublicationError("LEDGER_RENDER_ABORTED", true);
}

export async function processLedgerPdf({
  run,
  archive,
  renderer = renderLedgerPdf,
  storage,
  signal,
  scratchRoot = "/var/lib/smedc/ledger-pdf"
}: {
  run: ClaimedProcessingRun;
  archive: LedgerGenerationArchive;
  renderer?: LedgerPdfRenderer;
  storage: StorageAdapter;
  signal?: AbortSignal;
  scratchRoot?: string;
}): Promise<{ status: "published" | "empty" | "superseded" }> {
  if (!run.lockedBy) throw new LedgerPublicationError("PROCESSING_LEASE_LOST", false);
  const leaseToken = { runId: run.id, lockedBy: run.lockedBy, attemptNumber: run.attemptNumber };
  checkAbort(signal);
  const generation = await archive.getGeneration({ runId: run.id, orgId: run.orgId });
  const snapshot = await archive.readLedgerSnapshot(generation.key);
  checkAbort(signal);
  const publication = {
    partitionId: generation.partitionId,
    generation: generation.generation,
    dataRevision: snapshot.dataRevision,
    sourceFingerprint: snapshot.sourceFingerprint,
    leaseToken,
    sources: snapshot.sources,
    rowCount: snapshot.rows.length,
    certificateCount: snapshot.certificates.length
  };
  if (!snapshot.rows.length) {
    const status = await archive.publishLedgerPdf({ ...publication, candidate: null });
    return { status: status === "published" ? "empty" : status };
  }
  if (
    snapshot.rows.length > 10_000 ||
    snapshot.certificates.length > 200 ||
    snapshot.certificates.reduce((sum, photo) => sum + photo.byteSize, 0) > 500 * 1024 * 1024
  )
    throw new LedgerPublicationError("LEDGER_LIMIT_EXCEEDED", false);
  await mkdir(scratchRoot, { recursive: true });
  const directory = join(
    resolve(scratchRoot),
    `ledger-job-${run.id}.${run.attemptNumber}.${randomUUID()}`
  );
  await mkdir(directory);
  try {
    // Durable local manifest identifies exactly which expired lease owns crash residue.
    await writeFile(join(directory, "lease.json"), JSON.stringify(leaseToken), { flag: "wx" });
    const certificateFiles = new Map<string, string>();
    for (const [index, certificate] of snapshot.certificates.entries()) {
      checkAbort(signal);
      const path = join(directory, `certificate-${index}`);
      let bytes = 0;
      const digest = createHash("sha256");
      const bounded = new Transform({
        transform(chunk: Buffer, _encoding, callback) {
          bytes += chunk.length;
          if (bytes > certificate.byteSize)
            return callback(new LedgerPublicationError("LEDGER_CERTIFICATE_INVALID", false));
          digest.update(chunk);
          callback(null, chunk);
        }
      });
      await pipeline(
        (await storage.getObjectStream(certificate.storageObjectKey)) as Readable,
        bounded,
        createWriteStream(path, { flags: "wx" }),
        { signal }
      );
      if (
        bytes !== certificate.byteSize ||
        digest.digest("hex") !== certificate.checksumSha256.toLowerCase()
      )
        throw new LedgerPublicationError("LEDGER_CERTIFICATE_INVALID", false);
      certificateFiles.set(certificate.sourceDocumentId, path);
    }
    const rendered: RenderedLedgerPdf = await renderer({
      snapshot,
      certificateFiles,
      workDirectory: directory,
      signal
    });
    // Do not trust a malformed renderer result, even when using an injected implementation.
    const info = await stat(rendered.path);
    if (
      !info.isFile() ||
      info.size !== rendered.byteSize ||
      info.size <= 0 ||
      info.size > 200 * 1024 * 1024 ||
      !Number.isSafeInteger(rendered.pageCount) ||
      rendered.pageCount < 1 + snapshot.certificates.length ||
      (await fileDigest(rendered.path)) !== rendered.checksumSha256
    )
      throw new LedgerPublicationError("LEDGER_PDF_INVALID", false);
    checkAbort(signal);
    if (!storage.putObjectAtKey)
      throw new LedgerPublicationError("LEDGER_STORAGE_UNSUPPORTED", false);
    const objectKey = createLedgerPdfObjectKey(
      generation.key,
      generation.generation,
      (storage as StorageAdapter & { keyPrefix?: string }).keyPrefix ?? "",
      randomUUID()
    );
    await archive.registerCandidate({ orgId: run.orgId, leaseToken, objectKey });
    checkAbort(signal);
    const body = createReadStream(rendered.path);
    // Cancellation can precede the adapter attaching its own stream error handler.
    body.on("error", () => undefined);
    const abortUpload = () =>
      body.destroy(new LedgerPublicationError("LEDGER_RENDER_ABORTED", true));
    signal?.addEventListener("abort", abortUpload, { once: true });
    const uploaded = await storage
      .putObjectAtKey({
        key: objectKey,
        body,
        contentLength: rendered.byteSize,
        checksumSha256: rendered.checksumSha256,
        contentType: "application/pdf"
      })
      .finally(() => {
        signal?.removeEventListener("abort", abortUpload);
        body.destroy();
      });
    const head = await storage.headObject(objectKey);
    if (
      uploaded.key !== objectKey ||
      uploaded.size !== rendered.byteSize ||
      uploaded.hash !== rendered.checksumSha256 ||
      head.state !== "found" ||
      head.size !== rendered.byteSize ||
      head.hash !== rendered.checksumSha256
    )
      throw new LedgerPublicationError("LEDGER_UPLOAD_VERIFICATION_FAILED", true);
    checkAbort(signal);
    const status = await archive.publishLedgerPdf({
      ...publication,
      candidate: {
        objectKey,
        byteSize: rendered.byteSize,
        checksumSha256: rendered.checksumSha256,
        pageCount: rendered.pageCount
      }
    });
    // Do not delete candidates on a DB error: commit acknowledgement can be lost after commit.
    // Registered garbage is removed in the successful transaction and retained on rollback.
    return { status };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

export async function cleanupLedgerScratch(input: {
  scratchRoot: string;
  archive: Pick<LedgerGenerationArchive, "leaseIsActive">;
}): Promise<void> {
  const entries = await readdir(input.scratchRoot, { withFileTypes: true }).catch(
    (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return [];
      throw error;
    }
  );
  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.startsWith("ledger-job-")) continue;
    const directory = join(input.scratchRoot, entry.name);
    let lease: Pick<LedgerLeaseToken, "runId" | "attemptNumber"> & { lockedBy?: string };
    try {
      lease = JSON.parse(await readFile(join(directory, "lease.json"), "utf8")) as LedgerLeaseToken;
      if (
        typeof lease.runId !== "string" ||
        typeof lease.lockedBy !== "string" ||
        !Number.isSafeInteger(lease.attemptNumber)
      )
        continue;
    } catch {
      // The directory identity survives a crash between mkdir and manifest creation.
      const identity = /^ledger-job-([A-Za-z0-9_-]{1,32})\.(\d+)\.[0-9a-f-]{36}$/.exec(entry.name);
      if (!identity) continue;
      lease = { runId: identity[1]!, attemptNumber: Number(identity[2]) };
      if (!Number.isSafeInteger(lease.attemptNumber)) continue;
    }
    if (!(await input.archive.leaseIsActive(lease)))
      await rm(directory, { recursive: true, force: true });
  }
}

export function createLedgerPdfProcessor({
  databaseUrl = process.env["DATABASE_URL"],
  scratchRoot = "/var/lib/smedc/ledger-pdf"
}: { databaseUrl?: string; scratchRoot?: string } = {}) {
  if (!databaseUrl) throw new Error("DATABASE_URL is required for ledger PDF generation");
  const prisma = new PrismaClient({ adapter: createDatabaseAdapter(databaseUrl) });
  const archive = createPrismaLedgerPublicationArchive({ prisma });
  // Serializes conversion across worker slots; waiting jobs continue to heartbeat their lease.
  let previous: Promise<unknown> = Promise.resolve();
  return {
    process(input: { run: ClaimedProcessingRun; storage: StorageAdapter; signal?: AbortSignal }) {
      const next = previous
        .catch(() => undefined)
        .then(async () => (await processLedgerPdf({ ...input, archive, scratchRoot })).status);
      previous = next;
      return next;
    },
    maintain() {
      return cleanupLedgerScratch({ scratchRoot, archive });
    },
    disconnect() {
      return prisma.$disconnect();
    }
  };
}
