import { randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createDatabaseAdapter } from "./adapter.js";
import { createBusinessAuthorizationRepository } from "./business-authorization.js";
const run = process.env["RUN_STORE_REVIEW_PRISMA_INTEGRATION"] === "1";
const url = process.env["DATABASE_URL"] ?? "";
if (run) {
  const parsed = new URL(url);
  if (
    !["localhost", "127.0.0.1"].includes(parsed.hostname) ||
    !/^\/smedc_integration_[a-f0-9]{32}$/.test(parsed.pathname) ||
    parsed.search ||
    parsed.hash
  )
    throw new Error("Review enterprise tests require runner-owned loopback schema");
}
(run ? describe : describe.skip)("complete current store review enterprise options", () => {
  const prisma = new PrismaClient({ adapter: createDatabaseAdapter(url) });
  const repo = createBusinessAuthorizationRepository({ prisma });
  let orgId: string, id: string;
  beforeEach(async () => {
    orgId = `opt_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
    id = `${orgId}_admin`;
    await prisma.organization.create({
      data: { id: orgId, name: "Never substitute this organization name" }
    });
    await prisma.employee.create({
      data: {
        orgId,
        id,
        email: `${id}@example.invalid`,
        displayName: "Admin",
        role: "admin",
        clearance: 2
      }
    });
    await prisma.businessAuthorizationState.create({
      data: { orgId, mode: "enabled", version: 1n }
    });
    await prisma.businessCategory.create({
      data: {
        orgId,
        id: "reviews",
        key: "store_reviews",
        name: "Reviews",
        kind: "fixed",
        confidentialityLevel: 2,
        allowGroup: false,
        allowStore: true
      }
    });
  });
  afterAll(() => prisma.$disconnect());
  const card = async () => (await repo.loadPermissionCard(id, orgId)).storeReviewEnterprises;
  const declare = async (name: string) => {
    await prisma.businessEnterpriseIdentity.create({
      data: { orgId, enterpriseKey: name.toLowerCase(), enterpriseName: name }
    });
    await prisma.businessStore.create({
      data: { orgId, enterpriseKey: name.toLowerCase(), name: "同名门店" }
    });
  };
  const grant = async (
    enterpriseKey: string,
    stores: { kind: "all" } | { kind: "fixed"; values: string[] } = { kind: "all" }
  ) => {
    const state = await prisma.businessAuthorizationState.findUniqueOrThrow({ where: { orgId } });
    return repo.configureAccount({
      orgId,
      actorId: id,
      employeeId: id,
      expectedVersion: state.version.toString(),
      clearance: 2,
      grants: [
        {
          orgId,
          id: "review-grant",
          enterpriseKey,
          categoryIds: ["reviews"],
          ownership: "store",
          stores,
          dimensions: {}
        }
      ]
    });
  };
  it("lists zero, one and many registered writable enterprises without inferring undeclared keys", async () => {
    expect(await card()).toEqual({ complete: true, write: [], read: [] });
    await declare("Alpha");
    expect(await card()).toEqual({
      complete: true,
      write: [{ enterpriseKey: "alpha", enterpriseName: "Alpha" }],
      read: []
    });
    await declare("Beta");
    await prisma.businessStore.create({
      data: { orgId, enterpriseKey: "undeclared", name: "historic" }
    });
    const options = await card();
    expect(options.write.map((e) => e.enterpriseName)).toEqual(["Alpha", "Beta"]);
    expect(options.read).toEqual([]);
    await grant("alpha");
    expect((await card()).read).toEqual([{ enterpriseKey: "alpha", enterpriseName: "Alpha" }]);
  });
  it("separates read grants/clearance from administrator write authority and retains historical reads", async () => {
    await declare("Alpha");
    await grant("alpha", { kind: "fixed", values: ["同名门店"] });
    await prisma.businessStore.updateMany({ where: { orgId }, data: { retired: true } });
    expect(await card()).toMatchObject({ write: [], read: [{ enterpriseName: "Alpha" }] });
    await prisma.employee.update({ where: { id }, data: { role: "employee" } });
    expect(await card()).toMatchObject({ write: [], read: [{ enterpriseName: "Alpha" }] });
    await prisma.employee.update({ where: { id }, data: { clearance: 1 } });
    expect(await card()).toEqual({ complete: true, write: [], read: [] });
  });
  it("fails closed for disabled accounts, missing levels and every inactive mode", async () => {
    await declare("Alpha");
    await grant("alpha");
    for (const mode of ["legacy", "preparing", "suspended"] as const) {
      await prisma.businessAuthorizationState.update({ where: { orgId }, data: { mode } });
      expect(await card()).toEqual({ complete: true, write: [], read: [] });
    }
    await prisma.businessAuthorizationState.update({ where: { orgId }, data: { mode: "enabled" } });
    await prisma.employee.update({ where: { id }, data: { disabled: true } });
    expect(await card()).toEqual({ complete: true, write: [], read: [] });
    await prisma.employee.update({ where: { id }, data: { disabled: false } });
    await prisma.businessCategory.updateMany({
      where: { orgId },
      data: { confidentialityLevel: null }
    });
    expect(await card()).toEqual({ complete: true, write: [], read: [] });
  });
  it("initialization preserves mode, existing levels and grants while making review category empty", async () => {
    await prisma.businessCategory.deleteMany({ where: { orgId } });
    await prisma.businessCategory.create({
      data: {
        orgId,
        id: "old",
        key: "vip",
        name: "Old",
        kind: "fixed",
        confidentialityLevel: 3,
        allowGroup: true,
        allowStore: false
      }
    });
    await repo.initializeFixedCategories({ orgId, actorId: id, expectedVersion: "1" });
    expect(
      await prisma.businessCategory.findUnique({
        where: { orgId_key: { orgId, key: "store_reviews" } }
      })
    ).toMatchObject({ confidentialityLevel: null, allowGroup: false, allowStore: true });
    expect(
      await prisma.businessCategory.findUnique({ where: { orgId_key: { orgId, key: "vip" } } })
    ).toMatchObject({ id: "old", confidentialityLevel: 3 });
    expect(await prisma.businessAuthorizationState.findUnique({ where: { orgId } })).toMatchObject({
      mode: "enabled"
    });
    expect(await prisma.businessGrant.count({ where: { orgId } })).toBe(0);
  });
});
