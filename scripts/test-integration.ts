import { spawn } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
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

interface LoginResponse {
  accessToken: string;
  employee: { email: string };
}

interface WorkerResponse {
  processed: boolean;
  documentId?: string;
  status?: string;
}

interface StructuredUploadResponse {
  importBatch: {
    importBatchId: string;
    status: string;
    appliedRowCount: number;
  };
}

interface StructuredQueryResponse {
  rows: Array<Record<string, unknown>>;
}

interface EvidenceUploadResponse {
  document: {
    documentId: string;
    status: string;
  };
}

interface EvidenceStatusResponse {
  document: {
    documentId: string;
    status: string;
  };
  documentIndex: {
    status: string;
  };
}

interface EvidenceSearchResponse {
  results: Array<{
    documentId: string;
    text: string;
  }>;
}

const rootDir = process.cwd();
const mysqlPort = process.env["MYSQL_PORT"] ?? DEFAULT_MYSQL_PORT;
const integrationPort = optionalEnv("HUB_INTEGRATION_PORT") ?? String(await findAvailablePort());
const apiUrl = `http://127.0.0.1:${integrationPort}`;
const integrationRoot = path.join(rootDir, ".data", "integration");
const storageRoot = path.join(integrationRoot, "storage");

const integrationEnv: NodeJS.ProcessEnv = {
  ...process.env,
  MYSQL_PORT: mysqlPort,
  DATABASE_URL: process.env["DATABASE_URL"] ?? DEFAULT_DATABASE_URL(mysqlPort),
  JWT_SECRET: process.env["JWT_SECRET"] ?? DEFAULT_JWT_SECRET,
  STORAGE_DRIVER: "local",
  LOCAL_STORAGE_ROOT: storageRoot,
  QDRANT_URL: process.env["QDRANT_URL"] ?? "http://127.0.0.1:6333",
  QDRANT_COLLECTION_EVIDENCE:
    process.env["QDRANT_COLLECTION_EVIDENCE"] ?? "enterprise_hub_evidence_integration",
  RETRIEVAL_CONFIG_VERSION: process.env["RETRIEVAL_CONFIG_VERSION"] ?? "phase3.retrieval.v1",
  LLM_PROVIDER: process.env["LLM_PROVIDER"] ?? "fake",
  LLM_MODEL: process.env["LLM_MODEL"] ?? "fake-rerank",
  LLM_EMBEDDING_MODEL: process.env["LLM_EMBEDDING_MODEL"] ?? "fake-embedding",
  LLM_EMBEDDING_DIMENSION: process.env["LLM_EMBEDDING_DIMENSION"] ?? "",
  RERANK_PROVIDER: process.env["RERANK_PROVIDER"] ?? "fake",
  DASHSCOPE_API_KEY:
    optionalEnv("DASHSCOPE_API_KEY") ?? process.env["OPENAI_COMPATIBLE_API_KEY"] ?? "",
  DASHSCOPE_API_BASE_URL: process.env["DASHSCOPE_API_BASE_URL"] ?? "",
  EXTERNAL_MODEL_EGRESS_ACKNOWLEDGED: process.env["EXTERNAL_MODEL_EGRESS_ACKNOWLEDGED"] ?? "false",
  NODE_ENV: "development",
  HOST: "127.0.0.1",
  PORT: integrationPort
};

let apiProcess: ReturnType<typeof spawn> | null = null;

