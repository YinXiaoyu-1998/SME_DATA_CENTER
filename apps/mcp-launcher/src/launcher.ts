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
  validationErrorToolResult
} from "@enterprise-hub/mcp-contract";
import {
  createAuthorizationRequest,
  createLoopbackCallbackServer,
  waitForAuthorizationResponse
} from "./auth.js";
import type { LauncherRuntimeConfig } from "./config.js";
import { EnterpriseHubOAuthClient, LAUNCHER_VERSION } from "./oauth-client.js";
import { createCrossProcessLock, createKeychainCredentialStore } from "./runtime.js";
import { LauncherSession, LauncherTypedError } from "./session.js";

export const LAUNCHER_BOOTSTRAP_TOOL_NAMES = [
  "enterprise_hub_login",
  "enterprise_hub_logout",
  "enterprise_hub_auth_status"
] as const;
export type LauncherBootstrapToolName = (typeof LAUNCHER_BOOTSTRAP_TOOL_NAMES)[number];
export type LauncherBusinessToolName =
  | "enterprise_hub_list_labels"
  | "enterprise_hub_list_skills"
  | "search_document_evidence"
  | "list_structured_datasets"
  | "query_structured_dataset"
  | "upload_structured_dataset"
  | "upload_evidence_document"
  | "get_evidence_document_status"
  | "get_import_status";
export type LauncherToolName = LauncherBootstrapToolName | LauncherBusinessToolName;

export interface LauncherToolResult {
  [key: string]: unknown;
  content: Array<{ type: "text"; text: string }>;
  isError: boolean;
}

export interface LauncherAuthentication {
  login(): Promise<void>;
  logout(): Promise<{ remoteRevocationConfirmed: boolean; localCredentialRemoved: boolean }>;
  status(): Promise<{ authenticated: boolean }>;
  accessToken(): Promise<string>;
  invalidate(): Promise<void>;
  selfCheck(): Promise<LauncherSelfCheck>;
}

export interface LauncherSelfCheck {
  ok: boolean;
  launcherVersion: string;
  serviceOrigin: string;
  platform: string;
  secureStore: { available: boolean; durableCredentialPresent: boolean };
  server: {
    reachable: boolean;
    metadataCompatible: boolean;
    minimumLauncherVersion: string | null;
    recommendedLauncherVersion: string | null;
    recommendedUpdateAvailable: boolean;
  };
  mcp: { handshake: "ok" | "not_authenticated" | "unavailable" };
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
    handler: (input: unknown) => Promise<LauncherToolResult>
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
): (input: unknown) => Promise<LauncherToolResult> {
  if (toolName === "enterprise_hub_login") return (input) => login(input, dependencies);
  if (toolName === "enterprise_hub_logout") return (input) => logout(input, dependencies);
  if (toolName === "enterprise_hub_auth_status") return (input) => status(input, dependencies);
  if ((ENTERPRISE_HUB_MCP_TOOL_NAMES as readonly string[]).includes(toolName))
    return (input) => proxy(toolName as LauncherBusinessToolName, input, dependencies);
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
      const metadata = await oauth.metadata(true);
      const state = randomBytes(32).toString("base64url");
      const callback = await createLoopbackCallbackServer({ state });
      try {
        const request = await createAuthorizationRequest({
          authorizationEndpoint: metadata.authorizationEndpoint,
          redirectUri: callback.redirectUri,
          state
        });
        await open(request.url.toString());
        const callbackUrl = await waitForAuthorizationResponse(callback);
        const parameters = oauth.validateCallback(callbackUrl, state);
        const tokens = await oauth.exchange(parameters, callback.redirectUri, request.verifier);
        await session.establish(tokens.accessToken, tokens.refreshToken, tokens.expiresAt);
      } finally {
        await callback.close();
      }
    },
    logout: () => session.logout(),
    status: () => session.status(),
    accessToken: async () => {
      await oauth.metadata(true);
      return session.ensureAccessToken();
    },
    invalidate: () => session.invalidate(),
    selfCheck: async () => {
      let secureStoreAvailable = true;
      let authenticated = false;
      try {
        authenticated = (await session.status()).authenticated;
      } catch {
        secureStoreAvailable = false;
      }
      let metadata: Awaited<ReturnType<EnterpriseHubOAuthClient["metadata"]>> | null = null;
      try {
        metadata = await oauth.metadata(true, false);
      } catch {
        metadata = null;
      }
      let handshake: LauncherSelfCheck["mcp"]["handshake"] = authenticated
        ? "unavailable"
        : "not_authenticated";
      if (metadata?.compatible && authenticated) {
        try {
          const accessToken = await session.ensureAccessToken();
          await verifyMcpHandshake(config, accessToken, fetch);
          handshake = "ok";
        } catch {
          handshake = "unavailable";
        }
      }
      const ok =
        secureStoreAvailable &&
        metadata !== null &&
        metadata.compatible &&
        handshake !== "unavailable";
      return {
        ok,
        launcherVersion: LAUNCHER_VERSION,
        serviceOrigin: origin,
        platform: process.platform,
        secureStore: {
          available: secureStoreAvailable,
          durableCredentialPresent: authenticated
        },
        server: {
          reachable: metadata !== null,
          metadataCompatible: metadata?.compatible ?? false,
          minimumLauncherVersion: metadata?.minimumVersion ?? null,
          recommendedLauncherVersion: metadata?.recommendedVersion ?? null,
          recommendedUpdateAvailable: metadata?.recommendedUpdateAvailable ?? false
        },
        mcp: { handshake }
      };
    }
  };
}

