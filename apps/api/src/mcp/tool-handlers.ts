import {
  errorToolResult,
  type SmedcMcpToolName,
  type McpJsonToolResult
} from "@smedc/mcp-contract";
import type { AuthenticatedEmployee } from "@smedc/domain";
import type { RequestAuditContext } from "../request-audit-context.js";
import { createActionMcpToolHandlers } from "./action-tools.js";
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

export type SmedcMcpToolHandler = (
  input: unknown,
  context: McpRequestContext
) => Promise<McpJsonToolResult>;

export type SmedcMcpToolHandlers = Partial<Record<SmedcMcpToolName, SmedcMcpToolHandler>>;

export interface CreateSmedcMcpToolHandlersOptions {
  bearerToken: string;
  audit: RequestAuditContext;
  delegationProof: string;
  maxUploadBytes: number;
  inject: ApiDelegationContext["inject"];
  uploadDelegate: UploadApiDelegate;
}

export function createSmedcMcpToolHandlers(
  options: CreateSmedcMcpToolHandlersOptions
): SmedcMcpToolHandlers {
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
  const actionHandlers = createActionMcpToolHandlers({
    bearerToken: options.bearerToken,
    audit: options.audit,
    delegationProof: options.delegationProof,
    inject: options.inject
  });

  return {
    ...readOnlyHandlers,
    ...actionHandlers,
    ...uploadHandlers
  };
}

export function createNoopToolHandler(toolName: SmedcMcpToolName): SmedcMcpToolHandler {
  return async (_input, context) =>
    errorToolResult("MCP_TOOL_NOT_IMPLEMENTED", "SMEDC MCP tool handler is not implemented yet.", {
      toolName,
      requestId: context.audit.requestId
    });
}
