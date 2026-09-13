import {
  ENTERPRISE_HUB_MCP_TOOL_CONTRACTS,
  validationErrorToolResult,
  type EnterpriseHubMcpToolContract,
  type EnterpriseHubMcpToolName
} from "@enterprise-hub/mcp-contract";
import type { EnterpriseHubMcpToolHandlers } from "./tool-handlers.js";
import {
  delegateJsonApiRequest,
  type ApiDelegationContext,
  type DelegateJsonApiRequest
} from "./api-delegation.js";
import type { McpRequestContext } from "./tool-handlers.js";

export const READ_ONLY_MCP_TOOL_NAMES = [
  "enterprise_hub_get_current_user",
  "enterprise_hub_list_skills",
  "search_document_evidence",
  "list_structured_datasets",
  "query_structured_dataset",
  "describe_structured_dataset_coverage",
  "query_quarantine_certificates",
  "get_source_document_download_url",
  "get_evidence_document_status",
  "get_import_status"
] as const satisfies readonly EnterpriseHubMcpToolName[];

type ReadOnlyMcpToolName = (typeof READ_ONLY_MCP_TOOL_NAMES)[number];

const READ_ONLY_TOOL_CONTRACTS = Object.fromEntries(
  ENTERPRISE_HUB_MCP_TOOL_CONTRACTS.filter((contract) =>
    READ_ONLY_MCP_TOOL_NAMES.includes(contract.name as ReadOnlyMcpToolName)
  ).map((contract) => [contract.name, contract])
) as Record<ReadOnlyMcpToolName, EnterpriseHubMcpToolContract>;

export function createReadOnlyMcpToolHandlers(
  context: ApiDelegationContext
): EnterpriseHubMcpToolHandlers {
  return Object.fromEntries(
    READ_ONLY_MCP_TOOL_NAMES.map((toolName) => [
      toolName,
      async (input: unknown, mcpContext: McpRequestContext) => {
        const parsed = READ_ONLY_TOOL_CONTRACTS[toolName].inputSchema.safeParse(input);

        if (!parsed.success) {
          return validationErrorToolResult(parsed.error.issues.map(safeValidationIssue));
        }

        return delegateJsonApiRequest(
          {
            ...context,
            abortSignal: mcpContext.abortSignal ?? context.abortSignal
          },
          routeForReadOnlyTool(toolName, parsed.data)
        );
      }
    ])
  ) as EnterpriseHubMcpToolHandlers;
}

function routeForReadOnlyTool(
  toolName: ReadOnlyMcpToolName,
  input: Record<string, unknown>
): DelegateJsonApiRequest {
  switch (toolName) {
    case "enterprise_hub_get_current_user":
      return {
        method: "GET",
        path: "/me",
        mapSuccess: currentUserFromMe
      };
    case "enterprise_hub_list_skills":
      return {
        method: "GET",
        path: "/skills",
        query: {
          q: optionalString(input["q"]),
          category: optionalString(input["category"])
        }
      };
    case "search_document_evidence":
      return {
        method: "POST",
        path: "/v1/evidence/search",
        body: {
          query: input["query"],
          filters: input["filters"],
          limit: input["limit"],
          cursor: input["cursor"]
        }
      };
    case "list_structured_datasets":
      return {
        method: "GET",
        path: "/v1/structured/datasets"
      };
    case "query_structured_dataset":
      return {
        method: "POST",
        path: "/v1/structured/query",
        body: {
          dataset: input["dataset"],
          select: input["select"],
          filter: input["filter"],
          sort: input["sort"],
          page: input["page"],
          groupBy: input["groupBy"],
          aggregates: input["aggregates"]
        }
      };
    case "describe_structured_dataset_coverage":
      return {
        method: "GET",
        path: `/v1/structured/datasets/${encodeURIComponent(String(input["dataset"]))}/coverage`
      };
    case "query_quarantine_certificates":
      return {
        method: "POST",
        path: "/v1/quarantine-certificates/query",
        body: {
          receiptIds: input["receiptIds"]
        }
      };
    case "get_source_document_download_url":
      return {
        method: "POST",
        path: `/v1/source-documents/${encodeURIComponent(String(input["sourceDocumentId"]))}/download-url`
      };
    case "get_evidence_document_status":
      return {
        method: "GET",
        path: `/v1/documents/evidence/${encodeURIComponent(String(input["documentId"]))}/status`
      };
    case "get_import_status":
      return {
        method: "GET",
        path: `/v1/structured/imports/${encodeURIComponent(String(input["importBatchId"]))}`
      };
  }
}

function currentUserFromMe(value: unknown): unknown {
  if (typeof value !== "object" || value === null || !("employee" in value)) {
    throw new Error("Invalid current-user response.");
  }

  const employee = value.employee;
  if (
    typeof employee !== "object" ||
    employee === null ||
    !("displayName" in employee) ||
    typeof employee.displayName !== "string" ||
    !("email" in employee) ||
    typeof employee.email !== "string" ||
    !("role" in employee) ||
    !["admin", "employee"].includes(String(employee.role)) ||
    !("clearance" in employee) ||
    typeof employee.clearance !== "number"
  ) {
    throw new Error("Invalid current-user response.");
  }

  return {
    user: {
      displayName: employee.displayName,
      email: employee.email,
      role: employee.role,
      clearance: employee.clearance
    }
  };
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
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
