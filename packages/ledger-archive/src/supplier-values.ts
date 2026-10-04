import { Prisma } from "@prisma/client";

const SUPPLIER_CONTACT_PHONE = "supplier_contact_phone";
const SUPPLIER_UNIT_ADDRESS = "supplier_unit_address";
export interface CurrentSupplierCatalog {
  id: string;
  source_document_id: string;
}

export async function findReadableCurrentSupplierCatalog(
  prisma: Pick<Prisma.TransactionClient, "$queryRawUnsafe">,
  scope: { orgId: string; employee?: { clearance: number } }
): Promise<CurrentSupplierCatalog | null> {
  const params: Array<string | number> = [
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

  if (scope.employee) {
    clauses.push("d.confidentiality_level <= ?");
    params.push(scope.employee.clearance);
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

export async function findSupplierCatalogMatches(
  prisma: Pick<Prisma.TransactionClient, "$queryRawUnsafe">,
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
        AND CAST(JSON_UNQUOTE(JSON_EXTRACT(scr.payload, ?)) AS BINARY) IN (${supplierNames.map(() => "?").join(", ")})`,
    ...params
  )) as Array<Record<string, unknown>>;
  return rows;
}

export function dynamicValuesFor(
  row: Record<string, unknown>,
  compiled: { dynamicSelectedFields: string[] }
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

export function nullableValue(value: unknown): unknown {
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value === "string" && (value.trim().length === 0 || value === "null")) {
    return null;
  }
  return value;
}
