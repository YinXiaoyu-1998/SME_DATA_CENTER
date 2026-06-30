import { spawn } from "node:child_process";
import { mkdir, readFile, rm } from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const DEFAULT_MYSQL_PORT = "3307";
const DEFAULT_DATABASE_URL = (mysqlPort: string) =>
  `mysql://enterprise_hub:enterprise_hub_local_password@localhost:${mysqlPort}/enterprise_hub`;
const DEFAULT_JWT_SECRET = "replace-with-local-development-secret";

interface CommandResult {
  stdout: string;
  stderr: string;
}

interface StoredCliSession {
  accessToken: string;
}

interface UploadResponse {
  id: string;
  status: string;
}

interface DocumentListResponse {
  documents: Array<{
    id: string;
    title: string;
    status: string;
  }>;
}

interface DownloadResponse {
  id: string;
  downloadUrl: string;
}

interface WorkerResponse {
  processed: boolean;
  documentId?: string;
  status?: string;
}

const rootDir = process.cwd();
const mysqlPort = process.env["MYSQL_PORT"] ?? DEFAULT_MYSQL_PORT;
const integrationPort = process.env["HUB_INTEGRATION_PORT"] ?? String(await findAvailablePort());
const apiUrl = `http://127.0.0.1:${integrationPort}`;
const storageRoot = path.join(rootDir, ".data", "integration", "storage");
const sessionDir = path.join(rootDir, ".data", "integration", "sessions");
const baoliSessionFile = path.join(sessionDir, "baoli.json");
const suzhouSessionFile = path.join(sessionDir, "suzhou.json");

const integrationEnv: NodeJS.ProcessEnv = {
  ...process.env,
  MYSQL_PORT: mysqlPort,
  DATABASE_URL: process.env["DATABASE_URL"] ?? DEFAULT_DATABASE_URL(mysqlPort),
  JWT_SECRET: process.env["JWT_SECRET"] ?? DEFAULT_JWT_SECRET,
  STORAGE_DRIVER: "local",
  LOCAL_STORAGE_ROOT: storageRoot,
  HUB_API_URL: apiUrl,
  NODE_ENV: "development",
  HOST: "127.0.0.1",
  PORT: integrationPort
};

let apiProcess: ReturnType<typeof spawn> | null = null;

try {
  await prepareLocalWorkspace();
  await run("docker", ["compose", "up", "-d", "mysql"], { env: integrationEnv });
  await waitForMysqlHealth();
  await run("npm", ["run", "db:generate"], { env: integrationEnv });
  await run(
    "npx",
    ["prisma", "migrate", "reset", "--force", "--config", "packages/db/prisma.config.ts"],
    { env: integrationEnv }
  );
  await run("npm", ["run", "db:seed"], { env: integrationEnv });

  apiProcess = startApi();
  await waitForApiHealth(apiProcess);

  await runHub([
    "login",
    "--email",
    "baoli.manager@example.com",
    "--session-file",
    baoliSessionFile
  ]);
  const upload = parseJson<UploadResponse>(
    (
      await runHub([
        "documents",
        "upload",
        "./fixtures/baoli-june-meituan.csv",
        "--label",
        "store:baoli",
        "--title",
        "Integration Baoli June Meituan",
        "--source-system",
        "meituan",
        "--source-time",
        "2026-06-30T00:00:00.000Z",
        "--session-file",
        baoliSessionFile
      ])
    ).stdout
  );
  assert(upload.status === "pending_processing", "Uploaded document should start pending.");

  const worker = parseJson<WorkerResponse>(
    (await run("npm", ["--silent", "run", "worker:once"], { env: integrationEnv })).stdout
  );
  assert(worker.processed === true, "Worker should process one document.");
  assert(worker.documentId === upload.id, "Worker should process the uploaded document.");
  assert(worker.status === "active", "Worker should activate the uploaded document.");

  const baoliSearch = parseJson<DocumentListResponse>(
    (
      await runHub([
        "documents",
        "search",
        "Integration Baoli June Meituan",
        "--session-file",
        baoliSessionFile
      ])
    ).stdout
  );
  assert(
    baoliSearch.documents.some(
      (document) => document.id === upload.id && document.status === "active"
    ),
    "Baoli manager should find the active uploaded document."
  );

  await runHub([
    "login",
    "--email",
    "suzhou.manager@example.com",
    "--session-file",
    suzhouSessionFile
  ]);
  const suzhouSearch = parseJson<DocumentListResponse>(
    (
      await runHub([
        "documents",
        "search",
        "Integration Baoli June Meituan",
        "--session-file",
        suzhouSessionFile
      ])
    ).stdout
  );
  assert(
    suzhouSearch.documents.every((document) => document.id !== upload.id),
    "Suzhou manager must not receive the Baoli document."
  );

  const baoliToken = await readAccessToken(baoliSessionFile);
  const download = await apiJson<DownloadResponse>(`/documents/${upload.id}/download`, {
    headers: authorizationHeader(baoliToken)
  });
  assert(download.id === upload.id, "Download response should target the uploaded document.");
  assert(download.downloadUrl.startsWith("file://"), "Local download URL should be a file URL.");

  const archived = await apiJson<UploadResponse>(`/documents/${upload.id}/archive`, {
    method: "POST",
    headers: authorizationHeader(baoliToken)
  });
  assert(archived.status === "archived", "Archive should mark the document archived.");

  const afterArchiveSearch = parseJson<DocumentListResponse>(
    (
      await runHub([
        "documents",
        "search",
        "Integration Baoli June Meituan",
        "--session-file",
        baoliSessionFile
      ])
    ).stdout
  );
  assert(
    afterArchiveSearch.documents.every((document) => document.id !== upload.id),
    "Archived document should disappear from ordinary search."
  );

  console.log(
    JSON.stringify(
      {
        ok: true,
        documentId: upload.id,
        apiUrl,
        mysqlPort,
        proved: [
          "seed",
          "cli_login",
          "cli_upload",
          "worker_active",
          "baoli_search_visible",
          "suzhou_search_denied",
          "baoli_download",
          "archive_hidden"
        ]
      },
      null,
      2
    )
  );
} finally {
  if (apiProcess) {
    apiProcess.kill("SIGTERM");
  }
}

