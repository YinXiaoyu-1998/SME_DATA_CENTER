import { PartitionImportJobStatus, Prisma, type PrismaClient } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";
import { createPrismaStructuredPartitionRepository } from "./structured-partitions.js";

const upload = {
  id: "pjob_new",
  orgId: "org_1",
  uploaderId: "emp_1",
  dataset: "business" as const,
  enterpriseKey: "synthetic",
  enterpriseName: "Synthetic",
  confidentialityLevel: 1,
  idempotencyKey: "idem_1",
  requestFingerprint: "a".repeat(64),
  originalFileName: "business.csv",
  mediaType: "text/csv",
  sourceByteSize: 100n,
  sourceChecksumSha256: "b".repeat(64),
  sourceStartDate: "2026-09-07",
  sourceEndDate: "2026-09-13",
  expiresAt: new Date("2026-09-30T00:00:00.000Z"),
  temporaryObjectKey: "staging/org_1/pjob_new/source",
  multipartUploadId: "upload_1"
};

const existing = {
  ...upload,
  id: "pjob_existing",
  sourceStartDate: new Date("2026-09-07T00:00:00.000Z"),
  sourceEndDate: new Date("2026-09-13T00:00:00.000Z"),
  status: PartitionImportJobStatus.uploading,
  totalRowCount: 0n,
  partitionCount: 0,
  errorCode: null,
  errorSummary: null,
  validationErrors: null,
  publishedAt: null,
  finishedAt: null
};

describe("structured partition repository boundaries", () => {
  it.each(["existing", "unique-race"] as const)(
    "rejects another uploader's %s idempotency replay",
    async (path) => {
      const partitionImportJob = {
        findUnique: vi.fn(async () => (path === "existing" ? existing : null)),
        create: vi.fn(async () => {
          throw new Prisma.PrismaClientKnownRequestError("duplicate", {
            code: "P2002",
            clientVersion: "7.9.1"
          });
        }),
        findUniqueOrThrow: vi.fn(async () => existing)
      };
      const tx = {
        partitionImportJob,
        employee: { findFirst: vi.fn(async () => ({ id: "emp_2" })) }
      };
      const prisma = {
        ...tx,
        $transaction: vi.fn(async (callback: (client: typeof tx) => Promise<unknown>) =>
          callback(tx)
        )
      } as unknown as PrismaClient;
      const repository = createPrismaStructuredPartitionRepository({ prisma });

      await expect(
        repository.reserveUpload({ ...upload, uploaderId: "emp_2" })
      ).rejects.toMatchObject({
        code: "IDEMPOTENCY_KEY_REUSED"
      });
      if (path === "existing") expect(partitionImportJob.create).not.toHaveBeenCalled();
      else expect(partitionImportJob.findUniqueOrThrow).toHaveBeenCalledOnce();
    }
  );

  it("preserves an exact replay by the original uploader", async () => {
    const prisma = {
      partitionImportJob: { findUnique: vi.fn(async () => existing) }
    } as unknown as PrismaClient;
    const repository = createPrismaStructuredPartitionRepository({ prisma });

    await expect(repository.reserveUpload(upload)).resolves.toMatchObject({
      state: "existing",
      job: { id: existing.id, uploaderId: upload.uploaderId }
    });
  });

  it("limits manifest rows in the database and selects only response fields", async () => {
    const findMany = vi.fn(async () => []);
    const prisma = {
      structuredPartition: { findMany }
    } as unknown as PrismaClient;
    const repository = createPrismaStructuredPartitionRepository({ prisma });

    await repository.listReadableManifestRows({
      orgId: "org_1",
      clearance: 1,
      dataset: "business",
      enterpriseKey: "synthetic",
      startDate: "2026-09-07",
      endDate: "2026-09-13",
      maxPartitions: 2
    });

    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        take: 3,
        where: expect.objectContaining({
          orgId: "org_1",
          confidentialityLevel: { lte: 1 }
        }),
        select: {
          businessDate: true,
          merchantId: true,
          storeName: true,
          rowCount: true,
          byteSize: true,
          checksumSha256: true,
          objectKey: true
        }
      })
    );
  });
});

it("binds literal store-name scope together with authorization and manifest constraints", async () => {
  const queryRaw = vi.fn<(query: Prisma.Sql) => Promise<unknown[]>>(async () => []);
  const prisma = {
    $queryRaw: queryRaw,
    structuredPartition: { findMany: vi.fn(async () => []) }
  } as unknown as PrismaClient;
  const repository = createPrismaStructuredPartitionRepository({ prisma });
  await repository.listReadableManifestRows({
    orgId: "org_1",
    clearance: 1,
    dataset: "business",
    enterpriseKey: "synthetic",
    startDate: "2026-09-07",
    endDate: "2026-09-13",
    storeIds: ["001"],
    storeNameContains: ["麦家小馆", "A%_\\"],
    maxPartitions: 2
  });
  expect(queryRaw).toHaveBeenCalledOnce();
  const sql = queryRaw.mock.calls[0]![0] as Prisma.Sql;
  expect(sql.sql).toContain("org_id = ?");
  expect(sql.sql).toContain("confidentiality_level <= ?");
  expect(sql.sql).toContain("merchant_id IN (?)");
  expect(sql.sql).toContain("LOCATE(CAST(? AS BINARY), CAST(store_name AS BINARY)) > 0");
  expect(sql.sql).toContain(" OR ");
  expect(sql.sql).not.toContain("麦家小馆");
  expect(sql.values).toEqual([
    "org_1",
    1,
    "business",
    "synthetic",
    new Date("2026-09-07T00:00:00Z"),
    new Date("2026-09-13T00:00:00Z"),
    "001",
    "麦家小馆",
    "A%_\\",
    3
  ]);
});
