/** 本地静态站点入口：浏览器端到端用它替代生产 Nginx。 */
import { startWebServer } from "./serve-web.js";

const webRoot = process.env["WEB_DIR"];
const apiPort = process.env["WEB_E2E_API_PORT"];
const port = process.env["WEB_E2E_PORT"];
if (!webRoot || !apiPort || !port) {
  throw new Error("WEB_DIR, WEB_E2E_API_PORT and WEB_E2E_PORT are required.");
}

const server = await startWebServer({ webRoot, apiPort: Number(apiPort), port: Number(port) });
process.stdout.write(`web site on http://127.0.0.1:${port} serving ${webRoot}\n`);
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    void server.close().then(() => process.exit(0));
  });
}
