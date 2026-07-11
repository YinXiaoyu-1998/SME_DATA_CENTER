import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { config as loadDotenv } from "dotenv";
import {
  parseRuntimeReadinessConfig,
  qdrantCollectionMatchesExpectedSchema,
  qdrantEvidenceCollectionSchema,
  type QdrantRuntimeConfig,
  type RuntimeEnv,
  type RuntimeReadinessConfig
} from "@enterprise-hub/domain";

const DEFAULT_LOCAL_DATABASE_URL =
  "mysql://enterprise_hub:enterprise_hub_local_password@localhost:3306/enterprise_hub";
const DEFAULT_LOCAL_STORAGE_ROOT = "./.data/storage";
const DEFAULT_READINESS_CHECK_TIMEOUT_MS = 5_000;

export {
  parseRuntimeReadinessConfig,
  qdrantEvidenceCollectionSchema,
  type RuntimeReadinessConfig
} from "@enterprise-hub/domain";

export interface ReadinessCheckResult {
  name: "mysql" | "qdrant" | "storage" | "workerLease" | "modelProvider";
  ok: boolean;
  message: string;
}

export interface ReadinessReport {
  ok: boolean;
  retrievalConfigVersion: string;
  checks: ReadinessCheckResult[];
}

interface RuntimeDependencyChecks {
  mysql?: () => Promise<void>;
  storage?: () => Promise<void>;
  workerLease?: () => Promise<void>;
}

interface CheckRuntimeReadinessInput {
  env?: RuntimeEnv;
  checks?: RuntimeDependencyChecks;
  checkTimeoutMs?: number;
}

