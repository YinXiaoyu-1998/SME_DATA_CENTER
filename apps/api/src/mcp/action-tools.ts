import {
  SMEDC_MCP_TOOL_CONTRACTS,
  COST_CARD_LAUNCHER_VERSION,
  errorToolResult,
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
import { launcherVersionAtLeast } from "../request-audit-context.js";

export const ACTION_MCP_TOOL_NAMES = [
  "archive_quarantine_certificates",
  "archive_cost_card",
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
] as const satisfies readonly SmedcMcpToolName[];

type ActionMcpToolName = (typeof ACTION_MCP_TOOL_NAMES)[number];

const ACTION_TOOL_CONTRACTS = Object.fromEntries(
  SMEDC_MCP_TOOL_CONTRACTS.filter((contract) =>
    ACTION_MCP_TOOL_NAMES.includes(contract.name as ActionMcpToolName)
  ).map((contract) => [contract.name, contract])
) as Record<ActionMcpToolName, SmedcMcpToolContract>;

export function createActionMcpToolHandlers(context: ApiDelegationContext): SmedcMcpToolHandlers {
  return Object.fromEntries(
    ACTION_MCP_TOOL_NAMES.map((toolName) => [
      toolName,
      async (input: unknown, mcpContext: McpRequestContext) => {
        if (
          toolName === "archive_cost_card" &&
          !launcherVersionAtLeast(
            mcpContext.audit?.launcherVersion ?? context.audit.launcherVersion,
            COST_CARD_LAUNCHER_VERSION
          )
        )
          return errorToolResult(
            "LAUNCHER_UPGRADE_REQUIRED",
            "Update the SMEDC launcher before using cost cards.",
            undefined,
            { requestId: mcpContext.audit?.requestId ?? context.audit.requestId }
          );
        const parsed = ACTION_TOOL_CONTRACTS[toolName].inputSchema.safeParse(input);

        if (!parsed.success) {
          return validationErrorToolResult(parsed.error.issues.map(safeValidationIssue));
        }

        return delegateJsonApiRequest(
          {
            ...context,
            audit: mcpContext.audit ?? context.audit,
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
    case "archive_cost_card":
      return {
        method: "POST",
        path: `/v1/cost-cards/${encodeURIComponent(String(input["costCardId"]))}/archive`
      };
    case "update_account_permissions":
      return {
        method: "PATCH",
        path: `/v1/admin/permissions/accounts/${encodeURIComponent(String(input["employeeId"]))}`,
        body: Object.fromEntries(
          Object.entries(input).filter(([key]) => !["employeeId"].includes(key))
        )
      };
    case "create_evidence_category":
      return {
        method: "POST",
        path: `/v1/admin/permissions/categories`,
        body: input
      };
    case "update_business_category":
      return {
        method: "PATCH",
        path: `/v1/admin/permissions/categories/${encodeURIComponent(String(input["categoryId"]))}`,
        body: Object.fromEntries(
          Object.entries(input).filter(([key]) => !["categoryId"].includes(key))
        )
      };
    case "create_business_dimension":
      return {
        method: "POST",
        path: `/v1/admin/permissions/dimensions`,
        body: input
      };
    case "update_business_dimension":
      return {
        method: "PATCH",
        path: `/v1/admin/permissions/dimensions/${encodeURIComponent(String(input["dimensionId"]))}`,
        body: Object.fromEntries(
          Object.entries(input).filter(([key]) => !["dimensionId"].includes(key))
        )
      };
    case "create_business_dimension_value":
      return {
        method: "POST",
        path: `/v1/admin/permissions/dimensions/${encodeURIComponent(String(input["dimensionId"]))}/values`,
        body: Object.fromEntries(
          Object.entries(input).filter(([key]) => !["dimensionId"].includes(key))
        )
      };
    case "update_business_dimension_value":
      return {
        method: "PATCH",
        path: `/v1/admin/permissions/dimensions/${encodeURIComponent(String(input["dimensionId"]))}/values/${encodeURIComponent(String(input["valueId"]))}`,
        body: Object.fromEntries(
          Object.entries(input).filter(([key]) => !["dimensionId", "valueId"].includes(key))
        )
      };
    case "update_business_store":
      return {
        method: "POST",
        path: `/v1/admin/permissions/stores`,
        body: input
      };
    case "update_evidence_document_attributes":
      return {
        method: "PATCH",
        path: `/v1/admin/permissions/documents/${encodeURIComponent(String(input["documentId"]))}`,
        body: Object.fromEntries(
          Object.entries(input).filter(([key]) => !["documentId"].includes(key))
        )
      };
    case "activate_authorization_cutover":
      return {
        method: "POST",
        path: `/v1/admin/permissions/cutover/activate`,
        body: input
      };
    case "suspend_authorization_reads":
      return {
        method: "POST",
        path: `/v1/admin/permissions/cutover/suspend`,
        body: input
      };
    case "prepare_ledger_pdf_download":
      return { method: "POST", path: "/v1/ledger-pdfs/downloads", body: input };
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
