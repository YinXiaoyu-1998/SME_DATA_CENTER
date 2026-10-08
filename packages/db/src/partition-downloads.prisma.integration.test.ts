import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import type { StorageAdapter } from "@smedc/storage";
import { createPrismaProcessingWorkerRepository } from "../../../apps/worker/src/worker.js";
import { buildPartitionDownload } from "../../../apps/worker/src/partition-download/processor.js";
import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createDatabaseAdapter } from "./adapter.js";
import { loadPartitionDownloadLimits } from "@smedc/domain";
import { createPrismaPartitionDownloadRepository } from "./partition-downloads.js";
const suite = process.env["RUN_PARTITION_PRISMA_INTEGRATION"] === "1" ? describe : describe.skip;
const orgId = "download_test_org";
const actor = { id: "download_employee", orgId, clearance: 3, disabled: false };
const scope = {
  dataset: "business" as const,
  enterpriseKey: "synthetic",
  enterpriseName: "Synthetic",
  startDate: "2026-10-01",
  endDate: "2026-10-08"
};
suite("partition download persistence", () => {
  const prisma = new PrismaClient({
    adapter: createDatabaseAdapter(process.env["DATABASE_URL"] ?? "")
  });
  const repository = createPrismaPartitionDownloadRepository({ prisma });
  beforeAll(async () => {
    await prisma.organization.create({ data: { id: orgId, name: "Synthetic" } });
    await prisma.employee.create({
      data: {
        id: actor.id,
        orgId,
        email: "download@example.invalid",
        displayName: "Synthetic",
        role: "employee",
        clearance: 3
      }
    });
    await prisma.partitionImportJob.create({
      data: {
        id: "download_source",
        orgId,
        uploaderId: actor.id,
        dataset: "business",
        enterpriseKey: "synthetic",
        enterpriseName: "Synthetic",
        confidentialityLevel: 0,
        idempotencyKey: "source",
        requestFingerprint: "a".repeat(64),
        originalFileName: "synthetic.csv",
        mediaType: "text/csv",
        sourceByteSize: 1n,
        sourceChecksumSha256: "a".repeat(64),
        sourceStartDate: new Date("2026-10-01"),
        sourceEndDate: new Date("2026-10-08"),
        expiresAt: new Date("2030-01-01")
      }
    });
  });
  beforeEach(async () => {
    await prisma.storageGarbage.deleteMany({
      where: {
        OR: [
          { objectKey: { startsWith: "download-test/" } },
          { objectKey: { startsWith: `partition-downloads/${orgId}/` } }
        ]
      }
    });
    await prisma.processingRun.deleteMany({ where: { orgId } });
    await prisma.partitionDownloadRequest.deleteMany({ where: { orgId } });
    await prisma.structuredPartition.deleteMany({ where: { orgId } });
    await prisma.employee.update({
      where: { id: actor.id },
      data: { disabled: false, clearance: 3 }
    });
  });
  afterAll(async () => {
    await prisma.storageGarbage.deleteMany({
      where: {
        OR: [
          { objectKey: { startsWith: "download-test/" } },
          { objectKey: { startsWith: `partition-downloads/${orgId}/` } }
        ]
      }
    });
    await prisma.processingRun.deleteMany({ where: { orgId } });
    await prisma.partitionDownloadRequest.deleteMany({ where: { orgId } });
    await prisma.structuredPartition.deleteMany({ where: { orgId } });
    await prisma.partitionImportJob.deleteMany({ where: { orgId } });
    await prisma.employee.deleteMany({ where: { orgId } });
    await prisma.organization.delete({ where: { id: orgId } });
    await prisma.$disconnect();
  });
  async function partitions(count = 1, bytes = 10n) {
    await prisma.structuredPartition.createMany({
      data: Array.from({ length: count }, (_, i) => ({
        id: `download_part_${i}`,
        orgId,
        enterpriseKey: "synthetic",
        enterpriseName: "Synthetic",
        dataset: "business",
        storeKey: String(i),
        merchantId: String(i),
        storeName: `Store ${i}`,
        businessDate: new Date("2026-10-01"),
        objectKey: `download-test/source-${i}`,
        rowCount: 2n,
        byteSize: bytes,
        checksumSha256: "a".repeat(64),
        confidentialityLevel: 2,
        publishedByJobId: "download_source"
      }))
    });
  }
  it("worker lease reclaim fences old uploads and publishes with the new exclusive owner", async () => {
    const body = Buffer.from("store,total\nSynthetic,1\n");
    await partitions(1, BigInt(body.length));
    await prisma.structuredPartition.updateMany({
      where: { orgId },
      data: { checksumSha256: createHash("sha256").update(body).digest("hex") }
    });
    const request = await repository.prepare(actor, scope, "worker-reclaim");
    const worker = createPrismaProcessingWorkerRepository(process.env["DATABASE_URL"]!);
    try {
      await prisma.processingRun.updateMany({
        where: { orgId, partitionDownloadRequestId: request.requestId },
        data: { partitionImportJobId: "download_source" }
      });
      expect(
        await worker.claimNextProcessingRun({
          workerId: "mixed",
          leaseSeconds: 60,
          now: new Date()
        })
      ).toBeNull();
      await prisma.processingRun.updateMany({
        where: { orgId, partitionDownloadRequestId: request.requestId },
        data: { partitionImportJobId: null }
      });
      const old = (await worker.claimNextProcessingRun({
        workerId: "old",
        leaseSeconds: 60,
        now: new Date()
      }))!;
      expect(old.partitionDownloadRequestId).toBe(request.requestId);
      const oldLease = {
        runId: old.id,
        orgId,
        requestId: request.requestId,
        workerId: "old",
        attemptNumber: old.attemptNumber
      };
      expect(await repository.markRunning(oldLease)).toBeTruthy();
      await repository.recordProgress(oldLease, 1);
      const orphan = `partition-downloads/${orgId}/${request.requestId}/1/orphan.zip`;
      await repository.registerCandidate(oldLease, orphan);
      await prisma.processingRun.update({
        where: { id: old.id },
        data: { lockedUntil: new Date(Date.now() - 1000) }
      });
      const fresh = (await worker.claimNextProcessingRun({
        workerId: "new",
        leaseSeconds: 60,
        now: new Date()
      }))!;
      expect(fresh.attemptNumber).toBe(2);
      expect(
        await worker.heartbeatProcessingRun!({
          runId: old.id,
          workerId: "old",
          attemptNumber: 1,
          leaseSeconds: 60,
          now: new Date()
        })
      ).toBe(false);
      expect(
        await repository.publish(oldLease, {
          objectKey: orphan,
          byteSize: 1n,
          checksumSha256: "a".repeat(64),
          expiresAt: request.expiresAt
        })
      ).toBe(false);
      // Mixed ownership cannot heartbeat, retry, terminate, or complete via generic paths.
      await prisma.processingRun.update({
        where: { id: old.id },
        data: { partitionImportJobId: "download_source" }
      });
      expect(
        await worker.heartbeatProcessingRun!({
          runId: fresh.id,
          workerId: "new",
          attemptNumber: 2,
          leaseSeconds: 60,
          now: new Date()
        })
      ).toBe(false);
      for (const willRetry of [true, false])
        await expect(
          worker.failProcessingRun({
            runId: fresh.id,
            documentId: fresh.id,
            workerId: "new",
            attemptNumber: 2,
            now: new Date(),
            willRetry,
            nextAvailableAt: new Date(),
            errorCode: "TEST",
            errorSummary: "synthetic"
          })
        ).rejects.toThrow("no longer leased");
      await expect(
        worker.completePartitionProcessing!({
          runId: fresh.id,
          workerId: "new",
          attemptNumber: 2,
          now: new Date()
        })
      ).rejects.toThrow("no longer leased");
      await prisma.processingRun.update({
        where: { id: old.id },
        data: { partitionImportJobId: null }
      });
      const storage = {
        getObjectStream: async () => Readable.from([body]),
        putObjectAtKey: async (input: {
          body: Readable;
          key: string;
          contentLength: number;
          checksumSha256: string;
        }) => {
          for await (const chunk of input.body) void chunk;
          return { key: input.key, size: input.contentLength, hash: input.checksumSha256 };
        }
      } as unknown as StorageAdapter;
      expect(
        await buildPartitionDownload({
          requestId: request.requestId,
          lease: { ...oldLease, workerId: "new", attemptNumber: 2 },
          repository,
          storage
        })
      ).toBe("succeeded");
      expect(await repository.read(actor, request.requestId)).toMatchObject({
        status: "succeeded",
        completedPartitionCount: 1
      });
      expect(
        await prisma.processingRun.findUniqueOrThrow({ where: { id: fresh.id } })
      ).toMatchObject({ status: "succeeded", lockedBy: null });
      expect(await prisma.storageGarbage.findFirst({ where: { objectKey: orphan } })).toMatchObject(
        { repeatDeletion: true }
      );
    } finally {
      await worker.disconnect!();
    }
  });
  it("deduplicates concurrent same-key requests and rejects changed input", async () => {
    await partitions();
    const requests = await Promise.all(
      Array.from({ length: 6 }, () => repository.prepare(actor, scope, "same"))
    );
    expect(new Set(requests.map((r) => r.requestId)).size).toBe(1);
    expect(await prisma.processingRun.count({ where: { orgId } })).toBe(1);
    await expect(
      repository.prepare(actor, { ...scope, endDate: "2026-10-07" }, "same")
    ).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
  });
  it("enforces requester active limits under concurrent creation", async () => {
    await partitions();
    const results = await Promise.allSettled(
      Array.from({ length: 8 }, (_, i) => repository.prepare(actor, scope, `key-${i}`))
    );
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(4);
    expect(await prisma.partitionDownloadRequest.count({ where: { orgId } })).toBe(4);
  });
  it("rejects oversized scopes without creating requests", async () => {
    await partitions(501);
    await expect(repository.prepare(actor, scope, "count")).rejects.toMatchObject({
      code: "PARTITION_DOWNLOAD_LIMIT_EXCEEDED"
    });
    await prisma.structuredPartition.deleteMany({ where: { orgId } });
    await partitions(1, 268435457n);
    await expect(repository.prepare(actor, scope, "bytes")).rejects.toMatchObject({
      code: "PARTITION_DOWNLOAD_LIMIT_EXCEEDED"
    });
    expect(await prisma.partitionDownloadRequest.count({ where: { orgId } })).toBe(0);
  });
  it("returns empty success without a run and hides other owners", async () => {
    const request = await repository.prepare(actor, scope, "empty");
    expect(request).toMatchObject({ status: "succeeded", partitionCount: 0 });
    expect(await prisma.processingRun.count({ where: { orgId } })).toBe(0);
    await expect(
      repository.read({ ...actor, orgId: "other" }, request.requestId)
    ).rejects.toMatchObject({ code: "PARTITION_DOWNLOAD_NOT_FOUND" });
    await expect(
      repository.read({ ...actor, id: "other" }, request.requestId)
    ).rejects.toMatchObject({ code: "PARTITION_DOWNLOAD_NOT_FOUND" });
    expect(request).not.toHaveProperty("manifest");
  });
  it("expires same-key replay and demands a new key", async () => {
    const request = await repository.prepare(actor, scope, "expired");
    await prisma.partitionDownloadRequest.update({
      where: { id: request.requestId },
      data: { expiresAt: new Date(0) }
    });
    expect(await repository.prepare(actor, scope, "expired")).toMatchObject({
      status: "expired",
      errorCode: "PARTITION_DOWNLOAD_EXPIRED"
    });
    expect(await prisma.partitionDownloadRequest.count({ where: { orgId } })).toBe(1);
    expect((await repository.prepare(actor, scope, "fresh")).requestId).not.toBe(request.requestId);
  });
  it.each(["added", "deleted", "metadata"])(
    "detects %s partitions in the full scope",
    async (change) => {
      await partitions();
      const request = await repository.prepare(actor, scope, change);
      if (change === "deleted") await prisma.structuredPartition.deleteMany({ where: { orgId } });
      else if (change === "metadata")
        await prisma.structuredPartition.updateMany({
          where: { orgId },
          data: { storeName: "Changed" }
        });
      else {
        const row = await prisma.structuredPartition.findFirstOrThrow({ where: { orgId } });
        await prisma.structuredPartition.create({
          data: {
            ...row,
            id: "download_added",
            storeKey: "extra",
            objectKey: "download-test/extra"
          }
        });
      }
      await expect(repository.validateCurrent(actor, request.requestId)).rejects.toMatchObject({
        code: "PARTITION_DOWNLOAD_STALE"
      });
      expect(await repository.prepare(actor, scope, change)).toMatchObject({
        status: "failed",
        errorCode: "PARTITION_DOWNLOAD_STALE"
      });
    }
  );
  it("reloads employee authority instead of trusting the supplied actor", async () => {
    await partitions();
    const request = await repository.prepare(actor, scope, "auth");
    await prisma.employee.update({ where: { id: actor.id }, data: { disabled: true } });
    await expect(repository.validateCurrent(actor, request.requestId)).rejects.toMatchObject({
      code: "PARTITION_DOWNLOAD_FORBIDDEN"
    });
    await expect(repository.read(actor, request.requestId)).rejects.toMatchObject({
      code: "PARTITION_DOWNLOAD_FORBIDDEN"
    });
  });
  async function leaseFor(requestId: string) {
    const run = await prisma.processingRun.findUniqueOrThrow({
      where: { partitionDownloadRequestId: requestId }
    });
    await prisma.processingRun.update({
      where: { id: run.id },
      data: {
        status: "running",
        lockedBy: "worker",
        attemptNumber: 1,
        lockedUntil: new Date(Date.now() + 60000)
      }
    });
    return { runId: run.id, orgId, requestId, workerId: "worker", attemptNumber: 1 };
  }
  it("fences candidates, progress and publication, and registers exact expiry garbage", async () => {
    await partitions();
    const request = await repository.prepare(actor, scope, "publish");
    const lease = await leaseFor(request.requestId);
    expect(await repository.markRunning(lease)).toMatchObject({
      request: { status: "running" },
      limits: loadPartitionDownloadLimits({})
    });
    expect(await repository.recordProgress(lease, 1)).toBe(true);
    const objectKey = `partition-downloads/${orgId}/${request.requestId}/1/bundle.zip`;
    expect(await repository.registerCandidate({ ...lease, workerId: "stale" }, objectKey)).toBe(
      false
    );
    expect(await repository.registerCandidate(lease, objectKey)).toBe(true);
    const artifact = {
      objectKey,
      byteSize: 100n,
      checksumSha256: "b".repeat(64),
      expiresAt: request.expiresAt
    };
    expect(await repository.publish({ ...lease, attemptNumber: 0 }, artifact)).toBe(false);
    expect(await repository.publish(lease, artifact)).toBe(true);
    expect(await repository.fail(lease, "PARTITION_DOWNLOAD_FAILED")).toBe(false);
    expect(await repository.read(actor, request.requestId)).toMatchObject({
      status: "succeeded",
      completedPartitionCount: 1
    });
    expect((await repository.validateCurrent(actor, request.requestId)).artifact).toEqual(artifact);
    const garbage = await prisma.storageGarbage.findFirstOrThrow({ where: { objectKey } });
    expect(garbage).toMatchObject({
      processingRunId: null,
      repeatDeletion: false,
      availableAt: request.expiresAt
    });
    expect(await repository.expire(request.expiresAt)).toBe(1);
    expect(await repository.read(actor, request.requestId)).toMatchObject({ status: "expired" });
    expect(
      (
        await prisma.storageGarbage.findUniqueOrThrow({ where: { id: garbage.id } })
      ).availableAt.getTime()
    ).toBeLessThanOrEqual(Date.now());
  });
  it("rejects mixed processing owners and expired leases", async () => {
    await partitions();
    const request = await repository.prepare(actor, scope, "owners");
    const lease = await leaseFor(request.requestId);
    await prisma.processingRun.update({
      where: { id: lease.runId },
      data: { partitionImportJobId: "download_source" }
    });
    expect(await repository.markRunning(lease)).toBe(false);
    await prisma.processingRun.update({
      where: { id: lease.runId },
      data: { partitionImportJobId: null, lockedUntil: new Date(0) }
    });
    expect(await repository.recordProgress(lease, 1)).toBe(false);
    expect(await repository.fail(lease, "PARTITION_DOWNLOAD_FAILED")).toBe(false);
  });
  it.each(["mixed owner", "wrong job type"])(
    "leaves %s runs and leases untouched during status invalidation and expiry",
    async (invalidOwner) => {
      await partitions();
      const request = await repository.prepare(actor, scope, "terminal-owner");
      const lease = await leaseFor(request.requestId);
      const original = await prisma.processingRun.update({
        where: { id: lease.runId },
        data:
          invalidOwner === "mixed owner"
            ? { partitionImportJobId: "download_source" }
            : { jobType: "structured_import" }
      });
      await prisma.structuredPartition.updateMany({
        where: { orgId },
        data: { storeName: "Changed" }
      });
      expect(await repository.read(actor, request.requestId)).toMatchObject({
        status: "failed",
        errorCode: "PARTITION_DOWNLOAD_STALE"
      });
      expect(await prisma.processingRun.findUniqueOrThrow({ where: { id: lease.runId } })).toEqual(
        original
      );
      expect(await repository.expire(request.expiresAt)).toBe(1);
      expect(await prisma.processingRun.findUniqueOrThrow({ where: { id: lease.runId } })).toEqual(
        original
      );
    }
  );
  it("refuses changed-scope publication and preserves candidate cleanup", async () => {
    await partitions();
    const request = await repository.prepare(actor, scope, "stale-publish");
    const lease = await leaseFor(request.requestId);
    const objectKey = `partition-downloads/${orgId}/${request.requestId}/1/bundle.zip`;
    await repository.registerCandidate(lease, objectKey);
    await prisma.structuredPartition.updateMany({
      where: { orgId },
      data: { confidentialityLevel: 3 }
    });
    expect(
      await repository.publish(lease, {
        objectKey,
        byteSize: 100n,
        checksumSha256: "b".repeat(64),
        expiresAt: request.expiresAt
      })
    ).toBe(false);
    expect(await repository.read(actor, request.requestId)).toMatchObject({
      status: "failed",
      errorCode: "PARTITION_DOWNLOAD_STALE"
    });
    expect(await prisma.storageGarbage.count({ where: { objectKey } })).toBe(1);
  });
  it("enforces organization active quota in addition to requester quota", async () => {
    await partitions();
    const small = createPrismaPartitionDownloadRepository({
      prisma,
      limits: { ...loadPartitionDownloadLimits({}), partitionDownloadMaxActivePerOrg: 2 }
    });
    const results = await Promise.allSettled(
      Array.from({ length: 4 }, (_, i) => small.prepare(actor, scope, `org-${i}`))
    );
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(2);
  });
  it("database composite foreign keys prevent cross-organization requester and run owners", async () => {
    const request = await repository.prepare(actor, scope, "fk");
    const otherOrg = "download_other_org";
    await prisma.organization.create({ data: { id: otherOrg, name: "Synthetic Other" } });
    try {
      await expect(
        prisma.partitionDownloadRequest.update({
          where: { id: request.requestId },
          data: { orgId: otherOrg }
        })
      ).rejects.toThrow();
      await expect(
        prisma.processingRun.create({
          data: {
            orgId: otherOrg,
            partitionDownloadRequestId: request.requestId,
            jobKey: "cross-org",
            jobType: "structured_partition_bundle"
          }
        })
      ).rejects.toThrow();
    } finally {
      await prisma.organization.delete({ where: { id: otherOrg } });
    }
  });
  it("reclaims a published bundle when requester access is revoked", async () => {
    await partitions();
    const request = await repository.prepare(actor, scope, "revoke");
    const lease = await leaseFor(request.requestId);
    const objectKey = `partition-downloads/${orgId}/${request.requestId}/1/revoke.zip`;
    await repository.registerCandidate(lease, objectKey);
    await repository.publish(lease, {
      objectKey,
      byteSize: 100n,
      checksumSha256: "b".repeat(64),
      expiresAt: request.expiresAt
    });
    await prisma.employee.update({ where: { id: actor.id }, data: { disabled: true } });
    await expect(repository.validateCurrent(actor, request.requestId)).rejects.toMatchObject({
      code: "PARTITION_DOWNLOAD_FORBIDDEN"
    });
    expect(
      await prisma.partitionDownloadRequest.findUniqueOrThrow({ where: { id: request.requestId } })
    ).toMatchObject({ status: "failed", objectKey: null });
    const garbage = await prisma.storageGarbage.findFirstOrThrow({ where: { objectKey } });
    expect(garbage.availableAt.getTime()).toBeLessThanOrEqual(Date.now());
  });
  it("invalidates a snapshot after current clearance is lowered", async () => {
    await partitions();
    const request = await repository.prepare(actor, scope, "clearance");
    await prisma.employee.update({ where: { id: actor.id }, data: { clearance: 0 } });
    await expect(repository.validateCurrent(actor, request.requestId)).rejects.toMatchObject({
      code: "PARTITION_DOWNLOAD_STALE"
    });
    expect(await repository.prepare(actor, scope, "new-clearance")).toMatchObject({
      status: "succeeded",
      partitionCount: 0
    });
  });
});
