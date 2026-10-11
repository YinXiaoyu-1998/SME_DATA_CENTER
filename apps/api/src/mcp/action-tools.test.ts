import { describe, expect, it } from "vitest";
import type { ApiDelegationContext, ApiDelegationInjectRequest } from "./api-delegation.js";
import { ACTION_MCP_TOOL_NAMES, createActionMcpToolHandlers } from "./action-tools.js";

const audit = Object.freeze({
  requestId: "req_mcp_action",
  sourceIp: "198.51.100.26",
  clientSource: "mcp_launcher" as const,
  launcherVersion: null
});

function createCapturingDelegate() {
  const calls: ApiDelegationInjectRequest[] = [];
  const context: ApiDelegationContext = {
    bearerToken: "employee-token",
    audit,
    delegationProof: "delegation-proof",
    async inject(request) {
      calls.push(request);
      return {
        statusCode: 200,
        payload: JSON.stringify({ archivedCount: 1 })
      };
    }
  };

  return { calls, handlers: createActionMcpToolHandlers(context) };
}

describe("action MCP tool handlers", () => {
  it("delegates quarantine archive to the action API route", async () => {
    const { calls, handlers } = createCapturingDelegate();
    const result = await handlers.archive_quarantine_certificates?.(
      { receiptId: "SH2608250117" },
      {} as never
    );

    expect(ACTION_MCP_TOOL_NAMES).toEqual([
      "archive_quarantine_certificates",
      "prepare_ledger_pdf_download",
      "update_account_permissions",
      "create_evidence_category",
      "update_business_category",
      "create_business_dimension",
      "update_business_dimension",
      "create_business_dimension_value",
      "update_business_dimension_value",
      "update_business_store",
      "update_evidence_document_attributes",
      "activate_authorization_cutover",
      "suspend_authorization_reads"
    ]);
    expect(JSON.parse(result?.content[0]?.text ?? "{}")).toEqual({ archivedCount: 1 });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      method: "POST",
      url: "/v1/quarantine-certificates/archive",
      payload: { receiptId: "SH2608250117" }
    });
  });
});

it.each([["prepare_ledger_pdf_download", "/v1/ledger-pdfs/downloads"]] as const)(
  "%s delegates an idempotent ZIP request without rendering",
  async (name, url) => {
    const calls: ApiDelegationInjectRequest[] = [];
    const handlers = createActionMcpToolHandlers({
      bearerToken: "employee-token",
      audit,
      delegationProof: "proof",
      async inject(request) {
        calls.push(request);
        return {
          statusCode: 202,
          payload: JSON.stringify({ requestId: "pdf-1", status: "queued" })
        };
      }
    });
    const input = {
      storeNames: ["合成门店"],
      startDate: "2026-10-01",
      endDate: "2026-10-04",
      idempotencyKey: "key-1"
    };
    const result = await handlers[name]?.(input, {} as never);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      method: "POST",
      url,
      payload: input,
      headers: { authorization: "Bearer employee-token" }
    });
    expect(JSON.parse(result?.content[0]?.text ?? "{}")).toEqual({
      requestId: "pdf-1",
      status: "queued"
    });
    expect(result?.isError).toBe(false);
    expect(JSON.stringify(result)).not.toMatch(/base64|storageObjectKey|sourceDocument/);
    const invalid = await handlers[name]?.({ ...input, orgId: "other-org" }, {} as never);
    expect(invalid?.isError).toBe(true);
    expect(calls).toHaveLength(1);
  }
);

it.each([
  [
    "update_account_permissions",
    "PATCH",
    "/v1/admin/permissions/accounts/employee%2F1",
    { employeeId: "employee/1", expectedVersion: "7", clearance: 2, grants: [] },
    ["employeeId"]
  ],
  [
    "create_evidence_category",
    "POST",
    "/v1/admin/permissions/categories",
    {
      id: "memo",
      name: "Memo",
      expectedVersion: "7",
      ownerships: ["group"],
      requiredDimensionIds: []
    },
    []
  ],
  [
    "update_business_category",
    "PATCH",
    "/v1/admin/permissions/categories/category%2F1",
    { categoryId: "category/1", name: "Business", expectedVersion: "7", confidentialityLevel: 2 },
    ["categoryId"]
  ],
  [
    "create_business_dimension",
    "POST",
    "/v1/admin/permissions/dimensions",
    { id: "project", name: "Project", expectedVersion: "7" },
    []
  ],
  [
    "update_business_dimension",
    "PATCH",
    "/v1/admin/permissions/dimensions/project%2F1",
    { dimensionId: "project/1", name: "Project", expectedVersion: "7" },
    ["dimensionId"]
  ],
  [
    "create_business_dimension_value",
    "POST",
    "/v1/admin/permissions/dimensions/project%2F1/values",
    { dimensionId: "project/1", id: "X", name: "X", expectedVersion: "7" },
    ["dimensionId"]
  ],
  [
    "update_business_dimension_value",
    "PATCH",
    "/v1/admin/permissions/dimensions/project%2F1/values/X%2F1",
    { dimensionId: "project/1", valueId: "X/1", name: "X", expectedVersion: "7" },
    ["dimensionId", "valueId"]
  ],
  [
    "update_business_store",
    "POST",
    "/v1/admin/permissions/stores",
    { enterpriseKey: "enterprise", name: "Store A ", expectedVersion: "7" },
    []
  ],
  [
    "update_evidence_document_attributes",
    "PATCH",
    "/v1/admin/permissions/documents/doc%2F1",
    {
      documentId: "doc/1",
      categoryId: "memo",
      expectedVersion: "7",
      fileConfidentialityLevel: 2,
      scopes: [{ enterpriseKey: "enterprise", ownership: "group", dimensions: { project: "X" } }],
      historicalSupplementReason: "Explicit correction"
    },
    ["documentId"]
  ],
  [
    "activate_authorization_cutover",
    "POST",
    "/v1/admin/permissions/cutover/activate",
    { expectedVersion: "7", confirm: true },
    []
  ],
  [
    "suspend_authorization_reads",
    "POST",
    "/v1/admin/permissions/cutover/suspend",
    { expectedVersion: "7", confirm: true },
    []
  ]
] as const)(
  "%s uses only its controlled versioned HTTP operation",
  async (name, method, url, input, selectors) => {
    const { calls, handlers } = createCapturingDelegate();
    const result = await handlers[name]?.(input, { audit } as never);
    expect(result?.isError).toBe(false);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      method,
      url,
      payload: Object.fromEntries(
        Object.entries(input).filter(([key]) => !(selectors as readonly string[]).includes(key))
      )
    });
    const invalid = await handlers[name]?.(
      { ...input, api: "/v1/anything", orgId: "foreign", sql: "SELECT 1" },
      { audit } as never
    );
    expect(invalid?.isError).toBe(true);
    expect(calls).toHaveLength(1);
  }
);
