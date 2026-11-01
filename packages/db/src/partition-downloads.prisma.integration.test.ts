import Fastify from "fastify";
import { registerPartitionDownloadRoutes } from "../../../apps/api/src/routes/structured-partitions/downloads.js";
import type { RequestAuth } from "../../../apps/api/src/request-auth.js";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import type { StorageAdapter } from "@smedc/storage";
import { createPrismaProcessingWorkerRepository } from "../../../apps/worker/src/worker.js";
import { buildPartitionDownload } from "../../../apps/worker/src/partition-download/processor.js";
import { createStoreCleanupRepository } from "../../../scripts/partition-store-cleanup-support.js";
import { createPrismaStructuredPartitionRepository } from "./structured-partitions.js";
import { Prisma, PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createDatabaseAdapter } from "./adapter.js";
import { loadPartitionDownloadLimits } from "@smedc/domain";
import {
  createPrismaPartitionDownloadRepository,
  partitionDownloadFingerprint
} from "./partition-downloads.js";
const suite = process.env["RUN_PARTITION_PRISMA_INTEGRATION"] === "1" ? describe : describe.skip;
const orgId = "download_test_org";
const otherCleanupOrgId = "download_cleanup_other_org";
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
    await prisma.organization.create({ data: { id: otherCleanupOrgId, name: "Other Synthetic" } });
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
  async function clearAuthorization() {
    await prisma.businessResource.deleteMany({ where: { orgId } });
    await prisma.businessGrant.deleteMany({ where: { orgId } });
    await prisma.businessStore.deleteMany({ where: { orgId } });
    await prisma.businessCategory.deleteMany({ where: { orgId } });
    await prisma.businessAuthorizationState.deleteMany({ where: { orgId } });
  }
  beforeEach(async () => {
    await clearAuthorization();
    await prisma.storageGarbage.deleteMany({
      where: {
        OR: [
          { objectKey: { startsWith: "download-test/" } },
          { objectKey: { startsWith: `partition-downloads/${orgId}/` } }
        ]
      }
    });
    await prisma.auditLog.deleteMany({ where: { orgId } });
    await prisma.processingRun.deleteMany({ where: { orgId } });
    await prisma.partitionDownloadRequest.deleteMany({ where: { orgId } });
    await prisma.structuredPartition.deleteMany({ where: { orgId } });
    await prisma.employee.update({
      where: { id: actor.id },
      data: { disabled: false, clearance: 3 }
    });
  });
  afterAll(async () => {
    await clearAuthorization();
    await prisma.storageGarbage.deleteMany({
      where: {
        OR: [
          { objectKey: { startsWith: "download-test/" } },
          { objectKey: { startsWith: `partition-downloads/${orgId}/` } }
        ]
      }
    });
    await prisma.auditLog.deleteMany({ where: { orgId } });
    await prisma.processingRun.deleteMany({ where: { orgId } });
    await prisma.partitionDownloadRequest.deleteMany({ where: { orgId } });
    await prisma.structuredPartition.deleteMany({ where: { orgId } });
    await prisma.partitionImportJob.deleteMany({ where: { orgId } });
    await prisma.employee.deleteMany({ where: { orgId } });
    await prisma.organization.delete({ where: { id: orgId } });
    await prisma.structuredPartition.deleteMany({ where: { orgId: otherCleanupOrgId } });
    await prisma.organization.delete({ where: { id: otherCleanupOrgId } });
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
  it("upgrades legacy in-store data without replacing bytes or grants and expires old ZIP requests", async () => {
    const url = new URL(process.env["DATABASE_URL"]!);
    expect(["localhost", "127.0.0.1"]).toContain(url.hostname);
    expect(url.pathname).toMatch(/^\/smedc_integration_[a-f0-9]+$/);
    const migration = (
      await readFile(
        new URL(
          "../prisma/migrations/20261030020000_in_store_orders/migration.sql",
          import.meta.url
        ),
        "utf8"
      )
    )
      .split(";")
      .filter((statement) => statement.trim());
    // The runner migrates an empty schema first. Widen only these enums to seed a pre-upgrade fixture.
    for (const statement of migration.slice(0, 4)) await prisma.$executeRawUnsafe(statement);
    await partitions();
    const old = await publishedRequest();
    const queued = await repository.prepare(actor, scope, "legacy-pending");
    const beforePartition = await prisma.structuredPartition.findUniqueOrThrow({
      where: { id: "download_part_0" }
    });
    const beforeJob = await prisma.partitionImportJob.findUniqueOrThrow({
      where: { id: "download_source" }
    });
    await prisma.businessAuthorizationState.create({
      data: { orgId, mode: "enabled", version: 7n }
    });
    await prisma.businessCategory.create({
      data: {
        orgId,
        id: "legacy-orders",
        key: "settled_orders",
        name: "店内已结账订单明细",
        kind: "fixed",
        confidentialityLevel: 2,
        allowGroup: false,
        allowStore: true
      }
    });
    await prisma.businessGrant.create({
      data: {
        orgId,
        id: "legacy-order-grant",
        employeeId: actor.id,
        enterpriseKey: "synthetic",
        ownership: "store",
        allStores: true,
        categories: { create: { categoryId: "legacy-orders" } }
      }
    });
    await prisma.businessStore.create({
      data: { orgId, enterpriseKey: "synthetic", name: "Store 0" }
    });
    await prisma.businessResource.create({
      data: {
        orgId,
        id: "legacy-order-resource",
        categoryId: "legacy-orders",
        kind: "structured",
        resourceKey: "partition:download_part_0",
        valid: true,
        scopes: {
          create: {
            id: "legacy-order-scope",
            enterpriseKey: "synthetic",
            ownership: "store",
            storeName: "Store 0"
          }
        }
      }
    });
    await prisma.document.create({
      data: {
        id: "legacy-order-doc",
        orgId,
        title: "Synthetic old order source",
        documentType: "structured_dataset",
        documentKind: "structured",
        fileType: "csv",
        status: "active",
        storageObjectKey: "synthetic/legacy-orders.csv",
        uploaderId: actor.id,
        sourceMetadata: {
          dataset: "settled_orders",
          parsedBusinessScopes: { dataset: "settled_orders" }
        }
      }
    });
    await prisma.importBatch.create({
      data: {
        id: "legacy-order-batch",
        orgId,
        sourceDocumentId: "legacy-order-doc",
        dataset: "business",
        idempotencyKey: "legacy-batch",
        requestFingerprint: "b".repeat(64),
        naturalKey: "legacy-natural",
        status: "applied"
      }
    });
    await prisma.importWindowClaim.create({
      data: {
        id: "legacy-order-window",
        orgId,
        importBatchId: "legacy-order-batch",
        dataset: "business",
        startDate: new Date("2026-10-01"),
        endDate: new Date("2026-10-08")
      }
    });
    for (const table of [
      "partition_import_jobs",
      "structured_partitions",
      "import_batches",
      "import_window_claims"
    ])
      await prisma.$executeRawUnsafe(
        `UPDATE ${table} SET dataset='settled_orders' WHERE org_id=?`,
        orgId
      );
    const oldScope = { ...scope, dataset: "settled_orders" };
    await prisma.partitionDownloadRequest.updateMany({
      where: { orgId },
      data: { scope: oldScope, requestFingerprint: partitionDownloadFingerprint(oldScope) }
    });
    const beforeDownload = await prisma.partitionDownloadRequest.findUniqueOrThrow({
      where: { id: old.requestId }
    });
    const grants = await prisma.businessGrantCategory.findMany({ where: { orgId } });
    await prisma.businessAuthorizationState.create({
      data: { orgId: otherCleanupOrgId, mode: "enabled", version: 3n }
    });
    await prisma.businessCategory.create({
      data: {
        orgId: otherCleanupOrgId,
        id: "custom-order-category",
        key: "settled_orders",
        name: "保留自定义类别名称",
        kind: "fixed",
        confidentialityLevel: 1,
        allowGroup: false,
        allowStore: true,
        retired: true
      }
    });
    const apply = () =>
      prisma.$transaction(
        async (tx) => {
          for (const statement of migration) await tx.$executeRawUnsafe(statement);
        },
        { timeout: 30_000 }
      );
    try {
      await prisma.businessCategory.create({
        data: {
          orgId,
          id: "new-name-collision",
          key: "in_store_orders",
          name: "Existing category",
          kind: "fixed",
          confidentialityLevel: 0,
          allowGroup: false,
          allowStore: true
        }
      });
      await expect(apply()).rejects.toThrow();
      expect(
        await prisma.businessCategory.findUnique({
          where: { orgId_key: { orgId, key: "settled_orders" } }
        })
      ).toMatchObject({ id: "legacy-orders" });
      expect(
        await prisma.businessAuthorizationState.findUnique({ where: { orgId } })
      ).toMatchObject({ version: 7n });
      await prisma.businessCategory.delete({
        where: { orgId_id: { orgId, id: "new-name-collision" } }
      });
      await prisma.structuredPartition.create({
        data: {
          ...beforePartition,
          id: "new-partition-collision",
          dataset: "in_store_orders",
          objectKey: "download-test/collision.csv"
        }
      });
      await expect(apply()).rejects.toThrow();
      expect(
        await prisma.$queryRaw<
          Array<{ dataset: string }>
        >`SELECT dataset FROM structured_partitions WHERE id='download_part_0'`
      ).toEqual([{ dataset: "settled_orders" }]);
      await prisma.structuredPartition.delete({ where: { id: "new-partition-collision" } });
      await apply();
      expect(
        await prisma.businessCategory.findUnique({
          where: { orgId_key: { orgId, key: "in_store_orders" } }
        })
      ).toMatchObject({
        id: "legacy-orders",
        name: "店内订单明细",
        confidentialityLevel: 2,
        allowGroup: false,
        allowStore: true
      });
      expect(await prisma.businessGrantCategory.findMany({ where: { orgId } })).toEqual(grants);
      expect(
        await prisma.businessCategory.findUnique({
          where: { orgId_id: { orgId: otherCleanupOrgId, id: "custom-order-category" } }
        })
      ).toMatchObject({
        key: "in_store_orders",
        name: "保留自定义类别名称",
        confidentialityLevel: 1,
        retired: true
      });
      expect(
        await prisma.businessAuthorizationState.findUnique({ where: { orgId } })
      ).toMatchObject({ mode: "enabled", version: 8n });
      expect(
        await prisma.structuredPartition.findUniqueOrThrow({ where: { id: beforePartition.id } })
      ).toMatchObject({ ...beforePartition, dataset: "in_store_orders" });
      expect(
        await prisma.partitionImportJob.findUniqueOrThrow({ where: { id: beforeJob.id } })
      ).toMatchObject({ ...beforeJob, dataset: "in_store_orders" });
      expect(
        await prisma.importBatch.findUnique({ where: { id: "legacy-order-batch" } })
      ).toMatchObject({
        dataset: "in_store_orders",
        requestFingerprint: "b".repeat(64),
        naturalKey: "legacy-natural"
      });
      expect(
        await prisma.importWindowClaim.findUnique({ where: { id: "legacy-order-window" } })
      ).toMatchObject({ dataset: "in_store_orders" });
      expect(await prisma.document.findUnique({ where: { id: "legacy-order-doc" } })).toMatchObject(
        {
          sourceMetadata: {
            dataset: "in_store_orders",
            parsedBusinessScopes: { dataset: "in_store_orders" }
          }
        }
      );
      const retired = await prisma.partitionDownloadRequest.findUniqueOrThrow({
        where: { id: old.requestId }
      });
      expect(retired).toMatchObject({
        status: "expired",
        errorCode: "PARTITION_DOWNLOAD_EXPIRED",
        scope: oldScope,
        requestFingerprint: beforeDownload.requestFingerprint,
        manifestFingerprint: beforeDownload.manifestFingerprint,
        objectKey: null
      });
      const garbage = await prisma.storageGarbage.findFirstOrThrow({
        where: { objectKey: beforeDownload.objectKey! }
      });
      expect(garbage.availableAt.getTime()).toBeGreaterThan(Date.now() + 900_000);
      expect(
        await prisma.storageGarbage.findFirst({ where: { objectKey: beforePartition.objectKey } })
      ).toBeNull();
      expect(
        await prisma.processingRun.findUnique({
          where: { partitionDownloadRequestId: queued.requestId }
        })
      ).toMatchObject({ status: "failed", errorCode: "PARTITION_DOWNLOAD_EXPIRED" });
      const app = urlApp();
      try {
        expect(
          (await app.inject({ url: `/v1/structured/partition-downloads/${old.requestId}` })).json()
        ).toMatchObject({ status: "expired" });
        const expired = await app.inject({
          method: "POST",
          url: `/v1/structured/partition-downloads/${old.requestId}/url`
        });
        expect(expired.statusCode).toBe(410);
        expect(expired.json()).toMatchObject({ error: { code: "PARTITION_DOWNLOAD_EXPIRED" } });
        await expect(
          repository.prepare(
            actor,
            { ...scope, dataset: "in_store_orders" },
            beforeDownload.idempotencyKey
          )
        ).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
        const fresh = await repository.prepare(
          actor,
          { ...scope, dataset: "in_store_orders" },
          "new-order-download"
        );
        expect(fresh.partitionCount).toBe(1);
        const lease = await leaseFor(fresh.requestId);
        const key = `partition-downloads/${orgId}/${fresh.requestId}/1/in-store.zip`;
        await repository.registerCandidate(lease, key);
        expect(
          await repository.publish(lease, {
            objectKey: key,
            byteSize: 1n,
            checksumSha256: "c".repeat(64),
            expiresAt: fresh.expiresAt
          })
        ).toBe(true);
        const current = await app.inject({
          method: "POST",
          url: `/v1/structured/partition-downloads/${fresh.requestId}/url`
        });
        expect(current.statusCode).toBe(200);
        expect(current.json()).toMatchObject({
          scope: { dataset: "in_store_orders" },
          partitionCount: 1
        });
      } finally {
        await app.close();
      }
    } finally {
      await prisma.businessCategory.deleteMany({ where: { orgId: otherCleanupOrgId } });
      await prisma.businessAuthorizationState.deleteMany({ where: { orgId: otherCleanupOrgId } });
      await prisma.importWindowClaim.deleteMany({ where: { orgId } });
      await prisma.importBatch.deleteMany({ where: { id: "legacy-order-batch" } });
      await prisma.document.delete({ where: { id: "legacy-order-doc" } });
      await prisma.$executeRawUnsafe(
        "UPDATE partition_import_jobs SET dataset='business' WHERE id='download_source'"
      );
    }
  });

  it("fixes A/B at submission, completes after B revocation, and authorizes the whole manifest only at link issuance", async () => {
    await partitions(3);
    await prisma.businessAuthorizationState.create({ data: { orgId, mode: "enabled" } });
    await prisma.businessCategory.create({
      data: {
        orgId,
        id: "download-business",
        key: "business",
        name: "Business",
        kind: "fixed",
        confidentialityLevel: 2,
        allowStore: true,
        allowGroup: false
      }
    });
    await prisma.businessGrant.create({
      data: {
        orgId,
        id: "download-grant",
        employeeId: actor.id,
        enterpriseKey: "synthetic",
        ownership: "store",
        categories: { create: { categoryId: "download-business" } }
      }
    });
    for (let i = 0; i < 3; i++) {
      await prisma.businessStore.create({
        data: { orgId, enterpriseKey: "synthetic", name: `Store ${i}` }
      });
      await prisma.businessResource.create({
        data: {
          orgId,
          id: `download-resource-${i}`,
          kind: "structured",
          resourceKey: `partition:download_part_${i}`,
          categoryId: "download-business",
          valid: true,
          scopes: {
            create: {
              id: `download-scope-${i}`,
              enterpriseKey: "synthetic",
              ownership: "store",
              storeName: `Store ${i}`
            }
          }
        }
      });
    }
    const grantStore = (i: number) =>
      prisma.businessGrantStore.create({
        data: {
          orgId,
          grantId: "download-grant",
          enterpriseKey: "synthetic",
          storeName: `Store ${i}`
        }
      });
    await grantStore(0);
    await grantStore(1);
    const request = await repository.prepare(actor, scope, "fixed-a-b");
    expect(request).toMatchObject({ partitionCount: 2, status: "queued" });
    const before = (
      await prisma.partitionDownloadRequest.findUniqueOrThrow({ where: { id: request.requestId } })
    ).manifest;
    expect(before).toMatchObject({
      version: 1,
      entries: [{ id: "download_part_0" }, { id: "download_part_1" }]
    });
    await prisma.businessGrantStore.delete({
      where: { orgId_grantId_storeName: { orgId, grantId: "download-grant", storeName: "Store 1" } }
    });
    await prisma.employee.update({ where: { id: actor.id }, data: { clearance: 0 } });
    await prisma.structuredPartition.updateMany({
      where: { orgId },
      data: { confidentialityLevel: 3 }
    });
    const lease = await leaseFor(request.requestId);
    expect(await repository.markRunning(lease)).toMatchObject({
      request: { status: "running" },
      manifest: [{ id: "download_part_0" }, { id: "download_part_1" }]
    });
    const objectKey = `partition-downloads/${orgId}/${request.requestId}/1/fixed.zip`;
    await repository.registerCandidate(lease, objectKey);
    expect(
      await repository.publish(lease, {
        objectKey,
        byteSize: 100n,
        checksumSha256: "b".repeat(64),
        expiresAt: request.expiresAt
      })
    ).toBe(true);
    expect(await repository.read(actor, request.requestId)).toMatchObject({ status: "succeeded" });
    await expect(repository.validateCurrent(actor, request.requestId)).rejects.toMatchObject({
      code: "PARTITION_DOWNLOAD_FORBIDDEN"
    });
    expect(await repository.read(actor, request.requestId)).toMatchObject({ status: "succeeded" });
    await prisma.employee.update({ where: { id: actor.id }, data: { clearance: 3 } });
    const deniedAudit = vi.fn(async () => {});
    const app = urlApp(repository, vi.fn(), deniedAudit);
    try {
      const response = await app.inject({
        method: "POST",
        url: `/v1/structured/partition-downloads/${request.requestId}/url`
      });
      expect(response.statusCode).toBe(403);
      expect(deniedAudit).toHaveBeenCalledWith(
        expect.objectContaining({
          action: "url",
          result: "denied",
          errorCode: "PARTITION_DOWNLOAD_FORBIDDEN"
        })
      );
    } finally {
      await app.close();
    }
    await grantStore(1);
    await grantStore(2);
    expect((await repository.validateCurrent(actor, request.requestId)).manifest).toHaveLength(2);
    await prisma.employee.update({ where: { id: actor.id }, data: { clearance: 0 } });
    await expect(repository.validateCurrent(actor, request.requestId)).rejects.toMatchObject({
      code: "PARTITION_DOWNLOAD_FORBIDDEN"
    });
    expect(await repository.read(actor, request.requestId)).toMatchObject({ status: "succeeded" });
    await prisma.employee.update({ where: { id: actor.id }, data: { clearance: 3 } });
    expect((await repository.validateCurrent(actor, request.requestId)).request.status).toBe(
      "succeeded"
    );
    expect(
      (
        await prisma.partitionDownloadRequest.findUniqueOrThrow({
          where: { id: request.requestId }
        })
      ).manifest
    ).toEqual(before);
    await prisma.employee.create({
      data: {
        id: "download-other-admin",
        orgId,
        email: "other-admin@example.invalid",
        displayName: "Other",
        role: "admin",
        clearance: 3
      }
    });
    try {
      await expect(
        repository.read({ ...actor, id: "download-other-admin" }, request.requestId)
      ).rejects.toMatchObject({ code: "PARTITION_DOWNLOAD_NOT_FOUND" });
      await expect(
        repository.validateCurrent({ ...actor, id: "download-other-admin" }, request.requestId)
      ).rejects.toMatchObject({ code: "PARTITION_DOWNLOAD_NOT_FOUND" });
    } finally {
      await prisma.employee.delete({ where: { id: "download-other-admin" } });
    }
  });
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
  it.each(["deleted", "metadata"])(
    "refuses changed %s content without rewriting task status",
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
      expect(await repository.read(actor, request.requestId)).toMatchObject({
        status: "queued",
        errorCode: null
      });
      const renewed = await repository.prepare(actor, scope, `${change}-new-generation`);
      expect(renewed.requestId).not.toBe(request.requestId);
      expect(renewed.status).toBe(change === "deleted" ? "succeeded" : "queued");
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
  it("rolls back run, request and garbage writes when the clock crosses the lease at callback completion", async () => {
    await partitions();
    const request = await repository.prepare(actor, scope, "clock-crossing");
    const lease = await leaseFor(request.requestId);
    const objectKey = `partition-downloads/${orgId}/${request.requestId}/1/clock.zip`;
    await repository.registerCandidate(lease, objectKey);
    const before = {
      run: await prisma.processingRun.findUniqueOrThrow({ where: { id: lease.runId } }),
      request: await prisma.partitionDownloadRequest.findUniqueOrThrow({
        where: { id: request.requestId }
      }),
      garbage: await prisma.storageGarbage.findMany({ where: { objectKey } })
    };
    let clock = new Date();
    let crossed = false;
    const client = new Proxy(prisma, {
      get(target, key) {
        if (key !== "$transaction") return Reflect.get(target, key);
        return (fn: (tx: Prisma.TransactionClient) => Promise<unknown>, options: unknown) =>
          target.$transaction(
            async (tx) => {
              const result = await fn(
                new Proxy(tx, {
                  get(t, k) {
                    if (k !== "storageGarbage") return Reflect.get(t, k);
                    return new Proxy(t.storageGarbage, {
                      get(garbage, operation) {
                        if (operation !== "upsert") return Reflect.get(garbage, operation);
                        return async (args: Parameters<typeof garbage.upsert>[0]) => {
                          const row = await garbage.upsert(args);
                          if (row.reason === "partition_download_expired") {
                            clock = new Date(before.run.lockedUntil!.getTime() + 1);
                            crossed = true;
                          }
                          return row;
                        };
                      }
                    });
                  }
                })
              );
              return result;
            },
            options as Parameters<PrismaClient["$transaction"]>[1]
          );
      }
    });
    const fenced = createPrismaPartitionDownloadRepository({ prisma: client, now: () => clock });
    expect(
      await fenced.publish(lease, {
        objectKey,
        byteSize: 1n,
        checksumSha256: "a".repeat(64),
        expiresAt: request.expiresAt
      })
    ).toBe(false);
    expect(crossed).toBe(true);
    expect(await prisma.processingRun.findUniqueOrThrow({ where: { id: lease.runId } })).toEqual(
      before.run
    );
    expect(
      await prisma.partitionDownloadRequest.findUniqueOrThrow({ where: { id: request.requestId } })
    ).toEqual(before.request);
    expect(await prisma.storageGarbage.findMany({ where: { objectKey } })).toEqual(before.garbage);
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
    "leaves %s runs and leases untouched during status reads and expiry",
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
        status: "queued",
        errorCode: null
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
  it("refuses changed-content publication and preserves candidate cleanup", async () => {
    await partitions();
    const request = await repository.prepare(actor, scope, "stale-publish");
    const lease = await leaseFor(request.requestId);
    const objectKey = `partition-downloads/${orgId}/${request.requestId}/1/bundle.zip`;
    await repository.registerCandidate(lease, objectKey);
    await prisma.structuredPartition.updateMany({
      where: { orgId },
      data: { checksumSha256: "c".repeat(64) }
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
  it("denies a disabled requester without changing a succeeded bundle", async () => {
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
    ).toMatchObject({ status: "succeeded", objectKey });
    const garbage = await prisma.storageGarbage.findFirstOrThrow({ where: { objectKey } });
    expect(garbage.availableAt).toEqual(request.expiresAt);
  });
  it("denies a new link after current clearance is lowered without failing the task", async () => {
    await partitions();
    const request = await repository.prepare(actor, scope, "clearance");
    await prisma.employee.update({ where: { id: actor.id }, data: { clearance: 0 } });
    await expect(repository.validateCurrent(actor, request.requestId)).rejects.toMatchObject({
      code: "PARTITION_DOWNLOAD_FORBIDDEN"
    });
    expect(await repository.read(actor, request.requestId)).toMatchObject({ status: "queued" });
    expect(await repository.prepare(actor, scope, "new-clearance")).toMatchObject({
      status: "succeeded",
      partitionCount: 0
    });
  });
  const cleanup = createStoreCleanupRepository(prisma);
  const cleanupScope = {
    orgId,
    enterpriseName: "Synthetic",
    datasets: ["business" as const],
    storeNames: ["Store 0"]
  };
  it("rejects missing/empty scopes, changed inventory, and cross-organization previews atomically", async () => {
    await partitions();
    await expect(
      cleanup.buildStoreCleanupInventory({ ...cleanupScope, storeNames: [] })
    ).rejects.toThrow();
    await expect(
      cleanup.buildStoreCleanupInventory({ ...cleanupScope, storeNames: ["missing"] })
    ).rejects.toThrow("EMPTY_MATCH");
    await expect(
      cleanup.buildStoreCleanupInventory({ ...cleanupScope, orgId: "other" })
    ).rejects.toThrow("ORGANIZATION_NOT_FOUND");
    const inventory = await cleanup.buildStoreCleanupInventory(cleanupScope);
    const request = await repository.prepare(actor, scope, "cleanup-changed");
    await expect(
      cleanup.executeStoreCleanup({
        inventory: { ...inventory, scope: { ...inventory.scope, orgId: "other" } },
        expectedFingerprint: inventory.fingerprint
      })
    ).rejects.toThrow("FINGERPRINT_MISMATCH");
    await prisma.structuredPartition.updateMany({
      where: { orgId },
      data: { confidentialityLevel: 3 }
    });
    await expect(
      cleanup.executeStoreCleanup({ inventory, expectedFingerprint: inventory.fingerprint })
    ).rejects.toThrow("FINGERPRINT_MISMATCH");
    // Invalidation performed before recheck rolls back with the stale preview.
    expect(
      await prisma.partitionDownloadRequest.findUniqueOrThrow({ where: { id: request.requestId } })
    ).toMatchObject({ status: "queued" });
    expect(
      await prisma.storageGarbage.count({ where: { objectKey: { startsWith: "download-test/" } } })
    ).toBe(0);
    expect(await prisma.structuredPartition.count({ where: { orgId } })).toBe(1);
  });
  it("deletes only exact partitions, preserves mixed source jobs/runs/accounts, and reclaims late candidate writes idempotently", async () => {
    await partitions(2);
    const unrelatedKey = "download-test/unrelated-garbage";
    const unrelatedGarbage = await prisma.storageGarbage.create({
      data: {
        id: "download_unrelated_garbage",
        objectKey: unrelatedKey,
        objectKeyHash: createHash("sha256").update(unrelatedKey).digest("hex"),
        reason: "unrelated_fixture",
        availableAt: new Date(0)
      }
    });
    const sourceRun = await prisma.processingRun.create({
      data: {
        orgId,
        partitionImportJobId: "download_source",
        jobKey: "retained-source",
        jobType: "structured_partition_import"
      }
    });
    const job = await prisma.partitionImportJob.findUniqueOrThrow({
      where: { id: "download_source" }
    });
    await prisma.structuredPartition.update({
      where: { id: "download_part_1" },
      data: { storeName: "麦家保留门店" }
    });
    const retained = await prisma.structuredPartition.findUniqueOrThrow({
      where: { id: "download_part_1" }
    });
    const otherOrgPartition = await prisma.structuredPartition.create({
      data: {
        ...retained,
        id: "download_other_partition",
        orgId: otherCleanupOrgId,
        storeName: "Store 0",
        objectKey: "download-test/other-org"
      }
    });
    const employee = await prisma.employee.findUniqueOrThrow({ where: { id: actor.id } });
    const inventory = await cleanup.buildStoreCleanupInventory(cleanupScope);
    expect(inventory.preserved).toEqual({ partitions: 1, importJobs: 1, employees: 1 });
    expect(inventory.targets.map((row) => row.id)).toEqual(["download_part_0"]);
    const request = await repository.prepare(actor, scope, "cleanup-candidate");
    const lease = await leaseFor(request.requestId);
    const objectKey = `partition-downloads/${orgId}/${request.requestId}/1/late.zip`;
    await repository.registerCandidate(lease, objectKey);
    const result = await cleanup.executeStoreCleanup({
      inventory,
      expectedFingerprint: inventory.fingerprint
    });
    expect(result).toEqual({
      deletedPartitionCount: 1,
      invalidatedRequestCount: 1,
      garbageObjectCount: 2,
      externalCleanupPending: true
    });
    expect(
      await prisma.structuredPartition.findUnique({ where: { id: "download_part_0" } })
    ).toBeNull();
    expect(
      await prisma.structuredPartition.findUniqueOrThrow({ where: { id: retained.id } })
    ).toEqual(retained);
    expect(
      await prisma.structuredPartition.findUniqueOrThrow({ where: { id: otherOrgPartition.id } })
    ).toEqual(otherOrgPartition);
    expect(await prisma.partitionImportJob.findUniqueOrThrow({ where: { id: job.id } })).toEqual(
      job
    );
    expect(await prisma.processingRun.findUniqueOrThrow({ where: { id: sourceRun.id } })).toEqual(
      sourceRun
    );
    expect(await prisma.employee.findUniqueOrThrow({ where: { id: employee.id } })).toEqual(
      employee
    );
    expect(
      await repository.publish(lease, {
        objectKey,
        byteSize: 1n,
        checksumSha256: "a".repeat(64),
        expiresAt: request.expiresAt
      })
    ).toBe(false);
    const garbage = await prisma.storageGarbage.findMany({
      where: {
        id: { not: unrelatedGarbage.id },
        OR: [
          { objectKey: { startsWith: "download-test/" } },
          { objectKey: { startsWith: `partition-downloads/${orgId}/` } }
        ]
      },
      select: { id: true, objectKey: true },
      orderBy: { objectKey: "asc" }
    });
    expect(garbage.map(({ objectKey }) => objectKey)).toEqual([
      "download-test/source-0",
      objectKey
    ]);
    const garbageIds = new Set(garbage.map(({ id }) => id));
    const gc = createPrismaStructuredPartitionRepository({ prisma });
    const objects = new Set(["download-test/source-0", "download-test/source-1", objectKey]);
    for (let round = 0; round < 2; round++) {
      for (const item of await gc.listDueGarbage(new Date(Date.now() + round * 86400001), 100)) {
        // This fixture simulates GC only for its asserted cleanup outputs.
        if (!garbageIds.has(item.id)) continue;
        objects.delete(item.objectKey);
        await gc.deleteGarbage(item.id);
      }
      expect(objects.has("download-test/source-1")).toBe(true);
      expect(objects.has(objectKey)).toBe(false);
      expect(
        await prisma.storageGarbage.findUnique({ where: { id: unrelatedGarbage.id } })
      ).toEqual(unrelatedGarbage);
      if (!round) objects.add(objectKey); // A paused upload completes after the first GC pass.
    }
    expect(await prisma.storageGarbage.findFirst({ where: { objectKey } })).toMatchObject({
      repeatDeletion: true
    });
    expect(await prisma.auditLog.findFirst({ where: { orgId } })).toMatchObject({
      action: "partition.store_cleanup",
      metadata: { deletedPartitionCount: 1, externalCleanupPending: true }
    });
  });

  // Pause a real transaction after its source-lock query, without replacing any SQL behavior.
  function pausedClient(marker: string) {
    let release!: () => void;
    let reached!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const entered = new Promise<void>((resolve) => {
      reached = resolve;
    });
    let paused = false;
    const client = new Proxy(prisma, {
      get(target, key) {
        if (key !== "$transaction") return Reflect.get(target, key);
        return (fn: (tx: Prisma.TransactionClient) => Promise<unknown>, options: unknown) =>
          target.$transaction(
            async (tx) =>
              fn(
                new Proxy(tx, {
                  get(t, k) {
                    if (k !== "$queryRaw") return Reflect.get(t, k);
                    return async (sql: Prisma.Sql) => {
                      const result = await t.$queryRaw(sql);
                      if (!paused && sql.sql.includes(marker)) {
                        paused = true;
                        reached();
                        await gate;
                      }
                      return result;
                    };
                  }
                })
              ),
            options as Parameters<PrismaClient["$transaction"]>[1]
          );
      }
    });
    return { client, entered, release };
  }
  async function waitForSourceLockWait() {
    for (let i = 0; i < 200; i++) {
      const rows = await prisma.$queryRaw<{ n: bigint }[]>(
        Prisma.sql`SELECT COUNT(*) AS n FROM performance_schema.data_lock_waits w JOIN performance_schema.data_locks l ON w.REQUESTING_ENGINE_LOCK_ID=l.ENGINE_LOCK_ID WHERE l.OBJECT_SCHEMA=DATABASE() AND l.OBJECT_NAME IN ('structured_partitions', 'processing_runs', 'employees')`
      );
      if (Number(rows[0]!.n) > 0) return;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    throw new Error("Expected real MySQL lock wait");
  }
  function urlApp(
    downloads = repository,
    sign = vi.fn(async () => "https://synthetic.invalid/signed"),
    auditAppend: (...args: unknown[]) => Promise<void> = async () => {}
  ) {
    const app = Fastify();
    registerPartitionDownloadRoutes(app, {
      auth: { authenticate: async () => true, employee: () => actor } as unknown as RequestAuth,
      downloads: () => downloads,
      storage: () => ({ createDownloadUrl: sign }) as unknown as StorageAdapter,
      audit: () => ({ append: auditAppend }),
      createBusinessRequestAudit: () => ({
        requestId: "race",
        sourceIp: "127.0.0.1",
        clientSource: "http_api",
        launcherVersion: null
      })
    });
    return app;
  }
  async function publishedRequest() {
    const request = await repository.prepare(actor, scope, "issuance-race");
    const lease = await leaseFor(request.requestId);
    const objectKey = `partition-downloads/${orgId}/${request.requestId}/1/url.zip`;
    await repository.registerCandidate(lease, objectKey);
    expect(
      await repository.publish(lease, {
        objectKey,
        byteSize: 1n,
        checksumSha256: "a".repeat(64),
        expiresAt: request.expiresAt
      })
    ).toBe(true);
    return request;
  }
  it.each(["cleanup", "source", "authority"])(
    "HTTP URL signing holds validation locks against concurrent %s mutation",
    async (mutation) => {
      await partitions();
      const inventory = await cleanup.buildStoreCleanupInventory(cleanupScope);
      const request = await publishedRequest();
      let entered!: () => void;
      let release!: () => void;
      const signing = new Promise<void>((resolve) => {
        entered = resolve;
      });
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const sign = vi.fn(async () => {
        entered();
        await gate;
        return "https://synthetic.invalid/signed";
      });
      const app = urlApp(repository, sign);
      const issue = () =>
        app.inject({
          method: "POST",
          url: `/v1/structured/partition-downloads/${request.requestId}/url`
        });
      const response = issue();
      await signing;
      const write =
        mutation === "cleanup"
          ? cleanup.executeStoreCleanup({ inventory, expectedFingerprint: inventory.fingerprint })
          : mutation === "source"
            ? prisma.structuredPartition
                .update({
                  where: { id: "download_part_0" },
                  data: { checksumSha256: "b".repeat(64) }
                })
                .then((row) => row)
            : prisma.employee
                .update({ where: { id: actor.id }, data: { disabled: true } })
                .then((row) => row);
      try {
        await waitForSourceLockWait();
      } finally {
        release();
        await Promise.allSettled([response, write]);
      }
      try {
        expect((await response).statusCode).toBe(200);
        await write;
        expect((await issue()).statusCode).toBe(mutation === "authority" ? 403 : 409);
        expect(sign).toHaveBeenCalledTimes(1);
      } finally {
        await app.close();
      }
    }
  );
  it("HTTP URL issuance waits for an in-flight cleanup and never signs its invalidated object", async () => {
    await partitions();
    const inventory = await cleanup.buildStoreCleanupInventory(cleanupScope);
    const request = await publishedRequest();
    const barrier = pausedClient("enterprise_key AS enterpriseKey");
    const cleaning = createStoreCleanupRepository(barrier.client).executeStoreCleanup({
      inventory,
      expectedFingerprint: inventory.fingerprint
    });
    await barrier.entered;
    const sign = vi.fn(async () => "https://synthetic.invalid/signed");
    const app = urlApp(repository, sign);
    const response = app.inject({
      method: "POST",
      url: `/v1/structured/partition-downloads/${request.requestId}/url`
    });
    try {
      await waitForSourceLockWait();
    } finally {
      barrier.release();
      await Promise.allSettled([cleaning, response]);
    }
    try {
      await cleaning;
      expect((await response).statusCode).toBe(409);
      expect(sign).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });
  it.each(["cleanup-first", "publish-first"])(
    "serializes actual cleanup/publication race: %s",
    async (order) => {
      await partitions();
      const inventory = await cleanup.buildStoreCleanupInventory(cleanupScope);
      const request = await repository.prepare(actor, scope, "cleanup-race");
      const lease = await leaseFor(request.requestId);
      const objectKey = `partition-downloads/${orgId}/${request.requestId}/1/race.zip`;
      await repository.registerCandidate(lease, objectKey);
      const artifact = {
        objectKey,
        byteSize: 1n,
        checksumSha256: "a".repeat(64),
        expiresAt: request.expiresAt
      };
      const barrier = pausedClient(
        order === "cleanup-first"
          ? "enterprise_key AS enterpriseKey"
          : "SELECT id FROM structured_partitions"
      );
      const first =
        order === "cleanup-first"
          ? createStoreCleanupRepository(barrier.client).executeStoreCleanup({
              inventory,
              expectedFingerprint: inventory.fingerprint
            })
          : createPrismaPartitionDownloadRepository({ prisma: barrier.client }).publish(
              lease,
              artifact
            );
      await barrier.entered;
      const second =
        order === "cleanup-first"
          ? repository.publish(lease, artifact)
          : cleanup.executeStoreCleanup({ inventory, expectedFingerprint: inventory.fingerprint });
      try {
        await waitForSourceLockWait();
      } finally {
        barrier.release();
        await Promise.allSettled([first, second]);
      }
      const results = await Promise.all([first, second]);
      expect(results[order === "cleanup-first" ? 1 : 0]).toBe(order === "publish-first");
      expect(
        await prisma.partitionDownloadRequest.findUniqueOrThrow({
          where: { id: request.requestId }
        })
      ).toMatchObject({ status: "failed", errorCode: "PARTITION_DOWNLOAD_STALE", objectKey: null });
      expect(await prisma.structuredPartition.count({ where: { orgId } })).toBe(0);
      expect(await prisma.storageGarbage.findFirst({ where: { objectKey } })).not.toBeNull();
    }
  );
  it("publication and later source additions preserve the fixed manifest", async () => {
    await partitions();
    const request = await repository.prepare(actor, scope, "insert-race");
    const lease = await leaseFor(request.requestId);
    const objectKey = `partition-downloads/${orgId}/${request.requestId}/1/insert.zip`;
    await repository.registerCandidate(lease, objectKey);
    const barrier = pausedClient("SELECT id FROM structured_partitions");
    const publication = createPrismaPartitionDownloadRepository({ prisma: barrier.client }).publish(
      lease,
      { objectKey, byteSize: 1n, checksumSha256: "a".repeat(64), expiresAt: request.expiresAt }
    );
    await barrier.entered;
    await prisma.partitionImportJob.update({
      where: { id: "download_source" },
      data: { status: "processing" }
    });
    const source = createPrismaStructuredPartitionRepository({ prisma });
    const insertion = source.publishSourceAtomically({
      orgId,
      jobId: "download_source",
      totalRowCount: 1n,
      candidates: [
        {
          id: "download_added",
          orgId,
          enterpriseKey: "synthetic",
          enterpriseName: "Synthetic",
          dataset: "business",
          storeKey: "extra",
          merchantId: "extra",
          storeName: "Store extra",
          businessDate: "2026-10-01",
          objectKey: "download-test/extra",
          checksumSha256: "b".repeat(64),
          rowCount: 1n,
          byteSize: 1n,
          confidentialityLevel: 2
        }
      ]
    });
    try {
      await insertion;
    } finally {
      barrier.release();
      await Promise.allSettled([publication, insertion]);
    }
    expect(await publication).toBe(true);
    await insertion;
    expect((await repository.validateCurrent(actor, request.requestId)).manifest).toHaveLength(1);
  });
});
