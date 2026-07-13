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
import type { LauncherRuntimeConfig } from "./config.js";

export const LAUNCHER_BOOTSTRAP_TOOL_NAMES = [
  "enterprise_hub_login_local",
  "enterprise_hub_logout_local"
] as const;

export type LauncherBootstrapToolName = (typeof LAUNCHER_BOOTSTRAP_TOOL_NAMES)[number];
export type LauncherToolName = LauncherBootstrapToolName | EnterpriseHubMcpToolName;

export interface LauncherEmployeeIdentity {
  id: string;
  orgId?: string;
  email: string;
  role: string;
  disabled?: boolean;
  labels: string[];
}

interface MemorySessionRecord {
  accessToken: string;
  employee: LauncherEmployeeIdentity;
  serviceUrl: string;
}

interface LauncherAccessTokenContext {
  accessToken: string;
  employee: LauncherEmployeeIdentity;
  serviceUrl: string;
}

export class MemoryLauncherSession {
  #record: MemorySessionRecord | null = null;

  authenticate(record: MemorySessionRecord): void {
    this.#record = record;
  }

  clear(): void {
    this.#record = null;
  }

  isAuthenticated(): boolean {
    return this.#record !== null;
  }

  async withAccessToken<T>(
    callback: (context: LauncherAccessTokenContext) => T | Promise<T>
  ): Promise<T> {
    if (this.#record === null) {
      throw new LauncherEmployeeAuthRequiredError();
    }

    return callback({
      accessToken: this.#record.accessToken,
      employee: this.#record.employee,
      serviceUrl: this.#record.serviceUrl
    });
  }
}

export interface LauncherToolDependencies {
  config: LauncherRuntimeConfig;
  fetchImplementation: typeof fetch;
  session: MemoryLauncherSession;
}

export interface LauncherToolRegistrar {
  registerTool(
    name: string,
    options: {
      title: string;
      description: string;
      inputSchema: z.ZodRawShape;
    },
    handler: (input: unknown) => Promise<McpJsonToolResult>
  ): void;
}

const loginLocalInputSchema = z
  .object({
    email: z.string().email()
  })
  .strict();

const logoutLocalInputSchema = z.object({}).strict();

const employeeIdentitySchema = z
  .object({
    id: z.string().min(1),
    orgId: z.string().min(1).optional(),
    email: z.string().email(),
    role: z.string().min(1),
    disabled: z.boolean().optional(),
    labels: z.array(z.string())
  })
  .strict();

const devLoginResponseSchema = z
  .object({
    accessToken: z.string().min(1),
    employee: employeeIdentitySchema
  })
  .strict();

const DEV_LOGIN_TIMEOUT_MS = 10_000;
const DEV_LOGIN_MAX_SUCCESS_BODY_BYTES = 64 * 1024;
const REMOTE_MCP_REQUEST_TIMEOUT_MS = 30_000;

const bootstrapToolContracts = [
  {
    name: "enterprise_hub_login_local",
    title: "Enterprise Hub local login",
    description:
      "Log in to the configured Enterprise Hub service through development-only /auth/dev-login.",
    inputShape: loginLocalInputSchema.shape
  },
  {
    name: "enterprise_hub_logout_local",
    title: "Enterprise Hub local logout",
    description: "Clear the launcher process-memory Enterprise Hub session.",
    inputShape: logoutLocalInputSchema.shape
  }
] as const;

export function createLauncherToolDependencies(input: {
  config: LauncherRuntimeConfig;
  fetchImplementation?: typeof fetch;
  session?: MemoryLauncherSession;
}): LauncherToolDependencies {
  return {
    config: input.config,
    fetchImplementation: input.fetchImplementation ?? fetch,
    session: input.session ?? new MemoryLauncherSession()
  };
}

export function registerLauncherTools(
  registrar: LauncherToolRegistrar,
  dependencies: LauncherToolDependencies
): void {
  for (const tool of bootstrapToolContracts) {
    registrar.registerTool(
      tool.name,
      {
        title: tool.title,
        description: tool.description,
        inputSchema: tool.inputShape
      },
      createLauncherToolHandler(tool.name, dependencies)
    );
  }

  for (const tool of ENTERPRISE_HUB_MCP_TOOL_CONTRACTS) {
    registrar.registerTool(
      tool.name,
      {
        title: tool.title,
        description: tool.description,
        inputSchema: tool.inputShape
      },
      createLauncherToolHandler(tool.name, dependencies)
    );
  }
}

