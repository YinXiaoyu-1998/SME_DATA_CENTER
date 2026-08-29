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
import { AuthCore } from "../apps/api/src/auth/auth-core.js";
import {
  createLauncherToolDependencies,
  createLauncherToolHandler
} from "../apps/mcp-launcher/src/index.js";
import { getStructuredRegistry } from "@enterprise-hub/domain";
import {
  OAUTH_CLIENT_ID,
  OAUTH_TRANSACTION_COOKIE,
  csrfTokenForSecret,
  pkceChallengeForVerifier
} from "../apps/api/src/auth/http-contract.js";
import { createPrismaAuthCoreRepository } from "../apps/api/src/auth/prisma-auth-repository.js";
import { createPrismaProcessingWorkerRepository } from "../apps/worker/src/worker.js";
import { LocalFileSystemStorageAdapter } from "@enterprise-hub/storage";

const DEFAULT_MYSQL_PORT = "3307";
const DEFAULT_DATABASE_URL = (mysqlPort: string) =>
  `mysql://enterprise_hub:enterprise_hub_local_password@localhost:${mysqlPort}/enterprise_hub`;
const DEFAULT_CURSOR_SIGNING_SECRET = "replace-with-local-development-cursor-secret";

interface CommandResult {
  stdout: string;
  stderr: string;
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
    validationErrorCount: number;
    validationErrors: Array<{ code?: string; message?: string }>;
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

interface OAuthTokenResponse {
  access_token: string;
  refresh_token: string;
}

interface McpToolEnvelope {
  result?: {
    content?: Array<{ type: string; text?: string }>;
    isError?: boolean;
  };
}

interface McpStructuredQueryResponse {
  rows: Array<Record<string, unknown>>;
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
  CURSOR_SIGNING_SECRET: process.env["CURSOR_SIGNING_SECRET"] ?? DEFAULT_CURSOR_SIGNING_SECRET,
  ENTERPRISE_HUB_PUBLIC_ORIGIN:
    process.env["ENTERPRISE_HUB_PUBLIC_ORIGIN"] ?? "https://api.smedatacenter.xyz",
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
const officialSessionCleanup: Array<() => Promise<void>> = [];

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

  const employeeAccessToken = await createOfficialIntegrationAccessToken("emp_baoli_manager");
  const auth = authorizationHeader(employeeAccessToken);
  const adminAuth = authorizationHeader(await createOfficialIntegrationAccessToken("emp_admin"));

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
  const structuredUploadResult = await apiJsonWithStatus<StructuredUploadResponse>(
    "/v1/structured/imports",
    {
      method: "POST",
      headers: auth,
      body: structuredFormFor(structuredFixture, structuredIdempotencyKey)
    }
  );
  const structuredUpload = structuredUploadResult.body;
  assert(
    structuredUploadResult.status === 202,
    "Structured upload should return HTTP 202 quickly."
  );
  assert(
    structuredUpload.importBatch.status === "pending" &&
      structuredUpload.document.status === "pending_processing",
    "Structured upload should be queued before any parsing or business-row writes."
  );
  const structuredReplays = await Promise.all(
    Array.from({ length: 9 }, async () => {
      return apiJson<StructuredUploadResponse>("/v1/structured/imports", {
        method: "POST",
        headers: auth,
        body: structuredFormFor(structuredFixture, structuredIdempotencyKey)
      });
    })
  );
  for (const replay of structuredReplays) {
    assert(
      replay.document.documentId === structuredUpload.document.documentId &&
        replay.document.storageObjectKey === structuredUpload.document.storageObjectKey &&
        replay.document.status === structuredUpload.document.status &&
        replay.importBatch.importBatchId === structuredUpload.importBatch.importBatchId &&
        replay.importBatch.status === structuredUpload.importBatch.status,
      "Concurrent exact replays must return the authoritative persisted identifiers and status."
    );
  }
  await assertStructuredReplayCardinality(structuredIdempotencyKey, structuredUpload, "pending");
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
    windowConflict.status === 409 && windowConflictBody.error?.code === "IMPORT_IN_PROGRESS",
    "A second idempotency key must not bypass a queued import for the same date window."
  );
  await assertStructuredReplayCardinality(structuredIdempotencyKey, structuredUpload, "pending");
  const pendingStructuredQuery = await apiJson<StructuredQueryResponse>("/v1/structured/query", {
    method: "POST",
    headers: { ...auth, "content-type": "application/json" },
    body: JSON.stringify({ dataset: "dishes", aggregates: [{ op: "count", as: "row_count" }] })
  });
  assert(
    pendingStructuredQuery.rows[0]?.["row_count"] === 0,
    "Pending structured import data must not be queryable."
  );
  const structuredWorker = parseJson<WorkerResponse>(
    (await run("npm", ["--silent", "run", "worker:once"], { env: integrationEnv })).stdout
  );
  assert(
    structuredWorker.documentId === structuredUpload.document.documentId &&
      structuredWorker.status === "active",
    "Worker should apply the queued structured import."
  );
  const appliedStructuredUpload = await waitForStructuredImportStatus(
    structuredUpload.importBatch.importBatchId,
    auth,
    "applied"
  );
  assert(
    appliedStructuredUpload.importBatch.appliedRowCount === 1,
    "Structured import should load one fixture row."
  );
  await assertStructuredReplayCardinality(structuredIdempotencyKey, structuredUpload, "applied");

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
  await assertStructuredApplyRollback();
  const deliveryLedgerSupplierCatalog =
    await assertMcpDeliveryLedgerSupplierCatalogFlow(employeeAccessToken);

