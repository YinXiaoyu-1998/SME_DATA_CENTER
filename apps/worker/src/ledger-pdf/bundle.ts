import { createHash, randomBytes } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline, finished } from "node:stream/promises";
import JSZip from "jszip";
import { Prisma, type PrismaClient } from "@prisma/client";
import { enqueueStorageGarbage, storageGarbageKeyHash } from "@smedc/db";
import type { StorageAdapter } from "@smedc/storage";
import { createPrismaLedgerArtifactAccess } from "@smedc/ledger-archive";
import {
  createPrismaLedgerDeliveryRepository,
  ledgerBundleEntriesEqual,
  capturedLedgerBundleEntries,
  parseLedgerBundleManifest,
  readyCapturedLedgerBundleEntries,
  type LedgerBundleEntry,
  type LedgerBundleLease,
  type LedgerBundleRecord,
  type LedgerDeliveryEmployee
} from "@smedc/ledger-archive/delivery";

export interface LedgerBundleArchive {
  loadBundle(requestId: string): Promise<LedgerBundleRecord | null>;
  selectBundle(record: LedgerBundleRecord): Promise<LedgerBundleEntry[]>;
  registerCandidate(input: {
    record: LedgerBundleRecord;
    lease: LedgerBundleLease;
    key: string;
  }): Promise<boolean>;
  completeBundle(input: {
    record: LedgerBundleRecord;
    lease: LedgerBundleLease;
    key: string;
    entries: LedgerBundleEntry[];
    expiresAt: Date;
  }): Promise<boolean>;
  failBundle(input: {
    requestId: string;
    lease: LedgerBundleLease;
    code: string;
  }): Promise<boolean>;
}
export const LEDGER_BUNDLE_LIMITS = {
  files: 5000,
  bytes: 1024 ** 3,
  deadlineMs: 600000,
  retentionMs: 86400000
} as const;
export function ledgerBundleEntryName(entry: LedgerBundleEntry): string {
  // Percent itself is escaped, making the segment reversible and preventing collisions/traversal.
  const store = [...entry.key.storeName]
    .map((character, index, characters) =>
      '%./\\<>:"|?*'.includes(character) ||
      character.codePointAt(0)! < 32 ||
      character.codePointAt(0) === 127 ||
      (character === " " && index === characters.length - 1)
        ? encodeURIComponent(character).replaceAll(".", "%2E")
        : character
    )
    .join("");
  return `${store}/${entry.key.purchaseDate}/食品经营单位进货台帐_${store}_${entry.key.purchaseDate}.pdf`;
}
function error(code: string): never {
  throw new Error(code);
}
export async function processLedgerBundle({
  requestId,
  lease,
  archive,
  storage,
  signal,
  now = () => new Date(),
  limits = LEDGER_BUNDLE_LIMITS
}: {
  requestId: string;
  lease: LedgerBundleLease;
  archive: LedgerBundleArchive;
  storage: StorageAdapter;
  signal?: AbortSignal;
  now?: () => Date;
  limits?: { files: number; bytes: number; deadlineMs: number; retentionMs: number };
}): Promise<"completed" | "superseded"> {
  const record = await archive.loadBundle(requestId);
  if (!record) return "superseded";
  if (!storage.putObjectAtKey) error("LEDGER_BUNDLE_STORAGE_UNSUPPORTED");
  const controller = new AbortController();
  const abort = () => controller.abort(signal?.reason);
  signal?.addEventListener("abort", abort, { once: true });
  if (signal?.aborted) abort();
  const deadline = setTimeout(
    () => controller.abort(new Error("LEDGER_PDF_BUNDLE_TIMEOUT")),
    limits.deadlineMs
  );
  deadline.unref();
  async function bounded<T>(work: () => Promise<T>): Promise<T> {
    if (controller.signal.aborted) throw controller.signal.reason;
    return new Promise<T>((resolve, reject) => {
      const onAbort = () => reject(controller.signal.reason);
      controller.signal.addEventListener("abort", onAbort, { once: true });
      work()
        .then(resolve, reject)
        .finally(() => controller.signal.removeEventListener("abort", onAbort));
    });
  }
  const select = async () =>
    capturedLedgerBundleEntries(await archive.selectBundle(record), record.manifest.entries);
  const directory = await mkdtemp(join(tmpdir(), "smedc-ledger-zip-"));
  try {
    for (let attempt = 0; attempt < 3; attempt++) {
      const entries = await bounded(select);
      if (!entries.length) error("LEDGER_PDF_UNAVAILABLE");
      if (
        entries.length > limits.files ||
        entries.reduce((s, e) => s + e.byteSize, 0) > limits.bytes
      )
        error("LEDGER_PDF_BUNDLE_LIMIT_EXCEEDED");
      const names = entries.map(ledgerBundleEntryName);
      if (new Set(names).size !== names.length) error("LEDGER_BUNDLE_DUPLICATE_ENTRY");
      const key = `org/${encodeURIComponent(record.orgId)}/ledger_bundles/${record.requestId}/${lease.attemptNumber}-${randomBytes(12).toString("hex")}.zip`;
      if (!(await bounded(() => archive.registerCandidate({ record, lease, key }))))
        return "superseded";
      const zip = new JSZip();
      const inputStreams: Readable[] = [];
      const outputFile = join(directory, `bundle-${attempt}.zip`);
      try {
        entries.forEach((entry, index) => {
          const stream = Readable.from(
            (async function* () {
              const source = await storage.getObjectStream(entry.objectKey);
              const hash = createHash("sha256");
              let bytes = 0;
              try {
                for await (const chunk of source) {
                  if (controller.signal.aborted) throw controller.signal.reason;
                  const buffer = Buffer.from(chunk as Uint8Array);
                  bytes += buffer.length;
                  if (bytes > entry.byteSize) error("LEDGER_PDF_BUNDLE_STALE");
                  hash.update(buffer);
                  yield buffer;
                }
              } finally {
                (source as Readable).destroy?.();
              }
              if (bytes !== entry.byteSize || hash.digest("hex") !== entry.checksumSha256)
                error("LEDGER_PDF_BUNDLE_STALE");
            })()
          );
          inputStreams.push(stream);
          zip.file(names[index]!, stream, {
            binary: true,
            createFolders: false,
            date: new Date("2000-01-01T00:00:00Z")
          });
        });
        let bytes = 0;
        const hash = createHash("sha256");
        const output = zip.generateNodeStream({ streamFiles: true, compression: "STORE" });
        await pipeline(
          output,
          new Transform({
            transform(chunk: Buffer, _encoding, callback) {
              bytes += chunk.length;
              if (bytes > limits.bytes)
                return callback(new Error("LEDGER_PDF_BUNDLE_LIMIT_EXCEEDED"));
              hash.update(chunk);
              callback(null, chunk);
            }
          }),
          createWriteStream(outputFile),
          { signal: controller.signal }
        );
        const latest = await bounded(select);
        if (!ledgerBundleEntriesEqual(entries, latest)) {
          if (attempt < 2) continue;
          error("LEDGER_PDF_BUNDLE_STALE");
        }
        const contentLength = (await stat(outputFile)).size;
        const uploadStream = createReadStream(outputFile);
        inputStreams.push(uploadStream);
        await bounded(() =>
          storage.putObjectAtKey!({
            key,
            body: uploadStream,
            contentLength,
            checksumSha256: hash.digest("hex"),
            contentType: "application/zip"
          })
        );
        if (controller.signal.aborted) throw controller.signal.reason;
        const afterUpload = await bounded(select);
        if (!ledgerBundleEntriesEqual(entries, afterUpload)) {
          if (attempt < 2) continue;
          error("LEDGER_PDF_BUNDLE_STALE");
        }
        if (
          !(await bounded(() =>
            archive.completeBundle({
              record,
              lease,
              key,
              entries,
              expiresAt: new Date(now().getTime() + limits.retentionMs)
            })
          ))
        ) {
          // A current lease can retry a changed pointer; stale workers cannot finish or fail it.
          if (attempt < 2) continue;
          error("LEDGER_PDF_BUNDLE_STALE");
        }
        return "completed";
      } catch (cause) {
        if (controller.signal.aborted) error("LEDGER_PDF_BUNDLE_TIMEOUT");
        const changed = await bounded(select).catch(() => null);
        if (attempt < 2 && changed && !ledgerBundleEntriesEqual(entries, changed)) continue;
        throw cause;
      } finally {
        inputStreams.forEach((s) => s.destroy());
        await Promise.allSettled(inputStreams.map((s) => finished(s, { cleanup: true })));
        await rm(outputFile, { force: true });
      }
    }
    return error("LEDGER_PDF_BUNDLE_STALE");
  } catch (cause) {
    const safeCodes = new Set([
      "LEDGER_PDF_NOT_READY",
      "LEDGER_PDF_UNAVAILABLE",
      "LEDGER_PDF_BUNDLE_STALE",
      "LEDGER_PDF_BUNDLE_TIMEOUT",
      "LEDGER_PDF_BUNDLE_LIMIT_EXCEEDED"
    ]);
    const code =
      cause instanceof Error && safeCodes.has(cause.message)
        ? cause.message
        : "LEDGER_PDF_BUNDLE_FAILED";
    const failed = await archive.failBundle({ requestId, lease, code });
    return failed ? "completed" : "superseded";
  } finally {
    clearTimeout(deadline);
    signal?.removeEventListener("abort", abort);
    await rm(directory, { recursive: true, force: true });
  }
}

