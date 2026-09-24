import { mkdir, readFile, rm, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { PrismaMariaDb } from "@prisma/adapter-mariadb";
import { PrismaClient } from "@prisma/client";
import { parse as parseCsv } from "csv-parse/sync";
import { config as loadDotenv } from "dotenv";
import { createStorageAdapter } from "@smedc/storage";
import { parseApiRetrievalRuntimeConfig } from "../apps/api/src/config/retrieval-runtime.js";
import {
  assertCleanupCountsAreZero,
  assertStagingRuntimeDatabaseTarget,
  createStructuredWindow,
  deleteStorageObjects,
  isAcceptanceAccount,
  acceptanceAccountEmails,
  pollStructuredImportStatus,
  rewriteKnownValuesFixture,
  type CleanupCounts,
  type CurrentEnterpriseHubUserResult,
  type StructuredWindow
} from "./official-manual-acceptance-support.js";
import {
  runStagingController,
  type RemoteWindowResult
} from "./official-manual-remote-controller.js";

loadDotenv({ quiet: true, override: false });

const SERVICE_ORIGIN = "https://api.smedatacenter.xyz";
const LAUNCHER_VERSION = "0.5.2";
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

interface PartitionUploadResult extends ToolTextResult {
  partitionImportJobId: string;
  status: string;
  partitionCount: number;
  totalRowCount: number;
  error?: { code?: string; message?: string } | null;
}

interface PartitionDownloadResult extends ToolTextResult {
  localDirectory: string;
  partitionCount: number;
  totalRowCount: number;
  files: string[];
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
      controller: "staging-release-ops"
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
        controller: "staging-release-ops"
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
    name: "smedc-official-manual-acceptance",
    version: "0.1.0"
  });
  const transport = new StdioClientTransport({
    command: launcher,
    args: ["serve"],
    env: {
      SMEDC_BASE_URL: SERVICE_ORIGIN,
      PATH: process.env["PATH"] ?? ""
    }
  });
  await client.connect(transport, { timeout: 30_000 });
  const localExtracts: string[] = [];

  try {
    const status = await callJson<ToolTextResult>(client, "smedc_auth_status", {});
    if (status["authenticated"] !== true) {
      throw new Error("Official launcher is not authenticated. Run smedc_login first.");
    }

    const currentUser = await callJson<CurrentEnterpriseHubUserResult>(
      client,
      "smedc_get_current_user",
      {}
    );
    if (!isAcceptanceAccount(currentUser, run.runId, "admin")) {
      throw new Error("Positive upload smoke requires this run's synthetic admin at clearance 0.");
    }

    const [defaultEvidenceUpload, explicitLevelEvidenceUpload] = await uploadEvidenceFixtures(
      client,
      run
    );
    const deliveryUpload = await callJson<{
      importBatch: { importBatchId: string; status: string };
    }>(client, "upload_structured_dataset", {
      file: {
        name: "delivery_sheet_SH2608250117.xlsx",
        mediaType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        encoding: "path",
        filePath: path.resolve("fixtures/structured/delivery_sheet_SH2608250117.xlsx")
      },
      dataset: "delivery_ledger",
      enterpriseName: run.enterpriseName,
      idempotencyKey: `official-manual-acceptance:${run.runId}:delivery-ledger`
    });
    const deliveryCompletion = await pollStructuredImportStatus({
      importBatchId: deliveryUpload.importBatch.importBatchId,
      getStatus: () =>
        callJson<{ importBatch: { importBatchId: string; status: string } }>(
          client,
          "get_import_status",
          { importBatchId: deliveryUpload.importBatch.importBatchId }
        )
    });
    if (deliveryCompletion.importBatch.status !== "applied") {
      throw new Error("Delivery Ledger XLSX row import did not apply.");
    }
    await waitForEvidenceReady(client, defaultEvidenceUpload.document.documentId);

    const evidenceSearch = await callJson<EvidenceSearchResult>(
      client,
      "search_document_evidence",
      {
        query: "肉夹馍 默认 青椒",
        filters: { documentIds: [defaultEvidenceUpload.document.documentId] },
        limit: 5
      }
    );
    const evidenceIds = new Set([defaultEvidenceUpload.document.documentId]);
    if (!evidenceSearch.results.some((result) => evidenceIds.has(result.documentId))) {
      throw new Error(
        "Evidence search did not return the just-uploaded manual acceptance document."
      );
    }

    const structuredFile = await writeRunStructuredFixture(run, structuredWindow);
    const structuredUpload = await callJson<PartitionUploadResult>(
      client,
      "upload_structured_dataset",
      {
        file: {
          name: path.basename(structuredFile),
          mediaType: "text/csv",
          encoding: "path",
          filePath: structuredFile
        },
        dataset: "dishes",
        enterpriseName: run.enterpriseName,
        startDate: structuredWindow.startCompact,
        endDate: structuredWindow.endCompact,
        idempotencyKey: `official-manual-acceptance:${run.runId}:dishes-known-values`
      }
    );
    if (structuredUpload.status !== "queued" && structuredUpload.status !== "published") {
      throw new Error(`Expected partition import to queue; got ${structuredUpload.status}.`);
    }
    const structuredCompletion = await pollPartitionImportStatus(
      client,
      structuredUpload.partitionImportJobId
    );
    if (
      structuredCompletion.status !== "published" ||
      structuredCompletion.partitionCount !== 3 ||
      structuredCompletion.totalRowCount !== 3
    ) {
      throw new Error(
        `Expected three published partitions; got ${JSON.stringify(redactObject(structuredCompletion))}.`
      );
    }

    const downloaded = await callJson<PartitionDownloadResult>(
      client,
      "download_structured_partitions",
      {
        dataset: "dishes",
        enterpriseName: run.enterpriseName,
        startDate: structuredWindow.startCompact,
        endDate: structuredWindow.endCompact
      }
    );
    localExtracts.push(downloaded.localDirectory);
    if (
      downloaded.partitionCount !== 3 ||
      downloaded.totalRowCount !== 3 ||
      downloaded.files.length !== 3
    ) {
      throw new Error(`Unexpected partition download: ${JSON.stringify(redactObject(downloaded))}`);
    }
    const rows: Array<Record<string, string>> = [];
    for (const fileName of downloaded.files) {
      const csv = await readFile(path.join(downloaded.localDirectory, fileName), "utf8");
      rows.push(
        ...(parseCsv(csv, {
          bom: true,
          columns: true,
          skip_empty_lines: true
        }) as Array<Record<string, string>>)
      );
    }
    const aggregate = {
      row_count: rows.length,
      gross_sales: rows.reduce((sum, row) => sum + Number(row["菜品销售额"] ?? 0), 0)
    };
    if (aggregate.row_count !== 3 || aggregate.gross_sales !== 91) {
      throw new Error(
        `Unexpected local partition aggregate: ${JSON.stringify(redactObject(aggregate))}`
      );
    }
    const topNames = [...rows]
      .sort((left, right) => Number(right["菜品销售额"]) - Number(left["菜品销售额"]))
      .slice(0, 2)
      .map((row) => row["菜品名称"]);
    if (topNames[0] !== "合成凉皮" || topNames[1] !== "合成肉夹馍") {
      throw new Error(`Unexpected local top dishes: ${JSON.stringify(topNames)}`);
    }

    const invalidFile = await writeRunInvalidStructuredFixture(run, structuredWindow);
    const invalidImport = await callJson<PartitionUploadResult>(
      client,
      "upload_structured_dataset",
      {
        file: {
          name: path.basename(invalidFile),
          mediaType: "text/csv",
          encoding: "path",
          filePath: invalidFile
        },
        dataset: "dishes",
        enterpriseName: run.enterpriseName,
        startDate: structuredWindow.invalidCompact,
        endDate: structuredWindow.invalidCompact,
        idempotencyKey: `official-manual-acceptance:${run.runId}:dishes-invalid-atomic`
      }
    );
    const invalidCompletion = await pollPartitionImportStatus(
      client,
      invalidImport.partitionImportJobId
    );
    if (invalidCompletion.status !== "rejected" || !invalidCompletion.error?.code) {
      throw new Error(
        "Expected invalid partition source to be rejected atomically with a safe error."
      );
    }

    return {
      ok: true,
      runId: run.runId,
      serviceOrigin: SERVICE_ORIGIN,
      launcherVersion: LAUNCHER_VERSION,
      currentUserVerified: true,
      account: "admin",
      clearance: 0,
      coverage:
        "admin-positive-smoke; full three-account acceptance uses separate visible scenario tasks",
      deliveryImportBatchId: deliveryUpload.importBatch.importBatchId,
      defaultConfidentialityLevel: 0,
      explicitConfidentialityLevel: 2,
      evidenceDocuments: [
        defaultEvidenceUpload.document.documentId,
        explicitLevelEvidenceUpload.document.documentId
      ],
      partitionImportJob: structuredUpload.partitionImportJobId,
      structuredWindow: {
        startDate: structuredWindow.startDate,
        endDate: structuredWindow.endDate
      },
      aggregate: redactObject(aggregate),
      topDishes: topNames
    };
  } finally {
    await Promise.all(
      localExtracts.map((directory) => rm(directory, { recursive: true, force: true }))
    );
    await client.close().catch(() => undefined);
  }
}

