import { PrismaMariaDb } from "@prisma/adapter-mariadb";
import {
  DocumentKind,
  DocumentStatus,
  DocumentType,
  FileType,
  ImportBatchStatus,
  ImportDataset,
  PrismaClient
} from "@prisma/client";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { compileStructuredQuery } from "@enterprise-hub/domain";
import { createPrismaStructuredQueryRepository } from "./structured-query.js";

const runIntegration = process.env["RUN_STRUCTURED_QUERY_PRISMA_INTEGRATION"] === "1";
const describeIntegration = runIntegration ? describe : describe.skip;
const databaseUrl = process.env["DATABASE_URL"] ?? "";
const orgId = "query-prisma-review-org";
const adminId = "query_prisma_review_admin";
const labeledId = "query_prisma_review_labeled";
const zeroLabelId = "query_prisma_review_zero";
const allStaffLabelId = "query_prisma_review_all";
const visibleLabelId = "query_prisma_review_vis";
const hiddenLabelId = "query_prisma_review_hid";
let documentSequence = 0;
let batchSequence = 0;

describeIntegration("Prisma structured supplier enrichment authorization", () => {
  const prisma = new PrismaClient({ adapter: new PrismaMariaDb(databaseUrl) });

  beforeAll(async () => {
    await removeTestOrganization(prisma);
    await prisma.organization.create({ data: { id: orgId, name: "Query Prisma Review" } });
    await prisma.label.createMany({
      data: [
        { id: allStaffLabelId, orgId, key: "all_staff", name: "All staff", type: "all_staff" },
        { id: visibleLabelId, orgId, key: "store:visible", name: "Visible", type: "store" },
        { id: hiddenLabelId, orgId, key: "store:hidden", name: "Hidden", type: "store" }
      ]
    });
    await prisma.employee.createMany({
      data: [
        {
          id: adminId,
          orgId,
          email: "query-prisma-review-admin@example.invalid",
          displayName: "Query Prisma Review Admin",
          role: "admin"
        },
        {
          id: labeledId,
          orgId,
          email: "query-prisma-review-labeled@example.invalid",
          displayName: "Query Prisma Review Labeled",
          role: "manager"
        },
        {
          id: zeroLabelId,
          orgId,
          email: "query-prisma-review-zero@example.invalid",
          displayName: "Query Prisma Review Zero",
          role: "employee"
        }
      ]
    });
    await prisma.employeeLabel.create({ data: { employeeId: labeledId, labelId: visibleLabelId } });
  });

  beforeEach(async () => {
    await clearTestData(prisma);
  });

  afterAll(async () => {
    await clearTestData(prisma);
    await removeTestOrganization(prisma);
    await prisma.$disconnect();
  });

  it("enforces admin, labeled, and zero-label document authorization without leaking hidden rows", async () => {
    await createLedgerDocument(prisma, {
      suffix: "visible-ledger",
      labels: [allStaffLabelId],
      rows: [{ supplierName: "Visible Supplier", receiptId: "R-visible" }]
    });
    await createLedgerDocument(prisma, {
      suffix: "hidden-ledger",
      labels: [hiddenLabelId],
      rows: [{ supplierName: "Hidden Supplier", receiptId: "R-hidden" }]
    });
    await createCatalog(prisma, {
      suffix: "auth-catalog",
      labels: [allStaffLabelId],
      appliedAt: new Date("2026-08-29T01:00:00.000Z"),
      rows: [
        { supplierName: "Visible Supplier", phone: "138-visible", address: "Address visible" },
        { supplierName: "Hidden Supplier", phone: "138-hidden", address: "Address hidden" }
      ]
    });

    const adminRows = await executeFor(prisma, { id: adminId, role: "admin", labels: [] });
    const labeledRows = await executeFor(prisma, {
      id: labeledId,
      role: "manager",
      labels: ["store:visible"]
    });
    const zeroLabelRows = await executeFor(prisma, {
      id: zeroLabelId,
      role: "employee",
      labels: []
    });

    expect(adminRows).toEqual([
      expect.objectContaining({
        supplier_name: "Hidden Supplier",
        supplier_contact_phone: "138-hidden"
      }),
      expect.objectContaining({
        supplier_name: "Visible Supplier",
        supplier_contact_phone: "138-visible"
      })
    ]);
    expect(labeledRows).toEqual([
      expect.objectContaining({
        supplier_name: "Visible Supplier",
        supplier_contact_phone: "138-visible"
      })
    ]);
    expect(zeroLabelRows).toEqual([
      expect.objectContaining({
        supplier_name: "Visible Supplier",
        supplier_contact_phone: "138-visible"
      })
    ]);
    expect(labeledRows.some((row) => JSON.stringify(row).includes("138-hidden"))).toBe(false);
    expect(zeroLabelRows.some((row) => JSON.stringify(row).includes("138-hidden"))).toBe(false);
  });

  it("requires the exact catalog document lineage for supplier matches", async () => {
    const ledger = await createLedgerDocument(prisma, {
      suffix: "lineage-ledger",
      labels: [allStaffLabelId],
      rows: [
        { supplierName: "Current Supplier", receiptId: "R-current" },
        { supplierName: "Poison Supplier", receiptId: "R-poison" }
      ]
    });
    const catalog = await createCatalog(prisma, {
      suffix: "lineage-catalog",
      labels: [allStaffLabelId],
      appliedAt: new Date("2026-08-29T02:00:00.000Z"),
      rows: [{ supplierName: "Current Supplier", phone: "current", address: "Current address" }]
    });
    const otherDocument = await createDocument(prisma, "lineage-other", [allStaffLabelId]);
    await prisma.supplierCatalogRow.create({
      data: {
        id: "qpr_poison",
        orgId,
        sourceDocumentId: otherDocument.id,
        importBatchId: catalog.batch.id,
        sourceSheetIndex: 0,
        sourceSheetName: "Sheet1",
        sourceRowNumber: 3,
        payload: {
          supplier_name: "Poison Supplier",
          contact_phone: "poison",
          unit_address: "poison"
        }
      }
    });

    const rows = await executeFor(prisma, { id: adminId, role: "admin", labels: [] });
    const current = rows.find((row) => row["supplier_name"] === "Current Supplier");
    const poison = rows.find((row) => row["supplier_name"] === "Poison Supplier");
    expect(current).toMatchObject({ supplier_contact_phone: "current" });
    expect(poison).toMatchObject({ supplier_contact_phone: null, supplier_unit_address: null });
    expect(ledger.id).toBeDefined();
  });

  it.each([
    [
      "inactive",
      { status: DocumentStatus.processing_failed, archivedAt: null, labels: [allStaffLabelId] }
    ],
    [
      "archived",
      {
        status: DocumentStatus.active,
        archivedAt: new Date("2026-08-29T03:00:00.000Z"),
        labels: [allStaffLabelId]
      }
    ],
    ["unauthorized", { status: DocumentStatus.active, archivedAt: null, labels: [hiddenLabelId] }]
  ])("does not fall back when the latest catalog is %s", async (_state, latestDocument) => {
    await createLedgerDocument(prisma, {
      suffix: `latest-${_state}`,
      labels: [allStaffLabelId],
      rows: [{ supplierName: "Head Supplier", receiptId: "R-head" }]
    });
    await createCatalog(prisma, {
      suffix: `older-${_state}`,
      labels: [allStaffLabelId],
      appliedAt: new Date("2026-08-29T04:00:00.000Z"),
      rows: [
        { supplierName: "Head Supplier", phone: `older-${_state}`, address: `older-${_state}` }
      ]
    });
    await createCatalog(prisma, {
      suffix: `newer-${_state}`,
      labels: latestDocument.labels ?? [allStaffLabelId],
      appliedAt: new Date("2026-08-29T05:00:00.000Z"),
      documentStatus: latestDocument.status,
      archivedAt: latestDocument.archivedAt,
      rows: [
        { supplierName: "Head Supplier", phone: `newer-${_state}`, address: `newer-${_state}` }
      ]
    });

    const rows = await executeFor(prisma, {
      id: labeledId,
      role: "manager",
      labels: ["store:visible"]
    });
    expect(rows[0]).toMatchObject({
      supplier_contact_phone: null,
      supplier_unit_address: null
    });
    expect(JSON.stringify(rows)).not.toContain(`older-${_state}`);
    expect(JSON.stringify(rows)).not.toContain(`newer-${_state}`);
  });

  it("resolves the later applied catalog and breaks appliedAt ties by id descending", async () => {
    await createLedgerDocument(prisma, {
      suffix: "order-ledger",
      labels: [allStaffLabelId],
      rows: [{ supplierName: "Order Supplier", receiptId: "R-order" }]
    });
    await createCatalog(prisma, {
      suffix: "order-older",
      labels: [allStaffLabelId],
      appliedAt: new Date("2026-08-29T06:00:00.000Z"),
      rows: [{ supplierName: "Order Supplier", phone: "older", address: "older" }]
    });
    await createCatalog(prisma, {
      suffix: "order-tie-a",
      batchId: "qpr_batch_tie_a",
      labels: [allStaffLabelId],
      appliedAt: new Date("2026-08-29T07:00:00.000Z"),
      rows: [{ supplierName: "Order Supplier", phone: "tie-a", address: "tie-a" }]
    });
    await createCatalog(prisma, {
      suffix: "order-tie-z",
      batchId: "qpr_batch_tie_z",
      labels: [allStaffLabelId],
      appliedAt: new Date("2026-08-29T07:00:00.000Z"),
      rows: [{ supplierName: "Order Supplier", phone: "tie-z", address: "tie-z" }]
    });

    const rows = await executeFor(prisma, { id: adminId, role: "admin", labels: [] });
    expect(rows[0]).toMatchObject({ supplier_contact_phone: "tie-z" });
    expect(JSON.stringify(rows)).not.toContain("older");
    expect(JSON.stringify(rows)).not.toContain("tie-a");
  });

  it("ignores a newer failed or unapplied upload and uses the latest successful one", async () => {
    await createLedgerDocument(prisma, {
      suffix: "failed-newer-ledger",
      labels: [allStaffLabelId],
      rows: [{ supplierName: "Successful Supplier", receiptId: "R-success" }]
    });
    await createCatalog(prisma, {
      suffix: "successful-catalog",
      labels: [allStaffLabelId],
      appliedAt: new Date("2026-08-29T08:00:00.000Z"),
      rows: [{ supplierName: "Successful Supplier", phone: "successful", address: "successful" }]
    });
    await createCatalog(prisma, {
      suffix: "failed-catalog",
      labels: [allStaffLabelId],
      appliedAt: null,
      status: ImportBatchStatus.failed,
      rows: [{ supplierName: "Successful Supplier", phone: "failed", address: "failed" }]
    });

    const rows = await executeFor(prisma, { id: adminId, role: "admin", labels: [] });
    expect(rows[0]).toMatchObject({ supplier_contact_phone: "successful" });
    expect(JSON.stringify(rows)).not.toContain("failed");
  });
});