export function createLauncherToolHandler(
  toolName: string,
  dependencies: LauncherToolDependencies
): (input: unknown) => Promise<McpJsonToolResult> {
  if (toolName === "enterprise_hub_login_local") {
    return (input: unknown) => loginLocalTool(input, dependencies);
  }

  if (toolName === "enterprise_hub_logout_local") {
    return (input: unknown) => logoutLocalTool(input, dependencies);
  }

  if (isBusinessToolName(toolName)) {
    return (input: unknown) => proxyBusinessTool(toolName, input, dependencies);
  }

  return async () => toolNotFoundResult(toolName);
}

export function employeeAuthRequiredToolResult(): McpJsonToolResult {
  return errorToolResult("EMPLOYEE_AUTH_REQUIRED", "Enterprise Hub local login is required.");
}

export function enterpriseHubUnreachableToolResult(): McpJsonToolResult {
  return errorToolResult(
    "ENTERPRISE_HUB_UNREACHABLE",
    "Enterprise Hub service is unreachable.",
    undefined,
    { retryable: true }
  );
}

async function loginLocalTool(
  input: unknown,
  dependencies: LauncherToolDependencies
): Promise<McpJsonToolResult> {
  const parsedInput = loginLocalInputSchema.safeParse(input);

  if (!parsedInput.success) {
    return validationErrorToolResult(parsedInput.error.issues);
  }

  try {
    const loginResponse = await requestDevLogin(parsedInput.data.email, dependencies);

    dependencies.session.authenticate({
      accessToken: loginResponse.accessToken,
      employee: loginResponse.employee,
      serviceUrl: dependencies.config.serviceUrl
    });

    return jsonToolResult({
      employee: loginResponse.employee,
      serviceUrl: dependencies.config.serviceUrl
    });
  } catch (error) {
    if (error instanceof DevLoginRejectedError) {
      return errorToolResult("EMPLOYEE_AUTH_REQUIRED", "Enterprise Hub local login failed.");
    }

    return errorToolResult("ENTERPRISE_HUB_API_ERROR", "Enterprise Hub API request failed.");
  }
}

async function logoutLocalTool(
  input: unknown,
  dependencies: LauncherToolDependencies
): Promise<McpJsonToolResult> {
  const parsedInput = logoutLocalInputSchema.safeParse(input);

  if (!parsedInput.success) {
    return validationErrorToolResult(parsedInput.error.issues);
  }

  dependencies.session.clear();

  return jsonToolResult({ success: true });
}

async function proxyBusinessTool(
  toolName: EnterpriseHubMcpToolName,
  input: unknown,
  dependencies: LauncherToolDependencies
): Promise<McpJsonToolResult> {
  try {
    return await dependencies.session.withAccessToken(async ({ accessToken, serviceUrl }) => {
      const client = new Client({
        name: "enterprise-hub-mcp-launcher",
        version: "0.1.0"
      });
      const transport = new StreamableHTTPClientTransport(new URL("mcp", `${serviceUrl}/`), {
        fetch: dependencies.fetchImplementation,
        requestInit: {
          headers: {
            authorization: `Bearer ${accessToken}`
          }
        }
      });

      try {
        await client.connect(transport, { timeout: REMOTE_MCP_REQUEST_TIMEOUT_MS });
        const result = await client.callTool(
          {
            name: toolName,
            arguments: input as Record<string, unknown>
          },
          undefined,
          { timeout: REMOTE_MCP_REQUEST_TIMEOUT_MS }
        );

        return safeRemoteToolResult(result, accessToken);
      } catch (error) {
        if (isRemoteAuthFailure(error)) {
          dependencies.session.clear();
          return employeeAuthRequiredToolResult();
        }

        if (isRemoteUnavailable(error)) {
          return enterpriseHubUnreachableToolResult();
        }

        return errorToolResult("ENTERPRISE_HUB_API_ERROR", "Enterprise Hub API request failed.");
      } finally {
        await client.close().catch(() => undefined);
      }
    });
  } catch (error) {
    if (error instanceof LauncherEmployeeAuthRequiredError) {
      return employeeAuthRequiredToolResult();
    }

    throw error;
  }
}

