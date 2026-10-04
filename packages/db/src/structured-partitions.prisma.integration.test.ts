import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { storageGarbageKeyHash } from "./storage-garbage.js";
import { createDatabaseAdapter } from "./adapter.js";
import {
  createPrismaStructuredPartitionRepository,
  type PartitionCandidate
} from "./structured-partitions.js";

const run = process.env["RUN_PARTITION_PRISMA_INTEGRATION"] === "1";
const suite = run ? describe : describe.skip;
const databaseUrl = process.env["DATABASE_URL"] ?? "";
const orgId = "partition_repo_org";
const employeeId = "partition_repo_employee";

suite("structured partition repository", () => {
  const prisma = new PrismaClient({ adapter: createDatabaseAdapter(databaseUrl) });
  const repository = createPrismaStructuredPartitionRepository({ prisma });

  beforeAll(async () => {
    await prisma.organization.create({ data: { id: orgId, name: "Partition Repository Test" } });
    await prisma.employee.create({
      data: {
        id: employeeId,
        orgId,
        email: "partition-repo@example.invalid",
        displayName: "Partition Repo",
        role: "employee",
        clearance: 3
      }
    });
  });

  afterAll(async () => {
    await prisma.auditLog.deleteMany({ where: { orgId } });
    await prisma.processingRun.deleteMany({ where: { orgId } });
    await prisma.structuredPartition.deleteMany({ where: { orgId } });
    await prisma.partitionImportJob.deleteMany({ where: { orgId } });
    await prisma.storageGarbage.deleteMany({});
    await prisma.employee.deleteMany({ where: { id: employeeId } });
    await prisma.organization.deleteMany({ where: { id: orgId } });
    await prisma.$disconnect();
  });

  it("publishes atomically, deduplicates bytes, replaces metadata, and filters by clearance", async () => {
    await createProcessingJob("one");
    const first = candidate({
      id: "part_first",
      objectKey: "structured-partitions/partition_repo_org/pjob_one/part_first.csv",
      businessDate: "2026-09-07",
      confidentialityLevel: 2
    });
    await repository.publishSourceAtomically({
      orgId,
      jobId: "pjob_one",
      totalRowCount: 3n,
      candidates: [first]
    });
    expect(await prisma.structuredPartition.count({ where: { orgId } })).toBe(1);

    await createProcessingJob("two");
    const sameBytes = candidate({
      ...first,
      id: "part_second",
      objectKey: "structured-partitions/partition_repo_org/pjob_two/part_second.csv",
      confidentialityLevel: 0
    });
    await repository.publishSourceAtomically({
      orgId,
      jobId: "pjob_two",
      totalRowCount: 3n,
      candidates: [sameBytes]
    });
    const current = await prisma.structuredPartition.findFirstOrThrow({ where: { orgId } });
    expect(current.objectKey).toBe(first.objectKey);
    expect(current.confidentialityLevel).toBe(0);
    expect(
      await prisma.storageGarbage.findUnique({
        where: { objectKeyHash: storageGarbageKeyHash(sameBytes.objectKey) }
      })
    ).not.toBeNull();
    await expect(
      repository.listReadableManifestRows({
        orgId,
        clearance: 0,
        dataset: "business",
        enterpriseKey: "synthetic",
        startDate: "2026-09-07",
        endDate: "2026-09-07",
        maxPartitions: 10
      })
    ).resolves.toHaveLength(1);

    await createProcessingJob("rollback");
    const conflicting = [
      candidate({
        id: "part_rollback_a",
        objectKey: "structured-partitions/partition_repo_org/pjob_rollback/shared.csv",
        businessDate: "2026-09-08"
      }),
      candidate({
        id: "part_rollback_b",
        objectKey: "structured-partitions/partition_repo_org/pjob_rollback/shared.csv",
        businessDate: "2026-09-09"
      })
    ];
    await expect(
      repository.publishSourceAtomically({
        orgId,
        jobId: "pjob_rollback",
        totalRowCount: 6n,
        candidates: conflicting
      })
    ).rejects.toThrow();
    expect(await prisma.structuredPartition.count({ where: { orgId } })).toBe(1);
  });

  async function createProcessingJob(suffix: string) {
    const jobId = `pjob_${suffix}`;
    await repository.reserveUpload({
      id: jobId,
      orgId,
      uploaderId: employeeId,
      dataset: "business",
      enterpriseKey: "synthetic",
      enterpriseName: "Synthetic",
      confidentialityLevel: 0,
      idempotencyKey: `idem_${suffix}`,
      requestFingerprint: `fingerprint_${suffix}`.padEnd(64, "0"),
      originalFileName: "business.csv",
      mediaType: "text/csv",
      sourceByteSize: 100n,
      sourceChecksumSha256: "a".repeat(64),
      sourceStartDate: "2026-09-07",
      sourceEndDate: "2026-09-09",
      expiresAt: new Date("2026-09-16T00:00:00Z"),
      temporaryObjectKey: `structured-import-staging/${orgId}/${jobId}/source`,
      multipartUploadId: `upload_${suffix}`
    });
    await repository.queueCompletedUpload({
      orgId,
      jobId,
      temporaryObjectKey: `structured-import-staging/${orgId}/${jobId}/source`
    });
    expect(await repository.markJobProcessing(orgId, jobId)).toBe(true);
  }
});

function candidate(overrides: Partial<PartitionCandidate>): PartitionCandidate {
  return {
    id: "part_default",
    orgId,
    enterpriseKey: "synthetic",
    enterpriseName: "Synthetic",
    dataset: "business",
    storeKey: "merchant:001",
    merchantId: "001",
    storeName: "Store A",
    businessDate: "2026-09-07",
    objectKey: "structured-partitions/partition_repo_org/pjob_default/part_default.csv",
    rowCount: 3n,
    byteSize: 30n,
    checksumSha256: "b".repeat(64),
    confidentialityLevel: 2,
    ...overrides
  };
}
