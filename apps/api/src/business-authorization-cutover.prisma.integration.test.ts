import { randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { canReadResource } from "@smedc/domain";
import {
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
const orgId = `cut_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
const actorId = `${orgId}_admin`;
const ownership = {
  business: "store",
  dishes: "store",
  vip: "group",
  dish_catalog: "group",
  supplier_catalog: "group",
  delivery_ledger: "store",
  quarantine_certificate: "store",
  ledger_pdf: "store"
} as const;
suite("atomic tenant authorization cutover", () => {
  const prisma = new PrismaClient({ adapter: createDatabaseAdapter(url) });
  const repository = createBusinessAuthorizationRepository({ prisma });
  const service = createAuthorizationCutoverService(repository);
  const actor = { orgId, employeeId: actorId };
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
  beforeAll(async () => {
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
    await repository.initializeOrganization(orgId);
    for (const key of Object.keys(ownership) as Array<keyof typeof ownership>)
      await repository.configureCategory({ ...(await context()), ...category(key) });
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
