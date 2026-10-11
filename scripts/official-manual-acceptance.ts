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
import {
  ledgerPartitionsFromRows,
  ledgerStoreNameHash,
  createPrismaLedgerSourceReader
} from "@smedc/ledger-archive";
import { parseApiRetrievalRuntimeConfig } from "../apps/api/src/config/retrieval-runtime.js";
import {
  assertCleanupCountsAreZero,
  assertStagingRuntimeDatabaseTarget,
  createStructuredWindow,
  deleteStorageObjects,
  isAcceptanceAccount,
  isReusedAcceptanceAccount,
  validateAcceptanceScope,
  acceptanceAccountEmails,
  pollStructuredImportStatus,
  rewriteKnownValuesFixture,
  type CleanupCounts,
  type AcceptanceScope,
  type CurrentEnterpriseHubUserResult,
  type StructuredWindow
} from "./official-manual-acceptance-support.js";
import {
  runStagingController,
  type RemoteWindowResult
} from "./official-manual-remote-controller.js";

loadDotenv({ quiet: true, override: false });

const SERVICE_ORIGIN = "https://api.smedatacenter.xyz";
const LAUNCHER_VERSION = "0.9.0";
const RUN_ROOT = path.join(process.cwd(), ".data", "official-manual-acceptance");

interface ParsedArgs extends AcceptanceScope {
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
  const run = runConfig(args.runId, args);
  await removeStaleReport(run);
  await runStagingController("cleanup", run.runId, args);
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

