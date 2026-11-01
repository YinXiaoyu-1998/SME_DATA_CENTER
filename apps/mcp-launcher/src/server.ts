import { STORE_REVIEW_LIMITS } from "@smedc/domain";
import type { Readable, Writable } from "node:stream";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { LauncherRuntimeConfig } from "./config.js";
import { createLauncherToolDependencies, registerLauncherTools } from "./launcher.js";
import { cleanupDefaultStaleExtractDirectories } from "./partition-transfer.js";

export const MCP_LAUNCHER_SERVER_NAME = "smedc-mcp-launcher";
export const MCP_LAUNCHER_SERVER_VERSION = "0.15.0";

export function createSmedcMcpLauncherServer(config: LauncherRuntimeConfig): McpServer {
  const server = new McpServer({
    name: MCP_LAUNCHER_SERVER_NAME,
    version: MCP_LAUNCHER_SERVER_VERSION
  });

  registerLauncherTools(server, createLauncherToolDependencies({ config }));

  return server;
}

export function createLauncherStdioTransport(stdin?: Readable, stdout?: Writable) {
  // The SDK default is 10 MiB; a valid review batch may be 16 MiB before its envelope.
  return new StdioServerTransport(stdin, stdout, {
    maxBufferSize: STORE_REVIEW_LIMITS.batchBytes + 64 * 1024
  });
}

export async function runMcpLauncherStdioServer(config: LauncherRuntimeConfig): Promise<void> {
  await cleanupDefaultStaleExtractDirectories();
  const server = createSmedcMcpLauncherServer(config);
  await server.connect(createLauncherStdioTransport());
}
