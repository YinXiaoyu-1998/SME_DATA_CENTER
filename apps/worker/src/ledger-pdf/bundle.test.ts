import { readLedgerSourceMetadata } from "../../../../packages/ledger-archive/src/source-reader.js";
vi.mock("../../../../packages/ledger-archive/src/source-reader.js", async (original) => ({
  ...(await original<typeof import("../../../../packages/ledger-archive/src/source-reader.js")>()),
  readLedgerSourceMetadata: vi.fn()
}));
import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import JSZip from "jszip";
import { describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "@prisma/client";
import type { StorageAdapter } from "@smedc/storage";
import type { LedgerBundleEntry, LedgerBundleRecord } from "@smedc/ledger-archive/delivery";
import {
  createPrismaLedgerBundleArchive,
  enqueueExpiredLedgerBundles,
  ledgerBundleEntryName,
  processLedgerBundle,
  type LedgerBundleArchive
} from "./bundle.js";
const pdf = Buffer.from("%PDF-synthetic-existing-archive");
const hash = createHash("sha256").update(pdf).digest("hex");
function entry(day: number, generation = 1): LedgerBundleEntry {
  return {
    key: { orgId: "org", storeName: "../%店/\\", purchaseDate: `2026-10-0${day}` },
    partitionId: `p${day}`,
    generation,
    dataRevision: 1,
    sourceFingerprint: "a".repeat(64),
    objectKey: `existing-${day}-${generation}.pdf`,
    checksumSha256: hash,
    byteSize: pdf.length,
    sources: [
      {
        sourceDocumentId: "source",
        kind: "ledger",
        confidentialityLevel: 0,
        checksumSha256: "b".repeat(64)
      }
    ]
  };
}
function fixture() {
  const record: LedgerBundleRecord = {
    requestId: "r",
    orgId: "org",
    employeeId: "e",
    status: "queued",
    manifest: {
      version: 1,
      scope: {
        storeNames: [entry(1).key.storeName],
        dates: ["2026-10-01", "2026-10-02", "2026-10-03", "2026-10-04"]
      },
      entries: [entry(1), entry(2), entry(3)]
    },
    zipObjectKey: null,
    zipExpiresAt: null,
    errorCode: null
  };
  const archive: LedgerBundleArchive = {
    loadBundle: vi.fn(async () => record),
    selectBundle: vi.fn(async () => record.manifest.entries),
    registerCandidate: vi.fn(async () => true),
    completeBundle: vi.fn(async () => true),
    failBundle: vi.fn(async () => true)
  };
  const objects = new Map<string, Buffer>();
  const storage = {
    getObjectStream: vi.fn(async () => Readable.from([pdf.subarray(0, 7), pdf.subarray(7)])),
    putObjectAtKey: vi.fn(async (input) => {
      const chunks: Buffer[] = [];
      for await (const chunk of input.body) chunks.push(Buffer.from(chunk));
      const buffer = Buffer.concat(chunks);
      expect(buffer.length).toBe(input.contentLength);
      expect(createHash("sha256").update(buffer).digest("hex")).toBe(input.checksumSha256);
      objects.set(input.key, buffer);
      return { key: input.key, size: buffer.length, hash: input.checksumSha256 };
    })
  } as unknown as StorageAdapter;
  const run = () =>
    processLedgerBundle({
      requestId: "r",
      lease: { runId: "run", lockedBy: "worker", attemptNumber: 1 },
      archive,
      storage
    });
  return { record, archive, storage, objects, run };
}
describe("streaming existing ledger PDF ZIP", () => {
  it("accepts input exactly at the byte budget while allowing the ZIP container headers", async () => {
    const f = fixture();
    await processLedgerBundle({
      requestId: "r",
      lease: { runId: "run", lockedBy: "w", attemptNumber: 1 },
      archive: f.archive,
      storage: f.storage,
      limits: { files: 5000, bytes: pdf.length * 3, deadlineMs: 10000, retentionMs: 86400000 }
    });
    expect(f.archive.completeBundle).toHaveBeenCalled();
    const zip = await JSZip.loadAsync([...f.objects.values()][0]!);
    expect(Object.keys(zip.files)).toHaveLength(3);
    for (const file of Object.values(zip.files))
      expect(await file.async("nodebuffer")).toEqual(pdf);
  });
  it("fails a mixed-clearance revocation after prepare without completing a partial subset", async () => {
    const f = fixture();
    vi.mocked(f.archive.selectBundle)
      .mockResolvedValueOnce(f.record.manifest.entries)
      .mockResolvedValue(f.record.manifest.entries.slice(0, 2));
    await f.run();
    expect(f.archive.completeBundle).not.toHaveBeenCalled();
    expect(f.storage.putObjectAtKey).not.toHaveBeenCalled();
    expect(f.archive.failBundle).toHaveBeenCalledWith(
      expect.objectContaining({ code: "LEDGER_PDF_UNAVAILABLE" })
    );
  });
  it("retains ordinary Chinese store names and the required PDF filename", () => {
    const e = { ...entry(1), key: { ...entry(1).key, storeName: "北京朝阳门店" } };
    expect(ledgerBundleEntryName(e)).toBe(
      "北京朝阳门店/2026-10-01/食品经营单位进货台帐_北京朝阳门店_2026-10-01.pdf"
    );
  });
  it("streams exactly three PDFs for four requested dates with collision-safe paths", async () => {
    const f = fixture();
    expect(await f.run()).toBe("completed");
    expect(f.storage.getObjectStream).toHaveBeenCalledTimes(3);
    const zip = await JSZip.loadAsync([...f.objects.values()][0]!);
    expect(Object.keys(zip.files)).toHaveLength(3);
    expect(Object.keys(zip.files)).not.toContain("../");
    for (const file of Object.values(zip.files))
      expect(await file.async("nodebuffer")).toEqual(pdf);
    expect(f.archive.completeBundle).toHaveBeenCalledWith(
      expect.objectContaining({ expiresAt: expect.any(Date), entries: f.record.manifest.entries })
    );
    expect(f.archive.registerCandidate).toHaveBeenCalledBefore(
      f.storage.putObjectAtKey as ReturnType<typeof vi.fn>
    );
  });
  it("never renders or uploads empty/pending selections", async () => {
    const f = fixture();
    vi.mocked(f.archive.selectBundle).mockResolvedValue([]);
    await f.run();
    expect(f.storage.putObjectAtKey).not.toHaveBeenCalled();
    expect(f.archive.failBundle).toHaveBeenCalledWith(
      expect.objectContaining({ code: "LEDGER_PDF_UNAVAILABLE" })
    );
    vi.mocked(f.archive.selectBundle).mockRejectedValue(new Error("LEDGER_PDF_NOT_READY"));
    await f.run();
    expect(f.storage.putObjectAtKey).not.toHaveBeenCalled();
  });
  it("refuses a replacement generation outside the fixed manifest", async () => {
    const f = fixture();
    f.record.manifest.entries = [entry(1)];
    let selected = 0;
    vi.mocked(f.archive.selectBundle).mockImplementation(async () =>
      ++selected === 1 ? [entry(1)] : [entry(1, 2)]
    );
    vi.mocked(f.storage.getObjectStream).mockRejectedValueOnce(new Error("404 object missing"));
    expect(await f.run()).toBe("completed");
    expect(f.archive.completeBundle).not.toHaveBeenCalled();
    expect(f.archive.failBundle).toHaveBeenCalled();
    expect(f.objects.size).toBe(0);
  });
  it("rejects an unchanged missing or corrupted PDF without publishing partial output", async () => {
    const f = fixture();
    vi.mocked(f.storage.getObjectStream).mockResolvedValue(Readable.from([Buffer.from("corrupt")]));
    await f.run();
    expect(f.archive.failBundle).toHaveBeenCalledWith(
      expect.objectContaining({ code: "LEDGER_PDF_BUNDLE_STALE" })
    );
    expect(f.archive.completeBundle).not.toHaveBeenCalled();
    expect(f.storage.putObjectAtKey).not.toHaveBeenCalled();
  });
  it("enforces input/file limits and deadline before publication", async () => {
    const f = fixture();
    await processLedgerBundle({
      requestId: "r",
      lease: { runId: "run", lockedBy: "w", attemptNumber: 1 },
      archive: f.archive,
      storage: f.storage,
      limits: { files: 2, bytes: 10000, deadlineMs: 10000, retentionMs: 86400000 }
    });
    expect(f.storage.getObjectStream).not.toHaveBeenCalled();
    expect(f.archive.failBundle).toHaveBeenLastCalledWith(
      expect.objectContaining({ code: "LEDGER_PDF_BUNDLE_LIMIT_EXCEEDED" })
    );
    const g = fixture();
    await processLedgerBundle({
      requestId: "r",
      lease: { runId: "run", lockedBy: "w", attemptNumber: 1 },
      archive: g.archive,
      storage: g.storage,
      limits: { files: 5000, bytes: pdf.length * 3 - 1, deadlineMs: 10000, retentionMs: 86400000 }
    });
    expect(g.storage.putObjectAtKey).not.toHaveBeenCalled();
    expect(g.archive.failBundle).toHaveBeenLastCalledWith(
      expect.objectContaining({ code: "LEDGER_PDF_BUNDLE_LIMIT_EXCEEDED" })
    );
    const h = fixture();
    vi.mocked(h.storage.getObjectStream).mockImplementation(async () =>
      Readable.from(
        (async function* () {
          await new Promise((resolve) => setTimeout(resolve, 50));
          yield pdf;
        })()
      )
    );
    await processLedgerBundle({
      requestId: "r",
      lease: { runId: "run", lockedBy: "w", attemptNumber: 1 },
      archive: h.archive,
      storage: h.storage,
      limits: { files: 5000, bytes: 10000, deadlineMs: 5, retentionMs: 86400000 }
    });
    expect(h.archive.failBundle).toHaveBeenLastCalledWith(
      expect.objectContaining({ code: "LEDGER_PDF_BUNDLE_TIMEOUT" })
    );
    expect(h.storage.putObjectAtKey).not.toHaveBeenCalled();
  });
  it("stale lease cannot upload or report completion and unknown failures are safe", async () => {
    const f = fixture();
    vi.mocked(f.archive.registerCandidate).mockResolvedValue(false);
    expect(await f.run()).toBe("superseded");
    expect(f.storage.putObjectAtKey).not.toHaveBeenCalled();
    expect(f.archive.failBundle).not.toHaveBeenCalled();
    const g = fixture();
    vi.mocked(g.storage.getObjectStream).mockRejectedValue(new Error("OSS credential secret"));
    vi.mocked(g.archive.failBundle).mockResolvedValue(false);
    expect(await g.run()).toBe("superseded");
    expect(g.archive.failBundle).toHaveBeenCalledWith(
      expect.objectContaining({ code: "LEDGER_PDF_BUNDLE_FAILED" })
    );
  });
  it("escapes literal percent, dot, slash and backslash reversibly", () => {
    const a = entry(1);
    const b = { ...a, key: { ...a.key, storeName: "%2E%2E" } };
    expect(ledgerBundleEntryName(a)).not.toBe(ledgerBundleEntryName(b));
    expect(decodeURIComponent(ledgerBundleEntryName(a).split("/")[0]!)).toBe(a.key.storeName);
    const reserved = { ...a, key: { ...a.key, storeName: '门店:*?"<>| ' } };
    const segment = ledgerBundleEntryName(reserved).split("/")[0]!;
    expect(segment).not.toMatch(/[:*?"<>|]/);
    expect(decodeURIComponent(segment)).toBe(reserved.key.storeName);
  });
});

describe("bundle durable lease and expiration boundaries", () => {
  it("publishes the captured current pointers despite a newer requested rebuild, and rejects lost identities or changed data", async () => {
    const f = fixture();
    f.record.manifest.entries.forEach((e) => {
      e.sources[0]!.confidentialityLevel = 3;
    });
    const pointers = f.record.manifest.entries.map((e) => ({
      id: e.partitionId,
      orgId: e.key.orgId,
      storeName: e.key.storeName,
      purchaseDate: new Date(e.key.purchaseDate),
      currentObjectKey: e.objectKey,
      requestedGeneration: e.generation + 1,
      publishedGeneration: e.generation,
      dataRevision: e.dataRevision,
      publishedDataRevision: e.dataRevision,
      publishedSourceFingerprint: e.sourceFingerprint,
      checksumSha256: e.checksumSha256,
      byteSize: BigInt(e.byteSize)
    }));
    const tx = {
      $queryRaw: vi.fn(async () => []),
      employee: { findFirst: vi.fn(async () => ({ clearance: 0, disabled: true })) },
      document: {
        findMany: vi.fn(async () => [
          {
            id: "source",
            status: "active",
            archivedAt: null,
            confidentialityLevel: 3,
            checksumSha256: "b".repeat(64),
            documentKind: "structured",
            importBatch: {
              orgId: "org",
              status: "applied",
              archivedAt: null,
              dataset: "delivery_ledger"
            }
          }
        ])
      },
      processingRun: { findFirst: vi.fn(async () => ({})), update: vi.fn() },
      ledgerPdfPartition: { findMany: vi.fn(async () => pointers) },
      ledgerArtifactRequest: { update: vi.fn() },
      storageGarbage: {
        deleteMany: vi.fn(),
        upsert: vi.fn(async () => ({ objectKey: "candidate.zip" }))
      }
    };
    const prisma = {
      $transaction: vi.fn(async (fn: (tx: unknown) => unknown) => fn(tx))
    } as unknown as PrismaClient;
    const archive = createPrismaLedgerBundleArchive({ prisma, storage: f.storage });
    const input = {
      record: f.record,
      lease: { runId: "run", lockedBy: "w", attemptNumber: 1 },
      key: "candidate.zip",
      entries: f.record.manifest.entries,
      expiresAt: new Date("2026-10-05")
    };
    vi.mocked(readLedgerSourceMetadata).mockResolvedValue({
      rowCount: 1,
      sourceFingerprint: "a".repeat(64),
      sources: f.record.manifest.entries[0]!.sources
    });
    Object.assign(f.storage, {
      headObject: vi.fn(async () => ({
        state: "found",
        size: pdf.length,
        hash: createHash("sha256").update(pdf).digest("hex")
      }))
    });
    expect(await archive.selectBundle(f.record)).toEqual(f.record.manifest.entries);
    expect(await archive.completeBundle(input)).toBe(true);
    expect(tx.employee.findFirst).not.toHaveBeenCalled();
    expect(tx.ledgerArtifactRequest.update).toHaveBeenCalledTimes(1);
    pointers[0]!.dataRevision++;
    expect(await archive.completeBundle(input)).toBe(false);
    await expect(
      archive.completeBundle({ ...input, entries: input.entries.slice(0, 2) })
    ).rejects.toThrow("LEDGER_PDF_UNAVAILABLE");
    expect(tx.ledgerArtifactRequest.update).toHaveBeenCalledTimes(1);
  });
  it("fences candidate, success and failure against the same running unexpired attempt", async () => {
    const f = fixture();
    const tx = {
      $queryRaw: vi.fn(async () => []),
      processingRun: { findFirst: vi.fn(async () => null) },
      ledgerArtifactRequest: { update: vi.fn() },
      storageGarbage: { upsert: vi.fn() }
    };
    const prisma = {
      $transaction: vi.fn(async (fn: (tx: unknown) => unknown) => fn(tx))
    } as unknown as PrismaClient;
    const now = new Date("2026-10-04T00:00:00Z");
    const archive = createPrismaLedgerBundleArchive({ prisma, storage: f.storage, now: () => now });
    const lease = { runId: "run", lockedBy: "old-worker", attemptNumber: 1 };
    expect(await archive.registerCandidate({ record: f.record, lease, key: "candidate.zip" })).toBe(
      false
    );
    expect(
      await archive.completeBundle({
        record: f.record,
        lease,
        key: "candidate.zip",
        entries: f.record.manifest.entries,
        expiresAt: new Date("2026-10-05")
      })
    ).toBe(false);
    expect(
      await archive.failBundle({
        requestId: f.record.requestId,
        lease,
        code: "LEDGER_PDF_BUNDLE_FAILED"
      })
    ).toBe(false);
    expect(tx.processingRun.findFirst).toHaveBeenCalledWith({
      where: {
        id: "run",
        ledgerArtifactRequestId: "r",
        jobType: "ledger_pdf_bundle",
        status: "running",
        lockedBy: "old-worker",
        attemptNumber: 1,
        lockedUntil: { gt: now }
      }
    });
    expect(tx.ledgerArtifactRequest.update).not.toHaveBeenCalled();
    expect(tx.storageGarbage.upsert).not.toHaveBeenCalled();
  });
  it("queues expired bundles independently and clears only expired matching pointers", async () => {
    const now = new Date("2026-10-04T00:00:00Z");
    const tx = {
      ledgerArtifactRequest: {
        findMany: vi.fn(async () => [{ id: "r", zipObjectKey: "expired.zip" }]),
        updateMany: vi.fn(async () => ({ count: 1 }))
      },
      storageGarbage: { upsert: vi.fn(async () => ({ objectKey: "expired.zip" })) }
    };
    const prisma = {
      $transaction: vi.fn(async (fn: (tx: unknown) => unknown) => fn(tx))
    } as unknown as PrismaClient;
    expect(await enqueueExpiredLedgerBundles(prisma, now)).toBe(1);
    expect(tx.storageGarbage.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({ objectKey: "expired.zip", repeatDeletion: false })
      })
    );
    expect(tx.ledgerArtifactRequest.updateMany).toHaveBeenCalledWith({
      where: { id: "r", zipObjectKey: "expired.zip", zipExpiresAt: { lte: now } },
      data: { zipObjectKey: null, zipExpiresAt: null }
    });
  });
});