async function executeFor(
  prisma: PrismaClient,
  employee: { id: string; role: "admin" | "manager" | "employee"; labels: string[] }
) {
  const repository = createPrismaStructuredQueryRepository(databaseUrl);
  const compiled = compileStructuredQuery({
    orgId,
    employee,
    query: {
      dataset: "delivery_ledger",
      select: ["supplier_contact_phone", "supplier_name", "receipt_id", "supplier_unit_address"],
      sort: [{ field: "receipt_id", direction: "asc" }]
    },
    cursorSecret: "query-review-secret"
  });
  const result = await repository.execute(compiled);
  await repository.disconnect?.();
  return result.rows;
}

async function createLedgerDocument(
  prisma: PrismaClient,
  input: {
    suffix: string;
    labels: string[];
    rows: Array<{ supplierName: string; receiptId: string }>;
  }
) {
  const document = await createDocument(prisma, `ledger-${input.suffix}`, input.labels);
  const batch = await prisma.importBatch.create({
    data: {
      id: `qpr_b_${batchSequence++}`,
      orgId,
      sourceDocumentId: document.id,
      dataset: ImportDataset.delivery_ledger,
      startDate: new Date("2026-08-29T00:00:00.000Z"),
      endDate: new Date("2026-08-29T00:00:00.000Z"),
      idempotencyKey: `query-prisma-review-ledger-${input.suffix}`,
      requestFingerprint: input.suffix.padEnd(64, "0").slice(0, 64),
      status: ImportBatchStatus.applied,
      appliedAt: new Date("2026-08-29T00:00:00.000Z")
    }
  });
  await prisma.deliveryLedgerRow.createMany({
    data: input.rows.map((row, index) => ({
      id: `qpr_l_${input.suffix}_${index}`,
      orgId,
      sourceDocumentId: document.id,
      importBatchId: batch.id,
      sourceSheetIndex: 0,
      sourceSheetName: "Sheet1",
      sourceRowNumber: index + 2,
      payload: {
        entry_id: `entry-${input.suffix}-${index}`,
        receipt_id: row.receiptId,
        supplier_name: row.supplierName,
        purchase_date: "2026-08-29",
        store_name: "Review Store"
      }
    }))
  });
  return document;
}

