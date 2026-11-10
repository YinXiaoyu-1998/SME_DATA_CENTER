import {
  WORKFLOW_MCP_INPUT_SCHEMAS,
  WORKFLOW_MCP_TOOL_NAMES,
  ENTERPRISE_WORKFLOW_LAUNCHER_VERSION,
  errorToolResult,
  validationErrorToolResult
} from "@smedc/mcp-contract";
import {
  delegateJsonApiRequest,
  type ApiDelegationContext,
  type DelegateJsonApiRequest
} from "./api-delegation.js";
import type { SmedcMcpToolHandlers, McpRequestContext } from "./tool-handlers.js";
import { launcherVersionAtLeast } from "../request-audit-context.js";
export function createWorkflowMcpToolHandlers(context: ApiDelegationContext): SmedcMcpToolHandlers {
  return Object.fromEntries(
    WORKFLOW_MCP_TOOL_NAMES.map((tool) => [
      tool,
      async (input: unknown, request: McpRequestContext) => {
        const audit = request.audit ?? context.audit;
        if (!launcherVersionAtLeast(audit.launcherVersion, ENTERPRISE_WORKFLOW_LAUNCHER_VERSION))
          return errorToolResult(
            "LAUNCHER_UPGRADE_REQUIRED",
            "Update the SMEDC launcher before using enterprise workflows.",
            undefined,
            { requestId: audit.requestId }
          );
        const parsed = WORKFLOW_MCP_INPUT_SCHEMAS[tool].safeParse(input);
        if (!parsed.success)
          return validationErrorToolResult(
            parsed.error.issues.map((issue) => ({
              code: issue.code,
              path: issue.path.map((p) => (typeof p === "number" ? p : String(p))),
              message: issue.message
            }))
          );
        const { data } = parsed;
        let route: DelegateJsonApiRequest;
        if ("query" in data) {
          const { mode, ...body } = data.query;
          route = {
            method: "POST",
            path:
              mode === "list"
                ? "/v1/admin/workflows/list_enterprise_workflows"
                : "/v1/admin/workflows/get_enterprise_workflow",
            body
          };
        } else {
          route = { method: "POST", path: `/v1/admin/workflows/${tool}`, body: data };
        }
        return delegateJsonApiRequest(
          { ...context, audit, abortSignal: request.abortSignal ?? context.abortSignal },
          route
        );
      }
    ])
  );
}
