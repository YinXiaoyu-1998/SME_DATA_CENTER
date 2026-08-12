import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { PrismaMariaDb } from "@prisma/adapter-mariadb";
import { PrismaClient } from "@prisma/client";
import { config as loadDotenv } from "dotenv";
import { createStorageAdapter } from "@enterprise-hub/storage";
import { parseApiRetrievalRuntimeConfig } from "../apps/api/src/config/retrieval-runtime.js";
import {
  assertCleanupCountsAreZero,
  assertStagingRuntimeDatabaseTarget,
  createStructuredWindow,
  deleteStorageObjects,
  pollStructuredImportStatus,
  rewriteKnownValuesFixture,
  type CleanupCounts,
  type StructuredWindow
} from "./official-manual-acceptance-support.js";
import {
  runStagingController,
  type RemoteWindowResult
} from "./official-manual-remote-controller.js";

loadDotenv({ quiet: true, override: false });

const SERVICE_ORIGIN = "https://api.smedatacenter.xyz";
const LAUNCHER_VERSION = "0.2.0";
const DEFAULT_LABEL_KEY = "store:baoli";
const RUN_ROOT = path.join(process.cwd(), ".data", "official-manual-acceptance");

interface ParsedArgs {
  command: "run" | "cleanup" | "controller-cleanup" | "controller-window";
  runId: string;
  keepData: boolean;
}

interface ToolTextResult {
  [key: string]: unknown;
}

interface EvidenceUploadResult extends ToolTextResult {
  document: { documentId: string; status: string };
}

interface EvidenceStatusResult extends ToolTextResult {
  document: { documentId: string; status: string };
  documentIndex: { status: string };
}

interface EvidenceSearchResult extends ToolTextResult {
  results: Array<{ documentId: string; text: string }>;
}

interface StructuredUploadResult extends ToolTextResult {
  importBatch: {
    importBatchId: string;
    status: string;
    appliedRowCount?: number;
    validationErrorCount?: number;
  };
  document: { documentId: string };
}

interface StructuredQueryResult extends ToolTextResult {
  rows: Array<Record<string, unknown>>;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const parsedArgs = parseArgs(process.argv.slice(2));
  if (parsedArgs.command.startsWith("controller-")) {
    await runControllerCommand(parsedArgs);
  } else {
    await runLocalAcceptance(parsedArgs);
  }
}

async function runLocalAcceptance(args: ParsedArgs): Promise<void> {
  const run = runConfig(args.runId);
  await removeStaleReport(run);
  await runStagingController("cleanup", run.runId);
  if (args.command === "cleanup") {
    await writeReport(run, {
      ok: true,
      runId: run.runId,
      cleanedOnly: true,
      cleanupVerified: true,
      controller: "staging-api-container"
    });
    printSafe({ ok: true, command: "cleanup", runId: run.runId });
    return;
  }

  const windowResult = await runStagingController<RemoteWindowResult>("window", run.runId);
  let outcome: Record<string, unknown>;
  let cleanupVerified = false;
  try {
    outcome = await runAcceptance(run, windowResult.structuredWindow);
  } finally {
    if (!args.keepData) {
      await runStagingController("cleanup", run.runId);
      cleanupVerified = true;
      printSafe({ ok: true, command: "cleanup", runId: run.runId });
    }
  }
  const finalOutcome: Record<string, unknown> = args.keepData
    ? {
        ...outcome,
        cleanupVerified: false,
        dataRetainedByRequest: true
      }
    : {
        ...outcome,
        cleanupVerified,
        controller: "staging-api-container"
      };
  await writeReport(run, finalOutcome);
  printSafe({ ok: true, command: "run", runId: run.runId, report: reportPath(run) });
}

async function runControllerCommand(args: ParsedArgs): Promise<void> {
  const databaseUrl = process.env["DATABASE_URL"];
  if (!databaseUrl) {
    throw new Error("DATABASE_URL is required in the staging controller runtime.");
  }
  assertStagingRuntimeDatabaseTarget(databaseUrl);

  const run = runConfig(args.runId);
  const prisma = new PrismaClient({ adapter: new PrismaMariaDb(databaseUrl) });
  try {
    if (args.command === "controller-cleanup") {
      await cleanupRun(prisma, run);
      printSafe({
        ok: true,
        command: "controller-cleanup",
        runId: run.runId,
        cleanupVerified: true
      });
      return;
    }
    const structuredWindow = await selectAvailableStructuredWindow(prisma, run.runId);
    printSafe({
      ok: true,
      command: "controller-window",
      runId: run.runId,
      structuredWindow
    });
  } finally {
    await prisma.$disconnect();
  }
}