async function createCatalog(
  prisma: PrismaClient,
  input: {
    suffix: string;
    batchId?: string;
    labels: string[];
    appliedAt: Date | null;
    status?: ImportBatchStatus;
    documentStatus?: DocumentStatus;
    archivedAt?: Date | null;
    rows: Array<{ supplierName: string; phone: string; address: string }>;
  }
) {
  const document = await createDocument(
    prisma,
    `catalog-${input.suffix}`,
    input.labels,
    input.documentStatus ?? DocumentStatus.active,
    input.archivedAt ?? null
  );
  const batch = await prisma.importBatch.create({
    data: {
      id: input.batchId ?? `qpr_b_${batchSequence++}`,
      orgId,
      sourceDocumentId: document.id,
      dataset: ImportDataset.supplier_catalog,
      idempotencyKey: `query-prisma-review-catalog-${input.suffix}`,
      requestFingerprint: input.suffix.padEnd(64, "0").slice(0, 64),
      status: input.status ?? ImportBatchStatus.applied,
      appliedAt: input.appliedAt
    }
  });
  await prisma.supplierCatalogRow.createMany({
    data: input.rows.map((row, index) => ({
      id: `qpr_c_${input.suffix}_${index}`,
      orgId,
      sourceDocumentId: document.id,
      importBatchId: batch.id,
      sourceSheetIndex: 0,
      sourceSheetName: "Sheet1",
      sourceRowNumber: index + 2,
      payload: {
        supplier_name: row.supplierName,
        contact_phone: row.phone,
        unit_address: row.address
      }
    }))
  });
  return { document, batch };
}

