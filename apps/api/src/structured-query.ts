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
      const hasDynamicSupplierFields =
        compiled.dataset === "delivery_ledger" &&
        compiled.mode === "detail" &&
        compiled.dynamicSelectedFields.length > 0;

      if (!hasDynamicSupplierFields || visibleRows.length === 0) {
        return {
          rows: visibleRows.map(serializeStructuredQueryRow),
          hasMore: rows.length > compiled.limit
        };
      }

      const supplierNames = [
        ...new Set(
          visibleRows
            .map((row) => row[STRUCTURED_QUERY_SUPPLIER_NAME] ?? row["supplier_name"])
            .filter((value): value is string => typeof value === "string" && value.length > 0)
        )
      ];
      const nullDynamicValues = Object.fromEntries(
        compiled.dynamicSelectedFields.map((field) => [field, null])
      );
      const publicRows = visibleRows.map((row) => {
        return { ...withoutInternalSupplierName(row), ...nullDynamicValues };
      });

      if (supplierNames.length === 0) {
        return {
          rows: publicRows.map(serializeStructuredQueryRow),
          hasMore: rows.length > compiled.limit
        };
      }

      const currentCatalog = await findCurrentSupplierCatalog(prisma, compiled.authorizationScope);
      if (!currentCatalog) {
        return {
          rows: publicRows.map(serializeStructuredQueryRow),
          hasMore: rows.length > compiled.limit
        };
      }

      const authorized = await canReadCurrentSupplierCatalog(
        prisma,
        currentCatalog.source_document_id,
        compiled.authorizationScope
      );
      if (!authorized) {
        return {
          rows: publicRows.map(serializeStructuredQueryRow),
          hasMore: rows.length > compiled.limit
        };
      }

      const catalogRows = await findSupplierCatalogMatches(
        prisma,
        currentCatalog.id,
        supplierNames,
        compiled.dynamicSelectedFields,
        compiled.authorizationScope.orgId
      );
      const matchesByName = new Map<string, Array<Record<string, unknown>>>();
      for (const catalogRow of catalogRows) {
        const supplierName = catalogRow["supplier_name"];
        if (typeof supplierName !== "string") {
          continue;
        }
        const matches = matchesByName.get(supplierName) ?? [];
        matches.push(catalogRow);
        matchesByName.set(supplierName, matches);
      }

      return {
        rows: visibleRows.map((row) => {
          const supplierName = row[STRUCTURED_QUERY_SUPPLIER_NAME] ?? row["supplier_name"];
          const matches = typeof supplierName === "string" ? matchesByName.get(supplierName) : [];
          const values = matches?.length === 1 ? dynamicValuesFor(matches[0]!, compiled) : {};
          return serializeStructuredQueryRow({
            ...withoutInternalSupplierName(row),
            ...nullDynamicValues,
            ...values
          });
        }),
        hasMore: rows.length > compiled.limit
      };
    },
    async disconnect() {
      await prisma.$disconnect();
    }
  };
}

async function findCurrentSupplierCatalog(
  prisma: PrismaClient,
  scope: StructuredQueryAuthorizationScope
): Promise<CurrentSupplierCatalog | null> {
  const rows = (await prisma.$queryRawUnsafe(
    `SELECT ib.id, ib.source_document_id AS source_document_id
       FROM import_batches ib
       JOIN documents d ON d.id = ib.source_document_id
      WHERE ib.org_id = ?
        AND ib.dataset = ?
        AND ib.status = ?
        AND ib.applied_at IS NOT NULL
        AND ib.archived_at IS NULL
        AND d.org_id = ?
        AND d.document_kind = ?
        AND d.status = ?
        AND d.archived_at IS NULL
      ORDER BY ib.applied_at DESC, ib.id DESC
      LIMIT 1`,
    scope.orgId,
    "supplier_catalog",
    "applied",
    scope.orgId,
    "structured",
    "active"
  )) as Array<CurrentSupplierCatalog>;

  return rows[0] ?? null;
}

async function canReadCurrentSupplierCatalog(
  prisma: PrismaClient,
  documentId: string,
  scope: StructuredQueryAuthorizationScope
): Promise<boolean> {
  const params: Array<string> = [documentId, scope.orgId, "structured", "active"];
  const clauses = [
    "d.id = ?",
    "d.org_id = ?",
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
    `SELECT d.id FROM documents d WHERE ${clauses.map((clause) => `${clause}`).join(" AND ")} LIMIT 1`,
    ...params
  )) as Array<{ id: string }>;
  return rows.length > 0;
}

async function findSupplierCatalogMatches(
  prisma: PrismaClient,
  importBatchId: string,
  supplierNames: string[],
  dynamicFields: string[],
  orgId: string
): Promise<Array<Record<string, unknown>>> {
  const selectedColumns = [`JSON_UNQUOTE(JSON_EXTRACT(scr.payload, ?)) AS supplier_name`];
  const params: Array<string> = ["$.supplier_name"];
  if (dynamicFields.includes(SUPPLIER_CONTACT_PHONE)) {
    selectedColumns.push(`JSON_UNQUOTE(JSON_EXTRACT(scr.payload, ?)) AS contact_phone`);
    params.push("$.contact_phone");
  }
  if (dynamicFields.includes(SUPPLIER_UNIT_ADDRESS)) {
    selectedColumns.push(`JSON_UNQUOTE(JSON_EXTRACT(scr.payload, ?)) AS unit_address`);
    params.push("$.unit_address");
  }

  params.push(orgId, importBatchId, "$.supplier_name", ...supplierNames);
  const rows = (await prisma.$queryRawUnsafe(
    `SELECT ${selectedColumns.join(", ")}
       FROM supplier_catalog_rows scr
      WHERE scr.org_id = ?
        AND scr.import_batch_id = ?
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
