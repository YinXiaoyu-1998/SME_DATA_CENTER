import { createHash } from "node:crypto";
import { mkdtemp, readdir, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { LedgerSnapshot } from "@smedc/ledger-archive";
import type { StorageAdapter } from "@smedc/storage";
import {
  processLedgerPdf,
  cleanupLedgerScratch,
  type LedgerGenerationArchive,
  type LedgerPdfRenderer
} from "./processor.js";
import type { ClaimedProcessingRun } from "../worker.js";
const content = Buffer.from("%PDF-synthetic");
const checksum = createHash("sha256").update(content).digest("hex");
const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true }))
  );
});
async function fixture() {
  const scratchRoot = await mkdtemp(join(tmpdir(), "smedc-ledger-test-"));
  directories.push(scratchRoot);
  const key = { orgId: "synthetic", storeName: "Store", purchaseDate: "2026-10-01" };
  const snapshot: LedgerSnapshot = {
    key,
    dataRevision: 5,
    sourceFingerprint: "f".repeat(64),
    sources: [],
    certificates: [],
    confidentialityLevel: 0,
    rows: [{} as LedgerSnapshot["rows"][number]]
  };
  const run = {
    id: "run",
    orgId: key.orgId,
    jobType: "ledger_pdf_generate",
    attemptNumber: 2,
    lockedBy: "worker"
  } as ClaimedProcessingRun;
  const archive: LedgerGenerationArchive = {
    getGeneration: vi.fn(async () => ({ key, generation: 3, partitionId: "partition" })),
    readLedgerSnapshot: vi.fn(async () => snapshot),
    registerCandidate: vi.fn(async () => {}),
    publishLedgerPdf: vi.fn(async () => "published" as const),
    leaseIsActive: vi.fn(async () => true)
  };
  const storage = {
    putObjectAtKey: vi.fn(async (input) => {
      for await (const chunk of input.body) {
        expect(chunk.length).toBeGreaterThan(0);
      }
      return { key: input.key, size: content.length, hash: checksum };
    }),
    headObject: vi.fn(async () => ({ state: "found", size: content.length, hash: checksum })),
    deleteObject: vi.fn(),
    getObjectStream: vi.fn(async () => Readable.from([Buffer.from("bad")])),
    keyPrefix: "physical"
  } as unknown as StorageAdapter;
  const renderer: LedgerPdfRenderer = vi.fn(async (input) => {
    const path = join(input.workDirectory, "output.pdf");
    await writeFile(path, content);
    return { path, byteSize: content.length, checksumSha256: checksum, pageCount: 1 };
  });
  return { run, archive, renderer, storage, scratchRoot, snapshot };
}
describe("ledger PDF worker generation", () => {
  it("registers unique candidate before upload, verifies it, and publishes snapshot revision", async () => {
    const input = await fixture();
    expect(await processLedgerPdf(input)).toEqual({ status: "published" });
    const publication = vi.mocked(input.archive.publishLedgerPdf).mock.calls[0]![0];
    expect(publication).toMatchObject({
      generation: 3,
      dataRevision: 5,
      leaseToken: { runId: "run", lockedBy: "worker", attemptNumber: 2 }
    });
    expect(publication.candidate?.objectKey).toMatch(/台账_3-[0-9a-f-]{36}\.pdf$/);
    expect(vi.mocked(input.archive.registerCandidate).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(input.storage.putObjectAtKey!).mock.invocationCallOrder[0]!
    );
    expect(await readdir(input.scratchRoot)).toEqual([]);
  });
  it("leaves current untouched and durable candidate registration on upload failure", async () => {
    const input = await fixture();
    vi.mocked(input.storage.putObjectAtKey!).mockRejectedValueOnce(new Error("upload unavailable"));
    await expect(processLedgerPdf(input)).rejects.toThrow("upload unavailable");
    expect(input.archive.publishLedgerPdf).not.toHaveBeenCalled();
    expect(input.storage.deleteObject).not.toHaveBeenCalled();
    expect(input.archive.registerCandidate).toHaveBeenCalledOnce();
    expect(await readdir(input.scratchRoot)).toEqual([]);
  });
  it("retains durable recovery on DB errors because a lost commit acknowledgement is ambiguous", async () => {
    const input = await fixture();
    vi.mocked(input.archive.publishLedgerPdf).mockRejectedValueOnce(new Error("DB unavailable"));
    await expect(processLedgerPdf(input)).rejects.toThrow("DB unavailable");
    expect(input.archive.registerCandidate).toHaveBeenCalledOnce();
    expect(input.storage.deleteObject).not.toHaveBeenCalled();
  });
  it("refuses mismatched HEAD checksum", async () => {
    const input = await fixture();
    vi.mocked(input.storage.headObject).mockResolvedValueOnce({
      state: "found",
      size: content.length,
      hash: "0".repeat(64)
    });
    await expect(processLedgerPdf(input)).rejects.toThrow("LEDGER_UPLOAD_VERIFICATION_FAILED");
    expect(input.archive.publishLedgerPdf).not.toHaveBeenCalled();
  });
  it("publishes empty without rendering or source object deletion", async () => {
    const input = await fixture();
    input.snapshot.rows = [];
    expect(await processLedgerPdf(input)).toEqual({ status: "empty" });
    expect(input.renderer).not.toHaveBeenCalled();
    expect(input.storage.deleteObject).not.toHaveBeenCalled();
    expect(input.archive.publishLedgerPdf).toHaveBeenCalledWith(
      expect.objectContaining({ candidate: null, rowCount: 0 })
    );
  });
  it("rejects a corrupt certificate before conversion", async () => {
    const input = await fixture();
    input.snapshot.certificates = [
      {
        sourceDocumentId: "photo",
        receiptId: "r",
        storageObjectKey: "original-photo",
        checksumSha256: "0".repeat(64),
        contentType: "image/png",
        byteSize: 3,
        uploadedAt: "2026-10-01T00:00:00Z"
      }
    ];
    await expect(processLedgerPdf(input)).rejects.toThrow("LEDGER_CERTIFICATE_INVALID");
    expect(input.renderer).not.toHaveBeenCalled();
  });
  it("honors cancellation after source reading and before an empty publication", async () => {
    const input = await fixture();
    const controller = new AbortController();
    input.snapshot.rows = [];
    vi.mocked(input.archive.readLedgerSnapshot).mockImplementationOnce(async () => {
      controller.abort();
      return input.snapshot;
    });
    await expect(processLedgerPdf({ ...input, signal: controller.signal })).rejects.toThrow(
      "LEDGER_RENDER_ABORTED"
    );
    expect(input.archive.publishLedgerPdf).not.toHaveBeenCalled();
  });
  it("protects a directory created immediately before a crash writing its lease manifest", async () => {
    const input = await fixture();
    const name = "ledger-job-run.2.ffffffff-ffff-ffff-ffff-ffffffffffff";
    await mkdir(join(input.scratchRoot, name));
    await cleanupLedgerScratch(input);
    expect(await readdir(input.scratchRoot)).toEqual([name]);
    expect(input.archive.leaseIsActive).toHaveBeenCalledWith({ runId: "run", attemptNumber: 2 });
    vi.mocked(input.archive.leaseIsActive).mockResolvedValueOnce(false);
    await cleanupLedgerScratch(input);
    expect(await readdir(input.scratchRoot)).toEqual([]);
  });
  it("uses a new immutable candidate for every retry", async () => {
    const input = await fixture();
    await processLedgerPdf(input);
    await processLedgerPdf(input);
    const keys = vi
      .mocked(input.archive.registerCandidate)
      .mock.calls.map(([value]) => value.objectKey);
    expect(new Set(keys).size).toBe(2);
  });
  it("reclaims only scratch directories whose exact lease has ended", async () => {
    const input = await fixture();
    const path = join(input.scratchRoot, "ledger-job-crash");
    await mkdir(path);
    await writeFile(
      join(path, "lease.json"),
      JSON.stringify({ runId: "run", lockedBy: "worker", attemptNumber: 2 })
    );
    await cleanupLedgerScratch(input);
    expect(await readdir(input.scratchRoot)).toEqual(["ledger-job-crash"]);
    vi.mocked(input.archive.leaseIsActive).mockResolvedValueOnce(false);
    await cleanupLedgerScratch(input);
    expect(await readdir(input.scratchRoot)).toEqual([]);
  });
});