async function createDocument(
  prisma: PrismaClient,
  suffix: string,
  labelIds: string[],
  status: DocumentStatus = DocumentStatus.active,
  archivedAt: Date | null = null
) {
  const id = `qpr_d_${documentSequence++}`;
  const document = await prisma.document.create({
    data: {
      id,
      orgId,
      title: `Query Prisma Review ${suffix}`,
      documentType: DocumentType.structured_dataset,
      documentKind: DocumentKind.structured,
      fileType: FileType.csv,
      status,
      archivedAt,
      storageObjectKey: `query-prisma-review/${suffix}.csv`,
      originalFileName: `${suffix}.csv`,
      contentType: "text/csv",
      byteSize: 1n,
      checksumSha256: suffix.padEnd(64, "0").slice(0, 64),
      uploaderId: adminId,
      sourceSystem: "query_prisma_review"
    }
  });
  await prisma.documentLabel.createMany({
    data: labelIds.map((labelId) => ({ documentId: id, labelId }))
  });
  return document;
}

async function clearTestData(prisma: PrismaClient) {
  await prisma.supplierCatalogRow.deleteMany({ where: { orgId } });
  await prisma.deliveryLedgerRow.deleteMany({ where: { orgId } });
  await prisma.importBatch.deleteMany({ where: { orgId } });
  await prisma.document.deleteMany({ where: { orgId } });
}

async function removeTestOrganization(prisma: PrismaClient) {
  await clearTestData(prisma);
  await prisma.employeeLabel.deleteMany({
    where: { employeeId: { in: [adminId, labeledId, zeroLabelId] } }
  });
  await prisma.employee.deleteMany({ where: { id: { in: [adminId, labeledId, zeroLabelId] } } });
  await prisma.label.deleteMany({
    where: { id: { in: [allStaffLabelId, visibleLabelId, hiddenLabelId] } }
  });
  await prisma.organization.deleteMany({ where: { id: orgId } });
}
