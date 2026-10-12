import type { StorageAdapter } from "@smedc/storage";
import { randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createDatabaseAdapter,
  enqueueStorageGarbage,
  listDueStorageGarbage,
  storageGarbageKeyHash,
  createPrismaStructuredPartitionRepository,
  createBusinessAuthorizationRepository,
  getSourceReadRequirements,
  toResourceReadRequirement,
  persistResourceAttributes
} from "@smedc/db";
import {
  createPrismaProcessingWorkerRepository,
  ProcessingLeaseLostError,
  runWorkerOnce
} from "../../../apps/worker/src/worker.js";
import { canReadResource } from "@smedc/domain";
import { createPrismaLedgerDeliveryRepository } from "./delivery.js";
import { createPrismaLedgerSourceReader } from "./source-reader.js";
import { ledgerNeedsRepair } from "./reconciliation.js";
import { createPrismaLedgerArchiveRepository } from "./repository.js";
import { createPrismaLedgerPublicationArchive, type PublishLedgerPdfInput } from "./publication.js";
const enabled = process.env["RUN_LEDGER_PRISMA_INTEGRATION"] === "1";
const databaseUrl = process.env["DATABASE_URL"] ?? "";
if (enabled) {
  const url = new URL(databaseUrl);
  if (
    !["localhost", "127.0.0.1"].includes(url.hostname) ||
    (!url.pathname.includes("ledger_test") &&
      !/^\/smedc_integration_[a-f0-9]{32}$/.test(url.pathname))
  )
    throw new Error("Local synthetic ledger_test required");
}
(enabled ? describe : describe.skip)("fenced ledger publication and exact garbage", () => {
  const orgId = `ledger_pub_${randomUUID().slice(0, 8)}`;
  const prisma = new PrismaClient({ adapter: createDatabaseAdapter(databaseUrl) });
  const competing = new PrismaClient({ adapter: createDatabaseAdapter(databaseUrl) });
  const archive = createPrismaLedgerArchiveRepository({ prisma });
  const publication = createPrismaLedgerPublicationArchive({ prisma });
  const worker = createPrismaProcessingWorkerRepository(databaseUrl);
  const otherWorker = createPrismaProcessingWorkerRepository(databaseUrl);
  const garbageKeys: string[] = [];
  let sourceId: string;
  const sourceChecksum = "a".repeat(64);
  const date = "2026-10-01";
  beforeAll(async () => {
    await prisma.organization.create({ data: { id: orgId, name: "Synthetic publication" } });
    const employee = await prisma.employee.create({
      data: {
        orgId,
        email: `${orgId}@example.invalid`,
        displayName: "Synthetic",
        role: "admin",
        clearance: 3
      }
    });
    const source = await prisma.document.create({
      data: {
        orgId,
        uploaderId: employee.id,
        title: "Synthetic source",
        documentType: "raw_material",
        status: "active",
        documentKind: "structured",
        fileType: "csv",
        storageObjectKey: `synthetic/${orgId}/source`,
        checksumSha256: sourceChecksum,
        byteSize: 10n,
        confidentialityLevel: 1
      }
    });
    sourceId = source.id;
    await prisma.importBatch.create({
      data: {
        orgId,
        sourceDocumentId: source.id,
        dataset: "delivery_ledger",
        idempotencyKey: `${orgId}-source`,
        requestFingerprint: "e".repeat(64),
        status: "applied",
        appliedRowCount: 1,
        totalRowCount: 1
      }
    });
  });
  afterAll(async () => {
    await prisma.storageGarbage.deleteMany({ where: { objectKey: { in: garbageKeys } } });
    await prisma.auditLog.deleteMany({ where: { orgId } });
    await prisma.businessAuthorizationAudit.deleteMany({ where: { orgId } });
    await prisma.processingRun.deleteMany({ where: { orgId } });
    await prisma.ledgerPdfSource.deleteMany({ where: { orgId } });
    await prisma.ledgerArtifactRequestItem.deleteMany({ where: { orgId } });
    await prisma.ledgerArtifactRequest.deleteMany({ where: { orgId } });
    await prisma.ledgerPdfPartition.deleteMany({ where: { orgId } });
    await prisma.businessGrant.deleteMany({ where: { orgId } });
    await prisma.businessResource.deleteMany({ where: { orgId } });
    await prisma.businessCategory.deleteMany({ where: { orgId } });
    await prisma.businessStore.deleteMany({ where: { orgId } });
    await prisma.deliveryLedgerRow.deleteMany({ where: { orgId } });
    await prisma.quarantineCertificate.deleteMany({ where: { orgId } });
    await prisma.importBatch.deleteMany({ where: { orgId } });
    await prisma.document.deleteMany({ where: { orgId } });
    await prisma.employee.deleteMany({ where: { orgId } });
    await prisma.businessAuthorizationState.deleteMany({ where: { orgId } });
    await prisma.organization.delete({ where: { id: orgId } });
    await Promise.all([
      prisma.$disconnect(),
      competing.$disconnect(),
      worker.disconnect?.(),
      otherWorker.disconnect?.()
    ]);
  });
  async function reserve(storeName: string) {
    const result = await archive.reserveRefresh({
      orgId,
      actor: { kind: "operator", label: "synthetic" },
      idempotencyKey: randomUUID(),
      requestFingerprint: "b".repeat(64),
      scope: { storeNames: [storeName], dates: [date] },
      keys: [{ orgId, storeName, purchaseDate: date }]
    });
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
        lockedBy: "synthetic-worker",
        lockedUntil: new Date(Date.now() + 120_000)
      }
    });
    const candidateKey = `synthetic/${orgId}/${randomUUID()}.pdf`;
    garbageKeys.push(candidateKey);
    const input: PublishLedgerPdfInput = {
      partitionId: item.partitionId,
      generation: item.generation,
      dataRevision: 0,
      sourceFingerprint: "f".repeat(64),
      leaseToken: { runId: run.id, lockedBy: "synthetic-worker", attemptNumber: 1 },
      candidate: {
        objectKey: candidateKey,
        byteSize: 10,
        checksumSha256: "d".repeat(64),
        pageCount: 1
      },
      sources: [
        {
          sourceDocumentId: sourceId,
          kind: "ledger",
          confidentialityLevel: 1,
          checksumSha256: sourceChecksum
        }
      ],
      rowCount: 1,
      certificateCount: 0
    };
    await publication.registerCandidate({
      orgId,
      leaseToken: input.leaseToken,
      objectKey: candidateKey
    });
    return { item, run, input };
  }
  it("atomically publishes, replaces old PDF, and empty revokes only derived state", async () => {
    const first = await reserve("Atomic");
    expect(await publication.publishLedgerPdf(first.input)).toBe("published");
    expect(
      await prisma.storageGarbage.findUnique({
        where: { objectKeyHash: storageGarbageKeyHash(first.input.candidate!.objectKey) }
      })
    ).toBeNull();
    const second = await reserve("Atomic");
    expect(await publication.publishLedgerPdf(second.input)).toBe("published");
    expect(
      await prisma.storageGarbage.findUnique({
        where: { objectKeyHash: storageGarbageKeyHash(first.input.candidate!.objectKey) }
      })
    ).toMatchObject({ reason: "ledger_pdf_replaced" });
    const empty = await reserve("Atomic");
    expect(
      await publication.publishLedgerPdf({
        ...empty.input,
        candidate: null,
        sources: [],
        rowCount: 0
      })
    ).toBe("published");
    expect(
      await prisma.ledgerPdfPartition.findUnique({ where: { id: first.item.partitionId } })
    ).toMatchObject({ currentObjectKey: null, rowCount: 0 });
    expect(await prisma.document.count({ where: { orgId, id: sourceId } })).toBe(1);
    expect(await prisma.importBatch.count({ where: { orgId, sourceDocumentId: sourceId } })).toBe(
      1
    );
  });
  it("new generation finishes first and old attempt cannot overwrite it", async () => {
    const old = await reserve("Generation");
    const current = await reserve("Generation");
    expect(await publication.publishLedgerPdf(current.input)).toBe("published");
    expect(await publication.publishLedgerPdf(old.input)).toBe("superseded");
    expect(
      await prisma.ledgerPdfPartition.findUnique({ where: { id: old.item.partitionId } })
    ).toMatchObject({
      currentObjectKey: current.input.candidate!.objectKey,
      publishedGeneration: current.item.generation
    });
    expect(await listDueStorageGarbage(prisma, new Date(), 1000)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ objectKey: old.input.candidate!.objectKey })
      ])
    );
  });
  it("same-generation revision change requeues its job and the next attempt publishes fresh data", async () => {
    const previous = await reserve("Revision");
    await publication.publishLedgerPdf(previous.input);
    const value = await reserve("Revision");
    await prisma.ledgerPdfPartition.update({
      where: { id: value.item.partitionId },
      data: { dataRevision: { increment: 1 } }
    });
    const now = new Date();
    await prisma.processingRun.update({
      where: { id: value.run.id },
      data: {
        status: "queued",
        attemptNumber: 0,
        lockedBy: null,
        lockedUntil: null,
        availableAt: new Date(0),
        priority: -101
      }
    });
    const latestKey = `synthetic/${orgId}/${randomUUID()}.pdf`;
    garbageKeys.push(latestKey);
    const handler = {
      async process({
        run
      }: {
        run: { id: string; lockedBy: string | null; attemptNumber: number };
      }) {
        const leaseToken = {
          runId: run.id,
          lockedBy: run.lockedBy!,
          attemptNumber: run.attemptNumber
        };
        if (run.attemptNumber === 1)
          return publication.publishLedgerPdf({ ...value.input, leaseToken });
        const current = await prisma.ledgerPdfPartition.findUniqueOrThrow({
          where: { id: value.item.partitionId }
        });
        await publication.registerCandidate({ orgId, leaseToken, objectKey: latestKey });
        return publication.publishLedgerPdf({
          ...value.input,
          leaseToken,
          dataRevision: current.dataRevision,
          candidate: { ...value.input.candidate!, objectKey: latestKey }
        });
      }
    };
    const input = {
      repository: worker,
      storage: {} as StorageAdapter,
      ledgerJobs: { ledger_pdf_generate: handler },
      workerId: "synthetic-worker",
      retryBaseMs: 1
    };
    expect(await runWorkerOnce({ ...input, now: () => now })).toMatchObject({
      status: "retry_scheduled"
    });
    expect(
      await prisma.processingRun.findUniqueOrThrow({ where: { id: value.run.id } })
    ).toMatchObject({
      status: "retry_scheduled",
      attemptNumber: 1,
      errorCode: "LEDGER_SOURCE_CHANGED"
    });
    expect(
      await prisma.ledgerArtifactRequestItem.findUniqueOrThrow({ where: { id: value.item.id } })
    ).toMatchObject({ status: "queued", generation: value.item.generation });
    expect(
      await prisma.ledgerPdfPartition.findUniqueOrThrow({ where: { id: value.item.partitionId } })
    ).toMatchObject({ currentObjectKey: previous.input.candidate!.objectKey });
    expect(await runWorkerOnce({ ...input, now: () => new Date(now.getTime() + 5) })).toMatchObject(
      { status: "active" }
    );
    expect(
      await prisma.processingRun.findUniqueOrThrow({ where: { id: value.run.id } })
    ).toMatchObject({
      status: "succeeded",
      attemptNumber: 2,
      ledgerArtifactRequestItemId: value.item.id
    });
    expect(
      await prisma.ledgerPdfPartition.findUniqueOrThrow({ where: { id: value.item.partitionId } })
    ).toMatchObject({
      currentObjectKey: latestKey,
      publishedDataRevision: 1,
      publishedGeneration: value.item.generation
    });
  });
  it("invalid source rolls back publication and preserves its candidate registration", async () => {
    const previous = await reserve("Invalid");
    await publication.publishLedgerPdf(previous.input);
    const value = await reserve("Invalid");
    await prisma.document.update({
      where: { id: sourceId },
      data: { status: "processing_failed" }
    });
    await expect(publication.publishLedgerPdf(value.input)).rejects.toThrow(
      "LEDGER_SOURCE_CHANGED"
    );
    expect(
      await prisma.ledgerPdfPartition.findUnique({ where: { id: value.item.partitionId } })
    ).toMatchObject({ currentObjectKey: previous.input.candidate!.objectKey });
    expect(
      await prisma.storageGarbage.findUnique({
        where: { objectKeyHash: storageGarbageKeyHash(value.input.candidate!.objectKey) }
      })
    ).not.toBeNull();
    await prisma.document.update({ where: { id: sourceId }, data: { status: "active" } });
  });
  it("protects live uploads even after delay, retains exact long/case keys and tombstones", async () => {
    const value = await reserve("Garbage");
    const keys = [
      `synthetic/${orgId}/${"X".repeat(800)}`,
      `synthetic/${orgId}/Case`,
      `synthetic/${orgId}/case`,
      `synthetic/${orgId}/case `
    ];
    garbageKeys.push(...keys);
    for (const objectKey of keys)
      await enqueueStorageGarbage(prisma, { objectKey, reason: "synthetic" });
    await enqueueStorageGarbage(prisma, {
      objectKey: value.input.candidate!.objectKey,
      reason: "ledger_upload_candidate",
      processingRunId: value.run.id,
      availableAt: new Date(0)
    });
    const due = await listDueStorageGarbage(prisma, new Date(), 1000);
    expect(due.map((item) => item.objectKey)).toEqual(expect.arrayContaining(keys));
    expect(due.map((item) => item.objectKey)).not.toContain(value.input.candidate!.objectKey);
    await prisma.processingRun.update({
      where: { id: value.run.id },
      data: { lockedUntil: new Date(0) }
    });
    const expired = await listDueStorageGarbage(prisma, new Date(), 1000);
    const candidate = expired.find((item) => item.objectKey === value.input.candidate!.objectKey)!;
    expect(candidate).toBeDefined();
    await createPrismaStructuredPartitionRepository({ prisma }).deleteGarbage(candidate.id);
    expect(await prisma.storageGarbage.findUnique({ where: { id: candidate.id } })).toMatchObject({
      repeatDeletion: true
    });
  });
  it("two expired-run reclaimers elect one attempt and stale failure with reused workerId cannot mutate it", async () => {
    // Keep only this run claimable within the shared synthetic organization.
    await prisma.processingRun.updateMany({
      where: { orgId, status: "running" },
      data: { status: "failed", lockedBy: null, lockedUntil: null }
    });
    const value = await reserve("Reclaim");
    const now = new Date();
    await prisma.processingRun.update({
      where: { id: value.run.id },
      data: {
        lockedUntil: new Date(now.getTime() - 1000),
        availableAt: new Date("1900-01-01"),
        priority: -100
      }
    });
    const result = await Promise.all([
      worker.claimNextProcessingRun({ workerId: "synthetic-worker", now, leaseSeconds: 120 }),
      otherWorker.claimNextProcessingRun({ workerId: "synthetic-worker", now, leaseSeconds: 120 })
    ]);
    expect(result.filter(Boolean)).toHaveLength(1);
    const winner = result.find(Boolean)!;
    expect(winner.id).toBe(value.run.id);
    expect(winner.attemptNumber).toBe(2);
    await expect(
      worker.failProcessingRun({
        runId: value.run.id,
        attemptNumber: 1,
        documentId: value.run.id,
        workerId: "synthetic-worker",
        now,
        errorCode: "STALE",
        errorSummary: "synthetic stale",
        willRetry: false,
        nextAvailableAt: now
      })
    ).rejects.toBeInstanceOf(ProcessingLeaseLostError);
    await expect(publication.publishLedgerPdf(value.input)).rejects.toThrow(
      "PROCESSING_LEASE_LOST"
    );
    expect(await prisma.processingRun.findUnique({ where: { id: value.run.id } })).toMatchObject({
      status: "running",
      attemptNumber: 2
    });
  });
  it("keeps single-store PDF grants independent and invalidates business photo changes", async () => {
    const source = await prisma.document.findUniqueOrThrow({ where: { id: sourceId } });
    const batch = await prisma.importBatch.findUniqueOrThrow({
      where: { sourceDocumentId: sourceId }
    });
    const reader = createPrismaLedgerSourceReader({ prisma });
    const key = { orgId, storeName: "Product", purchaseDate: date };
    await prisma.document.update({
      where: { id: sourceId },
      data: { sourceMetadata: { enterpriseKey: "enterprise" }, confidentialityLevel: 3 }
    });
    await prisma.businessCategory.createMany({
      data: ["delivery_ledger", "quarantine_certificate", "ledger_pdf", "supplier_catalog"].map(
        (name) => ({
          orgId,
          id: name,
          key: name,
          name,
          kind: "fixed",
          confidentialityLevel: name === "delivery_ledger" ? null : name === "ledger_pdf" ? 0 : 3,
          allowStore: name !== "supplier_catalog",
          allowGroup: name === "supplier_catalog"
        })
      )
    });
    await prisma.businessStore.createMany({
      data: ["Product", "Other"].map((name) => ({ orgId, enterpriseKey: "enterprise", name }))
    });
    const scope = {
      enterpriseKey: "enterprise",
      ownership: "store" as const,
      storeName: key.storeName,
      dimensions: {}
    };
    await prisma.$transaction((tx) =>
      persistResourceAttributes(tx, {
        orgId,
        id: "ledger-fragment",
        kind: "source_fragment",
        resourceKey: sourceId,
        categoryId: "delivery_ledger",
        valid: true,
        sourceDocumentId: sourceId,
        scopes: [scope]
      })
    );
    await prisma.deliveryLedgerRow.create({
      data: {
        orgId,
        sourceDocumentId: sourceId,
        importBatchId: batch.id,
        sourceRowNumber: 1,
        payload: {
          receipt_id: "R-P",
          store_name: key.storeName,
          purchase_date: date,
          item_name: "Rice",
          purchase_quantity: "1",
          purchase_amount: "2"
        }
      }
    });
    const owner = await prisma.employee.create({
      data: {
        orgId,
        email: `${orgId}-pdf@example.invalid`,
        displayName: "PDF owner",
        role: "employee",
        clearance: 0
      }
    });
    await prisma.businessGrant.create({
      data: {
        orgId,
        id: "pdf-grant",
        employeeId: owner.id,
        enterpriseKey: "enterprise",
        ownership: "store",
        allStores: false
      }
    });
    await prisma.businessGrantCategory.create({
      data: { orgId, grantId: "pdf-grant", categoryId: "ledger_pdf" }
    });
    await prisma.businessGrantStore.create({
      data: { orgId, grantId: "pdf-grant", enterpriseKey: "enterprise", storeName: key.storeName }
    });
    const photoId = randomUUID().replaceAll("-", "");
    await prisma.document.create({
      data: {
        id: photoId,
        orgId,
        uploaderId: source.uploaderId,
        title: "Synthetic photo",
        documentType: "raw_material",
        documentKind: "quarantine_certificate",
        status: "active",
        fileType: "png",
        storageObjectKey: "synthetic-photo.png",
        checksumSha256: sourceChecksum,
        byteSize: 10n,
        contentType: "image/png",
        confidentialityLevel: 3
      }
    });
    await prisma.quarantineCertificate.create({
      data: {
        orgId,
        sourceDocumentId: photoId,
        receiptId: "R-P",
        idempotencyKey: "photo-p",
        requestFingerprint: sourceChecksum
      }
    });
    const photoAttributes = {
      orgId,
      id: "photo-resource",
      kind: "quarantine_certificate" as const,
      resourceKey: photoId,
      documentId: photoId,
      categoryId: "quarantine_certificate",
      valid: true,
      scopes: [scope]
    };
    await prisma.$transaction((tx) => persistResourceAttributes(tx, photoAttributes));
    await prisma.businessAuthorizationState.update({ where: { orgId }, data: { mode: "enabled" } });
    const snapshot = await reader.readLedgerSnapshot(key);
    expect(snapshot.certificates.map((photo) => photo.sourceDocumentId)).toEqual([photoId]);
    const reserved = await reserve(key.storeName);
    await publication.publishLedgerPdf({
      ...reserved.input,
      sources: snapshot.sources,
      sourceFingerprint: snapshot.sourceFingerprint,
      certificateCount: 1,
      candidate: { ...reserved.input.candidate!, pageCount: 2 }
    });
    const requirement = await prisma.businessResource.findUniqueOrThrow({
      where: {
        orgId_kind_resourceKey: {
          orgId,
          kind: "ledger_pdf",
          resourceKey: reserved.item.partitionId
        }
      },
      include: { scopes: true }
    });
    expect(requirement).toMatchObject({
      categoryId: "ledger_pdf",
      valid: true,
      scopes: [{ storeName: key.storeName, enterpriseKey: "enterprise" }]
    });
    const authorization = await createBusinessAuthorizationRepository({
      prisma
    }).loadAuthorizationSnapshot(owner.id, orgId);
    expect(
      (await getSourceReadRequirements(prisma, sourceId, orgId)).every(
        (value) => canReadResource(authorization, value).allowed
      )
    ).toBe(false);
    const photoResource = await prisma.businessResource.findUniqueOrThrow({
      where: { orgId_id: { orgId, id: photoAttributes.id } },
      include: { scopes: { include: { dimensions: true } } }
    });
    expect(canReadResource(authorization, toResourceReadRequirement(photoResource)).allowed).toBe(
      false
    );
    const delivery = createPrismaLedgerDeliveryRepository({
      prisma,
      storage: {
        headObject: async () => ({
          state: "found",
          size: 10,
          hash: reserved.input.candidate!.checksumSha256
        })
      } as unknown as StorageAdapter
    });
    const requestedScope = { storeNames: [key.storeName], dates: [date] };
    expect((await delivery.facts(owner, requestedScope))[0]?.status).toBe("ready");
    // This candidate represents the completed render from the dimension-free snapshot above.
    const late = await reserve(key.storeName);
    const renderedCandidate = {
      ...late.input,
      sources: snapshot.sources,
      sourceFingerprint: snapshot.sourceFingerprint,
      certificateCount: 1,
      candidate: { ...late.input.candidate!, pageCount: 2 }
    };
    const permissions = createBusinessAuthorizationRepository({ prisma });
    const currentVersion = async () =>
      (
        await prisma.businessAuthorizationState.findUniqueOrThrow({ where: { orgId } })
      ).version.toString();
    const dimensionId = "unregistered-source-dimension";
    await permissions.defineDimension({
      orgId,
      actorId: source.uploaderId,
      expectedVersion: await currentVersion(),
      id: dimensionId,
      name: "Unregistered source dimension"
    });
    const category = {
      orgId,
      actorId: source.uploaderId,
      id: "delivery_ledger",
      key: "delivery_ledger",
      name: "delivery_ledger",
      kind: "fixed" as const,
      confidentialityLevel: 3,
      ownerships: ["store" as const]
    };
    await permissions.configureCategory({
      ...category,
      expectedVersion: await currentVersion(),
      requiredDimensionIds: [dimensionId]
    });
    try {
      const publicationState = () =>
        Promise.all([
          prisma.ledgerPdfPartition.findUniqueOrThrow({
            where: { id: late.item.partitionId },
            include: { sources: true }
          }),
          prisma.businessResource.findUniqueOrThrow({
            where: { orgId_id: { orgId, id: requirement.id } },
            include: { scopes: { include: { dimensions: true } } }
          }),
          prisma.businessAuthorizationState.findUniqueOrThrow({ where: { orgId } }),
          prisma.processingRun.findUniqueOrThrow({ where: { id: late.run.id } }),
          prisma.ledgerArtifactRequestItem.findUniqueOrThrow({ where: { id: late.item.id } }),
          prisma.ledgerArtifactRequest.findUniqueOrThrow({ where: { id: late.item.requestId } }),
          prisma.auditLog.findMany({ where: { orgId }, orderBy: { id: "asc" } }),
          prisma.businessAuthorizationAudit.findMany({ where: { orgId }, orderBy: { id: "asc" } }),
          prisma.storageGarbage.findMany({
            where: {
              objectKey: {
                in: [reserved.input.candidate!.objectKey, late.input.candidate!.objectKey]
              }
            },
            orderBy: { id: "asc" }
          })
        ]);
      const before = await publicationState();
      expect(before[0]).toMatchObject({ currentObjectKey: reserved.input.candidate!.objectKey });
      await expect(publication.publishLedgerPdf(renderedCandidate)).rejects.toThrow(
        "RESOURCE_ATTRIBUTES_NOT_READY"
      );
      expect(await publicationState()).toEqual(before);
    } finally {
      await permissions.configureCategory({
        ...category,
        expectedVersion: await currentVersion(),
        requiredDimensionIds: []
      });
      await prisma.businessDimension.delete({ where: { orgId_id: { orgId, id: dimensionId } } });
    }
    expect((await delivery.facts(owner, requestedScope))[0]?.status).toBe("ready");
    await prisma.document.update({ where: { id: photoId }, data: { confidentialityLevel: 0 } });
    await prisma.businessCategory.update({
      where: { orgId_id: { orgId, id: "quarantine_certificate" } },
      data: { confidentialityLevel: 0 }
    });
    expect((await reader.readLedgerSourceMetadata(key)).sourceFingerprint).toBe(
      snapshot.sourceFingerprint
    );
    expect((await delivery.facts(owner, requestedScope))[0]?.status).toBe("ready");
    await prisma.$transaction((tx) =>
      persistResourceAttributes(tx, {
        ...photoAttributes,
        scopes: [{ ...scope, storeName: "Other" }]
      })
    );
    const changed = await reader.readLedgerSourceMetadata(key);
    expect(changed.sourceFingerprint).not.toBe(snapshot.sourceFingerprint);
    const pointer = await prisma.ledgerPdfPartition.findUniqueOrThrow({
      where: { id: reserved.item.partitionId }
    });
    expect(ledgerNeedsRepair(pointer, changed)).toBe(true);
    expect((await delivery.facts(owner, requestedScope))[0]?.status).toBe("stale");
    const rejected = await reserve(key.storeName);
    await expect(
      publication.publishLedgerPdf({
        ...rejected.input,
        sources: snapshot.sources,
        sourceFingerprint: snapshot.sourceFingerprint,
        certificateCount: 1,
        candidate: { ...rejected.input.candidate!, pageCount: 2 }
      })
    ).rejects.toThrow("LEDGER_SOURCE_CHANGED");
    expect((await delivery.facts(owner, requestedScope))[0]?.status).toBe("stale");
    await prisma.document.update({
      where: { id: photoId },
      data: { status: "archived", archivedAt: new Date() }
    });
    const withoutPhoto = await reader.readLedgerSnapshot(key);
    expect(withoutPhoto.certificates).toEqual([]);
    const repaired = await reserve(key.storeName);
    await publication.publishLedgerPdf({
      ...repaired.input,
      sources: withoutPhoto.sources,
      sourceFingerprint: withoutPhoto.sourceFingerprint
    });
    expect((await delivery.facts(owner, requestedScope))[0]?.status).toBe("ready");
    const replacementId = randomUUID().replaceAll("-", "");
    await prisma.document.create({
      data: {
        id: replacementId,
        orgId,
        uploaderId: source.uploaderId,
        title: "Replacement photo",
        documentType: "raw_material",
        documentKind: "quarantine_certificate",
        status: "active",
        fileType: "png",
        storageObjectKey: "synthetic-new-photo.png",
        checksumSha256: sourceChecksum,
        byteSize: 10n,
        contentType: "image/png",
        confidentialityLevel: 3
      }
    });
    await prisma.quarantineCertificate.create({
      data: {
        orgId,
        sourceDocumentId: replacementId,
        receiptId: "R-P",
        idempotencyKey: "photo-replacement",
        requestFingerprint: sourceChecksum
      }
    });
    await prisma.$transaction((tx) =>
      persistResourceAttributes(tx, {
        ...photoAttributes,
        id: "replacement-photo-resource",
        resourceKey: replacementId,
        documentId: replacementId
      })
    );
    expect(
      (await reader.readLedgerSnapshot(key)).certificates.map((photo) => photo.sourceDocumentId)
    ).toEqual([replacementId]);
    expect((await delivery.facts(owner, requestedScope))[0]?.status).toBe("stale");
  });
});
