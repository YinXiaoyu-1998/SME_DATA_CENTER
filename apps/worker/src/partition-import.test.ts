import { createHash } from "node:crypto";
import { readdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getStructuredRegistry } from "@smedc/domain";
import type { StructuredPartitionRepository } from "@smedc/db";
import { LocalFileSystemStorageAdapter } from "@smedc/storage";
import { createPartitionImporter } from "./partition-import.js";
import type { ClaimedProcessingRun } from "./worker.js";

describe("partition importer", () => {
  let root: string | undefined;
  afterEach(async () => {
    if (root) await rm(root, { recursive: true, force: true });
    root = undefined;
  });

  it("publishes all daily store candidates then removes source and work files", async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "partition-worker-"));
    const storage = new LocalFileSystemStorageAdapter({ root: path.join(root, "storage") });
    const source = businessCsv(["2026-09-07", "2026-09-08"]);
    const sourceKey = "structured-import-staging/org_1/pjob_1/source";
    await storage.putObjectAtKey({
      key: sourceKey,
      body: Readable.from([source]),
      contentLength: source.length,
      checksumSha256: sha(source)
    });
    const publish = vi.fn(async () => ({ garbageObjectKeys: [] }));
    const repository = repositoryStub({ publishSourceAtomically: publish });
    const workRoot = path.join(root, "work");
    const importer = createPartitionImporter({ repository, limits: limits(workRoot) });
    await expect(importer.process({ run: claimed(sourceKey, source), storage })).resolves.toBe(
      "published"
    );
    expect(publish).toHaveBeenCalledWith(
      expect.objectContaining({
        orgId: "org_1",
        jobId: "pjob_1",
        totalRowCount: 2n,
        candidates: expect.arrayContaining([
          expect.objectContaining({ businessDate: "2026-09-07" }),
          expect.objectContaining({ businessDate: "2026-09-08" })
        ])
      })
    );
    await expect(storage.statObject(sourceKey)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readdir(workRoot)).toEqual([]);
  });

  it("uploads partition objects with the configured bounded concurrency", async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "partition-worker-"));
    const storage = new LocalFileSystemStorageAdapter({ root: path.join(root, "storage") });
    const source = businessCsv([
      "2026-09-01",
      "2026-09-02",
      "2026-09-03",
      "2026-09-04",
      "2026-09-05"
    ]);
    const sourceKey = "structured-import-staging/org_1/pjob_1/source";
    await storage.putObjectAtKey({
      key: sourceKey,
      body: Readable.from([source]),
      contentLength: source.length,
      checksumSha256: sha(source)
    });
    const originalPut = storage.putObjectAtKey.bind(storage);
    const originalStat = storage.statObject.bind(storage);
    let activeUploads = 0;
    let maximumActiveUploads = 0;
    let activeVerifications = 0;
    let maximumActiveVerifications = 0;
    storage.putObjectAtKey = async (input) => {
      activeUploads += 1;
      maximumActiveUploads = Math.max(maximumActiveUploads, activeUploads);
      await new Promise((resolve) => setTimeout(resolve, 10));
      try {
        return await originalPut(input);
      } finally {
        activeUploads -= 1;
      }
    };
    storage.statObject = async (key) => {
      activeVerifications += 1;
      maximumActiveVerifications = Math.max(maximumActiveVerifications, activeVerifications);
      await new Promise((resolve) => setTimeout(resolve, 10));
      try {
        return await originalStat(key);
      } finally {
        activeVerifications -= 1;
      }
    };
    const importer = createPartitionImporter({
      repository: repositoryStub({
        publishSourceAtomically: async () => ({ garbageObjectKeys: [] })
      }),
      limits: { ...limits(path.join(root, "work")), objectUploadConcurrency: 2 }
    });

    await expect(
      importer.process({
        run: claimed(sourceKey, source, {
          startDate: "2026-09-01",
          endDate: "2026-09-05"
        }),
        storage
      })
    ).resolves.toBe("published");

    expect(maximumActiveUploads).toBe(2);
    expect(maximumActiveVerifications).toBe(2);
  });

  it("rejects an invalid direct object-upload concurrency", () => {
    expect(() =>
      createPartitionImporter({
        repository: repositoryStub({}),
        limits: { ...limits("/tmp/unused-partition-work"), objectUploadConcurrency: 0 }
      })
    ).toThrow("objectUploadConcurrency must be an integer between 1 and 8");
  });

  it("removes every uploaded candidate and publishes nothing when verification fails", async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "partition-worker-"));
    const storage = new LocalFileSystemStorageAdapter({ root: path.join(root, "storage") });
    const source = businessCsv(["2026-09-01", "2026-09-02", "2026-09-03"]);
    const sourceKey = "structured-import-staging/org_1/pjob_1/source";
    await storage.putObjectAtKey({
      key: sourceKey,
      body: Readable.from([source]),
      contentLength: source.length,
      checksumSha256: sha(source)
    });
    const uploadedCandidateKeys: string[] = [];
    const originalPut = storage.putObjectAtKey.bind(storage);
    const originalStat = storage.statObject.bind(storage);
    storage.putObjectAtKey = async (input) => {
      const result = await originalPut(input);
      uploadedCandidateKeys.push(input.key);
      return result;
    };
    let candidateStats = 0;
    storage.statObject = async (key) => {
      if (key !== sourceKey && ++candidateStats === 2) throw new Error("verification unavailable");
      return originalStat(key);
    };
    const publish = vi.fn(async () => ({ garbageObjectKeys: [] }));
    const importer = createPartitionImporter({
      repository: repositoryStub({ publishSourceAtomically: publish }),
      limits: { ...limits(path.join(root, "work")), objectUploadConcurrency: 2 }
    });

    await expect(
      importer.process({
        run: claimed(sourceKey, source, {
          startDate: "2026-09-01",
          endDate: "2026-09-03"
        }),
        storage
      })
    ).rejects.toMatchObject({ code: "PARTITION_IMPORT_FAILED" });

    expect(uploadedCandidateKeys.length).toBeGreaterThan(0);
    for (const key of uploadedCandidateKeys) {
      await expect(originalStat(key)).rejects.toMatchObject({ code: "ENOENT" });
    }
    expect(publish).not.toHaveBeenCalled();
  });

  it("reports timings for every phase of a published partition import", async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "partition-worker-"));
    const storage = new LocalFileSystemStorageAdapter({ root: path.join(root, "storage") });
    const source = businessCsv(["2026-09-07", "2026-09-08"]);
    const sourceKey = "structured-import-staging/org_1/pjob_1/source";
    await storage.putObjectAtKey({
      key: sourceKey,
      body: Readable.from([source]),
      contentLength: source.length,
      checksumSha256: sha(source)
    });
    const timings: Array<{
      event: string;
      phase?: string;
      outcome?: string;
      durationMs?: number;
      startedAt?: string;
      finishedAt?: string;
      jobId: string;
      dataset: string;
      sourceFormat?: string;
      totalMs?: number;
      prepareMs?: number;
      structureReadMs?: number;
      mergeScanMs?: number;
      rowDecodeMs?: number;
      rowRoutingMs?: number;
      canonicalizeMs?: number;
      partitionWriteMs?: number;
      partitionFlushCount?: number;
      finalizeMs?: number;
    }> = [];
    const importer = createPartitionImporter({
      repository: repositoryStub({
        publishSourceAtomically: async () => ({ garbageObjectKeys: [] })
      }),
      limits: limits(path.join(root, "work")),
      onTimingEvent: (event) => timings.push(event)
    });

    await expect(importer.process({ run: claimed(sourceKey, source), storage })).resolves.toBe(
      "published"
    );

    expect(
      timings
        .filter(({ event }) => event === "partition_import_timing")
        .map(({ phase, outcome }) => ({ phase, outcome }))
    ).toEqual([
      { phase: "source_download", outcome: "completed" },
      { phase: "source_export", outcome: "completed" },
      { phase: "partition_upload_verify", outcome: "completed" },
      { phase: "atomic_publish", outcome: "completed" },
      { phase: "source_cleanup", outcome: "completed" },
      { phase: "work_directory_cleanup", outcome: "completed" },
      { phase: "total", outcome: "published" }
    ]);
    for (const timing of timings.filter(({ event }) => event === "partition_import_timing")) {
      expect(timing).toMatchObject({
        event: "partition_import_timing",
        jobId: "pjob_1",
        dataset: "business"
      });
      expect(timing.durationMs).toBeGreaterThanOrEqual(0);
      expect(Number.isNaN(Date.parse(timing.startedAt!))).toBe(false);
      expect(Number.isNaN(Date.parse(timing.finishedAt!))).toBe(false);
    }
    expect(timings.find(({ event }) => event === "partition_export_profile")).toMatchObject({
      event: "partition_export_profile",
      jobId: "pjob_1",
      dataset: "business",
      sourceFormat: "csv",
      totalMs: expect.any(Number),
      prepareMs: expect.any(Number),
      structureReadMs: 0,
      mergeScanMs: 0,
      rowDecodeMs: expect.any(Number),
      rowRoutingMs: expect.any(Number),
      canonicalizeMs: expect.any(Number),
      partitionWriteMs: expect.any(Number),
      partitionFlushCount: expect.any(Number),
      finalizeMs: expect.any(Number)
    });
  });

  it("rejects the whole source and publishes nothing when one row is invalid", async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "partition-worker-"));
    const storage = new LocalFileSystemStorageAdapter({ root: path.join(root, "storage") });
    const source = businessCsv(["2026-09-07", "not-a-date"]);
    const sourceKey = "structured-import-staging/org_1/pjob_1/source";
    await storage.putObjectAtKey({
      key: sourceKey,
      body: Readable.from([source]),
      contentLength: source.length,
      checksumSha256: sha(source)
    });
    const publish = vi.fn();
    const finish = vi.fn(async () => undefined);
    const importer = createPartitionImporter({
      repository: repositoryStub({ publishSourceAtomically: publish, finishJob: finish }),
      limits: limits(path.join(root, "work"))
    });
    await expect(importer.process({ run: claimed(sourceKey, source), storage })).resolves.toBe(
      "rejected"
    );
    expect(publish).not.toHaveBeenCalled();
    expect(finish).toHaveBeenCalledWith(expect.objectContaining({ status: "rejected" }));
  });

  it("rejects the whole source when a business date falls outside the declared range", async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "partition-worker-"));
    const storage = new LocalFileSystemStorageAdapter({ root: path.join(root, "storage") });
    const source = businessCsv(["2026-09-09"]);
    const sourceKey = "structured-import-staging/org_1/pjob_1/source";
    await storage.putObjectAtKey({
      key: sourceKey,
      body: Readable.from([source]),
      contentLength: source.length,
      checksumSha256: sha(source)
    });
    const publish = vi.fn();
    const finish = vi.fn(async () => undefined);
    const importer = createPartitionImporter({
      repository: repositoryStub({ publishSourceAtomically: publish, finishJob: finish }),
      limits: limits(path.join(root, "work"))
    });

    await expect(importer.process({ run: claimed(sourceKey, source), storage })).resolves.toBe(
      "rejected"
    );
    expect(publish).not.toHaveBeenCalled();
    expect(finish).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "rejected",
        errorCode: "PARTITION_SOURCE_DATE_OUT_OF_RANGE"
      })
    );
  });

  it("preserves committed partition objects when the database commit acknowledgement is lost", async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "partition-worker-"));
    const storage = new LocalFileSystemStorageAdapter({ root: path.join(root, "storage") });
    const source = businessCsv(["2026-09-07"]);
    const sourceKey = "structured-import-staging/org_1/pjob_1/source";
    await storage.putObjectAtKey({
      key: sourceKey,
      body: Readable.from([source]),
      contentLength: source.length,
      checksumSha256: sha(source)
    });
    const publish = vi.fn(
      async (input: Parameters<StructuredPartitionRepository["publishSourceAtomically"]>[0]) => {
        void input;
        throw new Error("connection closed after commit");
      }
    );
    const repository = repositoryStub({
      publishSourceAtomically: publish,
      findJobForStatus: async () => ({
        id: "pjob_1",
        orgId: "org_1",
        uploaderId: "emp_1",
        dataset: "business",
        enterpriseKey: "synthetic",
        enterpriseName: "Synthetic",
        confidentialityLevel: 0,
        originalFileName: "business.csv",
        mediaType: "text/csv",
        sourceByteSize: BigInt(source.length),
        sourceChecksumSha256: sha(source),
        sourceStartDate: new Date("2026-09-07T00:00:00.000Z"),
        sourceEndDate: new Date("2026-09-07T00:00:00.000Z"),
        temporaryObjectKey: null,
        multipartUploadId: null,
        status: "published",
        totalRowCount: 1n,
        partitionCount: 1,
        errorCode: null,
        errorSummary: null,
        validationErrors: [],
        expiresAt: new Date(Date.now() + 60_000),
        publishedAt: new Date(),
        finishedAt: new Date()
      })
    });
    const importer = createPartitionImporter({
      repository,
      limits: limits(path.join(root, "work"))
    });

    await expect(importer.process({ run: claimed(sourceKey, source), storage })).resolves.toBe(
      "published"
    );
    const publishedCandidate = publish.mock.calls[0]![0].candidates[0]!;
    await expect(storage.statObject(publishedCandidate.objectKey)).resolves.toMatchObject({
      key: publishedCandidate.objectKey
    });
    await expect(storage.statObject(sourceKey)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("aborts expired multipart sessions before marking their jobs expired", async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "partition-worker-"));
    const storage = new LocalFileSystemStorageAdapter({ root: path.join(root, "storage") });
    const sourceKey = "structured-import-staging/org_1/pjob_expired/source";
    const multipart = await storage.createMultipartUpload({ key: sourceKey });
    const abort = vi.spyOn(storage, "abortMultipartUpload");
    const finish = vi.fn(async () => undefined);
    const now = new Date("2026-09-15T00:00:00.000Z");
    const importer = createPartitionImporter({
      repository: repositoryStub({
        listExpiredUploads: async () => [
          {
            id: "pjob_expired",
            orgId: "org_1",
            temporaryObjectKey: sourceKey,
            multipartUploadId: multipart.uploadId
          }
        ],
        finishJob: finish,
        listDueGarbage: async () => [],
        deleteTerminalJobs: async () => 0
      }),
      limits: limits(path.join(root, "work"))
    });

    await importer.maintain({ storage, now });

    expect(abort).toHaveBeenCalledWith({ key: sourceKey, uploadId: multipart.uploadId });
    expect(finish).toHaveBeenCalledWith(
      expect.objectContaining({
        orgId: "org_1",
        jobId: "pjob_expired",
        status: "expired",
        errorCode: "PARTITION_UPLOAD_EXPIRED"
      })
    );
  });
});

