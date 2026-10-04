import { createHash, randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { parse as parseDotenv } from "dotenv";
import { PrismaClient } from "@prisma/client";
import { createDatabaseAdapter } from "@smedc/db";
import { LocalFileSystemStorageAdapter } from "@smedc/storage";
import {
  createLedgerArchiveService,
  createPrismaLedgerArchiveRepository,
  markLedgerPartitionsChanged
} from "@smedc/ledger-archive";
import { createPrismaLedgerReconciliation } from "@smedc/ledger-archive/reconciliation";
import { buildApiServer } from "../../../api/src/server.js";
import {
  createLauncherToolDependencies,
  createLauncherToolHandler,
  type LauncherAuthentication
} from "../../../mcp-launcher/src/launcher.js";
import type { AuthenticatedEmployee } from "@smedc/domain";
import { parseLedgerCliArgs, runLedgerCli } from "../../../../scripts/ledger-pdf-support.js";
import { createPrismaProcessingWorkerRepository, runWorkerOnce } from "../worker.js";
import { createLedgerWorkerRuntime } from "./runtime.js";
import { runLedgerTool } from "./renderer.js";
import JSZip from "jszip";
import sharp from "sharp";
import { expect, it } from "vitest";

it.skipIf(process.env["RUN_LEDGER_FLOW_INTEGRATION"] !== "1")(
  "joins CLI, authenticated launcher/MCP, real renderer, ZIP, revisions and missing-PDF repair",
  async () => {
    const databaseUrl = process.env["DATABASE_URL"] ?? "";
    const target = new URL(databaseUrl);
    if (
      !["localhost", "127.0.0.1"].includes(target.hostname) ||
      !target.pathname.endsWith("ledger_test")
    )
      throw new Error("Local dedicated ledger_test database required");
    const providerEnvPath = process.env["SMEDC_LEDGER_PROVIDER_ENV"];
    if (!providerEnvPath || !resolve(providerEnvPath).endsWith("/.env"))
      throw new Error("Load the real main checkout .env explicitly");
    const providerEnv = parseDotenv(await readFile(providerEnvPath));
    if (!providerEnv["LLM_PROVIDER"]) throw new Error("Real provider configuration missing");
    const orgId = `ledger_flow_${randomUUID().slice(0, 8)}`;
    const otherOrgId = `${orgId}_other`;
    const directory = resolve(".data", orgId);
    const storageRoot = join(directory, "storage");
    const env = {
      ...providerEnv,
      DATABASE_URL: databaseUrl,
      STORAGE_DRIVER: "local",
      LOCAL_STORAGE_ROOT: storageRoot,
      LEDGER_PDF_DELIVERY_ENABLED: "true",
      LEDGER_PDF_RECONCILE_ENABLED: "true",
      LEDGER_PDF_RECONCILE_TIME: "03:00",
      CURSOR_SIGNING_SECRET: "synthetic-ledger-flow-cursor-secret"
    };
    if (
      new URL(env.DATABASE_URL).hostname !== target.hostname ||
      !storageRoot.startsWith(directory + "/")
    )
      throw new Error("Local fixture overrides required before mutation");
    const originalPath = process.env["PATH"];
    const image = process.env["LEDGER_FLOW_RENDER_IMAGE"];
    await mkdir(directory, { recursive: true });
    if (image) {
      if (!/^[a-zA-Z0-9._:/-]+$/.test(image)) throw new Error("Invalid controlled renderer image");
      const bin = join(directory, "bin");
      await mkdir(bin);
      const shellQuote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";
      for (const tool of ["soffice", "pdfinfo", "pdftotext"]) {
        const wrapper = join(bin, tool);
        await writeFile(
          wrapper,
          `#!/bin/sh\nexec docker run --rm --network none --user ${process.getuid?.() ?? 1000}:${process.getgid?.() ?? 1000} --volume ${shellQuote(directory + ":" + directory)} ${shellQuote(image)} ${tool} "$@"\n`
        );
        await chmod(wrapper, 0o700);
      }
      process.env["PATH"] = `${bin}:${originalPath ?? ""}`;
    }
    const prisma = new PrismaClient({ adapter: createDatabaseAdapter(databaseUrl) });
    const repository = createPrismaProcessingWorkerRepository(databaseUrl);
    const storage = new LocalFileSystemStorageAdapter({ root: storageRoot });
    let clock = new Date();
    const runtime = createLedgerWorkerRuntime({
      storage,
      scratchRoot: join(directory, "scratch"),
      env,
      now: () => clock
    });
    let app: ReturnType<typeof buildApiServer> | undefined;
    const key = { orgId, storeName: "合成门店 / % ..", purchaseDate: "2026-10-03" };
    const scope = { storeNames: [key.storeName], dates: [key.purchaseDate] };
    try {
      if (await prisma.organization.count())
        throw new Error("Empty dedicated synthetic database required");
      await prisma.organization.createMany({
        data: [orgId, otherOrgId].map((id) => ({ id, name: "Synthetic ledger flow" }))
      });
      const employee = await prisma.employee.create({
        data: {
          orgId,
          email: `${orgId}@example.invalid`,
          displayName: "Synthetic admin",
          role: "admin",
          clearance: 3
        }
      });
      const other = await prisma.employee.create({
        data: {
          orgId: otherOrgId,
          email: `${otherOrgId}@example.invalid`,
          displayName: "Other synthetic",
          role: "admin",
          clearance: 3
        }
      });
      const identities = new Map<string, AuthenticatedEmployee>(
        [employee, other].map((e) => [e.id, { ...e, organizationName: "Synthetic ledger flow" }])
      );
      app = buildApiServer({
        logger: false,
        storageAdapter: storage,
        runtimeEnv: env,
        authenticateAccessToken: async (token) => identities.get(token) ?? null
      });
      const fetchImplementation: typeof fetch = async (input, init) => {
        const request = new Request(input, init);
        const url = new URL(request.url);
        const response = await app!.inject({
          method: request.method as "GET" | "POST" | "DELETE",
          url: url.pathname + url.search,
          headers: Object.fromEntries(request.headers),
          ...(request.body !== null ? { payload: await request.text() } : {})
        });
        return new Response(response.statusCode === 204 ? null : response.body, {
          status: response.statusCode,
          headers: response.headers as Record<string, string>
        });
      };
      const auth = (id: string): LauncherAuthentication => ({
        login: async () => ({ authenticated: true }),
        logout: async () => ({ remoteRevocationConfirmed: true, localCredentialRemoved: true }),
        status: async () => ({ authenticated: true }),
        accessToken: async () => id,
        profile: async () => ({ ...identities.get(id)! }),
        invalidate: async () => {},
        selfCheck: async () => {
          throw new Error("Not used by ledger fixture");
        }
      });
      const tool = async (name: string, input: object, id = employee.id) => {
        const result = await createLauncherToolHandler(
          name,
          createLauncherToolDependencies({
            config: { serviceUrl: "https://ledger-fixture.invalid", transport: "stdio" },
            auth: auth(id),
            fetchImplementation
          })
        )(input);
        const body = JSON.parse(result.content[0]!.text) as Record<string, unknown>;
        return { result, body };
      };
      async function addReceipt(receiptId: string, itemName: string) {
        await prisma.$transaction(async (tx) => {
          const document = await tx.document.create({
            data: {
              orgId,
              uploaderId: employee.id,
              title: receiptId,
              documentType: "structured_dataset",
              documentKind: "structured",
              status: "active",
              storageObjectKey: `org/${orgId}/${receiptId}.csv`,
              checksumSha256: createHash("sha256").update(receiptId).digest("hex")
            }
          });
          const batch = await tx.importBatch.create({
            data: {
              orgId,
              sourceDocumentId: document.id,
              dataset: "delivery_ledger",
              status: "applied",
              idempotencyKey: receiptId,
              requestFingerprint: "a".repeat(64)
            }
          });
          await tx.deliveryLedgerRow.create({
            data: {
              orgId,
              sourceDocumentId: document.id,
              importBatchId: batch.id,
              sourceRowNumber: 1,
              payload: {
                store_name: key.storeName,
                purchase_date: key.purchaseDate,
                receipt_id: receiptId,
                item_name: itemName,
                purchase_quantity: "1.2300",
                purchase_amount: "5.6700"
              }
            }
          });
          await markLedgerPartitionsChanged(tx, [key]);
        });
      }
      async function drain() {
        clock = new Date(Math.max(clock.getTime(), Date.now() + 1000));
        for (let step = 0; step < 30; step++) {
          const result = await runWorkerOnce({
            repository,
            storage,
            ledgerJobs: runtime.jobs,
            now: () => clock,
            workerId: orgId,
            leaseSeconds: 240
          });
          if (!result.processed) return;
          expect(result.status).toBeOneOf(["active", "retry_scheduled"]);
        }
        throw new Error("Synthetic ledger worker did not drain");
      }
      async function current() {
        return prisma.ledgerPdfPartition.findFirstOrThrow({
          where: { orgId, storeName: key.storeName }
        });
      }
      await addReceipt("SYNTHETIC-001", "合成大米");
      const output: unknown[] = [];
      const archive = createLedgerArchiveService(createPrismaLedgerArchiveRepository({ prisma }));
      await runLedgerCli(
        parseLedgerCliArgs([
          "refresh",
          "--org-id",
          orgId,
          "--all-stores",
          "--all-dates",
          "--dry-run"
        ]),
        { archive, now: () => clock, output: (value) => output.push(value) }
      );
      expect(output[0]).toMatchObject({ partitionCount: 1 });
      await runLedgerCli(
        parseLedgerCliArgs([
          "refresh",
          "--org-id",
          orgId,
          "--all-stores",
          "--all-dates",
          "--execute",
          "--request-key",
          "synthetic-cli",
          "--operator",
          "synthetic-fixture"
        ]),
        { archive, now: () => clock, output: (value) => output.push(value) }
      );
      await drain();
      const first = await current();
      expect(first.rowCount).toBe(1);
      expect((await tool("describe_ledger_pdf_coverage", scope)).result.isError).toBe(false);
      const bundle = await tool("prepare_ledger_pdf_download", {
        ...scope,
        idempotencyKey: "synthetic-zip"
      });
      expect(bundle.result.isError).toBe(false);
      const requestId = String(bundle.body["requestId"]);
      await drain();
      expect((await tool("get_ledger_pdf_request_status", { requestId })).body).toMatchObject({
        status: "succeeded"
      });
      const url = await tool("get_ledger_pdf_download_url", { requestId });
      expect(url.body).not.toHaveProperty("error");
      expect(url.result.isError).toBe(false);
      const zip = await JSZip.loadAsync(await readFile(new URL(String(url.body["downloadUrl"]))));
      const files = Object.values(zip.files).filter((file) => !file.dir);
      expect(files).toHaveLength(1);
      expect((await files[0]!.async("nodebuffer")).subarray(0, 4).toString()).toBe("%PDF");
      expect(
        (await tool("get_ledger_pdf_download_url", { requestId }, other.id)).result.isError
      ).toBe(true);
      expect(
        (await tool("get_ledger_pdf_request_status", { requestId }, other.id)).result.isError
      ).toBe(true);
      expect(
        (await tool("describe_ledger_pdf_coverage", scope, other.id)).body["partitions"]
      ).toEqual([]);
      await addReceipt("SYNTHETIC-002", "合成白菜");
      const photo = await sharp({
        create: { width: 240, height: 160, channels: 3, background: "#2040db" }
      })
        .png()
        .toBuffer();
      const photoObject = await storage.putObject({
        orgId,
        documentId: "synthetic-photo",
        fileName: "synthetic.png",
        body: photo,
        contentType: "image/png"
      });
      await prisma.$transaction(async (tx) => {
        const document = await tx.document.create({
          data: {
            orgId,
            uploaderId: employee.id,
            title: "Synthetic certificate",
            documentType: "raw_material",
            documentKind: "quarantine_certificate",
            fileType: "png",
            status: "active",
            storageObjectKey: photoObject.key,
            checksumSha256: photoObject.hash,
            contentType: "image/png",
            byteSize: BigInt(photoObject.size)
          }
        });
        await tx.quarantineCertificate.create({
          data: {
            orgId,
            sourceDocumentId: document.id,
            receiptId: "SYNTHETIC-002",
            idempotencyKey: "synthetic-photo",
            requestFingerprint: "b".repeat(64)
          }
        });
        await markLedgerPartitionsChanged(tx, [key]);
      });
      expect(
        (await tool("refresh_ledger_pdfs", { ...scope, idempotencyKey: "synthetic-rebuild" }))
          .result.isError
      ).toBe(false);
      await drain();
      const second = await current();
      expect(second).toMatchObject({ rowCount: 2, certificateCount: 1 });
      expect(second.currentObjectKey).not.toBe(first.currentObjectKey);
      const text = await runLedgerTool(
        "pdftotext",
        [join(storageRoot, second.currentObjectKey!), "-"],
        { timeoutMs: 15000 }
      );
      expect(text.replace(/\s/g, "")).toContain("合成白菜");
      expect(text.replace(/\s/g, "")).toContain("检疫证明—收货单号：SYNTHETIC-002");
      // Delete exactly this fixture's current derived PDF; originals are untouched.
      expect(second.currentObjectKey).toContain(`org/${orgId}/ledger_records/`);
      await storage.deleteObject(second.currentObjectKey!);
      clock = new Date(clock.getTime() + 2 * 86400000);
      await runtime.maintain();
      await drain();
      const repaired = await current();
      expect(repaired.currentObjectKey).not.toBe(second.currentObjectKey);
      expect(await storage.headObject(repaired.currentObjectKey!)).toMatchObject({
        state: "found"
      });
      const scan = await prisma.ledgerPdfReconciliationRun.findFirstOrThrow({ where: { orgId } });
      const reconciliation = createPrismaLedgerReconciliation({ prisma, now: () => clock });
      expect(await reconciliation.getReconciliationStatus(scan.id)).toMatchObject({
        scanCompleted: true,
        repairsCompleted: true,
        repairedCount: 1
      });
      expect(await storage.headObject(photoObject.key)).toMatchObject({ state: "found" });
      expect(await prisma.deliveryLedgerRow.count({ where: { orgId } })).toBe(2);
      const expiredZip = await prisma.ledgerArtifactRequest.findUniqueOrThrow({
        where: { id: requestId }
      });
      expect(expiredZip.zipObjectKey).toBeNull();
    } finally {
      await app?.close();
      await runtime.disconnect();
      await repository.disconnect?.();
      const where = { orgId: { in: [orgId, otherOrgId] } };
      await prisma.storageGarbage.deleteMany({
        where: { objectKey: { startsWith: `org/${orgId}/` } }
      });
      await prisma.auditLog.deleteMany({ where });
      await prisma.processingRun.deleteMany({ where });
      await prisma.ledgerPdfReconciliationTarget.deleteMany({ where });
      await prisma.ledgerArtifactRequestItem.deleteMany({ where });
      await prisma.ledgerArtifactRequest.updateMany({ where, data: { retryOfRequestId: null } });
      await prisma.ledgerArtifactRequest.deleteMany({ where });
      await prisma.ledgerPdfSource.deleteMany({ where });
      await prisma.ledgerPdfPartition.deleteMany({ where });
      await prisma.ledgerPdfReconciliationRun.deleteMany({ where });
      await prisma.quarantineCertificate.deleteMany({ where });
      await prisma.deliveryLedgerRow.deleteMany({ where });
      await prisma.importBatch.deleteMany({ where });
      await prisma.document.deleteMany({ where });
      await prisma.employee.deleteMany({ where });
      await prisma.organization.deleteMany({ where: { id: where.orgId } });
      await prisma.$disconnect();
      process.env["PATH"] = originalPath;
      await rm(directory, { recursive: true, force: true });
    }
  },
  240000
);
