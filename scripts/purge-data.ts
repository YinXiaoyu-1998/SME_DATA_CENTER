import { readdir, rm, stat } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { config as loadDotenv } from "dotenv";
import { PrismaMariaDb } from "@prisma/adapter-mariadb";
import { PrismaClient } from "@prisma/client";

interface PurgeOptions {
  all: boolean;
  dryRun: boolean;
  filesOnly: boolean;
  cwd: string;
  env: NodeJS.ProcessEnv;
}

interface PurgeTarget {
  label: string;
  path: string;
}

interface LocalDatabaseTarget {
  databaseUrl: string;
  host: string;
  databaseName: string;
}

interface DatabasePurgeResult {
  target: LocalDatabaseTarget;
  documentsDeleted: number | null;
  documentAuditLogsDeleted: number | null;
}

interface PurgeResult {
  fileTargets: PurgeTarget[];
  database: DatabasePurgeResult | null;
}

loadDotenv({ quiet: true, override: false });

export async function purgeLocalData(options: PurgeOptions): Promise<PurgeResult> {
  const fileTargets = resolvePurgeTargets(options);
  const database = await purgeLocalDatabase(options);

  for (const target of fileTargets) {
    if (options.dryRun) {
      continue;
    }

    await rm(target.path, { recursive: true, force: true });
  }

  await removeEmptyDataDirectory(options.cwd, options.dryRun);

  return {
    fileTargets,
    database
  };
}

export function resolvePurgeTargets(options: PurgeOptions): PurgeTarget[] {
  const dataRoot = path.resolve(options.cwd, ".data");

  if (options.all) {
    return [{ label: "all local .data files", path: dataRoot }].filter((target) =>
      isInsideDirectory(dataRoot, target.path)
    );
  }

  const localStorageRoot = path.resolve(
    options.cwd,
    options.env["LOCAL_STORAGE_ROOT"] ?? ".data/storage"
  );
  const targets = [
    { label: "local upload storage", path: localStorageRoot },
    { label: "integration test storage", path: path.join(dataRoot, "integration", "storage") },
    { label: "MCP smoke test storage", path: path.join(dataRoot, "mcp-local-test", "storage") }
  ];

  return dedupeTargets(
    targets.filter((target) => {
      if (isInsideDirectory(dataRoot, target.path)) {
        return true;
      }

      process.stderr.write(`Skipping ${target.label}: ${target.path} is outside ${dataRoot}.\n`);
      return false;
    })
  );
}

export function resolveLocalDatabaseTarget(env: NodeJS.ProcessEnv): LocalDatabaseTarget | null {
  const databaseUrl = env["DATABASE_URL"];

  if (!databaseUrl) {
    return null;
  }

  const url = new URL(databaseUrl);
  const databaseName = url.pathname.replace(/^\/+/, "");
  const localHosts = new Set(["localhost", "127.0.0.1", "::1"]);

  if (url.protocol !== "mysql:") {
    throw new Error("purge-data only supports local MySQL DATABASE_URL values.");
  }

  if (!localHosts.has(url.hostname)) {
    throw new Error("purge-data refuses to purge a non-local DATABASE_URL host.");
  }

  if (databaseName !== "enterprise_hub") {
    throw new Error("purge-data refuses to purge a database other than enterprise_hub.");
  }

  return {
    databaseUrl,
    host: url.host,
    databaseName
  };
}

async function purgeLocalDatabase(options: PurgeOptions): Promise<DatabasePurgeResult | null> {
  if (options.filesOnly) {
    return null;
  }

  const target = resolveLocalDatabaseTarget(options.env);

  if (!target) {
    if (options.dryRun) {
      return null;
    }

    throw new Error("DATABASE_URL is required to purge local MySQL document data.");
  }

  if (options.dryRun) {
    return {
      target,
      documentsDeleted: null,
      documentAuditLogsDeleted: null
    };
  }

  const adapter = new PrismaMariaDb(target.databaseUrl);
  const prisma = new PrismaClient({ adapter });

  try {
    const documentAuditLogs = await prisma.auditLog.deleteMany({
      where: {
        OR: [{ targetType: "document" }, { action: { startsWith: "document." } }]
      }
    });
    const documents = await prisma.$transaction(async (tx) => {
      await tx.processingRun.deleteMany({ where: { partitionImportJobId: { not: null } } });
      await tx.structuredPartition.deleteMany({});
      await tx.storageGarbage.deleteMany({});
      await tx.partitionImportJob.deleteMany({});
      await tx.vipRow.deleteMany({});
      await tx.dishCatalogRow.deleteMany({});
      await tx.importWindowClaim.deleteMany({});
      await tx.importBatch.deleteMany({});
      return tx.document.deleteMany({});
    });

    return {
      target,
      documentsDeleted: documents.count,
      documentAuditLogsDeleted: documentAuditLogs.count
    };
  } finally {
    await prisma.$disconnect();
  }
}

function parseArgs(argv: string[]): Pick<PurgeOptions, "all" | "dryRun" | "filesOnly"> {
  return {
    all: argv.includes("--all"),
    dryRun: argv.includes("--dry-run"),
    filesOnly: argv.includes("--files-only")
  };
}

function dedupeTargets(targets: PurgeTarget[]): PurgeTarget[] {
  const seen = new Set<string>();
  const deduped: PurgeTarget[] = [];

  for (const target of targets) {
    if (seen.has(target.path)) {
      continue;
    }

    seen.add(target.path);
    deduped.push(target);
  }

  return deduped;
}

function isInsideDirectory(parent: string, candidate: string): boolean {
  const relative = path.relative(parent, candidate);

  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

async function removeEmptyDataDirectory(cwd: string, dryRun: boolean): Promise<void> {
  if (dryRun) {
    return;
  }

  const dataRoot = path.resolve(cwd, ".data");

  try {
    const dataRootStat = await stat(dataRoot);
    if (!dataRootStat.isDirectory()) {
      return;
    }

    const entries = await readdir(dataRoot);
    if (entries.length === 0) {
      await rm(dataRoot, { recursive: true, force: true });
    }
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return;
    }

    throw error;
  }
}

if (isMainModule()) {
  const options: PurgeOptions = {
    ...parseArgs(process.argv.slice(2)),
    cwd: process.cwd(),
    env: process.env
  };

  const result = await purgeLocalData(options);
  const action = options.dryRun ? "Would remove" : "Removed";

  if (result.database) {
    const dbAction = options.dryRun ? "Would purge" : "Purged";
    const target = `${result.database.target.databaseName} on ${result.database.target.host}`;

    if (options.dryRun) {
      console.log(`${dbAction} local MySQL document data: ${target}`);
    } else {
      console.log(
        `${dbAction} local MySQL document data: ${target} ` +
          `(documents=${result.database.documentsDeleted}, ` +
          `documentAuditLogs=${result.database.documentAuditLogsDeleted})`
      );
    }
  } else if (options.filesOnly) {
    console.log("Skipped local MySQL document data purge because --files-only was provided.");
  } else if (options.dryRun) {
    console.log("Would skip local MySQL document data purge because DATABASE_URL is not set.");
  }

  for (const target of result.fileTargets) {
    console.log(`${action} ${target.label}: ${target.path}`);
  }

  if (result.fileTargets.length === 0 && !result.database) {
    console.log("No local Enterprise Hub data targets found.");
  }
}

function isMainModule(): boolean {
  const entrypoint = process.argv[1];
  if (!entrypoint) {
    return false;
  }

  return import.meta.url === pathToFileURL(entrypoint).href;
}
