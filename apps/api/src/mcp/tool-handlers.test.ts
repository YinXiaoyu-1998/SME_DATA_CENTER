import { describe, expect, it, vi } from "vitest";
import type { UploadAuthorizationAuditRepository } from "../file-upload-authorization.js";
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

function createHandlers(
  bearerToken: string,
  auditRepository?: () => UploadAuthorizationAuditRepository
) {
  const appendDenied = vi.fn(async () => {});
  const uploadAuthorizationAudit = auditRepository ?? vi.fn(() => ({ appendDenied }));
  const logAuditFailure = vi.fn();
  const jsonRequests: ApiDelegationInjectRequest[] = [];
  const uploadRequests: UploadApiDelegationRequest[] = [];
  const handlers = createSmedcMcpToolHandlers({
    bearerToken,
    uploadAuthorizationAudit,
    logAuditFailure,
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

  return {
    handlers,
    jsonRequests,
    uploadRequests,
    appendDenied,
    uploadAuthorizationAudit,
    logAuditFailure
  };
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
  it("audits an employee denial exactly once with safe context and never delegates", async () => {
    const fixture = createHandlers("private-bearer");
    const result = await fixture.handlers.upload_structured_dataset!(
      { dataset: "private-fake", file: { name: "private-file", contentBase64: "private-content" } },
      mcpContext
    );
    expect(parseResult(result)).toMatchObject({
      error: { code: "UPLOAD_ADMIN_REQUIRED", retryable: false, requestId: audit.requestId }
    });
    expect(fixture.appendDenied).toHaveBeenCalledExactlyOnceWith({
      orgId: "default-org",
      actorEmployeeId: "emp_factory",
      uploadSurface: "structured_dataset",
      audit
    });
    expect(fixture.jsonRequests).toEqual([]);
    expect(fixture.uploadRequests).toEqual([]);
    expect(JSON.stringify([result, fixture.appendDenied.mock.calls])).not.toContain("private-");
  });

  it.each(["initialization", "append"])(
    "keeps denial safe when audit %s fails",
    async (failure) => {
      const repository = vi.fn(() => {
        if (failure === "initialization") throw new Error("private-audit-error");
        return {
          appendDenied: async () => {
            throw new Error("private-audit-error");
          }
        };
      });
      const fixture = createHandlers("private-bearer", repository);
      const result = await fixture.handlers.upload_evidence_document!({}, mcpContext);
      expect(parseResult(result)).toMatchObject({
        error: { code: "UPLOAD_ADMIN_REQUIRED", retryable: false }
      });
      expect(repository).toHaveBeenCalledOnce();
      expect(fixture.logAuditFailure).toHaveBeenCalledExactlyOnceWith({
        requestId: audit.requestId,
        uploadSurface: "evidence_document"
      });
      expect(fixture.uploadRequests).toEqual([]);
      expect(JSON.stringify([result, fixture.logAuditFailure.mock.calls])).not.toContain(
        "private-"
      );
    }
  );

  it("does not initialize the audit repository for admin uploads", async () => {
    const repository = vi.fn(() => {
      throw new Error("must stay lazy for admins");
    });
    const fixture = createHandlers("admin-token", repository);
    const result = await fixture.handlers.upload_evidence_document!(validEvidenceInput(), {
      ...mcpContext,
      employee: { ...mcpContext.employee, role: "admin" }
    });
    expect(parseResult(result)).toMatchObject({ ok: true });
    expect(fixture.uploadRequests).toHaveLength(1);
    expect(repository).not.toHaveBeenCalled();
  });
  it("contains concrete handlers for every core contract tool", () => {
    const { handlers } = createHandlers("token-a");

    expect(Object.keys(handlers).sort()).toEqual([...SMEDC_MCP_TOOL_NAMES].sort());
  });

  it("keeps bearer tokens in per-request factories instead of MCP context", async () => {
    const first = createHandlers("token-a");
    const second = createHandlers("token-b");

    const firstSkills = await first.handlers.smedc_list_skills?.({}, mcpContext);
    const secondSkills = await second.handlers.smedc_list_skills?.({}, mcpContext);
    const secondUpload = await second.handlers.upload_evidence_document?.(validEvidenceInput(), {
      ...mcpContext,
      employee: { ...mcpContext.employee, role: "admin" }
    });

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
