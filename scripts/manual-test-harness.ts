import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { config as loadDotenv } from "dotenv";

export type ManualTestProfile = "fake" | "real";

export interface ManualTestRuntime {
  runId: string;
  profile: ManualTestProfile;
  cwd: string;
  runRoot: string;
  storageRoot: string;
  mysqlPort: string;
  databaseUrl: string;
  apiUrl: string;
  qdrantUrl: string;
  qdrantCollection: string;
  llmProvider: string;
  rerankProvider: string;
  rerankModel: string;
  embeddingModel: string;
  embeddingDimension: string;
  egressAcknowledged: string;
  providerEnv: Record<string, string>;
}

export interface ManualTestManifest {
  runId: string;
  profile: ManualTestProfile;
  createdAt: string;
  runRoot: string;
  storageRoot: string;
  mysqlPort: string;
  apiUrl: string;
  qdrantUrl: string;
  qdrantCollection: string;
  llmProvider: string;
  rerankProvider: string;
  embeddingModel: string;
  embeddingDimension: string;
}

interface BuildManualTestRuntimeInput {
  cwd: string;
  profile: ManualTestProfile;
  env: NodeJS.ProcessEnv;
  runId: string;
}

export type ManualTestCommand = "prepare" | "serve" | "snapshot" | "cleanup";

export interface ManualTestArgs {
  command: ManualTestCommand;
  profile: ManualTestProfile;
  runId: string | undefined;
}

export interface SpawnLoggedChildInput {
  command: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  logPath: string;
}

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1"]);
const defaultDatabaseUrl = (mysqlPort: string) =>
  `mysql://enterprise_hub:enterprise_hub_local_password@127.0.0.1:${mysqlPort}/enterprise_hub`;

export function buildManualTestRuntime(input: BuildManualTestRuntimeInput): ManualTestRuntime {
  const runSegment = input.runId.replace(/[^A-Za-z0-9_]/g, "_");
  const runRoot = path.join(input.cwd, ".data", "manual-tests", input.runId);
  const providerEnv = buildProviderEnv(input.profile, input.env);
  const mysqlPort = input.env["MYSQL_PORT"] ?? "3307";
  const runtime: ManualTestRuntime = {
    runId: input.runId,
    profile: input.profile,
    cwd: input.cwd,
    runRoot,
    storageRoot: path.join(runRoot, "storage"),
    mysqlPort,
    databaseUrl: input.env["MANUAL_TEST_DATABASE_URL"] ?? defaultDatabaseUrl(mysqlPort),
    apiUrl: input.env["MANUAL_TEST_API_URL"] ?? "http://127.0.0.1:3000",
    qdrantUrl: input.env["MANUAL_TEST_QDRANT_URL"] ?? "http://127.0.0.1:6333",
    qdrantCollection: `enterprise_hub_evidence_manual_${runSegment}`,
    llmProvider: providerEnv["LLM_PROVIDER"] ?? "fake",
    rerankProvider: providerEnv["RERANK_PROVIDER"] ?? "fake",
    rerankModel: providerEnv["LLM_MODEL"] ?? "fake-rerank",
    embeddingModel: providerEnv["LLM_EMBEDDING_MODEL"] ?? "fake-embedding",
    embeddingDimension: providerEnv["LLM_EMBEDDING_DIMENSION"] ?? "8",
    egressAcknowledged: providerEnv["EXTERNAL_MODEL_EGRESS_ACKNOWLEDGED"] ?? "false",
    providerEnv
  };

  assertSafeManualTestTarget(runtime);
  return runtime;
}