async function runAcceptance(
  run: ReturnType<typeof runConfig>,
  structuredWindow: StructuredWindow
): Promise<Record<string, unknown>> {
  const launcher = launcherPath();
  const client = new Client({
    name: "enterprise-hub-official-manual-acceptance",
    version: "0.1.0"
  });
  const transport = new StdioClientTransport({
    command: launcher,
    args: ["serve"],
    env: {
      ENTERPRISE_HUB_BASE_URL: SERVICE_ORIGIN,
      PATH: process.env["PATH"] ?? ""
    }
  });
  await client.connect(transport, { timeout: 30_000 });

  try {
    const status = await callJson<ToolTextResult>(client, "enterprise_hub_auth_status", {});
    if (status["authenticated"] !== true) {
      throw new Error("Official launcher is not authenticated. Run enterprise_hub_login first.");
    }

    const labels = await callJson<ToolTextResult>(client, "enterprise_hub_list_labels", {});
    assertHasLabel(labels, DEFAULT_LABEL_KEY);

    const evidenceUploads = await uploadEvidenceFixtures(client, run);
    for (const upload of evidenceUploads) {
      await waitForEvidenceReady(client, upload.document.documentId);
    }

    const evidenceSearch = await callJson<EvidenceSearchResult>(
      client,
      "search_document_evidence",
      {
        query: "肉夹馍 默认 青椒",
        filters: { documentIds: evidenceUploads.map((upload) => upload.document.documentId) },
        limit: 5
      }
    );
    const evidenceIds = new Set(evidenceUploads.map((upload) => upload.document.documentId));
    if (!evidenceSearch.results.some((result) => evidenceIds.has(result.documentId))) {
      throw new Error(
        "Evidence search did not return the just-uploaded manual acceptance document."
      );
    }

    const structuredFile = await writeRunStructuredFixture(run, structuredWindow);
    const structuredUpload = await callJson<StructuredUploadResult>(
      client,
      "upload_structured_dataset",
      {
        file: {
          name: path.basename(structuredFile),
          mediaType: "text/csv",
          encoding: "base64",
          contentBase64: await fileBase64(structuredFile)
        },
        dataset: "dishes",
        enterpriseName: run.enterpriseName,
        startDate: structuredWindow.startCompact,
        endDate: structuredWindow.endCompact,
        idempotencyKey: `official-manual-acceptance:${run.runId}:dishes-known-values`,
        labelKeys: [DEFAULT_LABEL_KEY]
      }
    );
    if (structuredUpload.importBatch.status !== "pending") {
      throw new Error(
        `Expected structured import to be accepted as pending; got ${structuredUpload.importBatch.status}.`
      );
    }
    const structuredCompletion = await pollStructuredImportStatus({
      importBatchId: structuredUpload.importBatch.importBatchId,
      getStatus: () =>
        callJson<StructuredUploadResult>(client, "get_import_status", {
          importBatchId: structuredUpload.importBatch.importBatchId
        })
    });
    if (structuredCompletion.importBatch.status !== "applied") {
      throw new Error(
        `Expected structured import to apply after polling; got ${structuredCompletion.importBatch.status}.`
      );
    }

    const aggregateQuery = await callJson<StructuredQueryResult>(
      client,
      "query_structured_dataset",
      {
        dataset: "dishes",
        filter: {
          field: "business_date",
          op: "between",
          value: [structuredWindow.startDate, structuredWindow.endDate]
        },
        aggregates: [
          { op: "count", as: "row_count" },
          { op: "sum", field: "dishes_024_dish_sales_amount", as: "gross_sales" }
        ]
      }
    );
    const aggregate = aggregateQuery.rows[0] ?? {};
    if (String(aggregate["row_count"]) !== "3" || Number(aggregate["gross_sales"]) !== 91) {
      throw new Error(
        `Unexpected structured aggregate result: ${JSON.stringify(redactObject(aggregate))}`
      );
    }

    const topDishes = await callJson<StructuredQueryResult>(client, "query_structured_dataset", {
      dataset: "dishes",
      select: ["product_name", "dishes_024_dish_sales_amount"],
      filter: {
        field: "business_date",
        op: "between",
        value: [structuredWindow.startDate, structuredWindow.endDate]
      },
      sort: [{ field: "dishes_024_dish_sales_amount", direction: "desc" }],
      page: { limit: 2 }
    });
    const topNames = topDishes.rows.map((row) => row["product_name"]);
    if (topNames[0] !== "合成凉皮" || topNames[1] !== "合成肉夹馍") {
      throw new Error(`Unexpected top dishes: ${JSON.stringify(topNames)}`);
    }

    const invalidFile = await writeRunInvalidStructuredFixture(run, structuredWindow);
    const invalidImport = await callJson<StructuredUploadResult>(
      client,
      "upload_structured_dataset",
      {
        file: {
          name: path.basename(invalidFile),
          mediaType: "text/csv",
          encoding: "base64",
          contentBase64: await fileBase64(invalidFile)
        },
        dataset: "dishes",
        enterpriseName: run.enterpriseName,
        startDate: structuredWindow.invalidCompact,
        endDate: structuredWindow.invalidCompact,
        idempotencyKey: `official-manual-acceptance:${run.runId}:dishes-invalid-atomic`,
        labelKeys: [DEFAULT_LABEL_KEY]
      }
    );
    if (invalidImport.importBatch.status !== "pending") {
      throw new Error(
        `Expected invalid structured import to be accepted as pending; got ${invalidImport.importBatch.status}.`
      );
    }
    const invalidCompletion = await pollStructuredImportStatus({
      importBatchId: invalidImport.importBatch.importBatchId,
      getStatus: () =>
        callJson<StructuredUploadResult>(client, "get_import_status", {
          importBatchId: invalidImport.importBatch.importBatchId
        })
    });
    if (
      invalidCompletion.importBatch.status !== "rejected" ||
      (invalidCompletion.importBatch.validationErrorCount ?? 0) === 0
    ) {
      throw new Error(
        "Expected invalid structured import to be rejected after polling with safe validation errors."
      );
    }

    return {
      ok: true,
      runId: run.runId,
      serviceOrigin: SERVICE_ORIGIN,
      launcherVersion: LAUNCHER_VERSION,
      labelKey: DEFAULT_LABEL_KEY,
      evidenceDocuments: evidenceUploads.map((upload) => upload.document.documentId),
      structuredDocument: structuredUpload.document.documentId,
      importBatch: structuredUpload.importBatch.importBatchId,
      structuredWindow: {
        startDate: structuredWindow.startDate,
        endDate: structuredWindow.endDate
      },
      aggregate: redactObject(aggregate),
      topDishes: topNames
    };
  } finally {
    await client.close().catch(() => undefined);
  }
}

