import { describe, expect, it } from "vitest";
import { PHASE3_ERROR_CODES } from "./retrieval-contracts.js";
import {
  compileStructuredQuery,
  createStructuredCursor,
  decodeStructuredCursor,
  StructuredQueryValidationError
} from "./structured-query.js";

function expectStructuredError(run: () => unknown, code: string) {
  try {
    run();
    throw new Error("Expected structured query error.");
  } catch (error) {
    expect(error).toBeInstanceOf(StructuredQueryValidationError);
    expect((error as StructuredQueryValidationError).code).toBe(code);
  }
}

describe("structured query compiler", () => {
  it("compiles a controlled detail query to parameterized SQL with permission scope before filters", () => {
    const compiled = compileStructuredQuery({
      employee: {
        role: "manager",
        labels: ["all_staff", "store:baoli"]
      },
      orgId: "default-org",
      query: {
        dataset: "dishes",
        registryVersion: "dishes.2026-07-11.v1",
        select: ["business_date", "matched_product_name", "dish_sales_quantity"],
        filter: {
          and: [
            { field: "business_date", op: "between", value: ["2026-07-01", "2026-07-05"] },
            { field: "matched_product_name", op: "contains", value: "肉夹馍" }
          ]
        },
        sort: [{ field: "business_date", direction: "asc" }],
        page: { limit: 50 }
      },
      cursorSecret: "cursor-secret"
    });

    expect(compiled.mode).toBe("detail");
    expect(compiled.limit).toBe(50);
    expect(compiled.offset).toBe(0);
    expect(compiled.shapeHash).toEqual(expect.any(String));
    expect(compiled.sql).toContain("FROM dish_rows r");
    expect(compiled.sql).toContain("JOIN import_batches ib");
    expect(compiled.sql).toContain("JOIN documents d");
    expect(compiled.sql.indexOf("d.status = ?")).toBeLessThan(
      compiled.sql.indexOf(
        "STR_TO_DATE(JSON_UNQUOTE(JSON_EXTRACT(r.payload, ?)), '%Y-%m-%d') BETWEEN ? AND ?"
      )
    );
    expect(compiled.sql).not.toContain("肉夹馍");
    expect(compiled.params).toEqual([
      "$.business_date",
      "$.matched_product_name",
      "$.dish_sales_quantity",
      "default-org",
      "default-org",
      "default-org",
      "dishes",
      "applied",
      "structured",
      "active",
      "all_staff",
      "store:baoli",
      "$.business_date",
      "2026-07-01",
      "2026-07-05",
      "$.matched_product_name",
      "%肉夹馍%",
      "$.business_date",
      50,
      0
    ]);
  });

  it("omits label predicates for an admin", () => {
    const compiled = compileStructuredQuery({
      employee: { role: "admin", labels: [] },
      orgId: "default-org",
      query: { dataset: "dishes", select: ["business_date"] },
      cursorSecret: "cursor-secret"
    });

    expect(compiled.sql).not.toContain("document_labels");
    expect(compiled.params).toEqual([
      "$.business_date",
      "default-org",
      "default-org",
      "default-org",
      "dishes",
      "applied",
      "structured",
      "active",
      50,
      0
    ]);
  });

  it("permits a non-admin without labels to query all_staff documents", () => {
    const compiled = compileStructuredQuery({
      employee: { role: "employee", labels: [] },
      orgId: "default-org",
      query: { dataset: "dishes", select: ["business_date"] },
      cursorSecret: "cursor-secret"
    });

    expect(compiled.sql).toContain("l.key = ?");
    expect(compiled.params).toContain("all_staff");
    expect(compiled.params).not.toContain("store:baoli");
  });

  it("treats an all_staff-only employee label as the all_staff document scope", () => {
    const compiled = compileStructuredQuery({
      employee: { role: "employee", labels: ["all_staff"] },
      orgId: "default-org",
      query: { dataset: "dishes", select: ["business_date"] },
      cursorSecret: "cursor-secret"
    });

    expect(compiled.sql).toContain("l.key = ?");
    expect(compiled.params).toContain("all_staff");
    expect(compiled.params).not.toContain("store:baoli");
  });

  it("limits a non-admin query to all_staff or matching employee labels", () => {
    const compiled = compileStructuredQuery({
      employee: { role: "employee", labels: ["store:baoli"] },
      orgId: "default-org",
      query: { dataset: "dishes", select: ["business_date"] },
      cursorSecret: "cursor-secret"
    });

    expect(compiled.sql).toContain("l.key = ? OR l.key IN (?)");
    expect(compiled.params).toContain("all_staff");
    expect(compiled.params).toContain("store:baoli");
    expect(compiled.params).not.toContain("store:suzhou");
  });

  it("keeps non-matching labels parameterized without widening the document scope", () => {
    const compiled = compileStructuredQuery({
      employee: { role: "employee", labels: ["store:suzhou"] },
      orgId: "default-org",
      query: { dataset: "dishes", select: ["business_date"] },
      cursorSecret: "cursor-secret"
    });

    expect(compiled.sql).toContain("l.key = ? OR l.key IN (?)");
    expect(compiled.params).toContain("all_staff");
    expect(compiled.params).toContain("store:suzhou");
    expect(compiled.params).not.toContain("store:baoli");
  });

  it("rejects invalid field, operator, type, capability, raw SQL, and excessive limits before SQL", () => {
    const base = {
      employee: { role: "manager" as const, labels: ["store:baoli"] },
      orgId: "default-org",
      cursorSecret: "cursor-secret"
    };

    const cases = [
      {
        query: { dataset: "dishes", select: ["not_a_field"] },
        code: PHASE3_ERROR_CODES.invalidField
      },
      {
        query: {
          dataset: "dishes",
          filter: { field: "matched_product_name", op: "regex", value: ".*" }
        },
        code: PHASE3_ERROR_CODES.unsupportedOperator
      },
      {
        query: {
          dataset: "dishes",
          filter: { field: "business_date", op: "eq", value: 123 }
        },
        code: PHASE3_ERROR_CODES.typeMismatch
      },
      {
        query: {
          dataset: "dishes",
          groupBy: ["dish_sales_quantity"],
          aggregates: [{ op: "sum", field: "dish_sales_quantity", as: "sum_quantity" }]
        },
        code: PHASE3_ERROR_CODES.unsupportedCapability
      },
      {
        query: { dataset: "dishes", rawSql: "select * from dish_rows" },
        code: PHASE3_ERROR_CODES.invalidQuery
      },
      {
        query: { dataset: "dishes", page: { limit: 201 } },
        code: PHASE3_ERROR_CODES.limitExceeded
      }
    ];

    for (const testCase of cases) {
      expectStructuredError(
        () => compileStructuredQuery({ ...base, query: testCase.query }),
        testCase.code
      );
    }
  });

  it("enforces the hard structural query limits before SQL execution", () => {
    const base = {
      employee: { role: "manager" as const, labels: ["store:baoli"] },
      orgId: "default-org",
      cursorSecret: "cursor-secret"
    };
    const condition = { field: "matched_product_name", op: "contains", value: "肉夹馍" };

    const cases = [
      {
        query: {
          dataset: "dishes",
          select: Array.from({ length: 51 }, (_, index) => `field_${index}`)
        },
        code: PHASE3_ERROR_CODES.limitExceeded
      },
      {
        query: {
          dataset: "dishes",
          filter: { and: Array.from({ length: 21 }, () => condition) }
        },
        code: PHASE3_ERROR_CODES.limitExceeded
      },
      {
        query: {
          dataset: "dishes",
          filter: {
            and: [
              {
                or: [
                  {
                    and: [condition]
                  }
                ]
              }
            ]
          }
        },
        code: PHASE3_ERROR_CODES.limitExceeded
      },
      {
        query: {
          dataset: "dishes",
          filter: {
            field: "matched_product_name",
            op: "in",
            value: Array.from({ length: 101 }, (_, index) => `dish-${index}`)
          }
        },
        code: PHASE3_ERROR_CODES.limitExceeded
      },
      {
        query: {
          dataset: "dishes",
          sort: [
            { field: "business_date", direction: "asc" },
            { field: "matched_product_name", direction: "asc" },
            { field: "store_name", direction: "asc" }
          ]
        },
        code: PHASE3_ERROR_CODES.limitExceeded
      },
      {
        query: {
          dataset: "dishes",
          groupBy: ["business_date", "matched_product_name"],
          aggregates: [{ op: "count", as: "row_count" }]
        },
        code: PHASE3_ERROR_CODES.limitExceeded
      },
      {
        query: {
          dataset: "dishes",
          aggregates: Array.from({ length: 6 }, (_, index) => ({
            op: "sum",
            field: "dish_sales_quantity",
            as: `sum_${index}`
          }))
        },
        code: PHASE3_ERROR_CODES.limitExceeded
      }
    ];

    for (const testCase of cases) {
      expectStructuredError(
        () => compileStructuredQuery({ ...base, query: testCase.query }),
        testCase.code
      );
    }
  });

  it("compiles explicit aggregations without leaking hidden rows outside the permission scope", () => {
    const compiled = compileStructuredQuery({
      employee: {
        role: "manager",
        labels: ["store:baoli"]
      },
      orgId: "default-org",
      query: {
        dataset: "business",
        registryVersion: "business.2026-07-11.v1",
        groupBy: ["business_date"],
        aggregates: [
          { op: "count", as: "row_count" },
          { op: "sum", field: "gross_sales_amount", as: "gross_sales" },
          { op: "avg", field: "discount_rate", as: "avg_discount_rate" }
        ],
        sort: [{ field: "business_date", direction: "asc" }],
        page: { limit: 100 }
      },
      cursorSecret: "cursor-secret"
    });

    expect(compiled.mode).toBe("aggregate");
    expect(compiled.limit).toBe(100);
    expect(compiled.sql).toContain("COUNT(*) AS `row_count`");
    expect(compiled.sql).toContain(
      "SUM(CAST(JSON_UNQUOTE(JSON_EXTRACT(r.payload, ?)) AS DECIMAL(20, 6))) AS `gross_sales`"
    );
    expect(compiled.sql.indexOf("EXISTS (")).toBeLessThan(compiled.sql.indexOf("GROUP BY"));
    expect(compiled.params).toContain("$.gross_sales_amount");
    expect(compiled.params).toContain("$.discount_rate");
  });

  it("uses typed SQL expressions for numeric and date-time sort, comparison, and min/max", () => {
    const compiled = compileStructuredQuery({
      employee: {
        role: "manager",
        labels: ["store:baoli"]
      },
      orgId: "default-org",
      query: {
        dataset: "dishes",
        select: ["matched_product_name", "dish_sales_quantity"],
        filter: {
          field: "dish_sales_quantity",
          op: "gte",
          value: 10
        },
        sort: [{ field: "dish_sales_quantity", direction: "desc" }],
        page: { limit: 50 }
      },
      cursorSecret: "cursor-secret"
    });

    expect(compiled.sql).toContain(
      "CAST(JSON_UNQUOTE(JSON_EXTRACT(r.payload, ?)) AS DECIMAL(20, 6)) >= ?"
    );
    expect(compiled.sql).toContain(
      "ORDER BY CAST(JSON_UNQUOTE(JSON_EXTRACT(r.payload, ?)) AS DECIMAL(20, 6)) DESC"
    );

    const dateTime = compileStructuredQuery({
      employee: {
        role: "manager",
        labels: ["store:baoli"]
      },
      orgId: "default-org",
      query: {
        dataset: "dishes",
        select: ["order_time"],
        filter: {
          field: "order_time",
          op: "gte",
          value: "2026-07-01T12:30:45"
        },
        sort: [{ field: "order_time", direction: "asc" }]
      },
      cursorSecret: "cursor-secret"
    });

    expect(dateTime.sql).toContain(
      "STR_TO_DATE(JSON_UNQUOTE(JSON_EXTRACT(r.payload, ?)), '%Y-%m-%dT%H:%i:%s') >= ?"
    );
    expect(dateTime.sql).toContain(
      "ORDER BY STR_TO_DATE(JSON_UNQUOTE(JSON_EXTRACT(r.payload, ?)), '%Y-%m-%dT%H:%i:%s') ASC"
    );

    const aggregate = compileStructuredQuery({
      employee: {
        role: "manager",
        labels: ["store:baoli"]
      },
      orgId: "default-org",
      query: {
        dataset: "dishes",
        aggregates: [
          { op: "min", field: "dish_sales_quantity", as: "min_quantity" },
          { op: "max", field: "dish_sales_quantity", as: "max_quantity" }
        ]
      },
      cursorSecret: "cursor-secret"
    });

    expect(aggregate.sql).toContain(
      "MIN(CAST(JSON_UNQUOTE(JSON_EXTRACT(r.payload, ?)) AS DECIMAL(20, 6))) AS `min_quantity`"
    );
    expect(aggregate.sql).toContain(
      "MAX(CAST(JSON_UNQUOTE(JSON_EXTRACT(r.payload, ?)) AS DECIMAL(20, 6))) AS `max_quantity`"
    );
  });

  it("rejects cursor tampering and query-shape changes", () => {
    const query = {
      dataset: "dishes",
      select: ["business_date"],
      page: { limit: 1 }
    };
    const compiled = compileStructuredQuery({
      employee: { role: "manager", labels: ["store:baoli"] },
      orgId: "default-org",
      query,
      cursorSecret: "cursor-secret"
    });
    const cursor = createStructuredCursor({
      offset: 1,
      shapeHash: compiled.shapeHash,
      secret: "cursor-secret",
      now: new Date("2026-07-12T00:00:00.000Z")
    });

    expect(
      decodeStructuredCursor({
        cursor,
        expectedShapeHash: compiled.shapeHash,
        secret: "cursor-secret",
        now: new Date("2026-07-12T00:01:00.000Z")
      })
    ).toEqual({ offset: 1 });
    expectStructuredError(
      () =>
        decodeStructuredCursor({
          cursor: `${cursor.slice(0, -2)}xx`,
          expectedShapeHash: compiled.shapeHash,
          secret: "cursor-secret",
          now: new Date("2026-07-12T00:01:00.000Z")
        }),
      PHASE3_ERROR_CODES.invalidCursor
    );
    expectStructuredError(
      () =>
        decodeStructuredCursor({
          cursor,
          expectedShapeHash: "different-shape",
          secret: "cursor-secret",
          now: new Date("2026-07-12T00:01:00.000Z")
        }),
      PHASE3_ERROR_CODES.invalidCursor
    );
    expectStructuredError(
      () =>
        decodeStructuredCursor({
          cursor: createStructuredCursor({
            offset: 1,
            shapeHash: compiled.shapeHash,
            secret: "cursor-secret",
            now: new Date("2026-07-12T00:00:00.000Z")
          }),
          expectedShapeHash: compiled.shapeHash,
          secret: "cursor-secret",
          now: new Date("2026-07-12T00:16:00.000Z")
        }),
      PHASE3_ERROR_CODES.cursorExpired
    );
  });

  it("scopes cursor shape to org, employee, role, labels, and query", () => {
    const query = {
      dataset: "dishes",
      select: ["business_date"],
      page: { limit: 1 }
    };
    const base = compileStructuredQuery({
      employee: { id: "emp_1", role: "manager", labels: ["store:baoli"] },
      orgId: "default-org",
      query,
      cursorSecret: "cursor-secret"
    });

    const variants = [
      compileStructuredQuery({
        employee: { id: "emp_2", role: "manager", labels: ["store:baoli"] },
        orgId: "default-org",
        query,
        cursorSecret: "cursor-secret"
      }),
      compileStructuredQuery({
        employee: { id: "emp_1", role: "admin", labels: ["store:baoli"] },
        orgId: "default-org",
        query,
        cursorSecret: "cursor-secret"
      }),
      compileStructuredQuery({
        employee: { id: "emp_1", role: "manager", labels: ["store:suzhou"] },
        orgId: "default-org",
        query,
        cursorSecret: "cursor-secret"
      }),
      compileStructuredQuery({
        employee: { id: "emp_1", role: "manager", labels: ["store:baoli"] },
        orgId: "org-b",
        query,
        cursorSecret: "cursor-secret"
      })
    ];

    for (const variant of variants) {
      expect(variant.shapeHash).not.toBe(base.shapeHash);
    }
  });
});
