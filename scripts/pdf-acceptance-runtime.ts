import { execFile } from "node:child_process";
import { mkdir, open, unlink } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { PrismaMariaDb } from "@prisma/adapter-mariadb";
import { PrismaClient } from "@prisma/client";
import { createStorageAdapter } from "@smedc/storage";
import { parseApiRetrievalRuntimeConfig } from "../apps/api/src/config/retrieval-runtime.js";
import { assertStagingRuntimeDatabaseTarget } from "./official-manual-acceptance-support.js";
import { runPdfStagingController } from "./official-manual-remote-controller.js";
import {
  cleanupPrismaPdfAcceptanceRun,
  createPdfQdrantResources,
  inventoryPdfAcceptanceRun,
  readPdfManifest,
  registerPdfDocument,
  setupPdfAcceptanceRun,
  writePdfManifest
} from "./pdf-acceptance-controller.js";
import {
  assertPdfCredentialProfile,
  assertPdfInventory,
  createPdfAcceptanceManifest,
  validatePdfAcceptanceManifest,
  type PdfAcceptanceArgs,
  type PdfAcceptanceManifest
} from "./pdf-acceptance-support.js";

export function assertLocalPdfTargets(env: NodeJS.ProcessEnv) {
  if (
    env["SMEDC_PDF_ACCEPTANCE_LOCAL"] !== "1" ||
    !env["DATABASE_URL"] ||
    !env["QDRANT_URL"] ||
    env["STORAGE_DRIVER"] !== "local" ||
    !env["LOCAL_STORAGE_ROOT"]?.startsWith("/")
  )
    throw new Error(
      "Local PDF proof requires explicit database, Qdrant and local storage targets."
    );
  for (const target of [env["DATABASE_URL"], env["QDRANT_URL"]])
    if (!["127.0.0.1", "localhost"].includes(new URL(target).hostname))
      throw new Error("Local PDF proof refuses remote targets.");
}
/** The prepare reply contains identifiers/proof only; persist it on the operator host
 * before the ephemeral remote process is allowed to remove authoritative rows. */
export async function runDurablePdfRemoteCommand(
  args: PdfAcceptanceArgs,
  manifest: PdfAcceptanceManifest,
  d: {
    remote: typeof runPdfStagingController;
    save(m: PdfAcceptanceManifest): Promise<void>;
  }
) {
  if (args.command === "cleanup" && !["cleanup", "complete"].includes(manifest.phase)) {
    const prepared = await d.remote(args, manifest, true);
    if (!prepared.ok || prepared.manifest.phase !== "cleanup")
      throw new Error("PDF cleanup preparation failed; deletion not authorized.");
    await d.save(prepared.manifest);
    manifest = prepared.manifest;
  }
  const response = await d.remote(args, manifest);
  await d.save(response.manifest);
  return response;
}

