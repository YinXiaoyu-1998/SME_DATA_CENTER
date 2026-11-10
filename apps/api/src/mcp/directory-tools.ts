import {
  DIRECTORY_MCP_INPUT_SCHEMAS,
  DIRECTORY_MCP_TOOL_NAMES,
  errorToolResult,
  validationErrorToolResult
} from "@smedc/mcp-contract";
import { launcherVersionAtLeast } from "../request-audit-context.js";
import { delegateJsonApiRequest, type ApiDelegationContext } from "./api-delegation.js";
import type { SmedcMcpToolHandlers, McpRequestContext } from "./tool-handlers.js";
export function createDirectoryMcpToolHandlers(
  context: ApiDelegationContext
): SmedcMcpToolHandlers {
  return Object.fromEntries(
    DIRECTORY_MCP_TOOL_NAMES.map((tool) => [
      tool,
      async (input: unknown, request: McpRequestContext) => {
        const audit = request.audit ?? context.audit;
        if (!launcherVersionAtLeast(audit.launcherVersion, "0.18.0"))
          return errorToolResult(
            "LAUNCHER_UPGRADE_REQUIRED",
            "Update the SMEDC launcher to use employee directory.",
            undefined,
            { requestId: audit.requestId }
          );
        const parsed = DIRECTORY_MCP_INPUT_SCHEMAS[tool].safeParse(input);
        if (!parsed.success)
          return validationErrorToolResult(
            parsed.error.issues.map((issue) => ({
              code: issue.code,
              path: issue.path.map((p) => (typeof p === "number" ? p : String(p))),
              message: issue.message
            }))
          );
        const { action, ...body } = parsed.data.request;
        return delegateJsonApiRequest(
          { ...context, audit, abortSignal: request.abortSignal ?? context.abortSignal },
          { method: "POST", path: `/v1/directory/${action}`, body }
        );
      }
    ])
  );
}
