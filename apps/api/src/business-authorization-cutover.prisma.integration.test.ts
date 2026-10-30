import { readFile } from "node:fs/promises";
import Fastify from "fastify";
import { registerBusinessAuthorizationRoutes } from "./routes/business-authorization.js";
import { createBusinessAuthorizationService } from "./business-authorization.js";
import type { RequestAuth } from "./request-auth.js";
import { createPrismaAuthOperatorRepository } from "./auth/prisma-auth-operator-repository.js";
import { randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { canReadResource, FIXED_BUSINESS_CATEGORY_OWNERSHIP } from "@smedc/domain";
import {
  initializeFixedBusinessCategories,
  createDatabaseAdapter,
  createBusinessAuthorizationRepository,
  lockAuthorizationPublication,
  persistStructuredSourceReadRequirements,
  createPrismaPartitionDownloadRepository
} from "@smedc/db";
import {
  createAuthorizationCutoverService,
  AUTHORIZATION_READ_ADAPTERS
} from "./business-authorization-cutover.js";
import { createPrismaSourceDocumentRepository } from "./source-documents.js";
const run = process.env["RUN_BUSINESS_AUTHORIZATION_PRISMA_INTEGRATION"] === "1";
const url = process.env["DATABASE_URL"] ?? "";
if (run) {
  const parsed = new URL(url);
  if (
    !["localhost", "127.0.0.1"].includes(parsed.hostname) ||
    !/^\/smedc_integration_[a-f0-9]{32}$/.test(parsed.pathname) ||
    parsed.search ||
    parsed.hash
  )
    throw new Error("Cutover tests require a runner-owned loopback integration database");
}
const suite = run ? describe : describe.skip;
let orgId: string;
let actorId: string;
const ownership = FIXED_BUSINESS_CATEGORY_OWNERSHIP;
suite("fixed category bootstrap through supported administration", () => {
  const prisma = new PrismaClient({ adapter: createDatabaseAdapter(url) });
  afterAll(() => prisma.$disconnect());
  it("migrates existing tenants without overwriting choices, then configures and activates using HTTP", async () => {
    const orgId = `init_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
    const actorId = `${orgId}_admin`;
    await prisma.organization.create({ data: { id: orgId, name: "Synthetic existing tenant" } });
    await prisma.employee.create({
      data: {
        id: actorId,
        orgId,
        email: `${actorId}@example.invalid`,
        displayName: "Admin",
        role: "admin",
        clearance: 3
      }
    });
    await prisma.businessAuthorizationState.create({ data: { orgId, version: 5n } });
    const existing = await prisma.businessCategory.create({
      data: {
        orgId,
        id: "existing-pdf-id",
        key: "ledger_pdf",
        name: "Existing PDF name",
        kind: "fixed",
        confidentialityLevel: 2,
        allowGroup: false,
        allowStore: true,
        retired: true
      }
    });
    // Exercise the shipped migration against populated tables (the runner initially migrates an empty schema).
    const migration = await readFile(
      new URL(
        "../../../packages/db/prisma/migrations/20261011110000_initialize_fixed_business_categories/migration.sql",
        import.meta.url
      ),
      "utf8"
    );
    for (const sql of migration.split(";").filter((statement) => statement.trim()))
      await prisma.$executeRawUnsafe(sql);
    const repository = createBusinessAuthorizationRepository({ prisma });
    const migrated = await repository.listCategories(orgId);
    expect(migrated.map((c) => [c.key, c.allowGroup ? "group" : "store"]).sort()).toEqual(
      Object.entries(ownership)
        .filter(
          ([key]) =>
            !["cost_cards", "store_reviews", "in_store_orders", "takeaway_orders"].includes(key)
        )
        .sort()
    );
    expect(migrated.find((c) => c.key === "ledger_pdf")).toMatchObject(existing);
    expect(
      migrated.filter((c) => c.key !== "ledger_pdf").every((c) => c.confidentialityLevel === null)
    ).toBe(true);
    expect(await prisma.businessGrant.count({ where: { orgId } })).toBe(0);
    expect(await prisma.businessAuthorizationState.findUnique({ where: { orgId } })).toMatchObject({
      mode: "legacy",
      version: 6n
    });
    expect(
      (await repository.initializeFixedCategories({ orgId, actorId, expectedVersion: "6" })).value
        .createdCount
    ).toBe(4);
    const initialized = await repository.listCategories(orgId);
    expect(
      initialized.find((category) => category.key === "cost_cards")?.confidentialityLevel
    ).toBeNull();
    expect(initialized.find((category) => category.key === "in_store_orders")).toMatchObject({
      confidentialityLevel: null,
      allowGroup: false,
      allowStore: true
    });
    expect(await prisma.businessGrant.count({ where: { orgId } })).toBe(0);
    await prisma.$transaction(async (tx) => {
      await lockAuthorizationPublication(tx, orgId);
      expect((await initializeFixedBusinessCategories(tx, orgId)).count).toBe(0);
    });
    expect(await repository.listCategories(orgId)).toEqual(initialized);
    const app = Fastify();
    registerBusinessAuthorizationRoutes(app, {
      auth: {
        authenticate: async () => true,
        employee: () => ({ id: actorId, orgId })
      } as unknown as RequestAuth,
      permissions: () => createBusinessAuthorizationService(repository)
    });
    try {
      const before = await repository.loadAuthorizationSnapshot(actorId, orgId);
      const listed = (await app.inject({ url: "/v1/admin/permissions/categories" })).json();
      const report = (await app.inject({ url: "/v1/admin/permissions/cutover" })).json();
      expect(report.ready).toBe(false);
      expect(report.missing).toHaveLength(10);
      expect(report.missing).toContainEqual({
        code: "FIXED_CATEGORY_CLEARANCE_REQUIRED",
        targetId: "cost_cards"
      });
      expect(report.missing).not.toContainEqual({
        code: "FIXED_CATEGORY_CLEARANCE_REQUIRED",
        targetId: "delivery_ledger"
      });
      expect(await repository.loadAuthorizationSnapshot(actorId, orgId)).toEqual(before);
      expect(
        (
          await app.inject({
            method: "POST",
            url: "/v1/admin/permissions/cutover/activate",
            payload: { expectedVersion: report.authorizationVersion, confirm: true }
          })
        ).statusCode
      ).toBe(409);
      let version = listed.authorizationVersion;
      for (const category of initialized.filter((category) => category.key !== "delivery_ledger")) {
        const result = await app.inject({
          method: "PATCH",
          url: `/v1/admin/permissions/categories/${category.id}`,
          payload: { expectedVersion: version, name: category.name, confidentialityLevel: 1 }
        });
        expect(result.statusCode).toBe(200);
        version = result.json().authorizationVersion;
      }
      expect((await app.inject({ url: "/v1/admin/permissions/cutover" })).json()).toMatchObject({
        ready: true,
        authorizationVersion: version
      });
      expect(
        (
          await app.inject({
            method: "POST",
            url: "/v1/admin/permissions/cutover/activate",
            payload: { expectedVersion: version, confirm: true }
          })
        ).statusCode
      ).toBe(200);
      expect((await repository.loadAuthorizationSnapshot(actorId, orgId)).mode).toBe("enabled");
      expect(
        (await repository.listCategories(orgId)).find(
          (category) => category.key === "delivery_ledger"
        )?.confidentialityLevel
      ).toBeNull();
      expect(await prisma.businessGrant.count({ where: { orgId } })).toBe(0);
    } finally {
      await app.close();
    }
  });
  it("initializes a post-migration tenant during account onboarding without levels, grants or activation", async () => {
    const orgId = `new_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
    await prisma.organization.create({ data: { id: orgId, name: "Synthetic new tenant" } });
    const operator = createPrismaAuthOperatorRepository(prisma);
    const input = {
      orgId,
      normalizedEmail: `${orgId}@example.invalid`,
      displayName: "Admin",
      role: "admin" as const,
      clearance: 3,
      grantTokenHash: "synthetic-bootstrap-hash",
      grantExpiresAt: new Date(Date.now() + 60000),
      now: new Date()
    };
    const account = await operator.onboard(input);
    const repository = createBusinessAuthorizationRepository({ prisma });
    const categories = await repository.listCategories(orgId);
    expect(categories.map((c) => c.key).sort()).toEqual(Object.keys(ownership).sort());
    expect(categories.every((c) => c.confidentialityLevel === null)).toBe(true);
    expect(await repository.loadAuthorizationSnapshot(account.employeeId, orgId)).toMatchObject({
      mode: "legacy",
      grants: []
    });
    await operator.onboard({
      ...input,
      normalizedEmail: `${orgId}_second@example.invalid`,
      grantTokenHash: "synthetic-bootstrap-second-hash"
    });
    expect(await repository.listCategories(orgId)).toEqual(categories);
  });
});

suite("atomic tenant authorization cutover", () => {
  const prisma = new PrismaClient({ adapter: createDatabaseAdapter(url) });
  const repository = createBusinessAuthorizationRepository({ prisma });
  const service = createAuthorizationCutoverService(repository);
  let actor: { orgId: string; employeeId: string };
  const snapshot = () => repository.loadAuthorizationSnapshot(actorId, orgId);
  const context = async () => ({
    orgId,
    actorId,
    expectedVersion: (await snapshot()).authorizationVersion
  });
  const category = (key: keyof typeof ownership) => ({
    id: key,
    key,
    name: key,
    kind: "fixed" as const,
    confidentialityLevel: 1,
    ownerships: [ownership[key]],
    requiredDimensionIds: []
  });
  beforeEach(async () => {
    orgId = `cut_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
    actorId = `${orgId}_admin`;
    actor = { orgId, employeeId: actorId };
    await prisma.organization.create({ data: { id: orgId, name: "Synthetic cutover" } });
    await prisma.employee.create({
      data: {
        id: actorId,
        orgId,
        email: `${orgId}@example.invalid`,
        displayName: "Admin",
        role: "admin",
        clearance: 3
      }
    });
    await prisma.businessAuthorizationState.create({ data: { orgId } });
    for (const key of Object.keys(ownership) as Array<keyof typeof ownership>)
      await repository.configureCategory({ ...(await context()), ...category(key) });
  });
  afterEach(async () => {
    await prisma.partitionDownloadRequest.deleteMany({ where: { orgId } });
    await prisma.document.updateMany({
      where: { orgId, documentKind: "evidence" },
      data: { status: "archived", archivedAt: new Date() }
    });
  });
  afterAll(() => prisma.$disconnect());
  it("prepares without writes and refuses incomplete adapter activation with no partial version or mode change", async () => {
    const before = await snapshot();
    expect(await service.prepareAuthorizationCutover(orgId)).toMatchObject({
      ready: true,
      authorizationVersion: before.authorizationVersion,
      mode: "legacy"
    });
    const incomplete = createAuthorizationCutoverService(
      repository,
      AUTHORIZATION_READ_ADAPTERS.slice(1)
    );
    await expect(
      incomplete.activateAuthorizationCutover(actor, before.authorizationVersion, true)
    ).rejects.toThrow("AUTHORIZATION_CUTOVER_NOT_READY");
    expect(await snapshot()).toEqual(before);
  });
  it("does not enable or advance the version when synchronous inspection outlives its transaction", async () => {
    const before = await snapshot();
    await expect(
      repository.activateAuthorizationCutover({ ...(await context()), confirm: true }, async () => {
        // Reproduce CPU-heavy inspection starving Prisma's transaction timeout callback.
        const until = performance.now() + 5500;
        while (performance.now() < until) {
          /* synchronous inspection */
        }
        return { ready: true };
      })
    ).rejects.toThrow();
    expect(await snapshot()).toEqual(before);
    expect(
      await prisma.businessAuthorizationAudit.count({
        where: { orgId, action: "authorization.cutover.activate", outcome: "succeeded" }
      })
    ).toBe(0);
    expect(
      await prisma.businessAuthorizationAudit.count({
        where: { orgId, action: "authorization.cutover.activate", outcome: "denied" }
      })
    ).toBe(1);
  }, 15000);
  it("rejects prepared versions after category, grant and import publication changes", async () => {
    let prepared = await service.prepareAuthorizationCutover(orgId);
    await repository.configureCategory({
      ...(await context()),
      ...category("vip"),
      confidentialityLevel: 2
    });
    await expect(
      service.activateAuthorizationCutover(actor, prepared.authorizationVersion, true)
    ).rejects.toThrow("AUTHORIZATION_VERSION_CONFLICT");
    prepared = await service.prepareAuthorizationCutover(orgId);
    await repository.configureAccount({
      ...(await context()),
      employeeId: actorId,
      clearance: 3,
      grants: []
    });
    await expect(
      service.activateAuthorizationCutover(actor, prepared.authorizationVersion, true)
    ).rejects.toThrow("AUTHORIZATION_VERSION_CONFLICT");
    prepared = await service.prepareAuthorizationCutover(orgId);
    await prisma.$transaction(async (tx) => {
      const sourceDocumentId = randomUUID().replaceAll("-", "");
      await tx.document.create({
        data: {
          id: sourceDocumentId,
          orgId,
          title: "Synthetic parsed source",
          documentType: "structured_dataset",
          documentKind: "structured",
          status: "active",
          storageObjectKey: `synthetic/${sourceDocumentId}`,
          uploaderId: actorId,
          sourceMetadata: { enterpriseKey: "enterprise" }
        }
      });
      await tx.importBatch.create({
        data: {
          id: sourceDocumentId,
          orgId,
          sourceDocumentId,
          dataset: "vip",
          idempotencyKey: sourceDocumentId,
          requestFingerprint: "b".repeat(64),
          status: "applied"
        }
      });
      await persistStructuredSourceReadRequirements(tx, {
        orgId,
        sourceDocumentId,
        dataset: "vip",
        rows: [{ payload: { card_store_name: "B", recharge_store_name: "A" } }],
        workerId: "synthetic-cutover-worker"
      });
    });
    await expect(
      service.activateAuthorizationCutover(actor, prepared.authorizationVersion, true)
    ).rejects.toThrow("AUTHORIZATION_VERSION_CONFLICT");
    expect((await snapshot()).mode).toBe("legacy");
  });
  it("rechecks the current same-tenant active admin in the enabling transaction", async () => {
    const before = await snapshot();
    await prisma.employee.update({ where: { id: actorId }, data: { role: "employee" } });
    await expect(
      service.activateAuthorizationCutover(actor, before.authorizationVersion, true)
    ).rejects.toThrow("AUTHORIZATION_ADMIN_REQUIRED");
    await prisma.employee.update({ where: { id: actorId }, data: { role: "admin" } });
    await prisma.organization.create({
      data: { id: `${orgId}_foreign`, name: "Synthetic other tenant" }
    });
    await expect(
      service.activateAuthorizationCutover(
        { orgId: `${orgId}_foreign`, employeeId: actorId },
        "0",
        true
      )
    ).rejects.toThrow("AUTHORIZATION_ADMIN_REQUIRED");
    expect((await snapshot()).authorizationVersion).toBe(before.authorizationVersion);
    expect(
      await prisma.businessAuthorizationState.findUnique({ where: { orgId: `${orgId}_foreign` } })
    ).toBeNull();
  });
  it("reports missing existing document attributes and atomically refuses activation", async () => {
    const documentId = randomUUID().replaceAll("-", "");
    await prisma.$transaction(async (tx) => {
      await lockAuthorizationPublication(tx, orgId);
      await tx.document.create({
        data: {
          id: documentId,
          orgId,
          title: "Synthetic memo",
          documentType: "management_knowledge",
          documentKind: "evidence",
          status: "active",
          storageObjectKey: `synthetic/${documentId}`,
          uploaderId: actorId
        }
      });
    });
    const report = await service.prepareAuthorizationCutover(orgId);
    expect(report.missing).toContainEqual({
      code: "DOCUMENT_ATTRIBUTES_REQUIRED",
      targetId: documentId
    });
    await expect(
      service.activateAuthorizationCutover(actor, report.authorizationVersion, true)
    ).rejects.toThrow("AUTHORIZATION_CUTOVER_NOT_READY");
    expect((await snapshot()).authorizationVersion).toBe(report.authorizationVersion);
    await prisma.document.delete({ where: { id: documentId } });
  });
  it("requests during an enabling transaction retain one consistent old snapshot and new requests see only enabled", async () => {
    const before = await snapshot();
    let enter!: () => void;
    let release!: () => void;
    const entered = new Promise<void>((resolve) => {
      enter = resolve;
    });
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const activation = repository.activateAuthorizationCutover(
      { ...(await context()), confirm: true },
      async () => {
        enter();
        await held;
        return { ready: true };
      }
    );
    await entered;
    try {
      expect(await snapshot()).toEqual(before);
    } finally {
      release();
    }
    await activation;
    const after = await snapshot();
    expect(after.mode).toBe("enabled");
    expect(BigInt(after.authorizationVersion)).toBe(BigInt(before.authorizationVersion) + 1n);
    expect(before.mode).toBe("legacy");
  });

  it("new required dimensions block old documents, originals and grants until explicitly supplemented", async () => {
    await service.activateAuthorizationCutover(
      actor,
      (await snapshot()).authorizationVersion,
      true
    );
    const documentId = randomUUID().replaceAll("-", "");
    await repository.configureCategory({
      ...(await context()),
      id: "memo",
      name: "Memo",
      kind: "evidence",
      confidentialityLevel: null,
      ownerships: ["group"],
      requiredDimensionIds: []
    });
    await prisma.document.create({
      data: {
        id: documentId,
        orgId,
        title: "Synthetic dimensional memo",
        documentType: "management_knowledge",
        documentKind: "evidence",
        status: "active",
        storageObjectKey: `synthetic/${documentId}`,
        uploaderId: actorId
      }
    });
    const baseScope = { enterpriseKey: "enterprise", ownership: "group" as const, dimensions: {} };
    await repository.configureEvidenceDocument({
      ...(await context()),
      documentId,
      categoryId: "memo",
      fileConfidentialityLevel: 1,
      scopes: [baseScope]
    });
    const grant = {
      id: "memo-grant",
      orgId,
      enterpriseKey: "enterprise",
      categoryIds: ["memo"],
      ownership: "group" as const,
      dimensions: {}
    };
    await repository.configureAccount({
      ...(await context()),
      employeeId: actorId,
      clearance: 3,
      grants: [grant]
    });
    const originals = createPrismaSourceDocumentRepository(url);
    const employee = {
      id: actorId,
      orgId,
      role: "admin" as const,
      clearance: 3,
      disabled: false,
      displayName: "Admin",
      organizationName: "Synthetic",
      email: "synthetic@example.invalid"
    };
    try {
      expect(
        await originals.findDownloadableSourceDocuments({
          orgId,
          employee,
          sourceDocumentIds: [documentId]
        })
      ).toHaveLength(1);
      await repository.defineDimension({ ...(await context()), id: "project", name: "Project" });
      await repository.defineDimensionValue({
        ...(await context()),
        dimensionId: "project",
        id: "X",
        name: "X"
      });
      await repository.configureCategory({
        ...(await context()),
        id: "memo",
        name: "Memo",
        kind: "evidence",
        confidentialityLevel: null,
        ownerships: ["group"],
        requiredDimensionIds: ["project"]
      });
      const report = await service.prepareAuthorizationCutover(orgId);
      expect(report.ready).toBe(false);
      expect(report.missing.some((i) => i.code === "RESOURCE_ATTRIBUTES_REQUIRED")).toBe(true);
      expect(report.missing.some((i) => i.code === "GRANT_CONFIGURATION_REQUIRED")).toBe(true);
      expect(
        await originals.findDownloadableSourceDocuments({
          orgId,
          employee,
          sourceDocumentIds: [documentId]
        })
      ).toEqual([]);
      await expect(
        service.activateAuthorizationCutover(actor, report.authorizationVersion, true)
      ).rejects.toThrow("AUTHORIZATION_CUTOVER_NOT_READY");
      expect((await snapshot()).mode).toBe("enabled");
      await repository.configureEvidenceDocument({
        ...(await context()),
        documentId,
        categoryId: "memo",
        fileConfidentialityLevel: 1,
        scopes: [{ ...baseScope, dimensions: { project: "X" } }]
      });
      await repository.configureAccount({
        ...(await context()),
        employeeId: actorId,
        clearance: 3,
        grants: [{ ...grant, dimensions: { project: { kind: "all" } } }]
      });
      expect(await service.prepareAuthorizationCutover(orgId)).toMatchObject({ ready: true });
      expect(
        await originals.findDownloadableSourceDocuments({
          orgId,
          employee,
          sourceDocumentIds: [documentId]
        })
      ).toHaveLength(1);
    } finally {
      await originals.disconnect?.();
    }
  });
  it("refuses stale source signing receipts and suspends reading without restoring legacy grants", async () => {
    await service.activateAuthorizationCutover(
      actor,
      (await snapshot()).authorizationVersion,
      true
    );
    const originals = createPrismaSourceDocumentRepository(url);
    const before = await snapshot();
    await repository.configureAccount({
      ...(await context()),
      employeeId: actorId,
      clearance: 2,
      grants: []
    });
    try {
      await expect(
        originals.recordDownloadsIssued({
          orgId,
          employee: {
            id: actorId,
            orgId,
            role: "admin",
            clearance: 3,
            disabled: false,
            displayName: "Admin",
            organizationName: "Synthetic",
            email: "synthetic@example.invalid"
          },
          authorizationVersion: before.authorizationVersion,
          sourceDocumentIds: ["missing"],
          reason: "explicit_request",
          audit: {
            requestId: "synthetic",
            sourceIp: "127.0.0.1",
            clientSource: "http_api",
            launcherVersion: null
          }
        })
      ).rejects.toThrow("AUTHORIZATION_VERSION_CONFLICT");
      await repository.suspendAuthorizationReads({ ...(await context()), confirm: true });
      const paused = await snapshot();
      expect(paused.mode).toBe("suspended");
      expect(
        canReadResource(paused, {
          orgId,
          categoryId: "vip",
          valid: true,
          scopes: [{ enterpriseKey: "enterprise", ownership: "group", dimensions: {} }]
        }).allowed
      ).toBe(false);
      expect(
        await originals.findDownloadableSourceDocuments({
          orgId,
          employee: {
            id: actorId,
            orgId,
            role: "admin",
            clearance: 3,
            disabled: false,
            displayName: "Admin",
            organizationName: "Synthetic",
            email: "synthetic@example.invalid"
          },
          sourceDocumentIds: ["missing"]
        })
      ).toEqual([]);
      await expect(
        service.activateAuthorizationCutover(actor, paused.authorizationVersion, true)
      ).rejects.toThrow("AUTHORIZATION_SUSPENDED");
      expect((await snapshot()).authorizationVersion).toBe(paused.authorizationVersion);
    } finally {
      await originals.disconnect?.();
    }
  });
  it("rejects unknown old download manifests with rebuild guidance without changing successful task state", async () => {
    // A zero-entry old job claiming one partition cannot prove its submitted complete scope.
    await prisma.businessAuthorizationState.update({ where: { orgId }, data: { mode: "enabled" } });
    const id = randomUUID().replaceAll("-", "");
    await prisma.partitionDownloadRequest.create({
      data: {
        id,
        orgId,
        requesterId: actorId,
        idempotencyKey: id,
        requestFingerprint: "a".repeat(64),
        manifestFingerprint: "a".repeat(64),
        scope: {
          dataset: "business",
          enterpriseKey: "enterprise",
          startDate: "2026-10-01",
          endDate: "2026-10-01"
        },
        manifest: [],
        limits: {},
        status: "succeeded",
        partitionCount: 1,
        totalRowCount: 1,
        totalByteSize: 1,
        expiresAt: new Date(Date.now() + 60000)
      }
    });
    const downloads = createPrismaPartitionDownloadRepository({ prisma });
    await expect(
      downloads.issueCurrent(
        { id: actorId, orgId, clearance: 2, disabled: false },
        id,
        async () => "must never sign"
      )
    ).rejects.toThrow("PARTITION_DOWNLOAD_REBUILD_REQUIRED");
    expect(
      await prisma.partitionDownloadRequest.findUniqueOrThrow({ where: { id } })
    ).toMatchObject({ status: "succeeded", errorCode: null });
  });
});
