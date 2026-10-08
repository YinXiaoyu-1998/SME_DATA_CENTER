import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { LauncherRuntimeConfig } from "./config.js";
import { createLauncherToolDependencies, registerLauncherTools } from "./launcher.js";
import { cleanupDefaultStaleExtractDirectories } from "./partition-transfer.js";

export const MCP_LAUNCHER_SERVER_NAME = "smedc-mcp-launcher";
export const MCP_LAUNCHER_SERVER_VERSION = "0.8.2";

export function createSmedcMcpLauncherServer(config: LauncherRuntimeConfig): McpServer {
  const server = new McpServer({
    name: MCP_LAUNCHER_SERVER_NAME,
    version: MCP_LAUNCHER_SERVER_VERSION
  });

  registerLauncherTools(server, createLauncherToolDependencies({ config }));

  return server;
}

export async function runMcpLauncherStdioServer(config: LauncherRuntimeConfig): Promise<void> {
  await cleanupDefaultStaleExtractDirectories();
  const server = createSmedcMcpLauncherServer(config);
  await server.connect(new StdioServerTransport());
}