async function login(
  input: unknown,
  dependencies: LauncherToolDependencies
): Promise<LauncherToolResult> {
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
): Promise<LauncherToolResult> {
  const parsed = emptyInputSchema.safeParse(input);
  if (!parsed.success) return validationErrorToolResult(parsed.error.issues);
  try {
    return jsonToolResult(await dependencies.auth.logout());
  } catch (error) {
    return typedToolError(error);
  }
}
async function status(
  input: unknown,
  dependencies: LauncherToolDependencies
): Promise<LauncherToolResult> {
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
  toolName: LauncherBusinessToolName,
  input: unknown,
  dependencies: LauncherToolDependencies
): Promise<LauncherToolResult> {
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
      await client.connect(transport, { timeout: REMOTE_MCP_TIMEOUT_MS });
      const remoteResult = await client.callTool(
        {
          name: toolName,
          arguments: input as Record<string, unknown>
        },
        undefined,
        { timeout: REMOTE_MCP_TIMEOUT_MS }
      );
      return sanitizeRemoteToolResult(remoteResult, accessToken);
    } finally {
      await client.close().catch(() => undefined);
    }
  } catch (error) {
    const typed = mapMcpError(error);
    if (typed.code === "AUTHENTICATION_REQUIRED") await dependencies.auth.invalidate();
    return typedToolError(typed);
  }
}

const REMOTE_MCP_TIMEOUT_MS = 30_000;

export function sanitizeRemoteToolResult(result: unknown, accessToken: string): LauncherToolResult {
  if (containsCredential(result, accessToken)) {
    return errorToolResult("SERVICE_UNAVAILABLE", "Enterprise Hub returned an unsafe response.");
  }
  return result as LauncherToolResult;
}

function containsCredential(value: unknown, accessToken: string): boolean {
  if (typeof value === "string") {
    if (accessToken && value.includes(accessToken)) return true;
    try {
      return containsCredential(JSON.parse(value), accessToken);
    } catch {
      return (
        /^(?:Bearer|Basic)\s+\S+$/i.test(value.trim()) ||
        /^eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(value.trim()) ||
        /[?&](?:access_token|refresh_token|code)=/i.test(value) ||
        /(?:^|[^A-Za-z0-9_-])eh_(?:at|rt|ac|ps|tx)_[A-Za-z0-9_-]{43,}(?![A-Za-z0-9_-])/.test(value)
      );
    }
  }
  if (Array.isArray(value)) return value.some((item) => containsCredential(item, accessToken));
  if (typeof value !== "object" || value === null) return false;
  return Object.entries(value as Record<string, unknown>).some(
    ([key, item]) =>
      (accessToken !== "" && key.includes(accessToken)) ||
      isCredentialFieldName(key) ||
      containsCredential(item, accessToken)
  );
}

function isCredentialFieldName(key: string): boolean {
  const normalized = key.replace(/[^A-Za-z0-9]/g, "").toLowerCase();
  return new Set([
    "token",
    "accesstoken",
    "refreshtoken",
    "idtoken",
    "authorization",
    "authorizationheader",
    "cookie",
    "setcookie",
    "credential",
    "durablecredential",
    "password",
    "clientsecret",
    "codeverifier",
    "authorizationcode"
  ]).has(normalized);
}

export function mapMcpError(error: unknown): LauncherTypedError {
  if (error instanceof LauncherTypedError) return error;
  const code = errorCode(error);
  const message = error instanceof Error ? error.message.toLowerCase() : "";
  if (code === "401" || /\b401\b|unauthenticated|unauthorized/.test(message))
    return new LauncherTypedError("AUTHENTICATION_REQUIRED");
  if (code === "403" || /\b403\b|forbidden/.test(message))
    return new LauncherTypedError("FORBIDDEN");
  return new LauncherTypedError("SERVICE_UNAVAILABLE");
}

async function verifyMcpHandshake(
  config: LauncherRuntimeConfig,
  accessToken: string,
  fetchImplementation: typeof fetch
): Promise<void> {
  const client = new Client({
    name: "enterprise-hub-mcp-launcher-self-check",
    version: LAUNCHER_VERSION
  });
  const transport = new StreamableHTTPClientTransport(new URL("mcp", `${config.serviceUrl}/`), {
    fetch: fetchImplementation,
    requestInit: {
      headers: {
        authorization: `Bearer ${accessToken}`,
        "x-enterprise-hub-launcher-version": LAUNCHER_VERSION
      }
    }
  });
  try {
    await client.connect(transport, { timeout: REMOTE_MCP_TIMEOUT_MS });
    await client.listTools(undefined, { timeout: REMOTE_MCP_TIMEOUT_MS });
  } finally {
    await client.close().catch(() => undefined);
  }
}

function typedToolError(error: unknown): LauncherToolResult {
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
