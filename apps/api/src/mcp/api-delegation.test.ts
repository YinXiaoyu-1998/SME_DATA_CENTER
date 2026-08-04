import { describe, expect, it } from "vitest";
import { delegateJsonApiRequest, type ApiDelegationContext } from "./api-delegation.js";

const delegationProof = Buffer.alloc(32, 0x5a).toString("base64url");
const audit = Object.freeze({
  requestId: "req_mcp_123",
  sourceIp: "203.0.113.10",
  clientSource: "mcp_launcher" as const,
  launcherVersion: "0.1.0"
});

function parseToolResult(result: { content: Array<{ text: string }> }): unknown {
  return JSON.parse(result.content[0]?.text ?? "null");
}

describe("MCP API delegation", () => {
  it("injects JSON API requests with bearer authorization and request metadata", async () => {
    const calls: unknown[] = [];
    const context: ApiDelegationContext = {
      bearerToken: "secret-token",
      audit,
      delegationProof,
      async inject(request) {
        calls.push(request);

        return {
          statusCode: 200,
          payload: JSON.stringify({ ok: true })
        };
      }
    };

    const result = await delegateJsonApiRequest(context, {
      method: "POST",
      path: "/v1/evidence/search",
      query: { q: "菜单", empty: undefined },
      body: { query: "菜单", limit: 5 }
    });

    expect(result.isError).toBe(false);
    expect(parseToolResult(result)).toEqual({ ok: true });
    expect(JSON.stringify(result)).not.toContain(delegationProof);
    expect(calls).toEqual([
      {
        method: "POST",
        url: "/v1/evidence/search",
        query: { q: "菜单" },
        headers: {
          authorization: "Bearer secret-token",
          "content-type": "application/json",
          "x-request-id": "req_mcp_123",
          "x-enterprise-hub-internal-delegation": delegationProof,
          "x-enterprise-hub-launcher-version": "0.1.0"
        },
        payload: { query: "菜单", limit: 5 },
        remoteAddress: "203.0.113.10"
      }
    ]);
  });

  it("preserves shared safe API error fields without details", async () => {
    const context: ApiDelegationContext = {
      bearerToken: "secret-token",
      audit,
      delegationProof,
      async inject() {
        return {
          statusCode: 403,
          payload: JSON.stringify({
            error: {
              code: "DATASET_FORBIDDEN",
              message: "Dataset is not visible.",
              retryable: false,
              requestId: "api_req_456",
              details: { internal: "not for MCP" }
            }
          })
        };
      }
    };

    const result = await delegateJsonApiRequest(context, {
      method: "POST",
      path: "/v1/structured/query",
      body: { dataset: "business" }
    });

    expect(result.isError).toBe(true);
    expect(parseToolResult(result)).toEqual({
      error: {
        code: "DATASET_FORBIDDEN",
        message: "Dataset is not visible.",
        retryable: false,
        requestId: "api_req_456"
      }
    });
  });

  it("returns a stable generic API error for malformed or thrown responses without token leakage", async () => {
    const token = "secret-token";
    const context: ApiDelegationContext = {
      bearerToken: token,
      audit,
      delegationProof,
      async inject() {
        throw new Error(`upstream failed with Bearer ${token}`);
      }
    };

    const result = await delegateJsonApiRequest(context, {
      method: "GET",
      path: "/labels"
    });
    const serialized = JSON.stringify(result);

    expect(result.isError).toBe(true);
    expect(parseToolResult(result)).toEqual({
      error: {
        code: "ENTERPRISE_HUB_API_ERROR",
        message: "Enterprise Hub API request failed.",
        retryable: true,
        requestId: "req_mcp_123"
      }
    });
    expect(serialized).not.toContain(token);
  });

  it("returns request-cancelled before injection when the MCP context is already aborted", async () => {
    const token = "secret-token";
    const controller = new AbortController();
    controller.abort();
    const calls: unknown[] = [];
    const context: ApiDelegationContext = {
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
    };

    const result = await delegateJsonApiRequest(context, {
      method: "GET",
      path: "/labels"
    });
    const serialized = JSON.stringify(result);

    expect(calls).toEqual([]);
    expect(result.isError).toBe(true);
    expect(parseToolResult(result)).toEqual({
      error: {
        code: "MCP_REQUEST_CANCELLED",
        message: "MCP request was cancelled before API delegation started.",
        retryable: false,
        requestId: "req_mcp_123"
      }
    });
    expect(serialized).not.toContain(token);
  });
});
