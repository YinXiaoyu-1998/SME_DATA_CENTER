import { beforeEach, describe, expect, it, vi } from "vitest";

const prisma = vi.hoisted(() => ({
  auditLog: {
    create: vi.fn(),
    findMany: vi.fn()
  },
  document: {
    create: vi.fn(),
    findFirst: vi.fn(),
    update: vi.fn(),
    updateMany: vi.fn(),
    findFirstOrThrow: vi.fn()
  },
  $queryRaw: vi.fn(),
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
    confidentialityLevel: 0,
    processingRuns: [{ status: "queued" }],
    indexes: []
  };
}

describe("Prisma document catalog audit provenance", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    prisma.$queryRaw.mockResolvedValue([{ id: "org_1" }]);
    prisma.$transaction.mockImplementation(async (callback: (tx: typeof prisma) => unknown) =>
      callback(prisma)
    );
    prisma.auditLog.create.mockResolvedValue({});
    prisma.document.create.mockResolvedValue(documentRecord());
    prisma.document.findFirst.mockResolvedValue({ status: "active" });
    prisma.document.update.mockResolvedValue({ ...documentRecord(), status: "archived" });
    prisma.document.updateMany.mockResolvedValue({ count: 1 });
    prisma.document.findFirstOrThrow.mockResolvedValue({ ...documentRecord(), status: "archived" });
  });

  it("persists the complete audit context for upload and archive writes", async () => {
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
      confidentialityLevel: 0,
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
      action: "document.metadata_recorded",
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
});
