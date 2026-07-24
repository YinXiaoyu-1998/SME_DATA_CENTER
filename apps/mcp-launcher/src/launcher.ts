import open from "open";
import { randomBytes } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { z } from "zod";
import {
  ENTERPRISE_HUB_MCP_TOOL_CONTRACTS,
  ENTERPRISE_HUB_MCP_TOOL_NAMES,
  errorToolResult,
  jsonToolResult,
  toolNotFoundResult,
  validationErrorToolResult,
  type EnterpriseHubMcpToolName,
  type McpJsonToolResult
} from "@enterprise-hub/mcp-contract";
import {
  createAuthorizationRequest,
  createLoopbackCallbackServer,
  waitForAuthorizationCode
} from "./auth.js";
import type { LauncherRuntimeConfig } from "./config.js";
import { EnterpriseHubOAuthClient } from "./oauth-client.js";
import { createCrossProcessLock, createKeychainCredentialStore } from "./runtime.js";
import { LauncherSession, LauncherTypedError } from "./session.js";

export const LAUNCHER_BOOTSTRAP_TOOL_NAMES = [
  "enterprise_hub_login",
  "enterprise_hub_logout",
  "enterprise_hub_auth_status"
] as const;
export type LauncherBootstrapToolName = (typeof LAUNCHER_BOOTSTRAP_TOOL_NAMES)[number];
export type LauncherToolName = LauncherBootstrapToolName | EnterpriseHubMcpToolName;

export interface LauncherAuthentication {
  login(): Promise<void>;
  logout(): Promise<void>;
  status(): Promise<{ authenticated: boolean }>;
  accessToken(): Promise<string>;
}

export interface LauncherToolDependencies {
  config: LauncherRuntimeConfig;
  auth: LauncherAuthentication;
  fetchImplementation: typeof fetch;
}

export interface LauncherToolRegistrar {
  registerTool(
    name: string,
    options: { title: string; description: string; inputSchema: z.ZodRawShape },
    handler: (input: unknown) => Promise<McpJsonToolResult>
  ): void;
}

const emptyInputSchema = z.object({}).strict();
const bootstrapTools = [
  {
    name: "enterprise_hub_login",
    title: "Enterprise Hub sign in",
    description: "Open the system browser for Enterprise Hub sign-in.",
    inputShape: emptyInputSchema.shape
  },
  {
    name: "enterprise_hub_logout",
    title: "Enterprise Hub sign out",
    description: "Revoke and remove the local Enterprise Hub session.",
    inputShape: emptyInputSchema.shape
  },
  {
    name: "enterprise_hub_auth_status",
    title: "Enterprise Hub authentication status",
    description: "Check whether a local Enterprise Hub session is available.",
    inputShape: emptyInputSchema.shape
  }
] as const;

export function createLauncherToolDependencies(input: {
  config: LauncherRuntimeConfig;
  auth?: LauncherAuthentication;
  fetchImplementation?: typeof fetch;
}): LauncherToolDependencies {
  return {
    config: input.config,
    auth: input.auth ?? createOfficialLauncherAuthentication(input.config),
    fetchImplementation: input.fetchImplementation ?? fetch
  };
}

export function registerLauncherTools(
  registrar: LauncherToolRegistrar,
  dependencies: LauncherToolDependencies
): void {
  for (const tool of bootstrapTools)
    registrar.registerTool(
      tool.name,
      { title: tool.title, description: tool.description, inputSchema: tool.inputShape },
      createLauncherToolHandler(tool.name, dependencies)
    );
  for (const tool of ENTERPRISE_HUB_MCP_TOOL_CONTRACTS)
    registrar.registerTool(
      tool.name,
      { title: tool.title, description: tool.description, inputSchema: tool.inputShape },
      createLauncherToolHandler(tool.name, dependencies)
    );
}

export function createLauncherToolHandler(
  toolName: string,
  dependencies: LauncherToolDependencies
): (input: unknown) => Promise<McpJsonToolResult> {
  if (toolName === "enterprise_hub_login") return (input) => login(input, dependencies);
  if (toolName === "enterprise_hub_logout") return (input) => logout(input, dependencies);
  if (toolName === "enterprise_hub_auth_status") return (input) => status(input, dependencies);
  if ((ENTERPRISE_HUB_MCP_TOOL_NAMES as readonly string[]).includes(toolName))
    return (input) => proxy(toolName as EnterpriseHubMcpToolName, input, dependencies);
  return async () => toolNotFoundResult(toolName);
}