export async function bootstrapQdrantEvidenceCollection(
  config: QdrantRuntimeConfig
): Promise<void> {
  let existing: Awaited<ReturnType<typeof fetchQdrantJson>>;

  try {
    existing = await fetchQdrantJson(config, collectionUrl(config), "GET");
  } catch (error) {
    throw new Error(
      `Qdrant is unavailable while checking collection ${config.collectionName}: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  }

  if (existing.ok) {
    if (!qdrantCollectionMatchesExpectedSchema(existing.body)) {
      throw new Error(
        `Qdrant evidence collection ${config.collectionName} exists but does not match the expected dense/sparse config.`
      );
    }

    return;
  }

  if (existing.status !== 404) {
    throw new Error(
      `Qdrant is unavailable or returned ${existing.status} while checking collection ${config.collectionName}.`
    );
  }

  const created = await fetchQdrantJson(config, collectionUrl(config), "PUT", {
    body: JSON.stringify(qdrantEvidenceCollectionSchema())
  });

  if (!created.ok) {
    throw new Error(
      `Unable to create Qdrant evidence collection ${config.collectionName}: HTTP ${created.status}.`
    );
  }
}

export async function checkRuntimeReadiness(
  input: CheckRuntimeReadinessInput = {}
): Promise<ReadinessReport> {
  const config = parseRuntimeReadinessConfig(input.env);
  const checks = input.checks ?? {};
  const checkTimeoutMs = input.checkTimeoutMs ?? DEFAULT_READINESS_CHECK_TIMEOUT_MS;
  const results: ReadinessCheckResult[] = [];

  results.push(
    await runCheck("mysql", checks.mysql ?? (() => checkMysql(input.env)), checkTimeoutMs)
  );
  results.push(await checkQdrant(config.qdrant));
  results.push(
    await runCheck("storage", checks.storage ?? (() => checkStorage(input.env)), checkTimeoutMs)
  );
  results.push(
    await runCheck(
      "workerLease",
      checks.workerLease ?? (() => checkWorkerLease(input.env)),
      checkTimeoutMs
    )
  );
  results.push(checkModelProvider(config));

  return {
    ok: results.every((result) => result.ok),
    retrievalConfigVersion: config.qdrant.retrievalConfigVersion,
    checks: results
  };
}

async function checkQdrant(config: QdrantRuntimeConfig): Promise<ReadinessCheckResult> {
  try {
    const response = await fetchQdrantJson(config, collectionUrl(config), "GET");

    if (!response.ok) {
      return {
        name: "qdrant",
        ok: false,
        message:
          response.status === 404
            ? `Qdrant evidence collection ${config.collectionName} is missing. Run npm run qdrant:init.`
            : `Qdrant is unavailable or returned HTTP ${response.status}.`
      };
    }

    if (!qdrantCollectionMatchesExpectedSchema(response.body)) {
      return {
        name: "qdrant",
        ok: false,
        message: `Qdrant evidence collection ${config.collectionName} does not match expected dense/sparse config.`
      };
    }

    return {
      name: "qdrant",
      ok: true,
      message: `Qdrant evidence collection ${config.collectionName} is ready.`
    };
  } catch (error) {
    return {
      name: "qdrant",
      ok: false,
      message: `Qdrant is unavailable: ${error instanceof Error ? error.message : String(error)}`
    };
  }
}

function checkModelProvider(config: RuntimeReadinessConfig): ReadinessCheckResult {
  const provider = config.modelProvider.provider;

  if (provider === "fake") {
    return {
      name: "modelProvider",
      ok: true,
      message: "Model provider mode is fake; no external model egress will be performed."
    };
  }

  if (provider !== "openai-compatible") {
    return {
      name: "modelProvider",
      ok: false,
      message: `Unsupported LLM_PROVIDER ${provider}; expected fake or openai-compatible.`
    };
  }

  if (!config.modelProvider.egressAcknowledged) {
    return {
      name: "modelProvider",
      ok: false,
      message:
        "Real model provider mode requires EXTERNAL_MODEL_EGRESS_ACKNOWLEDGED=true before any external embedding/rerank call."
    };
  }

  if (
    !config.modelProvider.openAiCompatibleApiKey ||
    !config.modelProvider.openAiCompatibleBaseUrl ||
    !config.modelProvider.embeddingModel ||
    !config.modelProvider.rerankModel
  ) {
    return {
      name: "modelProvider",
      ok: false,
      message:
        "Real openai-compatible provider mode requires API key, base URL, embedding model, and rerank model."
    };
  }

  return {
    name: "modelProvider",
    ok: true,
    message: "Real model provider configuration is present and egress is acknowledged."
  };
}

async function checkMysql(env: RuntimeEnv | undefined): Promise<void> {
  const databaseUrl =
    env?.["DATABASE_URL"] ?? process.env["DATABASE_URL"] ?? DEFAULT_LOCAL_DATABASE_URL;

  if (!databaseUrl) {
    throw new Error("DATABASE_URL is required.");
  }

  const { PrismaMariaDb, PrismaClient } = await loadPrisma();
  const adapter = new PrismaMariaDb(databaseUrl);
  const prisma = new PrismaClient({ adapter });

  try {
    await prisma.$queryRaw`SELECT 1`;
  } finally {
    await prisma.$disconnect();
  }
}

async function checkStorage(env: RuntimeEnv | undefined): Promise<void> {
  const driver = env?.["STORAGE_DRIVER"] ?? process.env["STORAGE_DRIVER"] ?? "local";

  if (driver !== "local") {
    throw new Error(`Unsupported storage readiness driver ${driver}.`);
  }

  const root =
    env?.["LOCAL_STORAGE_ROOT"] ?? process.env["LOCAL_STORAGE_ROOT"] ?? DEFAULT_LOCAL_STORAGE_ROOT;

  if (!root) {
    throw new Error("LOCAL_STORAGE_ROOT is required for local storage readiness.");
  }

  const resolvedRoot = path.resolve(root);
  await mkdir(resolvedRoot, { recursive: true });
  const checkPath = path.join(resolvedRoot, `.readiness-${process.pid}-${Date.now()}`);
  await writeFile(checkPath, "ok", "utf8");
  await rm(checkPath, { force: true });
}

async function checkWorkerLease(env: RuntimeEnv | undefined): Promise<void> {
  const databaseUrl =
    env?.["DATABASE_URL"] ?? process.env["DATABASE_URL"] ?? DEFAULT_LOCAL_DATABASE_URL;

  if (!databaseUrl) {
    throw new Error("DATABASE_URL is required for worker lease readiness.");
  }

  const { PrismaMariaDb, PrismaClient } = await loadPrisma();
  const adapter = new PrismaMariaDb(databaseUrl);
  const prisma = new PrismaClient({ adapter });

  try {
    await prisma.$queryRaw`SELECT COUNT(*) AS queued_runs FROM processing_runs`;
  } finally {
    await prisma.$disconnect();
  }
}

async function loadPrisma() {
  const [{ PrismaMariaDb }, { PrismaClient }] = await Promise.all([
    import("@prisma/adapter-mariadb"),
    import("@prisma/client")
  ]);

  return { PrismaMariaDb, PrismaClient };
}

async function runCheck(
  name: ReadinessCheckResult["name"],
  check: () => Promise<void>,
  timeoutMs: number
): Promise<ReadinessCheckResult> {
  try {
    await withTimeout(
      check(),
      timeoutMs,
      `${name} readiness check timed out after ${timeoutMs}ms.`
    );
    return {
      name,
      ok: true,
      message: `${name} readiness check passed.`
    };
  } catch (error) {
    return {
      name,
      ok: false,
      message: `${name} readiness check failed: ${
        error instanceof Error ? error.message : String(error)
      }`
    };
  }
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timeout: NodeJS.Timeout | undefined;

  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => reject(new Error(message)), timeoutMs);
      })
    ]);
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
  }
}

async function fetchQdrantJson(
  config: QdrantRuntimeConfig,
  url: string,
  method: "GET" | "PUT",
  init: RequestInit = {}
): Promise<{ ok: boolean; status: number; body: unknown }> {
  const abortController = new AbortController();
  const timeout = setTimeout(() => abortController.abort(), config.timeoutMs);

  try {
    const headers = new Headers(init.headers);
    headers.set("content-type", "application/json");

    if (config.apiKey) {
      headers.set("api-key", config.apiKey);
    }

    const response = await fetch(url, {
      ...init,
      method,
      headers,
      signal: abortController.signal
    });

    return {
      ok: response.ok,
      status: response.status,
      body: await response.json().catch(() => null)
    };
  } finally {
    clearTimeout(timeout);
  }
}

function collectionUrl(config: QdrantRuntimeConfig): string {
  return `${config.url}/collections/${encodeURIComponent(config.collectionName)}`;
}

async function main() {
  loadDotenv({ quiet: true, override: false });

  const command = process.argv[2] ?? "check";
  const config = parseRuntimeReadinessConfig();

  if (command === "init-qdrant") {
    await bootstrapQdrantEvidenceCollection(config.qdrant);
    console.log(
      JSON.stringify(
        {
          ok: true,
          qdrantCollection: config.qdrant.collectionName,
          retrievalConfigVersion: config.qdrant.retrievalConfigVersion
        },
        null,
        2
      )
    );
    return;
  }

  if (command !== "check") {
    throw new Error(`Unsupported readiness command ${command}. Use check or init-qdrant.`);
  }

  const report = await checkRuntimeReadiness();
  console.log(JSON.stringify(report, null, 2));

  if (!report.ok) {
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
