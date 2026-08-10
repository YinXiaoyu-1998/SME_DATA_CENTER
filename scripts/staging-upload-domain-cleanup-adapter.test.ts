import type { PrismaClient } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";
import { createStagingUploadDomainCleanupAdapter } from "./staging-upload-domain-cleanup-adapter.js";

describe("repo-contained staging upload-domain cleanup adapter", () => {
  it("enumerates and deletes only exact DB, OSS, and Qdrant targets through injected providers", async () => {
    const prisma = {
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
            dishRows: [{ id: "dish-1" }],
            businessRows: [{ id: "business-1" }]
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
      documentLabel: { count: vi.fn(async () => 1), deleteMany: vi.fn(async () => ({})) },
      importWindowClaim: { deleteMany: vi.fn(async () => ({})), count: vi.fn(async () => 0) },
      dishRow: { deleteMany: vi.fn(async () => ({})), count: vi.fn(async () => 0) },
      businessRow: { deleteMany: vi.fn(async () => ({})), count: vi.fn(async () => 0) }
    } as unknown as PrismaClient;
    const storage = {
      deleteObject: vi.fn(async () => undefined),
      statObject: vi.fn(async () => {
        throw new Error("not found");
      })
    };
    const qdrant = {
      deletePoints: vi.fn(async () => undefined),
      countPoints: vi.fn(async () => 0)
    };
    const adapter = createStagingUploadDomainCleanupAdapter(
      {
        DATABASE_URL: "mysql://operator:secret@staging.example/enterprise_hub",
        QDRANT_URL: "https://qdrant.example"
      },
      { prisma, storage, qdrant }
    );

    const inventory = await adapter.collectInventory();
    expect(inventory).toMatchObject({
      documentIds: ["doc-1"],
      importBatchIds: ["batch-1"],
      storageObjectKeys: ["uploads/doc-1"],
      qdrantPoints: [{ collection: "evidence", pointId: "point-1" }]
    });
    await adapter.deleteQdrantPoints(inventory.qdrantPoints);
    await adapter.deleteOssObjects(inventory.storageObjectKeys);
    await adapter.deleteDocuments(inventory.documentIds);
    expect(qdrant.deletePoints).toHaveBeenCalledWith(inventory.qdrantPoints);
    expect(storage.deleteObject).toHaveBeenCalledWith("uploads/doc-1");
    expect(prisma.document.deleteMany).toHaveBeenCalledWith({ where: { id: { in: ["doc-1"] } } });
  });
});