async function requestDevLogin(
  email: string,
  dependencies: LauncherToolDependencies
): Promise<z.infer<typeof devLoginResponseSchema>> {
  const abortController = new AbortController();
  const timeout = setTimeout(() => abortController.abort(), DEV_LOGIN_TIMEOUT_MS);

  let response: Response;

  try {
    response = await dependencies.fetchImplementation(
      new URL("auth/dev-login", `${dependencies.config.serviceUrl}/`),
      {
        method: "POST",
        headers: {
          "content-type": "application/json"
        },
        body: JSON.stringify({ email }),
        signal: abortController.signal
      }
    );
  } finally {
    clearTimeout(timeout);
  }

  if (!response.ok) {
    throw new DevLoginRejectedError(response.status);
  }

  const body = await readBoundedJsonResponse(response);

  return devLoginResponseSchema.parse(body);
}

async function readBoundedJsonResponse(response: Response): Promise<unknown> {
  const text = await readBoundedResponseText(response);

  if (!text) {
    return null;
  }

  return JSON.parse(text);
}

async function readBoundedResponseText(response: Response): Promise<string> {
  const contentLength = response.headers.get("content-length");
  const parsedContentLength = contentLength === null ? null : Number(contentLength);

  if (parsedContentLength !== null && parsedContentLength > DEV_LOGIN_MAX_SUCCESS_BODY_BYTES) {
    throw new Error("Enterprise Hub local login response exceeded the maximum allowed size.");
  }

  if (response.body === null) {
    return "";
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;

  try {
    while (true) {
      const result = await reader.read();

      if (result.done) {
        break;
      }

      totalBytes += result.value.byteLength;

      if (totalBytes > DEV_LOGIN_MAX_SUCCESS_BODY_BYTES) {
        await reader.cancel();
        throw new Error("Enterprise Hub local login response exceeded the maximum allowed size.");
      }

      chunks.push(result.value);
    }
  } finally {
    reader.releaseLock();
  }

  const body = new Uint8Array(totalBytes);
  let offset = 0;

  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }

  return new TextDecoder().decode(body);
}

function isBusinessToolName(toolName: string): toolName is EnterpriseHubMcpToolName {
  return (ENTERPRISE_HUB_MCP_TOOL_NAMES as readonly string[]).includes(toolName);
}

function safeRemoteToolResult(result: unknown, accessToken: string): McpJsonToolResult {
  if (containsAccessToken(result, accessToken)) {
    return errorToolResult("ENTERPRISE_HUB_API_ERROR", "Enterprise Hub API request failed.");
  }

  return result as McpJsonToolResult;
}

function containsAccessToken(value: unknown, accessToken: string): boolean {
  if (!accessToken) {
    return false;
  }

  try {
    return JSON.stringify(value).includes(accessToken);
  } catch {
    return true;
  }
}

function isRemoteAuthFailure(error: unknown): boolean {
  const code = errorCode(error);
  const name = errorName(error);

  return code === 401 || code === 403 || name === "UnauthorizedError";
}

function isRemoteUnavailable(error: unknown): boolean {
  const code = errorCode(error);
  const message = errorMessage(error).toLowerCase();

  return (
    code === -32_001 ||
    code === -32_000 ||
    code === -1 ||
    message.includes("fetch failed") ||
    message.includes("econnrefused") ||
    message.includes("connection refused") ||
    message.includes("request timed out") ||
    message.includes("network")
  );
}

function errorCode(error: unknown): number | string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return undefined;
  }

  const code = (error as { code?: unknown }).code;

  return typeof code === "number" || typeof code === "string" ? code : undefined;
}

function errorName(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("name" in error)) {
    return undefined;
  }

  const name = (error as { name?: unknown }).name;

  return typeof name === "string" ? name : undefined;
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return typeof error === "string" ? error : "";
}

class LauncherEmployeeAuthRequiredError extends Error {
  constructor() {
    super("Enterprise Hub local login is required.");
  }
}

class DevLoginRejectedError extends Error {
  constructor(readonly status: number) {
    super("Enterprise Hub local login failed.");
  }
}