  const launcherPathCsv = Buffer.from(
    structuredFixture.toString("utf8").replace("2026-07-01,", "2026-07-06,"),
    "utf8"
  );
  const launcherPathFile = path.join(integrationRoot, "launcher-path-dishes.csv");
  await writeFile(launcherPathFile, launcherPathCsv);
  const launcherPathIdempotencyKey = `integration-launcher-path-${Date.now()}`;
  const launcherPathResult = await createLauncherToolHandler(
    "upload_structured_dataset",
    createLauncherToolDependencies({
      config: { serviceUrl: apiUrl, transport: "stdio" },
      auth: {
        login: async () => ({
          authenticated: false,
          flow: "device",
          verificationUri: `${apiUrl}/oauth/device/verify`,
          verificationUriComplete: `${apiUrl}/oauth/device/verify?user_code=INTEGR8`,
          userCode: "INTEGR8",
          instanceName: "integration-agent",
          instanceHostname: "integration-host",
          openedBrowser: false
        }),
        logout: async () => ({ remoteRevocationConfirmed: true, localCredentialRemoved: true }),
        status: async () => ({ authenticated: true }),
        accessToken: async () => employeeAccessToken,
        invalidate: async () => undefined,
        selfCheck: async () => {
          throw new Error("not used");
        }
      }
    })
  )({
    file: {
      name: "launcher-path-dishes.csv",
      mediaType: "text/csv",
      encoding: "path",
      filePath: launcherPathFile
    },
    dataset: "dishes",
    enterpriseName: "Integration Smoke",
    startDate: "20260706",
    endDate: "20260706",
    idempotencyKey: launcherPathIdempotencyKey,
    labelKeys: ["store:baoli"]
  });
  assert(
    !launcherPathResult.isError,
    `Launcher path-mode upload should not error: ${JSON.stringify(launcherPathResult)}`
  );
  const launcherPathBody = JSON.parse(
    launcherPathResult.content[0]?.text ?? "null"
  ) as StructuredUploadResponse;
  assert(
    launcherPathBody.importBatch.status === "pending",
    "Launcher path-mode import should report its queued state."
  );
  const launcherStructuredWorker = parseJson<WorkerResponse>(
    (await run("npm", ["--silent", "run", "worker:once"], { env: integrationEnv })).stdout
  );
  assert(
    launcherStructuredWorker.documentId === launcherPathBody.document.documentId &&
      launcherStructuredWorker.status === "active",
    "Worker should apply the launcher path-mode structured import."
  );
  const launcherPathCompletion = await waitForStructuredImportStatus(
    launcherPathBody.importBatch.importBatchId,
    auth,
    "applied"
  );
  assert(
    launcherPathCompletion.importBatch.appliedRowCount === 1,
    "Launcher path-mode import should load one row."
  );
  const storedObject = await new LocalFileSystemStorageAdapter({
    root: storageRoot
  }).getObjectStream(launcherPathBody.document.storageObjectKey);
  assert(
    Buffer.from(await collectStreamBytes(storedObject)).equals(launcherPathCsv),
    "Stored bytes must match the launcher path-mode upload."
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
  const allStaffStructuredUploadResult = await apiJsonWithStatus<StructuredUploadResponse>(
    "/v1/structured/imports",
    {
      method: "POST",
      headers: adminAuth,
      body: allStaffStructuredForm
    }
  );
  const allStaffStructuredUpload = allStaffStructuredUploadResult.body;
  assert(
    allStaffStructuredUploadResult.status === 202 &&
      allStaffStructuredUpload.importBatch.status === "pending",
    "Admin structured upload should be accepted as pending."
  );
  const allStaffStructuredWorker = parseJson<WorkerResponse>(
    (await run("npm", ["--silent", "run", "worker:once"], { env: integrationEnv })).stdout
  );
  assert(
    allStaffStructuredWorker.documentId === allStaffStructuredUpload.document.documentId &&
      allStaffStructuredWorker.status === "active",
    "Worker should apply the all_staff structured import."
  );
  const allStaffStructuredCompletion = await waitForStructuredImportStatus(
    allStaffStructuredUpload.importBatch.importBatchId,
    adminAuth,
    "applied"
  );
  assert(
    allStaffStructuredCompletion.importBatch.appliedRowCount > 0,
    "Admin all_staff structured fixture should apply after polling."
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

  const invalidStructuredFixture = await readFile(
    path.join(rootDir, "fixtures", "manual-acceptance", "structured", "dishes-invalid-atomic.csv")
  );
  const invalidStructuredForm = new FormData();
  invalidStructuredForm.append(
    "file",
    new Blob([new Uint8Array(invalidStructuredFixture)]),
    "dishes-invalid-atomic.csv"
  );
  invalidStructuredForm.append("dataset", "dishes");
  invalidStructuredForm.append("enterprise_name", "Integration Invalid");
  invalidStructuredForm.append("startDate", "20260820");
  invalidStructuredForm.append("endDate", "20260820");
  invalidStructuredForm.append("idempotencyKey", `integration-invalid-${Date.now()}`);
  invalidStructuredForm.append("labelKeys[]", "store:baoli");
  const invalidStructuredUploadResult = await apiJsonWithStatus<StructuredUploadResponse>(
    "/v1/structured/imports",
    { method: "POST", headers: auth, body: invalidStructuredForm }
  );
  const invalidStructuredUpload = invalidStructuredUploadResult.body;
  assert(
    invalidStructuredUploadResult.status === 202 &&
      invalidStructuredUpload.importBatch.status === "pending",
    "Invalid structured headers must be accepted first and validated by the worker."
  );
  const invalidStructuredWorker = parseJson<WorkerResponse>(
    (await run("npm", ["--silent", "run", "worker:once"], { env: integrationEnv })).stdout
  );
  assert(
    invalidStructuredWorker.documentId === invalidStructuredUpload.document.documentId &&
      invalidStructuredWorker.status === "rejected",
    "Worker should reject the invalid structured header."
  );
  const rejectedStructuredUpload = await waitForStructuredImportStatus(
    invalidStructuredUpload.importBatch.importBatchId,
    auth,
    "rejected"
  );
  const rejectedPayload = JSON.stringify(rejectedStructuredUpload);
  assert(
    rejectedStructuredUpload.importBatch.validationErrorCount > 0 &&
      !rejectedPayload.includes("不应写入的菜品") &&
      !rejectedPayload.includes("should-fail"),
    "Rejected structured imports should expose safe errors without raw cell values."
  );

  const suzhouAccessToken = await createOfficialIntegrationAccessToken("emp_suzhou_manager");
  const inaccessibleImportStatus = await fetch(
    `${apiUrl}/v1/structured/imports/${encodeURIComponent(structuredUpload.importBatch.importBatchId)}`,
    { headers: authorizationHeader(suzhouAccessToken) }
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
  await assertAuditProvenanceMatrix(employeeAccessToken);

  console.log(
    JSON.stringify(
      {
        ok: true,
        structuredImportBatchId: structuredUpload.importBatch.importBatchId,
        deliveryLedgerImportBatchId: deliveryLedgerSupplierCatalog.deliveryImportBatchId,
        supplierCatalogImportBatchId: deliveryLedgerSupplierCatalog.supplierImportBatchId,
        evidenceDocumentId: evidenceUpload.document.documentId,
        apiUrl,
        mysqlPort,
        proved: [
          "seed",
          "official_session_authentication",
          "phase3_structured_import",
          "phase3_structured_concurrent_exact_replay",
          "phase3_structured_apply_transaction_rollback",
          "launcher_local_path_upload",
          "phase3_structured_typed_query",
          "phase3_structured_query",
          "mcp_delivery_without_catalog_returns_null_enrichment",
          "mcp_delivery_supplier_dynamic_enrichment",
          "mcp_latest_supplier_catalog_replaces_enrichment",
          "phase3_structured_all_staff_import",
          "phase3_structured_all_staff_query",
          "phase3_structured_import_status_non_enumeration",
          "phase3_evidence_upload_worker_status_search",
          "phase3_evidence_signed_pagination",
          "phase3_worker_lease_crash_recovery",
          "audit_provenance_persistence_matrix",
          "audit_provenance_run_scoped_cleanup"
        ]
      },
      null,
      2
    )
  );
} finally {
  await Promise.allSettled(officialSessionCleanup.splice(0).map((cleanup) => cleanup()));
  if (apiProcess) {
    await stopApi(apiProcess);
  }
}

async function createOfficialIntegrationAccessToken(employeeId: string): Promise<string> {
  const prisma = new PrismaClient({
    adapter: new PrismaMariaDb(integrationEnv["DATABASE_URL"]!)
  });
  const auth = new AuthCore(createPrismaAuthCoreRepository(prisma));
  const identity = await prisma.loginIdentity.findFirst({
    where: { employeeId, disabled: false },
    select: { id: true, employeeId: true, orgId: true }
  });
  if (!identity) {
    await prisma.$disconnect();
    throw new Error(`Seeded official identity is missing for ${employeeId}.`);
  }
  const session = await auth.createSession({
    identityId: identity.id,
    employeeId: identity.employeeId,
    orgId: identity.orgId
  });
  officialSessionCleanup.push(async () => {
    try {
      await auth.logout(session.durableCredential);
    } finally {
      await prisma.$disconnect();
    }
  });
  return session.accessToken;
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
  return (await apiJsonWithStatus<T>(pathName, init)).body;
}

async function apiJsonWithStatus<T>(
  pathName: string,
  init: RequestInit
): Promise<{ status: number; body: T }> {
  const response = await fetch(`${apiUrl}${pathName}`, init);
  const body = (await response.json()) as T;

  if (!response.ok) {
    throw new Error(`API request failed: ${response.status} ${JSON.stringify(body)}`);
  }

  return { status: response.status, body };
}

async function waitForStructuredImportStatus(
  importBatchId: string,
  headers: HeadersInit,
  expectedStatus: "applied" | "rejected"
): Promise<StructuredUploadResponse> {
  let latest: StructuredUploadResponse | null = null;
  await waitForCondition(`Structured import ${expectedStatus}`, async () => {
    latest = await apiJson<StructuredUploadResponse>(
      `/v1/structured/imports/${encodeURIComponent(importBatchId)}`,
      { headers }
    );
    return latest.importBatch.status === expectedStatus;
  });
  return latest!;
}

async function assertMcpDeliveryLedgerSupplierCatalogFlow(
  accessToken: string
): Promise<{ deliveryImportBatchId: string; supplierImportBatchId: string }> {
  const runId = `mcp-ledger-supplier-${Date.now()}`;
  const receiptNumber = `MCP-${Date.now()}`;
  const supplierName = "MCP Synthetic Supplier";
  const deliveryUpload = await uploadStructuredDatasetThroughMcp(accessToken, {
    requestId: `${runId}-delivery`,
    fileName: "mcp-delivery-ledger.csv",
    content: deliveryLedgerCsvForIntegration(receiptNumber, supplierName),
    dataset: "delivery_ledger",
    enterpriseName: "MCP Delivery Smoke",
    idempotencyKey: `${runId}-delivery-key`
  });
  assert(
    deliveryUpload.importBatch.status === "pending",
    "MCP delivery upload should be queued before worker application."
  );
  const deliveryWorker = parseJson<WorkerResponse>(
    (await run("npm", ["--silent", "run", "worker:once"], { env: integrationEnv })).stdout
  );
  assert(
    deliveryWorker.documentId === deliveryUpload.document.documentId &&
      deliveryWorker.status === "active",
    "Worker should apply the MCP delivery upload."
  );
  const appliedDelivery = await waitForMcpImportStatus(
    accessToken,
    deliveryUpload.importBatch.importBatchId,
    `${runId}-delivery-status`
  );
  assert(
    appliedDelivery.importBatch.appliedRowCount === 1,
    "MCP delivery upload should apply one ledger row."
  );

  const noCatalogQuery = await queryDeliveryThroughMcp(
    accessToken,
    receiptNumber,
    `${runId}-no-catalog-query`
  );
  assert(
    noCatalogQuery.rows.length === 1 &&
      noCatalogQuery.rows[0]?.supplier_contact_phone === null &&
      noCatalogQuery.rows[0]?.supplier_unit_address === null,
    "A delivery query before any supplier catalog must return null enrichment."
  );

  const supplierUpload = await uploadStructuredDatasetThroughMcp(accessToken, {
    requestId: `${runId}-supplier-initial`,
    fileName: "mcp-supplier-catalog.csv",
    content: supplierCatalogCsvForIntegration(supplierName, "13800000001", "MCP Initial Address"),
    dataset: "supplier_catalog",
    enterpriseName: "MCP Supplier Smoke",
    idempotencyKey: `${runId}-supplier-initial-key`
  });
  const supplierWorker = parseJson<WorkerResponse>(
    (await run("npm", ["--silent", "run", "worker:once"], { env: integrationEnv })).stdout
  );
  assert(
    supplierWorker.documentId === supplierUpload.document.documentId &&
      supplierWorker.status === "active",
    "Worker should apply the initial MCP supplier catalog upload."
  );
  const appliedSupplier = await waitForMcpImportStatus(
    accessToken,
    supplierUpload.importBatch.importBatchId,
    `${runId}-supplier-initial-status`
  );
  assert(
    appliedSupplier.importBatch.appliedRowCount === 1,
    "Initial MCP supplier catalog upload should apply one supplier row."
  );

  const initialEnrichment = await queryDeliveryThroughMcp(
    accessToken,
    receiptNumber,
    `${runId}-initial-query`
  );
  assert(
    initialEnrichment.rows[0]?.supplier_contact_phone === "13800000001" &&
      initialEnrichment.rows[0]?.supplier_unit_address === "MCP Initial Address",
    "MCP delivery query should dynamically enrich from the current supplier catalog."
  );

  await delay(10);
  const newerSupplierUpload = await uploadStructuredDatasetThroughMcp(accessToken, {
    requestId: `${runId}-supplier-newer`,
    fileName: "mcp-supplier-catalog-newer.csv",
    content: supplierCatalogCsvForIntegration(supplierName, "13900000002", "MCP Newer Address"),
    dataset: "supplier_catalog",
    enterpriseName: "MCP Supplier Smoke",
    idempotencyKey: `${runId}-supplier-newer-key`
  });
  const newerSupplierWorker = parseJson<WorkerResponse>(
    (await run("npm", ["--silent", "run", "worker:once"], { env: integrationEnv })).stdout
  );
  assert(
    newerSupplierWorker.documentId === newerSupplierUpload.document.documentId &&
      newerSupplierWorker.status === "active",
    "Worker should apply the newer MCP supplier catalog upload."
  );
  const appliedNewerSupplier = await waitForMcpImportStatus(
    accessToken,
    newerSupplierUpload.importBatch.importBatchId,
    `${runId}-supplier-newer-status`
  );
  assert(
    appliedNewerSupplier.importBatch.appliedRowCount === 1,
    "Newer MCP supplier catalog upload should apply one supplier row."
  );

  const newerEnrichment = await queryDeliveryThroughMcp(
    accessToken,
    receiptNumber,
    `${runId}-newer-query`
  );
  assert(
    newerEnrichment.rows[0]?.receipt_number === receiptNumber &&
      newerEnrichment.rows[0]?.supplier_contact_phone === "13900000002" &&
      newerEnrichment.rows[0]?.supplier_unit_address === "MCP Newer Address",
    "The same historical delivery row must reflect the latest supplier phone and address."
  );

  return {
    deliveryImportBatchId: deliveryUpload.importBatch.importBatchId,
    supplierImportBatchId: newerSupplierUpload.importBatch.importBatchId
  };
}

async function uploadStructuredDatasetThroughMcp(
  accessToken: string,
  input: {
    requestId: string;
    fileName: string;
    content: string;
    dataset: "delivery_ledger" | "supplier_catalog";
    enterpriseName: string;
    idempotencyKey: string;
  }
): Promise<StructuredUploadResponse> {
  return callMcpTool<StructuredUploadResponse>(
    accessToken,
    input.requestId,
    "upload_structured_dataset",
    {
      file: {
        name: input.fileName,
        mediaType: "text/csv",
        encoding: "base64",
        contentBase64: Buffer.from(input.content, "utf8").toString("base64")
      },
      dataset: input.dataset,
      enterpriseName: input.enterpriseName,
      idempotencyKey: input.idempotencyKey,
      labelKeys: ["store:baoli"]
    }
  );
}

async function waitForMcpImportStatus(
  accessToken: string,
  importBatchId: string,
  requestId: string
): Promise<StructuredUploadResponse> {
  let latest: StructuredUploadResponse | null = null;
  let pollNumber = 0;
  await waitForCondition(`MCP structured import ${importBatchId}`, async () => {
    latest = await callMcpTool<StructuredUploadResponse>(
      accessToken,
      `${requestId}-${pollNumber++}`,
      "get_import_status",
      { importBatchId }
    );
    return latest.importBatch.status === "applied";
  });
  return latest!;
}

async function queryDeliveryThroughMcp(
  accessToken: string,
  receiptNumber: string,
  requestId: string
): Promise<McpStructuredQueryResponse> {
  return callMcpTool<McpStructuredQueryResponse>(
    accessToken,
    requestId,
    "query_structured_dataset",
    {
      dataset: "delivery_ledger",
      select: [
        "receipt_number",
        "supplier_name",
        "supplier_contact_phone",
        "supplier_unit_address"
      ],
      filter: { field: "receipt_number", op: "eq", value: receiptNumber },
      page: { limit: 10 }
    }
  );
}

async function callMcpTool<T>(
  accessToken: string,
  requestId: string,
  name: string,
  argumentsInput: Record<string, unknown>
): Promise<T> {
  const response = await fetch(`${apiUrl}/mcp`, {
    method: "POST",
    headers: {
      accept: "application/json, text/event-stream",
      authorization: `Bearer ${accessToken}`,
      "content-type": "application/json",
      "mcp-protocol-version": "2025-11-25",
      "x-enterprise-hub-launcher-version": "0.2.3",
      "x-request-id": requestId
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: requestId,
      method: "tools/call",
      params: { name, arguments: argumentsInput }
    })
  });
  const envelope = (await response.json()) as McpToolEnvelope;
  const toolResult = envelope.result;
  const text = toolResult?.content?.find((content) => content.type === "text")?.text;
  assert(response.status === 200, `MCP ${name} must return HTTP 200.`);
  assert(toolResult?.isError === false && Boolean(text), `MCP ${name} must succeed.`);
  return JSON.parse(text!) as T;
}

function deliveryLedgerCsvForIntegration(receiptNumber: string, supplierName: string): string {
  return [
    ["送货单"],
    ["单据号", receiptNumber, "订货机构", "MCP Synthetic Store"],
    ["送货机构", supplierName, "收货日期", "2026-08-29"],
    ["序号", "物品名称", "规格型号", "收货数量", "收货金额"],
    ["1", "MCP Synthetic Item", "件", "2", "100"],
    ["合计", "", "", "2", "100"],
    ["验收人", "MCP Synthetic Receiver"]
  ]
    .map((row) => row.join(","))
    .join("\n");
}

function supplierCatalogCsvForIntegration(
  supplierName: string,
  phone: string,
  address: string
): string {
  const headers = getStructuredRegistry("supplier_catalog")
    .fields.filter((field) => field.inputSource === "file")
    .map((field) => field.sourceColumn);
  const values = headers.map((header, index) => {
    if (header === "供应商编码") return "MCP-S-001";
    if (header === "供应商名称") return supplierName;
    if (header === "税率") return "13";
    if (header === "联系人电话") return phone;
    if (header === "单位地址") return address;
    if (header === "操作时间") return "2026-08-29 10:30:00";
    return `MCP值${index + 1}`;
  });
  return [headers, values].map((row) => row.join(",")).join("\n");
}

async function assertStructuredReplayCardinality(
  idempotencyKey: string,
  response: StructuredUploadResponse,
  expectedStatus: "pending" | "applied"
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
    assert(
      batch?.id === response.importBatch.importBatchId && batch.status === expectedStatus,
      "One authoritative batch must exist in the expected lifecycle state."
    );
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
    assert(
      rows === (expectedStatus === "applied" ? 1 : 0),
      "Concurrent replay must not publish rows before worker application."
    );
    assert(startedAudits === 1, "Concurrent replay must create one started audit.");
    assert(
      appliedAudits === (expectedStatus === "applied" ? 1 : 0),
      "Concurrent replay must create one applied audit only after worker application."
    );
    assert(processingRuns === 1, "Concurrent replay must create one ProcessingRun.");

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
        typedDishRow(importBatchId, sourceDocumentId, 1001, "typed-2", "2", "2026-07-03T10:00:00"),
        typedDishRow(
          importBatchId,
          sourceDocumentId,
          1002,
          "typed-10",
          "10",
          "2026-07-03T11:00:00"
        ),
        typedDishRow(
          importBatchId,
          sourceDocumentId,
          1003,
          "typed-100",
          "100",
          "2026-07-03T12:00:00"
        ),
        typedDishRow(
          importBatchId,
          sourceDocumentId,
          1004,
          "typed--1",
          "-1",
          "2026-07-03T09:00:00"
        ),
        typedDishRow(
          importBatchId,
          sourceDocumentId,
          1005,
          "typed-0.5",
          "0.5",
          "2026-07-03T10:30:00"
        )
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

    const dateTimeSorted = await apiJson<StructuredQueryResponse>("/v1/structured/query", {
      method: "POST",
      headers: { ...auth, "content-type": "application/json" },
      body: JSON.stringify({
        dataset: "dishes",
        select: ["matched_product_name", "order_time"],
        filter: {
          field: "order_time",
          op: "between",
          value: ["2026-07-03T10:00:00", "2026-07-03T12:00:00"]
        },
        sort: [{ field: "order_time", direction: "asc" }],
        page: { limit: 10 }
      })
    });
    assert(
      dateTimeSorted.rows.map((row) => row["matched_product_name"]).join(",") ===
        "typed-2,typed-0.5,typed-10,typed-100",
      "Date-time filtering and sorting must use the persisted ISO-like value format."
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
  dishSalesQuantity: string,
  orderTime: string
) {
  return {
    orgId: "default-org",
    sourceDocumentId,
    importBatchId,
    sourceRowNumber,
    payload: {
      business_date: "2026-07-03",
      matched_product_name: matchedProductName,
      dish_sales_quantity: dishSalesQuantity,
      order_time: orderTime
    }
  };
}

async function assertStructuredApplyRollback(): Promise<void> {
  await run(
    "npx",
    ["vitest", "run", "apps/worker/src/structured-import.prisma.integration.test.ts"],
    {
      env: {
        ...integrationEnv,
        RUN_WORKER_PRISMA_INTEGRATION: "1"
      }
    }
  );
}

async function assertAuditProvenanceMatrix(accessToken: string): Promise<void> {
  const runId = `audit_${Date.now().toString(36)}`;
  const sourceSystem = `audit_provenance_${runId}`;
  const requestIds = {
    direct: `${runId}_direct`,
    trustedProxy: `${runId}_proxy`,
    mcp: `${runId}_mcp`,
    forgedProof: `${runId}_forged`,
    browser: `${runId}_browser`,
    oauthToken: `${runId}_oauth_token`,
    oauthRefresh: `${runId}_oauth_refresh`,
    oauthRevoke: `${runId}_oauth_revoke`
  } as const;
  const businessRequestIds = [
    requestIds.direct,
    requestIds.trustedProxy,
    requestIds.mcp,
    requestIds.forgedProof
  ];
  const authRequestIds = [
    requestIds.browser,
    requestIds.oauthToken,
    requestIds.oauthRefresh,
    requestIds.oauthRevoke
  ];
  const prisma = new PrismaClient({ adapter: new PrismaMariaDb(integrationEnv["DATABASE_URL"]!) });
  const auth = new AuthCore(createPrismaAuthCoreRepository(prisma));
  const storage = new LocalFileSystemStorageAdapter({ root: storageRoot });
  const transactionIds: string[] = [];
  const sessionIds: string[] = [];

  try {
    const identity = await prisma.loginIdentity.findFirst({
      where: { employeeId: "emp_baoli_manager", disabled: false },
      select: { id: true, employeeId: true, orgId: true }
    });
    assert(Boolean(identity), "Audit provenance integration requires the seeded Baoli identity.");

    const operatorSession = await auth.createSession({
      identityId: identity!.id,
      employeeId: identity!.employeeId,
      orgId: identity!.orgId
    });
    sessionIds.push(operatorSession.sessionId);

    const direct = await uploadAuditEvidence(accessToken, {
      requestId: requestIds.direct,
      sourceSystem,
      title: `${runId} direct`,
      extraHeaders: { "x-enterprise-hub-launcher-version": "0.1.0" }
    });
    const trustedProxy = await uploadAuditEvidence(accessToken, {
      requestId: requestIds.trustedProxy,
      sourceSystem,
      title: `${runId} trusted proxy`,
      extraHeaders: { "x-forwarded-for": "203.0.113.41" }
    });
    const forgedProof = await uploadAuditEvidence(accessToken, {
      requestId: requestIds.forgedProof,
      sourceSystem,
      title: `${runId} forged proof`,
      extraHeaders: {
        "x-enterprise-hub-internal-delegation": "A".repeat(43),
        "x-enterprise-hub-launcher-version": "0.1.0"
      }
    });
    const mcp = await uploadAuditEvidenceThroughMcp(accessToken, {
      requestId: requestIds.mcp,
      sourceSystem,
      title: `${runId} MCP`,
      forwardedIp: "203.0.113.42"
    });
    const businessDocuments = [direct, trustedProxy, forgedProof, mcp];

    const browserTransaction = await auth.issueAuthorizationTransaction({
      clientId: OAUTH_CLIENT_ID,
      redirectUri: "http://127.0.0.1:43121/oauth/callback",
      state: `${runId}_browser_state`,
      pkceChallenge: pkceChallengeForVerifier(
        "audit-provenance-browser-verifier-abcdefghijklmnopqrstuvwxyz0123456789"
      )
    });
    transactionIds.push(browserTransaction.id);
    const browserResponse = await fetch(`${apiUrl}/oauth/authorize/login`, {
      method: "POST",
      headers: {
        cookie: `${OAUTH_TRANSACTION_COOKIE}=${browserTransaction.secret}`,
        "content-type": "application/x-www-form-urlencoded",
        "x-enterprise-hub-launcher-version": "0.1.0",
        "x-forwarded-for": "198.51.100.31",
        "x-request-id": requestIds.browser
      },
      body: new URLSearchParams({
        csrfToken: csrfTokenForSecret(browserTransaction.secret),
        email: `${runId}@example.invalid`,
        password: "intentionally invalid"
      }).toString(),
      redirect: "manual"
    });
    assert(browserResponse.status === 401, "Synthetic browser login must fail generically.");

    const verifier = "audit-provenance-oauth-verifier-abcdefghijklmnopqrstuvwxyz0123456789";
    const redirectUri = "http://127.0.0.1:43122/oauth/callback";
    const oauthTransaction = await auth.issueAuthorizationTransaction({
      clientId: OAUTH_CLIENT_ID,
      redirectUri,
      state: `${runId}_oauth_state`,
      pkceChallenge: pkceChallengeForVerifier(verifier)
    });
    transactionIds.push(oauthTransaction.id);
    const authorization = await auth.completeAuthorizationTransaction(
      oauthTransaction.secret,
      {
        identityId: identity!.id,
        employeeId: identity!.employeeId,
        orgId: identity!.orgId
      },
      { requestId: `${runId}_oauth_setup`, sourceIp: "127.0.0.1", launcherVersion: null }
    );
    assert(Boolean(authorization), "Synthetic OAuth authorization code must be created.");

    const tokenResponse = await fetch(`${apiUrl}/oauth/token`, {
      method: "POST",
      headers: oauthHeaders(requestIds.oauthToken, "198.51.100.32"),
      body: new URLSearchParams({
        grant_type: "authorization_code",
        client_id: OAUTH_CLIENT_ID,
        code: authorization!.code,
        redirect_uri: redirectUri,
        code_verifier: verifier
      }).toString()
    });
    const tokens = (await tokenResponse.json()) as OAuthTokenResponse;
    assert(tokenResponse.status === 200, "Synthetic OAuth code exchange must succeed.");

    const refreshResponse = await fetch(`${apiUrl}/oauth/token`, {
      method: "POST",
      headers: oauthHeaders(requestIds.oauthRefresh, "198.51.100.33"),
      body: new URLSearchParams({
        grant_type: "refresh_token",
        client_id: OAUTH_CLIENT_ID,
        refresh_token: `eh_rt_invalid_${runId}`
      }).toString()
    });
    assert(refreshResponse.status === 400, "Synthetic invalid OAuth refresh must be rejected.");

    const revokeResponse = await fetch(`${apiUrl}/oauth/revoke`, {
      method: "POST",
      headers: oauthHeaders(requestIds.oauthRevoke, "198.51.100.34"),
      body: new URLSearchParams({ token: tokens.refresh_token }).toString()
    });
    assert(revokeResponse.status === 200, "Synthetic OAuth revocation must succeed.");

    const auditRows = await prisma.auditLog.findMany({
      where: { requestId: { in: businessRequestIds } }
    });
    assert(auditRows.length === 4, "Every synthetic business origin must persist one audit row.");
    assertBusinessAudit(
      auditRows,
      requestIds.direct,
      direct.document.documentId,
      "127.0.0.1",
      "http_api",
      null
    );
    assertBusinessAudit(
      auditRows,
      requestIds.trustedProxy,
      trustedProxy.document.documentId,
      "203.0.113.41",
      "http_api",
      null
    );
    assertBusinessAudit(
      auditRows,
      requestIds.mcp,
      mcp.document.documentId,
      "203.0.113.42",
      "mcp_launcher",
      "0.1.0"
    );
    assertBusinessAudit(
      auditRows,
      requestIds.forgedProof,
      forgedProof.document.documentId,
      "127.0.0.1",
      "http_api",
      null
    );

    const browserEvent = await prisma.authSecurityEvent.findFirst({
      where: { requestId: requestIds.browser, eventType: "password_login_failed" }
    });
    assertAuthEvent(browserEvent, "198.51.100.31", null, "browser login");

    const tokenEvent = await prisma.authSecurityEvent.findFirst({
      where: { requestId: requestIds.oauthToken, eventType: "session_created" }
    });
    assertAuthEvent(tokenEvent, "198.51.100.32", "0.1.0", "OAuth token");
    assert(Boolean(tokenEvent?.sessionId), "OAuth token event must identify its session.");
    sessionIds.push(tokenEvent!.sessionId!);

    const refreshEvent = await prisma.authSecurityEvent.findFirst({
      where: { requestId: requestIds.oauthRefresh, eventType: "renewal_failed" }
    });
    assertAuthEvent(refreshEvent, "198.51.100.33", "0.1.0", "OAuth refresh");

    const revokeEvents = await prisma.authSecurityEvent.findMany({
      where: {
        requestId: requestIds.oauthRevoke,
        eventType: { in: ["logout", "session_revoked"] }
      }
    });
    assert(revokeEvents.length === 2, "OAuth revoke must persist logout and revocation events.");
    for (const event of revokeEvents) {
      assertAuthEvent(event, "198.51.100.34", "0.1.0", "OAuth revoke");
    }

    const deviceRunId = `${runId}_device`;
    const deviceHeaders = (requestId: string, forwardedIp: string) => ({
      ...oauthHeaders(requestId, forwardedIp),
      "x-enterprise-hub-launcher-version": "0.2.0"
    });
    const deviceRequest = await fetch(`${apiUrl}/oauth/device_authorization`, {
      method: "POST",
      headers: deviceHeaders(`${deviceRunId}_issue`, "198.51.100.35"),
      body: new URLSearchParams({
        client_id: OAUTH_CLIENT_ID,
        instanceName: `${runId}-agent`,
        instanceHostname: "integration-host"
      }).toString()
    });
    assert(deviceRequest.status === 200, "Device authorization request must succeed.");
    const device = (await deviceRequest.json()) as {
      device_code: string;
      user_code: string;
      verification_uri: string;
      verification_uri_complete: string;
      expires_in: number;
      interval: number;
    };
    assert(device.user_code.length === 8, "Device user code must be a short code.");
    assert(
      device.verification_uri_complete.includes(`user_code=${device.user_code}`),
      "Tap link must embed the user code."
    );

    const localVerifyUri = new URL(device.verification_uri_complete);
    localVerifyUri.protocol = new URL(apiUrl).protocol;
    localVerifyUri.host = new URL(apiUrl).host;
    const verifyPage = await fetch(localVerifyUri, {
      headers: { "x-forwarded-for": "198.51.100.36", "x-request-id": `${deviceRunId}_page` }
    });
    if (verifyPage.status !== 200) {
      throw new Error(
        `Device verification page must render (status ${verifyPage.status}): ${(
          await verifyPage.text()
        ).slice(0, 300)}`
      );
    }
    const pageHtml = await verifyPage.text();
    assert(
      pageHtml.includes(`${runId}-agent`) && pageHtml.includes("integration-host"),
      "Verification page must show the paired agent instance."
    );

    const pendingPoll = await fetch(`${apiUrl}/oauth/token`, {
      method: "POST",
      headers: deviceHeaders(`${deviceRunId}_pending`, "198.51.100.37"),
      body: new URLSearchParams({
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
        client_id: OAUTH_CLIENT_ID,
        device_code: device.device_code
      }).toString()
    });
    assert(
      pendingPoll.status === 400 &&
        ((await pendingPoll.json()) as { error: string }).error === "authorization_pending",
      "Polling before completion must return authorization_pending."
    );

    const completed = await auth.completeDeviceAuthorization(
      device.user_code,
      {
        identityId: identity!.id,
        employeeId: identity!.employeeId,
        orgId: identity!.orgId
      },
      { requestId: `${deviceRunId}_complete`, sourceIp: "198.51.100.38", launcherVersion: null }
    );
    assert(completed, "Device authorization must complete with the verified identity.");

    const deviceToken = await fetch(`${apiUrl}/oauth/token`, {
      method: "POST",
      headers: deviceHeaders(`${deviceRunId}_token`, "198.51.100.39"),
      body: new URLSearchParams({
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
        client_id: OAUTH_CLIENT_ID,
        device_code: device.device_code
      }).toString()
    });
    assert(deviceToken.status === 200, "Device code exchange must succeed.");
    const deviceTokens = (await deviceToken.json()) as OAuthTokenResponse;
    assert(
      Boolean(deviceTokens.access_token && deviceTokens.refresh_token),
      "Device exchange must issue both token types."
    );

    const deviceReplay = await fetch(`${apiUrl}/oauth/token`, {
      method: "POST",
      headers: deviceHeaders(`${deviceRunId}_replay`, "198.51.100.40"),
      body: new URLSearchParams({
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
        client_id: OAUTH_CLIENT_ID,
        device_code: device.device_code
      }).toString()
    });
    assert(deviceReplay.status === 400, "Replayed device codes must be rejected.");

    const deviceTokenEvent = await prisma.authSecurityEvent.findFirst({
      where: { requestId: `${deviceRunId}_token`, eventType: "session_created" }
    });
    assertAuthEvent(deviceTokenEvent, "198.51.100.39", "0.2.0", "device token");
    if (deviceTokenEvent?.sessionId) {
      sessionIds.push(deviceTokenEvent.sessionId);
    }

    const operatorEvent = await prisma.authSecurityEvent.findFirst({
      where: { sessionId: operatorSession.sessionId, eventType: "session_created" }
    });
    assert(
      operatorEvent?.requestId === null &&
        operatorEvent.sourceIp === null &&
        operatorEvent.launcherVersion === null,
      "Operator/system session events must keep request provenance null."
    );

    const worker = parseJson<WorkerResponse>(
      (await run("npm", ["--silent", "run", "worker:once"], { env: integrationEnv })).stdout
    );
    assert(
      Boolean(worker.documentId) &&
        businessDocuments.some((document) => document.document.documentId === worker.documentId),
      "The provenance cleanup fixture must index one run-scoped document."
    );
    await waitForEvidenceStatus(worker.documentId!, authorizationHeader(accessToken));
    assert(
      (await prisma.documentChunk.count({
        where: { documentId: worker.documentId!, qdrantPointId: { not: null } }
      })) > 0,
      "The provenance cleanup fixture must persist at least one Qdrant-backed chunk."
    );
  } finally {
    try {
      await cleanupAuditProvenanceRun(prisma, storage, {
        sourceSystem,
        businessRequestIds,
        authRequestIds,
        transactionIds,
        sessionIds
      });
    } finally {
      await prisma.$disconnect();
    }
  }
}

async function uploadAuditEvidence(
  accessToken: string,
  input: {
    requestId: string;
    sourceSystem: string;
    title: string;
    extraHeaders?: Record<string, string>;
  }
): Promise<EvidenceUploadResponse> {
  const form = new FormData();
  form.append(
    "file",
    new Blob([`# ${input.title}\n\nSynthetic audit cleanup fixture.\n`]),
    `${input.requestId}.md`
  );
  form.append("title", input.title);
  form.append("sourceSystem", input.sourceSystem);
  form.append("labelKeys[]", "store:baoli");
  return apiJson<EvidenceUploadResponse>("/v1/documents/evidence", {
    method: "POST",
    headers: {
      authorization: `Bearer ${accessToken}`,
      "x-request-id": input.requestId,
      ...input.extraHeaders
    },
    body: form
  });
}

async function uploadAuditEvidenceThroughMcp(
  accessToken: string,
  input: {
    requestId: string;
    sourceSystem: string;
    title: string;
    forwardedIp: string;
  }
): Promise<EvidenceUploadResponse> {
  const response = await fetch(`${apiUrl}/mcp`, {
    method: "POST",
    headers: {
      accept: "application/json, text/event-stream",
      authorization: `Bearer ${accessToken}`,
      "content-type": "application/json",
      "mcp-protocol-version": "2025-11-25",
      "x-enterprise-hub-launcher-version": "0.1.0",
      "x-forwarded-for": input.forwardedIp,
      "x-request-id": input.requestId
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: {
        name: "upload_evidence_document",
        arguments: {
          file: {
            name: `${input.requestId}.md`,
            mediaType: "text/markdown",
            encoding: "base64",
            contentBase64: Buffer.from(
              `# ${input.title}\n\nSynthetic MCP audit cleanup fixture.\n`,
              "utf8"
            ).toString("base64")
          },
          title: input.title,
          sourceSystem: input.sourceSystem,
          labelKeys: ["store:baoli"]
        }
      }
    })
  });
  const envelope = (await response.json()) as McpToolEnvelope;
  const toolResult = envelope.result;
  const text = toolResult?.content?.find((content) => content.type === "text")?.text;
  assert(response.status === 200, "Synthetic MCP upload must return HTTP 200.");
  assert(toolResult?.isError === false && Boolean(text), "Synthetic MCP upload must succeed.");
  return JSON.parse(text!) as EvidenceUploadResponse;
}

function oauthHeaders(requestId: string, forwardedIp: string): Record<string, string> {
  return {
    "content-type": "application/x-www-form-urlencoded",
    "x-enterprise-hub-launcher-version": "0.1.0",
    "x-forwarded-for": forwardedIp,
    "x-request-id": requestId
  };
}

function assertBusinessAudit(
  rows: Array<{
    requestId: string | null;
    targetId: string | null;
    action: string;
    targetType: string;
    result: string;
    clientIp: string | null;
    clientSource: string | null;
    launcherVersion: string | null;
  }>,
  requestId: string,
  documentId: string,
  clientIp: string,
  clientSource: string,
  launcherVersion: string | null
): void {
  const row = rows.find((candidate) => candidate.requestId === requestId);
  assert(Boolean(row), `Missing persisted audit row for ${requestId}.`);
  assert(
    row!.action === "document.uploaded" &&
      row!.targetType === "document" &&
      row!.targetId === documentId &&
      row!.result === "succeeded" &&
      row!.clientIp === clientIp &&
      row!.clientSource === clientSource &&
      row!.launcherVersion === launcherVersion,
    `Persisted audit provenance mismatch for ${requestId}.`
  );
}

function assertAuthEvent(
  event: { sourceIp: string | null; launcherVersion: string | null } | null,
  sourceIp: string,
  launcherVersion: string | null,
  origin: string
): void {
  assert(Boolean(event), `Missing persisted ${origin} security event.`);
  assert(
    event!.sourceIp === sourceIp && event!.launcherVersion === launcherVersion,
    `Persisted ${origin} security-event provenance mismatch.`
  );
}

async function cleanupAuditProvenanceRun(
  prisma: PrismaClient,
  storage: LocalFileSystemStorageAdapter,
  input: {
    sourceSystem: string;
    businessRequestIds: string[];
    authRequestIds: string[];
    transactionIds: string[];
    sessionIds: string[];
  }
): Promise<void> {
  const documents = await prisma.document.findMany({
    where: { sourceSystem: input.sourceSystem },
    select: {
      id: true,
      storageObjectKey: true,
      chunks: {
        where: { qdrantPointId: { not: null } },
        select: { qdrantPointId: true }
      }
    }
  });
  const documentIds = documents.map((document) => document.id);
  const storageObjectKeys = documents.map((document) => document.storageObjectKey);
  const qdrantPointIds = documents.flatMap((document) =>
    document.chunks
      .map((chunk) => chunk.qdrantPointId)
      .filter((pointId): pointId is string => Boolean(pointId))
  );
  await deleteIntegrationQdrantPoints(qdrantPointIds);
  for (const key of storageObjectKeys) {
    await storage.deleteObject(key);
  }

  const discoveredEvents = await prisma.authSecurityEvent.findMany({
    where: {
      OR: [
        { requestId: { in: input.authRequestIds } },
        ...(input.sessionIds.length > 0 ? [{ sessionId: { in: input.sessionIds } }] : [])
      ]
    },
    select: { sessionId: true }
  });
  const sessionIds = [
    ...new Set([
      ...input.sessionIds,
      ...discoveredEvents
        .map((event) => event.sessionId)
        .filter((sessionId): sessionId is string => Boolean(sessionId))
    ])
  ];

  await prisma.$transaction(async (tx) => {
    await tx.auditLog.deleteMany({
      where: {
        OR: [
          { requestId: { in: input.businessRequestIds } },
          ...(documentIds.length > 0 ? [{ targetId: { in: documentIds } }] : [])
        ]
      }
    });
    await tx.authSecurityEvent.deleteMany({
      where: {
        OR: [
          { requestId: { in: input.authRequestIds } },
          ...(sessionIds.length > 0 ? [{ sessionId: { in: sessionIds } }] : [])
        ]
      }
    });
    if (sessionIds.length > 0) {
      await tx.authSession.deleteMany({ where: { id: { in: sessionIds } } });
    }
    if (input.transactionIds.length > 0) {
      await tx.oAuthAuthorizationTransaction.deleteMany({
        where: { id: { in: input.transactionIds } }
      });
    }
    if (documentIds.length > 0) {
      await tx.document.deleteMany({ where: { id: { in: documentIds } } });
    }
  });

  let retainedStorageObjects = 0;
  for (const key of storageObjectKeys) {
    try {
      await storage.statObject(key);
      retainedStorageObjects += 1;
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) {
        throw error;
      }
    }
  }
  const [
    retainedDocuments,
    retainedAudits,
    retainedEvents,
    retainedSessions,
    retainedTransactions
  ] = await Promise.all([
    prisma.document.count({ where: { sourceSystem: input.sourceSystem } }),
    prisma.auditLog.count({ where: { requestId: { in: input.businessRequestIds } } }),
    prisma.authSecurityEvent.count({
      where: {
        OR: [
          { requestId: { in: input.authRequestIds } },
          ...(sessionIds.length > 0 ? [{ sessionId: { in: sessionIds } }] : [])
        ]
      }
    }),
    sessionIds.length > 0
      ? prisma.authSession.count({ where: { id: { in: sessionIds } } })
      : Promise.resolve(0),
    input.transactionIds.length > 0
      ? prisma.oAuthAuthorizationTransaction.count({
          where: { id: { in: input.transactionIds } }
        })
      : Promise.resolve(0)
  ]);
  const retainedQdrantPoints = await retrieveIntegrationQdrantPointCount(qdrantPointIds);
  assert(
    retainedDocuments === 0 &&
      retainedAudits === 0 &&
      retainedEvents === 0 &&
      retainedSessions === 0 &&
      retainedTransactions === 0 &&
      retainedStorageObjects === 0 &&
      retainedQdrantPoints === 0,
    "Audit provenance integration cleanup must leave no run-scoped DB/storage/Qdrant residue."
  );
}

async function deleteIntegrationQdrantPoints(pointIds: string[]): Promise<void> {
  if (pointIds.length === 0) {
    return;
  }
  const response = await fetch(`${integrationQdrantCollectionUrl()}/points/delete?wait=true`, {
    method: "POST",
    headers: integrationQdrantHeaders(),
    body: JSON.stringify({ points: pointIds })
  });
  assert(response.ok, `Qdrant provenance cleanup failed with HTTP ${response.status}.`);
}

async function retrieveIntegrationQdrantPointCount(pointIds: string[]): Promise<number> {
  if (pointIds.length === 0) {
    return 0;
  }
  const response = await fetch(`${integrationQdrantCollectionUrl()}/points`, {
    method: "POST",
    headers: integrationQdrantHeaders(),
    body: JSON.stringify({ ids: pointIds, with_payload: false, with_vector: false })
  });
  assert(response.ok, `Qdrant provenance verification failed with HTTP ${response.status}.`);
  const body = (await response.json()) as { result?: unknown[] };
  assert(Array.isArray(body.result), "Qdrant provenance verification returned invalid JSON.");
  return body.result.length;
}

function integrationQdrantCollectionUrl(): string {
  const baseUrl = integrationEnv["QDRANT_URL"]!.replace(/\/$/, "");
  return `${baseUrl}/collections/${encodeURIComponent(integrationEnv["QDRANT_COLLECTION_EVIDENCE"]!)}`;
}

function integrationQdrantHeaders(): Record<string, string> {
  const apiKey = integrationEnv["QDRANT_API_KEY"]?.trim();
  return {
    "content-type": "application/json",
    ...(apiKey ? { "api-key": apiKey } : {})
  };
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

async function collectStreamBytes(stream: NodeJS.ReadableStream): Promise<Uint8Array> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}
