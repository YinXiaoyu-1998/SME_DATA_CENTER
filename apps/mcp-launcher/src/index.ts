#!/usr/bin/env node
import { fileURLToPath } from "node:url";
import { loadLauncherRuntimeConfig } from "./config.js";
import { createOfficialLauncherAuthentication } from "./launcher.js";
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
  createEnterpriseHubMcpLauncherServer,
  runMcpLauncherStdioServer
} from "./server.js";
export {
  LAUNCHER_BOOTSTRAP_TOOL_NAMES,
  createOfficialLauncherAuthentication,
  createLauncherToolDependencies,
  createLauncherToolHandler,
  registerLauncherTools,
  type LauncherBootstrapToolName,
  type LauncherAuthentication,
  type LauncherToolDependencies,
  type LauncherToolName,
  type LauncherToolRegistrar
} from "./launcher.js";
export { LauncherSession, LauncherTypedError, type LauncherErrorCode } from "./session.js";
export { createAuthorizationRequest, createLoopbackCallbackServer, redactSecrets } from "./auth.js";

if (isMainModule()) {
  void runCommand();
}

async function runCommand(): Promise<void> {
  const command = process.argv[2] ?? "serve";
  if (command === "--version" || command === "-v") {
    process.stdout.write("0.1.0\n");
    return;
  }
  try {
    const config = loadLauncherRuntimeConfig();
    if (command === "serve") return runMcpLauncherStdioServer(config);
    if (command === "logout") return createOfficialLauncherAuthentication(config).logout();
    if (command === "self-check") {
      await createOfficialLauncherAuthentication(config).status();
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
      process.argv[1].endsWith("enterprise-hub-mcp-launcher"))
  );
}
