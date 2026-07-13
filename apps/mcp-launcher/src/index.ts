import { fileURLToPath } from "node:url";
import { loadLauncherRuntimeConfig } from "./config.js";
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
  MemoryLauncherSession,
  createLauncherToolDependencies,
  createLauncherToolHandler,
  registerLauncherTools,
  type LauncherBootstrapToolName,
  type LauncherEmployeeIdentity,
  type LauncherToolDependencies,
  type LauncherToolName,
  type LauncherToolRegistrar
} from "./launcher.js";

if (isMainModule()) {
  runMcpLauncherStdioServer(loadLauncherRuntimeConfig()).catch(() => {
    console.error("Enterprise Hub MCP launcher failed.");
    process.exitCode = 1;
  });
}

function isMainModule(): boolean {
  return process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1];
}