export function createPrismaLedgerBundleArchive({
  prisma,
  storage,
  now = () => new Date()
}: {
  prisma: PrismaClient;
  storage: StorageAdapter;
  now?: () => Date;
}): LedgerBundleArchive {
  const delivery = createPrismaLedgerDeliveryRepository({ prisma, storage });
  async function selectBundle(record: LedgerBundleRecord) {
    const employee = await prisma.employee.findFirst({
      where: { id: record.employeeId, orgId: record.orgId, disabled: false }
    });
    if (!employee) error("LEDGER_PDF_UNAVAILABLE");
    return readyCapturedLedgerBundleEntries(
      await delivery.facts(employee as LedgerDeliveryEmployee, record.manifest.scope),
      record.manifest.entries
    );
  }
  async function fenced<T>(
    lease: LedgerBundleLease,
    requestId: string,
    fn: (tx: Prisma.TransactionClient) => Promise<T>
  ): Promise<T | false> {
    return prisma.$transaction(
      async (tx) => {
        await tx.$queryRaw(
          Prisma.sql`SELECT id FROM processing_runs WHERE id=${lease.runId} FOR UPDATE`
        );
        const run = await tx.processingRun.findFirst({
          where: {
            id: lease.runId,
            ledgerArtifactRequestId: requestId,
            jobType: "ledger_pdf_bundle",
            status: "running",
            lockedBy: lease.lockedBy,
            attemptNumber: lease.attemptNumber,
            lockedUntil: { gt: now() }
          }
        });
        if (!run) return false;
        return fn(tx);
      },
      { timeout: 30000, isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted }
    );
  }
  return {
    async loadBundle(requestId) {
      const request = await prisma.ledgerArtifactRequest.findFirst({
        where: { id: requestId, kind: "download", actorKind: "employee" }
      });
      if (!request?.actorEmployeeId) return null;
      return {
        requestId: request.id,
        orgId: request.orgId,
        employeeId: request.actorEmployeeId,
        status: request.status,
        manifest: parseLedgerBundleManifest(request.scope),
        zipObjectKey: request.zipObjectKey,
        zipExpiresAt: request.zipExpiresAt,
        errorCode: request.errorCode
      };
    },
    selectBundle,
    registerCandidate({ record, lease, key }) {
      return fenced(lease, record.requestId, async (tx) => {
        await enqueueStorageGarbage(tx, {
          objectKey: key,
          reason: "ledger_bundle_candidate",
          processingRunId: lease.runId
        });
        await tx.ledgerArtifactRequest.update({
          where: { id: record.requestId },
          data: { status: "running" }
        });
        return true;
      });
    },
    async completeBundle({ record, lease, key, entries, expiresAt }) {
      // This check is repeated inside the lease lock, before the final CAS write.
      capturedLedgerBundleEntries(entries, record.manifest.entries);
      if (entries.length !== record.manifest.entries.length) return false;
      return fenced(lease, record.requestId, async (tx) => {
        await tx.$queryRaw(
          Prisma.sql`SELECT id FROM organizations WHERE id=${record.orgId} FOR UPDATE`
        );
        await tx.$queryRaw(
          Prisma.sql`SELECT id FROM employees WHERE id=${record.employeeId} AND org_id=${record.orgId} FOR UPDATE`
        );
        const employee = await tx.employee.findFirst({
          where: { id: record.employeeId, orgId: record.orgId, disabled: false }
        });
        if (!employee) return false;
        const dependencies = [
          ...new Map(
            entries
              .flatMap((entry) => entry.sources)
              .map((source) => [JSON.stringify(source), source])
          ).values()
        ];
        if (dependencies.some((source) => source.confidentialityLevel > employee.clearance))
          return false;
        if (
          !(await createPrismaLedgerArtifactAccess({ prisma: tx }).sourcesAreCurrent({
            orgId: record.orgId,
            sources: dependencies,
            tx
          }))
        )
          return false;
        const partitionIds = entries.map((entry) => entry.partitionId);
        await tx.$queryRaw(
          Prisma.sql`SELECT id FROM ledger_pdf_partitions WHERE org_id=${record.orgId} AND id IN (${Prisma.join(partitionIds)}) ORDER BY id FOR UPDATE`
        );
        const pointers = await tx.ledgerPdfPartition.findMany({
          where: { orgId: record.orgId, id: { in: partitionIds } }
        });
        const byId = new Map(pointers.map((pointer) => [pointer.id, pointer]));
        for (const entry of entries) {
          const pointer = byId.get(entry.partitionId);
          if (
            !pointer ||
            pointer.orgId !== entry.key.orgId ||
            pointer.storeName !== entry.key.storeName ||
            pointer.purchaseDate.toISOString().slice(0, 10) !== entry.key.purchaseDate ||
            pointer.currentObjectKey !== entry.objectKey ||
            pointer.publishedGeneration !== entry.generation ||
            pointer.dataRevision !== entry.dataRevision ||
            pointer.publishedDataRevision !== entry.dataRevision ||
            pointer.publishedSourceFingerprint !== entry.sourceFingerprint ||
            pointer.checksumSha256 !== entry.checksumSha256 ||
            Number(pointer.byteSize) !== entry.byteSize
          )
            return false;
        }
        if (
          !(await tx.processingRun.findFirst({
            where: {
              id: lease.runId,
              status: "running",
              lockedBy: lease.lockedBy,
              attemptNumber: lease.attemptNumber,
              lockedUntil: { gt: now() }
            }
          }))
        )
          return false;
        await tx.ledgerArtifactRequest.update({
          where: { id: record.requestId },
          data: {
            status: "succeeded",
            scope: { ...record.manifest, entries } as unknown as Prisma.InputJsonValue,
            zipObjectKey: key,
            zipExpiresAt: expiresAt,
            errorCode: null
          }
        });
        await tx.storageGarbage.deleteMany({
          where: { objectKeyHash: storageGarbageKeyHash(key), objectKey: key }
        });
        await enqueueStorageGarbage(tx, {
          objectKey: key,
          reason: "ledger_bundle_expired",
          availableAt: expiresAt
        });
        await tx.processingRun.update({
          where: { id: lease.runId },
          data: { status: "succeeded", finishedAt: now(), lockedBy: null, lockedUntil: null }
        });
        return true;
      });
    },
    failBundle({ requestId, lease, code }) {
      return fenced(lease, requestId, async (tx) => {
        await tx.ledgerArtifactRequest.update({
          where: { id: requestId },
          data: { status: "failed", errorCode: code }
        });
        await tx.processingRun.update({
          where: { id: lease.runId },
          data: {
            status: "failed",
            errorCode: code,
            finishedAt: now(),
            lockedBy: null,
            lockedUntil: null
          }
        });
        return true;
      });
    }
  };
}
/** Run on every worker maintenance cycle, independently of daily reconciliation enablement. */
export async function enqueueExpiredLedgerBundles(
  prisma: PrismaClient,
  now = new Date()
): Promise<number> {
  return prisma.$transaction(async (tx) => {
    const expired = await tx.ledgerArtifactRequest.findMany({
      where: { kind: "download", zipExpiresAt: { lte: now }, zipObjectKey: { not: null } },
      take: 200
    });
    for (const request of expired) {
      await enqueueStorageGarbage(tx, {
        objectKey: request.zipObjectKey!,
        reason: "ledger_bundle_expired"
      });
      await tx.ledgerArtifactRequest.updateMany({
        where: { id: request.id, zipObjectKey: request.zipObjectKey, zipExpiresAt: { lte: now } },
        data: { zipObjectKey: null }
      });
    }
    return expired.length;
  });
}
