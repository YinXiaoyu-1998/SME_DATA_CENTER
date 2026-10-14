import type { PrismaClient } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";
import {
  assertStagingCleanupRuntimeTargets,
  createStagingUploadDomainCleanupAdapter
} from "./staging-upload-domain-cleanup-adapter.js";
import { runStagingUploadDomainCleanup } from "./staging-upload-domain-cleanup.js";
import { buildStagingUploadDomainCleanupPlan } from "./staging-upload-domain-cleanup-support.js";

describe("repo-contained staging upload-domain cleanup adapter", () => {
  it("enumerates and deletes only exact DB, OSS, and Qdrant targets through injected providers", async () => {
    const prisma = {
      partitionDownloadRequest: { count: vi.fn(async () => 0) },
      $disconnect: vi.fn(async () => undefined),
      document: {
        findMany: vi.fn(async () => [{ id: "doc-1", storageObjectKey: "uploads/doc-1" }]),
        deleteMany: vi.fn(async () => ({})),
        count: vi.fn(async () => 0)
      },
      documentChunk: {
        findMany: vi.fn(async () => [
          {
            id: "chunk-1",
            qdrantPointId: "point-1",
            documentIndex: { qdrantCollection: "evidence" }
          }
        ]),
        deleteMany: vi.fn(async () => ({})),
        count: vi.fn(async () => 0)
      },
      importBatch: {
        findMany: vi.fn(async () => [
          {
            id: "batch-1",
            windowClaim: { id: "claim-1" },
            structuredPartitions: [{ id: "dish-1" }],
            partitionImportJobs: [{ id: "business-1" }],
            vipRows: [{ id: "vip-1" }],
            dishCatalogRows: [{ id: "catalog-1" }]
          }
        ]),
        deleteMany: vi.fn(async () => ({})),
        count: vi.fn(async () => 0)
      },
      auditLog: {
        findMany: vi.fn(async () => [{ id: "audit-1" }]),
        deleteMany: vi.fn(async () => ({})),
        count: vi.fn(async () => 0)
      },
      processingRun: {
        findMany: vi.fn(async () => [{ id: "run-1" }]),
        deleteMany: vi.fn(async () => ({})),
        count: vi.fn(async () => 0)
      },
      documentIndex: {
        findMany: vi.fn(async () => [{ id: "index-1" }]),
        deleteMany: vi.fn(async () => ({})),
        count: vi.fn(async () => 0)
      },
      importWindowClaim: { deleteMany: vi.fn(async () => ({})), count: vi.fn(async () => 0) },
      partitionImportJob: {
        findMany: vi.fn(async () => []),
        deleteMany: vi.fn(async () => ({})),
        count: vi.fn(async () => 0)
      },
      structuredPartition: {
        findMany: vi.fn(async () => []),
        deleteMany: vi.fn(async () => ({})),
        count: vi.fn(async () => 0)
      },
      costCard: {
        findMany: vi.fn(async () => [{ id: "card-1", objectKey: "cost-cards/current.csv" }]),
        deleteMany: vi.fn(async () => ({})),
        count: vi.fn(async () => 0)
      },
      businessResource: {
        findMany: vi.fn(async () => [{ id: "resource-1" }]),
        deleteMany: vi.fn(async () => ({})),
        count: vi.fn(async () => 0)
      },
      storageGarbage: {
        findMany: vi.fn(async () => [{ id: "garbage-1", objectKey: "cost-cards/candidate.csv" }]),
        deleteMany: vi.fn(async () => ({})),
        count: vi.fn(async () => 0)
      },
      quarantineCertificate: {
        findMany: vi.fn(async () => [{ id: "certificate-1" }]),
        deleteMany: vi.fn(async () => ({})),
        count: vi.fn(async () => 0)
      },
      vipRow: { deleteMany: vi.fn(async () => ({})), count: vi.fn(async () => 0) },
      dishCatalogRow: { deleteMany: vi.fn(async () => ({})), count: vi.fn(async () => 0) }
    } as unknown as PrismaClient;
    const storage = {
      deleteObject: vi.fn(async () => undefined),
      statObject: vi.fn(async () => {
        const error = new Error("not found");
        error.name = "NoSuchKey";
        throw error;
      })
    };
    const qdrant = {
      deletePoints: vi.fn(async () => undefined),
      countPoints: vi.fn(async () => 0)
    };
    const adapter = createStagingUploadDomainCleanupAdapter(
      {
        DATABASE_URL: "mysql://operator:secret@staging.example/smedc",
        QDRANT_URL: "https://qdrant.example"
      },
      { prisma, storage, qdrant }
    );

    const inventory = await adapter.collectInventory();
    expect(inventory).toMatchObject({
      documentIds: ["doc-1"],
      importBatchIds: ["batch-1"],
      quarantineCertificateIds: ["certificate-1"],
      vipRowIds: ["vip-1"],
      dishCatalogRowIds: ["catalog-1"],
      costCardIds: ["card-1"],
      costCardResourceIds: ["resource-1"],
      storageObjectKeys: ["uploads/doc-1", "cost-cards/current.csv", "cost-cards/candidate.csv"],
      qdrantPoints: [{ collection: "evidence", pointId: "point-1" }]
    });
    await adapter.deleteQdrantPoints(inventory.qdrantPoints);
    await adapter.deleteOssObjects(inventory.storageObjectKeys);
    await adapter.deleteQuarantineCertificates(inventory.quarantineCertificateIds);
    await adapter.deleteCostCardResources(inventory.costCardResourceIds);
    await adapter.deleteCostCards(inventory.costCardIds);
    expect(prisma.costCard.findMany).toHaveBeenCalledWith({
      select: { id: true, objectKey: true }
    });
    expect(prisma.businessResource.findMany).toHaveBeenCalledWith({
      where: { kind: "cost_card" },
      select: { id: true }
    });
    expect(prisma.businessResource.deleteMany).toHaveBeenCalledWith({
      where: { kind: "cost_card", id: { in: ["resource-1"] } }
    });
    expect(prisma.costCard.deleteMany).toHaveBeenCalledWith({ where: { id: { in: ["card-1"] } } });
    await adapter.deleteDocuments(inventory.documentIds);
    expect(qdrant.deletePoints).toHaveBeenCalledWith(inventory.qdrantPoints);
    expect(storage.deleteObject).toHaveBeenCalledWith("uploads/doc-1");
    expect(prisma.quarantineCertificate.deleteMany).toHaveBeenCalledWith({
      where: { id: { in: ["certificate-1"] } }
    });
    expect(prisma.document.deleteMany).toHaveBeenCalledWith({ where: { id: { in: ["doc-1"] } } });
    await expect(
      adapter.verifyPostCleanup(
        buildStagingUploadDomainCleanupPlan({
          options: { dryRun: false, target: "staging", confirmation: "delete-upload-domain" },
          inventory
        })
      )
    ).resolves.toMatchObject({ storageObjects: 0 });
    await adapter.close();
    expect(prisma.$disconnect).toHaveBeenCalledOnce();
  });

  it("fails closed when OSS verification reports anything except an identified not-found error", async () => {
    const storage = {
      deleteObject: vi.fn(async () => undefined),
      statObject: vi.fn(async () => {
        throw Object.assign(new Error("denied"), { name: "AccessDenied" });
      })
    };
    const emptyCount = { count: vi.fn(async () => 0) };
    const prisma = {
      document: emptyCount,
      documentLabel: emptyCount,
      processingRun: emptyCount,
      documentChunk: emptyCount,
      documentIndex: emptyCount,
      importBatch: emptyCount,
      importWindowClaim: emptyCount,
      partitionImportJob: emptyCount,
      structuredPartition: emptyCount,
      costCard: emptyCount,
      businessResource: emptyCount,
      storageGarbage: emptyCount,
      quarantineCertificate: emptyCount,
      vipRow: emptyCount,
      dishCatalogRow: emptyCount,
      auditLog: emptyCount
    } as unknown as PrismaClient;
    const adapter = createStagingUploadDomainCleanupAdapter(
      {
        DATABASE_URL: "mysql://operator:secret@staging.example/smedc",
        QDRANT_URL: "https://qdrant.example"
      },
      {
        prisma,
        storage,
        qdrant: { deletePoints: vi.fn(), countPoints: vi.fn(async () => 0) }
      }
    );
    const plan = buildStagingUploadDomainCleanupPlan({
      options: { dryRun: false, target: "staging", confirmation: "delete-upload-domain" },
      inventory: {
        documentIds: [],
        processingRunIds: [],
        documentChunkIds: [],
        documentIndexIds: [],
        importBatchIds: [],
        importWindowClaimIds: [],
        structuredPartitionIds: [],
        partitionImportJobIds: [],
        costCardIds: [],
        costCardResourceIds: [],
        storageGarbageIds: [],
        quarantineCertificateIds: [],
        vipRowIds: [],
        dishCatalogRowIds: [],
        uploadAuditLogIds: [],
        storageObjectKeys: ["uploads/doc-1"],
        qdrantPoints: []
      }
    });
    await expect(adapter.verifyPostCleanup(plan)).rejects.toThrow("denied");
  });

  it("rejects malformed or local Qdrant URLs before creating runtime providers", () => {
    expect(() =>
      createStagingUploadDomainCleanupAdapter({
        DATABASE_URL: "mysql://operator:secret@staging.example/smedc",
        QDRANT_URL: "not-a-url"
      })
    ).toThrow("QDRANT_URL");
    expect(() =>
      createStagingUploadDomainCleanupAdapter({
        DATABASE_URL: "mysql://operator:secret@staging.example/smedc",
        QDRANT_URL: "http://localhost:6333"
      })
    ).toThrow("QDRANT_URL");
    for (const qdrantUrl of ["http://[::1]:6333", "http://[0:0:0:0:0:0:0:1]:6333"]) {
      expect(() =>
        createStagingUploadDomainCleanupAdapter({
          DATABASE_URL: "mysql://operator:secret@staging.example/smedc",
          QDRANT_URL: qdrantUrl
        })
      ).toThrow("QDRANT_URL");
    }
  });

  it("allows the staging loopback Qdrant only when the database provably targets the staging RDS", () => {
    const stagingDatabaseUrl =
      "mysql://smedc_app:secret@rm-2ze2m5q387ydb9724.rwlb.cn-beijing.rds.aliyuncs.com:3306/smedc";

    for (const qdrantUrl of [
      "http://127.0.0.1:6333",
      "http://localhost:6333",
      "http://[::1]:6333",
      "http://[0:0:0:0:0:0:0:1]:6333"
    ]) {
      expect(() =>
        assertStagingCleanupRuntimeTargets({
          DATABASE_URL: stagingDatabaseUrl,
          QDRANT_URL: qdrantUrl
        })
      ).not.toThrow();
    }
  });

  it("still refuses loopback Qdrant for any non-staging database target", () => {
    for (const databaseUrl of [
      "mysql://operator:secret@staging.example/smedc",
      "mysql://smedc_app:secret@rm-2ze2m5q387ydb9724.rwlb.cn-beijing.rds.aliyuncs.com:3306/other_db",
      "mysql://smedc_app:secret@rm-2ze2m5q387ydb9724.rwlb.cn-beijing.rds.aliyuncs.com:3307/smedc"
    ]) {
      expect(() =>
        assertStagingCleanupRuntimeTargets({
          DATABASE_URL: databaseUrl,
          QDRANT_URL: "http://127.0.0.1:6333"
        })
      ).toThrow("QDRANT_URL");
    }
    expect(() =>
      assertStagingCleanupRuntimeTargets({
        DATABASE_URL: "mysql://smedc_app:secret@127.0.0.1:3307/smedc",
        QDRANT_URL: "http://127.0.0.1:6333"
      })
    ).toThrow("DATABASE_URL");
  });

  it("requires both runtime URLs before any cleanup planning", () => {
    const stagingDatabaseUrl =
      "mysql://smedc_app:secret@rm-2ze2m5q387ydb9724.rwlb.cn-beijing.rds.aliyuncs.com:3306/smedc";

    expect(() => assertStagingCleanupRuntimeTargets({ DATABASE_URL: stagingDatabaseUrl })).toThrow(
      "DATABASE_URL and QDRANT_URL"
    );
    expect(() => assertStagingCleanupRuntimeTargets({})).toThrow("DATABASE_URL and QDRANT_URL");
  });
});

it.each(["--dry-run", "--execute"])(
  "overall cleanup %s refuses download requests before external mutations",
  async (mode) => {
    const count = vi.fn(async () => 1);
    const storage = { deleteObject: vi.fn(), statObject: vi.fn() };
    const qdrant = { deletePoints: vi.fn(), countPoints: vi.fn() };
    const adapter = createStagingUploadDomainCleanupAdapter(
      {},
      {
        prisma: { partitionDownloadRequest: { count } } as unknown as PrismaClient,
        storage,
        qdrant
      }
    );
    await expect(
      runStagingUploadDomainCleanup({
        argv: [mode, "--target", "staging", "--confirm", "delete-upload-domain"],
        adapter,
        log: vi.fn()
      })
    ).rejects.toThrow("compatible release");
    expect(count).toHaveBeenCalledWith(); // Existing overall mode has whole-database scope.
    expect(storage.deleteObject).not.toHaveBeenCalled();
    expect(qdrant.deletePoints).not.toHaveBeenCalled();
  }
);
