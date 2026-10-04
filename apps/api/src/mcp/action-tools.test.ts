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
      "prepare_ledger_pdf_download"
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
