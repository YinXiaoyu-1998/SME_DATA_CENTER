import { pathToFileURL } from "node:url";
import { config as loadDotenv } from "dotenv";
import { PrismaClient } from "@prisma/client";
import { createDatabaseAdapter } from "@smedc/db";
import { parseRuntimeReadinessConfig } from "@smedc/domain";
import {
  assertReindexTargetMatchesRuntime,
  buildEvidenceReindexPlan
} from "./reindex-evidence-support.js";

interface ReindexArguments {
  targetRetrievalConfigVersion: string;
  targetCollection: string;
  execute: boolean;
  allowRemote: boolean;
}

export async function main(argv = process.argv.slice(2)): Promise<void> {
  loadDotenv({ quiet: true, override: false });
  const args = parseArguments(argv);
  const databaseUrl = process.env["DATABASE_URL"];
  if (!databaseUrl) throw new Error("DATABASE_URL is required.");
  assertLocalDatabase(databaseUrl, args.allowRemote);

  if (args.execute) {
    const runtime = parseRuntimeReadinessConfig(process.env);
    assertReindexTargetMatchesRuntime({
      targetRetrievalConfigVersion: args.targetRetrievalConfigVersion,
      targetCollection: args.targetCollection,
      runtimeRetrievalConfigVersion: runtime.qdrant.retrievalConfigVersion,
      runtimeCollection: runtime.qdrant.collectionName
    });
  }

  const prisma = new PrismaClient({ adapter: createDatabaseAdapter(databaseUrl) });
  try {
    const documents = await prisma.document.findMany({
      where: { documentKind: "evidence" },
      select: {
        id: true,
        orgId: true,
        contentVersion: true,
        status: true,
        documentKind: true,
        archivedAt: true
      },
      orderBy: [{ orgId: "asc" }, { id: "asc" }]
    });
    const existingTargetIndexes = await prisma.documentIndex.findMany({
      where: {
        retrievalConfig: { version: args.targetRetrievalConfigVersion }
      },
      select: {
        documentId: true,
        contentVersion: true,
        retrievalConfig: { select: { version: true } }
      }
    });
    const plan = buildEvidenceReindexPlan({
      documents,
      existingTargetIndexes: existingTargetIndexes.map((index) => ({
        documentId: index.documentId,
        contentVersion: index.contentVersion,
        retrievalConfigVersion: index.retrievalConfig.version
      })),
      targetRetrievalConfigVersion: args.targetRetrievalConfigVersion,
      targetCollection: args.targetCollection
    });

    let createdJobCount = 0;
    if (args.execute && plan.jobs.length > 0) {
      const created = await prisma.processingRun.createMany({
        data: plan.jobs.map((job) => ({
          orgId: job.orgId,
          documentId: job.documentId,
          jobKey: job.jobKey,
          status: "queued",
          jobType: "evidence_document_index",
          attemptNumber: 0,
          retryCount: 0,
          availableAt: new Date()
        })),
        skipDuplicates: true
      });
      createdJobCount = created.count;
    }

    console.log(
      JSON.stringify(
        {
          mode: args.execute ? "execute" : "dry-run",
          targetRetrievalConfigVersion: args.targetRetrievalConfigVersion,
          targetCollection: args.targetCollection,
          eligibleDocumentCount: plan.eligibleDocumentCount,
          excludedDocumentCount: plan.excludedDocumentCount,
          existingTargetIndexCount: plan.existingTargetIndexCount,
          plannedJobCount: plan.jobs.length,
          createdJobCount
        },
        null,
        2
      )
    );
  } finally {
    await prisma.$disconnect();
  }
}

function parseArguments(argv: readonly string[]): ReindexArguments {
  if (argv.includes("--help")) {
    console.log(`Usage: npm run evidence:reindex -- --target-config <version> --target-collection <name> [--dry-run|--execute] [--allow-remote]

The default mode is --dry-run. Controlled cutover order:
1. Create and validate the V2 collection.
2. Quiesce ordinary evidence workers and uploads.
3. Run --execute with worker runtime configured to the same target version and collection.
4. Run only that V2 worker until every target index is ready.
5. Run the fixture smoke, then switch API and worker runtime to V2.
6. Retain the V1 collection and environment values for rollback.`);
    process.exitCode = 0;
    throw new HelpRequested();
  }
  const targetRetrievalConfigVersion = argumentValue(argv, "--target-config");
  const targetCollection = argumentValue(argv, "--target-collection");
  const execute = argv.includes("--execute");
  if (execute && argv.includes("--dry-run")) {
    throw new Error("Choose either --dry-run or --execute, not both.");
  }
  return {
    targetRetrievalConfigVersion,
    targetCollection,
    execute,
    allowRemote: argv.includes("--allow-remote")
  };
}

function argumentValue(argv: readonly string[], flag: string): string {
  const index = argv.indexOf(flag);
  const value = index >= 0 ? argv[index + 1]?.trim() : "";
  if (!value) throw new Error(`${flag} is required.`);
  return value;
}

function assertLocalDatabase(databaseUrl: string, allowRemote: boolean): void {
  const hostname = new URL(databaseUrl).hostname;
  if (!allowRemote && hostname !== "localhost" && hostname !== "127.0.0.1") {
    throw new Error("Evidence reindex refuses a non-local database without --allow-remote.");
  }
}

class HelpRequested extends Error {}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error: unknown) => {
    if (error instanceof HelpRequested) return;
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
