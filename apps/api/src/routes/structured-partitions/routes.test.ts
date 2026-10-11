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
  organizationName: "Synthetic",
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

const auditContext = {
  requestId: "req_partition_denied",
  sourceIp: "127.0.0.1",
  clientSource: "http_api" as const,
  launcherVersion: null
};
const adminAuth = { ...auth, employee: () => ({ ...employee, role: "admin" as const }) };
const unusedAudit = {
  createBusinessRequestAudit: () => auditContext,
  uploadAuthorizationAudit: () => {
    throw new Error("admin must not initialize audit repository");
  }
};

describe("structured partition routes", () => {
  it.each([
    ["POST", "/v1/structured/partition-uploads"],
    ["GET", "/v1/structured/partition-uploads/pjob_employee/parts"],
    ["POST", "/v1/structured/partition-uploads/pjob_employee/complete"]
  ] as const)(
    "denies employee %s %s before inspecting data or initializing dependencies",
    async (method, url) => {
      const app = Fastify({ genReqId: () => auditContext.requestId });
      const appendDenied = vi.fn(async () => {});
      const storage = vi.fn(() => {
        throw new Error("storage must not initialize");
      });
      const partitions = vi.fn(() => {
        throw new Error("repository must not initialize");
      });
      const inspectDataset = vi.fn(() => {
        throw new Error("dataset must not be inspected");
      });
      app.addHook("preHandler", async (request) => {
        request.body = Object.defineProperty({}, "dataset", { get: inspectDataset });
      });
      registerStructuredPartitionRoutes(app, {
        auth,
        storage,
        partitions,
        runtimeLimits: loadApiRuntimeLimits({}),
        createBusinessRequestAudit: () => auditContext,
        uploadAuthorizationAudit: () => ({ appendDenied })
      });
      try {
        const response = await app.inject({ method, url });
        expect(response.statusCode).toBe(403);
        expect(response.json()).toEqual({
          error: {
            code: "UPLOAD_ADMIN_REQUIRED",
            message: "File upload requires the admin role.",
            retryable: false,
            details: {},
            requestId: auditContext.requestId
          }
        });
        expect(appendDenied).toHaveBeenCalledExactlyOnceWith({
          orgId: employee.orgId,
          actorEmployeeId: employee.id,
          uploadSurface: "structured_dataset",
          audit: auditContext
        });
        expect(inspectDataset).not.toHaveBeenCalled();
        expect(storage).not.toHaveBeenCalled();
        expect(partitions).not.toHaveBeenCalled();
      } finally {
        await app.close();
      }
    }
  );

  it("keeps the canonical denial when initializing the audit repository fails", async () => {
    const app = Fastify();
    const initializeAudit = vi.fn(() => {
      throw new Error("sensitive configuration");
    });
    const logAuditFailure = vi.fn();
    app.addHook("onRequest", async (request) => {
      request.log.error = logAuditFailure;
    });
    registerStructuredPartitionRoutes(app, {
      auth,
      storage: () => {
        throw new Error("unused");
      },
      partitions: () => {
        throw new Error("unused");
      },
      runtimeLimits: loadApiRuntimeLimits({}),
      createBusinessRequestAudit: () => auditContext,
      uploadAuthorizationAudit: initializeAudit
    });
    try {
      const response = await app.inject({
        method: "POST",
        url: "/v1/structured/partition-uploads",
        payload: {}
      });
      expect(response.statusCode).toBe(403);
      expect(response.json().error.code).toBe("UPLOAD_ADMIN_REQUIRED");
      expect(initializeAudit).toHaveBeenCalledTimes(1);
      expect(logAuditFailure).toHaveBeenCalledExactlyOnceWith(
        { requestId: auditContext.requestId, uploadSurface: "structured_dataset" },
        "upload denial audit failed"
      );
    } finally {
      await app.close();
    }
  });
  let root: string | undefined;
  afterEach(async () => {
    if (root) await rm(root, { recursive: true, force: true });
    root = undefined;
  });

  it("creates a bounded multipart upload session without returning object keys", async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "partition-route-"));
    const storage = new LocalFileSystemStorageAdapter({ root });
    let job: PartitionImportJobRecord | null = null;
    let isAdmin = true;
    const appendDenied = vi.fn(async () => {});
    const initializeAudit = vi.fn(() => ({ appendDenied }));
    const abort = vi.spyOn(storage, "abortMultipartUpload");
    const finishJob = vi.fn(async () => {});
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
      findJobForStatus: async () => job,
      finishJob
    });
    const app = Fastify();
    registerStructuredPartitionRoutes(app, {
      ...unusedAudit,
      auth: { ...auth, employee: () => (isAdmin ? adminAuth.employee() : employee) },
      uploadAuthorizationAudit: initializeAudit,
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
    const parts = await app.inject({
      method: "GET",
      url: `/v1/structured/partition-uploads/${response.json().partitionImportJobId}/parts`
    });
    expect(parts.statusCode).toBe(200);
    expect(parts.json().parts).toHaveLength(2);
    expect(initializeAudit).not.toHaveBeenCalled();
    isAdmin = false;
    const findJob = vi.spyOn(repository, "findJobForStatus");
    for (const input of [
      {
        method: "GET" as const,
        url: `/v1/structured/partition-uploads/${response.json().partitionImportJobId}/parts`
      },
      {
        method: "POST" as const,
        url: `/v1/structured/partition-uploads/${response.json().partitionImportJobId}/complete`,
        payload: {}
      }
    ]) {
      const denied = await app.inject(input);
      expect(denied.statusCode).toBe(403);
      expect(denied.json().error.code).toBe("UPLOAD_ADMIN_REQUIRED");
    }
    expect(appendDenied).toHaveBeenCalledTimes(2);
    expect(findJob).not.toHaveBeenCalled();
    expect(finishJob).not.toHaveBeenCalled();
    expect(abort).not.toHaveBeenCalled();
    const status = await app.inject({
      method: "GET",
      url: `/v1/structured/partition-imports/${response.json().partitionImportJobId}`
    });
    expect(status.statusCode).toBe(200);
    expect(status.json().status).toBe("uploading");
    const cancelled = await app.inject({
      method: "DELETE",
      url: `/v1/structured/partition-uploads/${response.json().partitionImportJobId}`
    });
    expect(cancelled.statusCode).toBe(204);
    expect(abort).toHaveBeenCalledTimes(1);
    expect(finishJob).toHaveBeenCalledExactlyOnceWith({
      orgId: employee.orgId,
      jobId: response.json().partitionImportJobId,
      uploaderId: employee.id,
      status: "cancelled"
    });
    await app.close();
  });

  it("shows partition import status only to its uploader with sufficient clearance", async () => {
    const job: PartitionImportJobRecord = {
      id: "pjob_private",
      orgId: employee.orgId,
      uploaderId: employee.id,
      dataset: "business",
      enterpriseKey: "private-enterprise",
      enterpriseName: "Private Enterprise",
      confidentialityLevel: 1,
      originalFileName: "private.csv",
      mediaType: "text/csv",
      sourceByteSize: 100n,
      sourceChecksumSha256: "a".repeat(64),
      sourceStartDate: new Date("2026-09-07T00:00:00.000Z"),
      sourceEndDate: new Date("2026-09-07T00:00:00.000Z"),
      temporaryObjectKey: null,
      multipartUploadId: null,
      status: "rejected",
      totalRowCount: 0n,
      partitionCount: 0,
      errorCode: "INVALID_SOURCE",
      errorSummary: "Private validation detail",
      validationErrors: ["Private validation detail"],
      expiresAt: new Date("2026-09-30T00:00:00.000Z"),
      publishedAt: null,
      finishedAt: new Date("2026-09-29T00:00:00.000Z")
    };
    let actor = employee;
    const app = Fastify();
    registerStructuredPartitionRoutes(app, {
      ...unusedAudit,
      auth: { ...auth, employee: () => actor },
      storage: () => {
        throw new Error("unused");
      },
      partitions: () => repositoryStub({ findJobForStatus: async () => job }),
      runtimeLimits: loadApiRuntimeLimits({})
    });
    try {
      const url = `/v1/structured/partition-imports/${job.id}`;
      const owner = await app.inject({ method: "GET", url });
      expect(owner.statusCode).toBe(200);
      expect(owner.json().validationErrors).toEqual(["Private validation detail"]);

      actor = { ...employee, id: "emp_2" };
      const otherEmployee = await app.inject({ method: "GET", url });
      expect(otherEmployee.statusCode).toBe(404);
      expect(otherEmployee.body).not.toContain("Private");

      actor = { ...employee, clearance: 0 };
      const downgradedOwner = await app.inject({ method: "GET", url });
      expect(downgradedOwner.statusCode).toBe(404);
      expect(downgradedOwner.body).not.toContain("Private");
    } finally {
      await app.close();
    }
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
      ...unusedAudit,
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
        endDate: "2026-09-13",
        storeNameContains: [" 麦家小馆 "]
      }
    });
    expect(response.statusCode).toBe(200);
    expect(list).toHaveBeenCalledWith(
      expect.objectContaining({
        orgId: "org_1",
        clearance: 1,
        enterpriseKey: "synthetic",
        maxPartitions: 10_000,
        storeNameContains: ["麦家小馆"]
      })
    );
    expect(response.json()).toMatchObject({
      partitionCount: 1,
      totalRowCount: 4,
      partitions: [{ storeId: "001", rowCount: 4 }]
    });
    expect(response.body).not.toContain("objectKey");
    await app.close();
  });

  it("rejects an oversized manifest before signing download URLs", async () => {
    const row = {
      businessDate: new Date("2026-09-07T00:00:00.000Z"),
      merchantId: "001",
      storeName: "Store A",
      rowCount: 4n,
      byteSize: 20n,
      checksumSha256: "b".repeat(64),
      objectKey: "structured-partitions/org_1/pjob_1/part_1.csv"
    };
    const list = vi.fn(async () => [row, row]);
    const storage = vi.fn(() => {
      throw new Error("oversized manifests must not initialize storage");
    });
    const app = Fastify();
    registerStructuredPartitionRoutes(app, {
      ...unusedAudit,
      auth,
      storage,
      partitions: () => repositoryStub({ listReadableManifestRows: list }),
      runtimeLimits: { ...loadApiRuntimeLimits({}), partitionManifestMaxPartitions: 1 }
    });
    try {
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
      expect(response.statusCode).toBe(413);
      expect(response.json().error.code).toBe("PARTITION_MANIFEST_TOO_LARGE");
      expect(list).toHaveBeenCalledWith(expect.objectContaining({ maxPartitions: 1 }));
      expect(storage).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it("returns 400 for malformed upload metadata before creating a multipart upload", async () => {
    const storage = vi.fn(() => {
      throw new Error("invalid upload must not initialize storage");
    });
    const app = Fastify();
    registerStructuredPartitionRoutes(app, {
      ...unusedAudit,
      auth: adminAuth,
      storage,
      partitions: () => repositoryStub({}),
      runtimeLimits: loadApiRuntimeLimits({})
    });
    const valid = {
      dataset: "business",
      enterpriseName: "Synthetic",
      startDate: "2026-09-07",
      endDate: "2026-09-13",
      originalFileName: "business.csv",
      mediaType: "text/csv",
      sourceByteSize: 100,
      sourceChecksumSha256: "a".repeat(64),
      idempotencyKey: "idem-valid"
    };
    try {
      for (const payload of [
        { ...valid, mediaType: 42 },
        { ...valid, idempotencyKey: 42 },
        { ...valid, startDate: "9999-99-99" }
      ]) {
        const response = await app.inject({
          method: "POST",
          url: "/v1/structured/partition-uploads",
          payload
        });
        expect(response.statusCode).toBe(400);
      }
      expect(storage).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it("returns 400 for malformed manifest fields before querying partitions", async () => {
    const list = vi.fn(async () => []);
    const app = Fastify();
    registerStructuredPartitionRoutes(app, {
      ...unusedAudit,
      auth,
      storage: () => {
        throw new Error("unused");
      },
      partitions: () => repositoryStub({ listReadableManifestRows: list }),
      runtimeLimits: loadApiRuntimeLimits({})
    });
    const valid = {
      dataset: "business",
      enterpriseName: "Synthetic",
      startDate: "2026-09-07",
      endDate: "2026-09-13"
    };
    try {
      for (const payload of [
        { ...valid, storeIds: { storeId: "001" } },
        { ...valid, storeIds: ["001", 42] },
        { ...valid, endDate: "9999-99-99" }
      ]) {
        const response = await app.inject({
          method: "POST",
          url: "/v1/structured/partition-manifests",
          payload
        });
        expect(response.statusCode).toBe(400);
      }
      expect(list).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
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
      ...unusedAudit,
      auth: adminAuth,
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

it("rejects empty store-name scope before reading or signing partitions", async () => {
  const app = Fastify();
  const partitions = vi.fn(() => {
    throw new Error("invalid scope must not read");
  });
  registerStructuredPartitionRoutes(app, {
    ...unusedAudit,
    auth,
    partitions,
    storage: () => {
      throw new Error("invalid scope must not sign");
    },
    runtimeLimits: loadApiRuntimeLimits({})
  });
  try {
    const response = await app.inject({
      method: "POST",
      url: "/v1/structured/partition-manifests",
      payload: {
        dataset: "business",
        enterpriseName: "Synthetic",
        startDate: "2026-09-07",
        endDate: "2026-09-13",
        storeNameContains: []
      }
    });
    expect(response.statusCode).toBe(400);
    expect(partitions).not.toHaveBeenCalled();
  } finally {
    await app.close();
  }
});

it.each(["queued", "processing", "published"] as const)(
  "does not cancel or abort an accepted %s import",
  async (status) => {
    const app = Fastify();
    const abort = vi.fn();
    const finishJob = vi.fn();
    registerStructuredPartitionRoutes(app, {
      auth,
      runtimeLimits: loadApiRuntimeLimits({}),
      ...unusedAudit,
      storage: () => ({ abortMultipartUpload: abort }) as never,
      partitions: () =>
        ({
          findJobForStatus: async () => ({
            id: "job",
            uploaderId: employee.id,
            status,
            temporaryObjectKey: "temp",
            multipartUploadId: "upload"
          }),
          finishJob
        }) as unknown as StructuredPartitionRepository
    });
    try {
      expect(
        (await app.inject({ method: "DELETE", url: "/v1/structured/partition-uploads/job" }))
          .statusCode
      ).toBe(409);
      expect(finishJob).not.toHaveBeenCalled();
      expect(abort).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  }
);
it("does not abort multipart storage when acceptance wins the cancellation race", async () => {
  const app = Fastify();
  const abort = vi.fn();
  registerStructuredPartitionRoutes(app, {
    auth,
    runtimeLimits: loadApiRuntimeLimits({}),
    ...unusedAudit,
    storage: () => ({ abortMultipartUpload: abort }) as never,
    partitions: () =>
      ({
        findJobForStatus: async () => ({
          id: "job",
          uploaderId: employee.id,
          status: "uploading",
          temporaryObjectKey: "temp",
          multipartUploadId: "upload"
        }),
        finishJob: async () => false
      }) as unknown as StructuredPartitionRepository
  });
  try {
    expect(
      (await app.inject({ method: "DELETE", url: "/v1/structured/partition-uploads/job" }))
        .statusCode
    ).toBe(409);
    expect(abort).not.toHaveBeenCalled();
  } finally {
    await app.close();
  }
});
