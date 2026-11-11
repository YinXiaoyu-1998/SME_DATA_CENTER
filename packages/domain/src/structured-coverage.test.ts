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
        clearance: 3
      },
      dataset: "dishes"
    });

    expect(compiled).toMatchObject({
      dataset: "dishes",
      metadataPolicy: "window",
      authorizationScope: {
        orgId: "org_1",
        employee: {
          id: "emp_1",
          clearance: 3
        }
      }
    } satisfies Partial<StructuredCompiledCoverageQuery>);
    expect(compact(compiled.sql)).toContain(
      "SELECT ib.id AS import_batch_id, ib.source_document_id, d.title AS source_document_title, ib.applied_at, ib.applied_row_count AS row_count, ib.start_date, ib.end_date FROM import_batches ib JOIN documents d ON d.id = ib.source_document_id"
    );
    expect(compact(compiled.sql)).toContain(
      "WHERE ib.org_id = ? AND d.org_id = ? AND ib.dataset = ? AND ib.status = ? AND ib.applied_at IS NOT NULL AND ib.archived_at IS NULL AND d.document_kind = ? AND d.status = ? AND d.archived_at IS NULL"
    );
    expect(compact(compiled.sql)).toContain("d.confidentiality_level <= ?");
    expect(compact(compiled.sql)).toContain(
      "ORDER BY ib.start_date ASC, ib.end_date ASC, ib.applied_at ASC, ib.id ASC"
    );
    expect(compiled.params).toEqual([
      "org_1",
      "org_1",
      "dishes",
      "applied",
      "structured",
      "active",
      3
    ]);
  });

  it("applies the same clearance predicate to admins", () => {
    const compiled = compileStructuredCoverageQuery({
      orgId: "org_1",
      employee: { id: "emp_admin", clearance: 3 },
      dataset: "business"
    });

    expect(compact(compiled.sql)).not.toContain("document_labels");
    expect(compiled.params).toEqual([
      "org_1",
      "org_1",
      "business",
      "applied",
      "structured",
      "active",
      3
    ]);
  });

  it("compiles current catalog coverage as a row count and last update", () => {
    const compiled = compileStructuredCoverageQuery({
      orgId: "org_1",
      employee: { id: "emp_1", clearance: 3 },
      dataset: "dish_catalog",
      businessAuthorization: {
        sql: "EXISTS (SELECT 1 WHERE ? = ?)",
        params: ["ent_a", "ent_a"]
      }
    });

    expect(compiled.metadataPolicy).toBe("current");
    expect(compact(compiled.sql)).toBe(
      "SELECT COUNT(*) AS row_count, MAX(r.updated_at) AS last_updated_at FROM dish_catalog_entries r WHERE r.org_id = ? AND (EXISTS (SELECT 1 WHERE ? = ?))"
    );
    expect(compact(compiled.sql)).not.toContain("import_batches");
    expect(compiled.params).toEqual(["org_1", "ent_a", "ent_a"]);
  });

  it("fails closed for current catalog coverage without business authorization", () => {
    const compiled = compileStructuredCoverageQuery({
      orgId: "org_1",
      employee: { clearance: 3 },
      dataset: "dish_catalog"
    });

    expect(compiled.metadataPolicy).toBe("current");
    expect(compact(compiled.sql)).toBe(
      "SELECT COUNT(*) AS row_count, MAX(r.updated_at) AS last_updated_at FROM dish_catalog_entries r WHERE r.org_id = ? AND 0 = 1"
    );
    expect(compact(compiled.sql)).not.toContain("confidentiality_level");
    expect(compiled.params).toEqual(["org_1"]);
  });

  it.each([
    ["delivery_ledger", "derived_receipt"],
    ["supplier_catalog", "none"]
  ] as const)("returns no source query for %s coverage", (dataset, metadataPolicy) => {
    const compiled = compileStructuredCoverageQuery({
      orgId: "org_1",
      employee: { clearance: 3 },
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
