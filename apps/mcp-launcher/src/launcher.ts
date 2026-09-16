import open from "open";
import os from "node:os";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { z } from "zod";
import {
  SMEDC_MCP_TOOL_CONTRACTS,
  SMEDC_MCP_TOOL_NAMES,
  errorToolResult,
  jsonToolResult,
  launcherUploadFileInputSchema,
  toolNotFoundResult,
  validationErrorToolResult
} from "@smedc/mcp-contract";
import type { LauncherRuntimeConfig } from "./config.js";
import { SmedcOAuthClient, LAUNCHER_VERSION } from "./oauth-client.js";
import { readLocalUploadFile } from "./local-file.js";
import { downloadPartitionDataset, uploadPartitionDataset } from "./partition-transfer.js";
import { createCrossProcessLock, createKeychainCredentialStore } from "./runtime.js";
import { LauncherSession, LauncherTypedError } from "./session.js";

export const LAUNCHER_BOOTSTRAP_TOOL_NAMES = [
  "smedc_login",
  "smedc_logout",
  "smedc_auth_status"
] as const;
export type LauncherBootstrapToolName = (typeof LAUNCHER_BOOTSTRAP_TOOL_NAMES)[number];
export type LauncherBusinessToolName =
  | "smedc_get_current_user"
  | "smedc_list_skills"
  | "search_document_evidence"
  | "list_structured_datasets"
  | "query_structured_dataset"
  | "describe_structured_dataset_coverage"
  | "upload_structured_dataset"
  | "upload_evidence_document"
  | "upload_quarantine_certificate"
  | "query_quarantine_certificates"
  | "archive_quarantine_certificates"
  | "get_source_document_download_url"
  | "get_evidence_document_status"
  | "get_import_status"
  | "get_partition_import_status"
  | "download_structured_partitions";
export type LauncherToolName = LauncherBootstrapToolName | LauncherBusinessToolName;

const LOCAL_PATH_UPLOAD_TOOL_NAMES = new Set<LauncherBusinessToolName>([
  "upload_structured_dataset",
  "upload_evidence_document",
  "upload_quarantine_certificate"
]);

function launcherUploadToolInputShape(
  contract: (typeof SMEDC_MCP_TOOL_CONTRACTS)[number]
): z.ZodRawShape {
  return {
    ...contract.inputSchema.shape,
    file: launcherUploadFileInputSchema
  };
}

export interface LauncherToolResult {
  [key: string]: unknown;
  content: Array<{ type: "text"; text: string }>;
  isError: boolean;
}

export interface LauncherAuthentication {
  login(): Promise<LauncherLoginResult>;
  logout(): Promise<{ remoteRevocationConfirmed: boolean; localCredentialRemoved: boolean }>;
  status(): Promise<{ authenticated: boolean }>;
  accessToken(): Promise<string>;
  invalidate(): Promise<void>;
  selfCheck(): Promise<LauncherSelfCheck>;
}

export type LauncherLoginResult =
  | { authenticated: true }
  | {
      authenticated: false;
      flow: "device";
      verificationUri: string;
      verificationUriComplete: string | null;
      userCode: string;
      instanceName: string;
      instanceHostname: string;
      openedBrowser: boolean;
    };

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
    name: "smedc_login",
    title: "SMEDC sign in",
    description: "Open the system browser for SMEDC sign-in.",
    inputShape: emptyInputSchema.shape
  },
  {
    name: "smedc_logout",
    title: "SMEDC sign out",
    description: "Revoke and remove the local SMEDC session.",
    inputShape: emptyInputSchema.shape
  },
  {
    name: "smedc_auth_status",
    title: "SMEDC authentication status",
    description: "Check whether a local SMEDC session is available.",
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
  for (const tool of SMEDC_MCP_TOOL_CONTRACTS)
    registrar.registerTool(
      tool.name,
      {
        title: tool.title,
        description: tool.description,
        inputSchema: LOCAL_PATH_UPLOAD_TOOL_NAMES.has(tool.name)
          ? launcherUploadToolInputShape(tool)
          : tool.inputShape
      },
      createLauncherToolHandler(tool.name, dependencies)
    );
}

export function createLauncherToolHandler(
  toolName: string,
  dependencies: LauncherToolDependencies
): (input: unknown) => Promise<LauncherToolResult> {
  if (toolName === "smedc_login") return (input) => login(input, dependencies);
  if (toolName === "smedc_logout") return (input) => logout(input, dependencies);
  if (toolName === "smedc_auth_status") return (input) => status(input, dependencies);
  if (toolName === "download_structured_partitions")
    return (input) => proxyPartitionDownload(input, dependencies);
  if (LOCAL_PATH_UPLOAD_TOOL_NAMES.has(toolName as LauncherBusinessToolName))
    return (input) =>
      proxyLocalPathUpload(toolName as LauncherBusinessToolName, input, dependencies);
  if ((SMEDC_MCP_TOOL_NAMES as readonly string[]).includes(toolName))
    return (input) => proxy(toolName as LauncherBusinessToolName, input, dependencies);
  return async () => toolNotFoundResult(toolName);
}

