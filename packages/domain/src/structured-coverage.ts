import {
  getStructuredRegistry,
  type StructuredDatasetName,
  type StructuredDatasetRegistry
} from "./structured-registry.js";
import type {
  StructuredQueryAuthorizationScope,
  StructuredQueryEmployeeScope
} from "./structured-query.js";

export type StructuredCoverageSourceBase = {
  importBatchId: string;
  sourceDocumentId: string;
  sourceDocumentTitle: string;
  appliedAt: string;
  rowCount: number;
};

export type StructuredDatasetCoverage =
  | {
      dataset: StructuredDatasetName;
      metadataPolicy: "window";
      sources: Array<StructuredCoverageSourceBase & { startDate: string; endDate: string }>;
    }
  | {
      dataset: StructuredDatasetName;
      metadataPolicy: "snapshot";
      sources: Array<StructuredCoverageSourceBase & { snapshotDate: string }>;
    }
  | {
      dataset: StructuredDatasetName;
      metadataPolicy: "derived_receipt" | "none";
      sources: [];
    };

export interface StructuredCompiledCoverageQuery {
  dataset: StructuredDatasetName;
  metadataPolicy: StructuredDatasetRegistry["metadataPolicy"];
  sql: string | null;
  params: Array<string | number>;
  authorizationScope: StructuredQueryAuthorizationScope;
}

export function compileStructuredCoverageQuery(input: {
  orgId: string;
  employee: StructuredQueryEmployeeScope;
  dataset: StructuredDatasetName;
  businessAuthorization?: { sql: string; params: Array<string | number> };
}): StructuredCompiledCoverageQuery {
  const registry = getStructuredRegistry(input.dataset);
  const authorizationScope = {
    orgId: input.orgId,
    employee: { ...input.employee }
  };

  if (registry.metadataPolicy === "derived_receipt" || registry.metadataPolicy === "none") {
    return {
      dataset: registry.dataset,
      metadataPolicy: registry.metadataPolicy,
      sql: null,
      params: [],
      authorizationScope
    };
  }

  const params: Array<string | number> = [
    input.orgId,
    input.orgId,
    registry.dataset,
    "applied",
    "structured",
    "active"
  ];
  const clauses = [
    "WHERE ib.org_id = ?",
    "AND d.org_id = ?",
    "AND ib.dataset = ?",
    "AND ib.status = ?",
    "AND ib.applied_at IS NOT NULL",
    "AND ib.archived_at IS NULL",
    "AND d.document_kind = ?",
    "AND d.status = ?",
    "AND d.archived_at IS NULL"
  ];

  if (input.businessAuthorization) {
    clauses.push(`AND (${input.businessAuthorization.sql})`);
    params.push(...input.businessAuthorization.params);
  } else {
    clauses.push("AND d.confidentiality_level <= ?");
    params.push(input.employee.clearance);
  }

  return {
    dataset: registry.dataset,
    metadataPolicy: registry.metadataPolicy,
    sql: `SELECT ib.id AS import_batch_id,
                 ib.source_document_id,
                 d.title AS source_document_title,
                 ib.applied_at,
                 ib.applied_row_count AS row_count,
                 ib.start_date,
                 ib.end_date
            FROM import_batches ib
            JOIN documents d ON d.id = ib.source_document_id
           ${clauses.join(" ")}
        ORDER BY ib.start_date ASC, ib.end_date ASC, ib.applied_at ASC, ib.id ASC`,
    params,
    authorizationScope
  };
}
