import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { PrismaClient } from "@prisma/client";
import { createDatabaseAdapter, persistResourceAttributes } from "@smedc/db";
import { LocalFileSystemStorageAdapter } from "@smedc/storage";
import {
  createPrismaLedgerArchiveRepository,
  createPrismaLedgerPublicationArchive
} from "@smedc/ledger-archive";
import { createPrismaLedgerSourceReader } from "@smedc/ledger-archive/source-reader";
import JSZip from "jszip";
import { expect, it } from "vitest";
import { buildApiServer } from "../server.js";
import { AuthCore } from "../auth/auth-core.js";
import { BrowserSessions, BROWSER_SESSION_COOKIE } from "../auth/browser-session.js";
import { createPrismaBrowserSessionRepository } from "../auth/prisma-browser-session.js";
import { createPrismaAuthCoreRepository } from "../auth/prisma-auth-repository.js";
import { hashOpaqueSecret, hashPassword } from "../auth/primitives.js";
import { createLedgerWorkerRuntime } from "../../../worker/src/ledger-pdf/runtime.js";
import {
  createPrismaProcessingWorkerRepository,
  runWorkerOnce
} from "../../../worker/src/worker.js";

const enabled = process.env["RUN_LEDGER_PRISMA_INTEGRATION"] === "1";
const databaseUrl = process.env["DATABASE_URL"] ?? "";
if (enabled) {
  const target = new URL(databaseUrl);
  if (
    !["localhost", "127.0.0.1"].includes(target.hostname) ||
    !/^\/smedc_integration_[a-f0-9]{32}$/.test(target.pathname)
  )
    throw new Error("Ledger web integration requires the runner's owned loopback schema");
}
const sha256 = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");

