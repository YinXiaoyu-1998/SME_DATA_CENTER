#!/usr/bin/env node
import { fileURLToPath } from "node:url";
import { loadLauncherRuntimeConfig } from "./config.js";
import { formatLauncherCommandResult } from "./cli.js";
import { createOfficialLauncherAuthentication } from "./launcher.js";
import { LAUNCHER_VERSION } from "./oauth-client.js";
import { runMcpLauncherStdioServer } from "./server.js";

export {
  createLauncherRuntimeConfig,
  loadLauncherRuntimeConfig,
  type LauncherRuntimeConfig,
  type LauncherRuntimeConfigInput
} from "./config.js";
export {
  MCP_LAUNCHER_SERVER_NAME,
  MCP_LAUNCHER_SERVER_VERSION,
  createSmedcMcpLauncherServer,
  runMcpLauncherStdioServer
} from "./server.js";
export {
  LAUNCHER_BOOTSTRAP_TOOL_NAMES,
  createOfficialLauncherAuthentication,
  createLauncherToolDependencies,
  createLauncherToolHandler,
  registerLauncherTools,
  type LauncherBootstrapToolName,
  type LauncherBusinessToolName,
  type LauncherAuthentication,
  type LauncherToolDependencies,
  type LauncherToolName,
  type LauncherToolRegistrar,
  type LauncherToolResult
} from "./launcher.js";
export { LauncherSession, LauncherTypedError, type LauncherErrorCode } from "./session.js";
export {
  cachedUserProfileSchema,
  parseCurrentUserProfileResponse,
  type CachedUserProfile
} from "./user-profile.js";
export { redactSecrets } from "./auth.js";

if (isMainModule()) {
  void runCommand();
}

export async function runCommand(): Promise<void> {
  const command = process.argv[2] ?? "serve";
  if (command === "--version" || command === "-v") {
    process.stdout.write(`${LAUNCHER_VERSION}\n`);
    return;
  }
  try {
    const config = loadLauncherRuntimeConfig();
    if (command === "serve") return runMcpLauncherStdioServer(config);
    if (command === "logout") {
      const outcome = await createOfficialLauncherAuthentication(config).logout();
      process.stdout.write(formatLauncherCommandResult("logout", outcome));
      if (!outcome.localCredentialRemoved) process.exitCode = 1;
      return;
    }
    if (command === "self-check") {
      const result = await createOfficialLauncherAuthentication(config).selfCheck();
      process.stdout.write(formatLauncherCommandResult("self-check", result));
      if (!result.ok) process.exitCode = 1;
      return;
    }
  } catch {
    process.exitCode = 1;
    return;
  }
  process.exitCode = 2;
}

function isMainModule(): boolean {
  return (
    process.argv[1] !== undefined &&
    (fileURLToPath(import.meta.url) === process.argv[1] ||
      process.argv[1].endsWith("smedc-mcp-launcher"))
  );
}