async function uploadEvidenceFixtures(
  client: Client,
  run: ReturnType<typeof runConfig>
): Promise<EvidenceUploadResult[]> {
  return Promise.all([
    callJson<EvidenceUploadResult>(client, "upload_evidence_document", {
      file: {
        name: "baoli-roujiamo-sop.md",
        mediaType: "text/markdown",
        encoding: "base64",
        contentBase64: await fileBase64("fixtures/manual-acceptance/evidence/baoli-roujiamo-sop.md")
      },
      title: `${run.titlePrefix} Baoli Roujiamo SOP`,
      sourceSystem: run.evidenceSourceSystem,
      labelKeys: [DEFAULT_LABEL_KEY]
    }),
    callJson<EvidenceUploadResult>(client, "upload_evidence_document", {
      file: {
        name: "prompt-injection-sop.md",
        mediaType: "text/markdown",
        encoding: "base64",
        contentBase64: await fileBase64(
          "fixtures/manual-acceptance/evidence/prompt-injection-sop.md"
        )
      },
      title: `${run.titlePrefix} Prompt Injection Fixture`,
      sourceSystem: run.evidenceSourceSystem,
      labelKeys: [DEFAULT_LABEL_KEY]
    })
  ]);
}

async function waitForEvidenceReady(client: Client, documentId: string): Promise<void> {
  const deadline = Date.now() + 180_000;
  let lastStatus = "unknown";
  while (Date.now() < deadline) {
    const status = await callJson<EvidenceStatusResult>(client, "get_evidence_document_status", {
      documentId
    });
    lastStatus = `${status.document.status}/${status.documentIndex.status}`;
    if (status.document.status === "active" && status.documentIndex.status === "ready") {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 3_000));
  }
  throw new Error(`Evidence document ${documentId} did not become ready; last=${lastStatus}.`);
}

