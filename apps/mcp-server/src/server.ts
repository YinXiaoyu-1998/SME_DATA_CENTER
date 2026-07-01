import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { McpRuntimeConfig } from "./config.js";
import { createEnterpriseHubApiClient } from "./api-client.js";
import { MCP_TOOL_CONTRACTS, plannedToolResult } from "./tools.js";

export const MCP_SERVER_NAME = "enterprise-hub-mcp";
export const MCP_SERVER_VERSION = "0.1.0";

export function createEnterpriseHubMcpServer(config: McpRuntimeConfig): McpServer {
  createEnterpriseHubApiClient(config);

  const server = new McpServer({
    name: MCP_SERVER_NAME,
    version: MCP_SERVER_VERSION
  });

  for (const tool of MCP_TOOL_CONTRACTS) {
    server.registerTool(
      tool.name,
      {
        title: tool.title,
        description: tool.description,
        inputSchema: tool.inputSchema
      },
      async () => plannedToolResult(tool.name)
    );
  }

  return server;
}

export async function runMcpStdioServer(config: McpRuntimeConfig): Promise<void> {
  const server = createEnterpriseHubMcpServer(config);
  await server.connect(new StdioServerTransport());
}