function businessCsv(dates: string[]): Buffer {
  const headers = getStructuredRegistry("business")
    .fields.filter((field) => field.inputSource === "file")
    .map((field) => field.sourceColumn);
  const rows = dates.map((date) =>
    headers
      .map((header) =>
        header === "营业日期"
          ? date
          : header === "门店名称"
            ? "Store A"
            : header === "商户号"
              ? "001"
              : ""
      )
      .join(",")
  );
  return Buffer.from(`${headers.join(",")}\n${rows.join("\n")}\n`, "utf8");
}

function claimed(
  sourceKey: string,
  source: Buffer,
  window: { startDate: string; endDate: string } = {
    startDate: "2026-09-07",
    endDate: "2026-09-08"
  }
): ClaimedProcessingRun {
  return {
    id: "run_1",
    orgId: "org_1",
    documentId: "pjob_1",
    retryCount: 0,
    attemptNumber: 1,
    jobType: "structured_partition_import",
    lockedBy: "worker_1",
    lockedUntil: new Date(),
    document: null,
    partitionImport: {
      jobId: "pjob_1",
      dataset: "business",
      enterpriseKey: "synthetic",
      enterpriseName: "Synthetic",
      confidentialityLevel: 0,
      originalFileName: "business.csv",
      sourceByteSize: BigInt(source.length),
      sourceChecksumSha256: sha(source),
      sourceStartDate: window.startDate,
      sourceEndDate: window.endDate,
      temporaryObjectKey: sourceKey
    }
  };
}

