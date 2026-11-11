import { describe, expect, it } from "vitest";
import { PHASE3_ERROR_CODES } from "./retrieval-contracts.js";
import { compileStructuredQuery, StructuredQueryValidationError } from "./structured-query.js";

function compile(query: unknown) {
  return compileStructuredQuery({
    orgId: "org_1",
    employee: { id: "emp_1", clearance: 2 },
    query,
    cursorSecret: "test-secret"
  });
}

describe("structured query compiler", () => {
  it.each(["business", "dishes", "in_store_orders", "takeaway_orders"])(
    "rejects %s before producing row-table SQL",
    (dataset) => {
      expect(() => compile({ dataset })).toThrowError(
        expect.objectContaining({ code: PHASE3_ERROR_CODES.datasetRequiresPartitionExtract })
      );
    }
  );

  it("keeps a bounded, parameterized row query for vip", () => {
    const result = compile({
      dataset: "vip",
      select: ["member_id", "member_phone"],
      filter: { field: "member_id", op: "contains", value: "123" },
      page: { limit: 20 }
    });
    expect(result.sql).toContain("vip_rows");
    expect(result.sql).not.toContain("dish_rows");
    expect(result.sql).not.toContain("business_rows");
    expect(result.params).toContain("org_1");
    expect(result.params).toContain(2);
    expect(result.limit).toBe(20);
  });

  it("compiles current catalog reads with the fixed department lookup", () => {
    const result = compile({
      dataset: "dish_catalog",
      page: { limit: 10 }
    });

    expect(result.sql).toContain(
      "FROM dish_catalog_entries r LEFT JOIN business_departments department ON department.department_id = r.department_id"
    );
    expect(result.sql).not.toContain("import_batches");
    expect(result.sql).not.toContain("JOIN documents");
    expect(result.sql).toContain("department.name AS `department_name`");
    expect(result.sql).toContain("r.updated_at AS `updated_at`");
    expect(result.sql).not.toContain("r.created_at AS `created_at`");
    expect(result.sql).not.toContain("r.department_id AS `department_id`");
    expect(result.sql).toContain("ORDER BY JSON_UNQUOTE(JSON_EXTRACT(r.payload, ?)) ASC, r.id ASC");
    expect(result.selectedFields).toContain("department_name");
    expect(result.selectedFields).toContain("updated_at");
    expect(result.selectedFields).not.toContain("department_id");
    expect(result.selectedFields).not.toContain("created_at");
    expect(result.params).toContain("$.sku_id");
    expect(result.params).toContain("org_1");
    expect(result.params).toContain(10);
    expect(result.params).toContain(0);
  });

  it("fails closed for current catalog reads without business authorization", () => {
    const result = compile({
      dataset: "dish_catalog",
      select: ["sku_id", "department_name"],
      page: { limit: 5 }
    });

    expect(result.sql).toContain("WHERE r.org_id = ? AND 0 = 1");
    expect(result.sql).not.toContain("confidentiality_level");
    expect(result.params).toEqual(["$.sku_id", "org_1", "$.sku_id", 5, 0]);
  });

  it("applies the same business authorization predicate to current catalog reads", () => {
    const result = compileStructuredQuery({
      orgId: "org_1",
      employee: { id: "emp_1", clearance: 2 },
      query: { dataset: "dish_catalog", select: ["sku_id"], page: { limit: 5 } },
      cursorSecret: "test-secret",
      businessAuthorization: {
        version: "v1",
        sql: "EXISTS (SELECT 1 WHERE ? = ?)",
        params: ["ent_a", "ent_a"]
      }
    });

    expect(result.sql).toContain("WHERE r.org_id = ? AND (EXISTS (SELECT 1 WHERE ? = ?))");
    expect(result.sql).not.toContain("AND 0 = 1");
    expect(result.params).toEqual(["$.sku_id", "org_1", "ent_a", "ent_a", "$.sku_id", 5, 0]);
  });

  it("filters, sorts, groups and aggregates catalog department and timestamp fields", () => {
    const result = compile({
      dataset: "dish_catalog",
      groupBy: ["department_id", "department_name", "updated_at"],
      aggregates: [
        { op: "count" },
        { op: "countDistinct", field: "department_id" },
        { op: "max", field: "updated_at" }
      ],
      sort: [{ field: "department_name", direction: "desc" }],
      filter: {
        and: [
          { field: "department_id", op: "eq", value: "dep_1" },
          { field: "department_name", op: "contains", value: "烧烤" },
          { field: "updated_at", op: "gte", value: "2026-11-01T00:00:00+08:00" }
        ]
      },
      page: { limit: 20 }
    });

    expect(result.sql).toContain("r.department_id AS `department_id`");
    expect(result.sql).toContain("department.name AS `department_name`");
    expect(result.sql).toContain("r.updated_at AS `updated_at`");
    expect(result.sql).toContain("r.department_id = ?");
    expect(result.sql).toContain("department.name LIKE ?");
    expect(result.sql).toContain("r.updated_at >= ?");
    expect(result.sql).toContain("COUNT(*) AS `count`");
    expect(result.sql).toContain(
      "COUNT(DISTINCT r.department_id) AS `countDistinct_department_id`"
    );
    expect(result.sql).toContain("MAX(r.updated_at) AS `max_updated_at`");
    expect(result.sql).toContain("ORDER BY `department_name` DESC");
    expect(result.params).toContain("dep_1");
    expect(result.params).toContain("%烧烤%");
  });

  it("sorts current catalog reads by physical department and timestamp columns", () => {
    const result = compile({
      dataset: "dish_catalog",
      select: ["sku_id", "department_name", "updated_at"],
      sort: [
        { field: "updated_at", direction: "desc" },
        { field: "department_name", direction: "asc" }
      ],
      page: { limit: 5 }
    });

    expect(result.sql).toContain("ORDER BY r.updated_at DESC, department.name ASC, r.id ASC");
    expect(result.params).toEqual(["$.sku_id", "org_1", 5, 0]);
  });

  it("uses r.id as the stable catalog tiebreaker after explicit sorting", () => {
    const result = compile({
      dataset: "dish_catalog",
      select: ["sku_id", "dish_name"],
      sort: [{ field: "dish_name", direction: "desc" }],
      page: { limit: 5 }
    });

    expect(result.sql).toContain(
      "ORDER BY JSON_UNQUOTE(JSON_EXTRACT(r.payload, ?)) DESC, r.id ASC"
    );

    expect(result.params).toEqual(["$.sku_id", "$.dish_name", "org_1", "$.dish_name", 5, 0]);
  });

  it("rejects raw SQL and unknown fields", () => {
    for (const query of [
      { dataset: "vip", sql: "select * from vip_rows" },
      { dataset: "vip", select: ["not_a_field"] },
      { dataset: "dish_catalog", select: ["department.name"] },
      {
        dataset: "dish_catalog",
        filter: { field: "business_departments.name", op: "eq", value: "烧烤" }
      }
    ]) {
      try {
        compile(query);
        throw new Error("Expected validation to fail.");
      } catch (error) {
        expect(error).toBeInstanceOf(StructuredQueryValidationError);
      }
    }
  });

  it("applies clearance even for an employee with an admin-shaped identifier", () => {
    const result = compileStructuredQuery({
      orgId: "org_1",
      employee: { id: "admin_1", clearance: 1 },
      query: { dataset: "supplier_catalog", page: { limit: 5 } },
      cursorSecret: "test-secret"
    });
    expect(result.params).toContain(1);
    expect(result.sql).toContain("confidentiality_level <= ?");
  });
});

it("binds current authorization versions into cursors and replaces upload clearance", async () => {
  const { createStructuredCursor } = await import("./structured-query.js");
  const query = { dataset: "vip", select: ["member_id"], page: { limit: 1 } };
  const base = {
    orgId: "org",
    employee: { id: "emp", clearance: 3 },
    cursorSecret: "secret",
    query,
    businessAuthorization: {
      version: "v1",
      sql: "EXISTS (SELECT 1 WHERE ? = ?)",
      params: ["A", "A"]
    }
  };
  const compiled = compileStructuredQuery(base);
  expect(compiled.sql).toContain(base.businessAuthorization.sql);
  expect(compiled.sql).not.toContain("d.confidentiality_level <= ?");
  expect(compiled.params).toContain("A");
  const cursor = createStructuredCursor({
    offset: 1,
    shapeHash: compiled.shapeHash,
    secret: "secret"
  });
  expect(() =>
    compileStructuredQuery({
      ...base,
      query: { ...query, page: { limit: 1, cursor } },
      businessAuthorization: { ...base.businessAuthorization, version: "v2" }
    })
  ).toThrowError(expect.objectContaining({ code: "INVALID_CURSOR" }));
});