try {
  await prepareLocalWorkspace();
  await run("docker", ["compose", "up", "-d", "mysql", "qdrant"], { env: integrationEnv });
  await waitForMysqlHealth();
  await run("npm", ["run", "db:generate"], { env: integrationEnv });
  await run(
    "npx",
    ["prisma", "migrate", "reset", "--force", "--config", "packages/db/prisma.config.ts"],
    { env: integrationEnv }
  );
  await run("npm", ["run", "db:seed"], { env: integrationEnv });
  await run("npm", ["run", "qdrant:init"], { env: integrationEnv });

  apiProcess = startApi();
  await waitForApiHealth(apiProcess);

  const login = await apiJson<LoginResponse>("/auth/dev-login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: "baoli.manager@example.com" })
  });
  assert(
    login.employee.email === "baoli.manager@example.com",
    "Dev login should authenticate Baoli manager."
  );
  const auth = authorizationHeader(login.accessToken);

  const adminLogin = await apiJson<LoginResponse>("/auth/dev-login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: "admin@example.com" })
  });
  const adminAuth = authorizationHeader(adminLogin.accessToken);

  const structuredForm = new FormData();
  structuredForm.append(
    "file",
    new Blob([await readFile(path.join(rootDir, "fixtures", "structured", "dishes-valid.csv"))]),
    "dishes-valid.csv"
  );
  structuredForm.append("dataset", "dishes");
  structuredForm.append("enterprise_name", "Integration Smoke");
  structuredForm.append("startDate", "20260701");
  structuredForm.append("endDate", "20260705");
  structuredForm.append("idempotencyKey", `integration-${Date.now()}`);
  structuredForm.append("labelKeys[]", "store:baoli");
  const structuredUpload = await apiJson<StructuredUploadResponse>("/v1/structured/imports", {
    method: "POST",
    headers: auth,
    body: structuredForm
  });
  assert(structuredUpload.importBatch.status === "applied", "Structured import should apply.");
  assert(
    structuredUpload.importBatch.appliedRowCount === 1,
    "Structured import should load one fixture row."
  );

  const structuredQuery = await apiJson<StructuredQueryResponse>("/v1/structured/query", {
    method: "POST",
    headers: { ...auth, "content-type": "application/json" },
    body: JSON.stringify({ dataset: "dishes", aggregates: [{ op: "count", as: "row_count" }] })
  });
  assert(
    structuredQuery.rows[0]?.["row_count"] === 1,
    "Structured query should return imported row count."
  );

  const allStaffStructuredForm = new FormData();
  allStaffStructuredForm.append(
    "file",
    new Blob([
      await readFile(
        path.join(
          rootDir,
          "fixtures",
          "structured",
          "maijia_business_20260706_20260712_first1000.xlsx"
        )
      )
    ]),
    "maijia_business_20260706_20260712_first1000.xlsx"
  );
  allStaffStructuredForm.append("dataset", "business");
  allStaffStructuredForm.append("enterprise_name", "Integration All Staff");
  allStaffStructuredForm.append("startDate", "20260706");
  allStaffStructuredForm.append("endDate", "20260712");
  allStaffStructuredForm.append("idempotencyKey", `integration-all-staff-${Date.now()}`);
  allStaffStructuredForm.append("labelKeys[]", "all_staff");
  const allStaffStructuredUpload = await apiJson<StructuredUploadResponse>(
    "/v1/structured/imports",
    {
      method: "POST",
      headers: adminAuth,
      body: allStaffStructuredForm
    }
  );
  assert(
    allStaffStructuredUpload.importBatch.status === "applied" &&
      allStaffStructuredUpload.importBatch.appliedRowCount > 0,
    "Admin should import the all_staff structured fixture."
  );

  const allStaffStructuredQuery = await apiJson<StructuredQueryResponse>("/v1/structured/query", {
    method: "POST",
    headers: { ...auth, "content-type": "application/json" },
    body: JSON.stringify({ dataset: "business", aggregates: [{ op: "count", as: "row_count" }] })
  });
  assert(
    Number(allStaffStructuredQuery.rows[0]?.["row_count"]) > 0,
    "A non-admin should query the imported all_staff row."
  );

  const suzhouLogin = await apiJson<LoginResponse>("/auth/dev-login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: "suzhou.manager@example.com" })
  });
  const inaccessibleImportStatus = await fetch(
    `${apiUrl}/v1/structured/imports/${encodeURIComponent(structuredUpload.importBatch.importBatchId)}`,
    { headers: authorizationHeader(suzhouLogin.accessToken) }
  );
  const inaccessibleImportBody = (await inaccessibleImportStatus.json()) as {
    error?: { code?: string; message?: string };
  };
  assert(
    inaccessibleImportStatus.status === 404 &&
      inaccessibleImportBody.error?.code === "IMPORT_BATCH_NOT_FOUND" &&
      inaccessibleImportBody.error.message === "Import batch not found.",
    "An inaccessible same-org import status must be non-enumerating."
  );

  const evidencePath = path.join(integrationRoot, "phase3-evidence.md");
  await writeFile(
    evidencePath,
    "# 差评处理 SOP\n\n差评处理需要在 15 分钟内联系顾客，记录订单号、原因和补偿动作。\n",
    "utf8"
  );
  const evidenceForm = new FormData();
  evidenceForm.append("file", new Blob([await readFile(evidencePath)]), "phase3-evidence.md");
  evidenceForm.append("title", "Integration Phase 3 差评处理 SOP");
  evidenceForm.append("sourceSystem", "integration_smoke");
  evidenceForm.append("labelKeys[]", "store:baoli");
  const evidenceUpload = await apiJson<EvidenceUploadResponse>("/v1/documents/evidence", {
    method: "POST",
    headers: auth,
    body: evidenceForm
  });
  assert(
    evidenceUpload.document.status === "pending_processing",
    "Evidence upload should start pending."
  );

  const worker = parseJson<WorkerResponse>(
    (await run("npm", ["--silent", "run", "worker:once"], { env: integrationEnv })).stdout
  );
  assert(
    worker.documentId === evidenceUpload.document.documentId,
    "Worker should process evidence upload."
  );
  assert(worker.status === "active", "Worker should activate evidence upload.");

  await waitForEvidenceStatus(evidenceUpload.document.documentId, auth);
  const evidenceSearch = await apiJson<EvidenceSearchResponse>("/v1/evidence/search", {
    method: "POST",
    headers: { ...auth, "content-type": "application/json" },
    body: JSON.stringify({ query: "差评处理", filters: { fileTypes: ["md"] }, limit: 5 })
  });
  assert(
    evidenceSearch.results.some(
      (result) =>
        result.documentId === evidenceUpload.document.documentId && result.text.includes("差评处理")
    ),
    "Evidence search should return indexed evidence chunks."
  );

  console.log(
    JSON.stringify(
      {
        ok: true,
        structuredImportBatchId: structuredUpload.importBatch.importBatchId,
        evidenceDocumentId: evidenceUpload.document.documentId,
        apiUrl,
        mysqlPort,
        proved: [
          "seed",
          "api_login",
          "phase3_structured_import",
          "phase3_structured_query",
          "phase3_structured_all_staff_import",
          "phase3_structured_all_staff_query",
          "phase3_structured_import_status_non_enumeration",
          "phase3_evidence_upload_worker_status_search"
        ]
      },
      null,
      2
    )
  );
} finally {
  if (apiProcess) {
    await stopApi(apiProcess);
  }
}