async function prepareLocalWorkspace(): Promise<void> {
  await rm(path.join(rootDir, ".data", "integration"), { recursive: true, force: true });
  await mkdir(sessionDir, { recursive: true });
}

function startApi(): ReturnType<typeof spawn> {
  const child = spawn("npm", ["run", "api:dev"], {
    cwd: rootDir,
    env: integrationEnv,
    stdio: ["ignore", "pipe", "pipe"]
  });

  return child;
}

async function waitForMysqlHealth(): Promise<void> {
  await waitForCondition("MySQL health", async () => {
    const result = await run(
      "docker",
      ["inspect", "-f", "{{.State.Health.Status}}", "enterprise-hub-mysql"],
      {
        env: integrationEnv,
        rejectOnFailure: false
      }
    );
    return result.stdout.trim() === "healthy";
  });
}

async function waitForApiHealth(child: ReturnType<typeof spawn>): Promise<void> {
  let logs = "";
  child.stdout?.on("data", (chunk: Buffer) => {
    logs += chunk.toString("utf8");
  });
  child.stderr?.on("data", (chunk: Buffer) => {
    logs += chunk.toString("utf8");
  });

  await waitForCondition("API health", async () => {
    if (child.exitCode !== null) {
      throw new Error(`API process exited early.\n${logs}`);
    }

    try {
      const response = await fetch(`${apiUrl}/healthz`);
      return response.ok;
    } catch {
      return false;
    }
  });
}

async function waitForCondition(name: string, condition: () => Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 60_000;

  while (Date.now() < deadline) {
    if (await condition()) {
      return;
    }

    await delay(1_000);
  }

  throw new Error(`${name} did not become ready before timeout.`);
}

async function runHub(args: string[]): Promise<CommandResult> {
  return run("npm", ["--silent", "run", "hub", "--", ...args, "--api-url", apiUrl], {
    env: integrationEnv
  });
}

async function run(
  command: string,
  args: string[],
  options: {
    env: NodeJS.ProcessEnv;
    rejectOnFailure?: boolean;
  }
): Promise<CommandResult> {
  const rejectOnFailure = options.rejectOnFailure ?? true;

  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: rootDir,
      env: options.env,
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", reject);
    child.on("close", (code) => {
      const result = { stdout, stderr };

      if (code !== 0 && rejectOnFailure) {
        reject(new Error(commandFailureMessage(command, args, code, result)));
        return;
      }

      resolve(result);
    });
  });
}

function commandFailureMessage(
  command: string,
  args: string[],
  code: number | null,
  result: CommandResult
): string {
  return [
    `Command failed (${code ?? "signal"}): ${command} ${args.join(" ")}`,
    result.stdout ? `stdout:\n${result.stdout}` : "",
    result.stderr ? `stderr:\n${result.stderr}` : ""
  ]
    .filter(Boolean)
    .join("\n\n");
}

function parseJson<T>(raw: string): T {
  return JSON.parse(raw) as T;
}

async function readAccessToken(sessionFile: string): Promise<string> {
  const session = parseJson<StoredCliSession>(await readFile(sessionFile, "utf8"));
  assert(
    typeof session.accessToken === "string" && session.accessToken.length > 0,
    "CLI session token missing."
  );
  return session.accessToken;
}

function authorizationHeader(token: string): HeadersInit {
  return {
    authorization: `Bearer ${token}`
  };
}

async function apiJson<T>(pathName: string, init: RequestInit): Promise<T> {
  const response = await fetch(`${apiUrl}${pathName}`, init);
  const body = (await response.json()) as T;

  if (!response.ok) {
    throw new Error(`API request failed: ${response.status} ${JSON.stringify(body)}`);
  }

  return body;
}

function assert(condition: boolean, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

async function findAvailablePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => {
        if (typeof address === "object" && address) {
          resolve(address.port);
          return;
        }

        reject(new Error("Unable to allocate an integration API port."));
      });
    });
  });
}
