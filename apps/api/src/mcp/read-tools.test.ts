import { describe, expect, it } from "vitest";
import type { EnterpriseHubMcpToolName } from "@enterprise-hub/mcp-contract";
import type { ApiDelegationContext, ApiDelegationInjectRequest } from "./api-delegation.js";
import { READ_ONLY_MCP_TOOL_NAMES, createReadOnlyMcpToolHandlers } from "./read-tools.js";

const delegationProof = Buffer.alloc(32, 0x5a).toString("base64url");
const audit = Object.freeze({
  requestId: "req_mcp_123",
  sourceIp: "198.51.100.25",
  clientSource: "mcp_launcher" as const,
  launcherVersion: null
});

function parseToolResult(result: { content: Array<{ text: string }> }): unknown {
  return JSON.parse(result.content[0]?.text ?? "null");
}

function createCapturingDelegate(
  token = "manager-token",
  auditContext: ApiDelegationContext["audit"] = audit
) {
  const calls: ApiDelegationInjectRequest[] = [];
  const context: ApiDelegationContext = {
    bearerToken: token,
    audit: auditContext,
    delegationProof,
    async inject(request) {
      calls.push(request);

      return {
        statusCode: 200,
        payload: JSON.stringify({
          ok: true,
          role: request.headers.authorization === "Bearer admin-token" ? "admin" : "manager"
        })
      };
    }
  };

  return { calls, handlers: createReadOnlyMcpToolHandlers(context) };
}

