import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { PrismaClient } from "@prisma/client";
import {
  createDatabaseAdapter,
  createPrismaPartitionDownloadRepository,
  createPrismaStructuredPartitionRepository
} from "@smedc/db";
import { LocalFileSystemStorageAdapter } from "@smedc/storage";
import { describe, expect, it } from "vitest";
import { AuthCore } from "../apps/api/src/auth/auth-core.js";
import { createPrismaAuthCoreRepository } from "../apps/api/src/auth/prisma-auth-repository.js";
import { createPrismaPartitionDownloadAuditRepository } from "../apps/api/src/routes/structured-partitions/downloads.js";
import { buildApiServer } from "../apps/api/src/server.js";
import { LAUNCHER_VERSION } from "../apps/mcp-launcher/src/oauth-client.js";
import { createPartitionDownloadRuntime } from "../apps/worker/src/partition-download/runtime.js";
import { createPrismaProcessingWorkerRepository } from "../apps/worker/src/worker.js";
import { comparePartitionDownloads, integrationDatabasePlan } from "./test-integration-support.js";

describe("fresh integration schema safety", () => {
  it("creates unique schema identities while preserving the loopback connection", () => {
    const first = integrationDatabasePlan("mysql://smedc@localhost:3307/smedc", "3307");
    const second = integrationDatabasePlan("mysql://smedc@localhost:3307/smedc", "3307");
    expect(first.schema).toMatch(/^smedc_integration_[a-f0-9]{32}$/);
    expect(second.schema).not.toBe(first.schema);
    expect(new URL(first.databaseUrl).pathname).toBe(`/${first.schema}`);
    expect(new URL(first.databaseUrl).hostname).toBe("localhost");
  });
  it.each([
    "mysql://smedc@remote.invalid:3307/smedc",
    "mysql://smedc@localhost:3306/smedc",
    "mysql://smedc@localhost:3307/smedc?host=remote.invalid",
    "mysql://smedc@localhost:3307/smedc?connectionLimit=10",
    "mysql://smedc@localhost:3307/smedc#override",
    "postgresql://smedc@localhost:3307/smedc",
    "mysql://smedc@localhost:3307/unsafe-name",
    "invalid"
  ])("rejects an unsafe connection without echoing it", (url) => {
    expect(() => integrationDatabasePlan(url, "3307")).toThrow(/Integration database/);
    try {
      integrationDatabasePlan(url, "3307");
    } catch (error) {
      expect(String(error)).not.toContain(url);
    }
  });
});

const integration =
  process.env["RUN_PARTITION_PRISMA_INTEGRATION"] === "1" ? describe : describe.skip;
