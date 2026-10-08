import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import { loadPartitionDownloadLimits } from "@smedc/domain";
import { mkdtemp, readdir, rm, mkdir, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { CurrentPartitionDownload, PartitionDownloadRepository } from "@smedc/db";
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
    const work = expect(runtime.job.process({ run, storage })).rejects.toMatchObject({
      retryable: true
    });
    await runtime.disconnect();
    await work;
    expect(repository.fail).not.toHaveBeenCalled();
    expect(repository.disconnect).toHaveBeenCalledTimes(1);
  });
  it.each(["recover", "exhaust", "invalid"])(
    "uses the actual builder and fenced scheduler for %s",
    async (mode) => {
      const body = Buffer.from("store,total\nSynthetic,1\n");
      const current: CurrentPartitionDownload = {
        request: {
          requestId: "request",
          status: "running",
          partitionCount: 1,
          completedPartitionCount: 0,
          totalRowCount: "1",
          totalByteSize: String(body.length),
          retryAfterSeconds: 1,
          errorCode: null,
          expiresAt: new Date(Date.now() + 3600000)
        },
        requester: { id: "employee", orgId: "org", clearance: 1, disabled: false },
        scope: {
          dataset: "business",
          enterpriseName: "Synthetic",
          enterpriseKey: "synthetic",
          startDate: "2026-10-01",
          endDate: "2026-10-01"
        },
        limits: loadPartitionDownloadLimits({}),
        artifact: null,
        manifest: [
          {
            id: "source",
            storeKey: "one",
            storeName: "Synthetic",
            merchantId: null,
            enterpriseName: "Synthetic",
            businessDate: "2026-10-01",
            objectKey: "source",
            checksumSha256: createHash("sha256").update(body).digest("hex"),
            byteSize: String(body.length),
            rowCount: "1",
            confidentialityLevel: 0
          }
        ]
      };
      const domain = {
        markRunning: vi.fn(async () => current),
        recordProgress: vi.fn(async (_lease, completed) => {
          current.request.completedPartitionCount = completed;
          return true;
        }),
        registerCandidate: vi.fn(async () => true),
        publish: vi.fn(async () => true),
        fail: vi.fn(async () => true),
        disconnect: vi.fn(async () => {})
      } as unknown as PartitionDownloadRepository;
      let attempt = 0;
      const scheduler = {
        claimNextProcessingRun: vi.fn(async () => ({ ...run, attemptNumber: ++attempt })),
        failProcessingRun: vi.fn(async (failure) => {
          if (!failure.willRetry)
            await domain.fail(
              {
                runId: run.id,
                orgId: run.orgId,
                requestId: "request",
                workerId: "worker",
                attemptNumber: attempt
              },
              failure.errorCode
            );
        })
      } as unknown as ProcessingWorkerRepository;
      const storage = {
        getObjectStream: vi.fn(async () =>
          Readable.from([mode === "invalid" ? Buffer.alloc(body.length) : body])
        ),
        putObjectAtKey: vi.fn(async (input) => {
          for await (const chunk of input.body as AsyncIterable<Buffer>) {
            expect(chunk.length).toBeGreaterThan(0);
            /* drain the synthetic upload */
          }
          if (mode === "exhaust" || attempt === 1)
            throw new Error("transient synthetic upload failure");
          return { key: input.key, size: body.length, hash: "synthetic" };
        })
      } as unknown as StorageAdapter;
      const runtime = createPartitionDownloadRuntime({ repository: domain, storage });
      const once = () =>
        runWorkerOnce({
          repository: scheduler,
          storage,
          partitionDownloadJob: runtime.job,
          workerId: "worker",
          maxAttempts: 2
        });
      try {
        if (mode === "invalid") {
          expect(await once()).toMatchObject({ status: "processing_failed" });
          expect(domain.fail).toHaveBeenCalledWith(
            expect.anything(),
            "PARTITION_DOWNLOAD_SOURCE_INVALID"
          );
          expect(scheduler.failProcessingRun).not.toHaveBeenCalled();
          expect(storage.putObjectAtKey).not.toHaveBeenCalled();
        } else {
          expect(await once()).toMatchObject({ status: "retry_scheduled" });
          expect(domain.fail).not.toHaveBeenCalled();
          expect(scheduler.failProcessingRun).toHaveBeenLastCalledWith(
            expect.objectContaining({
              willRetry: true,
              attemptNumber: 1,
              errorCode: "PARTITION_DOWNLOAD_FAILED"
            })
          );
          expect(await once()).toMatchObject({
            status: mode === "recover" ? "active" : "processing_failed"
          });
          expect(domain.registerCandidate).toHaveBeenCalledTimes(2);
          expect(domain.recordProgress).toHaveBeenNthCalledWith(
            2,
            expect.objectContaining({ attemptNumber: 2 }),
            1
          );
          if (mode === "exhaust") {
            expect(scheduler.failProcessingRun).toHaveBeenLastCalledWith(
              expect.objectContaining({ willRetry: false, attemptNumber: 2 })
            );
            expect(domain.fail).toHaveBeenCalledTimes(1);
          } else {
            expect(domain.publish).toHaveBeenCalledWith(
              expect.objectContaining({ attemptNumber: 2 }),
              expect.anything()
            );
            expect(domain.fail).not.toHaveBeenCalled();
          }
        }
      } finally {
        await runtime.disconnect();
      }
    }
  );
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
