import { createDatabaseAdapter } from "@enterprise-hub/db";
import { PrismaClient } from "@prisma/client";
import type {
  StructuredCompiledCoverageQuery,
  StructuredCoverageSourceBase,
  StructuredDatasetCoverage
} from "@enterprise-hub/domain";

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
      if (!compiled.sql) {
        return {
          dataset: compiled.dataset,
          metadataPolicy: compiled.metadataPolicy,
          sources: []
        } as StructuredDatasetCoverage;
      }

      const rows = (await prisma.$queryRawUnsafe(
        compiled.sql,
        ...compiled.params
      )) as StructuredCoverageRow[];
      const sources = rows.map(baseCoverageSource);

      if (compiled.metadataPolicy === "snapshot") {
        return {
          dataset: compiled.dataset,
          metadataPolicy: compiled.metadataPolicy,
          sources: rows.map((row, index) => ({
            ...sources[index]!,
            snapshotDate: formatDateOnly(row.start_date)
          }))
        };
      }

      if (compiled.metadataPolicy === "window") {
        return {
          dataset: compiled.dataset,
          metadataPolicy: compiled.metadataPolicy,
          sources: rows.map((row, index) => ({
            ...sources[index]!,
            startDate: formatDateOnly(row.start_date),
            endDate: formatDateOnly(row.end_date)
          }))
        };
      }

      return {
        dataset: compiled.dataset,
        metadataPolicy: compiled.metadataPolicy,
        sources: []
      } as StructuredDatasetCoverage;
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
