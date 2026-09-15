import { createHash } from "node:crypto";
import { readdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getStructuredRegistry } from "@enterprise-hub/domain";
import type { StructuredPartitionRepository } from "@enterprise-hub/db";
import { LocalFileSystemStorageAdapter } from "@enterprise-hub/storage";
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
        enterpriseKey: "maijia",
        enterpriseName: "Maijia",
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

function claimed(sourceKey: string, source: Buffer): ClaimedProcessingRun {
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
      enterpriseKey: "maijia",
      enterpriseName: "Maijia",
      confidentialityLevel: 0,
      originalFileName: "business.csv",
      sourceByteSize: BigInt(source.length),
      sourceChecksumSha256: sha(source),
      sourceStartDate: "2026-09-07",
      sourceEndDate: "2026-09-08",
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
