import { PrismaMariaDb } from "@prisma/adapter-mariadb";
import { PrismaClient } from "@prisma/client";
import type { StructuredCompiledQuery } from "@enterprise-hub/domain";

export interface ExecuteStructuredQueryResult {
  rows: Array<Record<string, unknown>>;
  hasMore: boolean;
}

export interface StructuredQueryRepository {
  execute(compiled: StructuredCompiledQuery): Promise<ExecuteStructuredQueryResult>;
  disconnect?(): Promise<void>;
}

const STRUCTURED_QUERY_SUPPLIER_NAME = "structured_query_supplier_name";
const SUPPLIER_CONTACT_PHONE = "supplier_contact_phone";
const SUPPLIER_UNIT_ADDRESS = "supplier_unit_address";

interface CurrentSupplierCatalog {
  id: string;
  source_document_id: string;
}

type StructuredQueryAuthorizationScope = StructuredCompiledQuery["authorizationScope"];

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
  const adapter = new PrismaMariaDb(databaseUrl);
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

async function findReadableCurrentSupplierCatalog(
  prisma: PrismaClient,
  scope: StructuredQueryAuthorizationScope
): Promise<CurrentSupplierCatalog | null> {
  const params: Array<string> = [
    scope.orgId,
    "supplier_catalog",
    "applied",
    "structured",
    "active"
  ];
  const clauses = [
    "d.id = latest.source_document_id",
    "d.org_id = latest.org_id",
    "d.document_kind = ?",
    "d.status = ?",
    "d.archived_at IS NULL"
  ];

  if (scope.employee.role !== "admin") {
    const visibleLabels = [
      ...new Set(scope.employee.labels.filter((label) => label !== "all_staff"))
    ].sort();
    const labelPredicate =
      visibleLabels.length === 0
        ? "l.key = ?"
        : `l.key = ? OR l.key IN (${visibleLabels.map(() => "?").join(", ")})`;
    clauses.push(
      `EXISTS (SELECT 1 FROM document_labels dl JOIN labels l ON l.id = dl.label_id WHERE dl.document_id = d.id AND (${labelPredicate}))`
    );
    params.push("all_staff", ...visibleLabels);
  }

  const rows = (await prisma.$queryRawUnsafe(
    `SELECT latest.id, latest.source_document_id
       FROM (
         SELECT ib.id, ib.org_id, ib.source_document_id
           FROM import_batches ib
          WHERE ib.org_id = ?
            AND ib.dataset = ?
            AND ib.status = ?
            AND ib.applied_at IS NOT NULL
            AND ib.archived_at IS NULL
          ORDER BY ib.applied_at DESC, ib.id DESC
          LIMIT 1
       ) latest
       JOIN documents d ON d.id = latest.source_document_id
      WHERE ${clauses.join(" AND ")}
      LIMIT 1`,
    ...params
  )) as Array<CurrentSupplierCatalog>;
  return rows[0] ?? null;
}

async function findSupplierCatalogMatches(
  prisma: PrismaClient,
  importBatchId: string,
  sourceDocumentId: string,
  supplierNames: string[],
  dynamicFields: string[],
  orgId: string
): Promise<Array<Record<string, unknown>>> {
  const selectedColumns = [
    "scr.source_document_id AS source_document_id",
    `JSON_UNQUOTE(JSON_EXTRACT(scr.payload, ?)) AS supplier_name`
  ];
  const params: Array<string> = ["$.supplier_name"];
  if (dynamicFields.includes(SUPPLIER_CONTACT_PHONE)) {
    selectedColumns.push(`JSON_UNQUOTE(JSON_EXTRACT(scr.payload, ?)) AS contact_phone`);
    params.push("$.contact_phone");
  }
  if (dynamicFields.includes(SUPPLIER_UNIT_ADDRESS)) {
    selectedColumns.push(`JSON_UNQUOTE(JSON_EXTRACT(scr.payload, ?)) AS unit_address`);
    params.push("$.unit_address");
  }

  params.push(orgId, importBatchId, sourceDocumentId, "$.supplier_name", ...supplierNames);
  const rows = (await prisma.$queryRawUnsafe(
    `SELECT ${selectedColumns.join(", ")}
       FROM supplier_catalog_rows scr
      WHERE scr.org_id = ?
        AND scr.import_batch_id = ?
        AND scr.source_document_id = ?
        AND JSON_UNQUOTE(JSON_EXTRACT(scr.payload, ?)) IN (${supplierNames.map(() => "?").join(", ")})`,
    ...params
  )) as Array<Record<string, unknown>>;
  return rows;
}

function dynamicValuesFor(
  row: Record<string, unknown>,
  compiled: StructuredCompiledQuery
): Record<string, unknown> {
  return Object.fromEntries(
    compiled.dynamicSelectedFields.flatMap((field) => {
      if (field === SUPPLIER_CONTACT_PHONE) {
        return [[field, nullableValue(row["contact_phone"])]];
      }
      if (field === SUPPLIER_UNIT_ADDRESS) {
        return [[field, nullableValue(row["unit_address"])]];
      }
      return [];
    })
  );
}

function nullableValue(value: unknown): unknown {
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value === "string" && value.trim().length === 0) {
    return null;
  }
  return value;
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
