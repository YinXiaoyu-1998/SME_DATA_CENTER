import {
  compileStructuredQuery,
  compileStructuredCoverageQuery,
  canReadResource,
  type AuthorizationSnapshot
} from "@smedc/domain";
import {
  compileStructuredReadScope,
  createPrismaStructuredPartitionRepository,
  getSourceReadRequirements
} from "@smedc/db";
import { createPrismaSourceDocumentRepository } from "./source-documents.js";
import { PrismaMariaDb } from "@prisma/adapter-mariadb";
import { DocumentStatus, DocumentType, PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const runIntegration = process.env["RUN_STRUCTURED_QUERY_PRISMA_INTEGRATION"] === "1";
const describeIntegration = runIntegration ? describe : describe.skip;
const databaseUrl = process.env["DATABASE_URL"] ?? "";
if (runIntegration) {
  const parsed = new URL(databaseUrl);
  if (
    !["localhost", "127.0.0.1"].includes(parsed.hostname) ||
    !/^\/smedc_integration_[a-f0-9]{32}$/.test(parsed.pathname) ||
    parsed.search ||
    parsed.hash
  )
    throw new Error("Structured read tests require a runner-owned loopback database");
}
const orgId = "confidentiality-query-prisma-org";

describeIntegration("Prisma confidentiality persistence", () => {
  const prisma = new PrismaClient({ adapter: new PrismaMariaDb(databaseUrl) });

  beforeAll(async () => {
    await prisma.organization.create({ data: { id: orgId, name: "Confidentiality Query Test" } });
    await prisma.employee.createMany({
      data: [
        {
          id: "cq-clearance-0",
          orgId,
          email: "clearance-0@example.invalid",
          displayName: "Clearance zero",
          role: "employee",
          clearance: 0
        },
        {
          id: "cq-clearance-3",
          orgId,
          email: "clearance-3@example.invalid",
          displayName: "Clearance three",
          role: "admin",
          clearance: 3
        }
      ]
    });
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("persists independent employee clearance and immutable document levels", async () => {
    await prisma.document.createMany({
      data: [
        {
          id: "confidentiality-query-doc-0",
          orgId,
          uploaderId: "cq-clearance-0",
          title: "Level zero",
          documentType: DocumentType.management_knowledge,
          status: DocumentStatus.active,
          confidentialityLevel: 0,
          storageObjectKey: "test/level-0",
          originalFileName: "level-0.md",
          byteSize: 1,
          checksumSha256: "0".repeat(64)
        },
        {
          id: "confidentiality-query-doc-3",
          orgId,
          uploaderId: "cq-clearance-3",
          title: "Level three",
          documentType: DocumentType.management_knowledge,
          status: DocumentStatus.active,
          confidentialityLevel: 3,
          storageObjectKey: "test/level-3",
          originalFileName: "level-3.md",
          byteSize: 1,
          checksumSha256: "3".repeat(64)
        }
      ]
    });

    const visibleToZero = await prisma.document.findMany({
      where: { orgId, confidentialityLevel: { lte: 0 } },
      orderBy: { id: "asc" },
      select: { id: true }
    });
    const visibleToThree = await prisma.document.findMany({
      where: { orgId, confidentialityLevel: { lte: 3 } },
      orderBy: { id: "asc" },
      select: { id: true }
    });

    expect(visibleToZero).toEqual([{ id: "confidentiality-query-doc-0" }]);
    expect(visibleToThree).toEqual([
      { id: "confidentiality-query-doc-0" },
      { id: "confidentiality-query-doc-3" }
    ]);
  });
  it("filters before counts/pagination, keeps VIP group-owned and authorizes complete original lineage", async () => {
    await prisma.businessAuthorizationState.create({ data: { orgId, mode: "enabled" } });
    for (const key of ["business", "vip"])
      await prisma.businessCategory.create({
        data: {
          orgId,
          id: `current-${key}`,
          key,
          name: key,
          kind: "fixed",
          confidentialityLevel: 0,
          allowGroup: key === "vip",
          allowStore: key === "business"
        }
      });
    const snapshot: AuthorizationSnapshot = {
      orgId,
      employeeId: "cq-clearance-0",
      role: "employee",
      disabled: false,
      clearance: 0,
      mode: "enabled",
      authorizationVersion: "1",
      categories: [
        {
          id: "current-business",
          kind: "fixed",
          confidentialityLevel: 0,
          ownerships: ["store"],
          requiredDimensionIds: []
        },
        {
          id: "current-vip",
          kind: "fixed",
          confidentialityLevel: 0,
          ownerships: ["group"],
          requiredDimensionIds: []
        }
      ],
      grants: [
        {
          id: "A",
          orgId,
          enterpriseKey: "enterprise",
          categoryIds: ["current-business"],
          ownership: "store",
          stores: { kind: "fixed", values: ["A"] },
          dimensions: {}
        },
        {
          id: "vip",
          orgId,
          enterpriseKey: "enterprise",
          categoryIds: ["current-vip"],
          ownership: "group",
          dimensions: {}
        }
      ]
    };
    const partitions = createPrismaStructuredPartitionRepository({ prisma });
    for (const [index, name] of ["B", "a", "A ", "A"].entries()) {
      const id = `auth-part-${index}`;
      await prisma.structuredPartition.create({
        data: {
          id,
          orgId,
          enterpriseKey: "enterprise",
          enterpriseName: "Enterprise",
          dataset: "business",
          storeKey: `key-${index}`,
          storeName: name,
          businessDate: new Date("2026-10-01"),
          objectKey: `fixture/${id}`,
          rowCount: BigInt(index + 1),
          byteSize: 10n,
          checksumSha256: "0".repeat(64),
          confidentialityLevel: 3,
          publishedByJobId: "fixture"
        }
      });
      await prisma.businessStore.create({ data: { orgId, enterpriseKey: "enterprise", name } });
      await prisma.businessResource.create({
        data: {
          id,
          orgId,
          kind: "structured",
          resourceKey: `partition:${id}`,
          categoryId: "current-business",
          valid: true,
          scopes: {
            create: {
              id: `scope-${index}`,
              enterpriseKey: "enterprise",
              ownership: "store",
              storeName: name
            }
          }
        }
      });
    }
    const scope = {
      orgId,
      clearance: 0,
      authorization: snapshot,
      dataset: "business" as const,
      enterpriseKey: "enterprise",
      startDate: "2026-10-01",
      endDate: "2026-10-01",
      maxPartitions: 1
    };
    expect((await partitions.listReadableManifestRows(scope)).map((row) => row.storeName)).toEqual([
      "A"
    ]);
    expect(
      (await partitions.listReadableManifestRows({ ...scope, storeNameContains: ["A", "B"] })).map(
        (row) => row.storeName
      )
    ).toEqual(["A"]);
    const coverage = await partitions.listCoverage!({
      orgId,
      clearance: 0,
      authorization: snapshot,
      dataset: "business"
    });
    expect(coverage.enterprises).toMatchObject([
      { partitionCount: 1, totalRowCount: 4n, stores: [{ storeName: "A" }] }
    ]);
    expect(
      await partitions.listReadableManifestRows({
        ...scope,
        authorization: {
          ...snapshot,
          categories: snapshot.categories.map((category) => ({
            ...category,
            confidentialityLevel: 1
          }))
        }
      })
    ).toEqual([]);
    const documentId = "auth-vip-source";
    await prisma.document.create({
      data: {
        id: documentId,
        orgId,
        uploaderId: "cq-clearance-3",
        title: "VIP A recharge/B enrollment",
        documentType: "management_knowledge",
        documentKind: "structured",
        status: "active",
        confidentialityLevel: 3,
        storageObjectKey: "test/vip",
        originalFileName: "vip.xlsx",
        byteSize: 1,
        checksumSha256: "0".repeat(64)
      }
    });
    await prisma.importBatch.create({
      data: {
        id: "auth-vip-batch",
        orgId,
        sourceDocumentId: documentId,
        dataset: "vip",
        idempotencyKey: "auth",
        requestFingerprint: "0".repeat(64),
        status: "applied",
        appliedAt: new Date(),
        appliedRowCount: 2,
        startDate: new Date("2026-10-01"),
        endDate: new Date("2026-10-01")
      }
    });
    for (const [index, store] of ["A", "B"].entries())
      await prisma.vipRow.create({
        data: {
          orgId,
          importBatchId: "auth-vip-batch",
          sourceDocumentId: documentId,
          sourceRowNumber: index + 1,
          payload: { member_id: `member-${store}`, store_name: store }
        }
      });
    await prisma.businessResource.create({
      data: {
        id: "auth-vip-fragment",
        orgId,
        kind: "source_fragment",
        resourceKey: "auth-vip-fragment",
        sourceDocumentId: documentId,
        categoryId: "current-vip",
        valid: true,
        scopes: { create: { id: "vip-scope", enterpriseKey: "enterprise", ownership: "group" } }
      }
    });
    const compiled = compileStructuredQuery({
      orgId,
      employee: { id: snapshot.employeeId, clearance: 0 },
      cursorSecret: "synthetic",
      query: { dataset: "vip", aggregates: [{ op: "count", as: "total" }] },
      businessAuthorization: {
        version: snapshot.authorizationVersion,
        ...compileStructuredReadScope(snapshot, "row", "vip")
      }
    });
    expect(await prisma.$queryRawUnsafe(compiled.sql, ...compiled.params)).toEqual([{ total: 2n }]);
    const compiledCoverage = compileStructuredCoverageQuery({
      orgId,
      employee: { id: snapshot.employeeId, clearance: 0 },
      dataset: "vip",
      businessAuthorization: compileStructuredReadScope(snapshot, "coverage", "vip")
    });
    expect(
      await prisma.$queryRawUnsafe(compiledCoverage.sql!, ...compiledCoverage.params)
    ).toMatchObject([{ row_count: 2 }]);
    const originals = createPrismaSourceDocumentRepository(databaseUrl);
    const originalActor = {
      id: "cq-clearance-0",
      orgId,
      role: "employee" as const,
      clearance: 0,
      disabled: false,
      organizationName: "Synthetic",
      displayName: "Synthetic",
      email: "synthetic@example.invalid"
    };
    await prisma.businessGrant.create({
      data: {
        id: "read-vip",
        orgId,
        employeeId: originalActor.id,
        enterpriseKey: "enterprise",
        ownership: "group"
      }
    });
    await prisma.businessGrantCategory.create({
      data: { orgId, grantId: "read-vip", categoryId: "current-vip" }
    });
    expect(
      await originals.findDownloadableSourceDocuments({
        orgId,
        employee: originalActor,
        sourceDocumentIds: [documentId]
      })
    ).toMatchObject([{ sourceDocumentId: documentId }]);
    const requirements = await getSourceReadRequirements(prisma, documentId, orgId);
    expect(
      requirements.every((requirement) => canReadResource(snapshot, requirement).allowed)
    ).toBe(true);
    await prisma.businessResource.create({
      data: {
        id: "auth-ab-fragment",
        orgId,
        kind: "source_fragment",
        resourceKey: "auth-ab-fragment",
        sourceDocumentId: documentId,
        categoryId: "current-business",
        valid: true,
        scopes: {
          create: ["A", "B"].map((name) => ({
            id: `original-${name}`,
            enterpriseKey: "enterprise",
            ownership: "store",
            storeName: name
          }))
        }
      }
    });
    expect(
      (await getSourceReadRequirements(prisma, documentId, orgId)).every(
        (requirement) => canReadResource(snapshot, requirement).allowed
      )
    ).toBe(false);
    expect(
      await originals.findDownloadableSourceDocuments({
        orgId,
        employee: originalActor,
        sourceDocumentIds: [documentId]
      })
    ).toEqual([]);
    // Account has no grants in the authoritative DB; its admin uploader is also no read bypass.
    expect(
      await originals.findDownloadableSourceDocuments({
        orgId,
        employee: {
          id: "cq-clearance-3",
          orgId,
          role: "admin",
          clearance: 3,
          disabled: false,
          organizationName: "Synthetic",
          displayName: "Synthetic",
          email: "synthetic@example.invalid"
        },
        sourceDocumentIds: [documentId]
      })
    ).toEqual([]);
    await originals.disconnect?.();
  });
});
