import { spawn } from "node:child_process";
import { mkdir, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { createEnterpriseHubApiClient } from "../apps/mcp-server/src/api-client.js";
import type { McpRuntimeConfig } from "../apps/mcp-server/src/config.js";
import { createToolHandler } from "../apps/mcp-server/src/server.js";
import { LocalMcpSessionStore } from "../apps/mcp-server/src/session-store.js";
import type { McpJsonToolResult } from "../apps/mcp-server/src/tools.js";

const DEFAULT_MYSQL_PORT = "3307";
const DEFAULT_DATABASE_URL = (mysqlPort: string) =>
  `mysql://enterprise_hub:enterprise_hub_local_password@localhost:${mysqlPort}/enterprise_hub`;
const DEFAULT_JWT_SECRET = "replace-with-local-development-secret";
const BAOLI_TITLE = "MCP Smoke Baoli June Meituan";
const BAOLI_QUERY = BAOLI_TITLE;

interface CommandResult {
  stdout: string;
  stderr: string;
}

interface LoginToolResponse {
  sessionName: string;
  employee: {
    email: string;
  };
}

interface LabelsToolResponse {
  labels: Array<{
    key: string;
    name: string;
    type: string;
  }>;
}

interface DocumentResponse {
  id: string;
  title: string;
  status: string;
}

interface DocumentListResponse {
  documents: DocumentResponse[];
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

interface StructuredDatasetsResponse {
  datasets: Array<{ dataset: string }>;
}

interface StructuredQueryResponse {
  rows: Array<Record<string, unknown>>;
}

interface StructuredUploadResponse {
  importBatch: {
    importBatchId: string;
    dataset: string;
    status: string;
    appliedRowCount: number;
  };
}

interface EvidenceUploadResponse {
  document: {
    documentId: string;
    status: string;
  };
}

interface EvidenceSearchResponse {
  results: Array<{
    documentId: string;
    text: string;
  }>;
}

interface McpToolCaller {
  call: <T>(toolName: string, input: unknown) => Promise<T>;
  callExpectError: (toolName: string, input: unknown) => Promise<{ error?: { code?: string } }>;
}

const rootDir = process.cwd();
const mysqlPort = process.env["MYSQL_PORT"] ?? DEFAULT_MYSQL_PORT;
const mcpTestPort = process.env["HUB_MCP_TEST_PORT"] ?? String(await findAvailablePort());
const apiUrl = `http://127.0.0.1:${mcpTestPort}`;
const testRoot = path.join(rootDir, ".data", "mcp-local-test");
const storageRoot = path.join(testRoot, "storage");
const sessionFile = path.join(testRoot, "session.json");

const testEnv: NodeJS.ProcessEnv = {
  ...process.env,
  MYSQL_PORT: mysqlPort,
  DATABASE_URL: process.env["DATABASE_URL"] ?? DEFAULT_DATABASE_URL(mysqlPort),
  JWT_SECRET: process.env["JWT_SECRET"] ?? DEFAULT_JWT_SECRET,
  STORAGE_DRIVER: "local",
  LOCAL_STORAGE_ROOT: storageRoot,
  ENTERPRISE_HUB_API_URL: apiUrl,
  ENTERPRISE_HUB_MCP_SESSION_FILE: sessionFile,
  QDRANT_URL: process.env["QDRANT_URL"] ?? "http://127.0.0.1:6333",
  QDRANT_COLLECTION_EVIDENCE:
    process.env["QDRANT_COLLECTION_EVIDENCE"] ?? "enterprise_hub_evidence_local",
  RETRIEVAL_CONFIG_VERSION: process.env["RETRIEVAL_CONFIG_VERSION"] ?? "phase3.retrieval.v1",
  LLM_PROVIDER: process.env["LLM_PROVIDER"] ?? "fake",
  LLM_MODEL: process.env["LLM_MODEL"] ?? "fake-rerank",
  LLM_EMBEDDING_MODEL: process.env["LLM_EMBEDDING_MODEL"] ?? "fake-embedding",
  NODE_ENV: "development",
  HOST: "127.0.0.1",
  PORT: mcpTestPort
};

const mcpConfig: McpRuntimeConfig = {
  apiUrl,
  profile: "local-development",
  sessionFile,
  transport: "stdio"
};

let apiProcess: ReturnType<typeof spawn> | null = null;

try {
  await prepareLocalWorkspace();
  await run("docker", ["compose", "up", "-d", "mysql", "qdrant"], { env: testEnv });
  await waitForMysqlHealth();
  await run("npm", ["run", "db:generate"], { env: testEnv });
  await run(
    "npx",
    ["prisma", "migrate", "reset", "--force", "--config", "packages/db/prisma.config.ts"],
    { env: testEnv }
  );
  await run("npm", ["run", "db:seed"], { env: testEnv });
  await run("npm", ["run", "qdrant:init"], { env: testEnv });

  apiProcess = startApi();
  await waitForApiHealth(apiProcess);

  const tools = createMcpToolCaller();

  const baoliLogin = await tools.call<LoginToolResponse>("enterprise_hub_login_dev", {
    email: "baoli.manager@example.com",
    sessionName: "baoli"
  });
  assert(baoliLogin.sessionName === "baoli", "Baoli MCP login should use the named session.");
  assert(
    baoliLogin.employee.email === "baoli.manager@example.com",
    "Baoli MCP login should authenticate the seeded manager."
  );

  const labels = await tools.call<LabelsToolResponse>("enterprise_hub_list_labels", {
    sessionName: "baoli"
  });
  assert(
    labels.labels.some((label) => label.key === "store:baoli"),
    "MCP list-labels should include the Baoli store label."
  );

  const upload = await tools.call<DocumentResponse>("enterprise_hub_upload_document", {
    sessionName: "baoli",
    filePath: path.join(rootDir, "fixtures", "baoli-june-meituan.csv"),
    title: BAOLI_TITLE,
    documentType: "raw_material",
    sourceSystem: "meituan",
    sourceTime: "2026-06-30T00:00:00.000Z",
    labelKeys: ["store:baoli"]
  });
  assert(upload.status === "pending_processing", "MCP upload should create a pending document.");

  const pendingStatus = await tools.call<DocumentResponse>("enterprise_hub_get_document_status", {
    sessionName: "baoli",
    documentId: upload.id
  });
  assert(
    pendingStatus.status === "pending_processing",
    "MCP status should show the pending document before the worker pass."
  );

  const worker = parseJson<WorkerResponse>(
    (await run("npm", ["--silent", "run", "worker:once"], { env: testEnv })).stdout
  );
  assert(worker.processed === true, "Worker should process one MCP-uploaded document.");
  assert(worker.documentId === upload.id, "Worker should process the MCP-uploaded document.");
  assert(worker.status === "active", "Worker should activate the MCP-uploaded document.");

  await waitForMcpStatus(tools, upload.id, "active");

  const baoliSearch = await tools.call<DocumentListResponse>("enterprise_hub_search_documents", {
    sessionName: "baoli",
    q: BAOLI_QUERY
  });
  assert(
    baoliSearch.documents.some(
      (document) => document.id === upload.id && document.status === "active"
    ),
    "Baoli MCP search should find the active uploaded document."
  );

  const suzhouLogin = await tools.call<LoginToolResponse>("enterprise_hub_login_dev", {
    email: "suzhou.manager@example.com",
    sessionName: "suzhou"
  });
  assert(
    suzhouLogin.employee.email === "suzhou.manager@example.com",
    "Suzhou MCP login should authenticate the seeded manager."
  );

  const suzhouSearch = await tools.call<DocumentListResponse>("enterprise_hub_search_documents", {
    sessionName: "suzhou",
    q: BAOLI_QUERY
  });
  assert(
    suzhouSearch.documents.every((document) => document.id !== upload.id),
    "Suzhou MCP search must not return the Baoli document."
  );

  const suzhouDetailError = await tools.callExpectError("enterprise_hub_get_document", {
    sessionName: "suzhou",
    documentId: upload.id
  });
  assert(
    suzhouDetailError.error?.code === "DOCUMENT_NOT_FOUND",
    "Suzhou MCP detail should preserve the API not-found/inaccessible response."
  );
  assert(
    !JSON.stringify(suzhouDetailError).includes(BAOLI_TITLE),
    "Inaccessible MCP detail errors must not leak the hidden document title."
  );

  const download = await tools.call<DownloadResponse>("enterprise_hub_get_document_download_url", {
    sessionName: "baoli",
    documentId: upload.id
  });
  assert(download.id === upload.id, "MCP download response should target the uploaded document.");
  assert(
    download.downloadUrl.startsWith("file://"),
    "Local MCP download URL should be a file URL."
  );

  const archived = await tools.call<DocumentResponse>("enterprise_hub_archive_document", {
    sessionName: "baoli",
    documentId: upload.id
  });
  assert(archived.status === "archived", "MCP archive should mark the document archived.");

  const afterArchiveSearch = await tools.call<DocumentListResponse>(
    "enterprise_hub_search_documents",
    {
      sessionName: "baoli",
      q: BAOLI_QUERY
    }
  );
  assert(
    afterArchiveSearch.documents.every((document) => document.id !== upload.id),
    "Archived document should disappear from ordinary MCP search."
  );

  const structuredDatasets = await tools.call<StructuredDatasetsResponse>(
    "list_structured_datasets",
    {
      sessionName: "baoli"
    }
  );
  assert(
    structuredDatasets.datasets.some((dataset) => dataset.dataset === "dishes"),
    "MCP structured dataset discovery should expose dishes."
  );

  const structuredUpload = await tools.call<StructuredUploadResponse>("upload_structured_dataset", {
    sessionName: "baoli",
    filePath: path.join(rootDir, "fixtures", "structured", "dishes-valid.csv"),
    dataset: "dishes",
    enterpriseName: "MCP Smoke",
    startDate: "20260701",
    endDate: "20260705",
    idempotencyKey: `mcp-phase3-${Date.now()}`,
    labelKeys: ["store:baoli"]
  });
  assert(
    structuredUpload.importBatch.status === "applied",
    "MCP structured upload should return an applied import batch."
  );
  assert(
    structuredUpload.importBatch.appliedRowCount === 1,
    "MCP structured upload should import the fixture row."
  );

  const importStatus = await tools.call<StructuredUploadResponse>("get_import_status", {
    sessionName: "baoli",
    importBatchId: structuredUpload.importBatch.importBatchId
  });
  assert(
    importStatus.importBatch.status === "applied",
    "MCP import status should read the applied structured import."
  );

  const structuredQuery = await tools.call<StructuredQueryResponse>("query_structured_dataset", {
    sessionName: "baoli",
    dataset: "dishes",
    aggregates: [{ op: "count", as: "row_count" }],
    page: { limit: 1 }
  });
  assert(
    structuredQuery.rows[0]?.["row_count"] === 1,
    "MCP structured query should return the imported row count."
  );

  const evidencePath = path.join(testRoot, "phase3-evidence.md");
  await writeFile(
    evidencePath,
    "# 差评处理 SOP\n\n差评处理需要在 15 分钟内联系顾客，记录订单号、原因和补偿动作。\n",
    "utf8"
  );
  const evidenceUpload = await tools.call<EvidenceUploadResponse>("upload_evidence_document", {
    sessionName: "baoli",
    filePath: evidencePath,
    title: "MCP Phase 3 差评处理 SOP",
    sourceSystem: "mcp_phase3_smoke",
    labelKeys: ["store:baoli"]
  });
  assert(
    evidenceUpload.document.status === "pending_processing",
    "MCP evidence upload should create a pending evidence document."
  );

  const evidenceWorker = parseJson<WorkerResponse>(
    (await run("npm", ["--silent", "run", "worker:once"], { env: testEnv })).stdout
  );
  assert(
    evidenceWorker.documentId === evidenceUpload.document.documentId,
    "Worker should process the MCP evidence upload."
  );
  assert(evidenceWorker.status === "active", "Worker should activate the MCP evidence upload.");
  await waitForMcpStatus(tools, evidenceUpload.document.documentId, "active");

  const evidenceSearch = await tools.call<EvidenceSearchResponse>("search_document_evidence", {
    sessionName: "baoli",
    query: "差评处理",
    filters: { fileTypes: ["md"] },
    limit: 5
  });
  assert(
    evidenceSearch.results.some(
      (result) =>
        result.documentId === evidenceUpload.document.documentId && result.text.includes("差评处理")
    ),
    "MCP evidence search should return evidence chunks without generating an answer."
  );

  console.log(
    JSON.stringify(
      {
        ok: true,
        documentId: upload.id,
        structuredImportBatchId: structuredUpload.importBatch.importBatchId,
        evidenceDocumentId: evidenceUpload.document.documentId,
        apiUrl,
        mysqlPort,
        proved: [
          "mcp_login_baoli",
          "mcp_list_labels",
          "mcp_upload",
          "mcp_status_pending",
          "worker_active",
          "mcp_search_baoli_visible",
          "mcp_login_suzhou",
          "mcp_search_suzhou_hidden",
          "mcp_detail_suzhou_not_found_without_title",
          "mcp_download_url",
          "mcp_archive_hidden",
          "mcp_phase3_structured_dataset_discovery",
          "mcp_phase3_structured_upload_status",
          "mcp_phase3_structured_query",
          "mcp_phase3_evidence_upload_index_search"
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
  await rm(testRoot, { recursive: true, force: true });
  await mkdir(testRoot, { recursive: true });
}

function createMcpToolCaller(): McpToolCaller {
  const dependencies = {
    apiClient: createEnterpriseHubApiClient(mcpConfig),
    config: mcpConfig,
    sessionStore: new LocalMcpSessionStore(sessionFile)
  };

  return {
    async call<T>(toolName: string, input: unknown) {
      const result = await createToolHandler(toolName, dependencies)(input);
      const payload = parseToolResult<T>(result);

      if (result.isError) {
        throw new Error(`MCP tool ${toolName} failed: ${JSON.stringify(payload)}`);
      }

      return payload;
    },
    async callExpectError(toolName: string, input: unknown) {
      const result = await createToolHandler(toolName, dependencies)(input);
      const payload = parseToolResult<{ error?: { code?: string } }>(result);

      if (!result.isError) {
        throw new Error(`MCP tool ${toolName} unexpectedly succeeded: ${JSON.stringify(payload)}`);
      }

      return payload;
    }
  };
}

async function waitForMcpStatus(
  tools: McpToolCaller,
  documentId: string,
  expectedStatus: string
): Promise<void> {
  await waitForCondition(`MCP document status ${expectedStatus}`, async () => {
    const status = await tools.call<DocumentResponse>("enterprise_hub_get_document_status", {
      sessionName: "baoli",
      documentId
    });

    return status.status === expectedStatus;
  });
}

function startApi(): ReturnType<typeof spawn> {
  return spawn("npm", ["run", "api:dev"], {
    cwd: rootDir,
    env: testEnv,
    stdio: ["ignore", "pipe", "pipe"]
  });
}

async function waitForMysqlHealth(): Promise<void> {
  await waitForCondition("MySQL health", async () => {
    const result = await run(
      "docker",
      ["inspect", "-f", "{{.State.Health.Status}}", "enterprise-hub-mysql"],
      {
        env: testEnv,
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

function parseToolResult<T>(result: McpJsonToolResult): T {
  const text = result.content[0]?.text;
  assert(typeof text === "string", "MCP tool result should contain JSON text.");
  return parseJson<T>(text);
}

function parseJson<T>(raw: string): T {
  return JSON.parse(raw) as T;
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

        reject(new Error("Unable to allocate an MCP smoke API port."));
      });
    });
  });
}
