import path from "node:path";

export const DEFAULT_MCP_PROFILE = "local-development";
export const DEFAULT_MCP_SESSION_FILE = ".data/enterprise-hub-mcp/session.json";

export interface McpRuntimeConfig {
  apiUrl: string;
  profile: typeof DEFAULT_MCP_PROFILE;
  sessionFile: string;
  transport: "stdio";
}

export function loadMcpRuntimeConfig(
  env: NodeJS.ProcessEnv = process.env,
  cwd = process.cwd()
): McpRuntimeConfig {
  const profile = env["ENTERPRISE_HUB_MCP_PROFILE"] ?? DEFAULT_MCP_PROFILE;

  if (profile !== DEFAULT_MCP_PROFILE) {
    throw new Error(
      `ENTERPRISE_HUB_MCP_PROFILE must be ${DEFAULT_MCP_PROFILE} for Phase 2 local MCP.`
    );
  }

  const rawApiUrl = env["ENTERPRISE_HUB_API_URL"];

  if (!rawApiUrl) {
    throw new Error("ENTERPRISE_HUB_API_URL is required for local MCP startup.");
  }

  return {
    apiUrl: normalizeHttpUrl(rawApiUrl),
    profile,
    sessionFile: path.resolve(
      cwd,
      env["ENTERPRISE_HUB_MCP_SESSION_FILE"] ?? DEFAULT_MCP_SESSION_FILE
    ),
    transport: "stdio"
  };
}

function normalizeHttpUrl(value: string): string {
  let url: URL;

  try {
    url = new URL(value);
  } catch {
    throw new Error("ENTERPRISE_HUB_API_URL must be an http(s) URL.");
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("ENTERPRISE_HUB_API_URL must be an http(s) URL.");
  }

  return url.toString().replace(/\/+$/, "");
}
