import { readdir, rm, stat } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { config as loadDotenv } from "dotenv";

interface PurgeOptions {
  all: boolean;
  dryRun: boolean;
  cwd: string;
  env: NodeJS.ProcessEnv;
}

interface PurgeTarget {
  label: string;
  path: string;
}

loadDotenv({ quiet: true, override: false });

export async function purgeLocalData(options: PurgeOptions): Promise<PurgeTarget[]> {
  const targets = resolvePurgeTargets(options);

  for (const target of targets) {
    if (options.dryRun) {
      continue;
    }

    await rm(target.path, { recursive: true, force: true });
  }

  await removeEmptyDataDirectory(options.cwd, options.dryRun);

  return targets;
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

function parseArgs(argv: string[]): Pick<PurgeOptions, "all" | "dryRun"> {
  return {
    all: argv.includes("--all"),
    dryRun: argv.includes("--dry-run")
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

  const targets = await purgeLocalData(options);
  const action = options.dryRun ? "Would remove" : "Removed";

  for (const target of targets) {
    console.log(`${action} ${target.label}: ${target.path}`);
  }

  if (targets.length === 0) {
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