integration("small authenticated partition comparison", () => {
  it("preserves all CSV hashes/counts/money and reduces payload HTTP requests from three to one", async () => {
    const databaseUrl = process.env["DATABASE_URL"]!;
    const plan = integrationDatabasePlan(databaseUrl, process.env["MYSQL_PORT"] ?? "3307");
    expect(new URL(databaseUrl).pathname).toMatch(/^\/smedc_integration_[a-f0-9]{32}$/);
    const prisma = new PrismaClient({ adapter: createDatabaseAdapter(plan.baseUrl) });
    const scratch = await mkdtemp(path.join(os.tmpdir(), "smedc-comparison-"));
    const orgId = `comparison_${randomUUID().replaceAll("-", "")}`;
    const employeeId = randomUUID().replaceAll("-", "");
    const sourceId = randomUUID().replaceAll("-", "");
    const auth = new AuthCore(createPrismaAuthCoreRepository(prisma));
    const repository = createPrismaPartitionDownloadRepository({ databaseUrl });
    const worker = createPrismaProcessingWorkerRepository(databaseUrl);
    const capabilities = new Map<string, string>();
    let origin = "";
    class HttpFixtureStorage extends LocalFileSystemStorageAdapter {
      override async createDownloadUrl(key: string) {
        const capability = randomUUID();
        capabilities.set(capability, key);
        return `${origin}/__synthetic_payload/${capability}`;
      }
    }
    const storage = new HttpFixtureStorage({ root: path.join(scratch, "storage") });
    const runtime = createPartitionDownloadRuntime({
      storage,
      repository,
      buildLimits: { scratchRoot: scratch }
    });
    const app = buildApiServer({
      authCore: auth,
      structuredPartitionRepository: createPrismaStructuredPartitionRepository({ databaseUrl }),
      partitionDownloadRepository: repository,
      partitionDownloadAuditRepository: createPrismaPartitionDownloadAuditRepository(databaseUrl),
      storageAdapter: storage,
      cursorSigningSecret: "synthetic-comparison-cursor-secret",
      runtimeEnv: { DATABASE_URL: databaseUrl, SMEDC_PUBLIC_ORIGIN: "https://example.invalid" },
      logger: false
    });
    app.get<{ Params: { capability: string } }>(
      "/__synthetic_payload/:capability",
      async (request, reply) => {
        const key = capabilities.get(request.params.capability);
        if (!key) return reply.code(404).send();
        return reply.type("application/octet-stream").send(await storage.getObjectStream(key));
      }
    );
    let credential: string | undefined;
    let ownsOrganization = false;
    try {
      await prisma.organization.create({ data: { id: orgId, name: "Synthetic" } });
      ownsOrganization = true;
      await prisma.employee.create({
        data: {
          id: employeeId,
          orgId,
          email: `${employeeId}@example.invalid`,
          displayName: "Synthetic",
          role: "employee",
          clearance: 0
        }
      });
      const identity = await prisma.loginIdentity.create({
        data: { orgId, employeeId, normalizedEmail: `${employeeId}@example.invalid` }
      });
      const session = await auth.createSession({ identityId: identity.id, orgId, employeeId });
      credential = session.durableCredential;
      await prisma.partitionImportJob.create({
        data: {
          id: sourceId,
          orgId,
          uploaderId: employeeId,
          dataset: "dishes",
          enterpriseKey: "synthetic",
          enterpriseName: "Synthetic",
          confidentialityLevel: 0,
          idempotencyKey: "comparison",
          requestFingerprint: "a".repeat(64),
          originalFileName: "synthetic.csv",
          mediaType: "text/csv",
          sourceByteSize: 1n,
          sourceChecksumSha256: "a".repeat(64),
          sourceStartDate: new Date("2026-07-01"),
          sourceEndDate: new Date("2026-07-03"),
          expiresAt: new Date("2030-01-01")
        }
      });
      for (const [index, amount] of ["30.00", "30.25", "25.50"].entries()) {
        const bytes = Buffer.from(`store,amount\nSynthetic,${amount}\n`);
        const objectKey = `comparison/source-${index}.csv`;
        const checksumSha256 = createHash("sha256").update(bytes).digest("hex");
        await storage.putObjectAtKey({
          key: objectKey,
          body: Readable.from(bytes),
          contentLength: bytes.length,
          checksumSha256,
          contentType: "text/csv"
        });
        await prisma.structuredPartition.create({
          data: {
            id: randomUUID().replaceAll("-", ""),
            orgId,
            enterpriseKey: "synthetic",
            enterpriseName: "Synthetic",
            dataset: "dishes",
            storeKey: "synthetic-store",
            merchantId: "synthetic-store",
            storeName: "Synthetic",
            businessDate: new Date(`2026-07-0${index + 1}`),
            objectKey,
            rowCount: 1n,
            byteSize: BigInt(bytes.length),
            checksumSha256,
            confidentialityLevel: 0,
            publishedByJobId: sourceId
          }
        });
      }
      origin = await app.listen({ host: "127.0.0.1", port: 0 });
      const scope = {
        dataset: "dishes" as const,
        enterpriseName: "Synthetic",
        startDate: "2026-07-01",
        endDate: "2026-07-03"
      };
      // Neither metadata route may create capabilities without an official session.
      for (const route of ["partition-manifests", "partition-downloads"]) {
        const denied = await fetch(`${origin}/v1/structured/${route}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(scope)
        });
        expect(denied.status).toBe(401);
        await denied.body?.cancel();
      }
      expect(capabilities.size).toBe(0);
      const evidence = await comparePartitionDownloads({
        context: {
          serviceUrl: origin,
          accessToken: session.accessToken,
          launcherVersion: LAUNCHER_VERSION,
          fetchImplementation: fetch
        },
        scope,
        amountColumn: "amount",
        expected: { partitionCount: 3, rowCount: 3, amountCents: 8575 },
        build: async (requestId) => {
          const run = await worker.claimNextProcessingRun({
            workerId: "comparison",
            leaseSeconds: 60,
            now: new Date()
          });
          expect(run?.partitionDownloadRequestId).toBe(requestId);
          expect(await runtime.job.process({ run: run!, storage })).toBe("succeeded");
        }
      });
      expect(evidence.legacy).toMatchObject({
        apiRequests: 1,
        payloadHttpRequests: 3,
        transferOperations: 3
      });
      expect(evidence.zip).toMatchObject({
        apiRequests: 3,
        payloadHttpRequests: 1,
        transferOperations: 1
      });
      expect(new Set(evidence.csvHashes).size).toBe(3);
      process.stdout.write(
        `${JSON.stringify({ event: "synthetic-partition-comparison", ...evidence })}\n`
      );
    } finally {
      if (credential) await auth.logout(credential);
      await app.close();
      await runtime.disconnect();
      await worker.disconnect?.();
      if (ownsOrganization) {
        await prisma.authSecurityEvent.deleteMany({ where: { orgId } });
        await prisma.oAuthAccessToken.deleteMany({ where: { orgId } });
        await prisma.authSession.deleteMany({ where: { orgId } });
        await prisma.loginIdentity.deleteMany({ where: { orgId } });
        await prisma.auditLog.deleteMany({ where: { orgId } });
        await prisma.storageGarbage.deleteMany({
          where: { objectKey: { startsWith: `partition-downloads/${orgId}/` } }
        });
        await prisma.processingRun.deleteMany({ where: { orgId } });
        await prisma.partitionDownloadRequest.deleteMany({ where: { orgId } });
        await prisma.structuredPartition.deleteMany({ where: { orgId } });
        await prisma.partitionImportJob.deleteMany({ where: { orgId } });
        await prisma.employee.deleteMany({ where: { orgId } });
        await prisma.organization.deleteMany({ where: { id: orgId } });
      }
      await prisma.$disconnect();
      await rm(scratch, { recursive: true, force: true });
    }
  }, 30_000);
});
