import { describe, expect, it } from "vitest";
import { PHASE3_ERROR_CODES } from "./retrieval-contracts.js";
import {
  compileStructuredQuery,
  createStructuredCursor,
  decodeStructuredCursor,
  STRUCTURED_QUERY_LIMITS,
  StructuredQueryValidationError
} from "./structured-query.js";
import { PUBLIC_INPUT_LIMITS } from "./input-boundaries.js";

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
  it("partitions delivery dynamic fields from the stored SQL projection", () => {
    const compiled = compileStructuredQuery({
      employee: { id: "emp_admin", role: "admin", labels: [] },
      orgId: "default-org",
      query: {
        dataset: "delivery_ledger",
        select: [
          "receipt_id",
          "source_document_id",
          "supplier_name",
          "supplier_contact_phone",
          "supplier_unit_address"
        ]
      },
      cursorSecret: "cursor-secret"
    });

    expect(compiled.selectedFields).toEqual([
      "receipt_id",
      "source_document_id",
      "supplier_name",
      "supplier_contact_phone",
      "supplier_unit_address"
    ]);
    expect(compiled.dynamicSelectedFields).toEqual([
      "supplier_contact_phone",
      "supplier_unit_address"
    ]);
    expect(compiled.sql).toContain("`receipt_id`");
    expect(compiled.sql).toContain("r.source_document_id AS `source_document_id`");
    expect(compiled.sql).toContain("`supplier_name`");
    expect(compiled.sql).not.toContain("`supplier_contact_phone`");
    expect(compiled.sql).not.toContain("`supplier_unit_address`");
    expect(compiled.params).not.toContain("$.supplier_contact_phone");
    expect(compiled.params).not.toContain("$.supplier_unit_address");
    expect(compiled.authorizationScope).toEqual({
      orgId: "default-org",
      employee: { id: "emp_admin", role: "admin", labels: [] }
    });
  });

  it.each([
    ["filter", { filter: { field: "supplier_contact_phone", op: "eq", value: "138" } }],
    ["sort", { sort: [{ field: "supplier_unit_address", direction: "asc" }] }],
    [
      "group",
      { groupBy: ["supplier_contact_phone"], aggregates: [{ op: "count", as: "row_count" }] }
    ],
    [
      "aggregate",
      { aggregates: [{ op: "count", field: "supplier_unit_address", as: "address_count" }] }
    ]
  ])("rejects dynamic delivery fields in %s capabilities", (_capability, query) => {
    expectStructuredError(
      () =>
        compileStructuredQuery({
          employee: { role: "admin", labels: [] },
          orgId: "default-org",
          query: { dataset: "delivery_ledger", ...query },
          cursorSecret: "cursor-secret"
        }),
      PHASE3_ERROR_CODES.unsupportedCapability
    );
  });

  it.each([
    ["filter", { filter: { field: "source_document_id", op: "eq", value: "doc_1" } }],
    ["sort", { sort: [{ field: "source_document_id", direction: "asc" }] }],
    ["group", { groupBy: ["source_document_id"], aggregates: [{ op: "count", as: "row_count" }] }],
    ["aggregate", { aggregates: [{ op: "count", field: "source_document_id", as: "source_docs" }] }]
  ])("rejects source_document_id in %s capabilities", (_capability, query) => {
    expectStructuredError(
      () =>
        compileStructuredQuery({
          employee: { role: "admin", labels: [] },
          orgId: "default-org",
          query: { dataset: "delivery_ledger", ...query },
          cursorSecret: "cursor-secret"
        }),
      PHASE3_ERROR_CODES.unsupportedCapability
    );
  });

  it("rejects dynamic fields nested inside combined filters", () => {
    expectStructuredError(
      () =>
        compileStructuredQuery({
          employee: { role: "admin", labels: [] },
          orgId: "default-org",
          query: {
            dataset: "delivery_ledger",
            filter: {
              and: [
                { field: "supplier_name", op: "eq", value: "Supplier A" },
                {
                  or: [{ field: "supplier_contact_phone", op: "eq", value: "13800138000" }]
                }
              ]
            }
          },
          cursorSecret: "cursor-secret"
        }),
      PHASE3_ERROR_CODES.unsupportedCapability
    );
  });

  it("rejects mixed dynamic and stored sort capabilities", () => {
    expectStructuredError(
      () =>
        compileStructuredQuery({
          employee: { role: "admin", labels: [] },
          orgId: "default-org",
          query: {
            dataset: "delivery_ledger",
            sort: [
              { field: "supplier_name", direction: "asc" },
              { field: "supplier_unit_address", direction: "asc" }
            ]
          },
          cursorSecret: "cursor-secret"
        }),
      PHASE3_ERROR_CODES.unsupportedCapability
    );
  });

  it("rejects dynamic aggregate aliases and mixed grouping capabilities", () => {
    expectStructuredError(
      () =>
        compileStructuredQuery({
          employee: { role: "admin", labels: [] },
          orgId: "default-org",
          query: {
            dataset: "delivery_ledger",
            groupBy: ["supplier_name"],
            aggregates: [{ op: "count", field: "supplier_contact_phone", as: "phone_count" }]
          },
          cursorSecret: "cursor-secret"
        }),
      PHASE3_ERROR_CODES.unsupportedCapability
    );
  });

  it("compiles catalog snapshot price filters against the catalog row table", () => {
    const compiled = compileStructuredQuery({
      employee: { role: "admin", labels: [] },
      orgId: "default-org",
      query: {
        dataset: "dish_catalog",
        registryVersion: "dish_catalog.2026-08-22.v1",
        select: ["snapshot_date", "sku_id", "sale_price"],
        filter: { field: "sale_price", op: "eq", value: 0 },
        sort: [{ field: "snapshot_date", direction: "desc" }]
      },
      cursorSecret: "cursor-secret"
    });

    expect(compiled.sql).toContain("FROM dish_catalog_rows r");
    expect(compiled.sql).toContain(
      "CAST(JSON_UNQUOTE(JSON_EXTRACT(r.payload, ?)) AS DECIMAL(20, 6)) = ?"
    );
    expect(compiled.params).toContain("$.snapshot_date");
    expect(compiled.params).toContain("$.sku_id");
    expect(compiled.params).toContain("$.sale_price");
    expect(compiled.params).toContain(0);
  });

  it("compiles a controlled detail query to parameterized SQL with permission scope before filters", () => {
    const compiled = compileStructuredQuery({
      employee: {
        role: "manager",
        labels: ["all_staff", "store:baoli"]
      },
      orgId: "default-org",
      query: {
        dataset: "dishes",
        registryVersion: "dishes.2026-09-04.v2",
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
        query: {
          dataset: "dishes",
          sort: [{ field: "business_date", direction: "asc", expression: "COUNT(*)" }]
        },
        code: PHASE3_ERROR_CODES.invalidQuery
      },
      {
        query: { dataset: "dishes", page: { limit: 50, offset: 1 } },
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
          dataset: "business",
          groupBy: ["store_name", "order_source", "meal_period", "business_date", "city"],
          aggregates: [{ op: "count", as: "row_count" }]
        },
        code: PHASE3_ERROR_CODES.limitExceeded
      },
      {
        query: {
          dataset: "dishes",
          aggregates: Array.from(
            { length: STRUCTURED_QUERY_LIMITS.maxAggregates + 1 },
            (_, index) => ({
              op: "sum",
              field: "dish_sales_quantity",
              as: `sum_${index}`
            })
          )
        },
        code: PHASE3_ERROR_CODES.limitExceeded
      },
      {
        query: {
          dataset: "dishes",
          aggregates: [{ op: "count", field: "", as: "blank_count" }]
        },
        code: PHASE3_ERROR_CODES.invalidAggregation
      }
    ];

    for (const testCase of cases) {
      expectStructuredError(
        () => compileStructuredQuery({ ...base, query: testCase.query }),
        testCase.code
      );
    }
  });

  it("accepts imported-size string scalars and rejects larger query values", () => {
    const base = {
      employee: { role: "manager" as const, labels: ["store:baoli"] },
      orgId: "default-org",
      cursorSecret: "cursor-secret"
    };
    const acceptedValue = "a".repeat(PUBLIC_INPUT_LIMITS.structuredQueryStringScalarChars);
    const compiled = compileStructuredQuery({
      ...base,
      query: {
        dataset: "dishes",
        filter: {
          field: "matched_product_name",
          op: "contains",
          value: acceptedValue
        }
      }
    });

    expect(compiled.params).toContain(`%${acceptedValue}%`);
    expectStructuredError(
      () =>
        compileStructuredQuery({
          ...base,
          query: {
            dataset: "dishes",
            filter: {
              field: "matched_product_name",
              op: "contains",
              value: `${acceptedValue}a`
            }
          }
        }),
      PHASE3_ERROR_CODES.limitExceeded
    );
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
        registryVersion: "business.2026-09-04.v2",
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

  it("compiles bounded weighted aggregate queries with alias-aware sorting and registry provenance", () => {
    const baseInput = {
      employee: {
        role: "manager" as const,
        labels: ["store:baoli"]
      },
      orgId: "default-org",
      cursorSecret: "cursor-secret"
    };
    const query = {
      dataset: "business",
      registryVersion: "business.2026-09-04.v2",
      groupBy: ["store_name", "order_source", "meal_period"],
      aggregates: [
        { op: "sum", field: "order_revenue", as: "revenue" },
        {
          op: "weightedAvg",
          field: "discount_rate",
          weightField: "gross_sales_amount",
          as: "weighted_discount_rate"
        }
      ],
      sort: [{ field: "revenue", direction: "desc" }],
      page: { limit: 200 }
    };
    const compiled = compileStructuredQuery({ ...baseInput, query });

    expect(compiled.mode).toBe("aggregate");
    expect(compiled.limit).toBe(STRUCTURED_QUERY_LIMITS.maxAggregateGroups);
    expect(compiled.selectedFields).toEqual([
      "store_name",
      "order_source",
      "meal_period",
      "revenue",
      "weighted_discount_rate"
    ]);
    expect(compiled.aggregateAliases).toEqual(["revenue", "weighted_discount_rate"]);
    expect(compiled.sql).not.toContain("ib.registry_version");
    expect(compiled.sql).toContain(
      "SUM(CAST(JSON_UNQUOTE(JSON_EXTRACT(r.payload, ?)) AS DECIMAL(20, 6))) AS `revenue`"
    );
    expect(compiled.sql).toContain(
      "SUM(CAST(JSON_UNQUOTE(JSON_EXTRACT(r.payload, ?)) AS DECIMAL(20, 6)) * CAST(JSON_UNQUOTE(JSON_EXTRACT(r.payload, ?)) AS DECIMAL(20, 6))) / NULLIF(SUM(CAST(JSON_UNQUOTE(JSON_EXTRACT(r.payload, ?)) AS DECIMAL(20, 6))), 0) AS `weighted_discount_rate`"
    );
    expect(compiled.sql).toContain("GROUP BY `store_name`, `order_source`, `meal_period`");
    expect(compiled.sql).toContain("ORDER BY `revenue` DESC");
    expect(compiled.params).toEqual([
      "$.store_name",
      "$.order_source",
      "$.meal_period",
      "$.order_revenue",
      "$.discount_rate",
      "$.gross_sales_amount",
      "$.gross_sales_amount",
      "default-org",
      "default-org",
      "default-org",
      "business",
      "applied",
      "structured",
      "active",
      "all_staff",
      "store:baoli",
      200,
      0
    ]);

    expectStructuredError(
      () =>
        compileStructuredQuery({
          ...baseInput,
          query: {
            ...query,
            aggregates: [
              { op: "sum", field: "order_revenue", as: "revenue" },
              { op: "avg", field: "discount_rate", as: "revenue" }
            ]
          }
        }),
      PHASE3_ERROR_CODES.invalidAggregation
    );
    expectStructuredError(
      () =>
        compileStructuredQuery({
          ...baseInput,
          query: {
            ...query,
            aggregates: [{ op: "sum", field: "order_revenue", as: "store_name" }]
          }
        }),
      PHASE3_ERROR_CODES.invalidAggregation
    );
    expectStructuredError(
      () =>
        compileStructuredQuery({
          ...baseInput,
          query: { ...query, sort: [{ field: "unknown_alias", direction: "desc" }] }
        }),
      PHASE3_ERROR_CODES.invalidField
    );
    expectStructuredError(
      () =>
        compileStructuredQuery({
          ...baseInput,
          query: {
            ...query,
            aggregates: [
              {
                op: "weightedAvg",
                field: "store_name",
                weightField: "gross_sales_amount",
                as: "bad_value"
              }
            ]
          }
        }),
      PHASE3_ERROR_CODES.unsupportedCapability
    );
    expectStructuredError(
      () =>
        compileStructuredQuery({
          ...baseInput,
          query: {
            ...query,
            aggregates: [
              {
                op: "weightedAvg",
                field: "discount_rate",
                weightField: "store_name",
                as: "bad_weight"
              }
            ]
          }
        }),
      PHASE3_ERROR_CODES.unsupportedCapability
    );
    expectStructuredError(
      () =>
        compileStructuredQuery({
          ...baseInput,
          query: {
            ...query,
            aggregates: [{ op: "weightedAvg", field: "discount_rate", as: "missing_weight" }]
          }
        }),
      PHASE3_ERROR_CODES.invalidAggregation
    );
    expectStructuredError(
      () =>
        compileStructuredQuery({
          ...baseInput,
          query: {
            ...query,
            aggregates: [
              {
                op: "weightedAvg",
                field: "discount_rate",
                weightField: "gross_sales_amount",
                as: "weighted_discount_rate",
                formula: "discount_rate * gross_sales_amount"
              }
            ]
          }
        }),
      PHASE3_ERROR_CODES.invalidQuery
    );

    for (const variantQuery of [
      {
        ...query,
        aggregates: [{ op: "sum", field: "gross_sales_amount", as: "revenue" }, query.aggregates[1]]
      },
      { ...query, sort: [{ field: "weighted_discount_rate", direction: "asc" }] }
    ]) {
      const variant = compileStructuredQuery({ ...baseInput, query: variantQuery });
      expect(variant.shapeHash).not.toBe(compiled.shapeHash);
      expectStructuredError(
        () =>
          compileStructuredQuery({
            ...baseInput,
            query: {
              ...variantQuery,
              page: {
                limit: query.page.limit,
                cursor: createStructuredCursor({
                  offset: query.page.limit,
                  shapeHash: compiled.shapeHash,
                  secret: baseInput.cursorSecret,
                  now: new Date("2026-09-04T00:00:00.000Z")
                })
              }
            },
            now: new Date("2026-09-04T00:01:00.000Z")
          }),
        PHASE3_ERROR_CODES.invalidCursor
      );
    }
  });

  it("compiles vip member dataset queries against vip_rows", () => {
    const compiled = compileStructuredQuery({
      employee: {
        role: "manager",
        labels: ["all_staff"]
      },
      orgId: "default-org",
      query: {
        dataset: "vip",
        select: ["member_card_no", "topup_count"],
        filter: {
          field: "topup_count",
          op: "gte",
          value: 1
        },
        page: { limit: 50 }
      },
      cursorSecret: "cursor-secret"
    });

    expect(compiled.mode).toBe("detail");
    expect(compiled.sql).toContain("FROM vip_rows r");
    expect(compiled.params).toContain("$.topup_count");
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
