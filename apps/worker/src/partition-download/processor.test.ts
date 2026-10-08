import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import JSZip from "jszip";
import { describe, expect, it, vi } from "vitest";
import { loadPartitionDownloadLimits } from "@smedc/domain";
import type { CurrentPartitionDownload, PartitionDownloadRepository } from "@smedc/db";
import type { StorageAdapter } from "@smedc/storage";
import { buildPartitionDownload } from "./processor.js";
const body = Buffer.from("store,total\nSynthetic,1\n");
const hash = (b: Buffer) => createHash("sha256").update(b).digest("hex");
function fixture() {
  const current: CurrentPartitionDownload = {
    request: {
      requestId: "request",
      status: "running",
      partitionCount: 2,
      completedPartitionCount: 2,
      totalRowCount: "2",
      totalByteSize: String(body.length * 2),
      retryAfterSeconds: 1,
      errorCode: null,
      expiresAt: new Date(Date.now() + 3600000)
    },
    requester: { id: "actor", orgId: "org", clearance: 1, disabled: false },
    scope: {
      dataset: "business",
      enterpriseKey: "synthetic",
      enterpriseName: "Synthetic",
      startDate: "2026-10-01",
      endDate: "2026-10-01"
    },
    limits: loadPartitionDownloadLimits({}),
    artifact: null,
    manifest: ["one", "two"].map((id) => ({
      id,
      storeKey: id,
      storeName: "Same/Name",
      merchantId: null,
      enterpriseName: "Synthetic",
      businessDate: "2026-10-01",
      objectKey: `private/${id}`,
      checksumSha256: hash(body),
      byteSize: String(body.length),
      rowCount: "1",
      confidentialityLevel: 1
    }))
  };
  const repository = {
    markRunning: vi.fn().mockResolvedValue(current),
    recordProgress: vi.fn().mockResolvedValue(true),
    registerCandidate: vi.fn().mockResolvedValue(true),
    publish: vi.fn().mockResolvedValue(true),
    fail: vi.fn().mockResolvedValue(true)
  } as unknown as PartitionDownloadRepository;
  let uploaded: Buffer | undefined;
  const storage = {
    getObjectStream: vi.fn().mockImplementation(async () => Readable.from([body])),
    putObjectAtKey: vi.fn().mockImplementation(async (input) => {
      const chunks = [];
      for await (const c of input.body) chunks.push(c);
      uploaded = Buffer.concat(chunks);
      return { key: input.key, size: uploaded.length, hash: hash(uploaded) };
    })
  } as unknown as StorageAdapter;
  return {
    current,
    repository,
    storage,
    uploaded: () => uploaded,
    input: {
      requestId: "request",
      lease: {
        runId: "run",
        orgId: "org",
        requestId: "request",
        workerId: "worker",
        attemptNumber: 2
      },
      repository,
      storage
    }
  };
}
describe("partition ZIP worker", () => {
  it("streams every source on retry, publishes a verified ZIP and unique safe manifest filenames", async () => {
    const f = fixture();
    expect(await buildPartitionDownload(f.input)).toBe("succeeded");
    const zip = await JSZip.loadAsync(f.uploaded()!);
    const manifest = JSON.parse(await zip.file("manifest.json")!.async("string"));
    expect(manifest).toMatchObject({ version: 1, partitionCount: 2, totalRowCount: "2" });
    expect(new Set(manifest.files.map((file: { fileName: string }) => file.fileName)).size).toBe(2);
    expect(JSON.stringify(manifest)).not.toMatch(/private|confidentiality|objectKey/);
    for (const file of manifest.files)
      expect(await zip.file(file.fileName)!.async("nodebuffer")).toEqual(body);
    expect(f.repository.recordProgress).toHaveBeenNthCalledWith(1, f.input.lease, 2);
    expect(f.repository.publish).toHaveBeenCalledWith(
      f.input.lease,
      expect.objectContaining({
        byteSize: BigInt(f.uploaded()!.length),
        checksumSha256: hash(f.uploaded()!)
      })
    );
  });
  it.each(["hash", "short", "long"])(
    "rejects %s source mismatch without uploading",
    async (mode) => {
      const f = fixture();
      vi.mocked(f.storage.getObjectStream).mockResolvedValue(
        Readable.from([
          mode === "hash"
            ? Buffer.alloc(body.length)
            : mode === "short"
              ? body.subarray(1)
              : Buffer.concat([body, body])
        ])
      );
      await expect(buildPartitionDownload(f.input)).rejects.toThrow(
        "PARTITION_DOWNLOAD_SOURCE_INVALID"
      );
      expect(f.repository.fail).toHaveBeenCalledWith(
        f.input.lease,
        "PARTITION_DOWNLOAD_SOURCE_INVALID"
      );
      expect(f.storage.putObjectAtKey).not.toHaveBeenCalled();
      expect(f.repository.publish).not.toHaveBeenCalled();
    }
  );
  it("registers candidate before a failed upload so garbage collection owns cleanup", async () => {
    const f = fixture();
    vi.mocked(f.storage.putObjectAtKey!).mockImplementation(async () => {
      expect(f.repository.registerCandidate).toHaveBeenCalled();
      throw new Error("network");
    });
    await expect(buildPartitionDownload(f.input)).rejects.toThrow("PARTITION_DOWNLOAD_FAILED");
    expect(f.repository.publish).not.toHaveBeenCalled();
    expect(f.repository.fail).not.toHaveBeenCalled();
  });
  it("keeps an interrupted source response retryable without finalizing the request", async () => {
    const f = fixture();
    vi.mocked(f.storage.getObjectStream).mockResolvedValue(
      Readable.from(
        (async function* () {
          yield body.subarray(0, 4);
          throw new Error("synthetic interrupted response");
        })()
      )
    );
    await expect(buildPartitionDownload(f.input)).rejects.toMatchObject({
      code: "PARTITION_DOWNLOAD_FAILED",
      retryable: true
    });
    expect(f.repository.fail).not.toHaveBeenCalled();
    expect(f.storage.putObjectAtKey).not.toHaveBeenCalled();
  });
  // Prisma tests cover stale publication and expired/reclaimed leases; revoked
  // authority is covered by URL validation. This proves only the false-return reaction.
  it("does not finalize when publication is fenced", async () => {
    const f = fixture();
    vi.mocked(f.repository.publish).mockResolvedValue(false);
    expect(await buildPartitionDownload(f.input)).toBe("superseded");
    expect(f.repository.fail).not.toHaveBeenCalled();
  });
  it("skips ZIP for already succeeded empty scopes", async () => {
    const f = fixture();
    vi.mocked(f.repository.markRunning).mockResolvedValue(false);
    expect(await buildPartitionDownload(f.input)).toBe("superseded");
    expect(f.storage.getObjectStream).not.toHaveBeenCalled();
  });
  it("uses snapshotted raw limits", async () => {
    const f = fixture();
    f.current.limits.partitionDownloadMaxBytes = 1;
    await expect(buildPartitionDownload(f.input)).rejects.toThrow(
      "PARTITION_DOWNLOAD_LIMIT_EXCEEDED"
    );
    expect(f.storage.getObjectStream).not.toHaveBeenCalled();
  });
});

it("cancels a stalled source and removes scratch without uploading", async () => {
  const { mkdtemp, readdir, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const root = await mkdtemp(join(tmpdir(), "partition-abort-test-"));
  const f = fixture();
  const source = new Readable({ read() {} });
  vi.mocked(f.storage.getObjectStream).mockResolvedValue(source);
  try {
    await expect(
      buildPartitionDownload({ ...f.input, limits: { scratchRoot: root, deadlineMs: 20 } })
    ).rejects.toThrow("PARTITION_DOWNLOAD_FAILED");
    expect(source.destroyed).toBe(true);
    expect(await readdir(root)).toEqual([]);
    expect(f.storage.putObjectAtKey).not.toHaveBeenCalled();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
