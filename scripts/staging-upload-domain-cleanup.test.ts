import { describe, expect, it, vi } from "vitest";
import type { StagingUploadDomainCleanupInventory } from "./staging-upload-domain-cleanup-support.js";
import {
  runStagingUploadDomainCleanup,
  runStagingUploadDomainCleanupCli,
  type StagingUploadDomainCleanupRuntimeAdapter
} from "./staging-upload-domain-cleanup.js";

const inventory: StagingUploadDomainCleanupInventory = {
  documentIds: ["doc-1"],
  processingRunIds: ["run-1"],
  documentChunkIds: ["chunk-1"],
  documentIndexIds: ["index-1"],
  importBatchIds: ["batch-1"],
  importWindowClaimIds: ["claim-1"],
  structuredPartitionIds: ["dish-1"],
  partitionImportJobIds: ["business-1"],
  costCardIds: ["card-1"],
  costCardResourceIds: ["resource-1"],
  storageGarbageIds: ["garbage-1"],
  quarantineCertificateIds: ["certificate-1"],
  vipRowIds: ["vip-1"],
  dishCatalogRowIds: ["catalog-1"],
  uploadAuditLogIds: ["audit-1"],
  storageObjectKeys: ["uploads/private.csv"],
  qdrantPoints: [{ collection: "evidence", pointId: "point-1" }]
};

function createAdapter(): StagingUploadDomainCleanupRuntimeAdapter {
  return {
    close: vi.fn(async () => undefined),
    collectInventory: vi.fn(async () => inventory),
    deleteQdrantPoints: vi.fn(async () => undefined),
    deleteOssObjects: vi.fn(async () => undefined),
    deleteUploadAuditLogs: vi.fn(async () => undefined),
    deleteProcessingRuns: vi.fn(async () => undefined),
    deleteDocumentChunks: vi.fn(async () => undefined),
    deleteDocumentIndexes: vi.fn(async () => undefined),
    deleteImportWindowClaims: vi.fn(async () => undefined),
    deleteStructuredPartitions: vi.fn(async () => undefined),
    deletePartitionImportJobs: vi.fn(async () => undefined),
    deleteCostCardResources: vi.fn(async () => undefined),
    deleteCostCards: vi.fn(async () => undefined),
    deleteStorageGarbage: vi.fn(async () => undefined),
    deleteQuarantineCertificates: vi.fn(async () => undefined),
    deleteVipRows: vi.fn(async () => undefined),
    deleteDishCatalogRows: vi.fn(async () => undefined),
    deleteImportBatches: vi.fn(async () => undefined),
    deleteDocuments: vi.fn(async () => undefined),
    verifyPostCleanup: vi.fn(async () => ({
      documents: 0,
      processingRuns: 0,
      documentChunks: 0,
      documentIndexes: 0,
      importBatches: 0,
      importWindowClaims: 0,
      structuredPartitions: 0,
      partitionImportJobs: 0,
      costCards: 0,
      costCardResources: 0,
      storageGarbage: 0,
      quarantineCertificates: 0,
      vipRows: 0,
      dishCatalogRows: 0,
      uploadAuditLogs: 0,
      storageObjects: 0,
      qdrantPoints: 0
    }))
  };
}

