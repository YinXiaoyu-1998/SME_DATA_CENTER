import {
  SMEDC_MCP_TOOL_CONTRACTS,
  COST_CARD_LAUNCHER_VERSION,
  errorToolResult,
  validationErrorToolResult,
  type PermissionMcpInputs,
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
  "upsert_store_reviews",
  "prepare_ledger_pdf_download",
  "update_account_permissions",
  "configure_business_category",
  "configure_business_dimension",
  "configure_business_dimension_value",
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
    case "upsert_store_reviews":
      return { method: "POST", path: "/v1/store-reviews/upsert", body: input };
    case "archive_cost_card":
      return {
        method: "POST",
        path: `/v1/cost-cards/${encodeURIComponent(String(input["costCardId"]))}/archive`
      };
    case "update_account_permissions":
      return {
        method: "PATCH",
        path: `/v1/admin/permissions/accounts/${encodeURIComponent(String(input["userAccountId"]))}`,
        body: Object.fromEntries(
          Object.entries(input).filter(([key]) => !["userAccountId"].includes(key))
        )
      };
    case "configure_business_category": {
      const { expectedVersion, operation } =
        input as PermissionMcpInputs["configure_business_category"];
      if (operation.kind === "create_evidence") {
        const { id, name, retired, ownerships, requiredDimensionIds } = operation;
        return {
          method: "POST",
          path: "/v1/admin/permissions/categories",
          body: { expectedVersion, id, name, retired, ownerships, requiredDimensionIds }
        };
      }
      const { categoryId, name, retired } = operation;
      const fields =
        operation.kind === "update_fixed"
          ? { confidentialityLevel: operation.confidentialityLevel }
          : {
              ownerships: operation.ownerships,
              requiredDimensionIds: operation.requiredDimensionIds
            };
      return {
        method: "PATCH",
        path: `/v1/admin/permissions/categories/${encodeURIComponent(categoryId)}`,
        body: { expectedVersion, name, retired, ...fields }
      };
    }
    case "configure_business_dimension": {
      const { expectedVersion, operation } =
        input as PermissionMcpInputs["configure_business_dimension"];
      const { kind, dimensionId, ...body } = operation;
      const base = "/v1/admin/permissions/dimensions";
      return kind === "create"
        ? { method: "POST", path: base, body: { expectedVersion, id: dimensionId, ...body } }
        : {
            method: "PATCH",
            path: `${base}/${encodeURIComponent(dimensionId)}`,
            body: { expectedVersion, ...body }
          };
    }
    case "configure_business_dimension_value": {
      const { expectedVersion, operation } =
        input as PermissionMcpInputs["configure_business_dimension_value"];
      const { kind, dimensionId, valueId, ...body } = operation;
      const base = `/v1/admin/permissions/dimensions/${encodeURIComponent(dimensionId)}/values`;
      return kind === "create"
        ? { method: "POST", path: base, body: { expectedVersion, id: valueId, ...body } }
        : {
            method: "PATCH",
            path: `${base}/${encodeURIComponent(valueId)}`,
            body: { expectedVersion, ...body }
          };
    }
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