async function prepareLocalWorkspace(): Promise<void> {
  await rm(integrationRoot, { recursive: true, force: true });
  await mkdir(integrationRoot, { recursive: true });
}

function startApi(): ReturnType<typeof spawn> {
  const child = spawn(process.execPath, ["--import", "tsx", "apps/api/src/index.ts"], {
    cwd: rootDir,
    env: integrationEnv,
    stdio: ["ignore", "pipe", "pipe"]
  });

  return child;
}

async function stopApi(child: ReturnType<typeof spawn>): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return;
  }

  await new Promise<void>((resolve) => {
    const forceKillTimer = setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
      }
    }, 5_000);
    forceKillTimer.unref();

    child.once("close", () => {
      clearTimeout(forceKillTimer);
      resolve();
    });

    child.kill("SIGTERM");
  });
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

async function waitForEvidenceStatus(documentId: string, headers: HeadersInit): Promise<void> {
  await waitForCondition("Evidence status ready", async () => {
    const status = await apiJson<EvidenceStatusResponse>(
      `/v1/documents/evidence/${encodeURIComponent(documentId)}/status`,
      { headers }
    );
    return status.document.status === "active" && status.documentIndex.status === "ready";
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

function optionalEnv(key: string): string | undefined {
  const value = process.env[key]?.trim();
  return value ? value : undefined;
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