async function proxyLocalPathUpload(
  toolName: LauncherBusinessToolName,
  input: unknown,
  dependencies: LauncherToolDependencies
): Promise<LauncherToolResult> {
  const file = uploadFileFromInput(input);

  if (file === undefined || file.encoding !== "path") {
    return proxy(toolName, input, dependencies);
  }

  const parsed = launcherUploadFileInputSchema.safeParse(file);

  if (!parsed.success) {
    return validationErrorToolResult(parsed.error.issues);
  }

  const pathFile = parsed.data as {
    name: string;
    mediaType: string;
    encoding: "path";
    filePath: string;
  };
  const structuredInput = input as Record<string, unknown>;
  if (
    toolName === "upload_structured_dataset" &&
    (structuredInput["dataset"] === "business" || structuredInput["dataset"] === "dishes")
  ) {
    return proxyPartitionUpload(
      {
        ...structuredInput,
        file: pathFile
      },
      dependencies
    );
  }
  const read = await readLocalUploadFile(pathFile);

  if (!read.ok) {
    return read.result;
  }

  const convertedInput = {
    ...(typeof input === "object" && input !== null ? (input as Record<string, unknown>) : {}),
    file: {
      name: pathFile.name,
      mediaType: pathFile.mediaType,
      encoding: "base64",
      contentBase64: read.body.toString("base64")
    }
  };

  return proxy(toolName, convertedInput, dependencies);
}

async function proxyPartitionUpload(
  input: Record<string, unknown>,
  dependencies: LauncherToolDependencies
): Promise<LauncherToolResult> {
  const contract = SMEDC_MCP_TOOL_CONTRACTS.find(
    (candidate) => candidate.name === "upload_structured_dataset"
  )!;
  const parsed = z.object(launcherUploadToolInputShape(contract)).strict().safeParse(input);
  if (!parsed.success) return validationErrorToolResult(parsed.error.issues);
  const value = parsed.data as {
    file: { name: string; mediaType: string; encoding: "path"; filePath: string };
    dataset: "business" | "dishes";
    enterpriseName: string;
    startDate: string;
    endDate: string;
    idempotencyKey: string;
    confidentialityLevel?: number;
  };
  if (!value.startDate || !value.endDate) {
    return errorToolResult(
      "MCP_INPUT_VALIDATION_ERROR",
      "business and dishes require startDate and endDate."
    );
  }
  try {
    const accessToken = await dependencies.auth.accessToken();
    return jsonToolResult(
      (await uploadPartitionDataset({
        context: partitionTransferContext(dependencies, accessToken),
        filePath: value.file.filePath,
        name: value.file.name,
        mediaType: value.file.mediaType,
        dataset: value.dataset,
        enterpriseName: value.enterpriseName,
        startDate: value.startDate,
        endDate: value.endDate,
        idempotencyKey: value.idempotencyKey,
        confidentialityLevel: value.confidentialityLevel
      })) as Record<string, unknown>
    );
  } catch (error) {
    return partitionTransferError(error);
  }
}

async function proxyPartitionDownload(
  input: unknown,
  dependencies: LauncherToolDependencies
): Promise<LauncherToolResult> {
  const contract = SMEDC_MCP_TOOL_CONTRACTS.find(
    (candidate) => candidate.name === "download_structured_partitions"
  )!;
  const parsed = contract.inputSchema.safeParse(input);
  if (!parsed.success) return validationErrorToolResult(parsed.error.issues);
  try {
    const accessToken = await dependencies.auth.accessToken();
    return jsonToolResult(
      (await downloadPartitionDataset({
        context: partitionTransferContext(dependencies, accessToken),
        ...(parsed.data as {
          dataset: "business" | "dishes";
          enterpriseName: string;
          startDate: string;
          endDate: string;
          storeIds?: string[];
        })
      })) as Record<string, unknown>
    );
  } catch (error) {
    return partitionTransferError(error);
  }
}

function partitionTransferContext(dependencies: LauncherToolDependencies, accessToken: string) {
  return {
    serviceUrl: dependencies.config.serviceUrl,
    accessToken,
    launcherVersion: LAUNCHER_VERSION,
    fetchImplementation: dependencies.fetchImplementation
  };
}

function partitionTransferError(error: unknown): LauncherToolResult {
  if (typeof error === "object" && error !== null && "body" in error) {
    const body = (error as { body?: { error?: { code?: string; message?: string } } }).body;
    if (body?.error?.code) {
      return errorToolResult(body.error.code, body.error.message ?? "Partition transfer failed.");
    }
  }
  return typedToolError(mapMcpError(error));
}

function uploadFileFromInput(
  input: unknown
): { encoding?: unknown; [key: string]: unknown } | undefined {
  if (typeof input !== "object" || input === null) {
    return undefined;
  }

  const file = (input as { file?: unknown }).file;

  if (typeof file !== "object" || file === null) {
    return undefined;
  }

  return file as { encoding?: unknown; [key: string]: unknown };
}

