import { createPrismaAuthOperatorRepository } from "../../../apps/api/src/auth/prisma-auth-operator-repository.js";
import { randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { canReadResource, validateBusinessGrant, type BusinessGrant } from "@smedc/domain";
import { createDatabaseAdapter } from "./adapter.js";
import { createBusinessAuthorizationRepository } from "./business-authorization.js";
import { compileAuthorizedScope } from "./business-authorization-sql.js";

const run = process.env["RUN_BUSINESS_AUTHORIZATION_PRISMA_INTEGRATION"] === "1";
const suite = run ? describe : describe.skip;
const url = process.env["DATABASE_URL"] ?? "";
if (run) {
  const parsed = new URL(url);
  if (
    !["localhost", "127.0.0.1"].includes(parsed.hostname) ||
    !/^\/smedc_integration_[a-f0-9]{32}$/.test(parsed.pathname) ||
    parsed.search ||
    parsed.hash
  )
    throw new Error(
      "Business authorization tests require a runner-owned loopback integration database"
    );
}
const orgId = `ba_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
const actorId = `${orgId}_actor`;
const fixed = (...values: string[]) => ({ kind: "fixed" as const, values });

suite("business authorization Prisma foundation", () => {
  const prisma = new PrismaClient({ adapter: createDatabaseAdapter(url) });
  const repository = createBusinessAuthorizationRepository({ prisma });
  let version = "0";
  const context = () => ({ orgId, actorId, expectedVersion: version });
  async function write<T extends { authorizationVersion: string }>(
    operation: Promise<T>
  ): Promise<T> {
    const result = await operation;
    version = result.authorizationVersion;
    return result;
  }
  beforeAll(async () => {
    await prisma.organization.create({ data: { id: orgId, name: "Synthetic Authorization" } });
    await prisma.employee.create({
      data: {
        id: actorId,
        orgId,
        email: `${orgId}@example.invalid`,
        displayName: "Admin",
        role: "admin",
        clearance: 2
      }
    });
    await repository.initializeOrganization(orgId);
  });
  afterAll(async () => {
    // The runner drops the whole owned schema, including these run-scoped relational fixtures.
    await prisma.$disconnect();
  });
  it("persists stable configuration, exact stores, complete grants and SQL/policy parity", async () => {
    await write(repository.defineDimension({ ...context(), id: "project", name: "Project" }));
    for (const id of ["X", "Y"])
      await write(
        repository.defineDimensionValue({ ...context(), id, dimensionId: "project", name: id })
      );
    await write(
      repository.configureCategory({
        ...context(),
        id: "sales",
        key: "business",
        name: "Sales",
        kind: "fixed",
        confidentialityLevel: 2,
        ownerships: ["store"],
        requiredDimensionIds: ["project"]
      })
    );
    await write(
      repository.configureCategory({
        ...context(),
        id: "vip",
        key: "vip",
        name: "Members",
        kind: "fixed",
        confidentialityLevel: 1,
        ownerships: ["group"],
        requiredDimensionIds: []
      })
    );
    await write(
      repository.configureCategory({
        ...context(),
        id: "memo",
        name: "Memo",
        kind: "evidence",
        confidentialityLevel: null,
        ownerships: ["store"],
        requiredDimensionIds: ["project"]
      })
    );
    for (const name of ["A", "a", "A ", "B", "陆家嘴店", "陆家嘴一店"])
      await write(
        repository.putStore({
          ...context(),
          enterpriseKey: "enterprise",
          name,
          retired: name === "B"
        })
      );
    expect(await prisma.businessStore.count({ where: { orgId } })).toBe(6);
    const grants: BusinessGrant[] = [
      {
        id: "grantA",
        orgId,
        enterpriseKey: "enterprise",
        categoryIds: ["sales", "memo"],
        ownership: "store",
        stores: fixed("A"),
        dimensions: { project: fixed("X") }
      },
      {
        id: "grantB",
        orgId,
        enterpriseKey: "enterprise",
        categoryIds: ["sales"],
        ownership: "store",
        stores: fixed("B"),
        dimensions: { project: fixed("Y") }
      },
      {
        id: "grantVip",
        orgId,
        enterpriseKey: "enterprise",
        categoryIds: ["vip"],
        ownership: "group",
        dimensions: {}
      }
    ];
    await write(repository.replaceGrants({ ...context(), employeeId: actorId, grants }));
    const scopes = (storeName: string, project: string) => ({
      enterpriseKey: "enterprise",
      ownership: "store" as const,
      storeName,
      dimensions: { project }
    });
    for (const [key, categoryId, items, level] of [
      ["AX", "sales", [scopes("A", "X")], null],
      ["AY", "sales", [scopes("A", "Y")], null],
      ["BY", "sales", [scopes("B", "Y")], null],
      ["shared", "sales", [scopes("A", "X"), scopes("B", "Y")], null],
      ["lower", "sales", [scopes("a", "X")], null],
      ["space", "sales", [scopes("A ", "X")], null],
      [
        "vip",
        "vip",
        [{ enterpriseKey: "enterprise", ownership: "group" as const, dimensions: {} }],
        null
      ],
      ["memo", "memo", [scopes("A", "X")], 3]
    ] as const)
      await write(
        repository.putResource({
          ...context(),
          id: key,
          kind: categoryId === "memo" ? "evidence" : "structured",
          resourceKey: key,
          categoryId,
          valid: true,
          fileConfidentialityLevel: level,
          scopes: [...items]
        })
      );
    // Enable only this synthetic fixture. Enterprise activation API belongs to batch 8.
    await prisma.businessAuthorizationState.update({ where: { orgId }, data: { mode: "enabled" } });
    const snapshot = await repository.loadAuthorizationSnapshot(actorId, orgId);
    const requirements = await repository.listResourceReadRequirements(orgId);
    const expected = requirements
      .filter((row) => canReadResource(snapshot, row.requirement).allowed)
      .map((row) => row.id)
      .sort();
    const compiled = compileAuthorizedScope(snapshot, "resource");
    const actual = await prisma.$queryRawUnsafe<Array<{ id: string }>>(
      `SELECT r.id FROM business_resources r WHERE ${compiled.sql}`,
      ...compiled.params
    );
    expect(actual.map((row) => row.id).sort()).toEqual(expected);
    expect(expected).toEqual(["AX", "BY", "shared", "vip"]);
    const splitCategoryAndScope = {
      ...snapshot,
      grants: [{ ...snapshot.grants[0]!, categoryIds: ["memo"] }, snapshot.grants[1]!]
    };
    for (const entry of splitCategoryAndScope.grants)
      expect(validateBusinessGrant(entry, splitCategoryAndScope.categories)).toEqual([]);
    // Same rows, representative refusal boundaries; SQL must never turn a denial into an empty-scope grant.
    for (const candidate of [
      splitCategoryAndScope,
      { ...snapshot, disabled: true },
      { ...snapshot, orgId: "other" },
      { ...snapshot, mode: "preparing" as const },
      { ...snapshot, clearance: 0 },
      { ...snapshot, grants: [] },
      {
        ...snapshot,
        categories: snapshot.categories.map((category) =>
          category.id === "sales"
            ? { ...category, requiredDimensionIds: ["project", "future"] }
            : category
        )
      }
    ]) {
      const filter = compileAuthorizedScope(candidate, "resource");
      const selected = await prisma.$queryRawUnsafe<Array<{ id: string }>>(
        `SELECT r.id FROM business_resources r WHERE ${filter.sql}`,
        ...filter.params
      );
      expect(selected.map((row) => row.id).sort()).toEqual(
        requirements
          .filter((row) => canReadResource(candidate, row.requirement).allowed)
          .map((row) => row.id)
          .sort()
      );
    }
    const malicious = {
      ...snapshot,
      grants: snapshot.grants.map((grant) => ({ ...grant, enterpriseKey: "enterprise' OR 1=1 --" }))
    };
    const injection = compileAuthorizedScope(malicious, "resource");
    expect(injection.sql).not.toContain("OR 1=1 --");
    expect(injection.params).toContain("enterprise' OR 1=1 --");
    expect(
      await prisma.$queryRawUnsafe(
        `SELECT r.id FROM business_resources r WHERE ${injection.sql}`,
        ...injection.params
      )
    ).toEqual([]);
    expect(() => compileAuthorizedScope(snapshot, "arbitrary_table" as "resource")).toThrow(
      "UNKNOWN_AUTHORIZATION_TARGET"
    );

    await write(
      repository.replaceGrants({
        ...context(),
        employeeId: actorId,
        grants: [
          {
            ...grants[0]!,
            categoryIds: ["sales"],
            stores: { kind: "all" },
            dimensions: { project: { kind: "all" } }
          }
        ]
      })
    );
    const dynamic = await repository.loadAuthorizationSnapshot(actorId, orgId);
    const query = compileAuthorizedScope(dynamic, "resource");
    const dynamicRows = await prisma.$queryRawUnsafe<Array<{ id: string }>>(
      `SELECT r.id FROM business_resources r WHERE ${query.sql}`,
      ...query.params
    );
    expect(dynamicRows.map((row) => row.id).sort()).toEqual(
      requirements
        .filter((row) => canReadResource(dynamic, row.requirement).allowed)
        .map((row) => row.id)
        .sort()
    );
  });
  it("rejects stale writes atomically, preserves audit/version and separates content from authorization", async () => {
    const before = await prisma.businessResource.findUniqueOrThrow({
      where: { orgId_id: { orgId, id: "memo" } }
    });
    const oldVersion = version;
    await write(repository.updateAccount({ ...context(), employeeId: actorId, clearance: 2 }));
    await expect(
      repository.updateAccount({
        ...context(),
        expectedVersion: oldVersion,
        employeeId: actorId,
        clearance: 0
      })
    ).rejects.toThrow("AUTHORIZATION_VERSION_CONFLICT");
    expect((await prisma.employee.findUniqueOrThrow({ where: { id: actorId } })).clearance).toBe(2);
    await write(
      repository.putResource({
        ...context(),
        id: "memo",
        kind: "evidence",
        resourceKey: "memo",
        categoryId: "memo",
        valid: true,
        fileConfidentialityLevel: 1,
        scopes: [
          {
            enterpriseKey: "enterprise",
            ownership: "store",
            storeName: "A",
            dimensions: { project: "X" }
          }
        ]
      })
    );
    const after = await prisma.businessResource.findUniqueOrThrow({
      where: { orgId_id: { orgId, id: "memo" } }
    });
    expect(after.contentVersion).toBe(before.contentVersion);
    expect(after.authorizationVersion).toBeGreaterThan(before.authorizationVersion);
    expect(
      await prisma.businessAuthorizationAudit.count({ where: { orgId, outcome: "succeeded" } })
    ).toBe(Number(version));
    const currentVersion = version;
    await expect(
      repository.replaceGrants({
        ...context(),
        employeeId: actorId,
        grants: [
          {
            id: "bad",
            orgId,
            enterpriseKey: "enterprise",
            categoryIds: ["sales"],
            ownership: "store",
            stores: fixed("unknown"),
            dimensions: { project: fixed("X") }
          }
        ]
      })
    ).rejects.toThrow();
    expect((await repository.loadAuthorizationSnapshot(actorId, orgId)).authorizationVersion).toBe(
      currentVersion
    );
    expect(
      await prisma.businessAuthorizationAudit.count({ where: { orgId, outcome: "denied" } })
    ).toBeGreaterThan(0);
    const salesBefore = await prisma.businessResource.findUniqueOrThrow({
      where: { orgId_id: { orgId, id: "AX" } }
    });
    await write(
      repository.configureCategory({
        ...context(),
        id: "sales",
        key: "business",
        name: "Sales",
        kind: "fixed",
        confidentialityLevel: 1,
        ownerships: ["store"],
        requiredDimensionIds: ["project"]
      })
    );
    await write(repository.updateAccount({ ...context(), employeeId: actorId, clearance: 1 }));
    const current = await repository.loadAuthorizationSnapshot(actorId, orgId);
    const sales = await repository.getResourceReadRequirement("AX", orgId);
    expect(sales).not.toBeNull();
    expect(canReadResource(current, sales!).allowed).toBe(true);
    expect(
      (
        await prisma.businessResource.findUniqueOrThrow({
          where: { orgId_id: { orgId, id: "AX" } }
        })
      ).contentVersion
    ).toBe(salesBefore.contentVersion);
    const bad = compileAuthorizedScope(
      { ...(await repository.loadAuthorizationSnapshot(actorId, orgId)), disabled: true },
      "resource"
    );
    expect(
      await prisma.$queryRawUnsafe(
        `SELECT r.id FROM business_resources r WHERE ${bad.sql}`,
        ...bad.params
      )
    ).toEqual([]);
  });
  it("keeps source fragments complete when current resources change, and retains cross-org foreign keys", async () => {
    const sourceDocumentId = `${orgId}_source`;
    await prisma.document.create({
      data: {
        id: sourceDocumentId,
        orgId,
        uploaderId: actorId,
        title: "Synthetic source",
        documentType: "structured_dataset",
        documentKind: "structured",
        storageObjectKey: "synthetic/source.csv"
      }
    });
    const scopes = ["A", "B"].map((storeName) => ({
      enterpriseKey: "enterprise",
      ownership: "store" as const,
      storeName,
      dimensions: { project: "X" }
    }));
    await write(
      repository.putResource({
        ...context(),
        id: "fragment",
        kind: "source_fragment",
        resourceKey: "original-successful-parse",
        sourceDocumentId,
        categoryId: "sales",
        valid: true,
        scopes
      })
    );
    const before = await prisma.businessResource.findUniqueOrThrow({
      where: { orgId_id: { orgId, id: "shared" } }
    });
    await write(
      repository.putResource({
        ...context(),
        id: "shared",
        kind: "structured",
        resourceKey: "shared",
        categoryId: "sales",
        valid: true,
        scopes: [scopes[0]!]
      })
    );
    const after = await prisma.businessResource.findUniqueOrThrow({
      where: { orgId_id: { orgId, id: "shared" } }
    });
    expect(after.contentVersion).toBe(before.contentVersion + 1n);
    expect(
      (await repository.getSourceReadRequirements(sourceDocumentId, orgId))[0]!.scopes
    ).toHaveLength(2);
    await expect(
      repository.putResource({
        ...context(),
        id: "fragment",
        kind: "source_fragment",
        resourceKey: "original-successful-parse",
        sourceDocumentId,
        categoryId: "sales",
        valid: true,
        scopes: [scopes[0]!]
      })
    ).rejects.toThrow("SOURCE_REQUIREMENTS_IMMUTABLE");
    await expect(repository.getSourceReadRequirements("unparsed", orgId)).rejects.toThrow(
      "SOURCE_AUTHORIZATION_NOT_READY"
    );
    await expect(
      repository.putResource({
        ...context(),
        id: "wrong-kind",
        kind: "evidence",
        resourceKey: "wrong-kind",
        categoryId: "sales",
        valid: true,
        scopes
      })
    ).rejects.toThrow("RESOURCE_CATEGORY_KIND_MISMATCH");
    await expect(
      repository.configureCategory({
        ...context(),
        id: "invalid-fixed",
        key: "made-up",
        name: "Unknown fixed category",
        kind: "fixed",
        confidentialityLevel: 1,
        ownerships: ["store"],
        requiredDimensionIds: []
      })
    ).rejects.toThrow("INVALID_FIXED_CATEGORY");
    const other = `${orgId}_other`;
    await prisma.organization.create({ data: { id: other, name: "Other synthetic organization" } });
    await repository.initializeOrganization(other);
    await expect(
      prisma.businessGrant.create({
        data: {
          orgId: other,
          id: "cross-org",
          employeeId: actorId,
          enterpriseKey: "enterprise",
          ownership: "group"
        }
      })
    ).rejects.toThrow();
  });
  it("explicitly enriches retained source tuples for a newly required dimension without narrowing or content changes", async () => {
    const sourceDocumentId = `${orgId}_source`;
    const before = await prisma.businessResource.findUniqueOrThrow({
      where: { orgId_id: { orgId, id: "fragment" } }
    });
    const original = (await repository.getSourceReadRequirements(sourceDocumentId, orgId))[0]!;
    expect(
      canReadResource(await repository.loadAuthorizationSnapshot(actorId, orgId), original).allowed
    ).toBe(true);
    await write(repository.defineDimension({ ...context(), id: "region", name: "Region" }));
    for (const id of ["North", "South"])
      await write(
        repository.defineDimensionValue({ ...context(), dimensionId: "region", id, name: id })
      );
    await write(
      repository.configureCategory({
        ...context(),
        id: "sales",
        key: "business",
        name: "Sales",
        kind: "fixed",
        confidentialityLevel: 1,
        ownerships: ["store"],
        requiredDimensionIds: ["project", "region"]
      })
    );
    let snapshot = await repository.loadAuthorizationSnapshot(actorId, orgId);
    expect(
      canReadResource(
        snapshot,
        (await repository.getSourceReadRequirements(sourceDocumentId, orgId))[0]!
      ).allowed
    ).toBe(false);
    await write(
      repository.replaceGrants({
        ...context(),
        employeeId: actorId,
        grants: [
          {
            ...snapshot.grants[0]!,
            dimensions: { project: { kind: "all" }, region: { kind: "all" } }
          }
        ]
      })
    );
    snapshot = await repository.loadAuthorizationSnapshot(actorId, orgId);
    const missing = compileAuthorizedScope(snapshot, "resource");
    expect(canReadResource(snapshot, original).allowed).toBe(false);
    expect(
      await prisma.$queryRawUnsafe(
        `SELECT r.id FROM business_resources r WHERE r.id = 'fragment' AND ${missing.sql}`,
        ...missing.params
      )
    ).toEqual([]);
    const enriched = original.scopes.map((scope) => ({
      ...scope,
      dimensions: { ...scope.dimensions, region: scope.storeName === "A" ? "North" : "South" }
    }));
    const input = {
      ...context(),
      id: "fragment",
      kind: "source_fragment" as const,
      resourceKey: "original-successful-parse",
      sourceDocumentId,
      categoryId: "sales",
      valid: true,
      scopes: enriched
    };
    await write(repository.putResource(input));
    const after = await prisma.businessResource.findUniqueOrThrow({
      where: { orgId_id: { orgId, id: "fragment" } }
    });
    expect(after.contentVersion).toBe(before.contentVersion);
    expect(after.authorizationVersion).toBe(before.authorizationVersion + 1n);
    const requirement = (await repository.getSourceReadRequirements(sourceDocumentId, orgId))[0]!;
    expect(requirement.scopes).toEqual(expect.arrayContaining(enriched));
    expect(requirement.scopes).toHaveLength(original.scopes.length);
    snapshot = await repository.loadAuthorizationSnapshot(actorId, orgId);
    expect(canReadResource(snapshot, requirement).allowed).toBe(true);
    const compiled = compileAuthorizedScope(snapshot, "resource");
    const rows = await prisma.$queryRawUnsafe<Array<{ id: string }>>(
      `SELECT r.id FROM business_resources r WHERE ${compiled.sql}`,
      ...compiled.params
    );
    const requirements = await repository.listResourceReadRequirements(orgId);
    expect(rows.map((row) => row.id).sort()).toEqual(
      requirements
        .filter((row) => canReadResource(snapshot, row.requirement).allowed)
        .map((row) => row.id)
        .sort()
    );
    for (const scopes of [
      [enriched[0]!],
      [enriched[0]!, enriched[0]!],
      enriched.map((scope, index) =>
        index === 0 ? { ...scope, dimensions: { ...scope.dimensions, project: "Y" } } : scope
      ),
      enriched.map((scope, index) => (index === 0 ? { ...scope, storeName: "a" } : scope)),
      [...enriched, enriched[0]!]
    ])
      await expect(repository.putResource({ ...input, ...context(), scopes })).rejects.toThrow(
        "SOURCE_REQUIREMENTS_IMMUTABLE"
      );
    await expect(repository.putResource({ ...input, ...context(), valid: false })).rejects.toThrow(
      "SOURCE_REQUIREMENTS_IMMUTABLE"
    );
    expect((await repository.loadAuthorizationSnapshot(actorId, orgId)).authorizationVersion).toBe(
      version
    );
    expect(
      (await repository.getSourceReadRequirements(sourceDocumentId, orgId))[0]!.scopes
    ).toEqual(expect.arrayContaining(enriched));
  });
  it("atomically configures clearance and complete grants, audits both and rolls back missing scope references", async () => {
    const snapshot = await repository.loadAuthorizationSnapshot(actorId, orgId);
    version = snapshot.authorizationVersion;
    const grants: BusinessGrant[] = [
      {
        id: "account_atomic",
        orgId,
        enterpriseKey: "enterprise",
        categoryIds: ["sales"],
        ownership: "store",
        stores: fixed("A"),
        dimensions: { project: fixed("X"), region: fixed("North") }
      }
    ];
    await write(
      repository.configureAccount({ ...context(), employeeId: actorId, clearance: 0, grants })
    );
    const changed = await repository.loadAuthorizationSnapshot(actorId, orgId);
    expect(changed.clearance).toBe(0);
    expect(changed.grants).toEqual(grants);
    const audit = await prisma.businessAuthorizationAudit.findFirstOrThrow({
      where: {
        orgId,
        action: "account.permissions.configure",
        outcome: "succeeded",
        version: BigInt(version)
      }
    });
    expect(audit.before).toMatchObject({ clearance: snapshot.clearance, grants: snapshot.grants });
    expect(audit.after).toEqual({ clearance: 0, grants });
    await expect(
      repository.configureAccount({
        ...context(),
        employeeId: actorId,
        clearance: 3,
        grants: [{ ...grants[0]!, stores: fixed("missing") }]
      })
    ).rejects.toThrow();
    expect(await repository.loadAuthorizationSnapshot(actorId, orgId)).toEqual(changed);
    await prisma.employee.update({ where: { id: actorId }, data: { role: "employee" } });
    await expect(
      repository.configureAccount({ ...context(), employeeId: actorId, clearance: 3, grants: [] })
    ).rejects.toThrow("AUTHORIZATION_ADMIN_REQUIRED");
    const demoted = await repository.loadAuthorizationSnapshot(actorId, orgId);
    expect(demoted.clearance).toBe(0);
    expect(demoted.grants).toEqual(grants);
    expect(demoted.authorizationVersion).toBe(version);
    await prisma.employee.update({ where: { id: actorId }, data: { role: "admin", clearance: 2 } });
  });
  it("onboards with empty defaults or explicit grants and audits the transaction without credential data", async () => {
    const operator = createPrismaAuthOperatorRepository(prisma);
    const input = {
      orgId,
      normalizedEmail: `${orgId}_empty@example.invalid`,
      displayName: "Empty",
      role: "admin" as const,
      clearance: 3,
      grantTokenHash: "synthetic-hash-empty",
      grantExpiresAt: new Date(Date.now() + 60_000),
      now: new Date()
    };
    const first = await operator.onboard(input);
    expect((await repository.loadAuthorizationSnapshot(first.employeeId, orgId)).grants).toEqual(
      []
    );
    const grants: BusinessGrant[] = [
      {
        id: "onboard_explicit",
        orgId,
        enterpriseKey: "enterprise",
        categoryIds: ["sales"],
        ownership: "store",
        stores: fixed("A"),
        dimensions: { project: fixed("X"), region: fixed("North") }
      }
    ];
    const second = await operator.onboard({
      ...input,
      normalizedEmail: `${orgId}_explicit@example.invalid`,
      grantTokenHash: "synthetic-hash-explicit",
      initialGrants: grants
    });
    expect((await repository.loadAuthorizationSnapshot(second.employeeId, orgId)).grants).toEqual(
      grants
    );
    const audit = await prisma.auditLog.findFirstOrThrow({
      where: { targetId: second.employeeId, action: "operator.account.initial_permissions" }
    });
    expect(audit.actorEmployeeId).toBeNull();
    expect(audit.clientSource).toBe("operator_cli");
    expect(audit.metadata).toMatchObject({ before: null, after: { clearance: 3, grants } });
    expect(JSON.stringify(audit.metadata)).not.toContain("synthetic-hash");
    const beforeVersion = (await repository.loadAuthorizationSnapshot(actorId, orgId))
      .authorizationVersion;
    const badEmail = `${orgId}_bad@example.invalid`;
    await expect(
      operator.onboard({
        ...input,
        normalizedEmail: badEmail,
        initialGrants: [{ ...grants[0]!, id: "bad_onboard", stores: fixed("missing") }]
      })
    ).rejects.toThrow();
    expect(await prisma.employee.findUnique({ where: { email: badEmail } })).toBeNull();
    expect((await repository.loadAuthorizationSnapshot(actorId, orgId)).authorizationVersion).toBe(
      beforeVersion
    );
  });
});
