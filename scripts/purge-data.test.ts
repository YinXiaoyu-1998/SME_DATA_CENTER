import path from "node:path";
import { describe, expect, it, vi } from "vitest";

const prisma = vi.hoisted(() => ({
  auditLog: { deleteMany: vi.fn(async () => ({ count: 0 })) },
  partitionDownloadRequest: { deleteMany: vi.fn(async () => ({ count: 0 })) },
  processingRun: { deleteMany: vi.fn(async () => ({ count: 0 })) },
  ledgerPdfReconciliationTarget: { deleteMany: vi.fn(async () => ({ count: 0 })) },
  ledgerArtifactRequestItem: { deleteMany: vi.fn(async () => ({ count: 0 })) },
  ledgerArtifactRequest: {
    updateMany: vi.fn(async () => ({ count: 0 })),
    deleteMany: vi.fn(async () => ({ count: 0 }))
  },
  ledgerPdfSource: { deleteMany: vi.fn(async () => ({ count: 0 })) },
  ledgerPdfPartition: { deleteMany: vi.fn(async () => ({ count: 0 })) },
  ledgerPdfReconciliationRun: { deleteMany: vi.fn(async () => ({ count: 0 })) },
  deliveryLedgerRow: { deleteMany: vi.fn(async () => ({ count: 0 })) },
  supplierCatalogRow: { deleteMany: vi.fn(async () => ({ count: 0 })) },
  quarantineCertificate: { deleteMany: vi.fn(async () => ({ count: 0 })) },
  structuredPartition: { deleteMany: vi.fn(async () => ({ count: 0 })) },
  storageGarbage: { deleteMany: vi.fn(async () => ({ count: 0 })) },
  partitionImportJob: { deleteMany: vi.fn(async () => ({ count: 0 })) },
  vipRow: { deleteMany: vi.fn(async () => ({ count: 0 })) },
  dishCatalogRow: { deleteMany: vi.fn(async () => ({ count: 0 })) },
  importWindowClaim: { deleteMany: vi.fn(async () => ({ count: 0 })) },
  importBatch: { deleteMany: vi.fn(async () => ({ count: 0 })) },
  document: { deleteMany: vi.fn(async () => ({ count: 0 })) },
  $transaction: vi.fn(),
  $disconnect: vi.fn(async () => undefined)
}));

vi.mock("@prisma/adapter-mariadb", () => ({ PrismaMariaDb: class PrismaMariaDb {} }));
vi.mock("@prisma/client", () => ({
  PrismaClient: class PrismaClient {
    constructor() {
      return prisma;
    }
  }
}));

import { purgeLocalData, resolveLocalDatabaseTarget, resolvePurgeTargets } from "./purge-data.js";

describe("purge-data target resolution", () => {
  const cwd = "/workspace/smedc";

  it("targets local upload and test storage directories by default", () => {
    expect(
      resolvePurgeTargets({
        all: false,
        dryRun: false,
        filesOnly: false,
        cwd,
        env: {}
      })
    ).toEqual([
      { label: "local upload storage", path: path.join(cwd, ".data", "storage") },
      {
        label: "integration test storage",
        path: path.join(cwd, ".data", "integration", "storage")
      },
      {
        label: "MCP smoke test storage",
        path: path.join(cwd, ".data", "mcp-local-test", "storage")
      }
    ]);
  });

  it("can target the full ignored local data directory", () => {
    expect(
      resolvePurgeTargets({
        all: true,
        dryRun: false,
        filesOnly: false,
        cwd,
        env: {}
      })
    ).toEqual([{ label: "all local .data files", path: path.join(cwd, ".data") }]);
  });

  it("skips a storage root outside the repo .data directory", () => {
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    expect(
      resolvePurgeTargets({
        all: false,
        dryRun: false,
        filesOnly: false,
        cwd,
        env: {
          LOCAL_STORAGE_ROOT: "/tmp/smedc-storage"
        }
      })
    ).toEqual([
      {
        label: "integration test storage",
        path: path.join(cwd, ".data", "integration", "storage")
      },
      {
        label: "MCP smoke test storage",
        path: path.join(cwd, ".data", "mcp-local-test", "storage")
      }
    ]);

    expect(stderrSpy).toHaveBeenCalledWith(
      expect.stringContaining("Skipping local upload storage")
    );
    stderrSpy.mockRestore();
  });
});

