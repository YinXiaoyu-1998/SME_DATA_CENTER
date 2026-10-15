import {
  findReadableCurrentSupplierCatalog,
  findSupplierCatalogMatches,
  dynamicValuesFor
} from "@smedc/ledger-archive";
import { createDatabaseAdapter } from "@smedc/db";
import { PrismaClient } from "@prisma/client";
import type { StructuredCompiledQuery } from "@smedc/domain";
import { COST_CARD_DIRECTORY_REGISTRY } from "@smedc/domain";
import { safeCostCardInteger } from "@smedc/db";

export interface ExecuteStructuredQueryResult {
  rows: Array<Record<string, unknown>>;
  hasMore: boolean;
}

export interface StructuredQueryRepository {
  execute(compiled: StructuredCompiledQuery): Promise<ExecuteStructuredQueryResult>;
  disconnect?(): Promise<void>;
}

const STRUCTURED_QUERY_SUPPLIER_NAME = "structured_query_supplier_name";

function serializeStructuredQueryValue(value: unknown): unknown {
  if (typeof value !== "bigint") {
    return value;
  }

  if (value <= BigInt(Number.MAX_SAFE_INTEGER) && value >= BigInt(Number.MIN_SAFE_INTEGER)) {
    return Number(value);
  }

  return value.toString();
}

function serializeStructuredQueryRow(row: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(row).map(([key, value]) => [key, serializeStructuredQueryValue(value)])
  );
}

function requireDatabaseUrl(): string {
  const databaseUrl = process.env["DATABASE_URL"];

  if (!databaseUrl) {
    throw new Error(
      "DATABASE_URL is required to start the API with the Prisma structured query repository."
    );
  }

  return databaseUrl;
}

export function createPrismaStructuredQueryRepository(
  databaseUrl = requireDatabaseUrl()
): StructuredQueryRepository {
  const adapter = createDatabaseAdapter(databaseUrl);
  const prisma = new PrismaClient({ adapter });

  return {
    async execute(compiled) {
      const params = [...compiled.params];
      const limitParamIndex = params.length - 2;
      params[limitParamIndex] = compiled.limit + 1;
      const rows = (await prisma.$queryRawUnsafe(compiled.sql, ...params)) as Array<
        Record<string, unknown>
      >;
      const visibleRows = rows.slice(0, compiled.limit);
      const hasMore = rows.length > compiled.limit;
      if (compiled.dataset === "cost_cards") {
        return {
          hasMore,
          rows: visibleRows.map((row) =>
            Object.fromEntries(
              compiled.selectedFields.map((name) => {
                const field = COST_CARD_DIRECTORY_REGISTRY.fields.find(
                  (field) => field.canonicalName === name
                )!;
                const value = row[name];
                if (field.type === "integer")
                  return [name, safeCostCardInteger(value as bigint | number)];
                if (field.type === "boolean") {
                  if (![true, false, 0, 1, 0n, 1n].includes(value as boolean | number | bigint))
                    throw new Error("COST_CARD_METADATA_INVALID");
                  return [name, value === true || value === 1 || value === 1n];
                }
                if (value !== null && typeof value !== "string")
                  throw new Error("COST_CARD_METADATA_INVALID");
                return [name, value];
              })
            )
          )
        };
      }
      if (
        compiled.dataset !== "delivery_ledger" ||
        compiled.mode !== "detail" ||
        compiled.dynamicSelectedFields.length === 0 ||
        visibleRows.length === 0
      )
        return { rows: visibleRows.map(serializeStructuredQueryRow), hasMore };

      const supplierNames = uniqueSupplierNames(visibleRows);
      const currentCatalog =
        supplierNames.length > 0
          ? await findReadableCurrentSupplierCatalog(prisma, compiled.authorizationScope)
          : null;
      const catalogRows = currentCatalog
        ? await findSupplierCatalogMatches(
            prisma,
            currentCatalog.id,
            currentCatalog.source_document_id,
            supplierNames,
            compiled.dynamicSelectedFields,
            compiled.authorizationScope.orgId
          )
        : [];
      const matchesByName = new Map<string, Array<Record<string, unknown>>>();
      for (const catalogRow of catalogRows) {
        const supplierName = catalogRow["supplier_name"];
        if (typeof supplierName !== "string") continue;
        const matches = matchesByName.get(supplierName) ?? [];
        matches.push(catalogRow);
        matchesByName.set(supplierName, matches);
      }
      const nullDynamicValues = Object.fromEntries(
        compiled.dynamicSelectedFields.map((field) => [field, null])
      );

      return {
        rows: visibleRows.map((row) => {
          const supplierName = row[STRUCTURED_QUERY_SUPPLIER_NAME] ?? row["supplier_name"];
          const matches = typeof supplierName === "string" ? matchesByName.get(supplierName) : [];
          const values = matches?.length === 1 ? dynamicValuesFor(matches[0]!, compiled) : {};
          return serializeStructuredDetailRow(row, compiled, { ...nullDynamicValues, ...values });
        }),
        hasMore
      };
    },
    async disconnect() {
      await prisma.$disconnect();
    }
  };
}

function uniqueSupplierNames(rows: Array<Record<string, unknown>>): string[] {
  return [
    ...new Set(
      rows
        .map((row) => row[STRUCTURED_QUERY_SUPPLIER_NAME] ?? row["supplier_name"])
        .filter((value): value is string => typeof value === "string" && value.length > 0)
    )
  ];
}

function withoutInternalSupplierName(row: Record<string, unknown>): Record<string, unknown> {
  const publicRow = { ...row };
  delete publicRow[STRUCTURED_QUERY_SUPPLIER_NAME];
  return publicRow;
}

function serializeStructuredDetailRow(
  row: Record<string, unknown>,
  compiled: StructuredCompiledQuery,
  dynamicValues: Record<string, unknown>
): Record<string, unknown> {
  const values = { ...withoutInternalSupplierName(row), ...dynamicValues };
  return serializeStructuredQueryRow(
    Object.fromEntries(
      compiled.selectedFields
        .filter((field) => Object.prototype.hasOwnProperty.call(values, field))
        .map((field) => [field, values[field]])
    )
  );
}
