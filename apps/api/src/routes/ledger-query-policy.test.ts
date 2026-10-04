import { afterEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import {
  compileStructuredQuery,
  createStructuredCursor,
  type AuthenticatedEmployee
} from "@smedc/domain";
import type { StructuredQueryRepository } from "../structured-query.js";
import { createReadOnlyMcpToolHandlers } from "../mcp/read-tools.js";
import { buildApiServer } from "../server.js";

const employee: AuthenticatedEmployee = {
  id: "emp_policy",
  orgId: "org_policy",
  organizationName: "Synthetic",
  displayName: "Synthetic",
  email: "synthetic@example.test",
  role: "admin",
  clearance: 3,
  disabled: false
};
const secret = "synthetic-cursor-secret";
const detail = { dataset: "delivery_ledger", select: ["receipt_id"], page: { limit: 1 } };

describe("public ledger query policy", () => {
  let app: FastifyInstance;
  afterEach(async () => {
    await app?.close();
  });

  function build(enabled = "true") {
    const execute = vi.fn<StructuredQueryRepository["execute"]>(async () => ({
      rows: [{ rows: 1 }],
      hasMore: false
    }));
    app = buildApiServer({
      runtimeEnv: { LEDGER_PDF_DELIVERY_ENABLED: enabled },
      authenticateAccessToken: async (token) =>
        token === "admin"
          ? employee
          : token === "other"
            ? { ...employee, id: "other", orgId: "other_org" }
            : null,
      cursorSigningSecret: secret,
      structuredQueryRepository: { execute },
      logger: false
    });
    return execute;
  }
  function query(payload: import("light-my-request").InjectPayload, token?: string) {
    return app.inject({
      method: "POST",
      url: "/v1/structured/query",
      headers: token ? { authorization: `Bearer ${token}` } : {},
      payload
    });
  }

  it("rejects admin detail and old detail cursors after authentication, with archived PDF guidance", async () => {
    const execute = build();
    const compiled = compileStructuredQuery({
      orgId: employee.orgId,
      employee,
      query: detail,
      cursorSecret: secret
    });
    const cursor = createStructuredCursor({ offset: 1, shapeHash: compiled.shapeHash, secret });
    expect((await query(detail)).statusCode).toBe(401);
    for (const payload of [detail, { ...detail, page: { limit: 1, cursor } }]) {
      const response = await query(payload, "admin");
      expect(response.statusCode).toBe(403);
      expect(response.json().error).toMatchObject({
        code: "LEDGER_DETAIL_DISABLED",
        retryable: false
      });
      expect(response.json().error.message).toMatch(/archived PDF/i);
    }
    expect(execute).not.toHaveBeenCalled();
  });

  it("accepts only the exact aggregate operands with parameterized store/date scope", async () => {
    const execute = build();
    const response = await query(
      {
        dataset: "delivery_ledger",
        groupBy: ["store_name", "purchase_date"],
        filter: {
          and: [
            { field: "store_name", op: "eq", value: "Synthetic Store" },
            { field: "purchase_date", op: "eq", value: "2026-10-01" }
          ]
        },
        aggregates: [
          { op: "count", as: "rows" },
          { op: "countDistinct", field: "receipt_id", as: "receipts" },
          { op: "sum", field: "purchase_amount", as: "amount" }
        ],
        page: { limit: 2 }
      },
      "admin"
    );
    expect(response.statusCode).toBe(200);
    const compiled = execute.mock.calls[0]![0];
    expect(compiled).toMatchObject({
      mode: "aggregate",
      authorizationScope: { orgId: "org_policy", employee: { id: "emp_policy", clearance: 3 } }
    });
    expect(compiled.sql).toContain("COUNT(DISTINCT");
    expect(compiled.sql).toContain("COUNT(*) AS `rows`");
    expect(compiled.sql).toContain("SUM(");
    expect(compiled.aggregateAliases).toEqual(["rows", "receipts", "amount"]);
    expect(compiled.sql).toContain("confidentiality_level <= ?");
    expect(compiled.sql).not.toContain("Synthetic Store");
    expect(compiled.params).toContain("Synthetic Store");
    expect(compiled.params).toContain("2026-10-01");
  });

  it.each([
    { aggregates: [{ op: "count", field: "receipt_id" }] },
    { aggregates: [{ op: "count", field: "store_name" }] },
    { aggregates: [{ op: "countDistinct", field: "store_name" }] },
    { aggregates: [{ op: "sum", field: "purchase_quantity" }] },
    { aggregates: [{ op: "avg", field: "purchase_amount" }] },
    { aggregates: [{ op: "min", field: "purchase_amount" }] },
    { aggregates: [{ op: "max", field: "purchase_amount" }] },
    { aggregates: [{ op: "countDistinct", field: "purchase_amount" }] },
    { aggregates: [{ op: "count", as: "x`; SELECT 1 --" }] },
    { aggregates: [{ op: "count" }], sort: [{ field: "receipt_id", direction: "asc" }] },
    {
      aggregates: [
        { op: "weightedAvg", field: "purchase_amount", weightField: "purchase_quantity" }
      ]
    },
    { aggregates: [{ op: "count" }], groupBy: ["supplier_name"] },
    {
      aggregates: [{ op: "count" }],
      filter: { not: { field: "receipt_id", op: "eq", value: "synthetic" } }
    },
    { aggregates: [{ op: "count" }], select: ["store_name"] },
    { groupBy: ["store_name"] }
  ])("rejects near-miss aggregate request %j", async (shape) => {
    const execute = build();
    expect((await query({ dataset: "delivery_ledger", ...shape }, "admin")).statusCode).toBe(400);
    expect(execute).not.toHaveBeenCalled();
  });

  it("binds allowed aggregate cursors to the employee and organization", async () => {
    build();
    const payload = {
      dataset: "delivery_ledger",
      aggregates: [{ op: "count" }],
      page: { limit: 1 }
    };
    const compiled = compileStructuredQuery({
      orgId: employee.orgId,
      employee,
      query: payload,
      cursorSecret: secret
    });
    const cursor = createStructuredCursor({ offset: 1, shapeHash: compiled.shapeHash, secret });
    expect(
      (await query({ ...payload, page: { limit: 1, cursor } }, "other")).json().error.code
    ).toBe("INVALID_CURSOR");
    expect((await query({ ...payload, page: { limit: 1, cursor } }, "admin")).statusCode).toBe(200);
  });

  it("exposes aggregate-only ledger discovery without raw detail presentation", async () => {
    build();
    expect((await app.inject({ method: "GET", url: "/v1/structured/datasets" })).statusCode).toBe(
      401
    );
    const response = await app.inject({
      method: "GET",
      url: "/v1/structured/datasets",
      headers: { authorization: "Bearer admin" }
    });
    const ledger = response
      .json()
      .datasets.find((entry: { dataset: string }) => entry.dataset === "delivery_ledger");
    expect(ledger.queryModes).toEqual(["aggregate"]);
    expect(ledger).not.toHaveProperty("presentation");
    expect(ledger.fields.map((field: { canonicalName: string }) => field.canonicalName)).toEqual([
      "receipt_id",
      "store_name",
      "purchase_date",
      "purchase_amount"
    ]);
    expect(ledger.fields.every((field: { defaultReturn: boolean }) => !field.defaultReturn)).toBe(
      true
    );
    expect(
      ledger.fields.find((field: { canonicalName: string }) => field.canonicalName === "receipt_id")
        .capabilities
    ).toEqual({ filter: false, sort: false, group: false, aggregate: true });
    expect(ledger.allowedAggregates).toEqual([
      { op: "count" },
      { op: "countDistinct", field: "receipt_id" },
      { op: "sum", field: "purchase_amount" }
    ]);
    expect(
      response.json().datasets.find((entry: { dataset: string }) => entry.dataset === "vip")
        .accessMode
    ).toBe("row_query");
  });

  it("applies the same detail denial and allowed aggregate via MCP delegation", async () => {
    const execute = build();
    const audit = {
      requestId: "synthetic_mcp",
      sourceIp: "127.0.0.1",
      clientSource: "mcp_launcher" as const,
      launcherVersion: "0.5.0"
    };
    const handlers = createReadOnlyMcpToolHandlers({
      bearerToken: "admin",
      delegationProof: "synthetic",
      audit,
      inject: async (request) => {
        const response = await app.inject({
          ...request,
          payload: request.payload as import("light-my-request").InjectPayload
        });
        return { statusCode: response.statusCode, payload: response.payload };
      }
    });
    const detailResult = await handlers.query_structured_dataset!(detail, { employee, audit });
    expect(detailResult).toMatchObject({ isError: true });
    expect(JSON.parse(detailResult.content[0]!.text!)).toMatchObject({
      error: { code: "LEDGER_DETAIL_DISABLED" }
    });
    const aggregateResult = await handlers.query_structured_dataset!(
      {
        dataset: "delivery_ledger",
        aggregates: [{ op: "countDistinct", field: "receipt_id" }],
        sort: [{ field: "countDistinct_receipt_id", direction: "desc" }]
      },
      { employee, audit }
    );
    expect(JSON.parse(aggregateResult.content[0]!.text!)).toMatchObject({ rows: [{ rows: 1 }] });
    expect(execute).toHaveBeenCalledTimes(1);
    expect(execute.mock.calls[0]![0].sql).toContain("ORDER BY `countDistinct_receipt_id` DESC");
  });

  it("does not accept a client-controlled feature switch", async () => {
    const execute = build();
    expect((await query({ ...detail, ledgerPdfDeliveryEnabled: false }, "admin")).statusCode).toBe(
      400
    );
    expect(execute).not.toHaveBeenCalled();
  });

  it("preserves flag-off ledger detail and flag-on other dataset queries", async () => {
    build("false");
    expect((await query(detail, "admin")).statusCode).toBe(200);
    await app.close();
    build();
    expect((await query({ dataset: "vip", select: ["member_id"] }, "admin")).statusCode).toBe(200);
  });
});
