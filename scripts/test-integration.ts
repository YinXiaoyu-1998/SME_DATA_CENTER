import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { PrismaMariaDb } from "@prisma/adapter-mariadb";
import {
  DocumentKind,
  DocumentStatus,
  DocumentType,
  FileType,
  PrismaClient,
  ProcessingJobType,
  ProcessingRunStatus
} from "@prisma/client";
import { createPrismaStructuredImportRepository } from "../apps/api/src/structured-imports.js";
import { createPrismaProcessingWorkerRepository } from "../apps/worker/src/worker.js";
import { createOriginalObjectKey, LocalFileSystemStorageAdapter } from "@enterprise-hub/storage";

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
  document: {
    documentId: string;
    storageObjectKey: string;
    status: string;
  };
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
    chunkId: string;
    documentId: string;
    text: string;
  }>;
  page: {
    nextCursor: string | null;
    hasMore: boolean;
  };
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

  const structuredFixture = await readFile(
    path.join(rootDir, "fixtures", "structured", "dishes-valid.csv")
  );
  const structuredIdempotencyKey = `integration-${Date.now()}`;
  const structuredFormFor = (content: Buffer, idempotencyKey: string) => {
    const form = new FormData();
    form.append("file", new Blob([new Uint8Array(content)]), "dishes-valid.csv");
    form.append("dataset", "dishes");
    form.append("enterprise_name", "Integration Smoke");
    form.append("startDate", "20260701");
    form.append("endDate", "20260705");
    form.append("idempotencyKey", idempotencyKey);
    form.append("labelKeys[]", "store:baoli");
    return form;
  };
  const structuredUploads = await Promise.all(
    Array.from({ length: 10 }, async () => {
      return apiJson<StructuredUploadResponse>("/v1/structured/imports", {
        method: "POST",
        headers: auth,
        body: structuredFormFor(structuredFixture, structuredIdempotencyKey)
      });
    })
  );
  const structuredUpload = structuredUploads[0]!;
  for (const replay of structuredUploads) {
    assert(
      replay.document.documentId === structuredUpload.document.documentId &&
        replay.document.storageObjectKey === structuredUpload.document.storageObjectKey &&
        replay.document.status === structuredUpload.document.status &&
        replay.importBatch.importBatchId === structuredUpload.importBatch.importBatchId &&
        replay.importBatch.status === structuredUpload.importBatch.status,
      "Concurrent exact replays must return the authoritative persisted identifiers and status."
    );
  }
  await assertStructuredReplayCardinality(structuredIdempotencyKey, structuredUpload);
  const fingerprintConflict = await fetch(`${apiUrl}/v1/structured/imports`, {
    method: "POST",
    headers: auth,
    body: structuredFormFor(
      Buffer.from(structuredFixture.toString("utf8").replace("合成菜品", "冲突菜品"), "utf8"),
      structuredIdempotencyKey
    )
  });
  const windowConflict = await fetch(`${apiUrl}/v1/structured/imports`, {
    method: "POST",
    headers: auth,
    body: structuredFormFor(structuredFixture, `${structuredIdempotencyKey}-window-conflict`)
  });
  const conflictBodies = (await Promise.all([
    fingerprintConflict.json(),
    windowConflict.json()
  ])) as Array<{ error?: { code?: string } }>;
  const fingerprintConflictBody = conflictBodies[0]!;
  const windowConflictBody = conflictBodies[1]!;
  assert(
    fingerprintConflict.status === 409 &&
      fingerprintConflictBody.error?.code === "IDEMPOTENCY_KEY_CONFLICT",
    "A changed exact-replay fingerprint must conflict before publication."
  );
  assert(
    windowConflict.status === 409 && windowConflictBody.error?.code === "ACTIVE_IMPORT_EXISTS",
    "A second idempotency key for an active window must conflict before publication."
  );
  await assertStructuredReplayCardinality(structuredIdempotencyKey, structuredUpload);
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
  await assertTypedStructuredQuerySemantics(
    auth,
    structuredUpload.importBatch.importBatchId,
    structuredUpload.document.documentId
  );
  await assertStructuredRecoveryPaths();

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
  const longEvidenceParagraph =
    "差评处理需要在 15 分钟内联系顾客，记录订单号、原因和补偿动作。".repeat(80);
  await writeFile(
    evidencePath,
    `# 差评处理 SOP\n\n${longEvidenceParagraph}\n\n## 复盘\n\n${longEvidenceParagraph}\n`,
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
  const firstEvidencePage = await apiJson<EvidenceSearchResponse>("/v1/evidence/search", {
    method: "POST",
    headers: { ...auth, "content-type": "application/json" },
    body: JSON.stringify({ query: "差评处理", filters: { fileTypes: ["md"] }, limit: 1 })
  });
  assert(
    firstEvidencePage.results.length === 1 && Boolean(firstEvidencePage.page.nextCursor),
    "Evidence search should return a signed cursor when more authorized chunks remain."
  );
  const secondEvidencePage = await apiJson<EvidenceSearchResponse>("/v1/evidence/search", {
    method: "POST",
    headers: { ...auth, "content-type": "application/json" },
    body: JSON.stringify({
      query: "差评处理",
      filters: { fileTypes: ["md"] },
      limit: 1,
      cursor: firstEvidencePage.page.nextCursor
    })
  });
  assert(
    secondEvidencePage.results.length === 1 &&
      secondEvidencePage.results[0]?.chunkId !== firstEvidencePage.results[0]?.chunkId,
    "Evidence cursor pagination should advance without duplicate chunks."
  );
  await assertWorkerLeaseRecovery();

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
          "phase3_structured_concurrent_exact_replay",
          "phase3_structured_storage_and_apply_recovery",
          "phase3_structured_typed_query",
          "phase3_structured_query",
          "phase3_structured_all_staff_import",
          "phase3_structured_all_staff_query",
          "phase3_structured_import_status_non_enumeration",
          "phase3_evidence_upload_worker_status_search",
          "phase3_evidence_signed_pagination",
          "phase3_worker_lease_crash_recovery"
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

async function assertStructuredReplayCardinality(
  idempotencyKey: string,
  response: StructuredUploadResponse
): Promise<void> {
  const adapter = new PrismaMariaDb(integrationEnv["DATABASE_URL"]!);
  const prisma = new PrismaClient({ adapter });
  try {
    const batch = await prisma.importBatch.findUnique({
      where: {
        orgId_idempotencyKey: {
          orgId: "default-org",
          idempotencyKey
        }
      }
    });
    assert(batch?.id === response.importBatch.importBatchId, "One authoritative batch must exist.");
    const [documents, batches, claims, rows, startedAudits, appliedAudits, processingRuns] =
      await Promise.all([
        prisma.document.count({ where: { id: response.document.documentId } }),
        prisma.importBatch.count({ where: { orgId: "default-org", idempotencyKey } }),
        prisma.importWindowClaim.count({
          where: { importBatchId: response.importBatch.importBatchId }
        }),
        prisma.dishRow.count({ where: { importBatchId: response.importBatch.importBatchId } }),
        prisma.auditLog.count({
          where: {
            targetId: response.importBatch.importBatchId,
            action: "structured_import.started"
          }
        }),
        prisma.auditLog.count({
          where: {
            targetId: response.importBatch.importBatchId,
            action: "structured_import.applied"
          }
        }),
        prisma.processingRun.count({ where: { documentId: response.document.documentId } })
      ]);
    assert(documents === 1, "Concurrent replay must create one Document.");
    assert(batches === 1, "Concurrent replay must create one ImportBatch.");
    assert(claims === 1, "Concurrent replay must create one ImportWindowClaim.");
    assert(rows === 1, "Concurrent replay must create one row set.");
    assert(startedAudits === 1, "Concurrent replay must create one started audit.");
    assert(appliedAudits === 1, "Concurrent replay must create one applied audit.");
    assert(processingRuns === 1, "Concurrent replay must create one successful ProcessingRun.");

    const storageEntries = await readdir(storageRoot, { recursive: true, withFileTypes: true });
    const storedObjects = storageEntries.filter(
      (entry) => entry.isFile() && !entry.name.endsWith(".metadata.json")
    );
    assert(storedObjects.length === 1, "Concurrent replay must publish one storage object key.");
  } finally {
    await prisma.$disconnect();
  }
}

async function assertTypedStructuredQuerySemantics(
  auth: HeadersInit,
  importBatchId: string,
  sourceDocumentId: string
): Promise<void> {
  const prisma = new PrismaClient({ adapter: new PrismaMariaDb(integrationEnv["DATABASE_URL"]!) });
  try {
    await prisma.dishRow.createMany({
      data: [
        typedDishRow(importBatchId, sourceDocumentId, 1001, "typed-2", "2"),
        typedDishRow(importBatchId, sourceDocumentId, 1002, "typed-10", "10"),
        typedDishRow(importBatchId, sourceDocumentId, 1003, "typed-100", "100"),
        typedDishRow(importBatchId, sourceDocumentId, 1004, "typed--1", "-1"),
        typedDishRow(importBatchId, sourceDocumentId, 1005, "typed-0.5", "0.5")
      ]
    });

    const sorted = await apiJson<StructuredQueryResponse>("/v1/structured/query", {
      method: "POST",
      headers: { ...auth, "content-type": "application/json" },
      body: JSON.stringify({
        dataset: "dishes",
        select: ["matched_product_name", "dish_sales_quantity"],
        filter: {
          field: "matched_product_name",
          op: "starts_with",
          value: "typed-"
        },
        sort: [{ field: "dish_sales_quantity", direction: "asc" }],
        page: { limit: 10 }
      })
    });
    assert(
      sorted.rows.map((row) => row["matched_product_name"]).join(",") ===
        "typed--1,typed-0.5,typed-2,typed-10,typed-100",
      "Numeric sort must use mathematical order, not string order."
    );

    const aggregate = await apiJson<StructuredQueryResponse>("/v1/structured/query", {
      method: "POST",
      headers: { ...auth, "content-type": "application/json" },
      body: JSON.stringify({
        dataset: "dishes",
        filter: {
          field: "matched_product_name",
          op: "starts_with",
          value: "typed-"
        },
        aggregates: [
          { op: "min", field: "dish_sales_quantity", as: "min_quantity" },
          { op: "max", field: "dish_sales_quantity", as: "max_quantity" },
          { op: "sum", field: "dish_sales_quantity", as: "sum_quantity" },
          { op: "avg", field: "dish_sales_quantity", as: "avg_quantity" }
        ]
      })
    });
    const row = aggregate.rows[0] ?? {};
    assert(Number(row["min_quantity"]) === -1, "Numeric min must be mathematical.");
    assert(Number(row["max_quantity"]) === 100, "Numeric max must be mathematical.");
    assert(Number(row["sum_quantity"]) === 111.5, "Numeric sum must be mathematical.");
    assert(
      Math.abs(Number(row["avg_quantity"]) - 22.3) < 0.000001,
      "Numeric avg must be mathematical."
    );
  } finally {
    await prisma.$disconnect();
  }
}

function typedDishRow(
  importBatchId: string,
  sourceDocumentId: string,
  sourceRowNumber: number,
  matchedProductName: string,
  dishSalesQuantity: string
) {
  return {
    orgId: "default-org",
    sourceDocumentId,
    importBatchId,
    sourceRowNumber,
    payload: {
      business_date: "2026-07-03",
      matched_product_name: matchedProductName,
      dish_sales_quantity: dishSalesQuantity
    }
  };
}

async function assertStructuredRecoveryPaths(): Promise<void> {
  const databaseUrl = integrationEnv["DATABASE_URL"]!;
  const prisma = new PrismaClient({ adapter: new PrismaMariaDb(databaseUrl) });
  const repository = createPrismaStructuredImportRepository({
    databaseUrl,
    transactionTimeoutMs: 60_000,
    batchInsertSize: 500
  });
  const storage = new LocalFileSystemStorageAdapter({ root: storageRoot });
  try {
    const [employee, label] = await Promise.all([
      prisma.employee.findFirst({
        where: { orgId: "default-org", email: "baoli.manager@example.com" }
      }),
      prisma.label.findUnique({
        where: { orgId_key: { orgId: "default-org", key: "store:baoli" } }
      })
    ]);
    assert(Boolean(employee && label), "Recovery integration prerequisites must be seeded.");

    const reservationInput = (input: {
      documentId: string;
      idempotencyKey: string;
      startDate: string;
      content: Buffer;
    }) => {
      const fileName = `${input.idempotencyKey}.csv`;
      const checksum = createHash("sha256").update(input.content).digest("hex");
      return {
        orgId: "default-org",
        actorEmployeeId: employee!.id,
        documentId: input.documentId,
        dataset: "dishes" as const,
        fileType: "csv" as const,
        startDate: input.startDate,
        endDate: input.startDate,
        idempotencyKey: input.idempotencyKey,
        requestFingerprint: createHash("sha256")
          .update(`${input.idempotencyKey}:${checksum}`)
          .digest("hex"),
        document: {
          title: input.idempotencyKey,
          storageObjectKey: createOriginalObjectKey({
            orgId: "default-org",
            documentId: input.documentId,
            fileName
          }),
          originalFileName: fileName,
          contentType: "text/csv",
          byteSize: input.content.byteLength,
          checksumSha256: checksum,
          labelIds: [label!.id],
          labels: [label!.key]
        },
        sourceSheetSummary: [],
        totalRowCount: 1,
        requestId: `request:${input.idempotencyKey}`,
        clientIp: "127.0.0.1"
      };
    };

    const applyContent = Buffer.from("apply recovery", "utf8");
    const applyInput = reservationInput({
      documentId: "doc_apply_recovery",
      idempotencyKey: "integration-apply-recovery",
      startDate: "20260801",
      content: applyContent
    });
    const applyReservation = await repository.reserveStructuredImport(applyInput);
    await storage.putObject({
      orgId: applyInput.orgId,
      documentId: applyReservation.importBatch.sourceDocumentId,
      fileName: applyInput.document.originalFileName,
      body: applyContent,
      contentType: "text/csv"
    });
    let applyFailed = false;
    try {
      await repository.applyReservedStructuredImport({
        orgId: applyInput.orgId,
        actorEmployeeId: "missing_employee",
        importBatchId: applyReservation.importBatch.id,
        rows: [{ sourceRowNumber: 2, payload: { business_date: "2026-08-01" } }],
        requestId: "request:apply-failure",
        clientIp: "127.0.0.1"
      });
    } catch {
      applyFailed = true;
    }
    assert(applyFailed, "A transactional applied-audit failure must reject the apply.");
    const [pendingBatch, pendingDocument, pendingRows, retainedObject] = await Promise.all([
      prisma.importBatch.findUnique({ where: { id: applyReservation.importBatch.id } }),
      prisma.document.findUnique({ where: { id: applyReservation.importBatch.sourceDocumentId } }),
      prisma.dishRow.count({ where: { importBatchId: applyReservation.importBatch.id } }),
      storage.statObject(applyReservation.importBatch.storageObjectKey)
    ]);
    assert(
      pendingBatch?.status === "pending",
      "Failed DB apply must roll the batch back to pending."
    );
    assert(
      pendingDocument?.status === "pending_processing",
      "Failed DB apply must not activate its Document."
    );
    assert(pendingRows === 0, "Failed DB apply must not leave partial rows.");
    assert(
      retainedObject.key === applyReservation.importBatch.storageObjectKey,
      "Failed DB apply must retain the referenced deterministic object."
    );
    const recoveredApply = await repository.applyReservedStructuredImport({
      orgId: applyInput.orgId,
      actorEmployeeId: employee!.id,
      importBatchId: applyReservation.importBatch.id,
      rows: [{ sourceRowNumber: 2, payload: { business_date: "2026-08-01" } }],
      requestId: "request:apply-recovery",
      clientIp: "127.0.0.1"
    });
    assert(
      recoveredApply.status === "applied" &&
        recoveredApply.sourceDocumentId === applyReservation.importBatch.sourceDocumentId,
      "A DB apply replay must recover the same reservation."
    );

    const storageContent = Buffer.from("storage recovery", "utf8");
    const storageInput = reservationInput({
      documentId: "doc_storage_recovery",
      idempotencyKey: "integration-storage-recovery",
      startDate: "20260802",
      content: storageContent
    });
    const storageReservation = await repository.reserveStructuredImport(storageInput);
    const failedStorageBatch = await repository.markStructuredImportStorageFailure({
      orgId: storageInput.orgId,
      importBatchId: storageReservation.importBatch.id,
      errorCode: "STORAGE_WRITE_FAILED",
      errorSummary: "simulated transient storage failure"
    });
    assert(
      failedStorageBatch.status === "failed" &&
        failedStorageBatch.sourceDocumentStatus === "processing_failed",
      "Storage failure must persist a resumable failed state."
    );
    const resumedStorage = await repository.reserveStructuredImport(storageInput);
    assert(
      resumedStorage.state === "resumable" &&
        resumedStorage.importBatch.id === storageReservation.importBatch.id &&
        resumedStorage.importBatch.sourceDocumentId ===
          storageReservation.importBatch.sourceDocumentId,
      "Storage replay must reuse the original reservation."
    );
    await storage.putObject({
      orgId: storageInput.orgId,
      documentId: resumedStorage.importBatch.sourceDocumentId,
      fileName: storageInput.document.originalFileName,
      body: storageContent,
      contentType: "text/csv"
    });
    const recoveredStorage = await repository.applyReservedStructuredImport({
      orgId: storageInput.orgId,
      actorEmployeeId: employee!.id,
      importBatchId: resumedStorage.importBatch.id,
      rows: [{ sourceRowNumber: 2, payload: { business_date: "2026-08-02" } }],
      requestId: "request:storage-recovery",
      clientIp: "127.0.0.1"
    });
    const [storageDocuments, storageBatches, storageClaims, storageStarted, storageApplied] =
      await Promise.all([
        prisma.document.count({ where: { id: storageReservation.importBatch.sourceDocumentId } }),
        prisma.importBatch.count({ where: { id: storageReservation.importBatch.id } }),
        prisma.importWindowClaim.count({
          where: { importBatchId: storageReservation.importBatch.id }
        }),
        prisma.auditLog.count({
          where: {
            targetId: storageReservation.importBatch.id,
            action: "structured_import.started"
          }
        }),
        prisma.auditLog.count({
          where: {
            targetId: storageReservation.importBatch.id,
            action: "structured_import.applied"
          }
        })
      ]);
    assert(
      recoveredStorage.status === "applied",
      "Storage failure replay must apply successfully."
    );
    assert(
      storageDocuments === 1 &&
        storageBatches === 1 &&
        storageClaims === 1 &&
        storageStarted === 1 &&
        storageApplied === 1,
      "Storage recovery must retain single-cardinality records and audits."
    );
  } finally {
    await repository.disconnect?.();
    await prisma.$disconnect();
  }
}

async function assertWorkerLeaseRecovery(): Promise<void> {
  const databaseUrl = integrationEnv["DATABASE_URL"]!;
  const prisma = new PrismaClient({ adapter: new PrismaMariaDb(databaseUrl) });
  const repository = createPrismaProcessingWorkerRepository(databaseUrl);
  const storage = new LocalFileSystemStorageAdapter({ root: storageRoot });
  const documentId = "doc_worker_lease_recovery";
  const runId = "run_worker_lease_recovery";
  const fileName = "worker-lease-recovery.md";
  const content = Buffer.from(
    "# Lease recovery\n\nOnly the current lease owner may publish.",
    "utf8"
  );
  try {
    const employee = await prisma.employee.findFirst({
      where: { orgId: "default-org", email: "baoli.manager@example.com" }
    });
    assert(Boolean(employee), "Worker lease integration requires the seeded Baoli manager.");
    const stored = await storage.putObject({
      orgId: "default-org",
      documentId,
      fileName,
      body: content,
      contentType: "text/markdown"
    });
    await prisma.document.create({
      data: {
        id: documentId,
        orgId: "default-org",
        title: "Worker Lease Recovery",
        documentType: DocumentType.management_knowledge,
        documentKind: DocumentKind.evidence,
        fileType: FileType.md,
        status: DocumentStatus.pending_processing,
        storageObjectKey: stored.key,
        originalFileName: fileName,
        contentType: "text/markdown",
        byteSize: BigInt(content.byteLength),
        checksumSha256: createHash("sha256").update(content).digest("hex"),
        uploaderId: employee!.id,
        sourceSystem: "integration_smoke"
      }
    });
    await prisma.processingRun.create({
      data: {
        id: runId,
        orgId: "default-org",
        documentId,
        jobKey: `evidence_document_index:${documentId}:v1`,
        status: ProcessingRunStatus.queued,
        jobType: ProcessingJobType.evidence_document_index,
        attemptNumber: 0,
        retryCount: 0,
        availableAt: new Date("2026-07-20T00:00:00.000Z")
      }
    });

    const claimedByA = await repository.claimNextProcessingRun({
      workerId: "worker-a",
      leaseSeconds: 1,
      now: new Date("2026-07-20T00:00:00.000Z")
    });
    assert(claimedByA?.id === runId, "Worker A must claim the queued run.");
    const claimedByBWhileLeased = await repository.claimNextProcessingRun({
      workerId: "worker-b",
      leaseSeconds: 1,
      now: new Date("2026-07-20T00:00:00.100Z")
    });
    assert(!claimedByBWhileLeased, "Worker B must not claim an active lease.");
    const heartbeated = await repository.heartbeatProcessingRun?.({
      runId,
      workerId: "worker-a",
      leaseSeconds: 1,
      now: new Date("2026-07-20T00:00:00.500Z")
    });
    assert(heartbeated === true, "Heartbeat must extend the current lease.");
    const claimedBeforeHeartbeatExpiry = await repository.claimNextProcessingRun({
      workerId: "worker-b",
      leaseSeconds: 1,
      now: new Date("2026-07-20T00:00:01.000Z")
    });
    assert(!claimedBeforeHeartbeatExpiry, "Heartbeat must prevent premature lease recovery.");
    const claimedByB = await repository.claimNextProcessingRun({
      workerId: "worker-b",
      leaseSeconds: 1,
      now: new Date("2026-07-20T00:00:01.600Z")
    });
    assert(claimedByB?.id === runId, "Worker B must recover the expired running job.");

    let oldWorkerCompleteRejected = false;
    try {
      await repository.completeEvidenceIndexing?.({
        runId,
        documentId,
        workerId: "worker-a",
        now: new Date("2026-07-20T00:00:01.700Z"),
        result: workerLeaseIndexingResult(),
        chunks: []
      });
    } catch {
      oldWorkerCompleteRejected = true;
    }
    assert(oldWorkerCompleteRejected, "Old worker must not complete after losing its lease.");
    assert(
      (await prisma.document.findUnique({ where: { id: documentId } }))?.status !==
        DocumentStatus.active,
      "A lost old worker must not activate the document."
    );

    await repository.completeEvidenceIndexing?.({
      runId,
      documentId,
      workerId: "worker-b",
      now: new Date("2026-07-20T00:00:01.700Z"),
      result: workerLeaseIndexingResult(),
      chunks: []
    });
    let oldWorkerFailRejected = false;
    try {
      await repository.failProcessingRun({
        runId,
        documentId,
        workerId: "worker-a",
        now: new Date("2026-07-20T00:00:01.800Z"),
        errorCode: "STALE_WORKER",
        errorSummary: "old worker attempted to fail after success",
        willRetry: false,
        nextAvailableAt: new Date("2026-07-20T00:00:01.800Z")
      });
    } catch {
      oldWorkerFailRejected = true;
    }
    const [finalRun, finalDocument, readyIndexes] = await Promise.all([
      prisma.processingRun.findUnique({ where: { id: runId } }),
      prisma.document.findUnique({ where: { id: documentId } }),
      prisma.documentIndex.count({ where: { documentId, status: "ready" } })
    ]);
    assert(oldWorkerFailRejected, "Old worker must not fail a job after another worker succeeds.");
    assert(finalRun?.status === ProcessingRunStatus.succeeded, "Recovered worker must succeed.");
    assert(
      finalRun.lockedBy === null && finalRun.lockedUntil === null,
      "Success must release lease."
    );
    assert(finalRun.attemptNumber === 2, "Lease recovery must increment the second attempt.");
    assert(
      finalDocument?.status === DocumentStatus.active,
      "Recovered worker must activate document."
    );
    assert(readyIndexes === 1, "Recovered worker must publish one ready index.");
  } finally {
    await repository.disconnect?.();
    await prisma.$disconnect();
  }
}

function workerLeaseIndexingResult() {
  return {
    retrievalConfigVersion: "phase3.worker-lease.integration",
    qdrantCollection: "enterprise_hub_evidence_test",
    embeddingProvider: "fake",
    embeddingModel: "fake-embedding-v1",
    embeddingVersion: "fake-embedding-v1@phase3.worker-lease.integration",
    embeddingDimension: 8,
    lexicalIndexVersion: "lexical.v1",
    rerankProvider: null,
    rerankModel: null,
    rerankVersion: null,
    chunks: []
  };
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