export function assertSafeManualTestTarget(runtime: ManualTestRuntime): void {
  const databaseUrl = new URL(runtime.databaseUrl);
  const qdrantUrl = new URL(runtime.qdrantUrl);
  const apiUrl = new URL(runtime.apiUrl);
  const manualDataRoot = path.join(runtime.cwd, ".data", "manual-tests");
  const relativeStoragePath = path.relative(manualDataRoot, runtime.storageRoot);

  if (databaseUrl.protocol !== "mysql:" || !LOCAL_HOSTS.has(databaseUrl.hostname)) {
    throw new Error("Manual tests refuse to target a non-local MySQL database.");
  }
  if (databaseUrl.pathname.replace(/^\/+/, "") !== "enterprise_hub") {
    throw new Error("Manual tests refuse to target a database other than enterprise_hub.");
  }
  if (!LOCAL_HOSTS.has(qdrantUrl.hostname)) {
    throw new Error("Manual tests refuse to target a non-local Qdrant service.");
  }
  if (!LOCAL_HOSTS.has(apiUrl.hostname)) {
    throw new Error("Manual tests refuse to target a non-local API service.");
  }
  if (!runtime.qdrantCollection.startsWith("enterprise_hub_evidence_manual_")) {
    throw new Error("Manual tests require a dedicated manual-test Qdrant collection.");
  }
  if (
    relativeStoragePath.startsWith("..") ||
    path.isAbsolute(relativeStoragePath) ||
    relativeStoragePath === ""
  ) {
    throw new Error("Manual tests require storage inside .data/manual-tests/<runId>.");
  }
}

export function manualTestProcessEnv(
  runtime: ManualTestRuntime,
  baseEnv: NodeJS.ProcessEnv = process.env
): NodeJS.ProcessEnv {
  const apiUrl = new URL(runtime.apiUrl);
  const port = apiUrl.port || "3000";

  return {
    ...baseEnv,
    ...runtime.providerEnv,
    MYSQL_PORT: runtime.mysqlPort,
    DATABASE_URL: runtime.databaseUrl,
    CURSOR_SIGNING_SECRET: "enterprise-hub-manual-test-local-cursor-secret",
    ENTERPRISE_HUB_PUBLIC_ORIGIN: "https://api.smedatacenter.xyz",
    STORAGE_DRIVER: "local",
    LOCAL_STORAGE_ROOT: runtime.storageRoot,
    HOST: apiUrl.hostname,
    PORT: port,
    QDRANT_URL: runtime.qdrantUrl,
    QDRANT_COLLECTION_EVIDENCE: runtime.qdrantCollection,
    RETRIEVAL_CONFIG_VERSION: "phase3.retrieval.v1"
  };
}

export function publicManualTestManifest(runtime: ManualTestRuntime): ManualTestManifest {
  return {
    runId: runtime.runId,
    profile: runtime.profile,
    createdAt: new Date().toISOString(),
    runRoot: runtime.runRoot,
    storageRoot: runtime.storageRoot,
    mysqlPort: runtime.mysqlPort,
    apiUrl: runtime.apiUrl,
    qdrantUrl: runtime.qdrantUrl,
    qdrantCollection: runtime.qdrantCollection,
    llmProvider: runtime.llmProvider,
    rerankProvider: runtime.rerankProvider,
    embeddingModel: runtime.embeddingModel,
    embeddingDimension: runtime.embeddingDimension
  };
}

export function parseManualTestArgs(argv: string[]): ManualTestArgs {
  const [command, ...options] = argv;

  if (!isManualTestCommand(command)) {
    throw new Error(
      "Usage: manual-test-harness <prepare|serve|snapshot|cleanup> [--profile=fake|real] [--run-id=<id>]"
    );
  }

  let profile: ManualTestProfile = "fake";
  let runId: string | undefined;

  for (const option of options) {
    if (option.startsWith("--profile=")) {
      const value = option.slice("--profile=".length);
      if (value !== "fake" && value !== "real") {
        throw new Error("Manual test profile must be fake or real.");
      }
      profile = value;
      continue;
    }
    if (option.startsWith("--run-id=")) {
      const value = option.slice("--run-id=".length).trim();
      if (!value || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(value)) {
        throw new Error(
          "Manual test run id must use 1-64 letters, numbers, underscores, or hyphens."
        );
      }
      runId = value;
      continue;
    }
    throw new Error(`Unsupported manual test option: ${option}`);
  }

  return { command, profile, runId };
}

