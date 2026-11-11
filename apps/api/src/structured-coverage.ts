import { createDatabaseAdapter } from "@smedc/db";
import { PrismaClient } from "@prisma/client";
import type {
  StructuredCompiledCoverageQuery,
  StructuredCoverageSourceBase,
  StructuredDatasetCoverage
} from "@smedc/domain";

export interface StructuredCoverageRepository {
  list(compiled: StructuredCompiledCoverageQuery): Promise<StructuredDatasetCoverage>;
  disconnect?(): Promise<void>;
}

interface StructuredCoverageRow {
  import_batch_id: string;
  source_document_id: string;
  source_document_title: string;
  applied_at: Date | string;
  row_count: bigint | number;
  start_date: Date | string | null;
  end_date: Date | string | null;
}

interface StructuredCurrentCoverageRow {
  row_count: bigint | number;
  last_updated_at: Date | string | null;
}

function requireDatabaseUrl(): string {
  const databaseUrl = process.env["DATABASE_URL"];

  if (!databaseUrl) {
    throw new Error(
      "DATABASE_URL is required to start the API with the Prisma structured coverage repository."
    );
  }

  return databaseUrl;
}

export function createPrismaStructuredCoverageRepository(
  databaseUrl = requireDatabaseUrl()
): StructuredCoverageRepository {
  const adapter = createDatabaseAdapter(databaseUrl);
  const prisma = new PrismaClient({ adapter });

  return {
    async list(compiled) {
      // Current-state datasets collapse to one scalar row: how many rows and when the
      // content last actually changed. Authorization is already bound into the SQL.
      if (compiled.metadataPolicy === "current") {
        if (!compiled.sql) {
          return {
            dataset: compiled.dataset,
            metadataPolicy: "current",
            rowCount: 0,
            lastUpdatedAt: null
          };
        }

        const rows = (await prisma.$queryRawUnsafe(
          compiled.sql,
          ...compiled.params
        )) as StructuredCurrentCoverageRow[];
        const row = rows[0];

        return {
          dataset: compiled.dataset,
          metadataPolicy: "current",
          rowCount: formatRowCount(row?.row_count ?? 0),
          lastUpdatedAt: row?.last_updated_at ? formatDateTime(row.last_updated_at) : null
        };
      }

      if (compiled.metadataPolicy === "derived_receipt" || compiled.metadataPolicy === "none") {
        return {
          dataset: compiled.dataset,
          metadataPolicy: compiled.metadataPolicy,
          sources: []
        };
      }

      if (compiled.metadataPolicy === "snapshot") {
        // The snapshot policy is retired; report no sources instead of inventing coverage.
        return {
          dataset: compiled.dataset,
          metadataPolicy: "none",
          sources: []
        };
      }

      if (!compiled.sql) {
        return {
          dataset: compiled.dataset,
          metadataPolicy: "window",
          sources: []
        };
      }

      const rows = (await prisma.$queryRawUnsafe(
        compiled.sql,
        ...compiled.params
      )) as StructuredCoverageRow[];

      return {
        dataset: compiled.dataset,
        metadataPolicy: "window",
        sources: rows.map((row) => ({
          ...baseCoverageSource(row),
          startDate: formatDateOnly(row.start_date),
          endDate: formatDateOnly(row.end_date)
        }))
      };
    },
    async disconnect() {
      await prisma.$disconnect();
    }
  };
}

function baseCoverageSource(row: StructuredCoverageRow): StructuredCoverageSourceBase {
  return {
    importBatchId: row.import_batch_id,
    sourceDocumentId: row.source_document_id,
    sourceDocumentTitle: row.source_document_title,
    appliedAt: formatDateTime(row.applied_at),
    rowCount: formatRowCount(row.row_count)
  };
}

function formatDateTime(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : value;
}

function formatDateOnly(value: Date | string | null): string {
  if (!value) {
    throw new Error("Structured coverage source is missing required date metadata.");
  }

  return value instanceof Date ? value.toISOString().slice(0, 10) : value.slice(0, 10);
}

function formatRowCount(value: bigint | number): number {
  if (typeof value === "number") {
    return value;
  }

  const serialized = Number(value);
  if (!Number.isSafeInteger(serialized)) {
    throw new Error("Structured coverage row count exceeds the safe JSON integer range.");
  }

  return serialized;
}
