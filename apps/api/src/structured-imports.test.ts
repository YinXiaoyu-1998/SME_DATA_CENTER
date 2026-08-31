import { beforeEach, describe, expect, it, vi } from "vitest";

const prisma = vi.hoisted(() => ({
  importBatch: {
    findUnique: vi.fn(),
    findUniqueOrThrow: vi.fn(),
    findFirst: vi.fn(),
    updateMany: vi.fn(),
    update: vi.fn(),
    create: vi.fn()
  },
  importWindowClaim: {
    findUnique: vi.fn(),
    create: vi.fn(),
    delete: vi.fn(),
    deleteMany: vi.fn()
  },
  document: {
    create: vi.fn(),
    update: vi.fn()
  },
  dishRow: {
    deleteMany: vi.fn()
  },
  businessRow: {
    deleteMany: vi.fn()
  },
  vipRow: {
    deleteMany: vi.fn()
  },
  dishCatalogRow: {
    deleteMany: vi.fn()
  },
  deliveryLedgerRow: {
    deleteMany: vi.fn()
  },
  supplierCatalogRow: {
    deleteMany: vi.fn()
  },
  processingRun: {
    create: vi.fn()
  },
  auditLog: {
    create: vi.fn()
  },
  $executeRaw: vi.fn(),
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

import { Prisma } from "@prisma/client";
import { createPrismaStructuredImportRepository } from "./structured-imports.js";

const audit = {
  requestId: "req_http_1",
  sourceIp: "198.51.100.8",
  clientSource: "http_api" as const,
  launcherVersion: null
};

function importBatchRecord(
  status = "pending",
  processingRuns: Array<{ id: string; status: string }> = [],
  dataset = "dishes"
) {
  return {
    id: "imp_1",
    orgId: "org_1",
    sourceDocumentId: "doc_1",
    dataset,
    status,
    requestFingerprint: "fingerprint_1",
    naturalKey: null,
    appliedAt: null,
    startDate: new Date("2026-07-01T00:00:00.000Z"),
    endDate: new Date("2026-07-05T00:00:00.000Z"),
    sourceSheetSummary: [],
    validationErrors: [],
    totalRowCount: 1,
    appliedRowCount: status === "applied" ? 1 : 0,
    sourceDocument: {
      status: status === "applied" ? "active" : "pending_processing",
      fileType: "csv",
      storageObjectKey: "org/org_1/documents/doc_1/original/data.csv",
      originalFileName: "data.csv",
      documentLabels: [{ label: { key: "all_staff" } }],
      processingRuns
    }
  };
}

function reservationInput(
  overrides: Partial<
    Parameters<
      ReturnType<typeof createPrismaStructuredImportRepository>["reserveStructuredImport"]
    >[0]
  > = {}
) {
  return {
    orgId: "org_1",
    actorEmployeeId: "emp_1",
    documentId: "doc_1",
    dataset: "dishes" as const,
    fileType: "csv" as const,
    startDate: "20260701",
    endDate: "20260705",
    idempotencyKey: "idem_1",
    requestFingerprint: "fingerprint_1",
    document: {
      title: "Structured import",
      storageObjectKey: "org/org_1/documents/doc_1/original/data.csv",
      originalFileName: "data.csv",
      contentType: "text/csv",
      byteSize: 10,
      checksumSha256: "hash",
      labelIds: ["label_1"],
      labels: ["all_staff"]
    },
    sourceSheetSummary: [],
    totalRowCount: 1,
    audit,
    ...overrides
  };
}

function useStatefulReservationPrisma(
  options: {
    race?: {
      naturalKey: string;
      batch: Omit<ReturnType<typeof importBatchRecord>, "naturalKey"> & { naturalKey: string };
    };
  } = {}
) {
  type StoredBatch = Omit<
    ReturnType<typeof importBatchRecord>,
    "id" | "orgId" | "dataset" | "requestFingerprint" | "naturalKey" | "startDate" | "endDate"
  > & {
    id: string;
    orgId: string;
    dataset: string;
    requestFingerprint: string;
    naturalKey: string | null;
    startDate: Date | null;
    endDate: Date | null;
  };

  const batches = new Map<string, StoredBatch>();
  const documents = new Map<string, Record<string, unknown>>();
  let currentBatches = batches;
  let currentDocuments = documents;
  let raceInjected = false;
  let naturalKeyInsertAttempts = 0;
  let transactionCallbacks = 0;

  function findBatch(where: Record<string, unknown>) {
    if ("orgId_idempotencyKey" in where) {
      const key = where.orgId_idempotencyKey as { orgId: string; idempotencyKey: string };
      return [...currentBatches.values()].find(
        (batch) =>
          batch.orgId === key.orgId &&
          (batch as unknown as { idempotencyKey: string }).idempotencyKey === key.idempotencyKey
      );
    }
    if ("orgId_dataset_naturalKey" in where) {
      const key = where.orgId_dataset_naturalKey as {
        orgId: string;
        dataset: string;
        naturalKey: string;
      };
      return [...currentBatches.values()].find(
        (batch) =>
          batch.orgId === key.orgId &&
          batch.dataset === key.dataset &&
          batch.naturalKey === key.naturalKey
      );
    }
    if ("id" in where) return currentBatches.get(where.id as string);
    return undefined;
  }

  prisma.importBatch.findUnique.mockImplementation(
    async ({ where }: { where: Record<string, unknown> }) => findBatch(where) ?? null
  );
  prisma.importBatch.findUniqueOrThrow.mockImplementation(
    async ({ where }: { where: Record<string, unknown> }) => {
      const batch = findBatch(where);
      if (!batch) throw new Error("stateful batch not found");
      return batch;
    }
  );
  prisma.importBatch.create.mockImplementation(
    async ({ data }: { data: Record<string, unknown> }) => {
      if (data.naturalKey !== undefined) {
        naturalKeyInsertAttempts += 1;
        if (options.race && !raceInjected && data.naturalKey === options.race.naturalKey) {
          raceInjected = true;
          batches.set(options.race.batch.id, options.race.batch as StoredBatch);
          throw new Prisma.PrismaClientKnownRequestError("duplicate receipt", {
            code: "P2002",
            clientVersion: "test"
          });
        }
      }
      const base = importBatchRecord("pending", [], String(data.dataset));
      const stored = {
        ...base,
        ...data,
        id: String(data.id),
        orgId: String(data.orgId),
        dataset: String(data.dataset),
        requestFingerprint: String(data.requestFingerprint),
        naturalKey: (data.naturalKey as string | undefined) ?? null,
        startDate: (data.startDate as Date | null) ?? null,
        endDate: (data.endDate as Date | null) ?? null
      } as StoredBatch;
      currentBatches.set(stored.id, stored);
      return stored;
    }
  );
  prisma.document.create.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => {
    currentDocuments.set(String(data.id), data);
    return data;
  });
  prisma.$transaction.mockImplementation(async (callback: (tx: typeof prisma) => unknown) => {
    transactionCallbacks += 1;
    const stagedBatches = new Map(currentBatches);
    const stagedDocuments = new Map(currentDocuments);
    currentBatches = stagedBatches;
    currentDocuments = stagedDocuments;
    try {
      const result = await callback(prisma);
      batches.clear();
      for (const [id, batch] of stagedBatches) batches.set(id, batch);
      documents.clear();
      for (const [id, document] of stagedDocuments) documents.set(id, document);
      return result;
    } finally {
      currentBatches = batches;
      currentDocuments = documents;
    }
  });

  return {
    batches,
    documents,
    get naturalKeyInsertAttempts() {
      return naturalKeyInsertAttempts;
    },
    get transactionCallbacks() {
      return transactionCallbacks;
    }
  };
}

describe("Prisma structured import audit provenance", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    prisma.importBatch.findUnique.mockResolvedValue(null);
    prisma.importWindowClaim.findUnique.mockResolvedValue(null);
    prisma.importWindowClaim.delete.mockResolvedValue({});
    prisma.importWindowClaim.deleteMany.mockResolvedValue({ count: 0 });
    prisma.$transaction.mockImplementation(async (callback: (tx: typeof prisma) => unknown) =>
      callback(prisma)
    );
    prisma.document.create.mockResolvedValue({});
    prisma.importBatch.create.mockResolvedValue({});
    prisma.importWindowClaim.create.mockResolvedValue({});
    prisma.auditLog.create.mockResolvedValue({});
    prisma.importBatch.findUniqueOrThrow.mockImplementation(
      ({ where }: { where: { id: string } }) =>
        Promise.resolve({ ...importBatchRecord(), id: where.id })
    );
    prisma.importBatch.findFirst.mockResolvedValue(importBatchRecord());
    prisma.importBatch.updateMany.mockResolvedValue({ count: 1 });
    prisma.importBatch.update.mockResolvedValue(importBatchRecord("applied"));
    prisma.document.update.mockResolvedValue({});
    prisma.dishRow.deleteMany.mockResolvedValue({ count: 0 });
    prisma.businessRow.deleteMany.mockResolvedValue({ count: 0 });
    prisma.vipRow.deleteMany.mockResolvedValue({ count: 0 });
    prisma.dishCatalogRow.deleteMany.mockResolvedValue({ count: 0 });
    prisma.deliveryLedgerRow.deleteMany.mockResolvedValue({ count: 0 });
    prisma.supplierCatalogRow.deleteMany.mockResolvedValue({ count: 0 });
    prisma.processingRun.create.mockResolvedValue({});
    prisma.$executeRaw.mockResolvedValue(1);
  });

  it("persists the complete audit context when reserving a structured import", async () => {
    const repository = createPrismaStructuredImportRepository({
      databaseUrl: "mysql://test",
      transactionTimeoutMs: 1_000,
      batchInsertSize: 100
    });

    await repository.reserveStructuredImport({
      orgId: "org_1",
      actorEmployeeId: "emp_1",
      documentId: "doc_1",
      dataset: "dishes",
      fileType: "csv",
      startDate: "20260701",
      endDate: "20260705",
      idempotencyKey: "idem_1",
      requestFingerprint: "fingerprint_1",
      document: {
        title: "Dishes",
        storageObjectKey: "org/org_1/documents/doc_1/original/data.csv",
        originalFileName: "data.csv",
        contentType: "text/csv",
        byteSize: 10,
        checksumSha256: "hash",
        labelIds: ["label_1"],
        labels: ["all_staff"]
      },
      sourceSheetSummary: [],
      totalRowCount: 1,
      audit
    });

    expect(prisma.auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          requestId: "req_http_1",
          clientIp: "198.51.100.8",
          clientSource: "http_api",
          launcherVersion: null
        })
      })
    );
    expect(prisma.auditLog.create.mock.calls[0]?.[0].data.metadata).toEqual({
      dataset: "dishes",
      startDate: "20260701",
      endDate: "20260705",
      rowCount: 1,
      sourceDocumentId: "doc_1"
    });
  });

  it("persists the complete audit context when applying a structured import", async () => {
    const repository = createPrismaStructuredImportRepository({
      databaseUrl: "mysql://test",
      transactionTimeoutMs: 1_000,
      batchInsertSize: 100
    });

    await repository.applyReservedStructuredImport({
      orgId: "org_1",
      actorEmployeeId: "emp_1",
      importBatchId: "imp_1",
      rows: [
        {
          sourceSheetIndex: 0,
          sourceSheetName: "Sheet1",
          sourceRowNumber: 2,
          payload: { product_name: "Tea" }
        }
      ],
      audit
    });

    expect(prisma.auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          requestId: "req_http_1",
          clientIp: "198.51.100.8",
          clientSource: "http_api",
          launcherVersion: null
        })
      })
    );
    expect(prisma.auditLog.create.mock.calls[0]?.[0].data.metadata).toEqual({
      dataset: "dishes",
      startDate: "20260701",
      endDate: "20260705",
      appliedRowCount: 1,
      sourceDocumentId: "doc_1"
    });
  });

  it("uses the dedicated catalog row branch when reapplying a reserved snapshot", async () => {
    const repository = createPrismaStructuredImportRepository({
      databaseUrl: "mysql://test",
      transactionTimeoutMs: 1_000,
      batchInsertSize: 100
    });
    prisma.importBatch.findFirst.mockResolvedValueOnce(
      importBatchRecord("pending", [], "dish_catalog")
    );
    prisma.importBatch.update.mockResolvedValueOnce(
      importBatchRecord("applied", [], "dish_catalog")
    );

    await repository.applyReservedStructuredImport({
      orgId: "org_1",
      actorEmployeeId: "emp_1",
      importBatchId: "imp_1",
      rows: [
        {
          sourceSheetIndex: 2,
          sourceSheetName: "Catalog B",
          sourceRowNumber: 2,
          payload: { sku_id: "sku-1" }
        }
      ],
      audit
    });

    expect(prisma.dishCatalogRow.deleteMany).toHaveBeenCalledWith({
      where: { importBatchId: "imp_1" }
    });
    expect(prisma.vipRow.deleteMany).not.toHaveBeenCalled();
    expect(JSON.stringify(prisma.$executeRaw.mock.calls)).toContain("Catalog B");
  });

  it("creates a queued structured-import processing run only after a reservation exists", async () => {
    const repository = createPrismaStructuredImportRepository({
      databaseUrl: "mysql://test",
      transactionTimeoutMs: 1_000,
      batchInsertSize: 100
    });

    await repository.enqueueReservedStructuredImport({
      orgId: "org_1",
      importBatchId: "imp_1"
    });

    expect(prisma.processingRun.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        orgId: "org_1",
        documentId: "doc_1",
        jobKey: "structured_import:imp_1",
        status: "queued",
        jobType: "structured_import"
      })
    });
  });

  it("returns the authoritative queued run when a concurrent replay wins the job-key race", async () => {
    const repository = createPrismaStructuredImportRepository({
      databaseUrl: "mysql://test",
      transactionTimeoutMs: 1_000,
      batchInsertSize: 100
    });
    prisma.importBatch.findFirst
      .mockResolvedValueOnce(importBatchRecord())
      .mockResolvedValueOnce(importBatchRecord("pending", [{ id: "run_1", status: "queued" }]));
    prisma.processingRun.create.mockRejectedValueOnce(
      new Prisma.PrismaClientKnownRequestError("duplicate structured-import job", {
        code: "P2002",
        clientVersion: "test"
      })
    );

    await expect(
      repository.enqueueReservedStructuredImport({ orgId: "org_1", importBatchId: "imp_1" })
    ).resolves.toMatchObject({ processingRunId: "run_1", processingStatus: "queued" });
  });

  it.each(["rejected", "failed"] as const)(
    "releases a %s import-window claim before accepting a replacement key",
    async (terminalStatus) => {
      const repository = createPrismaStructuredImportRepository({
        databaseUrl: "mysql://test",
        transactionTimeoutMs: 1_000,
        batchInsertSize: 100
      });
      prisma.importWindowClaim.findUnique.mockResolvedValueOnce({
        id: `claim_${terminalStatus}`,
        importBatch: importBatchRecord(terminalStatus)
      });

      await repository.reserveStructuredImport({
        orgId: "org_1",
        actorEmployeeId: "emp_2",
        documentId: "doc_2",
        dataset: "dishes",
        fileType: "csv",
        startDate: "20260701",
        endDate: "20260705",
        idempotencyKey: "replacement-key",
        requestFingerprint: "replacement-fingerprint",
        document: {
          title: "Replacement dishes",
          storageObjectKey: "org/org_1/documents/doc_2/original/data.csv",
          originalFileName: "data.csv",
          contentType: "text/csv",
          byteSize: 10,
          checksumSha256: "hash",
          labelIds: ["label_1"],
          labels: ["all_staff"]
        },
        sourceSheetSummary: [],
        totalRowCount: 0,
        audit
      });

      expect(prisma.importWindowClaim.delete).toHaveBeenCalledWith({
        where: { id: `claim_${terminalStatus}` }
      });
    }
  );

  it("releases an archived applied snapshot claim for a new key but replays the original key", async () => {
    const repository = createPrismaStructuredImportRepository({
      databaseUrl: "mysql://test",
      transactionTimeoutMs: 1_000,
      batchInsertSize: 100
    });
    const archivedBatch = {
      ...importBatchRecord(
        "applied",
        [{ id: "run_archived", status: "succeeded" }],
        "dish_catalog"
      ),
      id: "imp_archived",
      requestFingerprint: "archived-fingerprint",
      startDate: new Date("2026-08-19T00:00:00.000Z"),
      endDate: new Date("2026-08-19T00:00:00.000Z"),
      sourceDocument: {
        ...importBatchRecord("applied").sourceDocument,
        status: "archived",
        processingRuns: [{ id: "run_archived", status: "succeeded" }]
      }
    };
    const replacementBatch = {
      ...importBatchRecord("pending", [], "dish_catalog"),
      id: "imp_replacement",
      startDate: new Date("2026-08-19T00:00:00.000Z"),
      endDate: new Date("2026-08-19T00:00:00.000Z")
    };
    prisma.importBatch.findUnique.mockResolvedValueOnce(null).mockResolvedValueOnce(archivedBatch);
    prisma.importWindowClaim.findUnique.mockResolvedValueOnce({
      id: "claim_archived",
      importBatch: archivedBatch
    });
    prisma.importWindowClaim.deleteMany.mockResolvedValueOnce({ count: 1 });
    prisma.importBatch.findUniqueOrThrow.mockResolvedValueOnce(replacementBatch);

    const baseInput = {
      orgId: "org_1",
      actorEmployeeId: "emp_1",
      dataset: "dish_catalog" as const,
      fileType: "csv" as const,
      startDate: "20260819",
      endDate: "20260819",
      document: {
        title: "Catalog snapshot",
        storageObjectKey: "org/org_1/documents/doc_replacement/original/catalog.csv",
        originalFileName: "catalog.csv",
        contentType: "text/csv",
        byteSize: 10,
        checksumSha256: "hash",
        labelIds: ["label_1"],
        labels: ["all_staff"]
      },
      sourceSheetSummary: [],
      totalRowCount: 0,
      audit
    };

    await expect(
      repository.reserveStructuredImport({
        ...baseInput,
        documentId: "doc_replacement",
        idempotencyKey: "replacement-key",
        requestFingerprint: "replacement-fingerprint"
      })
    ).resolves.toMatchObject({
      state: "created",
      importBatch: { id: "imp_replacement", dataset: "dish_catalog" }
    });
    expect(prisma.importWindowClaim.deleteMany).toHaveBeenCalledWith({
      where: { id: "claim_archived", importBatchId: "imp_archived" }
    });

    await expect(
      repository.reserveStructuredImport({
        ...baseInput,
        documentId: "doc_unused",
        idempotencyKey: "original-key",
        requestFingerprint: "archived-fingerprint"
      })
    ).resolves.toMatchObject({
      state: "existing",
      importBatch: { id: "imp_archived", status: "archived", sourceDocumentStatus: "archived" }
    });
    expect(prisma.importWindowClaim.findUnique).toHaveBeenCalledOnce();
  });

  it("replays an existing delivery receipt by natural key before checking date claims", async () => {
    const repository = createPrismaStructuredImportRepository({
      databaseUrl: "mysql://test",
      transactionTimeoutMs: 1_000,
      batchInsertSize: 100
    });
    const existing = {
      ...importBatchRecord(
        "applied",
        [{ id: "run_delivery", status: "succeeded" }],
        "delivery_ledger"
      ),
      requestFingerprint: "same",
      naturalKey: "SH2608250117"
    };
    prisma.importBatch.findUnique.mockResolvedValueOnce(null).mockResolvedValueOnce(existing);

    await expect(
      repository.reserveStructuredImport(
        reservationInput({
          dataset: "delivery_ledger",
          naturalKey: "SH2608250117",
          requestFingerprint: "same"
        })
      )
    ).resolves.toMatchObject({ state: "existing", importBatch: { id: "imp_1" } });
    expect(prisma.importWindowClaim.findUnique).not.toHaveBeenCalled();
    expect(prisma.document.create).not.toHaveBeenCalled();
  });

  it("rejects a delivery receipt natural-key replay with a different fingerprint", async () => {
    const repository = createPrismaStructuredImportRepository({
      databaseUrl: "mysql://test",
      transactionTimeoutMs: 1_000,
      batchInsertSize: 100
    });
    prisma.importBatch.findUnique.mockResolvedValueOnce(null).mockResolvedValueOnce({
      ...importBatchRecord(
        "applied",
        [{ id: "run_delivery", status: "succeeded" }],
        "delivery_ledger"
      ),
      requestFingerprint: "same",
      naturalKey: "SH2608250117"
    });

    await expect(
      repository.reserveStructuredImport(
        reservationInput({
          dataset: "delivery_ledger",
          naturalKey: "SH2608250117",
          requestFingerprint: "different"
        })
      )
    ).rejects.toMatchObject({ code: "RECEIPT_ID_CONFLICT" });
    expect(prisma.document.create).not.toHaveBeenCalled();
  });

  it("allows two delivery receipt natural keys on the same date to reserve independently", async () => {
    const repository = createPrismaStructuredImportRepository({
      databaseUrl: "mysql://test",
      transactionTimeoutMs: 1_000,
      batchInsertSize: 100
    });
    const state = useStatefulReservationPrisma();

    await repository.reserveStructuredImport(
      reservationInput({ dataset: "delivery_ledger", naturalKey: "SH2608250117" })
    );
    await repository.reserveStructuredImport(
      reservationInput({
        documentId: "doc_2",
        idempotencyKey: "idem_2",
        dataset: "delivery_ledger",
        naturalKey: "SH2608250118"
      })
    );

    expect(prisma.document.create).toHaveBeenCalledTimes(2);
    expect(prisma.importBatch.create).toHaveBeenCalledTimes(2);
    expect(prisma.importWindowClaim.create).not.toHaveBeenCalled();
    expect(state.transactionCallbacks).toBe(2);
    expect(state.batches.size).toBe(2);
    expect([...state.batches.values()].map((batch) => batch.naturalKey)).toEqual([
      "SH2608250117",
      "SH2608250118"
    ]);
    expect(prisma.auditLog.create.mock.calls.map(([call]) => call.data.metadata)).toEqual([
      {
        dataset: "delivery_ledger",
        startDate: "20260701",
        endDate: "20260705",
        naturalKey: "SH2608250117",
        rowCount: 1,
        sourceDocumentId: "doc_1"
      },
      {
        dataset: "delivery_ledger",
        startDate: "20260701",
        endDate: "20260705",
        naturalKey: "SH2608250118",
        rowCount: 1,
        sourceDocumentId: "doc_2"
      }
    ]);
  });

  it("reserves a supplier catalog with nullable dates and no window claim or raw row metadata", async () => {
    const repository = createPrismaStructuredImportRepository({
      databaseUrl: "mysql://test",
      transactionTimeoutMs: 1_000,
      batchInsertSize: 100
    });
    const state = useStatefulReservationPrisma();

    await repository.reserveStructuredImport(
      reservationInput({
        dataset: "supplier_catalog",
        startDate: null,
        endDate: null,
        totalRowCount: 2
      })
    );

    expect(prisma.importWindowClaim.create).not.toHaveBeenCalled();
    expect(prisma.importBatch.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        dataset: "supplier_catalog",
        startDate: null,
        endDate: null
      })
    });
    expect(prisma.document.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          sourceMetadata: {
            dataset: "supplier_catalog",
            startDate: null,
            endDate: null
          }
        })
      })
    );
    expect(prisma.auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          metadata: {
            dataset: "supplier_catalog",
            startDate: null,
            endDate: null,
            rowCount: 2,
            sourceDocumentId: "doc_1"
          }
        })
      })
    );
    await repository.reserveStructuredImport(
      reservationInput({
        documentId: "doc_2",
        idempotencyKey: "idem_2",
        dataset: "supplier_catalog",
        startDate: null,
        endDate: null,
        totalRowCount: 3
      })
    );
    expect(state.batches.size).toBe(2);
    expect([...state.batches.values()].map((batch) => batch.naturalKey)).toEqual([null, null]);
    expect(prisma.importWindowClaim.create).not.toHaveBeenCalled();
  });

  it.each([
    { fingerprint: "same", expected: { state: "existing" } },
    { fingerprint: "different", expected: { code: "RECEIPT_ID_CONFLICT" } }
  ])(
    "executes the transaction before resolving a natural-key race for $fingerprint fingerprint",
    async ({ fingerprint, expected }) => {
      const repository = createPrismaStructuredImportRepository({
        databaseUrl: "mysql://test",
        transactionTimeoutMs: 1_000,
        batchInsertSize: 100
      });
      const raced = {
        ...importBatchRecord("pending", [{ id: "run_race", status: "queued" }], "delivery_ledger"),
        requestFingerprint: fingerprint === "same" ? "same" : "winner",
        naturalKey: "SH2608250117"
      };
      const state = useStatefulReservationPrisma({
        race: { naturalKey: "SH2608250117", batch: raced }
      });

      const result = expect(
        repository.reserveStructuredImport(
          reservationInput({
            dataset: "delivery_ledger",
            naturalKey: "SH2608250117",
            requestFingerprint: fingerprint
          })
        )
      );
      if ("state" in expected) {
        await result.resolves.toMatchObject(expected);
      } else {
        await result.rejects.toMatchObject(expected);
      }
      expect(state.transactionCallbacks).toBe(1);
      expect(state.naturalKeyInsertAttempts).toBe(1);
      expect(state.batches.size).toBe(1);
      expect(state.documents.size).toBe(0);
    }
  );

  it("marks a successfully applied supplier catalog with appliedAt", async () => {
    const repository = createPrismaStructuredImportRepository({
      databaseUrl: "mysql://test",
      transactionTimeoutMs: 1_000,
      batchInsertSize: 100
    });
    prisma.importBatch.findFirst.mockResolvedValueOnce(
      importBatchRecord("pending", [], "supplier_catalog")
    );
    prisma.importBatch.update.mockResolvedValueOnce(
      importBatchRecord("applied", [], "supplier_catalog")
    );

    await repository.applyReservedStructuredImport({
      orgId: "org_1",
      actorEmployeeId: "emp_1",
      importBatchId: "imp_1",
      rows: [
        {
          sourceSheetIndex: 0,
          sourceSheetName: "Suppliers",
          sourceRowNumber: 2,
          payload: { supplier_name: "Supplier A" }
        }
      ],
      audit
    });

    expect(prisma.supplierCatalogRow.deleteMany).toHaveBeenCalledWith({
      where: { importBatchId: "imp_1" }
    });
    expect(prisma.importBatch.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: "applied",
          appliedAt: expect.any(Date)
        })
      })
    );
  });
});
