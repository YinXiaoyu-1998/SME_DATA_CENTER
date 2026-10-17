import { spawn } from "node:child_process";
import assertStrict from "node:assert/strict";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
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
  createLauncherToolHandler,
  parseCurrentUserProfileResponse,
  type LauncherToolDependencies
} from "../apps/mcp-launcher/src/index.js";
import { COST_CARD_UPLOAD_SCHEMA, hashCostCard, normalizeEnterpriseIdentity } from "@smedc/domain";
import { readCostCardCsv } from "@smedc/structured-ingestion";
import { parse as parseCsv } from "csv-parse/sync";
import {
  DEVICE_VERIFY_COOKIE,
  OAUTH_CLIENT_ID,
  csrfTokenForSecret
} from "../apps/api/src/auth/http-contract.js";
import { createPrismaAuthCoreRepository } from "../apps/api/src/auth/prisma-auth-repository.js";
import { createPrismaProcessingWorkerRepository } from "../apps/worker/src/worker.js";
import { createBusinessAuthorizationRepository } from "@smedc/db";
import { LocalFileSystemStorageAdapter } from "@smedc/storage";
import { LAUNCHER_VERSION } from "../apps/mcp-launcher/src/oauth-client.js";
import {
  comparePartitionDownloads,
  createCostCardIntegrationFixture,
  createOwnedIntegrationDatabase,
  integrationDatabasePlan
} from "./test-integration-support.js";

const INTEGRATION_EVIDENCE_CATEGORY_ID = "integration-evidence";
const INTEGRATION_EVIDENCE_SCOPES = [
  { enterpriseKey: "integration-evidence-enterprise", ownership: "group" as const, dimensions: {} }
];
const DEFAULT_MYSQL_PORT = "3307";
const DEFAULT_DATABASE_URL = (mysqlPort: string) =>
  `mysql://smedc:smedc_local_password@localhost:${mysqlPort}/smedc`;
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
  sources: Array<{
    sourceDocumentId: string;
    downloadStatus: "available" | "unavailable";
    downloadUrl: string | null;
  }>;
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

const businessAuthorizationOnly = process.argv.includes("--business-authorization-only");
const structuredReadsOnly = process.argv.includes("--structured-reads-only");
const ledgerAuthorizationOnly = process.argv.includes("--ledger-authorization-only");
const partitionDownloadsOnly = process.argv.includes("--partition-downloads-only");
const storeReviewsOnly = process.argv.includes("--store-reviews-only");
const costCardsOnly = process.argv.includes("--cost-cards-only");
const focusedAuthorization =
  businessAuthorizationOnly ||
  structuredReadsOnly ||
  ledgerAuthorizationOnly ||
  costCardsOnly ||
  storeReviewsOnly ||
  partitionDownloadsOnly;
const rootDir = process.cwd();
const mysqlPort = process.env["MYSQL_PORT"] ?? DEFAULT_MYSQL_PORT;
// Reject nonlocal or driver-override connections before any local setup/mutation.
integrationDatabasePlan(process.env["DATABASE_URL"] ?? DEFAULT_DATABASE_URL(mysqlPort), mysqlPort);
const integrationPort = optionalEnv("HUB_INTEGRATION_PORT") ?? String(await findAvailablePort());
const apiUrl = `http://127.0.0.1:${integrationPort}`;
const integrationRoot = path.join(rootDir, ".data", "integration");
const storageRoot = path.join(integrationRoot, "storage");

const integrationEnv: NodeJS.ProcessEnv = {
  ...process.env,
  MYSQL_PORT: mysqlPort,
  DATABASE_URL: process.env["DATABASE_URL"] ?? DEFAULT_DATABASE_URL(mysqlPort),
  CURSOR_SIGNING_SECRET: process.env["CURSOR_SIGNING_SECRET"] ?? DEFAULT_CURSOR_SIGNING_SECRET,
  SMEDC_PUBLIC_ORIGIN: process.env["SMEDC_PUBLIC_ORIGIN"] ?? "https://api.smedatacenter.xyz",
  STORAGE_DRIVER: "local",
  LOCAL_STORAGE_ROOT: storageRoot,
  QDRANT_URL: process.env["QDRANT_URL"] ?? "http://127.0.0.1:6333",
  QDRANT_COLLECTION_EVIDENCE:
    process.env["QDRANT_COLLECTION_EVIDENCE"] ?? "smedc_evidence_integration",
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
  PARTITION_IMPORT_WORK_DIR: path.join(integrationRoot, "partition-work"),
  PARTITION_IMPORT_MIN_FREE_BYTES: "1",
  NODE_ENV: "development",
  HOST: "127.0.0.1",
  PORT: integrationPort
};

let apiProcess: ReturnType<typeof spawn> | null = null;
let ownedDatabase: Awaited<ReturnType<typeof createOwnedIntegrationDatabase>> | undefined;
let integrationFailed = false;
const officialSessionCleanup: Array<() => Promise<void>> = [];

