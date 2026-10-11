import { randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDatabaseAdapter } from "@smedc/db";
import { ledgerStoreNameHash } from "./keys.js";
import { createPrismaLedgerSourceReader } from "./source-reader.js";
import { createPrismaLedgerArtifactAccess } from "./access.js";
import { createPrismaLedgerDeliveryRepository } from "./delivery.js";
import type { StorageAdapter } from "@smedc/storage";
import { lockLedgerSourceMutation, markLedgerPartitionsChanged } from "./changes.js";
import { createPrismaQuarantineCertificateRepository } from "../../../apps/api/src/quarantine-certificates.js";
import { createPrismaDocumentCatalogRepository } from "../../../apps/api/src/documents.js";
import { createPrismaStructuredImportRepository } from "../../../apps/api/src/structured-imports.js";
import { createPrismaProcessingWorkerRepository } from "../../../apps/worker/src/worker.js";
const enabled = process.env["RUN_LEDGER_PRISMA_INTEGRATION"] === "1";
const databaseUrl = process.env["DATABASE_URL"] ?? "";
if (enabled) {
  const url = new URL(databaseUrl);
  if (
    !["localhost", "127.0.0.1"].includes(url.hostname) ||
    (!url.pathname.includes("ledger_test") &&
      !/^\/smedc_integration_[a-f0-9]{32}$/.test(url.pathname))
  )
    throw new Error("Local synthetic ledger_test database required");
}
(enabled ? describe : describe.skip)("ledger snapshots and source mutation transactions", () => {
  const orgId = `snapshot_${randomUUID().slice(0, 8)}`;
  const actor = {
    id: `${orgId}_admin`,
    orgId,
    role: "admin" as const,
    clearance: 3,
    disabled: false,
    organizationName: "Synthetic",
    displayName: "Synthetic",
    email: `${orgId}@example.invalid`
  };
  const low = { ...actor, id: `${orgId}_low`, clearance: 0, email: `${orgId}_low@example.invalid` };
  const key = { orgId, storeName: "Synthetic Shop ", purchaseDate: "2026-10-04" };
  const checksum = "a".repeat(64);
  const audit = {
    requestId: `${orgId}_request`,
    sourceIp: "127.0.0.1",
    clientSource: "http_api" as const,
    launcherVersion: null
  };
  let prisma: PrismaClient;
  let reader: ReturnType<typeof createPrismaLedgerSourceReader>;
  let certificates: ReturnType<typeof createPrismaQuarantineCertificateRepository>;
  let documents: ReturnType<typeof createPrismaDocumentCatalogRepository>;
  let imports: ReturnType<typeof createPrismaStructuredImportRepository>;
  let worker: ReturnType<typeof createPrismaProcessingWorkerRepository>;
  beforeAll(async () => {
    prisma = new PrismaClient({ adapter: createDatabaseAdapter(databaseUrl) });
    reader = createPrismaLedgerSourceReader({ prisma });
    certificates = createPrismaQuarantineCertificateRepository(databaseUrl);
    documents = createPrismaDocumentCatalogRepository(databaseUrl);
    imports = createPrismaStructuredImportRepository({
      databaseUrl,
      batchInsertSize: 500,
      transactionTimeoutMs: 30_000
    });
    worker = createPrismaProcessingWorkerRepository(databaseUrl);
    await prisma.organization.create({ data: { id: orgId, name: "Synthetic ledger snapshot" } });
    await prisma.employee.createMany({
      data: [actor, low].map(({ id, email, clearance }) => ({
        id,
        email,
        clearance,
        orgId,
        displayName: "Synthetic",
        role: "admin"
      }))
    });
  });
  afterAll(async () => {
    const where = { orgId };
    await prisma.auditLog.deleteMany({ where });
    await prisma.processingRun.deleteMany({ where });
    await prisma.ledgerPdfSource.deleteMany({ where });
    await prisma.ledgerPdfPartition.deleteMany({ where });
    await prisma.quarantineCertificate.deleteMany({ where });
    await prisma.deliveryLedgerRow.deleteMany({ where });
    await prisma.supplierCatalogRow.deleteMany({ where });
    await prisma.importBatch.deleteMany({ where });
    await prisma.businessResource.deleteMany({ where });
    await prisma.businessCategory.deleteMany({ where });
    await prisma.businessStore.deleteMany({ where });
    await prisma.businessAuthorizationState.deleteMany({ where });
    await prisma.document.deleteMany({ where });
    await prisma.employee.deleteMany({ where });
    await prisma.organization.delete({ where: { id: orgId } });
    await Promise.all([
      prisma.$disconnect(),
      certificates.disconnect?.(),
      documents.disconnect?.(),
      imports.disconnect?.(),
      worker.disconnect?.()
    ]);
  });
  async function photo(receiptId: string, suffix: string, clearance = 0, actorId = actor.id) {
    return certificates.createCertificate({
      orgId,
      actorEmployeeId: actorId,
      sourceDocumentId: `${orgId}_${suffix}`,
      title: "Synthetic photo",
      receiptId,
      idempotencyKey: suffix,
      requestFingerprint: checksum,
      fileType: "png",
      storageObjectKey: `synthetic/${suffix}`,
      originalFileName: "synthetic.png",
      contentType: "image/png",
      byteSize: 12,
      checksumSha256: checksum,
      confidentialityLevel: clearance,
      audit
    });
  }
  async function fact(receiptId: string, storeName = key.storeName, workerPublish = false) {
    const sourceDocumentId = `${orgId}_${receiptId}`;
    await prisma.document.create({
      data: {
        id: sourceDocumentId,
        orgId,
        uploaderId: actor.id,
        title: "Synthetic receipt",
        documentType: "raw_material",
        documentKind: "structured",
        fileType: "xlsx",
        status: "pending_processing",
        confidentialityLevel: receiptId === "R2" ? 2 : 0,
        storageObjectKey: `synthetic/${receiptId}`,
        checksumSha256: checksum
      }
    });
    const batch = await prisma.importBatch.create({
      data: {
        orgId,
        sourceDocumentId,
        dataset: "delivery_ledger",
        idempotencyKey: receiptId,
        naturalKey: receiptId,
        requestFingerprint: checksum,
        status: workerPublish ? "applying" : "pending"
      }
    });
    const rows = [
      {
        sourceSheetIndex: 0,
        sourceSheetName: "Sheet1",
        sourceRowNumber: 2,
        payload: {
          receipt_id: receiptId,
          store_name: storeName,
          purchase_date: key.purchaseDate,
          item_name: "Rice",
          purchase_quantity: "1.234567890123456789",
          purchase_amount: "2.00",
          specification: "null",
          supplier_name: "Supplier"
        }
      }
    ];
    if (workerPublish) {
      const now = new Date();
      const run = await prisma.processingRun.create({
        data: {
          orgId,
          documentId: sourceDocumentId,
          jobKey: `${orgId}:worker`,
          jobType: "structured_import",
          status: "running",
          lockedBy: "synthetic",
          lockedUntil: new Date(now.getTime() + 60_000)
        }
      });
      await worker.completeStructuredImport?.({
        runId: run.id,
        attemptNumber: run.attemptNumber,
        documentId: sourceDocumentId,
        importBatchId: batch.id,
        dataset: "delivery_ledger",
        workerId: "synthetic",
        now,
        batchInsertSize: 500,
        result: {
          rows,
          sheetSummary: [],
          ignoredSheets: [],
          validationErrors: [],
          validationErrorCount: 0,
          validationErrorsTruncated: false
        }
      });
      return batch;
    }
    const applied = await imports.applyReservedStructuredImport({
      orgId,
      actorEmployeeId: actor.id,
      importBatchId: batch.id,
      rows,
      audit
    });
    expect(applied.affectedLedgerPartitions).toEqual([{ ...key, storeName }]);
    const revision = (await reader.readLedgerSnapshot({ ...key, storeName })).dataRevision;
    await imports.applyReservedStructuredImport({
      orgId,
      actorEmployeeId: actor.id,
      importBatchId: batch.id,
      rows,
      audit
    });
    expect((await reader.readLedgerSnapshot({ ...key, storeName })).dataRevision).toBe(revision);
    return batch;
  }
  it("includes a photo uploaded before receipt import, accumulates same-day receipts, and excludes archived photos", async () => {
    const early = await photo("R1", "early");
    expect(early.affectedLedgerPartitions).toEqual([]);
    await fact("R1");
    const first = await reader.readLedgerSnapshot(key);
    expect(first.rows).toHaveLength(1);
    expect(first.certificates.map((row) => row.sourceDocumentId)).toEqual([early.sourceDocumentId]);
    expect(first.dataRevision).toBe(1);
    await fact("R2", key.storeName, true);
    const second = await reader.readLedgerSnapshot(key);
    expect(second.rows.map((row) => row.receipt_id)).toEqual(["R1", "R2"]);
    expect(second.dataRevision).toBe(2);
    expect(second.rows[0]?.specification).toBeNull();
    expect(second.rows[0]?.purchase_quantity).toBe("1.234567890123456789");
    expect(
      await createPrismaLedgerArtifactAccess({ prisma }).canReadLedgerArtifact({
        key,
        orgId,
        employee: low,
        sources: second.sources
      })
    ).toBe(false);
    const later = await photo("R2", "later", 0, low.id);
    expect(later.affectedLedgerPartitions).toEqual([]);
    expect((await reader.readLedgerSnapshot(key)).dataRevision).toBe(3);
    const replay = await certificates.findByIdempotencyKey(orgId, "later", low.id);
    expect(replay?.affectedLedgerPartitions).toEqual([]);
    expect((await reader.readLedgerSnapshot(key)).dataRevision).toBe(3);
    await documents.archiveDocument({
      orgId,
      documentId: early.sourceDocumentId,
      actorEmployeeId: actor.id,
      audit
    });
    const archived = await reader.readLedgerSnapshot(key);
    expect(archived.certificates.map((row) => row.sourceDocumentId)).toEqual([
      later.sourceDocumentId
    ]);
    expect(archived.dataRevision).toBe(4);
    await documents.archiveDocument({
      orgId,
      documentId: early.sourceDocumentId,
      actorEmployeeId: actor.id,
      audit
    });
    expect((await reader.readLedgerSnapshot(key)).dataRevision).toBe(4);
    expect(
      await createPrismaLedgerArtifactAccess({ prisma }).canReadLedgerArtifact({
        key,
        orgId,
        employee: actor,
        sources: first.sources
      })
    ).toBe(false);
    const result = await certificates.archiveBySourceDocumentId({
      orgId,
      sourceDocumentId: later.sourceDocumentId,
      employee: actor,
      audit
    });
    expect(result).toEqual({ archivedCount: 1, affectedLedgerPartitions: [key] });
    expect((await reader.readLedgerSnapshot(key)).dataRevision).toBe(5);
    await photo("R1", "bulk");
    expect(
      await certificates.archiveByReceiptId({ orgId, receiptId: "R1", employee: actor, audit })
    ).toEqual({ archivedCount: 1, affectedLedgerPartitions: [key] });
    expect((await reader.readLedgerSnapshot(key)).dataRevision).toBe(7);
    expect(
      await certificates.archiveByReceiptId({ orgId, receiptId: "R2", employee: actor, audit })
    ).toEqual({ archivedCount: 0, affectedLedgerPartitions: [] });
  });
  it("rejects reusing an applied receipt with different content and returns stable replay partition hints", async () => {
    const reservation = {
      orgId,
      actorEmployeeId: actor.id,
      documentId: `${orgId}_conflict`,
      dataset: "delivery_ledger" as const,
      fileType: "xlsx" as const,
      idempotencyKey: "receipt-replay",
      naturalKey: "R1",
      startDate: null,
      endDate: null,
      requestFingerprint: checksum,
      document: {
        title: "Synthetic",
        storageObjectKey: "synthetic/replay",
        originalFileName: "synthetic.xlsx",
        byteSize: 1,
        checksumSha256: checksum,
        confidentialityLevel: 0
      },
      sourceSheetSummary: [],
      totalRowCount: 1,
      audit
    };
    const replay = await imports.reserveStructuredImport(reservation);
    expect(replay.state).toBe("existing");
    expect(replay.importBatch.affectedLedgerPartitions).toEqual([key]);
    await expect(
      imports.reserveStructuredImport({ ...reservation, requestFingerprint: "b".repeat(64) })
    ).rejects.toMatchObject({ code: "RECEIPT_ID_CONFLICT" });
    expect((await reader.readLedgerSnapshot(key)).dataRevision).toBe(7);
  });

  it("serializes receipt publication and simultaneous photo mapping across two clients", async () => {
    const concurrentKey = { ...key, storeName: "Concurrent Synthetic" };
    const docId = `${orgId}_concurrent`;
    let release!: () => void;
    let entered!: () => void;
    const ready = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const finish = new Promise<void>((resolve) => {
      release = resolve;
    });
    const publication = prisma.$transaction(async (tx) => {
      await lockLedgerSourceMutation(tx, orgId);
      await tx.document.create({
        data: {
          id: docId,
          orgId,
          uploaderId: actor.id,
          title: "Synthetic concurrent receipt",
          documentType: "raw_material",
          documentKind: "structured",
          fileType: "xlsx",
          status: "active",
          storageObjectKey: "synthetic/concurrent",
          checksumSha256: checksum
        }
      });
      const batch = await tx.importBatch.create({
        data: {
          orgId,
          sourceDocumentId: docId,
          dataset: "delivery_ledger",
          idempotencyKey: "RC",
          requestFingerprint: checksum,
          status: "applied",
          appliedAt: new Date()
        }
      });
      await tx.deliveryLedgerRow.create({
        data: {
          orgId,
          sourceDocumentId: docId,
          importBatchId: batch.id,
          sourceRowNumber: 2,
          payload: {
            receipt_id: "RC",
            store_name: concurrentKey.storeName,
            purchase_date: key.purchaseDate,
            item_name: "Rice",
            purchase_quantity: "1.00",
            purchase_amount: "2.00"
          }
        }
      });
      await markLedgerPartitionsChanged(tx, [concurrentKey]);
      entered();
      await finish;
    });
    await ready;
    let photoCompleted = false;
    const upload = photo("RC", "cp").then((result) => {
      photoCompleted = true;
      return result;
    });
    try {
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(photoCompleted).toBe(false);
    } finally {
      release();
    }
    await publication;
    const uploaded = await upload;
    expect(uploaded.affectedLedgerPartitions).toEqual([concurrentKey]);
    const snapshot = await reader.readLedgerSnapshot(concurrentKey);
    expect(snapshot.dataRevision).toBe(2);
    expect(snapshot.rows).toHaveLength(1);
    expect(snapshot.certificates.map((value) => value.sourceDocumentId)).toEqual([
      uploaded.sourceDocumentId
    ]);
  });

  it("keeps exact case/trailing-space partitions and paginates facts without index dependence", async () => {
    await fact("R3", "Synthetic Shop");
    await fact("R4", "synthetic shop");
    await prisma.ledgerPdfPartition.deleteMany({
      where: {
        orgId,
        storeNameHash: {
          not: ledgerStoreNameHash(key.storeName)
        }
      }
    });
    const page = await reader.listLedgerFactPartitions({ orgId, limit: 2 });
    expect(page.keys).toHaveLength(2);
    expect(page.nextCursor).not.toBeNull();
    const next = await reader.listLedgerFactPartitions({
      orgId,
      limit: 2,
      cursor: page.nextCursor!
    });
    expect([...page.keys, ...next.keys].map((row) => row.storeName)).toEqual([
      "Concurrent Synthetic",
      "Synthetic Shop",
      "Synthetic Shop ",
      "synthetic shop"
    ]);
    await expect(
      reader.listLedgerFactPartitions({ orgId: "another", limit: 2, cursor: page.nextCursor! })
    ).rejects.toThrow("LEDGER_CURSOR_INVALID");
  });
  it("uses only unique exact suppliers, excludes catalog content from fingerprints and validates photo metadata", async () => {
    const original = await reader.readLedgerSnapshot(key);
    const supplierId = `${orgId}_sup`;
    await prisma.document.create({
      data: {
        id: supplierId,
        orgId,
        uploaderId: actor.id,
        title: "Supplier",
        documentType: "raw_material",
        documentKind: "structured",
        fileType: "xlsx",
        status: "active",
        confidentialityLevel: 3,
        storageObjectKey: "synthetic/supplier",
        checksumSha256: checksum
      }
    });
    const batch = await prisma.importBatch.create({
      data: {
        orgId,
        sourceDocumentId: supplierId,
        dataset: "supplier_catalog",
        idempotencyKey: "supplier",
        requestFingerprint: checksum,
        status: "applied",
        appliedAt: new Date()
      }
    });
    await prisma.supplierCatalogRow.createMany({
      data: [
        { supplier_name: "Supplier", unit_address: "Address", contact_phone: "null" },
        { supplier_name: "supplier", unit_address: "lowercase" },
        { supplier_name: "Supplier ", unit_address: "trailing" }
      ].map((payload, index) => ({
        orgId,
        sourceDocumentId: supplierId,
        importBatchId: batch.id,
        sourceRowNumber: index + 2,
        payload
      }))
    });
    const enriched = await reader.readLedgerSnapshot(key);
    expect(enriched.rows[0]).toMatchObject({
      supplier_unit_address: "Address",
      supplier_contact_phone: null
    });
    expect(enriched.confidentialityLevel).toBe(3);
    expect(enriched.sourceFingerprint).toBe(original.sourceFingerprint);
    expect(enriched.dataRevision).toBe(original.dataRevision);
    await prisma.supplierCatalogRow.create({
      data: {
        orgId,
        sourceDocumentId: supplierId,
        importBatchId: batch.id,
        sourceRowNumber: 5,
        payload: { supplier_name: "Supplier", unit_address: "Duplicate" }
      }
    });
    const duplicate = await reader.readLedgerSnapshot(key);
    expect(duplicate.rows[0]?.supplier_unit_address).toBeNull();
    expect(duplicate.sources.some((source) => source.kind === "supplier")).toBe(false);
    expect(duplicate.sourceFingerprint).toBe(original.sourceFingerprint);
    await documents.archiveDocument({
      orgId,
      documentId: supplierId,
      actorEmployeeId: actor.id,
      audit
    });
    expect(
      await createPrismaLedgerArtifactAccess({ prisma }).canReadLedgerArtifact({
        key,
        orgId,
        employee: actor,
        sources: enriched.sources
      })
    ).toBe(false);
    const bad = await photo("R1", "invalid");
    await prisma.document.update({ where: { id: bad.sourceDocumentId }, data: { byteSize: null } });
    await expect(reader.readLedgerSnapshot(key)).rejects.toThrow("LEDGER_SOURCE_METADATA_INVALID");
    await prisma.document.update({
      where: { id: bad.sourceDocumentId },
      data: { byteSize: 12n, status: "archived", archivedAt: new Date() }
    });
    await prisma.$transaction((tx) => markLedgerPartitionsChanged(tx, [key, key]));
    expect((await reader.readLedgerSnapshot(key)).dataRevision).toBe(original.dataRevision + 2);
  });
  it("covers many ready days with bounded source scans and preserves exact names, visibility, and object checks", async () => {
    const stores = [
      "Batch Shop",
      "batch shop",
      "Batch Shop ",
      ...Array.from({ length: 18 }, (_, i) => `Batch ${i}`)
    ];
    const snapshots = [];
    for (const [index, storeName] of stores.entries()) {
      const receiptId = `B${index}`;
      await fact(receiptId, storeName);
      if (index === 0) {
        const row = await prisma.deliveryLedgerRow.findFirstOrThrow({
          where: { orgId, sourceDocumentId: `${orgId}_${receiptId}` }
        });
        await prisma.deliveryLedgerRow.create({
          data: {
            orgId,
            sourceDocumentId: row.sourceDocumentId,
            importBatchId: row.importBatchId,
            sourceRowNumber: 3,
            payload: row.payload!
          }
        });
        await photo(receiptId, "batch-visible");
        await photo(receiptId, "batch-hidden", 3);
      }
      const snapshot = await reader.readLedgerSnapshot({ ...key, storeName });
      snapshots.push(snapshot);
      const published = await prisma.ledgerPdfPartition.update({
        where: {
          orgId_storeNameHash_purchaseDate: {
            orgId,
            storeNameHash: ledgerStoreNameHash(storeName),
            purchaseDate: new Date(key.purchaseDate + "T00:00:00Z")
          }
        },
        data: {
          publishedGeneration: 1,
          publishedDataRevision: snapshot.dataRevision,
          publishedSourceFingerprint: snapshot.sourceFingerprint,
          currentObjectKey: `synthetic/batch-${index}.pdf`,
          checksumSha256: checksum,
          byteSize: 12
        }
      });
      await prisma.ledgerPdfSource.createMany({
        data: snapshot.sources.map(
          ({ sourceDocumentId, kind, confidentialityLevel, checksumSha256 }) => ({
            orgId,
            partitionId: published.id,
            sourceDocumentId,
            kind,
            confidentialityLevel,
            checksumSha256
          })
        )
      });
    }
    let sourceScans = 0;
    const measured = prisma.$extends({
      query: {
        $allOperations({ operation, args, query }) {
          if (operation === "$queryRaw") sourceScans++;
          return query(args);
        }
      }
    });
    let activeHeads = 0;
    let peakHeads = 0;
    const storage = {
      async headObject(objectKey: string) {
        activeHeads++;
        peakHeads = Math.max(peakHeads, activeHeads);
        await new Promise((resolve) => setTimeout(resolve, 5));
        activeHeads--;
        return objectKey === "synthetic/batch-20.pdf"
          ? { state: "found", size: 12, hash: "b".repeat(64) }
          : { state: "found", size: 12, hash: checksum };
      }
    } as StorageAdapter;
    const delivery = createPrismaLedgerDeliveryRepository({
      prisma: measured as unknown as PrismaClient,
      storage
    });
    const facts = await delivery.facts(actor, { storeNames: stores, dates: [key.purchaseDate] });
    expect(facts).toHaveLength(21);
    expect(facts.filter((fact) => fact.status === "ready")).toHaveLength(20);
    expect(facts.find((fact) => fact.key.storeName === "Batch 17")?.status).toBe("missing");
    for (const snapshot of snapshots) {
      const result = facts.find((fact) => fact.key.storeName === snapshot.key.storeName);
      if (result?.status === "ready")
        expect(result.entry?.sourceFingerprint).toBe(snapshot.sourceFingerprint);
    }
    // A per-key source scan regresses the public coverage path beyond the launcher timeout.
    expect(sourceScans).toBeLessThanOrEqual(12);
    expect(peakHeads).toBeGreaterThan(1);
    expect(peakHeads).toBeLessThanOrEqual(4);
    const hiddenPhotoId = `${orgId}_batch-hidden`;
    await prisma.document.update({ where: { id: hiddenPhotoId }, data: { byteSize: null } });
    const visible = await delivery.facts(low, { storeNames: stores, dates: [key.purchaseDate] });
    expect(visible).toHaveLength(20);
    expect(visible.some((fact) => fact.key.storeName === "Batch Shop")).toBe(false);
    await prisma.employee.update({ where: { id: actor.id }, data: { disabled: true } });
    expect(await delivery.facts(actor, { storeNames: stores, dates: [key.purchaseDate] })).toEqual(
      []
    );
    await prisma.employee.update({ where: { id: actor.id }, data: { disabled: false } });
  }, 15_000);
});
