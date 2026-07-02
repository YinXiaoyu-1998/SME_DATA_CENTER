import { spawn, type ChildProcess, type StdioOptions } from "node:child_process";
import { once } from "node:events";
import { type Readable } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { config as loadDotenv } from "dotenv";
import { loadMcpRuntimeConfig } from "../apps/mcp-server/src/config.js";
import { runMcpStdioServer } from "../apps/mcp-server/src/server.js";

const DEFAULT_API_PORT = "3000";
const DEFAULT_API_HOST = "127.0.0.1";
const API_HEALTH_TIMEOUT_MS = 30_000;
const API_HEALTH_INTERVAL_MS = 250;

export interface McpBootupConfig {
  cwd: string;
  apiUrl: string;
  apiEnv: NodeJS.ProcessEnv;
  mcpEnv: NodeJS.ProcessEnv;
}

interface ApiChildSpec {
  command: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  stdio: StdioOptions;
}

export function buildMcpBootupConfig(
  env: NodeJS.ProcessEnv = process.env,
  cwd = process.cwd()
): McpBootupConfig {
  const rawApiUrl = env["ENTERPRISE_HUB_API_URL"];
  const port = resolveApiPort(rawApiUrl, env["PORT"]);
  const apiUrl = rawApiUrl ? normalizeApiUrl(rawApiUrl) : `http://127.0.0.1:${port}`;

  return {
    cwd,
    apiUrl,
    apiEnv: {
      ...env,
      HOST: env["HOST"] ?? DEFAULT_API_HOST,
      PORT: port
    },
    mcpEnv: {
      ...env,
      ENTERPRISE_HUB_API_URL: apiUrl
    }
  };
}

export function createApiChildSpec(config: McpBootupConfig): ApiChildSpec {
  return {
    command: "npm",
    args: ["run", "--silent", "api:dev"],
    cwd: config.cwd,
    env: config.apiEnv,
    stdio: ["ignore", "pipe", "pipe"]
  };
}

export async function runMcpBootup(): Promise<void> {
  loadDotenv({ quiet: true, override: false });

  const bootupConfig = buildMcpBootupConfig();
  const apiProcess = startApiProcess(bootupConfig);

  try {
    pipeChildOutputToStderr("enterprise-hub-api", apiProcess.stdout);
    pipeChildOutputToStderr("enterprise-hub-api", apiProcess.stderr);
    await waitForApiHealth(apiProcess, bootupConfig.apiUrl);
    await runMcpStdioServer(loadMcpRuntimeConfig(bootupConfig.mcpEnv, bootupConfig.cwd));
  } finally {
    await stopApiProcess(apiProcess);
  }
}

function startApiProcess(config: McpBootupConfig): ChildProcess {
  const spec = createApiChildSpec(config);

  return spawn(spec.command, spec.args, {
    cwd: spec.cwd,
    env: spec.env,
    stdio: spec.stdio
  });
}

function pipeChildOutputToStderr(name: string, stream: Readable | null): void {
  stream?.on("data", (chunk: Buffer) => {
    process.stderr.write(`[${name}] ${chunk.toString("utf8")}`);
  });
}

async function waitForApiHealth(child: ChildProcess, apiUrl: string): Promise<void> {
  const deadline = Date.now() + API_HEALTH_TIMEOUT_MS;
  const healthUrl = new URL(apiUrl);
  healthUrl.pathname = "/healthz";
  healthUrl.search = "";
  healthUrl.hash = "";

  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`API process exited before becoming healthy with code ${child.exitCode}.`);
    }

    try {
      const response = await fetch(healthUrl);

      if (response.ok) {
        return;
      }
    } catch {
      // The API may still be starting. Retry until the health timeout expires.
    }

    await delay(API_HEALTH_INTERVAL_MS);
  }

  throw new Error(`Timed out waiting for API health at ${healthUrl.toString()}.`);
}

async function stopApiProcess(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null) {
    return;
  }

  child.kill("SIGTERM");
  const forcedKill = delay(2_000).then(() => {
    if (child.exitCode === null) {
      child.kill("SIGKILL");
    }
  });

  await Promise.race([once(child, "exit"), forcedKill]);
}

function resolveApiPort(rawApiUrl: string | undefined, rawPort: string | undefined): string {
  const urlPort = rawApiUrl ? portFromUrl(rawApiUrl) : undefined;

  if (urlPort && rawPort && urlPort !== rawPort) {
    throw new Error("PORT must match ENTERPRISE_HUB_API_URL when both are set.");
  }

  return rawPort ?? urlPort ?? DEFAULT_API_PORT;
}

function portFromUrl(value: string): string | undefined {
  const url = new URL(value);

  if (url.port) {
    return url.port;
  }

  if (url.protocol === "http:") {
    return "80";
  }

  if (url.protocol === "https:") {
    return "443";
  }

  throw new Error("ENTERPRISE_HUB_API_URL must be an http(s) URL.");
}

function normalizeApiUrl(value: string): string {
  const url = new URL(value);

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("ENTERPRISE_HUB_API_URL must be an http(s) URL.");
  }

  return url.toString().replace(/\/+$/, "");
}

if (isMainModule()) {
  await runMcpBootup().catch((error: unknown) => {
    process.stderr.write(`enterprise-hub mcp bootup failed: ${errorToMessage(error)}\n`);
    process.exitCode = 1;
  });
}

function isMainModule(): boolean {
  const entrypoint = process.argv[1];
  if (!entrypoint) {
    return false;
  }

  return import.meta.url === pathToFileURL(entrypoint).href;
}

function errorToMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