describe("purge-data database target resolution", () => {
  it("accepts the local development MySQL database", () => {
    expect(
      resolveLocalDatabaseTarget({
        DATABASE_URL: "mysql://smedc:smedc_local_password@localhost:3307/smedc"
      })
    ).toEqual({
      databaseUrl: "mysql://smedc:smedc_local_password@localhost:3307/smedc",
      host: "localhost:3307",
      databaseName: "smedc"
    });
  });

  it("returns null when DATABASE_URL is missing", () => {
    expect(resolveLocalDatabaseTarget({})).toBeNull();
  });

  it("refuses to target a remote database host", () => {
    expect(() =>
      resolveLocalDatabaseTarget({
        DATABASE_URL: "mysql://smedc:password@example.com:3306/smedc"
      })
    ).toThrow("non-local DATABASE_URL host");
  });

  it("refuses to target a database with an unexpected name", () => {
    expect(() =>
      resolveLocalDatabaseTarget({
        DATABASE_URL: "mysql://smedc:password@localhost:3306/production_hub"
      })
    ).toThrow("database other than smedc");
  });

  it("deletes partition metadata and remaining row tables before documents", async () => {
    vi.clearAllMocks();
    prisma.$transaction.mockImplementation(async (callback: (tx: typeof prisma) => unknown) =>
      callback(prisma)
    );

    await purgeLocalData({
      all: false,
      dryRun: false,
      filesOnly: false,
      cwd: "/workspace/smedc",
      env: { DATABASE_URL: "mysql://user:password@localhost:3307/smedc" }
    });

    for (const rows of [
      prisma.vipRow,
      prisma.dishCatalogRow,
      prisma.deliveryLedgerRow,
      prisma.supplierCatalogRow
    ]) {
      expect(rows.deleteMany).toHaveBeenCalledWith({});
      expect(rows.deleteMany.mock.invocationCallOrder[0]).toBeLessThan(
        prisma.importBatch.deleteMany.mock.invocationCallOrder[0]!
      );
    }
    expect(prisma.processingRun.deleteMany).toHaveBeenCalledWith({
      where: { OR: expect.arrayContaining([{ partitionDownloadRequestId: { not: null } }]) }
    });
    expect(prisma.partitionDownloadRequest.deleteMany).toHaveBeenCalledWith({});
    expect(prisma.processingRun.deleteMany.mock.invocationCallOrder[0]).toBeLessThan(
      prisma.partitionDownloadRequest.deleteMany.mock.invocationCallOrder[0]!
    );
    expect(prisma.importWindowClaim.deleteMany).toHaveBeenCalledWith({});
    expect(prisma.importBatch.deleteMany).toHaveBeenCalledWith({});
    expect(prisma.structuredPartition.deleteMany).toHaveBeenCalledWith({});
    expect(prisma.partitionImportJob.deleteMany).toHaveBeenCalledWith({});
    expect(prisma.document.deleteMany).toHaveBeenCalledWith({});
    expect(
      prisma.ledgerPdfReconciliationTarget.deleteMany.mock.invocationCallOrder[0]
    ).toBeLessThan(prisma.ledgerArtifactRequestItem.deleteMany.mock.invocationCallOrder[0]!);
    expect(prisma.ledgerPdfSource.deleteMany.mock.invocationCallOrder[0]).toBeLessThan(
      prisma.document.deleteMany.mock.invocationCallOrder[0]!
    );
  });
});
