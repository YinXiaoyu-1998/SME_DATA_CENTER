import { open, readFile, rename, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  parsePdfRuntimeState,
  transitionPdfRuntimeState,
  type PdfRuntimeState,
  type PdfReleaseBundle
} from "./pdf-runtime-state.js";
export {
  createDeploymentPdfRollbackFloorVerifier,
  parsePdfRuntimeState,
  transitionPdfRuntimeState,
  verifyPdfRuntimeState,
  type PdfRuntimeState,
  type PdfReleaseBundle
} from "./pdf-runtime-state.js";
async function atomicJson(path: string, value: unknown, mode = 0o644): Promise<void> {
  const temporary = `${path}.${process.pid}.next`;
  const handle = await open(temporary, "w", mode);
  try {
    await handle.writeFile(JSON.stringify(value));
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(temporary, path);
  const directory = await open(dirname(path), "r");
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
}
async function loadState(path: string): Promise<PdfRuntimeState | null> {
  try {
    return parsePdfRuntimeState(JSON.parse(await readFile(path, "utf8")));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}
export interface ParkedPdfRun {
  id: string;
  orgId: string;
  documentId: string | null;
  attemptNumber: number;
  availableAt: string;
}
export const PDF_PARKED_AT = new Date("9999-01-01T00:00:00.000Z");
// Exact compare-and-set ownership; no retry or lease rewrite. Manifest is write-ahead.
export function parkedRunWhere(run: ParkedPdfRun, restoring: boolean) {
  return {
    id: run.id,
    orgId: run.orgId,
    documentId: run.documentId,
    attemptNumber: run.attemptNumber,
    jobType: "evidence_document_index" as const,
    status: {
      in: ["queued", "running", "retry_scheduled"] as ("queued" | "running" | "retry_scheduled")[]
    },
    availableAt: restoring ? PDF_PARKED_AT : new Date(run.availableAt),
    document: { fileType: "pdf" as const }
  };
}
async function schedulePdfRuns(command: "park" | "restore", directory: string): Promise<void> {
  const [{ PrismaClient }, { PrismaMariaDb }] = await Promise.all([
    import("@prisma/client"),
    import("@prisma/adapter-mariadb")
  ]);
  const prisma = new PrismaClient({
    adapter: new PrismaMariaDb(process.env["DATABASE_URL"] ?? "")
  });
  const manifest = join(directory, "parked-runs.json");
  try {
    let runs: ParkedPdfRun[];
    if (command === "park") {
      let existing: ParkedPdfRun[] = [];
      try {
        const value = JSON.parse(await readFile(manifest, "utf8")) as {
          schemaVersion: number;
          runs: ParkedPdfRun[];
        };
        if (value.schemaVersion !== 1 || !Array.isArray(value.runs))
          throw new Error("Invalid parking manifest.");
        existing = value.runs;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      const fresh = (
        await prisma.processingRun.findMany({
          where: {
            document: { fileType: "pdf" },
            jobType: "evidence_document_index",
            status: { in: ["queued", "running", "retry_scheduled"] },
            availableAt: { not: PDF_PARKED_AT }
          },
          select: {
            id: true,
            orgId: true,
            documentId: true,
            attemptNumber: true,
            availableAt: true
          }
        })
      ).map((run) => ({ ...run, availableAt: run.availableAt.toISOString() }));
      const retained = new Set(existing.map((run) => run.id));
      runs = [...existing, ...fresh.filter((run) => !retained.has(run.id))];
      await atomicJson(manifest, { schemaVersion: 1, runs }, 0o600);
    } else {
      try {
        const value = JSON.parse(await readFile(manifest, "utf8")) as {
          schemaVersion: number;
          runs: ParkedPdfRun[];
        };
        if (value.schemaVersion !== 1 || !Array.isArray(value.runs))
          throw new Error("Invalid parking manifest.");
        runs = value.runs;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
        throw error;
      }
    }
    const unresolved = await prisma.$transaction(async (tx) => {
      const retained: ParkedPdfRun[] = [];
      for (const run of runs) {
        const changed = await tx.processingRun.updateMany({
          where: parkedRunWhere(run, command === "restore"),
          data: { availableAt: command === "park" ? PDF_PARKED_AT : new Date(run.availableAt) }
        });
        if (command === "restore" && changed.count === 0) {
          const current = await tx.processingRun.findUnique({
            where: { id: run.id },
            select: { availableAt: true, status: true }
          });
          if (
            current?.availableAt.getTime() === PDF_PARKED_AT.getTime() &&
            ["queued", "running", "retry_scheduled"].includes(current.status)
          )
            retained.push(run);
        }
      }
      return retained;
    });
    if (command === "restore") {
      if (unresolved.length) {
        await atomicJson(manifest, { schemaVersion: 1, runs: unresolved }, 0o600);
        throw new Error("PDF parked run ownership changed; recovery required.");
      }
      await unlink(manifest);
    }
  } finally {
    await prisma.$disconnect();
  }
}
async function main(): Promise<void> {
  const [command, path, currentJson, rollbackJson] = process.argv.slice(2);
  if (!path) throw new Error("PDF release state path required.");
  if (command === "transition" || command === "validate") {
    const next = transitionPdfRuntimeState(
      await loadState(path),
      JSON.parse(currentJson ?? "") as PdfReleaseBundle,
      JSON.parse(rollbackJson ?? "") as PdfReleaseBundle
    );
    if (command === "transition") await atomicJson(path, next);
  } else if (command === "check") {
    const state = await loadState(path);
    if (!state) throw new Error("PDF runtime state missing; rollback refused.");
    const target = JSON.parse(currentJson ?? "") as PdfReleaseBundle;
    transitionPdfRuntimeState(state, target, target);
  } else if (command === "park" || command === "restore") await schedulePdfRuns(command, path);
  else throw new Error("Unsupported PDF release command.");
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : "PDF release operation failed.");
    process.exitCode = 1;
  });