async function callJson<T>(
  client: Client,
  name: string,
  args: Record<string, unknown>
): Promise<T> {
  const result = await client.callTool({ name, arguments: args }, undefined, { timeout: 60_000 });
  const content = result.content as Array<{ type: string; text?: string }> | undefined;
  const text = content?.[0]?.type === "text" ? (content[0].text ?? "") : "";
  if (!text) {
    throw new Error(`${name} returned no text content.`);
  }
  const parsed = JSON.parse(text) as T & { isError?: boolean; error?: unknown };
  if (result.isError && name !== "upload_structured_dataset") {
    throw new Error(`${name} failed: ${JSON.stringify(redactObject(parsed))}`);
  }
  return { ...parsed, isError: Boolean(result.isError) } as T;
}

async function cleanupRun(prisma: PrismaClient, run: ReturnType<typeof runConfig>): Promise<void> {
  const documents = await prisma.document.findMany({
    where: {
      OR: [
        { sourceSystem: run.evidenceSourceSystem },
        { title: { startsWith: `${run.enterpriseName}_` } },
        { title: { startsWith: run.titlePrefix } }
      ]
    },
    select: {
      id: true,
      storageObjectKey: true,
      chunks: {
        where: { qdrantPointId: { not: null } },
        select: { qdrantPointId: true }
      },
      importBatch: { select: { id: true } }
    }
  });

  const qdrantPointIds = documents.flatMap((document) =>
    document.chunks
      .map((chunk) => chunk.qdrantPointId)
      .filter((pointId): pointId is string => Boolean(pointId))
  );
  await deleteQdrantPoints(qdrantPointIds);

  const storage = createStorageAdapter(process.env);
  const storageObjectKeys = documents.map((document) => document.storageObjectKey);
  await deleteStorageObjects(storage, storageObjectKeys);

  const documentIds = documents.map((document) => document.id);
  const importBatchIds = documents
    .map((document) => document.importBatch?.id)
    .filter((id): id is string => Boolean(id));

  await prisma.$transaction(async (tx) => {
    if (importBatchIds.length > 0) {
      await tx.dishRow.deleteMany({ where: { importBatchId: { in: importBatchIds } } });
      await tx.businessRow.deleteMany({ where: { importBatchId: { in: importBatchIds } } });
      await tx.importWindowClaim.deleteMany({ where: { importBatchId: { in: importBatchIds } } });
      await tx.importBatch.deleteMany({ where: { id: { in: importBatchIds } } });
    }
    await tx.document.deleteMany({ where: { id: { in: documentIds } } });
  });

  await verifyCleanup(prisma, run, {
    documentIds,
    importBatchIds,
    qdrantPointIds,
    storageObjectKeys
  });
}

async function deleteQdrantPoints(pointIds: string[]): Promise<void> {
  if (pointIds.length === 0) return;

  const runtime = parseApiRetrievalRuntimeConfig();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), runtime.qdrant.timeoutMs);
  try {
    const response = await fetch(
      `${runtime.qdrant.url}/collections/${encodeURIComponent(runtime.qdrant.collectionName)}/points/delete?wait=true`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(runtime.qdrant.apiKey ? { "api-key": runtime.qdrant.apiKey } : {})
        },
        body: JSON.stringify({ points: pointIds }),
        signal: controller.signal
      }
    );
    if (!response.ok) {
      throw new Error(`Qdrant cleanup failed: HTTP ${response.status}`);
    }
  } finally {
    clearTimeout(timeout);
  }
}

async function selectAvailableStructuredWindow(
  prisma: PrismaClient,
  runId: string
): Promise<StructuredWindow> {
  for (let attempt = 0; attempt < 256; attempt += 1) {
    const candidate = createStructuredWindow(runId, attempt);
    const overlap = await prisma.importWindowClaim.findFirst({
      where: {
        orgId: "default-org",
        dataset: "dishes",
        startDate: { lte: new Date(`${candidate.endDate}T00:00:00.000Z`) },
        endDate: { gte: new Date(`${candidate.startDate}T00:00:00.000Z`) }
      },
      select: { id: true }
    });
    if (!overlap) return candidate;
  }
  throw new Error("Could not allocate an unused structured-import window after 256 attempts.");
}

