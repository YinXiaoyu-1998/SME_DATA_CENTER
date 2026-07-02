import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { McpRuntimeConfig } from "./config.js";
import { createEnterpriseHubApiClient, type EnterpriseHubApiClient } from "./api-client.js";
import { loginDevTool } from "./auth.js";
import { LocalMcpSessionStore, McpSessionRequiredError } from "./session-store.js";
import {
  MCP_TOOL_CONTRACTS,
  plannedToolResult,
  sessionRequiredToolResult,
  type McpJsonToolResult
} from "./tools.js";

export const MCP_SERVER_NAME = "enterprise-hub-mcp";
export const MCP_SERVER_VERSION = "0.1.0";

export interface McpToolDependencies {
  apiClient: EnterpriseHubApiClient;
  config: McpRuntimeConfig;
  sessionStore: LocalMcpSessionStore;
}

export function createEnterpriseHubMcpServer(config: McpRuntimeConfig): McpServer {
  const dependencies: McpToolDependencies = {
    apiClient: createEnterpriseHubApiClient(config),
    config,
    sessionStore: new LocalMcpSessionStore(config.sessionFile)
  };

  const server = new McpServer({
    name: MCP_SERVER_NAME,
    version: MCP_SERVER_VERSION
  });

  for (const tool of MCP_TOOL_CONTRACTS) {
    const handler = createToolHandler(tool.name, dependencies);

    server.registerTool(
      tool.name,
      {
        title: tool.title,
        description: tool.description,
        inputSchema: tool.inputSchema
      },
      handler
    );
  }

  return server;
}

export function createToolHandler(
  toolName: string,
  dependencies: McpToolDependencies
): (input: unknown) => Promise<McpJsonToolResult> {
  if (toolName === "enterprise_hub_login_dev") {
    return async (input: unknown) => loginDevTool(input, dependencies);
  }

  return async (input: unknown) => {
    try {
      await dependencies.sessionStore.requireSession(getSessionName(input));
    } catch (error) {
      if (error instanceof McpSessionRequiredError) {
        return sessionRequiredToolResult();
      }

      throw error;
    }

    return plannedToolResult(toolName);
  };
}

function getSessionName(input: unknown): string | undefined {
  if (typeof input !== "object" || input === null || !("sessionName" in input)) {
    return undefined;
  }

  const sessionName = (input as { sessionName?: unknown }).sessionName;

  return typeof sessionName === "string" ? sessionName : undefined;
}

export async function runMcpStdioServer(config: McpRuntimeConfig): Promise<void> {
  const server = createEnterpriseHubMcpServer(config);
  await server.connect(new StdioServerTransport());
}
