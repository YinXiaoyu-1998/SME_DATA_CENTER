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
      registryVersion: string;
      metadataPolicy: "window";
      sources: Array<StructuredCoverageSourceBase & { startDate: string; endDate: string }>;
    }
  | {
      dataset: StructuredDatasetName;
      registryVersion: string;
      metadataPolicy: "snapshot";
      sources: Array<StructuredCoverageSourceBase & { snapshotDate: string }>;
    }
  | {
      dataset: StructuredDatasetName;
      registryVersion: string;
      metadataPolicy: "derived_receipt" | "none";
      sources: [];
    };

export interface StructuredCompiledCoverageQuery {
  dataset: StructuredDatasetName;
  registryVersion: string;
  metadataPolicy: StructuredDatasetRegistry["metadataPolicy"];
  sql: string | null;
  params: Array<string | number>;
  authorizationScope: StructuredQueryAuthorizationScope;
}

export function compileStructuredCoverageQuery(input: {
  orgId: string;
  employee: StructuredQueryEmployeeScope;
  dataset: StructuredDatasetName;
}): StructuredCompiledCoverageQuery {
  const registry = getStructuredRegistry(input.dataset);
  const authorizationScope = {
    orgId: input.orgId,
    employee: { ...input.employee, labels: [...input.employee.labels] }
  };

  if (registry.metadataPolicy === "derived_receipt" || registry.metadataPolicy === "none") {
    return {
      dataset: registry.dataset,
      registryVersion: registry.version,
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
    registry.version,
    "applied",
    "structured",
    "active"
  ];
  const clauses = [
    "WHERE ib.org_id = ?",
    "AND d.org_id = ?",
    "AND ib.dataset = ?",
    "AND ib.registry_version = ?",
    "AND ib.status = ?",
    "AND ib.applied_at IS NOT NULL",
    "AND ib.archived_at IS NULL",
    "AND d.document_kind = ?",
    "AND d.status = ?",
    "AND d.archived_at IS NULL"
  ];

  if (input.employee.role !== "admin") {
    const visibleLabels = [
      ...new Set(input.employee.labels.filter((label) => label !== "all_staff"))
    ].sort();
    const labelPredicate =
      visibleLabels.length === 0
        ? "l.key = ?"
        : `l.key = ? OR l.key IN (${visibleLabels.map(() => "?").join(", ")})`;

    clauses.push(
      `AND EXISTS (SELECT 1 FROM document_labels dl JOIN labels l ON l.id = dl.label_id WHERE dl.document_id = d.id AND (${labelPredicate}))`
    );
    params.push("all_staff", ...visibleLabels);
  }

  return {
    dataset: registry.dataset,
    registryVersion: registry.version,
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