export async function runPdfAcceptanceRuntime(args: PdfAcceptanceArgs) {
  // This path never reads .env or the legacy/default credential namespace.
  const local = process.env["SMEDC_PDF_ACCEPTANCE_LOCAL"] === "1";
  const controller = process.env["SMEDC_PDF_ACCEPTANCE_CONTROLLER"] === "1";
  if (local) assertLocalPdfTargets(process.env);
  if (!local && !controller) {
    const profile = process.env["SMEDC_CREDENTIAL_PROFILE"];
    if (profile !== `pdf-${args.runId}-a-admin`)
      throw new Error("Online PDF controller requires its dedicated admin credential profile.");
    const launcher = process.env["SMEDC_PDF_ACCEPTANCE_LAUNCHER"];
    if (!launcher?.startsWith("/"))
      throw new Error("Specify the independently verified published PDF-compatible launcher path.");
    const { stdout } = await promisify(execFile)(launcher, ["self-check"], {
      env: {
        ...process.env,
        SMEDC_BASE_URL: "https://api.smedatacenter.xyz",
        SMEDC_CREDENTIAL_PROFILE: profile
      },
      maxBuffer: 65536
    });
    assertPdfCredentialProfile(args.runId, "a-admin", JSON.parse(stdout));
  }
  await mkdir(path.dirname(args.manifestPath), { recursive: true, mode: 0o700 });
  const lock = await open(`${args.manifestPath}.lock`, "wx", 0o600);
  try {
    let manifest: PdfAcceptanceManifest;
    if (controller) {
      let input = "";
      for await (const chunk of process.stdin) {
        input += chunk;
        if (input.length > 4 * 1024 * 1024) throw new Error("PDF manifest input too large.");
      }
      manifest = validatePdfAcceptanceManifest(JSON.parse(input));
      if (manifest.runId !== args.runId) throw new Error("PDF controller run mismatch.");
    } else {
      try {
        manifest = await readPdfManifest(args.manifestPath, args.runId);
      } catch (error) {
        if (args.command !== "setup" || (error as NodeJS.ErrnoException).code !== "ENOENT")
          throw error;
        manifest = createPdfAcceptanceManifest(args.runId);
        await writePdfManifest(args.manifestPath, manifest);
      }
    }
    if (!local && !controller) {
      const response = await runDurablePdfRemoteCommand(args, manifest, {
        remote: runPdfStagingController,
        save: (m) => writePdfManifest(args.manifestPath, m)
      });
      if (!response.ok)
        throw new Error(
          "PDF controller cleanup/verification failed; private manifest retained for recovery."
        );
      process.stdout.write(
        JSON.stringify({ ok: true, profile: "pdf", command: args.command, runId: args.runId }) +
          "\n"
      );
      return;
    }
    const databaseUrl = process.env["DATABASE_URL"];
    if (!databaseUrl) throw new Error("Controller database target required.");
    if (!local) assertStagingRuntimeDatabaseTarget(databaseUrl);
    const prisma = new PrismaClient({ adapter: new PrismaMariaDb(databaseUrl) });
    const save = controller
      ? async (m: PdfAcceptanceManifest) => {
          manifest = m;
        }
      : (m: PdfAcceptanceManifest) => writePdfManifest(args.manifestPath, m);
    try {
      const runtime = parseApiRetrievalRuntimeConfig();
      const external = createPdfQdrantResources({
        storage: createStorageAdapter(process.env),
        url: runtime.qdrant.url,
        collection: runtime.qdrant.collectionName,
        ...(runtime.qdrant.apiKey ? { apiKey: runtime.qdrant.apiKey } : {})
      });
      if (args.command === "setup") await setupPdfAcceptanceRun(prisma, manifest, save);
      else if (args.command === "register")
        await registerPdfDocument(prisma, manifest, args.documentId!, external, save);
      else if (args.command === "cleanup")
        await cleanupPrismaPdfAcceptanceRun(
          prisma,
          manifest,
          external,
          save,
          controller && process.env["SMEDC_PDF_ACCEPTANCE_PREPARE_CLEANUP"] === "1"
        );
      else {
        const inventory = await inventoryPdfAcceptanceRun(prisma, manifest, external);
        assertPdfInventory(manifest, inventory);
        const docs = await prisma.document.findMany({
          where: { id: { in: manifest.documentIds }, orgId: { in: manifest.orgIds } },
          include: { indexes: true }
        });
        if (
          !docs.length ||
          docs.some(
            (d) =>
              d.status !== "active" ||
              !d.indexes.some((i) => i.status === "ready" && i.parseSummary !== null)
          )
        )
          throw new Error(
            "PDF verification requires complete ready documents; employee MCP evidence remains a separate gate."
          );
        const identities = await prisma.loginIdentity.findMany({
          where: { employeeId: { in: manifest.employeeIds }, orgId: { in: manifest.orgIds } },
          select: { passwordHash: true }
        });
        if (
          identities.length !== manifest.employeeIds.length ||
          identities.some((i) => !i.passwordHash)
        )
          throw new Error("Human password setup has not completed for every PDF account.");
      }
      process.stdout.write(
        JSON.stringify(
          controller
            ? { ok: true, manifest }
            : { ok: true, profile: "pdf", command: args.command, runId: args.runId }
        ) + "\n"
      );
    } catch (error) {
      if (controller) {
        process.stdout.write(JSON.stringify({ ok: false, manifest }) + "\n");
        process.exitCode = 1;
      } else throw error;
    } finally {
      await prisma.$disconnect();
    }
  } finally {
    await lock.close();
    await unlink(`${args.manifestPath}.lock`);
  }
}
