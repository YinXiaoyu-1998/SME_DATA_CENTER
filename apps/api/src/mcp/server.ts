import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  ENTERPRISE_HUB_MCP_TOOL_CONTRACTS,
  type EnterpriseHubMcpToolName
} from "@enterprise-hub/mcp-contract";
import type { McpRequestContext, EnterpriseHubMcpToolHandlers } from "./tool-handlers.js";
import { createNoopToolHandler } from "./tool-handlers.js";

export const MCP_SERVER_NAME = "enterprise-hub-api-mcp";
export const MCP_SERVER_VERSION = "0.1.0";

export function createEnterpriseHubHttpMcpServer(input: {
  context: McpRequestContext;
  handlers?: EnterpriseHubMcpToolHandlers;
}): McpServer {
  const server = new McpServer({
    name: MCP_SERVER_NAME,
    version: MCP_SERVER_VERSION
  });

  for (const tool of ENTERPRISE_HUB_MCP_TOOL_CONTRACTS) {
    const toolName = tool.name as EnterpriseHubMcpToolName;
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