describe("read-only MCP tool handlers", () => {
  it("exports exactly the read-only core business tools", () => {
    expect(READ_ONLY_MCP_TOOL_NAMES).toEqual([
      "enterprise_hub_list_labels",
      "enterprise_hub_list_skills",
      "search_document_evidence",
      "list_structured_datasets",
      "query_structured_dataset",
      "describe_structured_dataset_coverage",
      "query_quarantine_certificates",
      "get_source_document_download_url",
      "get_evidence_document_status",
      "get_import_status"
    ]);
    expect(Object.keys(createCapturingDelegate().handlers).sort()).toEqual(
      [...READ_ONLY_MCP_TOOL_NAMES].sort()
    );
  });

  it("maps read-only tool inputs to the authenticated API routes", async () => {
    const { calls, handlers } = createCapturingDelegate();

    await handlers.enterprise_hub_list_labels?.({}, {} as never);
    await handlers.enterprise_hub_list_skills?.(
      { q: "菜单", category: "menu-analysis" },
      {} as never
    );
    await handlers.search_document_evidence?.(
      {
        query: "菜单 毛利",
        filters: { fileTypes: ["md"], documentIds: ["doc_1"], labelIds: ["lbl_1"] },
        limit: 5,
        cursor: "cursor_1"
      },
      {} as never
    );
    await handlers.list_structured_datasets?.({}, {} as never);
    await handlers.query_structured_dataset?.(
      {
        dataset: "dishes",
        registryVersion: "2026-01",
        select: ["dish_name", "sales_amount"],
        filter: { field: "store_label", op: "eq", value: "store:baoli" },
        sort: [{ field: "sales_amount", direction: "desc" }],
        page: { limit: 25, cursor: null },
        groupBy: ["dish_category"],
        aggregates: [{ op: "sum", field: "sales_amount", as: "sales" }]
      },
      {} as never
    );
    await (
      handlers as Record<
        string,
        (input: unknown, context: Record<string, unknown>) => Promise<unknown>
      >
    )["describe_structured_dataset_coverage"]?.({ dataset: "dish_catalog" }, {} as never);
    await handlers.get_evidence_document_status?.({ documentId: "doc/1" }, {} as never);
    await handlers.get_import_status?.({ importBatchId: "imp/1" }, {} as never);
    await handlers.query_quarantine_certificates?.(
      { receiptIds: ["SH2608250117", "SH2608260003"] },
      {} as never
    );
    await handlers.get_source_document_download_url?.({ sourceDocumentId: "doc/2" }, {} as never);

    expect(
      calls.map(({ method, url, query, payload }) => ({ method, url, query, payload }))
    ).toEqual([
      { method: "GET", url: "/labels", query: undefined, payload: undefined },
      {
        method: "GET",
        url: "/skills",
        query: { q: "菜单", category: "menu-analysis" },
        payload: undefined
      },
      {
        method: "POST",
        url: "/v1/evidence/search",
        query: undefined,
        payload: {
          query: "菜单 毛利",
          filters: { fileTypes: ["md"], documentIds: ["doc_1"], labelIds: ["lbl_1"] },
          limit: 5,
          cursor: "cursor_1"
        }
      },
      {
        method: "GET",
        url: "/v1/structured/datasets",
        query: undefined,
        payload: undefined
      },
      {
        method: "POST",
        url: "/v1/structured/query",
        query: undefined,
        payload: {
          dataset: "dishes",
          registryVersion: "2026-01",
          select: ["dish_name", "sales_amount"],
          filter: { field: "store_label", op: "eq", value: "store:baoli" },
          sort: [{ field: "sales_amount", direction: "desc" }],
          page: { limit: 25, cursor: null },
          groupBy: ["dish_category"],
          aggregates: [{ op: "sum", field: "sales_amount", as: "sales" }]
        }
      },
      {
        method: "GET",
        url: "/v1/structured/datasets/dish_catalog/coverage",
        query: undefined,
        payload: undefined
      },
      {
        method: "GET",
        url: "/v1/documents/evidence/doc%2F1/status",
        query: undefined,
        payload: undefined
      },
      {
        method: "GET",
        url: "/v1/structured/imports/imp%2F1",
        query: undefined,
        payload: undefined
      },
      {
        method: "POST",
        url: "/v1/quarantine-certificates/query",
        query: undefined,
        payload: { receiptIds: ["SH2608250117", "SH2608260003"] }
      },
      {
        method: "POST",
        url: "/v1/source-documents/doc%2F2/download-url",
        query: undefined,
        payload: undefined
      }
    ]);
    expect(calls.every((call) => call.headers.authorization === "Bearer manager-token")).toBe(true);
    expect(JSON.stringify(calls)).not.toContain("undefined");
  });

  it.each(["delivery_ledger", "supplier_catalog"] as const)(
    "delegates %s structured queries through the existing read tool",
    async (dataset) => {
      const { calls, handlers } = createCapturingDelegate();

      const result = await handlers.query_structured_dataset?.(
        { dataset, select: ["supplier_name"], page: { limit: 1 } },
        {} as never
      );

      expect(parseToolResult(result!)).toMatchObject({ ok: true });
      expect(calls).toHaveLength(1);
      expect(calls[0]).toMatchObject({
        method: "POST",
        url: "/v1/structured/query",
        payload: {
          dataset,
          select: ["supplier_name"],
          page: { limit: 1 }
        }
      });
    }
  );

  it("validates inputs with shared strict schemas before API injection", async () => {
    const { calls, handlers } = createCapturingDelegate("secret-token");

    const labelsResult = await handlers.enterprise_hub_list_labels?.(
      { unexpected: true },
      {} as never
    );
    const queryResult = await handlers.query_structured_dataset?.(
      { dataset: "dishes", filePath: "/tmp/not-allowed.csv" },
      {} as never
    );

    expect(calls).toEqual([]);
    expect(labelsResult?.isError).toBe(true);
    expect(queryResult?.isError).toBe(true);
    expect(JSON.stringify(labelsResult)).not.toContain("secret-token");
    expect(JSON.stringify(queryResult)).not.toContain("/tmp/not-allowed.csv");
    expect(parseToolResult(labelsResult!)).toMatchObject({
      error: { code: "MCP_INPUT_VALIDATION_ERROR" }
    });
    expect(parseToolResult(queryResult!)).toMatchObject({
      error: { code: "MCP_INPUT_VALIDATION_ERROR" }
    });
  });

  it("rejects invalid structured coverage inputs before API injection", async () => {
    const { calls, handlers } = createCapturingDelegate("secret-token");
    const coverageHandler = (
      handlers as Record<
        string,
        (
          input: unknown,
          context: Record<string, unknown>
        ) => Promise<{ isError: boolean; content: Array<{ text: string }> }>
      >
    )["describe_structured_dataset_coverage"];

    const invalidDataset = await coverageHandler?.({ dataset: "orders" }, {} as never);
    const extraField = await coverageHandler?.(
      { dataset: "dishes", report: "weekly" },
      {} as never
    );

    expect(calls).toEqual([]);
    expect(invalidDataset?.isError).toBe(true);
    expect(extraField?.isError).toBe(true);
    expect(parseToolResult(invalidDataset!)).toMatchObject({
      error: { code: "MCP_INPUT_VALIDATION_ERROR" }
    });
    expect(parseToolResult(extraField!)).toMatchObject({
      error: { code: "MCP_INPUT_VALIDATION_ERROR" }
    });
  });

  it("delegates structured coverage with request and launcher audit headers", async () => {
    const { calls, handlers } = createCapturingDelegate("manager-token", {
      ...audit,
      requestId: "req_coverage_mcp",
      launcherVersion: "0.2.6"
    });

    await (
      handlers as Record<
        string,
        (input: unknown, context: Record<string, unknown>) => Promise<unknown>
      >
    )["describe_structured_dataset_coverage"]?.({ dataset: "delivery_ledger" }, {} as never);

    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      method: "GET",
      url: "/v1/structured/datasets/delivery_ledger/coverage",
      headers: {
        authorization: "Bearer manager-token",
        "x-request-id": "req_coverage_mcp",
        "x-enterprise-hub-internal-delegation": delegationProof,
        "x-enterprise-hub-launcher-version": "0.2.6"
      },
      remoteAddress: audit.sourceIp
    });
  });

  it("returns structured coverage API success envelopes without interpretation", async () => {
    const coverage = {
      dataset: "business",
      registryVersion: "business.2026-09-04.v2",
      metadataPolicy: "window",
      sources: [
        {
          importBatchId: "imp_coverage",
          sourceDocumentId: "doc_coverage",
          sourceDocumentTitle: "July business export",
          appliedAt: "2026-08-01T00:00:00.000Z",
          rowCount: 31,
          startDate: "2026-07-01",
          endDate: "2026-07-31"
        }
      ]
    };
    const handlers = createReadOnlyMcpToolHandlers({
      bearerToken: "manager-token",
      audit,
      delegationProof,
      async inject() {
        return {
          statusCode: 200,
          payload: JSON.stringify(coverage)
        };
      }
    });
    const coverageHandler = (
      handlers as Record<
        string,
        (
          input: unknown,
          context: Record<string, unknown>
        ) => Promise<{ content: Array<{ text: string }>; isError: boolean }>
      >
    )["describe_structured_dataset_coverage"];

    const result = await coverageHandler?.({ dataset: "business" }, {} as never);

    expect(result?.isError).toBe(false);
    expect(parseToolResult(result!)).toEqual(coverage);
    expect(JSON.stringify(result)).not.toMatch(/complete|incomplete|sufficient|report/i);
  });

  it("returns delegated structured coverage API error envelopes through the existing adapter", async () => {
    const context: ApiDelegationContext = {
      bearerToken: "manager-token",
      audit,
      delegationProof,
      async inject() {
        return {
          statusCode: 400,
          payload: JSON.stringify({
            error: {
              code: "INVALID_QUERY",
              message: "Dataset is invalid.",
              retryable: false,
              requestId: "req_coverage_api",
              details: { dataset: "orders" }
            }
          })
        };
      }
    };
    const handlers = createReadOnlyMcpToolHandlers(context);
    const coverageHandler = (
      handlers as Record<
        string,
        (
          input: unknown,
          context: Record<string, unknown>
        ) => Promise<{ content: Array<{ text: string }>; isError: boolean }>
      >
    )["describe_structured_dataset_coverage"];

    const result = await coverageHandler?.({ dataset: "dishes" }, {} as never);

    expect(result?.isError).toBe(true);
    expect(parseToolResult(result!)).toEqual({
      error: {
        code: "INVALID_QUERY",
        message: "Dataset is invalid.",
        retryable: false,
        requestId: "req_coverage_api"
      }
    });
  });

  it("lets the delegated API enforce role and permission semantics from the forwarded bearer", async () => {
    const manager = createCapturingDelegate("manager-token");
    const admin = createCapturingDelegate("admin-token");

    const managerResult = await manager.handlers.query_structured_dataset?.(
      { dataset: "business", page: { limit: 1 } },
      {} as never
    );
    const adminResult = await admin.handlers.query_structured_dataset?.(
      { dataset: "business", page: { limit: 1 } },
      {} as never
    );

    expect(parseToolResult(managerResult!)).toMatchObject({ role: "manager" });
    expect(parseToolResult(adminResult!)).toMatchObject({ role: "admin" });
  });

  it("does not create handlers for upload or mutation tools", () => {
    const handlers = createCapturingDelegate().handlers as Partial<
      Record<EnterpriseHubMcpToolName, unknown>
    >;

    expect(handlers.upload_evidence_document).toBeUndefined();
    expect(handlers.upload_structured_dataset).toBeUndefined();
    expect(handlers.archive_quarantine_certificates).toBeUndefined();
  });

  it("honors already-aborted contexts before read API injection without leaking input data", async () => {
    const token = "secret-token";
    const controller = new AbortController();
    controller.abort();
    const calls: ApiDelegationInjectRequest[] = [];
    const handlers = createReadOnlyMcpToolHandlers({
      bearerToken: token,
      audit,
      delegationProof,
      abortSignal: controller.signal,
      async inject(request) {
        calls.push(request);

        return {
          statusCode: 200,
          payload: JSON.stringify({ ok: true, token })
        };
      }
    });

    const result = await handlers.search_document_evidence?.(
      { query: "secret query", limit: 5 },
      {} as never
    );
    const serialized = JSON.stringify(result);

    expect(calls).toEqual([]);
    expect(result?.isError).toBe(true);
    expect(parseToolResult(result!)).toEqual({
      error: {
        code: "MCP_REQUEST_CANCELLED",
        message: "MCP request was cancelled before API delegation started.",
        retryable: false,
        requestId: "req_mcp_123"
      }
    });
    expect(serialized).not.toContain(token);
    expect(serialized).not.toContain("secret query");
  });
});