export function spawnLoggedChild(input: SpawnLoggedChildInput): {
  child: ReturnType<typeof spawn>;
  closeLog: () => Promise<void>;
} {
  const log = createWriteStream(input.logPath, { flags: "a" });
  const child = spawn(input.command, input.args, {
    cwd: input.cwd,
    env: input.env,
    stdio: ["ignore", "pipe", "pipe"]
  });
  child.stdout.pipe(log, { end: false });
  child.stderr.pipe(log, { end: false });
  let closed = false;

  return {
    child,
    async closeLog() {
      if (closed) {
        return;
      }
      closed = true;
      await new Promise<void>((resolve, reject) => {
        log.once("error", reject);
        log.end(resolve);
      });
    }
  };
}

async function main(): Promise<void> {
  loadDotenv({ quiet: true, override: false });
  const args = parseManualTestArgs(process.argv.slice(2));

  if (args.command === "prepare") {
    await prepareManualTest(args);
    return;
  }

  const runtime = await loadCurrentRuntime(process.cwd(), process.env);
  if (args.command === "serve") {
    await serveManualTest(runtime);
    return;
  }
  if (args.command === "snapshot") {
    const snapshot = await captureManualTestSnapshot(runtime, "manual");
    process.stdout.write(`${JSON.stringify(snapshot, null, 2)}\n`);
    return;
  }

  await cleanupManualTest(runtime);
}

async function prepareManualTest(args: ManualTestArgs): Promise<void> {
  const cwd = process.cwd();
  const runId = args.runId ?? createRunId();
  const runtime = buildManualTestRuntime({ cwd, profile: args.profile, env: process.env, runId });
  const processEnv = composeProcessEnv(runtime);

  await runCommand("docker", ["compose", "down", "-v", "--remove-orphans"], processEnv, false);
  await mkdir(runtime.runRoot, { recursive: true });
  await mkdir(runtime.storageRoot, { recursive: true });
  await runCommand("docker", ["compose", "up", "-d", "mysql", "qdrant"], processEnv);
  await waitForMysqlHealth(processEnv);
  await runCommand("npm", ["run", "db:generate"], processEnv);
  await runCommand(
    "npx",
    ["prisma", "migrate", "reset", "--force", "--config", "packages/db/prisma.config.ts"],
    processEnv
  );
  await runCommand("npm", ["run", "db:seed"], processEnv);
  await runCommand("npm", ["run", "qdrant:init"], processEnv);
  await runCommand("npm", ["run", "readyz:local"], processEnv);

  const manifest = publicManualTestManifest(runtime);
  const manifestText = `${JSON.stringify(manifest, null, 2)}\n`;
  await writeFile(path.join(runtime.runRoot, "environment.json"), manifestText, "utf8");
  await mkdir(path.dirname(currentManifestPath(cwd)), { recursive: true });
  await writeFile(currentManifestPath(cwd), manifestText, "utf8");

  const snapshot = await captureManualTestSnapshot(runtime, "initial");
  assertCleanBusinessState(snapshot);

  process.stdout.write(
    `${JSON.stringify(
      {
        ok: true,
        command: "prepare",
        ...manifest,
        initialSnapshot: snapshot.snapshotPath
      },
      null,
      2
    )}\n`
  );
}

async function serveManualTest(runtime: ManualTestRuntime): Promise<void> {
  const processEnv = manualTestProcessEnv(runtime);
  const apiLogPath = path.join(runtime.runRoot, "api.log");
  const workerLogPath = path.join(runtime.runRoot, "worker.log");
  const apiLogged = spawnLoggedChild({
    command: process.execPath,
    args: ["--import", "tsx", "apps/api/src/index.ts"],
    cwd: runtime.cwd,
    env: processEnv,
    logPath: apiLogPath
  });
  const workerLogged = spawnLoggedChild({
    command: process.execPath,
    args: ["--import", "tsx", "apps/worker/src/dev-loop.ts"],
    cwd: runtime.cwd,
    env: processEnv,
    logPath: workerLogPath
  });
  const api = apiLogged.child;
  const worker = workerLogged.child;

  try {
    await waitForApiHealth(runtime.apiUrl, api, apiLogPath);
    process.stdout.write(
      `${JSON.stringify(
        {
          ok: true,
          command: "serve",
          runId: runtime.runId,
          apiUrl: runtime.apiUrl,
          apiLogPath,
          workerLogPath
        },
        null,
        2
      )}\n`
    );
    await waitForShutdown([api, worker]);
  } finally {
    await Promise.all([stopChild(api), stopChild(worker)]);
    await Promise.all([apiLogged.closeLog(), workerLogged.closeLog()]);
  }
}

