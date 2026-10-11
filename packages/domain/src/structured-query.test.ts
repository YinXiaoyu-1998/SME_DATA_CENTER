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
  it.each(["business", "dishes"])("rejects %s before producing row-table SQL", (dataset) => {
    expect(() => compile({ dataset })).toThrowError(
      expect.objectContaining({ code: PHASE3_ERROR_CODES.datasetRequiresPartitionExtract })
    );
  });

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

  it("keeps catalog snapshot queries on the row path", () => {
    const result = compile({
      dataset: "dish_catalog",
      select: ["dish_name"],
      page: { limit: 10 }
    });
    expect(result.sql).toContain("dish_catalog_rows");
  });

  it("rejects raw SQL and unknown fields", () => {
    for (const query of [
      { dataset: "vip", sql: "select * from vip_rows" },
      { dataset: "vip", select: ["not_a_field"] }
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