async function verifyCleanup(
  prisma: PrismaClient,
  run: ReturnType<typeof runConfig>,
  deleted: {
    documentIds: string[];
    importBatchIds: string[];
    qdrantPointIds: string[];
    storageObjectKeys: string[];
  }
): Promise<void> {
  const storage = createStorageAdapter(process.env);
  let storageObjects = 0;
  for (const key of deleted.storageObjectKeys) {
    try {
      await storage.statObject(key);
      storageObjects += 1;
    } catch (error) {
      if (!isMissingStorageObject(error)) throw error;
    }
  }

  const [documents, importBatches, dishRows, businessRows, windowClaims, qdrantPoints] =
    await Promise.all([
      prisma.document.count({
        where: {
          OR: [
            { sourceSystem: run.evidenceSourceSystem },
            { title: { startsWith: `${run.enterpriseName}_` } },
            { title: { startsWith: run.titlePrefix } }
          ]
        }
      }),
      countByIds(deleted.importBatchIds, (ids) =>
        prisma.importBatch.count({ where: { id: { in: ids } } })
      ),
      countByIds(deleted.importBatchIds, (ids) =>
        prisma.dishRow.count({ where: { importBatchId: { in: ids } } })
      ),
      countByIds(deleted.importBatchIds, (ids) =>
        prisma.businessRow.count({ where: { importBatchId: { in: ids } } })
      ),
      countByIds(deleted.importBatchIds, (ids) =>
        prisma.importWindowClaim.count({ where: { importBatchId: { in: ids } } })
      ),
      retrieveQdrantPointCount(deleted.qdrantPointIds)
    ]);

  const counts: CleanupCounts = {
    documents,
    importBatches,
    dishRows,
    businessRows,
    windowClaims,
    qdrantPoints,
    storageObjects
  };
  assertCleanupCountsAreZero(counts);
}

async function retrieveQdrantPointCount(pointIds: string[]): Promise<number> {
  if (pointIds.length === 0) return 0;

  const runtime = parseApiRetrievalRuntimeConfig();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), runtime.qdrant.timeoutMs);
  try {
    const response = await fetch(
      `${runtime.qdrant.url}/collections/${encodeURIComponent(runtime.qdrant.collectionName)}/points`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(runtime.qdrant.apiKey ? { "api-key": runtime.qdrant.apiKey } : {})
        },
        body: JSON.stringify({
          ids: pointIds,
          with_payload: false,
          with_vector: false
        }),
        signal: controller.signal
      }
    );
    if (!response.ok) {
      throw new Error(`Qdrant cleanup verification failed: HTTP ${response.status}`);
    }
    const body = (await response.json()) as { result?: unknown[] };
    if (!Array.isArray(body.result)) {
      throw new Error("Qdrant cleanup verification returned an unexpected response shape.");
    }
    return body.result.length;
  } finally {
    clearTimeout(timeout);
  }
}

async function countByIds(
  ids: string[],
  count: (ids: string[]) => Promise<number>
): Promise<number> {
  return ids.length === 0 ? 0 : count(ids);
}

function isMissingStorageObject(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const candidate = error as {
    name?: unknown;
    code?: unknown;
    Code?: unknown;
    statusCode?: unknown;
    $metadata?: { httpStatusCode?: unknown };
  };
  return (
    candidate.name === "NotFound" ||
    candidate.code === "ENOENT" ||
    candidate.code === "NoSuchKey" ||
    candidate.Code === "NoSuchKey" ||
    candidate.statusCode === 404 ||
    candidate.$metadata?.httpStatusCode === 404
  );
}

async function writeRunStructuredFixture(
  run: ReturnType<typeof runConfig>,
  structuredWindow: StructuredWindow
): Promise<string> {
  const source = await readFile(
    "fixtures/manual-acceptance/structured/dishes-known-values.csv",
    "utf8"
  );
  const updated = rewriteKnownValuesFixture(source, structuredWindow);
  const directory = path.join(RUN_ROOT, run.runId);
  await mkdir(directory, { recursive: true });
  const target = path.join(
    directory,
    `dishes-known-values-${structuredWindow.startCompact}-${structuredWindow.endCompact}.csv`
  );
  await writeFile(target, updated);
  return target;
}

async function writeRunInvalidStructuredFixture(
  run: ReturnType<typeof runConfig>,
  structuredWindow: StructuredWindow
): Promise<string> {
  const source = await readFile(
    "fixtures/manual-acceptance/structured/dishes-invalid-atomic.csv",
    "utf8"
  );
  const updated = source.replaceAll("2026-07-04", structuredWindow.invalidDate);
  const directory = path.join(RUN_ROOT, run.runId);
  await mkdir(directory, { recursive: true });
  const target = path.join(
    directory,
    `dishes-invalid-atomic-${structuredWindow.invalidCompact}.csv`
  );
  await writeFile(target, updated);
  return target;
}