  const windowResult = await runStagingController<RemoteWindowResult>("window", run.runId, args);
  let outcome: Record<string, unknown>;
  let cleanupVerified = false;
  try {
    outcome = await runAcceptance(run, windowResult.structuredWindow);
  } finally {
    if (!args.keepData) {
      await runStagingController("cleanup", run.runId, args);
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

  const run = runConfig(args.runId, args);
  const prisma = new PrismaClient({ adapter: new PrismaMariaDb(databaseUrl) });
  try {
    if (run.reuseSession) {
      const employee = await prisma.employee.findUnique({
        where: { email: run.reuseSession },
        select: { id: true, orgId: true, role: true, disabled: true }
      });
      if (!employee || employee.role !== "admin" || employee.disabled)
        throw new Error("Existing-session acceptance requires the selected active admin.");
      run.reusedEmployeeId = employee.id;
      run.orgId = employee.orgId;
    }
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
    const structuredWindow = await selectAvailableStructuredWindow(prisma, run.runId, run.orgId);
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
    const acceptedAccount = run.reuseSession
      ? isReusedAcceptanceAccount(currentUser, run.reuseSession)
      : isAcceptanceAccount(currentUser, run.runId, "admin");
    if (!acceptedAccount) {
      throw new Error("Positive upload smoke requires this run's synthetic admin at clearance 0.");
    }

    // Confirm the current dataset contract before any structured tool call.
    await callJson(client, "list_structured_datasets", {});

    const [defaultEvidenceUpload, explicitLevelEvidenceUpload] = await uploadEvidenceFixtures(
      client,
      run
    );
    const deliveryFile = await writeRunDeliveryFixture(run);
    const deliveryUpload = await callJson<{
      importBatch: { importBatchId: string; status: string };
    }>(client, "upload_structured_dataset", {
      file: {
        name: path.basename(deliveryFile),
        mediaType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        encoding: "path",
        filePath: deliveryFile
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
    const deliverySummary = await callJson<{ rows: Array<Record<string, unknown>> }>(
      client,
      "query_structured_dataset",
      {
        dataset: "delivery_ledger",
        filter: { field: "store_name", op: "eq", value: run.enterpriseName },
        aggregates: [
          { op: "count", as: "rows" },
          { op: "sum", field: "purchase_amount", as: "amount" }
        ]
      }
    );
    if (
      Number(deliverySummary.rows[0]?.["rows"]) !== 2 ||
      Number(deliverySummary.rows[0]?.["amount"]) !== 42.5
    )
      throw new Error("Delivery ledger aggregate did not match the run receipt.");
    await waitForEvidenceReady(client, defaultEvidenceUpload.document.documentId);
    if (currentUser.user.clearance >= 2)
      await waitForEvidenceReady(client, explicitLevelEvidenceUpload.document.documentId);

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
    const partitionContents: string[] = [];
    for (const fileName of downloaded.files) {
      const csv = await readFile(path.join(downloaded.localDirectory, fileName), "utf8");
      partitionContents.push(csv);
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
    const afterRejection = await callJson<PartitionDownloadResult>(
      client,
      "download_structured_partitions",
      {
        dataset: "dishes",
        enterpriseName: run.enterpriseName,
        startDate: structuredWindow.startCompact,
        endDate: structuredWindow.endCompact
      }
    );
    localExtracts.push(afterRejection.localDirectory);
    const afterContents = await Promise.all(
      afterRejection.files.map((file) =>
        readFile(path.join(afterRejection.localDirectory, file), "utf8")
      )
    );
    if (JSON.stringify(partitionContents.sort()) !== JSON.stringify(afterContents.sort()))
      throw new Error("Rejected import changed previously published partitions.");

    return {
      ok: true,
      runId: run.runId,
      serviceOrigin: SERVICE_ORIGIN,
      launcherVersion: LAUNCHER_VERSION,
      currentUserVerified: true,
      account: "admin",
      clearance: currentUser.user.clearance,
      coverage: run.reuseSession
        ? "existing-session business smoke; identity-switch and auth cases excluded"
        : "admin-positive-smoke; full three-account acceptance uses separate visible scenario tasks",
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
      publishedPartitionsUnchangedAfterRejection: true,
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

export async function cleanupRun(
  prisma: PrismaClient,
  run: ReturnType<typeof runConfig>
): Promise<void> {
  const identities = await prisma.loginIdentity.findMany({
    where: {
      orgId: run.orgId,
      normalizedEmail: {
        in: acceptanceAccountEmails(run.runId)
      }
    },
    select: { employeeId: true }
  });
  const uploaderEmployeeIds = identities.map((identity) => identity.employeeId);
  // The reused employee is deliberately never added to this uploader-wide selector.
  if (run.reusedEmployeeId) {
    const foreignDocuments = await prisma.document.count({
      where: {
        id: { in: run.documentIds },
        NOT: { uploaderId: run.reusedEmployeeId, orgId: run.orgId }
      }
    });
    const foreignJobs = await prisma.partitionImportJob.count({
      where: {
        id: { in: run.partitionJobIds },
        NOT: { uploaderId: run.reusedEmployeeId, orgId: run.orgId }
      }
    });
    const foreignRequests = await prisma.ledgerArtifactRequest.count({
      where: {
        id: { in: run.ledgerRequestIds },
        NOT: { actorEmployeeId: run.reusedEmployeeId, orgId: run.orgId, kind: "download" }
      }
    });
    if (foreignDocuments || foreignJobs || foreignRequests)
      throw new Error("Cleanup IDs do not belong to the selected QA account.");
  }
  const partitionJobs = await prisma.partitionImportJob.findMany({
    where: {
      orgId: run.orgId,
      OR: [
        { uploaderId: { in: uploaderEmployeeIds } },
        { enterpriseName: run.enterpriseName },
        { id: { in: run.partitionJobIds } }
      ]
    },
    select: { id: true, temporaryObjectKey: true }
  });
  const partitionJobIds = partitionJobs.map((job) => job.id);
  const partitions = await prisma.structuredPartition.findMany({
    where: { publishedByJobId: { in: partitionJobIds } },
    select: { objectKey: true }
  });
  const documentFilters = officialManualDocumentFilters(run, uploaderEmployeeIds);
  const documents = await prisma.document.findMany({
    where: { orgId: run.orgId, OR: documentFilters },
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

  // Archive cleanup stays within the run's synthetic documents and employees.
  // Refuse a shared derived partition/request rather than deleting another run's data.
  const ownedDocumentIds = documents.map((document) => document.id);
  const receiptRows = await prisma.deliveryLedgerRow.findMany({
    where: { sourceDocumentId: { in: ownedDocumentIds } },
    select: { orgId: true, payload: true }
  });
  const receiptKeys = receiptRows.flatMap((row) =>
    ledgerPartitionsFromRows(row.orgId, [{ payload: row.payload as Record<string, unknown> }])
  );
  const ledgerPartitions = await prisma.ledgerPdfPartition.findMany({
    where: {
      OR: [
        { sources: { some: { sourceDocumentId: { in: ownedDocumentIds } } } },
        ...receiptKeys.map((key) => ({
          orgId: key.orgId,
          storeNameHash: ledgerStoreNameHash(key.storeName),
          purchaseDate: new Date(`${key.purchaseDate}T00:00:00Z`)
        }))
      ]
    },
    include: { sources: { select: { sourceDocumentId: true } } }
  });
  const ownedIds = new Set(ownedDocumentIds);
  if (
    ledgerPartitions.some((partition) =>
      partition.sources.some((source) => !ownedIds.has(source.sourceDocumentId))
    )
  )
    throw new Error("Official cleanup refuses a shared ledger PDF partition");
  const sourceReader = createPrismaLedgerSourceReader({ prisma });
  for (const partition of ledgerPartitions) {
    const metadata = await sourceReader.readLedgerSourceMetadata({
      orgId: partition.orgId,
      storeName: partition.storeName,
      purchaseDate: partition.purchaseDate.toISOString().slice(0, 10)
    });
    if (metadata.sources.some((source) => !ownedIds.has(source.sourceDocumentId)))
      throw new Error("Official cleanup refuses shared ledger source facts");
  }
  const ledgerPartitionIds = ledgerPartitions.map((partition) => partition.id);
  const ledgerRequests = await prisma.ledgerArtifactRequest.findMany({
    where: {
      orgId: run.orgId,
      OR: [
        { actorEmployeeId: { in: uploaderEmployeeIds } },
        { id: { in: run.ledgerRequestIds } },
        { items: { some: { partitionId: { in: ledgerPartitionIds } } } }
      ]
    },
    include: { items: { select: { id: true, partitionId: true } } }
  });
  const partitionIds = new Set(ledgerPartitionIds);
  if (
    ledgerRequests.some(
      (request) =>
        !run.ledgerRequestIds.includes(request.id) &&
        request.items.some((item) => !partitionIds.has(item.partitionId))
    )
  )
    throw new Error("Official cleanup refuses a shared ledger PDF request");
  const ledgerRequestIds = ledgerRequests.map((request) => request.id);
  const ledgerItemIds = ledgerRequests.flatMap((request) => request.items.map((item) => item.id));
  const ledgerTargets = await prisma.ledgerPdfReconciliationTarget.findMany({
    where: { requestItemId: { in: ledgerItemIds } },
    select: { reconciliationRunId: true }
  });
  const reconciliationIds = [
    ...new Set([
      ...ledgerTargets.map((target) => target.reconciliationRunId),
      ...ledgerRequests.flatMap((request) =>
        request.reconciliationRunId ? [request.reconciliationRunId] : []
      )
    ])
  ];
  const ledgerJobs = await prisma.processingRun.findMany({
    where: {
      OR: [
        { ledgerArtifactRequestId: { in: ledgerRequestIds } },
        { ledgerArtifactRequestItemId: { in: ledgerItemIds } }
      ]
    },
    select: { id: true }
  });
  if (
    await prisma.processingRun.count({
      where: {
        OR: [
          { id: { in: ledgerJobs.map((job) => job.id) } },
          { documentId: { in: ownedDocumentIds } },
          { partitionImportJobId: { in: partitionJobIds } }
        ],
        status: { in: ["queued", "running", "retry_scheduled"] }
      }
    })
  )
    throw new Error("Official cleanup refuses active processing jobs");
  const ledgerGarbage = await prisma.storageGarbage.findMany({
    where: {
      processingRun: {
        OR: [
          { id: { in: ledgerJobs.map((job) => job.id) } },
          { partitionImportJobId: { in: partitionJobIds } }
        ]
      }
    },
    select: { objectKey: true }
  });
  const storage = createStorageAdapter(process.env);
  const storageObjectKeys = [
    ...ledgerPartitions.flatMap((partition) =>
      partition.currentObjectKey ? [partition.currentObjectKey] : []
    ),
    ...ledgerRequests.flatMap((request) => (request.zipObjectKey ? [request.zipObjectKey] : [])),
    ...ledgerGarbage.map((garbage) => garbage.objectKey),
    ...documents.map((document) => document.storageObjectKey),
    ...partitionJobs
      .map((job) => job.temporaryObjectKey)
      .filter((key): key is string => Boolean(key)),
    ...partitions.map((partition) => partition.objectKey)
  ];
  await deleteQdrantPoints(qdrantPointIds);
  await deleteStorageObjects(storage, [...new Set(storageObjectKeys)]);

  const documentIds = documents.map((document) => document.id);
  const importBatchIds = documents
    .map((document) => document.importBatch?.id)
    .filter((id): id is string => Boolean(id));

  await prisma.$transaction(async (tx) => {
    await tx.storageGarbage.deleteMany({ where: { objectKey: { in: storageObjectKeys } } });
    await tx.processingRun.deleteMany({ where: { id: { in: ledgerJobs.map((job) => job.id) } } });
    await tx.ledgerPdfReconciliationTarget.deleteMany({
      where: { requestItemId: { in: ledgerItemIds } }
    });
    await tx.ledgerArtifactRequestItem.deleteMany({ where: { id: { in: ledgerItemIds } } });
    await tx.ledgerArtifactRequest.updateMany({
      where: { id: { in: ledgerRequestIds } },
      data: { retryOfRequestId: null }
    });
    await tx.ledgerArtifactRequest.deleteMany({ where: { id: { in: ledgerRequestIds } } });
    await tx.ledgerPdfSource.deleteMany({ where: { partitionId: { in: ledgerPartitionIds } } });
    await tx.ledgerPdfPartition.deleteMany({ where: { id: { in: ledgerPartitionIds } } });
    const emptyReconciliations = await tx.ledgerPdfReconciliationRun.findMany({
      where: { id: { in: reconciliationIds }, requests: { none: {} }, targets: { none: {} } },
      select: { id: true }
    });
    const emptyIds = emptyReconciliations.map((run) => run.id);
    await tx.processingRun.deleteMany({
      where: { ledgerPdfReconciliationRunId: { in: emptyIds } }
    });
    await tx.ledgerPdfReconciliationRun.deleteMany({ where: { id: { in: emptyIds } } });
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
  const ledgerResidue = await Promise.all([
    prisma.ledgerArtifactRequest.count({ where: { id: { in: ledgerRequestIds } } }),
    prisma.ledgerPdfPartition.count({ where: { id: { in: ledgerPartitionIds } } }),
    prisma.processingRun.count({ where: { id: { in: ledgerJobs.map((job) => job.id) } } })
  ]);
  if (ledgerResidue.some(Boolean))
    throw new Error("Ledger archive cleanup left run-scoped residue.");
}

function officialManualDocumentFilters(
  run: ReturnType<typeof runConfig>,
  uploaderEmployeeIds: string[]
) {
  return [
    { sourceSystem: run.evidenceSourceSystem },
    { title: { startsWith: `${run.enterpriseName}_` } },
    { title: { startsWith: run.titlePrefix } },
    { id: { in: run.documentIds } },
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
  runId: string,
  orgId: string
): Promise<StructuredWindow> {
  for (let attempt = 0; attempt < 256; attempt += 1) {
    const candidate = createStructuredWindow(runId, attempt);
    const overlap = await prisma.importWindowClaim.findFirst({
      where: {
        orgId,
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
      where: {
        orgId: run.orgId,
        OR: officialManualDocumentFilters(run, deleted.uploaderEmployeeIds)
      }
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

async function writeRunDeliveryFixture(run: ReturnType<typeof runConfig>): Promise<string> {
  // Local fixture preparation only; release-ops does not install the workbook writer.
  const { default: ExcelJS } = await import("exceljs");
  const destination = path.join(RUN_ROOT, run.runId, "receipt.xlsx");
  await mkdir(path.dirname(destination), { recursive: true });
  const workbook = new ExcelJS.Workbook();
  workbook
    .addWorksheet("送货单")
    .addRows([
      ["送货单"],
      ["单据号", `MANUAL-${run.runId.toUpperCase()}`, "订货机构", run.enterpriseName],
      ["送货机构", "合成验收供应商", "收货日期", "2026-10-07"],
      ["序号", "物品名称", "规格型号", "收货数量", "收货金额"],
      [1, "验收青菜", "千克", 2, 12.5],
      [2, "验收大米", "千克", 3, 30],
      ["合计", "", "", 5, 42.5]
    ]);
  await workbook.xlsx.writeFile(destination);
  return destination;
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

export function runConfig(
  runId: string,
  scope: AcceptanceScope = { documentIds: [], partitionJobIds: [] }
) {
  const safeRunId = runId
    .trim()
    .replace(/[^A-Za-z0-9_-]/g, "-")
    .slice(0, 48);
  if (!safeRunId) {
    throw new Error("runId must contain at least one safe character.");
  }
  const compact = safeRunId.replace(/[^A-Za-z0-9]/g, "_");
  return {
    ...scope,
    ledgerRequestIds: scope.ledgerRequestIds ?? [],
    orgId: "default-org",
    reusedEmployeeId: undefined as string | undefined,
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
  const scope: AcceptanceScope = { documentIds: [], partitionJobIds: [] };
  for (const arg of rest) {
    if (arg.startsWith("--reuse-session=")) {
      scope.reuseSession = arg.slice("--reuse-session=".length);
      if (!scope.reuseSession)
        throw new Error("--reuse-session requires the expected account email.");
      continue;
    }
    if (arg.startsWith("--document-id=")) {
      scope.documentIds.push(arg.slice("--document-id=".length));
      continue;
    }
    if (arg.startsWith("--partition-job-id=")) {
      scope.partitionJobIds.push(arg.slice("--partition-job-id=".length));
      continue;
    }
    if (arg.startsWith("--ledger-request-id=")) {
      (scope.ledgerRequestIds ??= []).push(arg.slice("--ledger-request-id=".length));
      continue;
    }
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
  validateAcceptanceScope(scope);
  return { command, runId, keepData, ...scope };
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