async function uploadEvidenceFixtures(
  client: Client,
  run: ReturnType<typeof runConfig>
): Promise<[EvidenceUploadResult, EvidenceUploadResult]> {
  const [defaultLevelUpload, explicitLevelUpload] = await Promise.all([
    callJson<EvidenceUploadResult>(client, "upload_evidence_document", {
      file: {
        name: "baoli-roujiamo-sop.md",
        mediaType: "text/markdown",
        encoding: "base64",
        contentBase64: await fileBase64("fixtures/manual-acceptance/evidence/baoli-roujiamo-sop.md")
      },
      title: `${run.titlePrefix} Baoli Roujiamo SOP`,
      sourceSystem: run.evidenceSourceSystem
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
      confidentialityLevel: 2
    })
  ]);

  return [defaultLevelUpload, explicitLevelUpload];
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

async function pollPartitionImportStatus(
  client: Client,
  partitionImportJobId: string
): Promise<PartitionUploadResult> {
  const deadline = Date.now() + 10 * 60_000;
  let latest: PartitionUploadResult | null = null;
  while (Date.now() < deadline) {
    latest = await callJson<PartitionUploadResult>(client, "get_partition_import_status", {
      partitionImportJobId
    });
    if (["published", "rejected", "failed", "cancelled", "expired"].includes(latest.status)) {
      return latest;
    }
    await new Promise((resolve) => setTimeout(resolve, 3_000));
  }
  throw new Error(
    `Partition import ${partitionImportJobId} did not finish; latest=${JSON.stringify(redactObject(latest ?? {}))}.`
  );
}

async function callJson<T>(
  client: Client,
  name: string,
  args: Record<string, unknown>
): Promise<T> {
  const result = await client.callTool({ name, arguments: args }, undefined, {
    timeout: name === "upload_structured_dataset" ? 30 * 60_000 : 60_000
  });
  const content = result.content as Array<{ type: string; text?: string }> | undefined;
  const text = content?.[0]?.type === "text" ? (content[0].text ?? "") : "";
  if (!text) {
    throw new Error(`${name} returned no text content.`);
  }
  const parsed = JSON.parse(text) as T & { isError?: boolean; error?: unknown };
  if (result.isError) {
    throw new Error(`${name} failed: ${JSON.stringify(redactObject(parsed))}`);
  }
  return { ...parsed, isError: Boolean(result.isError) } as T;
}

async function cleanupRun(prisma: PrismaClient, run: ReturnType<typeof runConfig>): Promise<void> {
  const identities = await prisma.loginIdentity.findMany({
    where: {
      normalizedEmail: {
        in: acceptanceAccountEmails(run.runId)
      }
    },
    select: { employeeId: true }
  });
  const uploaderEmployeeIds = identities.map((identity) => identity.employeeId);
  const partitionJobs = await prisma.partitionImportJob.findMany({
    where: { uploaderId: { in: uploaderEmployeeIds } },
    select: { id: true, temporaryObjectKey: true }
  });
  const partitionJobIds = partitionJobs.map((job) => job.id);
  const partitions = await prisma.structuredPartition.findMany({
    where: { publishedByJobId: { in: partitionJobIds } },
    select: { objectKey: true }
  });
  const documentFilters = officialManualDocumentFilters(run, uploaderEmployeeIds);
  const documents = await prisma.document.findMany({
    where: { OR: documentFilters },
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
  const storageObjectKeys = [
    ...documents.map((document) => document.storageObjectKey),
    ...partitionJobs
      .map((job) => job.temporaryObjectKey)
      .filter((key): key is string => Boolean(key)),
    ...partitions.map((partition) => partition.objectKey)
  ];
  await deleteStorageObjects(storage, storageObjectKeys);

  const documentIds = documents.map((document) => document.id);
  const importBatchIds = documents
    .map((document) => document.importBatch?.id)
    .filter((id): id is string => Boolean(id));

  await prisma.$transaction(async (tx) => {
    if (partitionJobIds.length > 0) {
      await tx.processingRun.deleteMany({
        where: { partitionImportJobId: { in: partitionJobIds } }
      });
      await tx.structuredPartition.deleteMany({
        where: { publishedByJobId: { in: partitionJobIds } }
      });
      await tx.storageGarbage.deleteMany({
        where: { objectKey: { in: storageObjectKeys } }
      });
      await tx.partitionImportJob.deleteMany({ where: { id: { in: partitionJobIds } } });
    }
    if (importBatchIds.length > 0) {
      await tx.vipRow.deleteMany({ where: { importBatchId: { in: importBatchIds } } });
      await tx.dishCatalogRow.deleteMany({ where: { importBatchId: { in: importBatchIds } } });
      await tx.deliveryLedgerRow.deleteMany({ where: { importBatchId: { in: importBatchIds } } });
      await tx.supplierCatalogRow.deleteMany({
        where: { importBatchId: { in: importBatchIds } }
      });
      await tx.importWindowClaim.deleteMany({ where: { importBatchId: { in: importBatchIds } } });
      await tx.importBatch.deleteMany({ where: { id: { in: importBatchIds } } });
    }
    if (documentIds.length > 0) {
      await tx.quarantineCertificate.deleteMany({
        where: { sourceDocumentId: { in: documentIds } }
      });
    }
    await tx.document.deleteMany({ where: { id: { in: documentIds } } });
  });

  await verifyCleanup(prisma, run, {
    documentIds,
    importBatchIds,
    partitionJobIds,
    qdrantPointIds,
    storageObjectKeys,
    uploaderEmployeeIds
  });
}

function officialManualDocumentFilters(
  run: ReturnType<typeof runConfig>,
  uploaderEmployeeIds: string[]
) {
  return [
    { sourceSystem: run.evidenceSourceSystem },
    { title: { startsWith: `${run.enterpriseName}_` } },
    { title: { startsWith: run.titlePrefix } },
    ...(uploaderEmployeeIds.length > 0 ? [{ uploaderId: { in: uploaderEmployeeIds } }] : [])
  ];
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
    partitionJobIds: string[];
    qdrantPointIds: string[];
    storageObjectKeys: string[];
    uploaderEmployeeIds: string[];
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

  const [
    documents,
    importBatches,
    partitionImportJobs,
    structuredPartitions,
    storageGarbage,
    vipRows,
    dishCatalogRows,
    deliveryLedgerRows,
    supplierCatalogRows,
    quarantineCertificates,
    windowClaims,
    qdrantPoints
  ] = await Promise.all([
    prisma.document.count({
      where: { OR: officialManualDocumentFilters(run, deleted.uploaderEmployeeIds) }
    }),
    countByIds(deleted.importBatchIds, (ids) =>
      prisma.importBatch.count({ where: { id: { in: ids } } })
    ),
    countByIds(deleted.partitionJobIds, (ids) =>
      prisma.partitionImportJob.count({ where: { id: { in: ids } } })
    ),
    countByIds(deleted.partitionJobIds, (ids) =>
      prisma.structuredPartition.count({ where: { publishedByJobId: { in: ids } } })
    ),
    countByIds(deleted.storageObjectKeys, (keys) =>
      prisma.storageGarbage.count({ where: { objectKey: { in: keys } } })
    ),
    countByIds(deleted.importBatchIds, (ids) =>
      prisma.vipRow.count({ where: { importBatchId: { in: ids } } })
    ),
    countByIds(deleted.importBatchIds, (ids) =>
      prisma.dishCatalogRow.count({ where: { importBatchId: { in: ids } } })
    ),
    countByIds(deleted.importBatchIds, (ids) =>
      prisma.deliveryLedgerRow.count({ where: { importBatchId: { in: ids } } })
    ),
    countByIds(deleted.importBatchIds, (ids) =>
      prisma.supplierCatalogRow.count({ where: { importBatchId: { in: ids } } })
    ),
    countByIds(deleted.documentIds, (ids) =>
      prisma.quarantineCertificate.count({ where: { sourceDocumentId: { in: ids } } })
    ),
    countByIds(deleted.importBatchIds, (ids) =>
      prisma.importWindowClaim.count({ where: { importBatchId: { in: ids } } })
    ),
    retrieveQdrantPointCount(deleted.qdrantPointIds)
  ]);

  const counts: CleanupCounts = {
    documents,
    importBatches,
    partitionImportJobs,
    structuredPartitions,
    storageGarbage,
    vipRows,
    dishCatalogRows,
    deliveryLedgerRows,
    supplierCatalogRows,
    quarantineCertificates,
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
    "Library/Application Support/SMEDC/launcher/versions",
    LAUNCHER_VERSION,
    "node_modules/.bin/smedc-mcp-launcher"
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