export function createOfficialLauncherAuthentication(
  config: LauncherRuntimeConfig
): LauncherAuthentication {
  const origin = config.serviceUrl;
  const oauth = new EnterpriseHubOAuthClient(new URL(origin));
  const session = new LauncherSession({
    origin,
    secureStore: createKeychainCredentialStore(origin),
    tokenClient: oauth,
    lock: createCrossProcessLock(origin)
  });
  return {
    login: async () => {
      const metadata = await oauth.metadata().catch(() => {
        throw new LauncherTypedError("SERVICE_UNAVAILABLE");
      });
      assertCompatible(metadata.minimumVersion, metadata.recommendedVersion);
      const state = randomBytes(32).toString("base64url");
      const callback = await createLoopbackCallbackServer({ state });
      try {
        const request = await createAuthorizationRequest({
          authorizationEndpoint: metadata.authorizationEndpoint,
          redirectUri: callback.redirectUri,
          state
        });
        await open(request.url.toString());
        const code = await waitForAuthorizationCode(callback);
        const tokens = await oauth.exchange(code, callback.redirectUri, request.verifier);
        await session.establish(tokens.accessToken, tokens.refreshToken);
      } finally {
        await callback.close();
      }
    },
    logout: () => session.logout(),
    status: () => session.status(),
    accessToken: () => session.ensureAccessToken()
  };
}

async function login(
  input: unknown,
  dependencies: LauncherToolDependencies
): Promise<McpJsonToolResult> {
  const parsed = emptyInputSchema.safeParse(input);
  if (!parsed.success) return validationErrorToolResult(parsed.error.issues);
  try {
    await dependencies.auth.login();
    return jsonToolResult({ authenticated: true, serviceUrl: dependencies.config.serviceUrl });
  } catch (error) {
    return typedToolError(error);
  }
}
async function logout(
  input: unknown,
  dependencies: LauncherToolDependencies
): Promise<McpJsonToolResult> {
  const parsed = emptyInputSchema.safeParse(input);
  if (!parsed.success) return validationErrorToolResult(parsed.error.issues);
  try {
    await dependencies.auth.logout();
    return jsonToolResult({ success: true });
  } catch (error) {
    return typedToolError(error);
  }
}
async function status(
  input: unknown,
  dependencies: LauncherToolDependencies
): Promise<McpJsonToolResult> {
  const parsed = emptyInputSchema.safeParse(input);
  if (!parsed.success) return validationErrorToolResult(parsed.error.issues);
  try {
    return jsonToolResult({
      ...(await dependencies.auth.status()),
      serviceUrl: dependencies.config.serviceUrl
    });
  } catch (error) {
    return typedToolError(error);
  }
}

async function proxy(
  toolName: EnterpriseHubMcpToolName,
  input: unknown,
  dependencies: LauncherToolDependencies
): Promise<McpJsonToolResult> {
  try {
    const accessToken = await dependencies.auth.accessToken();
    const client = new Client({ name: "enterprise-hub-mcp-launcher", version: "0.1.0" });
    const transport = new StreamableHTTPClientTransport(
      new URL("mcp", `${dependencies.config.serviceUrl}/`),
      {
        fetch: dependencies.fetchImplementation,
        requestInit: {
          headers: {
            authorization: `Bearer ${accessToken}`,
            "x-enterprise-hub-launcher-version": "0.1.0"
          }
        }
      }
    );
    try {
      await client.connect(transport);
      return (await client.callTool({
        name: toolName,
        arguments: input as Record<string, unknown>
      })) as McpJsonToolResult;
    } finally {
      await client.close().catch(() => undefined);
    }
  } catch (error) {
    return typedToolError(error);
  }
}

function typedToolError(error: unknown): McpJsonToolResult {
  const code = error instanceof LauncherTypedError ? error.code : errorCode(error);
  if (code === "SERVICE_UNAVAILABLE")
    return errorToolResult(code, "Enterprise Hub service is unavailable.", undefined, {
      retryable: true
    });
  if (code === "FORBIDDEN") return errorToolResult(code, "Enterprise Hub denied this request.");
  if (code === "LAUNCHER_UPGRADE_REQUIRED")
    return errorToolResult(code, "This Enterprise Hub launcher must be upgraded.");
  return errorToolResult("AUTHENTICATION_REQUIRED", "Enterprise Hub sign-in is required.");
}
function errorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error
    ? String((error as { code?: unknown }).code)
    : undefined;
}
function assertCompatible(minimumVersion: string | undefined, recommendedVersion?: string): void {
  if (recommendedVersion && !isSemver(recommendedVersion)) {
    throw new LauncherTypedError("LAUNCHER_UPGRADE_REQUIRED");
  }
  if (minimumVersion && (!isSemver(minimumVersion) || compareVersions("0.1.0", minimumVersion) < 0))
    throw new LauncherTypedError("LAUNCHER_UPGRADE_REQUIRED");
}
function isSemver(value: string): boolean {
  return /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(value);
}
function compareVersions(left: string, right: string): number {
  const a = left.split(".").map(Number),
    b = right.split(".").map(Number);
  for (let i = 0; i < 3; i += 1) {
    const diff = (a[i] ?? 0) - (b[i] ?? 0);
    if (diff) return diff;
  }
  return 0;
}
