import { describe, expect, it } from "vitest";
import { SMEDC_MCP_TOOL_NAMES } from "@smedc/mcp-contract";
import { createSmedcMcpToolHandlers, type McpRequestContext } from "./tool-handlers.js";
import type { ApiDelegationInjectRequest } from "./api-delegation.js";
import type { UploadApiDelegationRequest } from "./upload-tools.js";

const delegationProof = Buffer.alloc(32, 0x5a).toString("base64url");
const audit = Object.freeze({
  requestId: "factory_req_1",
  sourceIp: "127.0.0.1",
  clientSource: "mcp_launcher" as const,
  launcherVersion: "0.1.0"
});

const mcpContext: McpRequestContext = {
  employee: {
    id: "emp_factory",
    orgId: "default-org",
    organizationName: "Default Organization",
    displayName: "Factory Employee",
    email: "factory@example.com",
    role: "employee",
    disabled: false,
    clearance: 3
  },
  audit
};

function createHandlers(bearerToken: string) {
  const jsonRequests: ApiDelegationInjectRequest[] = [];
  const uploadRequests: UploadApiDelegationRequest[] = [];
  const handlers = createSmedcMcpToolHandlers({
    bearerToken,
    audit,
    delegationProof,
    maxUploadBytes: 1024,
    async inject(request) {
      jsonRequests.push(request);

      return {
        statusCode: 200,
        payload: JSON.stringify({ ok: true, token: request.headers.authorization })
      };
    },
    async uploadDelegate(request) {
      uploadRequests.push(request);

      return {
        statusCode: 202,
        payload: JSON.stringify({ ok: true, token: request.headers.authorization })
      };
    }
  });

  return { handlers, jsonRequests, uploadRequests };
}

function parseResult(result: { content: Array<{ text: string }> }) {
  return JSON.parse(result.content[0]?.text ?? "null") as unknown;
}

function validEvidenceInput() {
  return {
    file: {
      name: "evidence.md",
      mediaType: "text/markdown",
      encoding: "base64",
      contentBase64: Buffer.from("# Evidence\n", "utf8").toString("base64")
    },
    title: "Evidence",
    confidentialityLevel: 0
  };
}

describe("live SMEDC MCP tool handler map", () => {
  it("contains concrete handlers for every core contract tool", () => {
    const { handlers } = createHandlers("token-a");

    expect(Object.keys(handlers).sort()).toEqual([...SMEDC_MCP_TOOL_NAMES].sort());
  });

  it("keeps bearer tokens in per-request factories instead of MCP context", async () => {
    const first = createHandlers("token-a");
    const second = createHandlers("token-b");

    const firstSkills = await first.handlers.smedc_list_skills?.({}, mcpContext);
    const secondSkills = await second.handlers.smedc_list_skills?.({}, mcpContext);
    const secondUpload = await second.handlers.upload_evidence_document?.(
      validEvidenceInput(),
      mcpContext
    );

    expect(parseResult(firstSkills!)).toMatchObject({ token: "Bearer token-a" });
    expect(parseResult(secondSkills!)).toMatchObject({ token: "Bearer token-b" });
    expect(parseResult(secondUpload!)).toMatchObject({ token: "Bearer token-b" });
    expect(first.jsonRequests[0]?.headers.authorization).toBe("Bearer token-a");
    expect(second.jsonRequests[0]?.headers.authorization).toBe("Bearer token-b");
    expect(second.uploadRequests[0]?.headers.authorization).toBe("Bearer token-b");
    expect(JSON.stringify(mcpContext)).not.toContain("token-a");
    expect(JSON.stringify(mcpContext)).not.toContain("token-b");
  });
});
