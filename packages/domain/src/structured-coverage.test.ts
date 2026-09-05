import { describe, expect, it } from "vitest";
import {
  compileStructuredCoverageQuery,
  type StructuredCompiledCoverageQuery
} from "./structured-coverage.js";

function compact(sql: string | null): string {
  return sql?.replace(/\s+/g, " ").trim() ?? "";
}

describe("structured coverage compiler", () => {
  it("compiles authorization-safe window coverage over active applied imports", () => {
    const compiled = compileStructuredCoverageQuery({
      orgId: "org_1",
      employee: {
        id: "emp_1",
        role: "manager",
        labels: ["all_staff", "store:baoli", "store:baoli"]
      },
      dataset: "dishes"
    });

    expect(compiled).toMatchObject({
      dataset: "dishes",
      registryVersion: "dishes.2026-09-04.v2",
      metadataPolicy: "window",
      authorizationScope: {
        orgId: "org_1",
        employee: {
          id: "emp_1",
          role: "manager",
          labels: ["all_staff", "store:baoli", "store:baoli"]
        }
      }
    } satisfies Partial<StructuredCompiledCoverageQuery>);
    expect(compact(compiled.sql)).toContain(
      "SELECT ib.id AS import_batch_id, ib.source_document_id, d.title AS source_document_title, ib.applied_at, ib.applied_row_count AS row_count, ib.start_date, ib.end_date FROM import_batches ib JOIN documents d ON d.id = ib.source_document_id"
    );
    expect(compact(compiled.sql)).toContain(
      "WHERE ib.org_id = ? AND d.org_id = ? AND ib.dataset = ? AND ib.registry_version = ? AND ib.status = ? AND ib.applied_at IS NOT NULL AND ib.archived_at IS NULL AND d.document_kind = ? AND d.status = ? AND d.archived_at IS NULL"
    );
    expect(compact(compiled.sql)).toContain(
      "EXISTS (SELECT 1 FROM document_labels dl JOIN labels l ON l.id = dl.label_id WHERE dl.document_id = d.id AND (l.key = ? OR l.key IN (?)))"
    );
    expect(compact(compiled.sql)).toContain(
      "ORDER BY ib.start_date ASC, ib.end_date ASC, ib.applied_at ASC, ib.id ASC"
    );
    expect(compiled.params).toEqual([
      "org_1",
      "org_1",
      "dishes",
      "dishes.2026-09-04.v2",
      "applied",
      "structured",
      "active",
      "all_staff",
      "store:baoli"
    ]);
  });

  it("omits label predicates for admins", () => {
    const compiled = compileStructuredCoverageQuery({
      orgId: "org_1",
      employee: { id: "emp_admin", role: "admin", labels: [] },
      dataset: "business"
    });

    expect(compact(compiled.sql)).not.toContain("document_labels");
    expect(compiled.params).toEqual([
      "org_1",
      "org_1",
      "business",
      "business.2026-09-04.v2",
      "applied",
      "structured",
      "active"
    ]);
  });

  it("compiles snapshot coverage and projects the registry metadata policy", () => {
    const compiled = compileStructuredCoverageQuery({
      orgId: "org_1",
      employee: { role: "employee", labels: [] },
      dataset: "dish_catalog"
    });

    expect(compiled.metadataPolicy).toBe("snapshot");
    expect(compiled.registryVersion).toBe("dish_catalog.2026-08-22.v1");
    expect(compact(compiled.sql)).toContain(
      "ib.start_date, ib.end_date FROM import_batches ib JOIN documents d"
    );
    expect(compiled.params).toEqual([
      "org_1",
      "org_1",
      "dish_catalog",
      "dish_catalog.2026-08-22.v1",
      "applied",
      "structured",
      "active",
      "all_staff"
    ]);
  });

  it.each([
    ["delivery_ledger", "derived_receipt"],
    ["supplier_catalog", "none"]
  ] as const)("returns no source query for %s coverage", (dataset, metadataPolicy) => {
    const compiled = compileStructuredCoverageQuery({
      orgId: "org_1",
      employee: { role: "employee", labels: ["store:baoli"] },
      dataset
    });

    expect(compiled).toMatchObject({
      dataset,
      metadataPolicy,
      sql: null,
      params: []
    });
  });
});
