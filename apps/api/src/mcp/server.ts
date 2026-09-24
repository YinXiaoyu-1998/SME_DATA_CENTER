import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  CallToolRequestSchema,
  ErrorCode,
  McpError,
  type CallToolRequest
} from "@modelcontextprotocol/sdk/types.js";
import { SMEDC_MCP_TOOL_CONTRACTS, type SmedcMcpToolName } from "@smedc/mcp-contract";
import type { McpRequestContext, SmedcMcpToolHandlers } from "./tool-handlers.js";
import { createNoopToolHandler } from "./tool-handlers.js";

export const MCP_SERVER_NAME = "smedc-api-mcp";
export const MCP_SERVER_VERSION = "0.1.0";

export function createSmedcHttpMcpServer(input: {
  context: McpRequestContext;
  handlers?: SmedcMcpToolHandlers;
}): McpServer {
  const server = new McpServer({
    name: MCP_SERVER_NAME,
    version: MCP_SERVER_VERSION
  });

  const setRequestHandler = server.server.setRequestHandler;
  // The SDK normally validates arguments before invoking a tool. Capture its
  // public registration boundary so upload handlers can authorize first, while
  // discovery and every non-upload request retain the SDK's own handlers.
  server.server.setRequestHandler = (schema, handler) => {
    if (!Object.is(schema, CallToolRequestSchema)) {
      setRequestHandler.call(server.server, schema, handler);
      return;
    }
    setRequestHandler.call(server.server, schema, async (request, extra) => {
      const { params } = request as CallToolRequest;
      if (
        params.name === "upload_evidence_document" ||
        params.name === "upload_quarantine_certificate" ||
        params.name === "upload_structured_dataset"
      ) {
        const upload = input.handlers?.[params.name];
        if (upload) {
          try {
            return await upload(params.arguments, { ...input.context, abortSignal: extra.signal });
          } catch (error) {
            // Match the SDK tools/call wrapper after authorization-first dispatch.
            if (error instanceof McpError && error.code === ErrorCode.UrlElicitationRequired) {
              throw error;
            }
            return {
              content: [
                { type: "text", text: error instanceof Error ? error.message : String(error) }
              ],
              isError: true
            };
          }
        }
      }
      return handler(request, extra);
    });
  };

  try {
    for (const tool of SMEDC_MCP_TOOL_CONTRACTS) {
      const toolName = tool.name as SmedcMcpToolName;
      const handler = input.handlers?.[toolName] ?? createNoopToolHandler(toolName);

      server.registerTool(
        tool.name,
        {
          title: tool.title,
          description: tool.description,
          inputSchema: tool.inputSchema
        },
        async (toolInput, extra) =>
          handler(toolInput, {
            ...input.context,
            abortSignal: extra.signal
          })
      );
    }
  } finally {
    server.server.setRequestHandler = setRequestHandler;
  }

  return server;
}