integrationRun: try {
  // Focused mode uses an already-running loopback MySQL and the same owned-schema runner.
  if (!focusedAuthorization) {
    await prepareLocalWorkspace();
    await run("docker", ["compose", "up", "-d", "mysql", "qdrant"], { env: integrationEnv });
    await waitForMysqlHealth();
  }
  ownedDatabase = await createOwnedIntegrationDatabase(integrationEnv["DATABASE_URL"]!, mysqlPort);
  integrationEnv["DATABASE_URL"] = ownedDatabase.databaseUrl;
  await run("npm", ["run", "db:generate"], { env: integrationEnv });
  await run("npm", ["run", "db:migrate:deploy"], { env: integrationEnv });
  // These opt-in Prisma regressions are not covered by the procedural scenario or npm test.
  const prismaRegressions = await run(
    "npx",
    [
      "vitest",
      "run",
      "--no-file-parallelism",
      ...(storeReviewsOnly
        ? [
            "packages/db/src/store-reviews.prisma.integration.test.ts",
            "packages/db/src/store-review-enterprises.prisma.integration.test.ts",
            "packages/db/src/business-authorization.prisma.integration.test.ts",
            "apps/api/src/business-authorization-cutover.prisma.integration.test.ts"
          ]
        : costCardsOnly
          ? [
              "packages/db/src/cost-cards.prisma.integration.test.ts",
              "apps/worker/src/cost-card-import.prisma.integration.test.ts",
              "apps/api/src/cost-cards.prisma.integration.test.ts"
            ]
          : partitionDownloadsOnly
            ? ["packages/db/src/partition-downloads.prisma.integration.test.ts"]
            : ledgerAuthorizationOnly
              ? [
                  "packages/ledger-archive/src/publication.prisma.integration.test.ts",
                  "packages/ledger-archive/src/source-reader.prisma.integration.test.ts"
                ]
              : structuredReadsOnly
                ? ["apps/api/src/structured-query.prisma.integration.test.ts"]
                : businessAuthorizationOnly
                  ? ["apps/api/src/business-authorization-cutover.prisma.integration.test.ts"]
                  : [
                      "apps/api/src/structured-query.prisma.integration.test.ts",
                      "packages/ledger-archive/src/publication.prisma.integration.test.ts",
                      "packages/ledger-archive/src/source-reader.prisma.integration.test.ts",
                      "apps/api/src/business-authorization-cutover.prisma.integration.test.ts",
                      "packages/db/src/structured-partitions.prisma.integration.test.ts",
                      "packages/db/src/partition-downloads.prisma.integration.test.ts",
                      "packages/db/src/cost-cards.prisma.integration.test.ts",
                      "apps/worker/src/cost-card-import.prisma.integration.test.ts",
                      "apps/api/src/cost-cards.prisma.integration.test.ts",
                      "packages/db/src/store-reviews.prisma.integration.test.ts",
                      "packages/db/src/store-review-enterprises.prisma.integration.test.ts",
                      "scripts/test-integration-support.test.ts"
                    ]),
      ...(!storeReviewsOnly &&
      !costCardsOnly &&
      !structuredReadsOnly &&
      !ledgerAuthorizationOnly &&
      !partitionDownloadsOnly
        ? [
            "packages/db/src/business-authorization.prisma.integration.test.ts",
            "apps/api/src/permissions-operator/cli.prisma.integration.test.ts"
          ]
        : [])
    ],
    {
      env: {
        ...integrationEnv,
        RUN_LEDGER_PRISMA_INTEGRATION: "1",
        RUN_STRUCTURED_QUERY_PRISMA_INTEGRATION: "1",
        RUN_PARTITION_PRISMA_INTEGRATION: "1",
        RUN_BUSINESS_AUTHORIZATION_PRISMA_INTEGRATION: "1",
        RUN_PERMISSIONS_OPERATOR_PRISMA_INTEGRATION: "1",
        RUN_COST_CARD_PRISMA_INTEGRATION: "1",
        RUN_STORE_REVIEW_PRISMA_INTEGRATION: "1"
      }
    }
  );
  process.stdout.write(prismaRegressions.stdout);
  // Exit the scenario through the shared finally cleanup, without starting API/Qdrant.
  if (focusedAuthorization) break integrationRun;
  await run("npm", ["run", "db:seed"], { env: integrationEnv });
  const identitySetup = new PrismaClient({
    adapter: new PrismaMariaDb(integrationEnv["DATABASE_URL"]!)
  });
  try {
    const state = await identitySetup.businessAuthorizationState.upsert({
      where: { orgId: "default-org" },
      create: { orgId: "default-org" },
      update: {}
    });
    await createBusinessAuthorizationRepository({ prisma: identitySetup }).configureCategory({
      orgId: "default-org",
      actorId: "emp_admin",
      expectedVersion: state.version.toString(),
      id: INTEGRATION_EVIDENCE_CATEGORY_ID,
      name: "Synthetic integration evidence",
      kind: "evidence",
      confidentialityLevel: null,
      ownerships: ["group"],
      requiredDimensionIds: [],
      createOnly: true
    });
    await identitySetup.employee.update({ where: { id: "emp_admin" }, data: { clearance: 0 } });
    await identitySetup.employee.update({
      where: { id: "emp_baoli_employee" },
      data: { clearance: 0 }
    });
    await identitySetup.employee.update({
      where: { id: "emp_suzhou_employee" },
      data: { clearance: 3 }
    });
  } finally {
    await identitySetup.$disconnect();
  }
  await run("npm", ["run", "qdrant:init"], { env: integrationEnv });

  apiProcess = startApi();
  await waitForApiHealth(apiProcess);

  const employeeAccessToken = await createOfficialIntegrationAccessToken("emp_baoli_employee");
  const employeeAuth = authorizationHeader(employeeAccessToken);
  const adminAccessToken = await createOfficialIntegrationAccessToken("emp_admin");
  const adminAuth = authorizationHeader(adminAccessToken);
  const highEmployeeAuth = authorizationHeader(
    await createOfficialIntegrationAccessToken("emp_suzhou_employee")
  );
  await assertEmployeeUploadDenied(employeeAuth, "emp_baoli_employee");
  await assertEmployeeUploadDenied(highEmployeeAuth, "emp_suzhou_employee");

  const partitionFixturePath = path.join(
    rootDir,
    "fixtures",
    "manual-acceptance",
    "structured",
    "dishes-known-values.csv"
  );
  const partitionFixture = await readFile(partitionFixturePath);
  const legacyPartitionForm = new FormData();
  legacyPartitionForm.append(
    "file",
    new Blob([new Uint8Array(partitionFixture)]),
    "dishes-known-values.csv"
  );
  legacyPartitionForm.append("dataset", "dishes");
  legacyPartitionForm.append("enterprise_name", "Integration Partitions");
  legacyPartitionForm.append("startDate", "20260701");
  legacyPartitionForm.append("endDate", "20260703");
  legacyPartitionForm.append("idempotencyKey", `legacy-rejected-${Date.now()}`);
  const legacyPartitionUpload = await fetch(`${apiUrl}/v1/structured/imports`, {
    method: "POST",
    headers: adminAuth,
    body: legacyPartitionForm
  });
  const legacyPartitionBody = (await legacyPartitionUpload.json()) as {
    error?: { code?: string };
  };
  assert(
    legacyPartitionUpload.status === 409 &&
      legacyPartitionBody.error?.code === "PARTITION_UPLOAD_SESSION_REQUIRED",
    "business and dishes must be rejected by the removed row-import endpoint."
  );

  const launcherDependenciesFor = (accessToken: string) =>
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
        accessToken: async () => accessToken,
        profile: async () => {
          const response = await fetch(`${apiUrl}/me`, {
            headers: authorizationHeader(accessToken)
          });
          assert(response.ok, "Launcher account profile lookup must succeed.");
          return parseCurrentUserProfileResponse(await response.json());
        },
        invalidate: async () => undefined,
        selfCheck: async () => {
          throw new Error("not used");
        }
      }
    });
  const launcherDependencies = launcherDependenciesFor(adminAccessToken);
  const employeeLauncherDependencies = launcherDependenciesFor(employeeAccessToken);
  for (const fixture of [
    {
      dataset: "delivery_ledger",
      filePath: "fixtures/structured/delivery_sheet_SH2608250117.xlsx",
      mediaType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    },
    {
      dataset: "vip",
      filePath: "fixtures/manual-acceptance/structured/vip-known-values.csv",
      mediaType: "text/csv",
      startDate: "20260809",
      endDate: "20260809"
    }
  ]) {
    const uploaded = await createLauncherToolHandler(
      "upload_structured_dataset",
      launcherDependencies
    )({
      file: {
        name: path.basename(fixture.filePath),
        mediaType: fixture.mediaType,
        encoding: "path",
        filePath: path.join(rootDir, fixture.filePath)
      },
      dataset: fixture.dataset,
      enterpriseName: "Integration Row Imports",
      ...(fixture.startDate ? { startDate: fixture.startDate, endDate: fixture.endDate } : {}),
      idempotencyKey: `row-integration-${fixture.dataset}-${Date.now()}`,
      confidentialityLevel: 0
    });
    assert(!uploaded.isError, `Admin c0 row upload failed: ${JSON.stringify(uploaded)}`);
    const receipt = JSON.parse(uploaded.content[0]?.text ?? "null") as {
      importBatch: { importBatchId: string };
    };
    const worker = parseJson<WorkerResponse>(
      (await run("npm", ["--silent", "run", "worker:once"], { env: integrationEnv })).stdout
    );
    assert(worker.status === "active", "Row-import worker must apply the original XLSX/CSV.");
    const status = await createLauncherToolHandler(
      "get_import_status",
      launcherDependencies
    )({ importBatchId: receipt.importBatch.importBatchId });
    const statusBody = JSON.parse(status.content[0]?.text ?? "null") as {
      importBatch: { status: string };
    };
    assert(
      !status.isError && statusBody.importBatch.status === "applied",
      "Original row import must reach applied status."
    );
    const queried = await createLauncherToolHandler(
      "query_structured_dataset",
      employeeLauncherDependencies
    )({ dataset: fixture.dataset, aggregates: [{ op: "count", as: "row_count" }] });
    if (fixture.dataset === "delivery_ledger") {
      const denied = JSON.parse(queried.content[0]?.text ?? "null") as {
        error?: { code?: string };
      };
      assert(
        queried.isError && denied.error?.code === "LEDGER_DETAIL_DISABLED",
        "Raw ledger aggregation must remain unavailable through the official launcher."
      );
      continue;
    }
    const result = JSON.parse(queried.content[0]?.text ?? "null") as {
      rows: Array<{ row_count: number }>;
    };
    assert(
      !queried.isError && Number(result.rows[0]?.row_count) > 0,
      "Employee c0 must query admin-uploaded level-0 rows."
    );
  }
  const partitionIdempotencyKey = `partition-integration-${Date.now()}`;
  const partitionUploadInput = {
    file: {
      name: "dishes-known-values.csv",
      mediaType: "text/csv",
      encoding: "path" as const,
      filePath: partitionFixturePath
    },
    dataset: "dishes" as const,
    enterpriseName: "Integration Partitions",
    startDate: "20260701",
    endDate: "20260703",
    idempotencyKey: partitionIdempotencyKey,
    confidentialityLevel: 0
  };
  const partitionUploadResult = await createLauncherToolHandler(
    "upload_structured_dataset",
    launcherDependencies
  )(partitionUploadInput);
  assert(
    !partitionUploadResult.isError,
    `Partition launcher upload failed: ${JSON.stringify(partitionUploadResult)}`
  );
  const partitionUpload = JSON.parse(partitionUploadResult.content[0]?.text ?? "null") as {
    partitionImportJobId: string;
    status: string;
  };
  assert(
    partitionUpload.status === "queued" && Boolean(partitionUpload.partitionImportJobId),
    "Partition launcher upload should complete multipart transport and queue one job."
  );

  const partitionWorker = parseJson<WorkerResponse>(
    (await run("npm", ["--silent", "run", "worker:once"], { env: integrationEnv })).stdout
  );
  assert(
    partitionWorker.documentId === partitionUpload.partitionImportJobId &&
      partitionWorker.status === "active",
    "Worker should atomically publish the uploaded partition dataset."
  );
  const publishedPartitionJob = await waitForPartitionImportStatus(
    partitionUpload.partitionImportJobId,
    adminAuth,
    "published"
  );
  assert(
    publishedPartitionJob.partitionCount === 3 && publishedPartitionJob.totalRowCount === 3,
    "Three complete source days for one store should publish as three partitions."
  );

  const exactReplay = await createLauncherToolHandler(
    "upload_structured_dataset",
    launcherDependencies
  )(partitionUploadInput);
  const exactReplayBody = JSON.parse(exactReplay.content[0]?.text ?? "null") as {
    partitionImportJobId: string;
    status: string;
  };
  assert(
    !exactReplay.isError &&
      exactReplayBody.partitionImportJobId === partitionUpload.partitionImportJobId &&
      exactReplayBody.status === "published",
    "An exact source replay should reuse the published job without re-uploading."
  );

  const partitionComparison = await comparePartitionDownloads({
    context: {
      serviceUrl: apiUrl,
      accessToken: employeeAccessToken,
      launcherVersion: LAUNCHER_VERSION,
      fetchImplementation: fetch
    },
    scope: {
      dataset: "dishes",
      enterpriseName: "Integration Partitions",
      startDate: "2026-07-01",
      endDate: "2026-07-03"
    },
    amountColumn: "菜品总收入",
    expected: { partitionCount: 3, rowCount: 3, amountCents: 8500 },
    build: async () => {
      const result = parseJson<WorkerResponse>(
        (await run("npm", ["--silent", "run", "worker:once"], { env: integrationEnv })).stdout
      );
      assert(
        result.processed && result.status === "active",
        "Worker must publish the comparison ZIP."
      );
    }
  });

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
  evidenceForm.append("confidentialityLevel", "0");
  evidenceForm.append("categoryId", INTEGRATION_EVIDENCE_CATEGORY_ID);
  evidenceForm.append("scopes", JSON.stringify(INTEGRATION_EVIDENCE_SCOPES));
  const evidenceUpload = await apiJson<EvidenceUploadResponse>("/v1/documents/evidence", {
    method: "POST",
    headers: adminAuth,
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

  await waitForEvidenceStatus(evidenceUpload.document.documentId, adminAuth);
  const evidenceSearch = await apiJson<EvidenceSearchResponse>("/v1/evidence/search", {
    method: "POST",
    headers: { ...employeeAuth, "content-type": "application/json" },
    body: JSON.stringify({ query: "差评处理", filters: { fileTypes: ["md"] }, limit: 5 })
  });
  assert(
    evidenceSearch.results.some(
      (result) =>
        result.documentId === evidenceUpload.document.documentId && result.text.includes("差评处理")
    ),
    "Evidence search should return indexed evidence chunks."
  );
  assert(
    evidenceSearch.sources.length === 1 &&
      evidenceSearch.sources[0]?.sourceDocumentId === evidenceUpload.document.documentId &&
      evidenceSearch.sources[0]?.downloadStatus === "available" &&
      Boolean(evidenceSearch.sources[0]?.downloadUrl),
    "Every distinct evidence source must include one automatic download URL."
  );
  const firstEvidencePage = await apiJson<EvidenceSearchResponse>("/v1/evidence/search", {
    method: "POST",
    headers: { ...employeeAuth, "content-type": "application/json" },
    body: JSON.stringify({ query: "差评处理", filters: { fileTypes: ["md"] }, limit: 1 })
  });
  assert(
    firstEvidencePage.results.length === 1 && Boolean(firstEvidencePage.page.nextCursor),
    "Evidence search should return a signed cursor when more authorized chunks remain."
  );
  const secondEvidencePage = await apiJson<EvidenceSearchResponse>("/v1/evidence/search", {
    method: "POST",
    headers: { ...employeeAuth, "content-type": "application/json" },
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
  await assertDualCollectionEvidenceReindex({
    documentId: evidenceUpload.document.documentId,
    auth: employeeAuth,
    v1Cursor: firstEvidencePage.page.nextCursor!
  });
  await assertWorkerLeaseRecovery();
  await assertAdminUploadClearanceOrthogonality(adminAuth, highEmployeeAuth);
  await assertAuditProvenanceMatrix(adminAccessToken);
  const costCards = await assertCostCardWorkflow({
    admin: launcherDependencies,
    reader: launcherDependenciesFor(
      await createOfficialIntegrationAccessToken("emp_suzhou_employee")
    ),
    denied: employeeLauncherDependencies
  });

  console.log(
    JSON.stringify(
      {
        ok: true,
        partitionImportJobId: partitionUpload.partitionImportJobId,
        evidenceDocumentId: evidenceUpload.document.documentId,
        apiUrl,
        mysqlPort,
        partitionComparison,
        costCards,
        proved: [
          "seed",
          "official_session_authentication",
          "employee_c0_upload_denied_audit_once_no_residue",
          "employee_c3_upload_denied_audit_once_no_residue",
          "admin_c0_delivery_xlsx_and_row_csv_employee_c0_query",
          "admin_c0_upload_level2_employee_c3_reads_admin_read_denied",
          "partition_upload_session",
          "partition_worker_atomic_publish",
          "partition_exact_replay",
          "partition_manifest_local_download",
          "partition_zip_same_csv_hashes_counts_aggregate_and_request_counts",
          "partition_prisma_repository_regressions",
          "cost_card_original_precision_hash_csv_launcher_local_filter",
          "cost_card_archive_replay_restore_rollback_authorization",
          "cost_card_prisma_atomicity_gc_manifest_regressions",
          "legacy_business_dishes_row_import_rejected",
          "delivery_supplier_query_authorization",
          "phase3_evidence_upload_worker_status_search",
          "phase3_evidence_signed_pagination",
          "phase3_evidence_v1_v2_dual_collection_reindex",
          "phase3_evidence_cross_version_cursor_rejected",
          "phase3_worker_lease_crash_recovery",
          "audit_provenance_persistence_matrix",
          "audit_provenance_run_scoped_cleanup"
        ]
      },
      null,
      2
    )
  );
} catch (error) {
  integrationFailed = true;
  throw error;
} finally {
  await Promise.allSettled(officialSessionCleanup.splice(0).map((cleanup) => cleanup()));
  if (apiProcess) {
    await stopApi(apiProcess);
  }
  if (ownedDatabase) {
    try {
      await ownedDatabase.cleanup();
    } catch {
      console.error(
        JSON.stringify({ event: "integration_schema_cleanup_failed", schema: ownedDatabase.schema })
      );
      if (!integrationFailed) process.exitCode = 1;
    }
  }
}

async function assertCostCardWorkflow(input: {
  admin: LauncherToolDependencies;
  reader: LauncherToolDependencies;
  denied: LauncherToolDependencies;
}) {
  const prisma = new PrismaClient({ adapter: new PrismaMariaDb(integrationEnv["DATABASE_URL"]!) });
  const permissions = createBusinessAuthorizationRepository({ prisma });
  const enterpriseName = "Integration Cost Cards";
  const enterpriseKey = normalizeEnterpriseIdentity(enterpriseName).enterpriseKey;
  const directories: string[] = [];
  const fixture = await createCostCardIntegrationFixture();
  const filePath = path.join(integrationRoot, "cost-card-original.xlsx");
  const csvPath = path.join(integrationRoot, "cost-card-original.csv");
  const key = `cost-card-integration-${Date.now()}`;
  type Receipt = {
    importBatch: {
      importBatchId: string;
      sourceDocumentId: string;
      status: string;
      publicationSummary?: {
        counts: { inserted: number; updated: number; unchanged: number; restored: number };
        inputCardCount: number;
        inputItemRowCount: number;
      };
    };
  };
  type DirectoryRow = {
    cost_card_id: string;
    spu_id: string;
    sku_id: string;
    specification_name: string;
    sale_price: string;
    revision: string;
    source_document_id: string;
    import_batch_id: string;
  };
  const call = async <T>(name: string, args: unknown, dependencies = input.reader): Promise<T> => {
    const result = await createLauncherToolHandler(name, dependencies)(args);
    assert(!result.isError, `${name} must succeed: ${JSON.stringify(result)}`);
    return parseJson<T>(result.content[0]?.text ?? "null");
  };
  const query = () =>
    call<{ rows: DirectoryRow[] }>("query_structured_dataset", {
      dataset: "cost_cards",
      filter: { field: "dish_name", op: "eq", value: "合成精度锅" },
      select: [
        "cost_card_id",
        "spu_id",
        "sku_id",
        "specification_name",
        "sale_price",
        "revision",
        "source_document_id",
        "import_batch_id"
      ]
    });
  const upload = (file: string, idempotencyKey: string) =>
    call<Receipt>(
      "upload_structured_dataset",
      {
        dataset: "cost_cards",
        enterpriseName,
        idempotencyKey,
        file: {
          name: path.basename(file),
          mediaType: file.endsWith(".xlsx")
            ? "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
            : "text/csv",
          encoding: "path",
          filePath: file
        }
      },
      input.admin
    );
  const worker = async (expected: string) => {
    const result = parseJson<WorkerResponse>(
      (await run("npm", ["--silent", "run", "worker:once"], { env: integrationEnv })).stdout
    );
    assert(result.processed && result.status === expected, `Cost-card worker must be ${expected}.`);
  };
  const snapshot = async () =>
    JSON.stringify(
      await prisma.costCard.findMany({
        where: { orgId: "default-org", enterpriseKey },
        orderBy: { id: "asc" }
      }),
      (_key, value: unknown) => (typeof value === "bigint" ? value.toString() : value)
    );
  const download = async (ids: string[], expectedSource: Map<string, DirectoryRow>) => {
    const result = await call<{
      localDirectory: string;
      files: string[];
      cardCount: number;
      totalItemRowCount: number;
    }>("download_cost_cards", { costCardIds: ids });
    directories.push(result.localDirectory);
    assert(result.cardCount === ids.length, "Launcher must deliver every selected card.");
    const localManifestText = await readFile(
      path.join(result.localDirectory, "manifest.json"),
      "utf8"
    );
    assert(
      !/presignedDownloadUrl|file:\/\/|objectKey/.test(localManifestText),
      "Local manifest must contain no signed capabilities or object keys."
    );
    const manifest = JSON.parse(localManifestText) as {
      cards: Array<{
        costCardId: string;
        fileName: string;
        sourceDocumentId: string;
        importBatchId: string;
      }>;
    };
    let itemCount = 0;
    for (const entry of manifest.cards) {
      const directory = expectedSource.get(entry.costCardId)!;
      assert(
        entry.sourceDocumentId === directory.source_document_id &&
          entry.importBatchId === directory.import_batch_id,
        "Local manifest sources must match each independently published directory."
      );
      const localPath = path.join(result.localDirectory, entry.fileName);
      const bytes = await readFile(localPath);
      const rows = parseCsv(bytes, { columns: true }) as Array<Record<string, string>>;
      assertStrict.deepEqual(Object.keys(rows[0]!), [
        ...fixture.headers,
        "source_sheet_index",
        "source_sheet_name",
        "source_row_number"
      ]);
      assert(
        rows.length === 3 &&
          rows.filter((row) => row["配方类型"] === "全局（标准配方）").length === 2,
        "Duplicate standard rows and the exception recipe must survive local string parsing."
      );
      for (const row of rows) {
        const original = fixture.rows[Number(row["source_row_number"]) - 2]!;
        assert(
          original &&
            row["source_sheet_index"] === "0" &&
            row["source_sheet_name"] === fixture.sheetName,
          "Every source locator must identify its original worksheet and row."
        );
        for (const field of COST_CARD_UPLOAD_SCHEMA)
          assertStrict.equal(
            row[field.sourceColumn],
            original[field.canonicalName],
            `Exact ${field.sourceColumn} string`
          );
      }
      assert(
        rows.filter((row) => row["物品编码"] === "0007").length === 3,
        "Agent-side item filtering preserves leading-zero identifiers."
      );
      const canonical = await readCostCardCsv({
        stream: createReadStream(localPath),
        schemaVersion: 1,
        identity: {
          enterpriseKey,
          sourceNamespace: "meituan",
          spuId: directory.spu_id,
          skuId: directory.sku_id
        }
      });
      const stored = await prisma.costCard.findUniqueOrThrow({ where: { id: entry.costCardId } });
      assert(
        hashCostCard(canonical) === stored.contentHash &&
          createHash("sha256").update(bytes).digest("hex") === stored.checksumSha256,
        "Original reader, business hash, CSV bytes and verified launcher extraction must agree."
      );
      itemCount += rows.length;
    }
    assert(
      itemCount === result.totalItemRowCount,
      "Manifest item counts must match downloaded CSV rows."
    );
    return result;
  };
  try {
    // Only this owned synthetic schema changes mode; existing evidence tests finished above.
    await prisma.businessAuthorizationState.update({
      where: { orgId: "default-org" },
      data: { mode: "enabled", version: { increment: 1 } }
    });
    const context = async () => ({
      orgId: "default-org",
      actorId: "emp_admin",
      expectedVersion: (await permissions.loadAuthorizationSnapshot("emp_admin", "default-org"))
        .authorizationVersion
    });
    await permissions.initializeFixedCategories(await context());
    const category = await prisma.businessCategory.findUniqueOrThrow({
      where: { orgId_key: { orgId: "default-org", key: "cost_cards" } }
    });
    await permissions.configureCategory({
      ...(await context()),
      id: category.id,
      name: "Synthetic cost cards",
      confidentialityLevel: 2,
      kind: "fixed",
      key: "cost_cards",
      ownerships: ["group"],
      requiredDimensionIds: []
    });
    await permissions.configureAccount({
      ...(await context()),
      employeeId: "emp_suzhou_employee",
      clearance: 3,
      grants: [
        {
          id: "integration-cost-card-group",
          orgId: "default-org",
          enterpriseKey,
          categoryIds: [category.id],
          ownership: "group",
          dimensions: {}
        }
      ]
    });
    await writeFile(filePath, fixture.xlsx);
    await writeFile(csvPath, fixture.csv);
    const first = await upload(filePath, key);
    await worker("active");
    const applied = await call<Receipt>("get_import_status", {
      importBatchId: first.importBatch.importBatchId
    });
    assert(applied.importBatch.status === "applied", "Original upload must reach applied.");
    assertStrict.deepEqual(applied.importBatch.publicationSummary, {
      ...(applied.importBatch.publicationSummary ?? {}),
      inputCardCount: 3,
      inputItemRowCount: 9,
      counts: { inserted: 3, updated: 0, unchanged: 0, restored: 0 }
    });
    const found = (await query()).rows;
    assert(
      found.length === 3 &&
        new Set(found.map((row) => `${row.spu_id}/${row.sku_id}`)).size === 3 &&
        new Set(found.map((row) => row.specification_name)).size === 3,
      "Same-name specifications and the same SKU on independent SPUs must remain distinct candidates."
    );
    assert(
      found.every((row) => row.sale_price === "99999999999999.123456"),
      "Directory JSON must preserve exact string prices."
    );
    const sources = new Map(found.map((row) => [row.cost_card_id, row]));
    await download(
      found.map((row) => row.cost_card_id),
      sources
    );
    // A new CSV request has equivalent numeric/text/percent values: hashes and pointers stay unchanged.
    const initialSnapshot = await snapshot();
    const equivalent = await upload(csvPath, `${key}-equivalent`);
    await worker("active");
    const unchanged = await call<Receipt>("get_import_status", {
      importBatchId: equivalent.importBatch.importBatchId
    });
    assertStrict.deepEqual(unchanged.importBatch.publicationSummary?.counts, {
      inserted: 0,
      updated: 0,
      unchanged: 3,
      restored: 0
    });
    assertStrict.equal(await snapshot(), initialSnapshot);
    // Original-file archival is independent of card CSV lifecycle.
    await prisma.document.update({
      where: { id: first.importBatch.sourceDocumentId },
      data: { status: "archived", archivedAt: new Date() }
    });
    await download(
      found.map((row) => row.cost_card_id),
      sources
    );
    const originalLink = await fetch(
      `${apiUrl}/v1/source-documents/${first.importBatch.sourceDocumentId}/download-url`,
      { method: "POST", headers: authorizationHeader(await input.reader.auth.accessToken()) }
    );
    assert(
      originalLink.status === 404,
      "Archived original access must fail while card downloads remain available."
    );
    const archived = await call<{ archived: boolean }>(
      "archive_cost_card",
      { costCardId: found[0]!.cost_card_id },
      input.admin
    );
    assert(
      archived.archived && (await query()).rows.length === 2,
      "One archive must leave sibling cards available."
    );
    const replay = await upload(filePath, key);
    assert(
      replay.importBatch.importBatchId === first.importBatch.importBatchId &&
        (await query()).rows.length === 2,
      "Old successful idempotent replay must not republish or restore an archived card."
    );
    const restored = await upload(filePath, `${key}-restore`);
    await worker("active");
    const restoreStatus = await call<Receipt>("get_import_status", {
      importBatchId: restored.importBatch.importBatchId
    });
    assertStrict.deepEqual(restoreStatus.importBatch.publicationSummary?.counts, {
      inserted: 0,
      updated: 0,
      unchanged: 2,
      restored: 1
    });
    const current = (await query()).rows;
    assert(
      current.some((row) => row.cost_card_id === found[0]!.cost_card_id && row.revision === "3"),
      "New authorized upload restores the stable card ID and advances revision."
    );
    await download(
      current.map((row) => row.cost_card_id),
      new Map(current.map((row) => [row.cost_card_id, row]))
    );
    const stable = await snapshot();
    const badPath = path.join(integrationRoot, "cost-card-invalid.csv");
    await writeFile(
      badPath,
      fixture.csv.toString("utf8").replace("99999999999999.000001", "invalid-decimal")
    );
    const bad = await upload(badPath, `${key}-bad`);
    await worker("rejected");
    const rejected = await call<Receipt>("get_import_status", {
      importBatchId: bad.importBatch.importBatchId
    });
    assert(
      rejected.importBatch.status === "rejected" && !rejected.importBatch.publicationSummary,
      "Bad file must reject without a publication summary."
    );
    assertStrict.equal(
      await snapshot(),
      stable,
      "Bad file cannot partially change any current card."
    );
    const forbidden = await createLauncherToolHandler(
      "download_cost_cards",
      input.denied
    )({ costCardIds: [found[0]!.cost_card_id] });
    assert(forbidden.isError, "Low-clearance ungranted employee cannot download card contents.");
    const forbiddenArchive = await createLauncherToolHandler(
      "archive_cost_card",
      input.reader
    )({ costCardId: found[0]!.cost_card_id });
    assert(
      forbiddenArchive.isError,
      "Ordinary read permission cannot grant administrator archive authority."
    );
    for (const queryInput of [
      { select: ["item_name"] },
      { aggregates: [{ op: "count", as: "count" }] }
    ]) {
      const response = await fetch(`${apiUrl}/v1/structured/query`, {
        method: "POST",
        headers: {
          ...authorizationHeader(await input.reader.auth.accessToken()),
          "content-type": "application/json"
        },
        body: JSON.stringify({ dataset: "cost_cards", ...queryInput })
      });
      assert(
        response.status === 400,
        "Server must reject cost-card detail projection and aggregation."
      );
    }
    const tables = await prisma.$queryRaw<Array<{ TABLE_NAME: string }>>`
      SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE()
      AND TABLE_NAME LIKE 'cost_card%'`;
    assertStrict.deepEqual(
      tables.map((table) => table.TABLE_NAME),
      ["cost_cards"],
      "MySQL must have only the cost-card directory, without recipe/item detail copies."
    );
    return {
      cardCount: 3,
      itemRowCount: 9,
      exactBusinessColumns: 35,
      sourceColumns: 3,
      sameNameSpecifications: 3,
      restoredStableId: found[0]!.cost_card_id
    };
  } finally {
    await Promise.all(
      directories.map((directory) => rm(directory, { recursive: true, force: true }))
    );
    await prisma.$disconnect();
  }
}

async function assertEmployeeUploadDenied(
  employeeAuth: Record<string, string>,
  employeeId: string
): Promise<void> {
  const prisma = new PrismaClient({ adapter: new PrismaMariaDb(integrationEnv["DATABASE_URL"]!) });
  const snapshot = async () => ({
    documents: await prisma.document.count(),
    imports: await prisma.importBatch.count(),
    jobs: await prisma.partitionImportJob.count(),
    partitions: await prisma.structuredPartition.count(),
    objects: await readdir(storageRoot, { recursive: true }).catch(
      (error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return [];
        throw error;
      }
    )
  });
  const requestId = `employee_upload_denied_${employeeId}_${Date.now()}`;
  try {
    const before = await snapshot();
    const response = await fetch(`${apiUrl}/v1/documents/evidence`, {
      method: "POST",
      headers: { ...employeeAuth, "x-request-id": requestId, "content-type": "text/plain" },
      body: "Private filename/content must never enter denial audit"
    });
    const body = (await response.json()) as { error?: { code?: string; retryable?: boolean } };
    assert(
      response.status === 403 &&
        body.error?.code === "UPLOAD_ADMIN_REQUIRED" &&
        body.error.retryable === false,
      "Employee upload must return canonical 403 before multipart parsing."
    );
    assert(
      JSON.stringify(await snapshot()) === JSON.stringify(before),
      "Denied upload must leave no document/import/partition/storage residue."
    );
    const audit = await prisma.auditLog.findMany({ where: { requestId } });
    const metadata = audit[0]?.metadata as Record<string, unknown> | undefined;
    assert(
      audit.length === 1 &&
        audit[0]?.action === "file_upload.denied" &&
        audit[0]?.result === "denied" &&
        audit[0]?.actorEmployeeId === employeeId &&
        audit[0]?.targetId === null &&
        metadata?.["uploadSurface"] === "evidence_document" &&
        metadata["reason"] === "admin_role_required" &&
        Object.keys(metadata).length === 2,
      "Denied upload must persist exactly one safe transport-only audit."
    );
  } finally {
    await prisma.auditLog.deleteMany({ where: { requestId } });
    await prisma.$disconnect();
  }
}

async function assertAdminUploadClearanceOrthogonality(
  adminAuth: Record<string, string>,
  highEmployeeAuth: Record<string, string>
): Promise<void> {
  const form = new FormData();
  form.append(
    "file",
    new Blob(["# Integration confidential SOP\n\n高密级验收资料：折扣口令仅供授权员工查询。"]),
    "confidential-sop.md"
  );
  form.append("title", "Integration confidential SOP");
  form.append("sourceSystem", "integration_high_clearance");
  form.append("confidentialityLevel", "2");
  form.append("categoryId", INTEGRATION_EVIDENCE_CATEGORY_ID);
  form.append("scopes", JSON.stringify(INTEGRATION_EVIDENCE_SCOPES));
  const upload = await apiJson<EvidenceUploadResponse>("/v1/documents/evidence", {
    method: "POST",
    headers: adminAuth,
    body: form
  });
  const worker = parseJson<WorkerResponse>(
    (await run("npm", ["--silent", "run", "worker:once"], { env: integrationEnv })).stdout
  );
  assert(
    worker.documentId === upload.document.documentId && worker.status === "active",
    `Worker must activate admin-c0's level-2 upload: ${JSON.stringify(worker)} (expected ${upload.document.documentId}).`
  );
  const id = upload.document.documentId;
  const ownerProgress = await fetch(`${apiUrl}/v1/documents/evidence/${id}/status`, {
    headers: adminAuth
  });
  const deniedDownload = await fetch(`${apiUrl}/v1/source-documents/${id}/download-url`, {
    method: "POST",
    headers: adminAuth
  });
  assert(
    ownerProgress.status === 200 && deniedDownload.status === 404,
    "Uploader progress must remain available without granting a high-level original download."
  );
  const safeProgress = (await ownerProgress.json()) as { document: Record<string, unknown> };
  assert(
    !("title" in safeProgress.document) && !("downloadUrl" in safeProgress.document),
    "Owner progress must not include protected metadata or links."
  );
  const query = JSON.stringify({ query: "折扣口令", filters: { documentIds: [id] }, limit: 5 });
  const deniedSearch = await apiJson<EvidenceSearchResponse>("/v1/evidence/search", {
    method: "POST",
    headers: { ...adminAuth, "content-type": "application/json" },
    body: query
  });
  assert(
    deniedSearch.results.length === 0 && deniedSearch.sources.length === 0,
    "Admin c0 must not read high-level evidence through search."
  );
  const allowedSearch = await apiJson<EvidenceSearchResponse>("/v1/evidence/search", {
    method: "POST",
    headers: { ...highEmployeeAuth, "content-type": "application/json" },
    body: query
  });
  assert(
    allowedSearch.results.some((row) => row.documentId === id),
    "Employee c3 must read indexed level-2 evidence."
  );
  const download = await apiJson<{ downloadUrl: string }>(
    `/v1/source-documents/${id}/download-url`,
    { method: "POST", headers: highEmployeeAuth }
  );
  // The disposable integration storage adapter returns file: download URLs.
  const sourceUrl = new URL(download.downloadUrl);
  assert(sourceUrl.protocol === "file:", "Local storage must issue a local source URL.");
  const source = await readFile(sourceUrl, "utf8");
  assert(source.includes("折扣口令"), "Employee c3 must download the original high-level source.");
}

async function assertDualCollectionEvidenceReindex(input: {
  documentId: string;
  auth: HeadersInit;
  v1Cursor: string;
}): Promise<void> {
  const jsonHeaders = new Headers(input.auth);
  jsonHeaders.set("content-type", "application/json");
  const v2Collection = `${integrationEnv["QDRANT_COLLECTION_EVIDENCE"]}_v2`;
  const v2Env: NodeJS.ProcessEnv = {
    ...integrationEnv,
    RETRIEVAL_CONFIG_VERSION: "phase3.retrieval.v2-bm25",
    QDRANT_COLLECTION_EVIDENCE: v2Collection
  };
  await run("npm", ["run", "qdrant:init"], { env: v2Env });
  const reindex = parseJson<{ createdJobCount: number }>(
    (
      await run(
        "npm",
        [
          "--silent",
          "run",
          "evidence:reindex",
          "--",
          "--target-config",
          "phase3.retrieval.v2-bm25",
          "--target-collection",
          v2Collection,
          "--execute"
        ],
        { env: v2Env }
      )
    ).stdout
  );
  assert(
    reindex.createdJobCount > 0,
    "V2 reindex must queue at least one active evidence document."
  );
  for (let index = 0; index < reindex.createdJobCount; index += 1) {
    const worker = parseJson<WorkerResponse>(
      (await run("npm", ["--silent", "run", "worker:once"], { env: v2Env })).stdout
    );
    assert(worker.processed === true, "V2 reindex worker must process every queued target job.");
  }

  const prisma = new PrismaClient({ adapter: new PrismaMariaDb(integrationEnv["DATABASE_URL"]!) });
  try {
    const indexes = await prisma.documentIndex.findMany({
      where: { documentId: input.documentId, status: "ready" },
      include: { retrievalConfig: true }
    });
    assert(
      indexes.some((index) => index.retrievalConfig.version === "phase3.retrieval.v1") &&
        indexes.some((index) => index.retrievalConfig.version === "phase3.retrieval.v2-bm25"),
      "V2 reindex must preserve the ready V1 index beside the new ready V2 index."
    );
  } finally {
    await prisma.$disconnect();
  }

  const v1StillReadable = await apiJson<EvidenceSearchResponse>("/v1/evidence/search", {
    method: "POST",
    headers: jsonHeaders,
    body: JSON.stringify({ query: "差评处理", filters: { fileTypes: ["md"] }, limit: 5 })
  });
  assert(
    v1StillReadable.results.some((result) => result.documentId === input.documentId),
    "V1 must remain queryable after the V2 reindex."
  );

  if (apiProcess) await stopApi(apiProcess);
  Object.assign(integrationEnv, v2Env);
  apiProcess = startApi();
  await waitForApiHealth(apiProcess);

  const v2Search = await apiJson<EvidenceSearchResponse>("/v1/evidence/search", {
    method: "POST",
    headers: jsonHeaders,
    body: JSON.stringify({ query: "差评处理", filters: { fileTypes: ["md"] }, limit: 5 })
  });
  assert(
    v2Search.results.some((result) => result.documentId === input.documentId),
    "V2 must return the reindexed evidence document."
  );
  assert(
    v2Search.sources.length === 1 &&
      v2Search.sources[0]?.sourceDocumentId === input.documentId &&
      v2Search.sources[0]?.downloadStatus === "available" &&
      Boolean(v2Search.sources[0]?.downloadUrl),
    "V2 evidence results must include the automatic source download URL."
  );

  const crossVersionCursor = await fetch(`${apiUrl}/v1/evidence/search`, {
    method: "POST",
    headers: jsonHeaders,
    body: JSON.stringify({
      query: "差评处理",
      filters: { fileTypes: ["md"] },
      limit: 1,
      cursor: input.v1Cursor
    })
  });
  assert(crossVersionCursor.status === 400, "A V1 evidence cursor must be rejected by V2.");
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
      ["inspect", "-f", "{{.State.Health.Status}}", "smedc-mysql"],
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

function authorizationHeader(token: string): Record<string, string> {
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

async function waitForPartitionImportStatus(
  jobId: string,
  headers: HeadersInit,
  expectedStatus: string
): Promise<{ status: string; partitionCount: number; totalRowCount: number }> {
  let latest: { status: string; partitionCount: number; totalRowCount: number } | null = null;
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const status = await apiJson<{ status: string; partitionCount: number; totalRowCount: number }>(
      `/v1/structured/partition-imports/${encodeURIComponent(jobId)}`,
      { headers }
    );
    latest = status;
    if (status.status === expectedStatus) return status;
    await delay(100);
  }
  throw new Error(
    `Partition import ${jobId} did not reach ${expectedStatus}; latest=${JSON.stringify(latest)}`
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
  const deviceInstanceNames = [`${runId}-browser`, `${runId}-oauth`, `${runId}-agent`];
  const sessionIds: string[] = [];

  try {
    const identity = await prisma.loginIdentity.findFirst({
      where: { employeeId: "emp_admin", disabled: false },
      select: { id: true, employeeId: true, orgId: true }
    });
    assert(
      Boolean(identity),
      "Audit provenance upload integration requires the seeded admin identity."
    );

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
      extraHeaders: { "x-smedc-launcher-version": "0.6.0" }
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
        "x-smedc-internal-delegation": "A".repeat(43),
        "x-smedc-launcher-version": "0.6.0"
      }
    });
    const mcp = await uploadAuditEvidenceThroughMcp(accessToken, {
      requestId: requestIds.mcp,
      sourceSystem,
      title: `${runId} MCP`,
      forwardedIp: "203.0.113.42"
    });
    const businessDocuments = [direct, trustedProxy, forgedProof, mcp];

    const browserAuthorization = await auth.issueDeviceAuthorization({
      clientId: OAUTH_CLIENT_ID,
      instanceName: deviceInstanceNames[0]!,
      instanceHostname: "integration-host",
      audit: { requestId: `${runId}_browser_setup`, sourceIp: "127.0.0.1", launcherVersion: null }
    });
    const browserPage = await fetch(
      `${apiUrl}/oauth/device/verify?user_code=${browserAuthorization.userCode}`
    );
    const verifySecret = new RegExp(`${DEVICE_VERIFY_COOKIE}=([^;]+)`).exec(
      browserPage.headers.get("set-cookie") ?? ""
    )?.[1];
    assert(browserPage.status === 200 && Boolean(verifySecret), "Device login page must render.");
    const browserResponse = await fetch(`${apiUrl}/oauth/device/verify/login`, {
      method: "POST",
      headers: {
        cookie: `${DEVICE_VERIFY_COOKIE}=${verifySecret}`,
        "content-type": "application/x-www-form-urlencoded",
        "x-forwarded-for": "198.51.100.31",
        "x-request-id": requestIds.browser
      },
      body: new URLSearchParams({
        csrfToken: csrfTokenForSecret(verifySecret!),
        userCode: browserAuthorization.userCode,
        email: `${runId}@example.invalid`,
        password: "intentionally invalid"
      }).toString(),
      redirect: "manual"
    });
    assert(browserResponse.status === 401, "Synthetic browser login must fail generically.");

    const oauthAuthorization = await auth.issueDeviceAuthorization({
      clientId: OAUTH_CLIENT_ID,
      instanceName: deviceInstanceNames[1]!,
      instanceHostname: "integration-host",
      audit: { requestId: `${runId}_oauth_setup`, sourceIp: "127.0.0.1", launcherVersion: null }
    });
    const authorizationCompleted = await auth.completeDeviceAuthorization(
      oauthAuthorization.userCode,
      {
        identityId: identity!.id,
        employeeId: identity!.employeeId,
        orgId: identity!.orgId
      },
      { requestId: `${runId}_oauth_setup`, sourceIp: "127.0.0.1", launcherVersion: null }
    );
    assert(authorizationCompleted, "Synthetic device authorization must complete.");

    const tokenResponse = await fetch(`${apiUrl}/oauth/token`, {
      method: "POST",
      headers: oauthHeaders(requestIds.oauthToken, "198.51.100.32"),
      body: new URLSearchParams({
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
        client_id: OAUTH_CLIENT_ID,
        device_code: oauthAuthorization.deviceCode
      }).toString()
    });
    const tokens = (await tokenResponse.json()) as OAuthTokenResponse;
    assert(tokenResponse.status === 200, "Synthetic device-code exchange must succeed.");

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
      "0.6.0"
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
    assertAuthEvent(tokenEvent, "198.51.100.32", "0.6.0", "OAuth token");
    assert(Boolean(tokenEvent?.sessionId), "OAuth token event must identify its session.");
    sessionIds.push(tokenEvent!.sessionId!);

    const refreshEvent = await prisma.authSecurityEvent.findFirst({
      where: { requestId: requestIds.oauthRefresh, eventType: "renewal_failed" }
    });
    assertAuthEvent(refreshEvent, "198.51.100.33", "0.6.0", "OAuth refresh");

    const revokeEvents = await prisma.authSecurityEvent.findMany({
      where: {
        requestId: requestIds.oauthRevoke,
        eventType: { in: ["logout", "session_revoked"] }
      }
    });
    assert(revokeEvents.length === 2, "OAuth revoke must persist logout and revocation events.");
    for (const event of revokeEvents) {
      assertAuthEvent(event, "198.51.100.34", "0.6.0", "OAuth revoke");
    }

    const deviceRunId = `${runId}_device`;
    const deviceHeaders = (requestId: string, forwardedIp: string) => ({
      ...oauthHeaders(requestId, forwardedIp),
      "x-smedc-launcher-version": "0.6.0"
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
    assertAuthEvent(deviceTokenEvent, "198.51.100.39", "0.6.0", "device token");
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
        deviceInstanceNames,
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
  form.append("confidentialityLevel", "0");
  form.append("categoryId", INTEGRATION_EVIDENCE_CATEGORY_ID);
  form.append("scopes", JSON.stringify(INTEGRATION_EVIDENCE_SCOPES));
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
      "x-smedc-launcher-version": "0.6.0",
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
          categoryId: INTEGRATION_EVIDENCE_CATEGORY_ID,
          scopes: INTEGRATION_EVIDENCE_SCOPES,
          sourceSystem: input.sourceSystem,
          confidentialityLevel: 0
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
    "x-smedc-launcher-version": "0.6.0",
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
    deviceInstanceNames: string[];
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
    if (input.deviceInstanceNames.length > 0) {
      await tx.deviceAuthorization.deleteMany({
        where: { instanceName: { in: input.deviceInstanceNames } }
      });
    }
    if (documentIds.length > 0) {
      await tx.businessResource.deleteMany({
        where: {
          OR: [{ documentId: { in: documentIds } }, { sourceDocumentId: { in: documentIds } }]
        }
      });
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
    retainedDeviceAuthorizations
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
    input.deviceInstanceNames.length > 0
      ? prisma.deviceAuthorization.count({
          where: { instanceName: { in: input.deviceInstanceNames } }
        })
      : Promise.resolve(0)
  ]);
  const retainedQdrantPoints = await retrieveIntegrationQdrantPointCount(qdrantPointIds);
  assert(
    retainedDocuments === 0 &&
      retainedAudits === 0 &&
      retainedEvents === 0 &&
      retainedSessions === 0 &&
      retainedDeviceAuthorizations === 0 &&
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
  const leaseStart = Date.now();
  const leaseTime = (offset: number) => new Date(leaseStart + offset);
  try {
    const employee = await prisma.employee.findFirst({
      where: { orgId: "default-org", email: "baoli.employee@example.com" }
    });
    assert(Boolean(employee), "Worker lease integration requires the seeded Baoli employee.");
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
        availableAt: leaseTime(0)
      }
    });

    const claimedByA = await repository.claimNextProcessingRun({
      workerId: "worker-a",
      leaseSeconds: 60,
      now: leaseTime(0)
    });
    assert(claimedByA?.id === runId, "Worker A must claim the queued run.");
    const claimedByBWhileLeased = await repository.claimNextProcessingRun({
      workerId: "worker-b",
      leaseSeconds: 60,
      now: leaseTime(100)
    });
    assert(!claimedByBWhileLeased, "Worker B must not claim an active lease.");
    const heartbeated = await repository.heartbeatProcessingRun?.({
      runId,
      attemptNumber: 1,
      workerId: "worker-a",
      leaseSeconds: 60,
      now: leaseTime(500)
    });
    assert(heartbeated === true, "Heartbeat must extend the current lease.");
    const heartbeatExpiry = (await prisma.processingRun.findUniqueOrThrow({ where: { id: runId } }))
      .lockedUntil!;
    const claimedBeforeHeartbeatExpiry = await repository.claimNextProcessingRun({
      workerId: "worker-b",
      leaseSeconds: 60,
      now: new Date(heartbeatExpiry.getTime() - 1)
    });
    assert(!claimedBeforeHeartbeatExpiry, "Heartbeat must prevent premature lease recovery.");
    const claimedByB = await repository.claimNextProcessingRun({
      workerId: "worker-b",
      leaseSeconds: 60,
      now: new Date(heartbeatExpiry.getTime() + 1)
    });
    assert(claimedByB?.id === runId, "Worker B must recover the expired running job.");

    let oldWorkerCompleteRejected = false;
    try {
      await repository.completeEvidenceIndexing?.({
        runId,
        attemptNumber: 1,
        documentId,
        workerId: "worker-a",
        now: new Date(heartbeatExpiry.getTime() + 100),
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
      attemptNumber: 2,
      documentId,
      workerId: "worker-b",
      now: new Date(heartbeatExpiry.getTime() + 100),
      result: workerLeaseIndexingResult(),
      chunks: []
    });
    let oldWorkerFailRejected = false;
    try {
      await repository.failProcessingRun({
        runId,
        attemptNumber: 1,
        documentId,
        workerId: "worker-a",
        now: new Date(heartbeatExpiry.getTime() + 200),
        errorCode: "STALE_WORKER",
        errorSummary: "old worker attempted to fail after success",
        willRetry: false,
        nextAvailableAt: new Date(heartbeatExpiry.getTime() + 200)
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
    qdrantCollection: "smedc_evidence_test",
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
