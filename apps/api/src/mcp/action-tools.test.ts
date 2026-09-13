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

    expect(ACTION_MCP_TOOL_NAMES).toEqual(["archive_quarantine_certificates"]);
    expect(JSON.parse(result?.content[0]?.text ?? "{}")).toEqual({ archivedCount: 1 });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      method: "POST",
      url: "/v1/quarantine-certificates/archive",
      payload: { receiptId: "SH2608250117" }
    });
  });
});
