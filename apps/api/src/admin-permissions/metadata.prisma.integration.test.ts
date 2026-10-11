import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PrismaClient } from "@prisma/client";
import { createDatabaseAdapter } from "@smedc/db";
import { createPrismaPermissionsUiMetadata } from "./metadata.js";
const enabled = process.env["RUN_AUTH_INTEGRATION"] === "1";
const url = process.env["DATABASE_URL"] ?? "mysql://unused:unused@127.0.0.1:3307/unused";
if (enabled && !["localhost", "127.0.0.1"].includes(new URL(url).hostname))
  throw new Error("Metadata tests require loopback MySQL");
(enabled ? describe : describe.skip)("Prisma permissions UI metadata", () => {
  const prisma = new PrismaClient({ adapter: createDatabaseAdapter(url) });
  const metadata = createPrismaPermissionsUiMetadata(prisma);
  const organizations = ["ui_metadata_a", "ui_metadata_b"];
  beforeAll(async () => {
    for (const orgId of organizations) {
      await prisma.organization.create({
        data: { id: orgId, name: "Never infer this organization name" }
      });
      await prisma.employee.create({
        data: {
          id: `${orgId}_admin`,
          orgId,
          email: `${orgId}@example.invalid`,
          displayName: "测试管理员",
          role: "admin",
          clearance: 3
        }
      });
      await prisma.businessAuthorizationState.create({ data: { orgId } });
    }
    await prisma.document.createMany({
      data: Array.from({ length: 52 }, (_, index) => ({
        id: `ui_metadata_doc_${String(index).padStart(2, "0")}`,
        orgId: organizations[0]!,
        title: `普通文档 ${index}`,
        documentType: "management_knowledge" as const,
        documentKind: "evidence" as const,
        status: "active" as const,
        storageObjectKey: "must-never-expose-storage-key",
        uploaderId: `${organizations[0]}_admin`,
        sourceMetadata: { secretContent: "must-never-expose-content" }
      }))
    });
    await prisma.document.create({
      data: {
        id: "ui_metadata_foreign",
        orgId: organizations[1]!,
        title: "Foreign enterprise secret",
        documentType: "management_knowledge",
        documentKind: "evidence",
        status: "active",
        storageObjectKey: "foreign-key",
        uploaderId: `${organizations[1]}_admin`
      }
    });
  });
  afterAll(async () => {
    await prisma.businessStore.deleteMany({ where: { orgId: { in: organizations } } });
    await prisma.document.deleteMany({ where: { orgId: { in: organizations } } });
    await prisma.businessAuthorizationState.deleteMany({ where: { orgId: { in: organizations } } });
    await prisma.employee.deleteMany({ where: { orgId: { in: organizations } } });
    await prisma.organization.deleteMany({ where: { id: { in: organizations } } });
    await prisma.$disconnect();
  });
  it("never guesses business identity from organization name or another tenant's directories", async () => {
    expect(await metadata.listEnterprises(organizations[0]!)).toEqual([]);
    await prisma.businessStore.createMany({
      data: [
        { orgId: organizations[0]!, enterpriseKey: "declared-enterprise", name: "本企业门店" },
        { orgId: organizations[1]!, enterpriseKey: "foreign-enterprise", name: "外企业门店" }
      ]
    });
    expect(await metadata.listEnterprises(organizations[0]!)).toEqual([
      { enterpriseKey: "declared-enterprise", enterpriseName: "declared-enterprise" }
    ]);
  });
  it("paginates evidence permission metadata at 50 without exposing content or storage fields", async () => {
    const first = await metadata.listDocuments(organizations[0]!, {});
    expect(first.documents).toHaveLength(50);
    expect(first.nextCursor).toBe(first.documents[49]!.id);
    const second = await metadata.listDocuments(organizations[0]!, { cursor: first.nextCursor! });
    expect(second.documents).toHaveLength(2);
    expect(second.nextCursor).toBeNull();
    expect(new Set([...first.documents, ...second.documents].map((doc) => doc.id)).size).toBe(52);
    const serialized = JSON.stringify(first);
    for (const forbidden of [
      "storageObjectKey",
      "sourceMetadata",
      "must-never-expose",
      "downloadUrl",
      "Foreign enterprise secret",
      "contentVersion"
    ])
      expect(serialized).not.toContain(forbidden);
  });
  it("filters safe metadata by document id or name within the current organization", async () => {
    expect(
      (
        await metadata.listDocuments(organizations[0]!, { search: "ui_metadata_doc_00" })
      ).documents.map((doc) => doc.id)
    ).toEqual(["ui_metadata_doc_00"]);
    expect(
      (await metadata.listDocuments(organizations[0]!, { search: "普通文档 51" })).documents.map(
        (doc) => doc.id
      )
    ).toEqual(["ui_metadata_doc_51"]);
    expect(
      (await metadata.listDocuments(organizations[0]!, { search: "ui_metadata_foreign" })).documents
    ).toEqual([]);
  });
});
