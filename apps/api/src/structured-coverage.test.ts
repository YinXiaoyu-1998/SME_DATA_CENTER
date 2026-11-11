import { beforeEach, describe, expect, it, vi } from "vitest";
import { compileStructuredCoverageQuery } from "@smedc/domain";
import { createPrismaStructuredCoverageRepository } from "./structured-coverage.js";

const prisma = vi.hoisted(() => ({
  $queryRawUnsafe: vi.fn(),
  $disconnect: vi.fn()
}));

vi.mock("@prisma/adapter-mariadb", () => ({
  PrismaMariaDb: class PrismaMariaDb {}
}));

vi.mock("@prisma/client", async (importOriginal) => {
  return {
    ...(await importOriginal<typeof import("@prisma/client")>()),
    PrismaClient: class PrismaClient {
      constructor() {
        return prisma;
      }
    }
  };
});

describe("Prisma structured coverage repository", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("serializes window coverage rows with ISO timestamps, date-only windows, and safe numbers", async () => {
    prisma.$queryRawUnsafe.mockResolvedValueOnce([
      {
        import_batch_id: "batch_1",
        source_document_id: "doc_1",
        source_document_title: "Dishes July",
        applied_at: new Date("2026-08-01T03:04:05.000Z"),
        row_count: BigInt(42),
        start_date: new Date("2026-07-01T00:00:00.000Z"),
        end_date: new Date("2026-07-31T00:00:00.000Z")
      }
    ]);
    const repository = createPrismaStructuredCoverageRepository("mysql://test");
    const compiled = compileStructuredCoverageQuery({
      orgId: "org_1",
      employee: { clearance: 3 },
      dataset: "dishes"
    });

    await expect(repository.list(compiled)).resolves.toEqual({
      dataset: "dishes",
      metadataPolicy: "window",
      sources: [
        {
          importBatchId: "batch_1",
          sourceDocumentId: "doc_1",
          sourceDocumentTitle: "Dishes July",
          appliedAt: "2026-08-01T03:04:05.000Z",
          rowCount: 42,
          startDate: "2026-07-01",
          endDate: "2026-07-31"
        }
      ]
    });
    expect(prisma.$queryRawUnsafe).toHaveBeenCalledWith(compiled.sql, ...compiled.params);
  });

  it("returns current catalog coverage as the row count and last update time", async () => {
    prisma.$queryRawUnsafe.mockResolvedValueOnce([
      {
        row_count: BigInt(17),
        last_updated_at: new Date("2026-08-19T03:04:05.000Z")
      }
    ]);
    const repository = createPrismaStructuredCoverageRepository("mysql://test");
    const compiled = compileStructuredCoverageQuery({
      orgId: "org_1",
      employee: { clearance: 3 },
      dataset: "dish_catalog"
    });

    await expect(repository.list(compiled)).resolves.toEqual({
      dataset: "dish_catalog",
      metadataPolicy: "current",
      rowCount: 17,
      lastUpdatedAt: "2026-08-19T03:04:05.000Z"
    });
    expect(prisma.$queryRawUnsafe).toHaveBeenCalledWith(compiled.sql, ...compiled.params);
  });

  it("returns zero rows and no timestamp for an authorized but empty current catalog", async () => {
    prisma.$queryRawUnsafe.mockResolvedValueOnce([{ row_count: BigInt(0), last_updated_at: null }]);
    const repository = createPrismaStructuredCoverageRepository("mysql://test");

    await expect(
      repository.list(
        compileStructuredCoverageQuery({
          orgId: "org_1",
          employee: { clearance: 3 },
          dataset: "dish_catalog"
        })
      )
    ).resolves.toEqual({
      dataset: "dish_catalog",
      metadataPolicy: "current",
      rowCount: 0,
      lastUpdatedAt: null
    });
  });

  it("returns empty sources without querying for derived or metadata-free datasets", async () => {
    const repository = createPrismaStructuredCoverageRepository("mysql://test");

    await expect(
      repository.list(
        compileStructuredCoverageQuery({
          orgId: "org_1",
          employee: { clearance: 3 },
          dataset: "supplier_catalog"
        })
      )
    ).resolves.toEqual({
      dataset: "supplier_catalog",
      metadataPolicy: "none",
      sources: []
    });
    expect(prisma.$queryRawUnsafe).not.toHaveBeenCalled();
  });
});
