import { loadMcpRuntimeConfig } from "./config.js";
import { runMcpStdioServer } from "./server.js";

try {
  await runMcpStdioServer(loadMcpRuntimeConfig());
} catch (error) {
  process.stderr.write(`enterprise-hub-mcp startup failed: ${errorToMessage(error)}\n`);
  process.exitCode = 1;
}

function errorToMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