export function createOfficialLauncherAuthentication(
  config: LauncherRuntimeConfig
): LauncherAuthentication {
  const origin = config.serviceUrl;
  const oauth = new SmedcOAuthClient(new URL(origin));
  const session = new LauncherSession({
    origin,
    secureStore: createKeychainCredentialStore(origin),
    tokenClient: oauth,
    lock: createCrossProcessLock(origin)
  });
  return {
    login: async () => {
      const metadata = await oauth.metadata(true);
      if (!metadata.deviceAuthorizationEndpoint) {
        throw new LauncherTypedError("SERVICE_UNAVAILABLE");
      }
      const instanceHostname = os.hostname();
      const instanceName = instanceHostname;
      const device = await oauth.requestDeviceAuthorization({
        instanceName,
        instanceHostname
      });
      const openedBrowser = await openVerificationLink(device);
      session.waitForLogin(pollUntilComplete(oauth, session, device));
      return {
        authenticated: false,
        flow: "device",
        verificationUri: device.verificationUri.toString(),
        verificationUriComplete: device.verificationUriComplete?.toString() ?? null,
        userCode: device.userCode,
        instanceName,
        instanceHostname,
        openedBrowser
      };
    },
    logout: () => session.logout(),
    status: () => session.status(),
    accessToken: async () => {
      await oauth.metadata(true);
      return session.ensureAccessToken();
    },
    invalidate: () => session.invalidate(),
    selfCheck: async () => {
      let secureStoreAvailable = false;
      let authenticated = false;
      try {
        secureStoreAvailable = await session.secureStoreAvailable();
        authenticated = (await session.status()).authenticated;
      } catch {
        // A failed probe reports an unavailable secure store in the self-check result.
      }
      let metadata: Awaited<ReturnType<SmedcOAuthClient["metadata"]>> | null = null;
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
      const ok = metadata !== null && metadata.compatible && handshake !== "unavailable";
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
    const result = await dependencies.auth.login();
    return jsonToolResult({ ...result, serviceUrl: dependencies.config.serviceUrl });
  } catch (error) {
    return typedToolError(error);
  }
}

export function canOpenBrowser(): boolean {
  if (process.platform === "darwin" || process.platform === "win32") {
    return true;
  }
  return Boolean(process.env.DISPLAY || process.env.WAYLAND_DISPLAY);
}

async function openVerificationLink(device: {
  verificationUri: URL;
  verificationUriComplete: URL | null;
}): Promise<boolean> {
  if (!canOpenBrowser()) {
    return false;
  }
  const target = device.verificationUriComplete ?? device.verificationUri;
  try {
    await open(target.toString());
    return true;
  } catch {
    return false;
  }
}

async function pollUntilComplete(
  oauth: SmedcOAuthClient,
  session: LauncherSession,
  device: {
    deviceCode: string;
    expiresInSeconds: number;
    intervalSeconds: number;
  }
): Promise<void> {
  let intervalSeconds = device.intervalSeconds;
  const deadline = Date.now() + device.expiresInSeconds * 1000;
  while (Date.now() < deadline) {
    await sleep(intervalSeconds * 1000);
    const result = await oauth.pollDeviceAuthorization(device.deviceCode);
    if (result.status === "complete") {
      await session.establish(
        result.accessToken,
        result.refreshToken,
        result.expiresAt ?? Date.now() + 9 * 60_000
      );
      return;
    }
    if (result.status === "slow_down") {
      intervalSeconds += result.intervalSeconds;
    }
    if (result.status === "expired") {
      return;
    }
  }
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
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
    const client = new Client({ name: "smedc-mcp-launcher", version: LAUNCHER_VERSION });
    const transport = new StreamableHTTPClientTransport(
      new URL("mcp", `${dependencies.config.serviceUrl}/`),
      {
        fetch: dependencies.fetchImplementation,
        requestInit: {
          headers: {
            authorization: `Bearer ${accessToken}`,
            "x-smedc-launcher-version": LAUNCHER_VERSION
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
    return errorToolResult("SERVICE_UNAVAILABLE", "SMEDC returned an unsafe response.");
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
    name: "smedc-mcp-launcher-self-check",
    version: LAUNCHER_VERSION
  });
  const transport = new StreamableHTTPClientTransport(new URL("mcp", `${config.serviceUrl}/`), {
    fetch: fetchImplementation,
    requestInit: {
      headers: {
        authorization: `Bearer ${accessToken}`,
        "x-smedc-launcher-version": LAUNCHER_VERSION
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
    return errorToolResult(code, "SMEDC service is unavailable.", undefined, {
      retryable: true
    });
  if (code === "FORBIDDEN") return errorToolResult(code, "SMEDC denied this request.");
  if (code === "LAUNCHER_UPGRADE_REQUIRED")
    return errorToolResult(code, "This SMEDC launcher must be upgraded.");
  return errorToolResult("AUTHENTICATION_REQUIRED", "SMEDC sign-in is required.");
}
function errorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error
    ? String((error as { code?: unknown }).code)
    : undefined;
}