describe("staging upload-domain cleanup CLI", () => {
  it("defaults to dry-run and logs only the safe plan", async () => {
    const adapter = createAdapter();
    const log = vi.fn();

    await runStagingUploadDomainCleanup({
      argv: ["--target", "staging"],
      adapter,
      log
    });

    expect(adapter.collectInventory).toHaveBeenCalledOnce();
    expect(adapter.deleteDocuments).not.toHaveBeenCalled();
    expect(adapter.verifyPostCleanup).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith(
      expect.objectContaining({ mode: "dry-run", documentIds: ["doc-1"] })
    );
    expect(JSON.stringify(log.mock.calls)).not.toContain("uploads/private.csv");
  });

  it("refuses an executable cleanup without the exact staging target and confirmation", async () => {
    const adapter = createAdapter();

    await expect(
      runStagingUploadDomainCleanup({
        argv: ["--execute", "--target", "production", "--confirm", "delete-upload-domain"],
        adapter,
        log: vi.fn()
      })
    ).rejects.toThrow("--target staging");
    await expect(
      runStagingUploadDomainCleanup({
        argv: ["--execute", "--target", "staging", "--confirm", "yes"],
        adapter,
        log: vi.fn()
      })
    ).rejects.toThrow("--confirm delete-upload-domain");
    expect(adapter.collectInventory).not.toHaveBeenCalled();
  });

  it("rejects invalid CLI flags before constructing the runtime adapter", async () => {
    const adapterFactory = vi.fn(async () => createAdapter());

    await expect(
      runStagingUploadDomainCleanupCli({
        argv: ["--execute", "--target", "production", "--confirm", "delete-upload-domain"],
        createAdapter: adapterFactory,
        log: vi.fn()
      })
    ).rejects.toThrow("--target staging");
    await expect(
      runStagingUploadDomainCleanupCli({
        argv: ["--execute", "--target", "staging", "--confirm", "no"],
        createAdapter: adapterFactory,
        log: vi.fn()
      })
    ).rejects.toThrow("--confirm delete-upload-domain");
    expect(adapterFactory).not.toHaveBeenCalled();
  });

  it("closes the runtime adapter after a successful CLI run", async () => {
    const adapter = createAdapter();
    const close = vi.fn(async () => undefined);

    await runStagingUploadDomainCleanupCli({
      argv: ["--target", "staging"],
      createAdapter: vi.fn(async () => ({ ...adapter, close })),
      log: vi.fn()
    });

    expect(close).toHaveBeenCalledOnce();
  });

  it("closes the runtime adapter when the CLI run fails", async () => {
    const adapter = createAdapter();
    const failure = new Error("inventory failed");
    adapter.collectInventory = vi.fn(async () => {
      throw failure;
    });
    const close = vi.fn(async () => undefined);

    await expect(
      runStagingUploadDomainCleanupCli({
        argv: ["--target", "staging"],
        createAdapter: vi.fn(async () => ({ ...adapter, close })),
        log: vi.fn()
      })
    ).rejects.toThrow(failure);

    expect(close).toHaveBeenCalledOnce();
  });

  it("executes only the plan's enumerated DB, OSS, and Qdrant targets after confirmation", async () => {
    const adapter = createAdapter();
    const log = vi.fn();

    await runStagingUploadDomainCleanup({
      argv: ["--execute", "--target", "staging", "--confirm", "delete-upload-domain"],
      adapter,
      log
    });

    expect(adapter.deleteQdrantPoints).toHaveBeenCalledWith(inventory.qdrantPoints);
    expect(adapter.deleteOssObjects).toHaveBeenCalledWith(inventory.storageObjectKeys);
    expect(adapter.deleteUploadAuditLogs).toHaveBeenCalledWith(inventory.uploadAuditLogIds);
    expect(adapter.deleteProcessingRuns).toHaveBeenCalledWith(inventory.processingRunIds);
    expect(adapter.deleteDocumentChunks).toHaveBeenCalledWith(inventory.documentChunkIds);
    expect(adapter.deleteDocumentIndexes).toHaveBeenCalledWith(inventory.documentIndexIds);
    expect(adapter.deleteImportWindowClaims).toHaveBeenCalledWith(inventory.importWindowClaimIds);
    expect(adapter.deleteStructuredPartitions).toHaveBeenCalledWith(
      inventory.structuredPartitionIds
    );
    expect(adapter.deletePartitionImportJobs).toHaveBeenCalledWith(inventory.partitionImportJobIds);
    expect(adapter.deleteCostCardResources).toHaveBeenCalledWith(inventory.costCardResourceIds);
    expect(adapter.deleteCostCards).toHaveBeenCalledWith(inventory.costCardIds);
    expect(vi.mocked(adapter.deleteCostCardResources).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(adapter.deleteCostCards).mock.invocationCallOrder[0]!
    );
    expect(vi.mocked(adapter.deleteCostCards).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(adapter.deleteImportBatches).mock.invocationCallOrder[0]!
    );
    expect(adapter.deleteStorageGarbage).toHaveBeenCalledWith(inventory.storageGarbageIds);
    expect(adapter.deleteQuarantineCertificates).toHaveBeenCalledWith(
      inventory.quarantineCertificateIds
    );
    expect(adapter.deleteVipRows).toHaveBeenCalledWith(inventory.vipRowIds);
    expect(adapter.deleteDishCatalogRows).toHaveBeenCalledWith(inventory.dishCatalogRowIds);
    expect(adapter.deleteImportBatches).toHaveBeenCalledWith(inventory.importBatchIds);
    expect(adapter.deleteDocuments).toHaveBeenCalledWith(inventory.documentIds);
    expect(adapter.verifyPostCleanup).toHaveBeenCalledOnce();
    expect(JSON.stringify(log.mock.calls)).not.toContain("uploads/private.csv");
  });
});