interface ManualTestSnapshot {
  runId: string;
  capturedAt: string;
  snapshotPath: string;
  counts: {
    employees: number;
    skills: number;
    documents: number;
    processingRuns: number;
    documentChunks: number;
    documentIndexes: number;
    importBatches: number;
    partitionImportJobs: number;
    structuredPartitions: number;
    storageGarbage: number;
    vipRows: number;
    dishCatalogRows: number;
    auditLogs: number;
    qdrantPoints: number;
    storageFiles: number;
  };
  documents: Array<{
    id: string;
    title: string;
    documentKind: string | null;
    status: string;
    uploaderId: string;
  }>;
}

async function captureManualTestSnapshot(
  runtime: ManualTestRuntime,
  label: string
): Promise<ManualTestSnapshot> {
  const [{ PrismaMariaDb }, { PrismaClient }] = await Promise.all([
    import("@prisma/adapter-mariadb"),
    import("@prisma/client")
  ]);
  const adapter = new PrismaMariaDb(runtime.databaseUrl);
  const prisma = new PrismaClient({ adapter });

  try {
    const [
      employees,
      skills,
      documents,
      processingRuns,
      documentChunks,
      documentIndexes,
      importBatches,
      partitionImportJobs,
      structuredPartitions,
      storageGarbage,
      vipRows,
      dishCatalogRows,
      auditLogs,
      documentRecords,
      qdrantPoints,
      storageFiles
    ] = await Promise.all([
      prisma.employee.count(),
      prisma.skillEntry.count(),
      prisma.document.count(),
      prisma.processingRun.count(),
      prisma.documentChunk.count(),
      prisma.documentIndex.count(),
      prisma.importBatch.count(),
      prisma.partitionImportJob.count(),
      prisma.structuredPartition.count(),
      prisma.storageGarbage.count(),
      prisma.vipRow.count(),
      prisma.dishCatalogRow.count(),
      prisma.auditLog.count(),
      prisma.document.findMany({
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
        select: {
          id: true,
          title: true,
          documentKind: true,
          status: true,
          uploaderId: true
        }
      }),
      countQdrantPoints(runtime),
      countFiles(runtime.storageRoot)
    ]);
    const capturedAt = new Date().toISOString();
    const snapshotPath = path.join(
      runtime.runRoot,
      "snapshots",
      `${capturedAt.replace(/[:.]/g, "-")}-${label}.json`
    );
    const snapshot: ManualTestSnapshot = {
      runId: runtime.runId,
      capturedAt,
      snapshotPath,
      counts: {
        employees,
        skills,
        documents,
        processingRuns,
        documentChunks,
        documentIndexes,
        importBatches,
        partitionImportJobs,
        structuredPartitions,
        storageGarbage,
        vipRows,
        dishCatalogRows,
        auditLogs,
        qdrantPoints,
        storageFiles
      },
      documents: documentRecords.map((document) => ({
        ...document,
        documentKind: document.documentKind ?? null
      }))
    };

    await mkdir(path.dirname(snapshotPath), { recursive: true });
    await writeFile(snapshotPath, `${JSON.stringify(snapshot, null, 2)}\n`, "utf8");
    return snapshot;
  } finally {
    await prisma.$disconnect();
  }
}

