import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  SMEDC_MCP_TOOL_CONTRACTS,
  type SmedcMcpToolName
} from "@smedc/mcp-contract";
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

  return server;
}
