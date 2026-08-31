import {
  ENTERPRISE_HUB_MCP_TOOL_CONTRACTS,
  validationErrorToolResult,
  type EnterpriseHubMcpToolContract,
  type EnterpriseHubMcpToolName
} from "@enterprise-hub/mcp-contract";
import {
  delegateJsonApiRequest,
  type ApiDelegationContext,
  type DelegateJsonApiRequest
} from "./api-delegation.js";
import type { EnterpriseHubMcpToolHandlers, McpRequestContext } from "./tool-handlers.js";

export const ACTION_MCP_TOOL_NAMES = [
  "archive_quarantine_certificates"
] as const satisfies readonly EnterpriseHubMcpToolName[];

type ActionMcpToolName = (typeof ACTION_MCP_TOOL_NAMES)[number];

const ACTION_TOOL_CONTRACTS = Object.fromEntries(
  ENTERPRISE_HUB_MCP_TOOL_CONTRACTS.filter((contract) =>
    ACTION_MCP_TOOL_NAMES.includes(contract.name as ActionMcpToolName)
  ).map((contract) => [contract.name, contract])
) as Record<ActionMcpToolName, EnterpriseHubMcpToolContract>;

export function createActionMcpToolHandlers(
  context: ApiDelegationContext
): EnterpriseHubMcpToolHandlers {
  return Object.fromEntries(
    ACTION_MCP_TOOL_NAMES.map((toolName) => [
      toolName,
      async (input: unknown, mcpContext: McpRequestContext) => {
        const parsed = ACTION_TOOL_CONTRACTS[toolName].inputSchema.safeParse(input);

        if (!parsed.success) {
          return validationErrorToolResult(parsed.error.issues.map(safeValidationIssue));
        }

        return delegateJsonApiRequest(
          {
            ...context,
            abortSignal: mcpContext.abortSignal ?? context.abortSignal
          },
          routeForActionTool(toolName, parsed.data)
        );
      }
    ])
  ) as EnterpriseHubMcpToolHandlers;
}

function routeForActionTool(
  toolName: ActionMcpToolName,
  input: Record<string, unknown>
): DelegateJsonApiRequest {
  switch (toolName) {
    case "archive_quarantine_certificates":
      return {
        method: "POST",
        path: "/v1/quarantine-certificates/archive",
        body: {
          sourceDocumentId: input["sourceDocumentId"],
          receiptId: input["receiptId"]
        }
      };
  }
}

function safeValidationIssue(issue: { code: string; path: PropertyKey[]; message: string }): {
  code: string;
  path: Array<string | number>;
  message: string;
} {
  return {
    code: issue.code,
    path: issue.path.map((pathPart) =>
      typeof pathPart === "number" ? pathPart : String(pathPart)
    ),
    message: issue.message
  };
}