async function cleanupManualTest(runtime: ManualTestRuntime): Promise<void> {
  await captureManualTestSnapshot(runtime, "final");
  await runCommand("docker", ["compose", "down"], composeProcessEnv(runtime), false);
  process.stdout.write(
    `${JSON.stringify({ ok: true, command: "cleanup", runId: runtime.runId, runRoot: runtime.runRoot }, null, 2)}\n`
  );
}

async function loadCurrentRuntime(cwd: string, env: NodeJS.ProcessEnv): Promise<ManualTestRuntime> {
  const manifest = JSON.parse(
    await readFile(currentManifestPath(cwd), "utf8")
  ) as ManualTestManifest;
  const runtime = buildManualTestRuntime({
    cwd,
    profile: manifest.profile,
    env,
    runId: manifest.runId
  });

  if (
    runtime.apiUrl !== manifest.apiUrl ||
    runtime.qdrantUrl !== manifest.qdrantUrl ||
    runtime.qdrantCollection !== manifest.qdrantCollection
  ) {
    throw new Error("Current manual test environment no longer matches its manifest.");
  }
  return runtime;
}

function assertCleanBusinessState(snapshot: ManualTestSnapshot): void {
  const businessCounts = {
    documents: snapshot.counts.documents,
    processingRuns: snapshot.counts.processingRuns,
    documentChunks: snapshot.counts.documentChunks,
    documentIndexes: snapshot.counts.documentIndexes,
    importBatches: snapshot.counts.importBatches,
    partitionImportJobs: snapshot.counts.partitionImportJobs,
    structuredPartitions: snapshot.counts.structuredPartitions,
    storageGarbage: snapshot.counts.storageGarbage,
    vipRows: snapshot.counts.vipRows,
    dishCatalogRows: snapshot.counts.dishCatalogRows,
    auditLogs: snapshot.counts.auditLogs,
    qdrantPoints: snapshot.counts.qdrantPoints,
    storageFiles: snapshot.counts.storageFiles
  };
  const dirty = Object.entries(businessCounts).filter(([, count]) => count !== 0);
  if (dirty.length > 0) {
    throw new Error(`Manual test business state is not empty: ${JSON.stringify(dirty)}`);
  }
  if (snapshot.counts.employees < 4 || snapshot.counts.skills < 2) {
    throw new Error("Manual test seed identities or skills are incomplete.");
  }
}

async function countQdrantPoints(runtime: ManualTestRuntime): Promise<number> {
  const response = await fetch(
    `${runtime.qdrantUrl}/collections/${encodeURIComponent(runtime.qdrantCollection)}/points/count`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ exact: true })
    }
  );
  if (!response.ok) {
    throw new Error(`Qdrant point count failed: HTTP ${response.status}`);
  }
  const body = (await response.json()) as { result?: { count?: number } };
  const count = body.result?.count;
  if (typeof count !== "number") {
    throw new Error("Qdrant point count response is invalid.");
  }
  return count;
}

async function countFiles(directory: string): Promise<number> {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return 0;
    }
    throw error;
  }

  const counts = await Promise.all(
    entries.map((entry) =>
      entry.isDirectory() ? countFiles(path.join(directory, entry.name)) : Promise.resolve(1)
    )
  );
  return counts.reduce((total, count) => total + count, 0);
}

function composeProcessEnv(runtime: ManualTestRuntime): NodeJS.ProcessEnv {
  return {
    ...manualTestProcessEnv(runtime),
    QDRANT_HTTP_PORT: "6333",
    QDRANT_GRPC_PORT: "6334"
  };
}

async function waitForMysqlHealth(env: NodeJS.ProcessEnv): Promise<void> {
  await waitForCondition("MySQL health", 90_000, async () => {
    const result = await runCommand(
      "docker",
      ["inspect", "-f", "{{.State.Health.Status}}", "enterprise-hub-mysql"],
      env,
      false
    );
    return result.stdout.trim() === "healthy";
  });
}

async function waitForApiHealth(
  apiUrl: string,
  child: ReturnType<typeof spawn>,
  logPath: string
): Promise<void> {
  await waitForCondition("API health", 60_000, async () => {
    if (child.exitCode !== null) {
      throw new Error(`Manual test API exited early. See ${logPath}.`);
    }
    try {
      const response = await fetch(`${apiUrl}/healthz`);
      return response.ok;
    } catch {
      return false;
    }
  });
}

