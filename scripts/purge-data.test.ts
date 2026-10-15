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
  costCard: {
    findMany: vi.fn(async () => [] as Array<{ orgId: string; id: string }>),
    deleteMany: vi.fn(async () => ({ count: 0 }))
  },
  businessResource: {
    findMany: vi.fn(async () => [] as Array<{ orgId: string; id: string }>),
    count: vi.fn(async () => 0),
    deleteMany: vi.fn(async () => ({ count: 0 }))
  },
  storageGarbage: { deleteMany: vi.fn(async () => ({ count: 0 })) },
  partitionImportJob: { deleteMany: vi.fn(async () => ({ count: 0 })) },
  vipRow: { deleteMany: vi.fn(async () => ({ count: 0 })) },
  dishCatalogRow: { deleteMany: vi.fn(async () => ({ count: 0 })) },
  importWindowClaim: { deleteMany: vi.fn(async () => ({ count: 0 })) },
  importBatch: { deleteMany: vi.fn(async () => ({ count: 0 })) },
  businessResourceScope: { count: vi.fn(async () => 0) },
  document: {
    findMany: vi.fn(async () => [] as Array<{ orgId: string; id: string }>),
    deleteMany: vi.fn(async () => ({ count: 0 }))
  },
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
    expect(prisma.businessResource.deleteMany).toHaveBeenCalledWith({
      where: { kind: "cost_card", OR: [] }
    });
    expect(prisma.costCard.deleteMany).toHaveBeenCalledWith({});
    expect(prisma.businessResource.deleteMany.mock.invocationCallOrder[0]).toBeLessThan(
      prisma.costCard.deleteMany.mock.invocationCallOrder[0]!
    );
    expect(prisma.costCard.deleteMany.mock.invocationCallOrder[0]).toBeLessThan(
      prisma.importBatch.deleteMany.mock.invocationCallOrder[0]!
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

it("purges null-source card resources and mandatory source fragments before restrictive originals", async () => {
  vi.clearAllMocks();
  const remaining = new Map(
    (
      [
        ["org", "card-active", "cost_card", "cost-card:active", null],
        ["org", "card-archived", "cost_card", "cost-card:archived", null],
        ["org", "source-current", "source_fragment", "current:cost", "current"],
        ["org", "source-history", "source_fragment", "historical:cost", "historical"],
        ["other", "unrelated", "cost_card", "cost-card:other", null]
      ] as const
    ).map(
      ([orgId, id, kind, resourceKey, sourceDocumentId]) =>
        [
          id,
          {
            orgId,
            id,
            kind,
            resourceKey,
            sourceDocumentId,
            category: { key: "cost_cards", kind: "fixed" }
          }
        ] as const
    )
  );
  prisma.$transaction.mockImplementation(async (callback) => callback(prisma));
  prisma.document.findMany.mockResolvedValue([
    { orgId: "org", id: "current" },
    { orgId: "org", id: "historical" }
  ]);
  prisma.costCard.findMany.mockResolvedValue([
    { orgId: "org", id: "active" },
    { orgId: "org", id: "archived" }
  ]);
  prisma.businessResource.findMany.mockImplementation(async (...args: unknown[]) => {
    const { where } = args[0] as {
      where: {
        kind: string;
        OR: Array<{ orgId: string; resourceKey?: string; sourceDocumentId?: string }>;
        category?: { key: string };
      };
    };
    return [...remaining.values()]
      .filter(
        (resource) =>
          resource.kind === where.kind &&
          (!where.category || resource.category.key === where.category.key) &&
          where.OR?.some(
            (target) =>
              target.orgId === resource.orgId &&
              (target.resourceKey
                ? target.resourceKey === resource.resourceKey
                : target.sourceDocumentId === resource.sourceDocumentId)
          )
      )
      .map((resource) => ({ orgId: resource.orgId, id: resource.id }));
  });
  prisma.businessResource.deleteMany.mockImplementation(async (...args: unknown[]) => {
    const { where } = args[0] as {
      where: { kind?: string; OR?: Array<{ orgId: string; id: string }> };
    };
    for (const [key, resource] of remaining)
      if (
        (!where.kind || resource.kind === where.kind) &&
        (!where.OR ||
          where.OR.some((target) => target.orgId === resource.orgId && target.id === resource.id))
      )
        remaining.delete(key);
    return { count: 0 };
  });
  prisma.document.deleteMany.mockImplementationOnce(async () => {
    if ([...remaining.values()].some((resource) => resource.sourceDocumentId))
      throw new Error("Restrict: source fragment still references original");
    return { count: 2 };
  });
  await expect(
    purgeLocalData({
      all: false,
      dryRun: false,
      filesOnly: false,
      cwd: "/workspace/smedc",
      env: { DATABASE_URL: "mysql://user:password@localhost:3307/smedc" }
    })
  ).resolves.toMatchObject({ database: { documentsDeleted: 2 } });
  expect([...remaining.keys()]).toEqual(["unrelated"]);
});
