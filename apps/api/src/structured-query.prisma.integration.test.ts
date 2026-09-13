import { PrismaMariaDb } from "@prisma/adapter-mariadb";
import { DocumentStatus, DocumentType, PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const runIntegration = process.env["RUN_STRUCTURED_QUERY_PRISMA_INTEGRATION"] === "1";
const describeIntegration = runIntegration ? describe : describe.skip;
const databaseUrl = process.env["DATABASE_URL"] ?? "";
const orgId = "confidentiality-query-prisma-org";

describeIntegration("Prisma confidentiality persistence", () => {
  const prisma = new PrismaClient({ adapter: new PrismaMariaDb(databaseUrl) });

  beforeAll(async () => {
    await prisma.organization.create({ data: { id: orgId, name: "Confidentiality Query Test" } });
    await prisma.employee.createMany({
      data: [
        {
          id: "confidentiality-query-clearance-0",
          orgId,
          email: "clearance-0@example.invalid",
          displayName: "Clearance zero",
          role: "employee",
          clearance: 0
        },
        {
          id: "confidentiality-query-clearance-3",
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
    await prisma.document.deleteMany({ where: { orgId } });
    await prisma.employee.deleteMany({ where: { orgId } });
    await prisma.organization.deleteMany({ where: { id: orgId } });
    await prisma.$disconnect();
  });

  it("persists independent employee clearance and immutable document levels", async () => {
    await prisma.document.createMany({
      data: [
        {
          id: "confidentiality-query-doc-0",
          orgId,
          uploaderId: "confidentiality-query-clearance-0",
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
          uploaderId: "confidentiality-query-clearance-3",
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
});
