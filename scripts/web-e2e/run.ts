/**
 * 一条命令跑完浏览器端到端：起 API、起同构静态站点、跑 Playwright、收尾。
 *
 * 依赖一个已经迁移并播种过的本地 MySQL（见 scripts/web-e2e/README.md），
 * 不负责创建数据库、不部署、不触碰远程环境。
 */
import { spawn, type ChildProcess } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { API_PORT, WEB_E2E_PORT, webE2eEnv } from "./env.js";

const databaseUrl = process.env["DATABASE_URL"];
const webDir = process.env["WEB_DIR"];
if (!databaseUrl) throw new Error("DATABASE_URL is required.");
if (!webDir) throw new Error("WEB_DIR must point at the built frontend (npm run build).");

const children: ChildProcess[] = [];

function start(
  command: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  stdio: "inherit" | "quiet" = "inherit"
): ChildProcess {
  const child = spawn(command, args, {
    env,
    // API 的请求日志会淹没 Playwright 输出，只保留 stderr 便于定位启动失败。
    stdio: stdio === "inherit" ? ["ignore", "inherit", "inherit"] : ["ignore", "ignore", "inherit"]
  });
  children.push(child);
  return child;
}

async function waitFor(url: string, label: string, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.status < 500) return;
    } catch {
      // 还没起来
    }
    await delay(300);
  }
  throw new Error(`${label} did not become ready at ${url}`);
}

function stopAll(): void {
  for (const child of children) {
    if (child.exitCode === null && !child.killed) child.kill("SIGTERM");
  }
}

let exitCode = 1;
try {
  const env = webE2eEnv(databaseUrl);
  start("npx", ["tsx", "apps/api/src/index.ts"], env, "quiet");
  await waitFor(`http://127.0.0.1:${API_PORT}/healthz`, "API");

  start("npx", ["tsx", "scripts/web-e2e/serve.ts"], {
    ...process.env,
    WEB_DIR: webDir,
    WEB_E2E_API_PORT: String(API_PORT),
    WEB_E2E_PORT: String(WEB_E2E_PORT)
  });
  await waitFor(`http://localhost:${WEB_E2E_PORT}/`, "web site");

  const playwright = spawn("npx", ["playwright", "test"], { stdio: "inherit" });
  exitCode = await new Promise<number>((resolve) => {
    playwright.on("exit", (code) => resolve(code ?? 1));
  });
} finally {
  stopAll();
}

process.exit(exitCode);