async function waitForCondition(
  name: string,
  timeoutMs: number,
  check: () => Promise<boolean>
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) {
      return;
    }
    await delay(500);
  }
  throw new Error(`${name} did not become ready within ${timeoutMs}ms.`);
}

async function waitForShutdown(children: Array<ReturnType<typeof spawn>>): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const finish = () => resolve();
    process.once("SIGINT", finish);
    process.once("SIGTERM", finish);
    for (const child of children) {
      child.once("error", reject);
      child.once("exit", (code, signal) => {
        reject(
          new Error(
            `Manual test child exited unexpectedly: code=${code ?? "none"} signal=${signal ?? "none"}`
          )
        );
      });
    }
  });
}

async function stopChild(child: ReturnType<typeof spawn>): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return;
  }
  await new Promise<void>((resolve) => {
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
    }, 5_000);
    timeout.unref();
    child.once("close", () => {
      clearTimeout(timeout);
      resolve();
    });
    child.kill("SIGTERM");
  });
}

interface CommandResult {
  stdout: string;
  stderr: string;
  code: number | null;
}

async function runCommand(
  command: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  rejectOnFailure = true
): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: process.cwd(),
      env,
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString("utf8")));
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString("utf8")));
    child.once("error", reject);
    child.once("close", (code) => {
      const result = { stdout, stderr, code };
      if (code !== 0 && rejectOnFailure) {
        reject(
          new Error(
            [`Command failed (${code ?? "signal"}): ${command} ${args.join(" ")}`, stdout, stderr]
              .filter(Boolean)
              .join("\n\n")
          )
        );
        return;
      }
      resolve(result);
    });
  });
}

function currentManifestPath(cwd: string): string {
  return path.join(cwd, ".data", "manual-tests", "current.json");
}

function createRunId(date = new Date()): string {
  return date.toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15);
}

function isManualTestCommand(value: string | undefined): value is ManualTestCommand {
  return value === "prepare" || value === "serve" || value === "snapshot" || value === "cleanup";
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}

function buildProviderEnv(
  profile: ManualTestProfile,
  env: NodeJS.ProcessEnv
): Record<string, string> {
  if (profile === "fake") {
    return {
      LLM_PROVIDER: "fake",
      RERANK_PROVIDER: "fake",
      LLM_MODEL: "fake-rerank",
      LLM_EMBEDDING_MODEL: "fake-embedding",
      LLM_EMBEDDING_DIMENSION: "8",
      EXTERNAL_MODEL_EGRESS_ACKNOWLEDGED: "false"
    };
  }

  if (env["EXTERNAL_MODEL_EGRESS_ACKNOWLEDGED"] !== "true") {
    throw new Error(
      "Real manual tests require EXTERNAL_MODEL_EGRESS_ACKNOWLEDGED=true in the local environment."
    );
  }

  const required = [
    "LLM_PROVIDER",
    "LLM_EMBEDDING_MODEL",
    "OPENAI_COMPATIBLE_API_KEY",
    "OPENAI_COMPATIBLE_BASE_URL"
  ] as const;
  for (const name of required) {
    if (!env[name]?.trim()) {
      throw new Error(`Real manual tests require ${name}.`);
    }
  }

  return Object.fromEntries(
    [
      "LLM_PROVIDER",
      "RERANK_PROVIDER",
      "LLM_MODEL",
      "LLM_EMBEDDING_MODEL",
      "LLM_EMBEDDING_DIMENSION",
      "OPENAI_COMPATIBLE_API_KEY",
      "OPENAI_COMPATIBLE_BASE_URL",
      "DASHSCOPE_API_KEY",
      "DASHSCOPE_API_BASE_URL",
      "EXTERNAL_MODEL_EGRESS_ACKNOWLEDGED"
    ].flatMap((name) => (env[name] ? [[name, env[name]]] : []))
  );
}