function limits(workDirectory: string) {
  return {
    workDirectory,
    minFreeBytes: 1,
    jobRetentionDays: 30,
    maxSourceBytes: 10_000_000,
    maxRows: 100,
    maxPartitions: 100,
    maxCanonicalBytes: 10_000_000,
    maxOpenFiles: 4,
    objectUploadConcurrency: 1,
    maxStructuredCellChars: 1_000,
    maxXlsxSheets: 10,
    maxXlsxUncompressedBytes: 10_000_000,
    maxXlsxZipEntries: 10_000,
    maxXlsxCompressionRatio: 1_000
  };
}
function sha(bytes: Buffer) {
  return createHash("sha256").update(bytes).digest("hex");
}
function repositoryStub(
  overrides: Partial<StructuredPartitionRepository>
): StructuredPartitionRepository {
  const unused = async () => {
    throw new Error("unused");
  };
  return {
    reserveUpload: unused,
    queueCompletedUpload: unused,
    findJobForStatus: unused,
    markJobProcessing: unused,
    finishJob: unused,
    listExpiredUploads: unused,
    publishSourceAtomically: unused,
    listReadableManifestRows: unused,
    enqueueGarbage: async () => undefined,
    listDueGarbage: unused,
    deleteGarbage: unused,
    markObjectDeleted: async () => undefined,
    postponeGarbage: unused,
    deleteTerminalJobs: unused,
    ...overrides
  } as StructuredPartitionRepository;
}
