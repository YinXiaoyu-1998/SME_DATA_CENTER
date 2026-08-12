import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { LauncherRuntimeConfig } from "./config.js";
import { createLauncherToolDependencies, registerLauncherTools } from "./launcher.js";

export const MCP_LAUNCHER_SERVER_NAME = "enterprise-hub-mcp-launcher";
export const MCP_LAUNCHER_SERVER_VERSION = "0.2.2";

export function createEnterpriseHubMcpLauncherServer(config: LauncherRuntimeConfig): McpServer {
  const server = new McpServer({
    name: MCP_LAUNCHER_SERVER_NAME,
    version: MCP_LAUNCHER_SERVER_VERSION
  });

  registerLauncherTools(server, createLauncherToolDependencies({ config }));

  return server;
}

export async function runMcpLauncherStdioServer(config: LauncherRuntimeConfig): Promise<void> {
  const server = createEnterpriseHubMcpLauncherServer(config);
  await server.connect(new StdioServerTransport());
}
