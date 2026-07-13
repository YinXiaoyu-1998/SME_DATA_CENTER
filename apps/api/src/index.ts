import { loadApiEnv } from "./env.js";
import { resolvePhase3ServiceListenHost } from "./mcp/guards.js";
import { buildApiServer } from "./server.js";

loadApiEnv();

const port = Number(process.env["PORT"] ?? 3000);
const host = resolvePhase3ServiceListenHost();

const app = buildApiServer();

try {
  await app.listen({ port, host });
} catch (error) {
  app.log.error(error);
  process.exitCode = 1;
}

export { buildApiServer };
