import {
  errorToolResult,
  type EnterpriseHubMcpToolName,
  type McpJsonToolResult
} from "@enterprise-hub/mcp-contract";
import type { AuthenticatedEmployee } from "@enterprise-hub/domain";
import type { RequestAuditContext } from "../request-audit-context.js";
import { createReadOnlyMcpToolHandlers } from "./read-tools.js";
import type { ApiDelegationContext } from "./api-delegation.js";
import {
  createUploadToolHandlers,
  type UploadApiDelegate,
  type UploadApiDelegationContext
} from "./upload-tools.js";

export interface McpRequestContext {
  employee: AuthenticatedEmployee;
  audit: RequestAuditContext;
  abortSignal?: AbortSignal;
}

export type EnterpriseHubMcpToolHandler = (
  input: unknown,
  context: McpRequestContext
) => Promise<McpJsonToolResult>;

export type EnterpriseHubMcpToolHandlers = Partial<
  Record<EnterpriseHubMcpToolName, EnterpriseHubMcpToolHandler>
>;

export interface CreateEnterpriseHubMcpToolHandlersOptions {
  bearerToken: string;
  audit: RequestAuditContext;
  delegationProof: string;
  maxUploadBytes: number;
  inject: ApiDelegationContext["inject"];
  uploadDelegate: UploadApiDelegate;
}

export function createEnterpriseHubMcpToolHandlers(
  options: CreateEnterpriseHubMcpToolHandlersOptions
): EnterpriseHubMcpToolHandlers {
  const readOnlyHandlers = createReadOnlyMcpToolHandlers({
    bearerToken: options.bearerToken,
    audit: options.audit,
    delegationProof: options.delegationProof,
    inject: options.inject
  });
  const uploadHandlers = createUploadToolHandlers({
    delegate: options.uploadDelegate,
    getDelegationContext: (context): UploadApiDelegationContext => ({
      authorization: `Bearer ${options.bearerToken}`,
      audit: context.audit,
      delegationProof: options.delegationProof,
      maxUploadBytes: options.maxUploadBytes
    })
  });

  return {
    ...readOnlyHandlers,
    ...uploadHandlers
  };
}

export function createNoopToolHandler(
  toolName: EnterpriseHubMcpToolName
): EnterpriseHubMcpToolHandler {
  return async (_input, context) =>
    errorToolResult(
      "MCP_TOOL_NOT_IMPLEMENTED",
      "Enterprise Hub MCP tool handler is not implemented yet.",
      {
        toolName,
        requestId: context.audit.requestId
      }
    );
}
