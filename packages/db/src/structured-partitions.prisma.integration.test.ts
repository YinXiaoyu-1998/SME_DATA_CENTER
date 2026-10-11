import { createStoreCleanupRepository } from "../../../scripts/partition-store-cleanup-support.js";
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
        role: "admin",
        clearance: 3
      }
    });
  });

  afterAll(async () => {
    await prisma.businessAuthorizationAudit.deleteMany({ where: { orgId } });
    await prisma.businessResource.deleteMany({ where: { orgId } });
    await prisma.businessStore.deleteMany({ where: { orgId } });
    await prisma.businessCategory.deleteMany({ where: { orgId } });
    await prisma.businessAuthorizationState.deleteMany({ where: { orgId } });
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

  it("literalStoreNameScope filters manifest and coverage under MySQL collation", async () => {
    await createProcessingJob("literal_scope");
    const stores = [
      { name: "麦家小馆东店", merchantId: "scope001" },
      { name: "麦家小馆西店", merchantId: null },
      { name: "其他品牌", merchantId: "scope003" },
      { name: "麦家小馆密店", merchantId: "scope004", confidentialityLevel: 3 },
      { name: "麦家小馆企业外", merchantId: "scope005", enterpriseKey: "other" },
      { name: "前缀A%_\\后缀", merchantId: "scope006" },
      { name: "前缀a%_\\后缀", merchantId: "scope007" },
      { name: "前缀AXY\\后缀", merchantId: "scope008" }
    ];
    await repository.publishSourceAtomically({
      orgId,
      jobId: "pjob_literal_scope",
      totalRowCount: BigInt(stores.length * 3),
      candidates: stores.map((store, i) =>
        candidate({
          id: `part_scope_${i}`,
          storeKey: `scope:${i}`,
          storeName: store.name,
          merchantId: store.merchantId,
          enterpriseKey: store.enterpriseKey ?? "synthetic",
          confidentialityLevel: store.confidentialityLevel ?? 0,
          objectKey: `structured-partitions/${orgId}/pjob_literal_scope/part_${i}.csv`
        })
      )
    });
    await prisma.organization.create({
      data: { id: "partition_other_org", name: "Other synthetic organization" }
    });
    try {
      await prisma.structuredPartition.create({
        data: {
          ...candidate({
            id: "part_other_org",
            orgId: "partition_other_org",
            storeKey: "other_org",
            storeName: "麦家小馆组织外",
            confidentialityLevel: 0,
            objectKey: "structured-partitions/partition_other_org/other.csv"
          }),
          businessDate: new Date("2026-09-07T00:00:00Z"),
          publishedByJobId: "pjob_literal_scope"
        }
      });
      const collation = await prisma.$queryRaw<
        Array<{ collationName: string }>
      >`SELECT COLLATION(store_name) AS collationName FROM structured_partitions WHERE id = 'part_scope_0'`;
      expect(collation[0]!.collationName).toMatch(/_ci$/);
      const scope = {
        orgId,
        clearance: 0,
        dataset: "business" as const,
        enterpriseKey: "synthetic",
        storeNameContains: ["麦家小馆"]
      };
      const rows = await repository.listReadableManifestRows({
        ...scope,
        startDate: "2026-09-07",
        endDate: "2026-09-07",
        maxPartitions: 10
      });
      expect(rows.map((row) => row.storeName).sort()).toEqual(["麦家小馆东店", "麦家小馆西店"]);
      expect(rows.map((row) => row.merchantId)).toContain(null);
      const enterpriseOnly = await repository.listCoverage!({
        orgId,
        clearance: 0,
        dataset: "business",
        enterpriseKey: "synthetic"
      });
      expect(enterpriseOnly.enterprises.map((enterprise) => enterprise.enterpriseKey)).toEqual([
        "synthetic"
      ]);
      const coverage = await repository.listCoverage!(scope);
      expect(coverage.enterprises).toHaveLength(1);
      expect(coverage.enterprises[0]).toMatchObject({ partitionCount: 2, totalRowCount: 6n });
      expect(coverage.enterprises[0]!.stores.map((store) => store.storeName).sort()).toEqual(
        rows.map((row) => row.storeName).sort()
      );
      const union = await repository.listReadableManifestRows({
        ...scope,
        storeNameContains: ["麦家小馆", "A%_\\"],
        startDate: "2026-09-07",
        endDate: "2026-09-07",
        maxPartitions: 10
      });
      expect(union.map((row) => row.storeName).sort()).toEqual(
        ["麦家小馆东店", "麦家小馆西店", "前缀A%_\\后缀"].sort()
      );
      const literal = { ...scope, storeNameContains: ["A%_\\"] };
      expect(
        (
          await repository.listReadableManifestRows({
            ...literal,
            startDate: "2026-09-07",
            endDate: "2026-09-07",
            maxPartitions: 10
          })
        ).map((row) => row.storeName)
      ).toEqual(["前缀A%_\\后缀"]);
      expect((await repository.listCoverage!(literal)).enterprises[0]!.partitionCount).toBe(1);
      expect(
        (
          await repository.listReadableManifestRows({
            ...scope,
            storeIds: ["scope001"],
            startDate: "2026-09-07",
            endDate: "2026-09-07",
            maxPartitions: 10
          })
        ).map((row) => row.merchantId)
      ).toEqual(["scope001"]);
    } finally {
      await prisma.structuredPartition.deleteMany({ where: { orgId: "partition_other_org" } });
      await prisma.organization.delete({ where: { id: "partition_other_org" } });
    }
  });

  it("cleans exact store partitions on the original schema while preserving mixed jobs and accounts", async () => {
    await createProcessingJob("cleanup_base");
    const run = await prisma.processingRun.findUniqueOrThrow({
      where: { partitionImportJobId: "pjob_cleanup_base" }
    });
    for (const [id, storeName] of [
      ["cleanup_target", "CleanupA%_店"],
      ["cleanup_keep", "CleanupAxx店"]
    ]) {
      await prisma.structuredPartition.create({
        data: {
          ...candidate({
            id,
            storeKey: id,
            storeName,
            objectKey: `structured-partitions/${orgId}/${id}.csv`,
            confidentialityLevel: 0
          }),
          businessDate: new Date("2026-09-07"),
          publishedByJobId: "pjob_cleanup_base"
        }
      });
    }
    const cleanup = createStoreCleanupRepository(prisma);
    const scope = {
      orgId,
      enterpriseName: "Synthetic",
      datasets: ["business" as const],
      storeNameContains: ["CleanupA%_"]
    };
    await expect(
      cleanup.buildStoreCleanupInventory({ ...scope, storeNameContains: [] })
    ).rejects.toThrow();
    await expect(
      cleanup.buildStoreCleanupInventory({ ...scope, enterpriseName: "synthetic" })
    ).rejects.toThrow("STORE_CLEANUP_EMPTY_MATCH");
    const inventory = await cleanup.buildStoreCleanupInventory(scope);
    expect(inventory.targets.map((row) => row.id)).toEqual(["cleanup_target"]);
    await prisma.structuredPartition.update({
      where: { id: "cleanup_target" },
      data: { rowCount: 9n }
    });
    await expect(
      cleanup.executeStoreCleanup({ inventory, expectedFingerprint: inventory.fingerprint })
    ).rejects.toThrow("STORE_CLEANUP_FINGERPRINT_MISMATCH");
    const refreshed = await cleanup.buildStoreCleanupInventory(scope);
    const job = await prisma.partitionImportJob.findUniqueOrThrow({
      where: { id: "pjob_cleanup_base" }
    });
    const employee = await prisma.employee.findUniqueOrThrow({ where: { id: employeeId } });
    const result = await cleanup.executeStoreCleanup({
      inventory: refreshed,
      expectedFingerprint: refreshed.fingerprint
    });
    expect(result).toMatchObject({
      deletedPartitionCount: 1,
      garbageObjectCount: 1,
      externalCleanupPending: true
    });
    expect(
      await prisma.structuredPartition.findUnique({ where: { id: "cleanup_target" } })
    ).toBeNull();
    expect(
      await prisma.structuredPartition.findUnique({ where: { id: "cleanup_keep" } })
    ).not.toBeNull();
    expect(await prisma.partitionImportJob.findUniqueOrThrow({ where: { id: job.id } })).toEqual(
      job
    );
    expect(await prisma.processingRun.findUniqueOrThrow({ where: { id: run.id } })).toEqual(run);
    expect(await prisma.employee.findUniqueOrThrow({ where: { id: employeeId } })).toEqual(
      employee
    );
    const garbage = await repository.listDueGarbage(new Date(), 100);
    expect(
      garbage.some((row) => row.objectKey === `structured-partitions/${orgId}/cleanup_target.csv`)
    ).toBe(true);
    expect(
      garbage.some((row) => row.objectKey === `structured-partitions/${orgId}/cleanup_keep.csv`)
    ).toBe(false);
    for (const row of garbage) await repository.deleteGarbage(row.id);
    expect(
      (await repository.listDueGarbage(new Date(), 100)).some(
        (row) => row.objectKey === `structured-partitions/${orgId}/cleanup_target.csv`
      )
    ).toBe(false);
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
