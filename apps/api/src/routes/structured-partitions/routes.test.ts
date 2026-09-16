import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import Fastify from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LocalFileSystemStorageAdapter } from "@smedc/storage";
import { loadApiRuntimeLimits } from "../../config/runtime-limits.js";
import type { RequestAuth } from "../../request-auth.js";
import type {
  PartitionImportJobRecord,
  StructuredPartitionRepository
} from "../../structured-partitions.js";
import { registerStructuredPartitionRoutes } from "./routes.js";

const employee = {
  id: "emp_1",
  orgId: "org_1",
  displayName: "One",
  email: "one@example.invalid",
  role: "employee" as const,
  clearance: 1,
  disabled: false
};
const auth = {
  authenticate: vi.fn(async () => true),
  employee: vi.fn(() => employee)
} as unknown as RequestAuth;

describe("structured partition routes", () => {
  let root: string | undefined;
  afterEach(async () => {
    if (root) await rm(root, { recursive: true, force: true });
    root = undefined;
  });

  it("creates a bounded multipart upload session without returning object keys", async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "partition-route-"));
    const storage = new LocalFileSystemStorageAdapter({ root });
    let job: PartitionImportJobRecord | null = null;
    const repository = repositoryStub({
      reserveUpload: async (input) => {
        job = {
          id: input.id!,
          orgId: input.orgId,
          uploaderId: input.uploaderId,
          dataset: input.dataset,
          enterpriseKey: input.enterpriseKey,
          enterpriseName: input.enterpriseName,
          confidentialityLevel: input.confidentialityLevel,
          originalFileName: input.originalFileName,
          mediaType: input.mediaType,
          sourceByteSize: input.sourceByteSize,
          sourceChecksumSha256: input.sourceChecksumSha256,
          sourceStartDate: new Date(`${input.sourceStartDate}T00:00:00.000Z`),
          sourceEndDate: new Date(`${input.sourceEndDate}T00:00:00.000Z`),
          temporaryObjectKey: input.temporaryObjectKey,
          multipartUploadId: input.multipartUploadId,
          status: "uploading",
          totalRowCount: 0n,
          partitionCount: 0,
          errorCode: null,
          errorSummary: null,
          validationErrors: [],
          expiresAt: input.expiresAt,
          publishedAt: null,
          finishedAt: null
        };
        return { state: "created", job };
      },
      findJobForStatus: async () => job
    });
    const app = Fastify();
    registerStructuredPartitionRoutes(app, {
      auth,
      storage: () => storage,
      partitions: () => repository,
      runtimeLimits: loadApiRuntimeLimits({})
    });
    const response = await app.inject({
      method: "POST",
      url: "/v1/structured/partition-uploads",
      payload: {
        dataset: "business",
        enterpriseName: " Synthetic ",
        startDate: "2026-09-07",
        endDate: "2026-09-13",
        originalFileName: "business.xlsx",
        mediaType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        sourceByteSize: 20_000_000,
        sourceChecksumSha256: "a".repeat(64),
        idempotencyKey: "idem-1"
      }
    });
    expect(response.statusCode).toBe(201);
    expect(response.json()).toMatchObject({
      status: "uploading",
      partSize: 16_777_216,
      totalParts: 2,
      parts: [{ partNumber: 1 }, { partNumber: 2 }]
    });
    expect(response.body).not.toContain("structured-import-staging");
    await app.close();
  });

  it("builds an authorized manifest and never includes object keys", async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "partition-route-"));
    const storage = new LocalFileSystemStorageAdapter({ root });
    const list = vi.fn(async () => [
      {
        id: "part_1",
        orgId: "org_1",
        enterpriseKey: "synthetic",
        enterpriseName: "Synthetic",
        dataset: "business" as const,
        storeKey: "merchant:001",
        merchantId: "001",
        storeName: "Store A",
        businessDate: new Date("2026-09-07T00:00:00Z"),
        objectKey: "structured-partitions/org_1/pjob_1/part_1.csv",
        rowCount: 4n,
        byteSize: 20n,
        checksumSha256: "b".repeat(64),
        confidentialityLevel: 1,
        publishedByJobId: "pjob_1"
      }
    ]);
    const repository = repositoryStub({ listReadableManifestRows: list });
    const app = Fastify();
    registerStructuredPartitionRoutes(app, {
      auth,
      storage: () => storage,
      partitions: () => repository,
      runtimeLimits: loadApiRuntimeLimits({})
    });
    const response = await app.inject({
      method: "POST",
      url: "/v1/structured/partition-manifests",
      payload: {
        dataset: "business",
        enterpriseName: "Synthetic",
        startDate: "2026-09-07",
        endDate: "2026-09-13"
      }
    });
    expect(response.statusCode).toBe(200);
    expect(list).toHaveBeenCalledWith(
      expect.objectContaining({ orgId: "org_1", clearance: 1, enterpriseKey: "synthetic" })
    );
    expect(response.json()).toMatchObject({
      partitionCount: 1,
      totalRowCount: 4,
      partitions: [{ storeId: "001", rowCount: 4 }]
    });
    expect(response.body).not.toContain("objectKey");
    await app.close();
  });

  it("queues an already completed source without completing the multipart upload twice", async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "partition-route-"));
    const storage = new LocalFileSystemStorageAdapter({ root });
    const bytes = Buffer.from("abc");
    const checksum = createHash("sha256").update(bytes).digest("hex");
    const objectKey = "structured-import-staging/org_1/pjob_1/source";
    await storage.putObjectAtKey!({
      key: objectKey,
      body: Readable.from(bytes),
      contentLength: bytes.byteLength,
      checksumSha256: checksum
    });
    const complete = vi.spyOn(storage, "completeMultipartUpload");
    const job: PartitionImportJobRecord = {
      id: "pjob_1",
      orgId: "org_1",
      uploaderId: employee.id,
      dataset: "business",
      enterpriseKey: "synthetic",
      enterpriseName: "Synthetic",
      confidentialityLevel: 0,
      originalFileName: "business.csv",
      mediaType: "text/csv",
      sourceByteSize: BigInt(bytes.byteLength),
      sourceChecksumSha256: checksum,
      sourceStartDate: new Date("2026-09-07T00:00:00.000Z"),
      sourceEndDate: new Date("2026-09-07T00:00:00.000Z"),
      temporaryObjectKey: objectKey,
      multipartUploadId: "already-completed",
      status: "uploading",
      totalRowCount: 0n,
      partitionCount: 0,
      errorCode: null,
      errorSummary: null,
      validationErrors: [],
      expiresAt: new Date(Date.now() + 60_000),
      publishedAt: null,
      finishedAt: null
    };
    const queueCompletedUpload = vi.fn(async () => ({ ...job, status: "queued" as const }));
    const repository = repositoryStub({
      findJobForStatus: async () => job,
      queueCompletedUpload
    });
    const app = Fastify();
    registerStructuredPartitionRoutes(app, {
      auth,
      storage: () => storage,
      partitions: () => repository,
      runtimeLimits: loadApiRuntimeLimits({})
    });

    const response = await app.inject({
      method: "POST",
      url: "/v1/structured/partition-uploads/pjob_1/complete",
      payload: { parts: [{ partNumber: 1, etag: "etag-1" }] }
    });

    expect(response.statusCode).toBe(202);
    expect(complete).not.toHaveBeenCalled();
    expect(queueCompletedUpload).toHaveBeenCalledWith({
      orgId: "org_1",
      jobId: "pjob_1",
      temporaryObjectKey: objectKey
    });
    await app.close();
  });
});

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
    publishSourceAtomically: unused,
    listReadableManifestRows: unused,
    enqueueGarbage: unused,
    listDueGarbage: unused,
    deleteGarbage: unused,
    markObjectDeleted: unused,
    postponeGarbage: unused,
    deleteTerminalJobs: unused,
    ...overrides
  } as StructuredPartitionRepository;
}