async function fileBase64(filePath: string): Promise<string> {
  return (await readFile(filePath)).toString("base64");
}

async function writeReport(run: ReturnType<typeof runConfig>, result: Record<string, unknown>) {
  await mkdir(path.dirname(reportPath(run)), { recursive: true });
  const body = [
    "# Official Manual Acceptance Report",
    "",
    `- Run ID: ${run.runId}`,
    `- Service origin: ${SERVICE_ORIGIN}`,
    `- Launcher version: ${LAUNCHER_VERSION}`,
    `- Evidence source system: ${run.evidenceSourceSystem}`,
    `- Structured enterprise name: ${run.enterpriseName}`,
    `- Result: ${result["ok"] === true ? "pass" : "fail"}`,
    "",
    "```json",
    JSON.stringify(redactObject(result), null, 2),
    "```",
    ""
  ].join("\n");
  await writeFile(reportPath(run), body);
}

function runConfig(runId: string) {
  const safeRunId = runId
    .trim()
    .replace(/[^A-Za-z0-9_-]/g, "-")
    .slice(0, 48);
  if (!safeRunId) {
    throw new Error("runId must contain at least one safe character.");
  }
  const compact = safeRunId.replace(/[^A-Za-z0-9]/g, "_");
  return {
    runId: safeRunId,
    titlePrefix: `[manual-acceptance:${safeRunId}]`,
    evidenceSourceSystem: `manual_acceptance_${compact}`,
    enterpriseName: `ManualAcceptance_${compact}`
  };
}

function launcherPath(): string {
  if (process.platform !== "darwin") {
    throw new Error("This runner currently covers the macOS Codex acceptance path only.");
  }
  return path.join(
    os.homedir(),
    "Library/Application Support/Enterprise Hub/launcher/versions",
    LAUNCHER_VERSION,
    "node_modules/.bin/enterprise-hub-mcp-launcher"
  );
}

function reportPath(run: ReturnType<typeof runConfig>): string {
  return path.join(RUN_ROOT, run.runId, "report.md");
}

async function removeStaleReport(run: ReturnType<typeof runConfig>): Promise<void> {
  try {
    await unlink(reportPath(run));
  } catch (error) {
    if (!error || typeof error !== "object" || !("code" in error) || error.code !== "ENOENT") {
      throw error;
    }
  }
}

function assertHasLabel(labels: ToolTextResult, key: string): void {
  const labelKeys = Array.isArray(labels["labels"])
    ? labels["labels"]
        .map((label) =>
          typeof label === "object" && label !== null && "key" in label
            ? String((label as { key: unknown }).key)
            : null
        )
        .filter(Boolean)
    : [];
  if (!labelKeys.includes(key)) {
    throw new Error(`Authenticated employee cannot see required label ${key}.`);
  }
}

function parseArgs(args: string[]): ParsedArgs {
  const commands: ParsedArgs["command"][] = [
    "run",
    "cleanup",
    "controller-cleanup",
    "controller-window"
  ];
  const first = args[0] as ParsedArgs["command"] | undefined;
  const command = first && commands.includes(first) ? first : "run";
  const rest = first && commands.includes(first) ? args.slice(1) : args;
  let runId = new Date().toISOString().replace(/[-:]/g, "").replace(/\..+/, "Z");
  let keepData = false;
  for (const arg of rest) {
    if (arg === "--keep-data") {
      keepData = true;
      continue;
    }
    if (arg.startsWith("--run-id=")) {
      runId = arg.slice("--run-id=".length);
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }
  return { command, runId, keepData };
}

function printSafe(value: Record<string, unknown>): void {
  process.stdout.write(`${JSON.stringify(redactObject(value), null, 2)}\n`);
}

function redactObject<T>(input: T): T {
  return JSON.parse(
    JSON.stringify(input, (key, value) => {
      const normalized = key.toLowerCase();
      if (
        normalized.includes("token") ||
        normalized.includes("credential") ||
        normalized.includes("password") ||
        normalized.includes("authorization") ||
        normalized.includes("secret")
      ) {
        return "[redacted]";
      }
      if (typeof value === "string") {
        if (/eh_(?:at|rt|ac|ps|tx)_[A-Za-z0-9_-]{20,}/.test(value)) return "[redacted]";
        if (value.includes("://") && value.includes("@")) return "[redacted-url]";
      }
      return value;
    })
  ) as T;
}
