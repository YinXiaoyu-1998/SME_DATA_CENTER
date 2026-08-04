import { beforeEach, describe, expect, it, vi } from "vitest";

const prisma = vi.hoisted(() => ({
  auditLog: {
    create: vi.fn(),
    findMany: vi.fn()
  },
  document: {
    create: vi.fn(),
    findFirst: vi.fn(),
    update: vi.fn()
  },
  label: {
    findMany: vi.fn()
  },
  employeeLabel: {
    findFirst: vi.fn()
  },
  $transaction: vi.fn(),
  $disconnect: vi.fn()
}));

vi.mock("@prisma/adapter-mariadb", () => ({
  PrismaMariaDb: class PrismaMariaDb {}
}));

vi.mock("@prisma/client", async (importOriginal) => {
  const original = await importOriginal<typeof import("@prisma/client")>();

  return {
    ...original,
    PrismaClient: class PrismaClient {
      constructor() {
        return prisma;
      }
    }
  };
});

import { createPrismaDocumentCatalogRepository } from "./documents.js";

const audit = {
  requestId: "req_http_1",
  sourceIp: "198.51.100.8",
  clientSource: "http_api" as const,
  launcherVersion: null
};

function documentRecord() {
  return {
    id: "doc_1",
    orgId: "org_1",
    uploaderId: "emp_1",
    title: "SOP",
    documentType: "management_knowledge",
    documentKind: "evidence",
    fileType: "md",
    status: "pending_processing",
    storageObjectKey: "org/org_1/documents/doc_1/original/sop.md",
    originalFileName: "sop.md",
    contentType: "text/markdown",
    byteSize: 3n,
    checksumSha256: "hash",
    sourceSystem: "manual",
    sourceTime: null,
    documentLabels: [{ label: { key: "all_staff" } }],
    processingRuns: [{ status: "queued" }],
    indexes: []
  };
}

describe("Prisma document catalog audit provenance", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    prisma.$transaction.mockImplementation(async (callback: (tx: typeof prisma) => unknown) =>
      callback(prisma)
    );
    prisma.auditLog.create.mockResolvedValue({});
    prisma.document.create.mockResolvedValue(documentRecord());
    prisma.document.findFirst.mockResolvedValue({ status: "active" });
    prisma.document.update.mockResolvedValue({ ...documentRecord(), status: "archived" });
  });

  it("persists the complete audit context for upload, archive, and label audit writes", async () => {
    const repository = createPrismaDocumentCatalogRepository("mysql://test");

    await repository.createUploadedDocument({
      id: "doc_1",
      orgId: "org_1",
      title: "SOP",
      documentType: "management_knowledge",
      documentKind: "evidence",
      fileType: "md",
      status: "pending_processing",
      storageObjectKey: "org/org_1/documents/doc_1/original/sop.md",
      originalFileName: "sop.md",
      contentType: "text/markdown",
      byteSize: 3,
      checksumSha256: "hash",
      uploaderId: "emp_1",
      sourceSystem: "manual",
      sourceTime: null,
      labelIds: ["label_1"],
      labels: ["all_staff"],
      processingJobType: "evidence_document_index",
      audit
    });
    await repository.archiveDocument({
      orgId: "org_1",
      documentId: "doc_1",
      actorEmployeeId: "emp_1",
      audit
    });
    await repository.appendAuditLog({
      orgId: "org_1",
      actorEmployeeId: "emp_1",
      action: "document.labels_added",
      targetType: "document",
      targetId: "doc_1",
      result: "succeeded",
      audit
    });

    expect(prisma.auditLog.create).toHaveBeenCalledTimes(3);
    for (const call of prisma.auditLog.create.mock.calls) {
      expect(call[0]).toMatchObject({
        data: {
          requestId: "req_http_1",
          clientIp: "198.51.100.8",
          clientSource: "http_api",
          launcherVersion: null
        }
      });
    }
  });

  it("serializes both populated provenance and nullable historical provenance", async () => {
    prisma.auditLog.findMany.mockResolvedValue([
      {
        id: "audit_2",
        actorEmployeeId: "emp_1",
        action: "document.uploaded",
        targetType: "document",
        targetId: "doc_1",
        result: "succeeded",
        metadata: null,
        requestId: "req_http_1",
        clientIp: "198.51.100.8",
        clientSource: "http_api",
        launcherVersion: null,
        createdAt: new Date("2026-07-31T12:00:00.000Z")
      },
      {
        id: "audit_1",
        actorEmployeeId: null,
        action: "historical.event",
        targetType: "document",
        targetId: null,
        result: "succeeded",
        metadata: null,
        requestId: null,
        clientIp: null,
        clientSource: null,
        launcherVersion: null,
        createdAt: new Date("2026-07-30T12:00:00.000Z")
      }
    ]);
    const repository = createPrismaDocumentCatalogRepository("mysql://test");

    const result = await repository.listAuditLogs({ orgId: "org_1", limit: 10, cursor: null });

    expect(result.auditLogs).toEqual([
      expect.objectContaining({
        requestId: "req_http_1",
        clientIp: "198.51.100.8",
        clientSource: "http_api",
        launcherVersion: null
      }),
      expect.objectContaining({
        requestId: null,
        clientIp: null,
        clientSource: null,
        launcherVersion: null
      })
    ]);
  });
});
