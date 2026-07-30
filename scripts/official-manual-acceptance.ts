import { mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { PrismaMariaDb } from "@prisma/adapter-mariadb";
import { PrismaClient } from "@prisma/client";
import { config as loadDotenv } from "dotenv";
import { createStorageAdapter } from "@enterprise-hub/storage";
import { parseApiRetrievalRuntimeConfig } from "../apps/api/src/config/retrieval-runtime.js";

loadDotenv({ quiet: true, override: false });

const SERVICE_ORIGIN = "https://api.smedatacenter.xyz";
const LAUNCHER_VERSION = "0.1.0";
const DEFAULT_LABEL_KEY = "store:baoli";
const RUN_ROOT = path.join(process.cwd(), ".data", "official-manual-acceptance");

interface ParsedArgs {
  command: "run" | "cleanup";
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
  importBatch: { importBatchId: string; status: string; appliedRowCount?: number };
  document: { documentId: string };
}

interface StructuredQueryResult extends ToolTextResult {
  rows: Array<Record<string, unknown>>;
}

const parsedArgs = parseArgs(process.argv.slice(2));
await main(parsedArgs);

async function main(args: ParsedArgs): Promise<void> {
  const databaseUrl = process.env["DATABASE_URL"];
  if (!databaseUrl) {
    throw new Error("DATABASE_URL is required for official manual acceptance cleanup.");
  }
  assertCleanupTargetMatchesService(databaseUrl);

  const run = runConfig(args.runId);
  const prisma = new PrismaClient({ adapter: new PrismaMariaDb(databaseUrl) });
  try {
    await cleanupRun(prisma, run);
    if (args.command === "cleanup") {
      await writeReport(run, {
        ok: true,
        runId: run.runId,
        cleanedOnly: true
      });
      printSafe({ ok: true, command: "cleanup", runId: run.runId });
      return;
    }

    const outcome = await runAcceptance(run);
    await writeReport(run, outcome);
    printSafe({ ok: true, command: "run", runId: run.runId, report: reportPath(run) });

    if (!args.keepData) {
      await cleanupRun(prisma, run);
      printSafe({ ok: true, command: "cleanup", runId: run.runId });
    }
  } finally {
    await prisma.$disconnect();
  }
}

async function runAcceptance(run: ReturnType<typeof runConfig>): Promise<Record<string, unknown>> {
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

    const structuredFile = await writeRunStructuredFixture(run);
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
        startDate: "20300101",
        endDate: "20300103",
        idempotencyKey: `official-manual-acceptance:${run.runId}:dishes-known-values`,
        labelKeys: [DEFAULT_LABEL_KEY]
      }
    );
    if (structuredUpload.importBatch.status !== "applied") {
      throw new Error(
        `Expected structured import applied; got ${structuredUpload.importBatch.status}.`
      );
    }

    const aggregateQuery = await callJson<StructuredQueryResult>(
      client,
      "query_structured_dataset",
      {
        dataset: "dishes",
        filter: { field: "business_date", op: "between", value: ["2030-01-01", "2030-01-03"] },
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
      filter: { field: "business_date", op: "between", value: ["2030-01-01", "2030-01-03"] },
      sort: [{ field: "dishes_024_dish_sales_amount", direction: "desc" }],
      page: { limit: 2 }
    });
    const topNames = topDishes.rows.map((row) => row["product_name"]);
    if (topNames[0] !== "合成凉皮" || topNames[1] !== "合成肉夹馍") {
      throw new Error(`Unexpected top dishes: ${JSON.stringify(topNames)}`);
    }

    const invalidImport = await callJson<ToolTextResult>(client, "upload_structured_dataset", {
      file: {
        name: "dishes-invalid-atomic.csv",
        mediaType: "text/csv",
        encoding: "base64",
        contentBase64: await fileBase64(
          "fixtures/manual-acceptance/structured/dishes-invalid-atomic.csv"
        )
      },
      dataset: "dishes",
      enterpriseName: run.enterpriseName,
      startDate: "20300104",
      endDate: "20300104",
      idempotencyKey: `official-manual-acceptance:${run.runId}:dishes-invalid-atomic`,
      labelKeys: [DEFAULT_LABEL_KEY]
    });
    if (!invalidImport["isError"] && !JSON.stringify(invalidImport).includes("validation")) {
      throw new Error("Invalid structured import did not return a validation-style failure.");
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

  if (documents.length === 0) {
    return;
  }

  const qdrantPointIds = documents.flatMap((document) =>
    document.chunks
      .map((chunk) => chunk.qdrantPointId)
      .filter((pointId): pointId is string => Boolean(pointId))
  );
  await deleteQdrantPoints(qdrantPointIds);

  const storage = createStorageAdapter(process.env);
  for (const document of documents) {
    await storage.deleteObject(document.storageObjectKey).catch(() => undefined);
  }

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

async function writeRunStructuredFixture(run: ReturnType<typeof runConfig>): Promise<string> {
  const source = await readFile(
    "fixtures/manual-acceptance/structured/dishes-known-values.csv",
    "utf8"
  );
  const updated = source
    .replaceAll("2026-07-01", "2030-01-01")
    .replaceAll("2026-07-02", "2030-01-02")
    .replaceAll("2026-07-03", "2030-01-03")
    .replaceAll("2026/07", "2030/01")
    .replaceAll("2026第27周", "2030第01周");
  const directory = path.join(RUN_ROOT, run.runId);
  await mkdir(directory, { recursive: true });
  const target = path.join(directory, "dishes-known-values-20300101-20300103.csv");
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

function assertCleanupTargetMatchesService(databaseUrl: string): void {
  const serviceHost = new URL(SERVICE_ORIGIN).hostname;
  const databaseHost = new URL(databaseUrl).hostname;
  const serviceIsLoopback = isLoopbackHost(serviceHost);
  const databaseIsLoopback = isLoopbackHost(databaseHost);

  if (!serviceIsLoopback && databaseIsLoopback) {
    throw new Error(
      "Official manual acceptance targets the public staging service, but DATABASE_URL points to a local database. Run cleanup from the staging runtime or configure the matching staging cleanup environment."
    );
  }
}

function isLoopbackHost(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1";
}

function reportPath(run: ReturnType<typeof runConfig>): string {
  return path.join(RUN_ROOT, run.runId, "report.md");
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
  const command = args[0] === "cleanup" ? "cleanup" : "run";
  const rest = command === "cleanup" ? args.slice(1) : args;
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
