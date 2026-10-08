import { mkdtemp, readdir, rm, mkdir, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { PartitionDownloadRepository } from "@smedc/db";
import type { StorageAdapter } from "@smedc/storage";
import { createPartitionDownloadRuntime } from "./runtime.js";
import {
  runWorkerOnce,
  type ClaimedProcessingRun,
  type ProcessingWorkerRepository
} from "../worker.js";
const run: ClaimedProcessingRun = {
  id: "run",
  orgId: "org",
  documentId: "run",
  jobType: "structured_partition_bundle",
  partitionDownloadRequestId: "request",
  retryCount: 0,
  attemptNumber: 1,
  lockedBy: "worker",
  lockedUntil: new Date(Date.now() + 60000),
  document: null
};
const storage = {} as StorageAdapter;
describe("partition runtime", () => {
  it("fails missing handlers and never invokes generic completion after domain completion", async () => {
    const repository = {
      claimNextProcessingRun: vi.fn().mockResolvedValue(run),
      failProcessingRun: vi.fn(),
      completePartitionProcessing: vi.fn()
    } as unknown as ProcessingWorkerRepository;
    expect(await runWorkerOnce({ repository, storage })).toMatchObject({
      status: "processing_failed"
    });
    expect(repository.failProcessingRun).toHaveBeenCalledWith(
      expect.objectContaining({ willRetry: false, errorCode: "UNSUPPORTED_PROCESSING_JOB_TYPE" })
    );
    vi.mocked(repository.failProcessingRun).mockClear();
    for (const outcome of ["succeeded", "failed", "superseded"] as const)
      await runWorkerOnce({
        repository,
        storage,
        partitionDownloadJob: { process: vi.fn().mockResolvedValue(outcome) }
      });
    expect(repository.completePartitionProcessing).not.toHaveBeenCalled();
    expect(repository.failProcessingRun).not.toHaveBeenCalled();
  });
  it("aborts active work and waits for cleanup before disconnecting", async () => {
    const repository = {
      markRunning: vi.fn().mockImplementation(() => new Promise(() => {})),
      fail: vi.fn().mockResolvedValue(true),
      disconnect: vi.fn()
    } as unknown as PartitionDownloadRepository;
    const runtime = createPartitionDownloadRuntime({ storage, repository });
    const work = runtime.job.process({ run, storage });
    await runtime.disconnect();
    expect(await work).toBe("failed");
    expect(repository.fail).toHaveBeenCalled();
    expect(repository.disconnect).toHaveBeenCalledTimes(1);
  });
  it("coalesces expiry cycles, removes stale owned scratch, and disconnects", async () => {
    const root = await mkdtemp(join(tmpdir(), "partition-runtime-test-"));
    const repository = {
      expire: vi.fn().mockResolvedValue(0),
      disconnect: vi.fn()
    } as unknown as PartitionDownloadRepository;
    const runtime = createPartitionDownloadRuntime({
      storage,
      repository,
      buildLimits: { scratchRoot: root }
    });
    try {
      const stale = join(root, "smedc-partition-zip-stale");
      await mkdir(stale);
      await utimes(stale, new Date(0), new Date(0));
      await mkdir(join(root, "unrelated"));
      await Promise.all([runtime.maintain(), runtime.maintain()]);
      await runtime.maintain();
      expect(repository.expire).toHaveBeenCalledTimes(1);
      expect(await readdir(root)).toEqual(["unrelated"]);
      await runtime.disconnect();
      await runtime.maintain();
      expect(repository.disconnect).toHaveBeenCalledTimes(1);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