it.skipIf(!enabled)(
  "delivers only selected persisted PDFs through browser login, a real worker and ZIP after live grant changes",
  async () => {
    const prisma = new PrismaClient({ adapter: createDatabaseAdapter(databaseUrl) });
    const scratch = await mkdtemp(join(tmpdir(), "smedc-ledger-browser-"));
    const orgId = `web_${randomUUID().replaceAll("-", "")}`;
    const capabilities = new Map<string, string>();
    let origin = "";
    class HttpFixtureStorage extends LocalFileSystemStorageAdapter {
      override async createDownloadUrl(key: string) {
        const capability = randomUUID();
        capabilities.set(capability, key);
        return `${origin}/__synthetic_zip/${capability}`;
      }
    }
    const storage = new HttpFixtureStorage({ root: join(scratch, "storage") });
    const worker = createPrismaProcessingWorkerRepository(databaseUrl);
    const env = {
      DATABASE_URL: databaseUrl,
      LEDGER_PDF_DELIVERY_ENABLED: "true",
      SMEDC_PUBLIC_ORIGIN: "https://browser.example.invalid"
    };
    const runtime = createLedgerWorkerRuntime({
      storage,
      scratchRoot: join(scratch, "scratch"),
      env
    });
    const issuedAt = new Date();
    let now = issuedAt;
    const sessions = new BrowserSessions(createPrismaBrowserSessionRepository(prisma), () => now);
    const app = buildApiServer({
      logger: false,
      authCore: new AuthCore(createPrismaAuthCoreRepository(prisma)),
      browserSessions: sessions,
      storageAdapter: storage,
      cursorSigningSecret: "synthetic-ledger-browser-cursor-secret",
      runtimeEnv: env
    });
    app.get<{ Params: { capability: string } }>(
      "/__synthetic_zip/:capability",
      async (request, reply) => {
        const key = capabilities.get(request.params.capability);
        return key
          ? reply.type("application/zip").send(await storage.getObjectStream(key))
          : reply.code(404).send();
      }
    );
    try {
      await prisma.organization.create({
        data: { id: orgId, name: "Synthetic browser enterprise" }
      });
      const owner = await prisma.employee.create({
        data: {
          orgId,
          email: `${orgId}@example.invalid`,
          displayName: "Ordinary employee",
          role: "employee",
          clearance: 0
        }
      });
      const admin = await prisma.employee.create({
        data: {
          orgId,
          email: `${orgId}-admin@example.invalid`,
          displayName: "Admin without grants",
          role: "admin",
          clearance: 3
        }
      });
      const password = "synthetic browser integration password";
      const passwordHash = await hashPassword(password);
      for (const employee of [owner, admin])
        await prisma.loginIdentity.create({
          data: { orgId, employeeId: employee.id, normalizedEmail: employee.email, passwordHash }
        });
      await prisma.businessAuthorizationState.create({ data: { orgId, mode: "enabled" } });
      await prisma.businessCategory.createMany({
        data: ["delivery_ledger", "ledger_pdf"].map((id) => ({
          orgId,
          id,
          key: id,
          name: id,
          kind: "fixed",
          confidentialityLevel: id === "ledger_pdf" ? 0 : null,
          allowStore: true,
          allowGroup: false
        }))
      });
      const stores = ["合成甲店", "合成乙店"];
      const dates = ["2026-10-01", "2026-10-02"];
      await prisma.businessStore.createMany({
        data: stores.map((name) => ({ orgId, enterpriseKey: "synthetic", name }))
      });
      const grant = await prisma.businessGrant.create({
        data: {
          id: "browser-pdf-grant",
          orgId,
          employeeId: owner.id,
          enterpriseKey: "synthetic",
          ownership: "store",
          allStores: false
        }
      });
      await prisma.businessGrantCategory.create({
        data: { orgId, grantId: grant.id, categoryId: "ledger_pdf" }
      });
      const grantStore = (storeName: string) => ({
        orgId,
        grantId: grant.id,
        enterpriseKey: "synthetic",
        storeName
      });
      await prisma.businessGrantStore.createMany({ data: stores.map(grantStore) });
      const keys = stores.flatMap((storeName) =>
        dates.map((purchaseDate) => ({ orgId, storeName, purchaseDate }))
      );
      for (const storeName of stores) {
        const source = await prisma.document.create({
          data: {
            orgId,
            uploaderId: admin.id,
            title: "Synthetic ledger source",
            documentType: "raw_material",
            documentKind: "structured",
            fileType: "csv",
            status: "active",
            storageObjectKey: `${orgId}/${storeName}/source.csv`,
            checksumSha256: "a".repeat(64),
            byteSize: 10n,
            confidentialityLevel: 3,
            sourceMetadata: { enterpriseKey: "synthetic" }
          }
        });
        const batch = await prisma.importBatch.create({
          data: {
            orgId,
            sourceDocumentId: source.id,
            dataset: "delivery_ledger",
            idempotencyKey: storeName,
            requestFingerprint: "b".repeat(64),
            status: "applied",
            appliedRowCount: 2,
            totalRowCount: 2
          }
        });
        await prisma.$transaction((tx) =>
          persistResourceAttributes(tx, {
            orgId,
            id: source.id,
            kind: "source_fragment",
            resourceKey: source.id,
            sourceDocumentId: source.id,
            categoryId: "delivery_ledger",
            valid: true,
            scopes: [{ enterpriseKey: "synthetic", ownership: "store", storeName, dimensions: {} }]
          })
        );
        await prisma.deliveryLedgerRow.createMany({
          data: dates.map((purchaseDate, index) => ({
            orgId,
            sourceDocumentId: source.id,
            importBatchId: batch.id,
            sourceRowNumber: index + 1,
            payload: {
              receipt_id: `R-${storeName}-${index}`,
              store_name: storeName,
              purchase_date: purchaseDate,
              item_name: "Synthetic rice",
              purchase_quantity: "1",
              purchase_amount: "2"
            }
          }))
        });
      }
      const archive = createPrismaLedgerArchiveRepository({ prisma });
      const publication = createPrismaLedgerPublicationArchive({ prisma });
      const sourceReader = createPrismaLedgerSourceReader({ prisma });
      const pdfs = new Map<string, Buffer>();
      let refreshRequestId = "";
      for (const key of keys) {
        const result = await archive.reserveRefresh({
          orgId,
          actor: { kind: "employee", employeeId: owner.id },
          idempotencyKey: randomUUID(),
          requestFingerprint: "c".repeat(64),
          scope: { storeNames: [key.storeName], dates: [key.purchaseDate] },
          keys: [key]
        });
        refreshRequestId ||= result!.requestId;
        const item = await prisma.ledgerArtifactRequestItem.findFirstOrThrow({
          where: { requestId: result!.requestId }
        });
        const run = await prisma.processingRun.findFirstOrThrow({
          where: { ledgerArtifactRequestItemId: item.id }
        });
        await prisma.processingRun.update({
          where: { id: run.id },
          data: {
            status: "running",
            attemptNumber: 1,
            lockedBy: orgId,
            lockedUntil: new Date(Date.now() + 120000)
          }
        });
        const snapshot = await sourceReader.readLedgerSnapshot(key);
        const bytes = Buffer.from(
          `%PDF-1.4\nSynthetic ${key.storeName} ${key.purchaseDate}\n%%EOF\n`
        );
        pdfs.set(`${key.storeName}/${key.purchaseDate}`, bytes);
        const objectKey = `${orgId}/${randomUUID()}.pdf`;
        await storage.putObjectAtKey({
          key: objectKey,
          body: Readable.from(bytes),
          contentType: "application/pdf",
          contentLength: bytes.length,
          checksumSha256: sha256(bytes)
        });
        const leaseToken = { runId: run.id, lockedBy: orgId, attemptNumber: 1 };
        await publication.registerCandidate({ orgId, leaseToken, objectKey });
        expect(
          await publication.publishLedgerPdf({
            partitionId: item.partitionId,
            generation: item.generation,
            dataRevision: 0,
            sourceFingerprint: snapshot.sourceFingerprint,
            leaseToken,
            candidate: {
              objectKey,
              byteSize: bytes.length,
              checksumSha256: sha256(bytes),
              pageCount: 1
            },
            sources: snapshot.sources,
            rowCount: snapshot.rows.length,
            certificateCount: 0
          })
        ).toBe("published");
      }
      origin = await app.listen({ host: "127.0.0.1", port: 0 });
      async function login(email: string) {
        const page = await fetch(`${origin}/ledger-pdfs/login`, { redirect: "manual" });
        const loginCookie = page.headers.getSetCookie()[0]!.split(";")[0]!;
        const csrfToken = (await page.text()).match(/name="csrfToken" value="([^"]+)"/)![1]!;
        const response = await fetch(`${origin}/ledger-pdfs/login`, {
          method: "POST",
          redirect: "manual",
          headers: {
            cookie: loginCookie,
            origin: env.SMEDC_PUBLIC_ORIGIN,
            "content-type": "application/x-www-form-urlencoded"
          },
          body: new URLSearchParams({ email, password, csrfToken })
        });
        expect(response.status).toBe(303);
        const setCookie = response.headers
          .getSetCookie()
          .find((value) => value.startsWith(BROWSER_SESSION_COOKIE + "="))!;
        expect(setCookie).toContain("Max-Age=604800");
        const cookie = setCookie.split(";")[0]!;
        const context = await fetch(`${origin}/ledger-pdfs/api/context`, { headers: { cookie } });
        expect(context.status).toBe(200);
        return {
          cookie,
          context: (await context.json()) as { identity: { employeeId: string }; csrfToken: string }
        };
      }
      const browser = await login(owner.email);
      expect(browser.context.identity.employeeId).toBe(owner.id);
      const persisted = await prisma.browserSession.findUniqueOrThrow({
        where: { secretHash: hashOpaqueSecret(browser.cookie.split("=")[1]!) }
      });
      expect(persisted.expiresAt.getTime()).toBe(issuedAt.getTime() + 604800000);
      const headers = {
        cookie: browser.cookie,
        origin: env.SMEDC_PUBLIC_ORIGIN,
        "x-csrf-token": browser.context.csrfToken
      };
      const post = (route: string, body?: unknown) =>
        fetch(`${origin}/ledger-pdfs/api/${route}`, {
          method: "POST",
          headers: {
            ...headers,
            ...(body === undefined ? {} : { "content-type": "application/json" })
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) })
        });
      const coverage = await post("coverage", {
        scope: { startDate: dates[0], endDate: dates[1] }
      });
      expect(coverage.status).toBe(200);
      const coverageBody = await coverage.json();
      expect(coverageBody.partitions).toHaveLength(4);
      expect(
        coverageBody.partitions.every(
          (item: { status: string; byteSize: number }) =>
            item.status === "ready" && item.byteSize > 0
        )
      ).toBe(true);
      const selection = [
        { storeName: stores[0]!, purchaseDate: dates[0]! },
        { storeName: stores[1]!, purchaseDate: dates[1]! }
      ];
      const pdf = await fetch(
        `${origin}/ledger-pdfs/api/pdf?${new URLSearchParams({ ...selection[0]!, disposition: "inline" })}`,
        { headers }
      );
      expect(pdf.status).toBe(200);
      expect(pdf.headers.get("content-disposition")).toMatch(/^inline;/);
      expect(Buffer.from(await pdf.arrayBuffer())).toEqual(pdfs.get(`${stores[0]}/${dates[0]}`));
      const created = await post("downloads", {
        selection,
        idempotencyKey: "exact-browser-selection"
      });
      expect(created.status).toBe(202);
      const task = (await created.json()) as { requestId: string; status: string };
      expect(
        await (
          await post("downloads", {
            selection: [...selection].reverse(),
            idempotencyKey: "exact-browser-selection"
          })
        ).json()
      ).toEqual(task);
      expect(
        (
          await post("downloads", {
            selection: [selection[0]],
            idempotencyKey: "exact-browser-selection"
          })
        ).status
      ).toBe(409);
      // Revoke only one captured target while queued: worker still finishes the complete package.
      await prisma.businessGrantStore.deleteMany({
        where: { orgId, grantId: grant.id, storeName: stores[1] }
      });
      await prisma.businessAuthorizationState.update({
        where: { orgId },
        data: { version: { increment: 1 } }
      });
      expect(
        await runWorkerOnce({
          repository: worker,
          storage,
          ledgerJobs: runtime.jobs,
          workerId: orgId,
          leaseSeconds: 120
        })
      ).toMatchObject({ processed: true, status: "active" });
      const status = () =>
        fetch(`${origin}/ledger-pdfs/api/requests/${task.requestId}`, { headers });
      expect(await (await status()).json()).toMatchObject({
        status: "succeeded",
        partitions: expect.arrayContaining(
          selection.map((pair) => ({ ...pair, status: "succeeded" }))
        )
      });
      expect((await post(`requests/${task.requestId}/download-url`)).status).toBe(404);
      expect(await (await status()).json()).toMatchObject({ status: "succeeded" });
      const adminBrowser = await login(admin.email);
      const adminHeaders = {
        cookie: adminBrowser.cookie,
        origin: env.SMEDC_PUBLIC_ORIGIN,
        "x-csrf-token": adminBrowser.context.csrfToken,
        "content-type": "application/json"
      };
      // Browser status is only for owned downloads, even for admins or the refresh owner.
      for (const cookie of [adminBrowser.cookie, browser.cookie]) {
        const refresh = await fetch(`${origin}/ledger-pdfs/api/requests/${refreshRequestId}`, {
          headers: { cookie }
        });
        expect(refresh.status).toBe(404);
        const body = await refresh.json();
        expect(body).toMatchObject({ error: { code: "LEDGER_PDF_UNAVAILABLE" } });
        expect(body).not.toHaveProperty("partitions");
        expect(body).not.toHaveProperty("status");
        expect(JSON.stringify(body)).not.toContain(stores[0]);
        expect(JSON.stringify(body)).not.toContain(dates[0]);
      }
      // The existing authenticated HTTP/MCP admin refresh contract remains available.
      const adminIdentity = await prisma.loginIdentity.findFirstOrThrow({
        where: { orgId, employeeId: admin.id }
      });
      const adminToken = randomUUID();
      await createPrismaAuthCoreRepository(prisma).createSessionBundle({
        identityId: adminIdentity.id,
        employeeId: admin.id,
        orgId,
        credentialHash: hashOpaqueSecret(randomUUID()),
        accessTokenHash: hashOpaqueSecret(adminToken),
        accessTokenExpiresAt: new Date(Date.now() + 600000),
        absoluteExpiresAt: new Date(Date.now() + 86400000),
        now: new Date(),
        audit: {
          requestId: "synthetic-admin-refresh",
          sourceIp: "127.0.0.1",
          launcherVersion: null
        }
      });
      const legacyRefresh = await fetch(`${origin}/v1/ledger-pdfs/requests/${refreshRequestId}`, {
        headers: { authorization: `Bearer ${adminToken}` }
      });
      expect(legacyRefresh.status).toBe(200);
      expect(await legacyRefresh.json()).toMatchObject({
        requestId: refreshRequestId,
        status: "succeeded",
        partitions: [{ storeName: stores[0], purchaseDate: dates[0], status: "succeeded" }]
      });
      const adminCoverage = await fetch(`${origin}/ledger-pdfs/api/coverage`, {
        method: "POST",
        headers: adminHeaders,
        body: JSON.stringify({ scope: { startDate: dates[0], endDate: dates[1] } })
      });
      expect(await adminCoverage.json()).toMatchObject({ partitions: [] });
      expect(
        (
          await fetch(`${origin}/ledger-pdfs/api/requests/${task.requestId}`, {
            headers: adminHeaders
          })
        ).status
      ).toBe(404);
      await prisma.businessGrantStore.create({ data: grantStore(stores[1]!) });
      await prisma.businessAuthorizationState.update({
        where: { orgId },
        data: { version: { increment: 1 } }
      });
      const link = await post(`requests/${task.requestId}/download-url`);
      expect(link.status).toBe(200);
      const { downloadUrl } = (await link.json()) as { downloadUrl: string };
      const downloaded = await fetch(downloadUrl);
      expect(downloaded.status).toBe(200);
      const zip = await JSZip.loadAsync(await downloaded.arrayBuffer());
      const expectedNames = [
        "合成甲店/2026-10-01/食品经营单位进货台帐_合成甲店_2026-10-01.pdf",
        "合成乙店/2026-10-02/食品经营单位进货台帐_合成乙店_2026-10-02.pdf"
      ];
      expect(Object.keys(zip.files).sort()).toEqual([...expectedNames].sort());
      for (const [index, pair] of selection.entries()) {
        const zipped = await zip.file(expectedNames[index]!)!.async("nodebuffer");
        expect(sha256(zipped)).toBe(sha256(pdfs.get(`${pair.storeName}/${pair.purchaseDate}`)!));
      }
      now = new Date(persisted.expiresAt.getTime() - 1);
      expect((await fetch(`${origin}/ledger-pdfs/api/context`, { headers })).status).toBe(200);
      expect(
        (await prisma.browserSession.findUniqueOrThrow({ where: { id: persisted.id } })).expiresAt
      ).toEqual(persisted.expiresAt);
      now = persisted.expiresAt;
      expect((await fetch(`${origin}/ledger-pdfs/api/context`, { headers })).status).toBe(401);
    } finally {
      await app.close();
      await Promise.all([runtime.disconnect(), worker.disconnect?.(), prisma.$disconnect()]);
      await rm(scratch, { recursive: true, force: true });
      // The existing runner owns and drops the whole isolated schema, including fixture rows.
    }
  },
  30000
);
