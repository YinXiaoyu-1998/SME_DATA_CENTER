import type { FastifyInstance } from "fastify";
import { WORKFLOW_MCP_INPUT_SCHEMAS, WORKFLOW_MCP_TOOL_NAMES } from "@smedc/mcp-contract";
import type { RequestAuth } from "../request-auth.js";
import { errorResponse } from "../request-errors.js";
import type { EnterpriseWorkflowService } from "./service.js";
export function registerEnterpriseWorkflowRoutes(
  app: FastifyInstance,
  dependencies: {
    auth: Pick<RequestAuth, "authenticate" | "employee">;
    workflows: () => EnterpriseWorkflowService;
    basePath?: string;
  }
) {
  for (const tool of WORKFLOW_MCP_TOOL_NAMES)
    app.post(
      `${dependencies.basePath ?? "/v1/admin/workflows"}/${tool}`,
      { bodyLimit: 1_100_000 },
      async (request, reply) => {
        if (!(await dependencies.auth.authenticate(request, reply))) return;
        const parsed = WORKFLOW_MCP_INPUT_SCHEMAS[tool].safeParse(request.body);
        if (!parsed.success)
          return reply
            .code(400)
            .send(errorResponse("INVALID_WORKFLOW_INPUT", "Workflow request is invalid."));
        try {
          return await dependencies
            .workflows()
            .execute(tool, parsed.data, dependencies.auth.employee(request));
        } catch (error) {
          const code = error instanceof Error ? error.message : "";
          if (code.startsWith("WORKFLOW_"))
            return reply
              .code(
                /ADMIN_REQUIRED|PERMISSION_DENIED/.test(code)
                  ? 403
                  : /CONFIGURATION_REQUIRED/.test(code)
                    ? 404
                    : 409
              )
              .send(
                errorResponse(
                  code,
                  "Workflow operation is unavailable. Reload its configuration and status."
                )
              );
          if (
            typeof error === "object" &&
            error &&
            "code" in error &&
            ["P2002", "P2034"].includes(String(error.code))
          )
            return reply
              .code(409)
              .send(
                errorResponse(
                  "WORKFLOW_VERSION_CONFLICT",
                  "Workflow state changed. Reload and retry."
                )
              );
          throw error;
        }
      }
    );
}
