import {
  SMEDC_MCP_TOOL_CONTRACTS,
  validationErrorToolResult,
  type SmedcMcpToolContract,
  type SmedcMcpToolName
} from "@smedc/mcp-contract";
import {
  delegateJsonApiRequest,
  type ApiDelegationContext,
  type DelegateJsonApiRequest
} from "./api-delegation.js";
import type { SmedcMcpToolHandlers, McpRequestContext } from "./tool-handlers.js";

export const ACTION_MCP_TOOL_NAMES = [
  "archive_quarantine_certificates"
] as const satisfies readonly SmedcMcpToolName[];

type ActionMcpToolName = (typeof ACTION_MCP_TOOL_NAMES)[number];

const ACTION_TOOL_CONTRACTS = Object.fromEntries(
  SMEDC_MCP_TOOL_CONTRACTS.filter((contract) =>
    ACTION_MCP_TOOL_NAMES.includes(contract.name as ActionMcpToolName)
  ).map((contract) => [contract.name, contract])
) as Record<ActionMcpToolName, SmedcMcpToolContract>;

export function createActionMcpToolHandlers(
  context: ApiDelegationContext
): SmedcMcpToolHandlers {
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
  ) as SmedcMcpToolHandlers;
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
