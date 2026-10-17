import { createPrismaAuthOperatorRepository } from "../../../apps/api/src/auth/prisma-auth-operator-repository.js";
import { createPrismaDocumentCatalogRepository } from "../../../apps/api/src/documents.js";
import { randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { canReadResource, validateBusinessGrant, type BusinessGrant } from "@smedc/domain";
import { createDatabaseAdapter } from "./adapter.js";
import { createBusinessAuthorizationRepository } from "./business-authorization.js";
import {
  createPrismaStructuredPartitionRepository,
  type PartitionCandidate
} from "./structured-partitions.js";
import {
  getSourceReadRequirements,
  persistStructuredSourceReadRequirements,
  persistPartitionReadRequirement,
  persistPhotoReadRequirement,
  persistEvidenceReadRequirement,
  activateEvidenceReadRequirement,
  lockAuthorizationPublication
} from "./source-read-requirements.js";
import { toResourceReadRequirement, resourcesInclude } from "./business-authorization-records.js";
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
let orgId: string;
let actorId: string;
const fixed = (...values: string[]) => ({ kind: "fixed" as const, values });

suite("business authorization Prisma foundation", () => {
  const prisma = new PrismaClient({ adapter: createDatabaseAdapter(url) });
  const repository = createBusinessAuthorizationRepository({ prisma });
  // These foundation fixtures deliberately retain a retired store's pre-existing history.
  const historicalResource = (input: Parameters<typeof repository.putResource>[0]) =>
    repository.putResource({
      ...input,
      historicalSupplementReason: "Synthetic existing historical fixture"
    });
  let version = "0";
  const context = () => ({ orgId, actorId, expectedVersion: version });
  async function write<T extends { authorizationVersion: string }>(
    operation: Promise<T>
  ): Promise<T> {
    const result = await operation;
    version = result.authorizationVersion;
    return result;
  }
  beforeEach(async () => {
    orgId = `ba_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
    actorId = `${orgId}_actor`;
    version = "0";
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
    await prisma.businessAuthorizationState.create({ data: { orgId } });
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
          enterpriseName: "Enterprise",
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
    await write(
      repository.configureAccount({ clearance: 2, ...context(), employeeId: actorId, grants })
    );
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
        historicalResource({
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
  });
  afterEach(async () => {
    await prisma.document.updateMany({
      where: { orgId },
      data: { status: "archived", archivedAt: new Date() }
    });
  });
  afterAll(() => prisma.$disconnect());
  // Raw fixture inspection for SQL/policy parity; production reads use lifecycle-aware helpers.
  async function storedRequirements() {
    return (
      await prisma.businessResource.findMany({ where: { orgId }, include: resourcesInclude })
    ).map((row) => ({ id: row.id, requirement: toResourceReadRequirement(row) }));
  }
  async function createOriginalFixture() {
    const sourceDocumentId = `${orgId}_source`;
    await prisma.document.create({
      data: {
        id: sourceDocumentId,
        orgId,
        uploaderId: actorId,
        title: "Synthetic source",
        documentType: "structured_dataset",
        documentKind: "structured",
        status: "active",
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
      historicalResource({
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
    return { sourceDocumentId, scopes };
  }
  it("persists stable configuration, exact stores, complete grants and SQL/policy parity", async () => {
    const snapshot = await repository.loadAuthorizationSnapshot(actorId, orgId);
    const requirements = await storedRequirements();
    const grants = snapshot.grants;
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
      repository.configureAccount({
        clearance: 2,
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
    await write(
      repository.configureAccount({
        grants: (await repository.loadAuthorizationSnapshot(actorId, orgId)).grants,
        ...context(),
        employeeId: actorId,
        clearance: 2
      })
    );
    await expect(
      repository.configureAccount({
        grants: (await repository.loadAuthorizationSnapshot(actorId, orgId)).grants,
        ...context(),
        expectedVersion: oldVersion,
        employeeId: actorId,
        clearance: 0
      })
    ).rejects.toThrow("AUTHORIZATION_VERSION_CONFLICT");
    expect((await prisma.employee.findUniqueOrThrow({ where: { id: actorId } })).clearance).toBe(2);
    await write(
      historicalResource({
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
    ).toBe(Number(version) + 1); // The first store also audits enterprise creation at the same version.
    const currentVersion = version;
    await expect(
      repository.configureAccount({
        clearance: 2,
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
    await write(
      repository.configureAccount({
        grants: (await repository.loadAuthorizationSnapshot(actorId, orgId)).grants,
        ...context(),
        employeeId: actorId,
        clearance: 1
      })
    );
    const current = await repository.loadAuthorizationSnapshot(actorId, orgId);
    const sales = toResourceReadRequirement(
      await prisma.businessResource.findUniqueOrThrow({
        where: { orgId_id: { orgId, id: "AX" } },
        include: resourcesInclude
      })
    );
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
    const { sourceDocumentId, scopes } = await createOriginalFixture();
    const before = await prisma.businessResource.findUniqueOrThrow({
      where: { orgId_id: { orgId, id: "shared" } }
    });
    await write(
      historicalResource({
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
      (await getSourceReadRequirements(prisma, sourceDocumentId, orgId))[0]!.scopes
    ).toHaveLength(2);
    await expect(
      historicalResource({
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
    await expect(getSourceReadRequirements(prisma, "unparsed", orgId)).rejects.toThrow(
      "SOURCE_AUTHORIZATION_NOT_READY"
    );
    await expect(
      historicalResource({
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
    await prisma.businessAuthorizationState.create({ data: { orgId: other } });
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
    const { sourceDocumentId } = await createOriginalFixture();
    await write(
      repository.configureAccount({
        ...context(),
        employeeId: actorId,
        clearance: 2,
        grants: [
          {
            id: "all-sales",
            orgId,
            enterpriseKey: "enterprise",
            categoryIds: ["sales"],
            ownership: "store",
            stores: { kind: "all" },
            dimensions: { project: { kind: "all" } }
          }
        ]
      })
    );
    const before = await prisma.businessResource.findUniqueOrThrow({
      where: { orgId_id: { orgId, id: "fragment" } }
    });
    const original = (await getSourceReadRequirements(prisma, sourceDocumentId, orgId))[0]!;
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
        (await getSourceReadRequirements(prisma, sourceDocumentId, orgId))[0]!
      ).allowed
    ).toBe(false);
    await write(
      repository.configureAccount({
        clearance: 2,
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
    await write(historicalResource(input));
    const after = await prisma.businessResource.findUniqueOrThrow({
      where: { orgId_id: { orgId, id: "fragment" } }
    });
    expect(after.contentVersion).toBe(before.contentVersion);
    expect(after.authorizationVersion).toBe(before.authorizationVersion + 1n);
    const requirement = (await getSourceReadRequirements(prisma, sourceDocumentId, orgId))[0]!;
    expect(requirement.scopes).toEqual(expect.arrayContaining(enriched));
    expect(requirement.scopes).toHaveLength(original.scopes.length);
    snapshot = await repository.loadAuthorizationSnapshot(actorId, orgId);
    expect(canReadResource(snapshot, requirement).allowed).toBe(true);
    const compiled = compileAuthorizedScope(snapshot, "resource");
    const rows = await prisma.$queryRawUnsafe<Array<{ id: string }>>(
      `SELECT r.id FROM business_resources r WHERE ${compiled.sql}`,
      ...compiled.params
    );
    const requirements = await storedRequirements();
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
      await expect(historicalResource({ ...input, ...context(), scopes })).rejects.toThrow(
        "SOURCE_REQUIREMENTS_IMMUTABLE"
      );
    await expect(historicalResource({ ...input, ...context(), valid: false })).rejects.toThrow(
      "SOURCE_REQUIREMENTS_IMMUTABLE"
    );
    expect((await repository.loadAuthorizationSnapshot(actorId, orgId)).authorizationVersion).toBe(
      version
    );
    expect((await getSourceReadRequirements(prisma, sourceDocumentId, orgId))[0]!.scopes).toEqual(
      expect.arrayContaining(enriched)
    );
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
        dimensions: { project: fixed("X") }
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
      grantTokenHash: `${orgId}-synthetic-hash-empty`,
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
        dimensions: { project: fixed("X") }
      }
    ];
    const second = await operator.onboard({
      ...input,
      normalizedEmail: `${orgId}_explicit@example.invalid`,
      grantTokenHash: `${orgId}-synthetic-hash-explicit`,
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

suite("authoritative publication and original lineage", () => {
  const prisma = new PrismaClient({ adapter: createDatabaseAdapter(url) });
  let publicationOrg: string;
  let admin: string;
  let counter = 0;
  const nextId = () => `${publicationOrg}_${++counter}`;
  const documentData = (
    id: string,
    documentKind: "structured" | "quarantine_certificate" | "evidence" = "structured"
  ) => ({
    id,
    orgId: publicationOrg,
    uploaderId: admin,
    title: "Synthetic publication",
    documentType: "structured_dataset" as const,
    documentKind,
    status: "processing" as const,
    storageObjectKey: `synthetic/${id}`,
    sourceMetadata: { enterpriseKey: "enterprise" }
  });
  beforeEach(async () => {
    publicationOrg = `pub_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
    admin = `${publicationOrg}_admin`;
    counter = 0;
    await prisma.organization.create({
      data: { id: publicationOrg, name: "Synthetic publication" }
    });
    await prisma.employee.create({
      data: {
        id: admin,
        orgId: publicationOrg,
        email: `${publicationOrg}@example.invalid`,
        displayName: "Admin",
        role: "admin",
        clearance: 0
      }
    });
    await prisma.businessAuthorizationState.create({
      data: { orgId: publicationOrg, mode: "enabled" }
    });
    for (const [key, group] of [
      ["business", false],
      ["vip", true],
      ["delivery_ledger", false],
      ["quarantine_certificate", false]
    ] as const)
      await prisma.businessCategory.create({
        data: {
          orgId: publicationOrg,
          id: key,
          key,
          name: key,
          kind: "fixed",
          confidentialityLevel: 2,
          allowGroup: group,
          allowStore: !group
        }
      });
    await prisma.businessCategory.create({
      data: {
        orgId: publicationOrg,
        id: "memo",
        name: "Memo",
        kind: "evidence",
        allowGroup: true,
        allowStore: false
      }
    });
  });
  afterEach(async () => {
    // Global worker/GC scans must not observe this completed suite's synthetic work.
    await prisma.storageGarbage.deleteMany({
      where: { objectKey: { startsWith: `synthetic/${publicationOrg}_` } }
    });
    await prisma.processingRun.deleteMany({ where: { orgId: publicationOrg } });
    await prisma.document.updateMany({
      where: { orgId: publicationOrg, documentKind: "evidence" },
      data: { status: "archived", archivedAt: new Date() }
    });
  });

  afterAll(() => prisma.$disconnect());

  it("publishes all parsed source scopes with the document, keeps originals independent of current resources and resolves the current category level", async () => {
    const sourceDocumentId = nextId();
    await prisma.$transaction(async (tx) => {
      await tx.document.create({ data: documentData(sourceDocumentId) });
      await persistStructuredSourceReadRequirements(tx, {
        orgId: publicationOrg,
        sourceDocumentId,
        dataset: "business",
        workerId: "internal-worker",
        rows: ["A", "B", "A"].map((store_name) => ({ payload: { store_name } }))
      });
      await tx.document.update({ where: { id: sourceDocumentId }, data: { status: "active" } });
    });
    const requirements = await getSourceReadRequirements(prisma, sourceDocumentId, publicationOrg);
    expect(requirements).toEqual([
      {
        orgId: publicationOrg,
        categoryId: "business",
        fileConfidentialityLevel: null,
        valid: true,
        scopes: expect.arrayContaining(
          ["A", "B"].map((storeName) => ({
            enterpriseKey: "enterprise",
            ownership: "store",
            storeName,
            dimensions: {}
          }))
        )
      }
    ]);
    expect(requirements[0]?.scopes).toHaveLength(2);
    await prisma.$transaction(async (tx) => {
      const state = await lockAuthorizationPublication(tx, publicationOrg);
      await persistPartitionReadRequirement(
        tx,
        {
          orgId: publicationOrg,
          partitionId: "current-A",
          dataset: "business",
          enterpriseKey: "enterprise",
          storeName: "A",
          workerId: "partition-worker"
        },
        state
      );
    });
    expect(await getSourceReadRequirements(prisma, sourceDocumentId, publicationOrg)).toEqual(
      requirements
    );
    const repository = createBusinessAuthorizationRepository({ prisma });
    const snapshot = await repository.loadAuthorizationSnapshot(admin, publicationOrg);
    expect(canReadResource(snapshot, requirements[0]!).allowed).toBe(false);
    // Category authority stays a live reference; the original stores no copied upload level.
    await prisma.businessCategory.update({
      where: { orgId_id: { orgId: publicationOrg, id: "business" } },
      data: { confidentialityLevel: 3 }
    });
    expect(
      (await repository.loadAuthorizationSnapshot(admin, publicationOrg)).categories.find(
        (c) => c.id === "business"
      )?.confidentialityLevel
    ).toBe(3);
    expect(await getSourceReadRequirements(prisma, sourceDocumentId, publicationOrg)).toEqual(
      requirements
    );
    const audit = await prisma.auditLog.findFirstOrThrow({
      where: { orgId: publicationOrg, action: "resource.authorization.published" }
    });
    expect(audit.actorEmployeeId).toBeNull();
    expect(audit.clientSource).toBe("worker");
    await prisma.document.update({
      where: { id: sourceDocumentId },
      data: { status: "archived", archivedAt: new Date() }
    });
    expect(
      (await getSourceReadRequirements(prisma, sourceDocumentId, publicationOrg))[0]?.valid
    ).toBe(false);
  });

  it("rejects incomplete or zero parsed publication and rolls back documents, scopes, stores and audit writes", async () => {
    for (const [dataset, rows, error] of [
      ["business", [], "SOURCE_HAS_NO_PARSED_ROWS"],
      ["business", [{ payload: { store_name: "" } }], "RESOURCE_ATTRIBUTES_NOT_READY"],
      ["dishes", [{ payload: { store_name: "Fresh" } }], "RESOURCE_CATEGORY_NOT_CONFIGURED"]
    ] as const) {
      const sourceDocumentId = nextId();
      const before = await prisma.businessAuthorizationState.findUniqueOrThrow({
        where: { orgId: publicationOrg }
      });
      await expect(
        prisma.$transaction(async (tx) => {
          await tx.document.create({ data: documentData(sourceDocumentId) });
          await persistStructuredSourceReadRequirements(tx, {
            orgId: publicationOrg,
            sourceDocumentId,
            dataset,
            rows,
            workerId: "internal-worker"
          });
        })
      ).rejects.toThrow(error);
      expect(await prisma.document.findUnique({ where: { id: sourceDocumentId } })).toBeNull();
      expect(
        await prisma.businessResource.count({ where: { orgId: publicationOrg, sourceDocumentId } })
      ).toBe(0);
      expect(
        (
          await prisma.businessAuthorizationState.findUniqueOrThrow({
            where: { orgId: publicationOrg }
          })
        ).version
      ).toBe(before.version);
    }
    expect(
      await prisma.businessStore.count({ where: { orgId: publicationOrg, name: "Fresh" } })
    ).toBe(0);
    const failedSource = nextId();
    await expect(
      prisma.$transaction(async (tx) => {
        await tx.document.create({ data: documentData(failedSource) });
        await persistStructuredSourceReadRequirements(tx, {
          orgId: publicationOrg,
          sourceDocumentId: failedSource,
          dataset: "business",
          rows: [{ payload: { store_name: "Rollback store" } }],
          workerId: "internal-worker"
        });
        throw new Error("later row persistence failure");
      })
    ).rejects.toThrow("later row persistence failure");
    expect(
      await prisma.businessResource.count({
        where: { orgId: publicationOrg, sourceDocumentId: failedSource }
      })
    ).toBe(0);
    expect(
      await prisma.businessStore.count({ where: { orgId: publicationOrg, name: "Rollback store" } })
    ).toBe(0);
    expect(await prisma.document.findUnique({ where: { id: failedSource } })).toBeNull();
  });

  it("publishes an enabled tenant's internal receipt with an unset level and complete original lineage", async () => {
    await prisma.businessCategory.update({
      where: { orgId_id: { orgId: publicationOrg, id: "delivery_ledger" } },
      data: { confidentialityLevel: null }
    });
    const sourceDocumentId = nextId();
    await prisma.$transaction(async (tx) => {
      await tx.document.create({ data: documentData(sourceDocumentId) });
      await persistStructuredSourceReadRequirements(tx, {
        orgId: publicationOrg,
        sourceDocumentId,
        dataset: "delivery_ledger",
        workerId: "internal-worker",
        rows: [{ payload: { receipt_id: "INTERNAL-R-1", store_name: "Exact A " } }]
      });
      await tx.document.update({ where: { id: sourceDocumentId }, data: { status: "active" } });
    });
    expect(await getSourceReadRequirements(prisma, sourceDocumentId, publicationOrg)).toMatchObject(
      [
        {
          orgId: publicationOrg,
          categoryId: "delivery_ledger",
          valid: true,
          scopes: [
            {
              enterpriseKey: "enterprise",
              ownership: "store",
              storeName: "Exact A ",
              dimensions: {}
            }
          ]
        }
      ]
    );
    expect(
      await prisma.businessCategory.findUniqueOrThrow({
        where: { orgId_id: { orgId: publicationOrg, id: "delivery_ledger" } }
      })
    ).toMatchObject({ confidentialityLevel: null });
  });

  it("publishes membership as group-owned even when parsed rows contain multiple store labels", async () => {
    const sourceDocumentId = nextId();
    await prisma.$transaction(async (tx) => {
      await tx.document.create({ data: documentData(sourceDocumentId) });
      await persistStructuredSourceReadRequirements(tx, {
        orgId: publicationOrg,
        sourceDocumentId,
        dataset: "vip",
        workerId: "internal-worker",
        rows: ["A", "B"].map((store_name) => ({ payload: { store_name } }))
      });
      await tx.document.update({ where: { id: sourceDocumentId }, data: { status: "active" } });
    });
    expect(
      (await getSourceReadRequirements(prisma, sourceDocumentId, publicationOrg))[0]?.scopes
    ).toEqual([{ enterpriseKey: "enterprise", ownership: "group", dimensions: {} }]);
  });

  it("allows an explicitly scoped photo before its ledger, rejects a later ledger for another store, and preserves the photo", async () => {
    const photoId = nextId();
    const receiptId = `receipt-${photoId}`;
    await prisma.$transaction(async (tx) => {
      await tx.document.create({
        data: { ...documentData(photoId, "quarantine_certificate"), status: "active" }
      });
      await tx.quarantineCertificate.create({
        data: {
          orgId: publicationOrg,
          sourceDocumentId: photoId,
          receiptId,
          idempotencyKey: photoId,
          requestFingerprint: "synthetic"
        }
      });
      await persistPhotoReadRequirement(tx, {
        orgId: publicationOrg,
        sourceDocumentId: photoId,
        enterpriseKey: "enterprise",
        storeName: "Photo A",
        receiptId
      });
    });
    const badLedger = nextId();
    await expect(
      prisma.$transaction(async (tx) => {
        await tx.document.create({ data: documentData(badLedger) });
        await persistStructuredSourceReadRequirements(tx, {
          orgId: publicationOrg,
          sourceDocumentId: badLedger,
          dataset: "delivery_ledger",
          workerId: "internal-worker",
          rows: [{ payload: { store_name: "Ledger B", receipt_id: receiptId } }]
        });
      })
    ).rejects.toThrow("CERTIFICATE_STORE_MISMATCH");
    expect(await prisma.document.findUnique({ where: { id: badLedger } })).toBeNull();
    expect(
      await prisma.quarantineCertificate.count({
        where: { orgId: publicationOrg, sourceDocumentId: photoId }
      })
    ).toBe(1);
    const goodLedger = nextId();
    await prisma.$transaction(async (tx) => {
      await tx.document.create({ data: documentData(goodLedger) });
      await persistStructuredSourceReadRequirements(tx, {
        orgId: publicationOrg,
        sourceDocumentId: goodLedger,
        dataset: "delivery_ledger",
        workerId: "internal-worker",
        rows: [{ payload: { store_name: "Photo A", receipt_id: receiptId } }]
      });
      await tx.document.update({ where: { id: goodLedger }, data: { status: "active" } });
    });
    expect(
      (await getSourceReadRequirements(prisma, goodLedger, publicationOrg))[0]?.scopes[0]?.storeName
    ).toBe("Photo A");
  });
  it("requires an existing evidence category and activates only its complete explicit file attributes", async () => {
    const failed = nextId();
    await expect(
      prisma.$transaction(async (tx) => {
        await tx.document.create({ data: documentData(failed, "evidence") });
        await persistEvidenceReadRequirement(tx, {
          orgId: publicationOrg,
          documentId: failed,
          categoryId: "not-created",
          scopes: [{ enterpriseKey: "enterprise", ownership: "group", dimensions: {} }],
          fileConfidentialityLevel: 3,
          valid: false
        });
      })
    ).rejects.toThrow("RESOURCE_CATEGORY_NOT_CONFIGURED");
    expect(
      await prisma.businessCategory.findUnique({
        where: { orgId_id: { orgId: publicationOrg, id: "not-created" } }
      })
    ).toBeNull();
    expect(await prisma.document.findUnique({ where: { id: failed } })).toBeNull();
    const doc = nextId();
    await prisma.$transaction(async (tx) => {
      await tx.document.create({ data: documentData(doc, "evidence") });
      await persistEvidenceReadRequirement(tx, {
        orgId: publicationOrg,
        documentId: doc,
        categoryId: "memo",
        scopes: [{ enterpriseKey: "enterprise", ownership: "group", dimensions: {} }],
        fileConfidentialityLevel: 3,
        valid: false
      });
    });
    const where = {
      orgId_kind_resourceKey: { orgId: publicationOrg, kind: "evidence" as const, resourceKey: doc }
    };
    expect(await prisma.businessResource.findUniqueOrThrow({ where })).toMatchObject({
      valid: false,
      fileConfidentialityLevel: 3
    });
    await prisma.$transaction(async (tx) => {
      await activateEvidenceReadRequirement(tx, publicationOrg, doc);
      await tx.document.update({ where: { id: doc }, data: { status: "active" } });
    });
    expect(await prisma.businessResource.findUniqueOrThrow({ where })).toMatchObject({
      valid: true,
      fileConfidentialityLevel: 3
    });
  });
  it("preserves retired history, rejects ordinary replacement and activation, and audits explicit historical data correction", async () => {
    const permissions = createBusinessAuthorizationRepository({ prisma });
    const partitions = createPrismaStructuredPartitionRepository({ prisma });
    const date = "2026-08-19";
    const storeName = "Historical exact store";
    const reserve = async (reason?: string) => {
      const jobId = nextId();
      const temporaryObjectKey = `synthetic/${jobId}/source`;
      await partitions.reserveUpload({
        id: jobId,
        orgId: publicationOrg,
        uploaderId: admin,
        dataset: "business",
        enterpriseKey: "enterprise",
        enterpriseName: "Synthetic",
        confidentialityLevel: 0,
        idempotencyKey: jobId,
        requestFingerprint: "a".repeat(64),
        originalFileName: "historical.csv",
        mediaType: "text/csv",
        sourceByteSize: 100n,
        sourceChecksumSha256: "a".repeat(64),
        sourceStartDate: date,
        sourceEndDate: date,
        expiresAt: new Date(Date.now() + 60_000),
        temporaryObjectKey,
        multipartUploadId: jobId,
        historicalSupplementReason: reason
      });
      await partitions.queueCompletedUpload({ orgId: publicationOrg, jobId, temporaryObjectKey });
      expect(await partitions.markJobProcessing(publicationOrg, jobId)).toBe(true);
      return jobId;
    };
    const candidate = (id: string): PartitionCandidate => ({
      id,
      orgId: publicationOrg,
      enterpriseKey: "enterprise",
      enterpriseName: "Synthetic",
      dataset: "business",
      storeKey: "historical-store",
      storeName,
      merchantId: null,
      businessDate: date,
      objectKey: `synthetic/${id}/partition`,
      rowCount: 1n,
      byteSize: 10n,
      checksumSha256: id.padEnd(64, "0"),
      confidentialityLevel: 0
    });
    const publish = (jobId: string, value: PartitionCandidate) =>
      partitions.publishSourceAtomically({
        orgId: publicationOrg,
        jobId,
        totalRowCount: 1n,
        candidates: [value]
      });
    const original = candidate(nextId());
    await publish(await reserve(), original);
    const pending = nextId();
    await prisma.$transaction(async (tx) => {
      await tx.document.create({ data: documentData(pending, "evidence") });
      await persistEvidenceReadRequirement(tx, {
        orgId: publicationOrg,
        documentId: pending,
        categoryId: "memo",
        scopes: [{ enterpriseKey: "enterprise", ownership: "group", dimensions: {} }],
        fileConfidentialityLevel: 2,
        valid: false
      });
    });
    const currentContext = async () => ({
      orgId: publicationOrg,
      actorId: admin,
      expectedVersion: (await permissions.loadAuthorizationSnapshot(admin, publicationOrg))
        .authorizationVersion
    });
    await permissions.configureAccount({
      ...(await currentContext()),
      employeeId: admin,
      clearance: 3,
      grants: [
        {
          id: "historical-reader",
          orgId: publicationOrg,
          enterpriseKey: "enterprise",
          categoryIds: ["business"],
          ownership: "store",
          stores: fixed(storeName),
          dimensions: {}
        }
      ]
    });
    const resource = await prisma.businessResource.findUniqueOrThrow({
      where: {
        orgId_kind_resourceKey: {
          orgId: publicationOrg,
          kind: "structured",
          resourceKey: `partition:${original.id}`
        }
      }
    });
    const requirement = toResourceReadRequirement(
      await prisma.businessResource.findUniqueOrThrow({
        where: { orgId_id: { orgId: publicationOrg, id: resource.id } },
        include: resourcesInclude
      })
    );
    expect(
      canReadResource(
        await permissions.loadAuthorizationSnapshot(admin, publicationOrg),
        requirement!
      ).allowed
    ).toBe(true);
    await permissions.configureCategory({
      ...(await currentContext()),
      id: "business",
      key: "business",
      name: "business",
      kind: "fixed",
      confidentialityLevel: 3,
      ownerships: ["store"],
      requiredDimensionIds: [],
      retired: true
    });
    await permissions.putStore({
      ...(await currentContext()),
      enterpriseKey: "enterprise",
      enterpriseName: "Enterprise",
      name: storeName,
      retired: true
    });
    await permissions.configureCategory({
      ...(await currentContext()),
      id: "memo",
      name: "Memo",
      kind: "evidence",
      confidentialityLevel: null,
      ownerships: ["group"],
      requiredDimensionIds: [],
      retired: true
    });
    const snapshot = await permissions.loadAuthorizationSnapshot(admin, publicationOrg);
    expect(canReadResource(snapshot, requirement!).allowed).toBe(true);
    const rejectedJob = await reserve();
    await expect(publish(rejectedJob, candidate(nextId()))).rejects.toThrow(
      "RESOURCE_DIRECTORY_RETIRED"
    );
    expect(
      await prisma.structuredPartition.findUniqueOrThrow({ where: { id: original.id } })
    ).toMatchObject({ objectKey: original.objectKey, checksumSha256: original.checksumSha256 });
    expect(
      (await permissions.loadAuthorizationSnapshot(admin, publicationOrg)).authorizationVersion
    ).toBe(snapshot.authorizationVersion);
    await expect(
      prisma.$transaction((tx) => activateEvidenceReadRequirement(tx, publicationOrg, pending))
    ).rejects.toThrow("RESOURCE_DIRECTORY_RETIRED");
    expect(
      (await permissions.loadAuthorizationSnapshot(admin, publicationOrg)).authorizationVersion
    ).toBe(snapshot.authorizationVersion);
    expect(
      await prisma.businessResource.findUniqueOrThrow({
        where: {
          orgId_kind_resourceKey: { orgId: publicationOrg, kind: "evidence", resourceKey: pending }
        }
      })
    ).toMatchObject({ valid: false });
    const refusedEvidence = nextId();
    await expect(
      prisma.$transaction(async (tx) => {
        await tx.document.create({ data: documentData(refusedEvidence, "evidence") });
        await persistEvidenceReadRequirement(tx, {
          orgId: publicationOrg,
          documentId: refusedEvidence,
          categoryId: "memo",
          scopes: [{ enterpriseKey: "enterprise", ownership: "group", dimensions: {} }],
          fileConfidentialityLevel: 2,
          valid: false
        });
      })
    ).rejects.toThrow("RESOURCE_DIRECTORY_RETIRED");
    expect(await prisma.document.findUnique({ where: { id: refusedEvidence } })).toBeNull();
    // Editing the existing file's clearance retains exactly its retired references.
    await permissions.configureEvidenceDocument({
      ...(await currentContext()),
      documentId: pending,
      categoryId: "memo",
      scopes: [{ enterpriseKey: "enterprise", ownership: "group", dimensions: {} }],
      fileConfidentialityLevel: 3
    });
    const reason = "Correct an explicitly requested historical business day";
    const correctionJob = await reserve(reason);
    const correction = candidate(nextId());
    await publish(correctionJob, correction);
    expect(
      await prisma.structuredPartition.findUniqueOrThrow({ where: { id: original.id } })
    ).toMatchObject({ objectKey: correction.objectKey, checksumSha256: correction.checksumSha256 });
    const audit = await prisma.auditLog.findFirstOrThrow({
      where: {
        orgId: publicationOrg,
        targetId: resource.id,
        action: "resource.historical_supplement.authorized"
      }
    });
    expect(audit).toMatchObject({
      actorEmployeeId: admin,
      clientSource: "admin",
      result: "succeeded"
    });
    expect(audit.metadata).toMatchObject({
      historicalSupplement: { actorEmployeeId: admin, reason },
      businessDates: [date],
      retired: expect.arrayContaining([
        { kind: "category", identity: ["business"] },
        { kind: "store", identity: ["enterprise", storeName] }
      ])
    });
    expect(
      await prisma.businessCategory.findUniqueOrThrow({
        where: { orgId_id: { orgId: publicationOrg, id: "business" } }
      })
    ).toMatchObject({ retired: true, name: "business" });
    expect(
      await prisma.businessStore.findUniqueOrThrow({
        where: {
          orgId_enterpriseKey_name: {
            orgId: publicationOrg,
            enterpriseKey: "enterprise",
            name: storeName
          }
        }
      })
    ).toMatchObject({ retired: true, name: storeName });
    const revokedJob = await reserve(reason);
    await prisma.employee.update({ where: { id: admin }, data: { role: "employee" } });
    const beforeRevoked = (await permissions.loadAuthorizationSnapshot(admin, publicationOrg))
      .authorizationVersion;
    await expect(publish(revokedJob, candidate(nextId()))).rejects.toThrow(
      "AUTHORIZATION_ADMIN_REQUIRED"
    );
    expect(
      (await permissions.loadAuthorizationSnapshot(admin, publicationOrg)).authorizationVersion
    ).toBe(beforeRevoked);
    expect(
      await prisma.structuredPartition.findUniqueOrThrow({ where: { id: original.id } })
    ).toMatchObject({ objectKey: correction.objectKey });
    await prisma.employee.update({ where: { id: admin }, data: { role: "admin" } });
  }, 15_000);
  async function uploadHistoricalEvidence(reason: string) {
    const id = nextId();
    const catalog = createPrismaDocumentCatalogRepository(url);
    try {
      await catalog.createUploadedDocument({
        id,
        orgId: publicationOrg,
        uploaderId: admin,
        title: "Historical memo",
        documentType: "structured_dataset",
        documentKind: "evidence",
        fileType: "md",
        status: "pending_processing",
        storageObjectKey: `synthetic/${id}`,
        originalFileName: "memo.md",
        contentType: "text/markdown",
        byteSize: 10,
        checksumSha256: "a".repeat(64),
        sourceSystem: null,
        sourceTime: null,
        confidentialityLevel: 2,
        processingJobType: "evidence_document_index",
        businessCategoryId: "memo",
        businessScopes: [{ enterpriseKey: "enterprise", ownership: "group", dimensions: {} }],
        historicalSupplementReason: reason,
        audit: {
          requestId: id,
          sourceIp: "127.0.0.1",
          clientSource: "http_api",
          launcherVersion: null
        }
      });
    } finally {
      await catalog.disconnect?.();
    }
    return id;
  }
  it("preserves original historical approval across a same-reference clearance PATCH and still rechecks that admin", async () => {
    await prisma.businessCategory.update({
      where: { orgId_id: { orgId: publicationOrg, id: "memo" } },
      data: { retired: true }
    });
    const permissions = createBusinessAuthorizationRepository({ prisma });
    const reason = "Approved historical memo correction";
    const documentId = await uploadHistoricalEvidence(reason);
    const editor = nextId();
    await prisma.employee.create({
      data: {
        id: editor,
        orgId: publicationOrg,
        email: `${editor}@example.invalid`,
        displayName: "Permission editor",
        role: "admin",
        clearance: 0
      }
    });
    const context = async () => ({
      orgId: publicationOrg,
      actorId: editor,
      expectedVersion: (await permissions.loadAuthorizationSnapshot(editor, publicationOrg))
        .authorizationVersion
    });
    const patch = {
      documentId,
      categoryId: "memo",
      fileConfidentialityLevel: 3,
      scopes: [{ enterpriseKey: "enterprise", ownership: "group" as const, dimensions: {} }]
    };
    await permissions.configureEvidenceDocument({ ...(await context()), ...patch });
    const intent = { actorEmployeeId: admin, reason };
    expect(
      (await prisma.document.findUniqueOrThrow({ where: { id: documentId } })).sourceMetadata
    ).toMatchObject({ historicalSupplement: intent });
    const beforeChanged = await permissions.loadAuthorizationSnapshot(editor, publicationOrg);
    await expect(
      permissions.configureEvidenceDocument({
        ...(await context()),
        ...patch,
        scopes: [{ enterpriseKey: "different-enterprise", ownership: "group", dimensions: {} }]
      })
    ).rejects.toThrow("RESOURCE_DIRECTORY_RETIRED");
    expect(
      (await permissions.loadAuthorizationSnapshot(editor, publicationOrg)).authorizationVersion
    ).toBe(beforeChanged.authorizationVersion);
    expect(
      (await prisma.document.findUniqueOrThrow({ where: { id: documentId } })).sourceMetadata
    ).toMatchObject({ historicalSupplement: intent });
    await prisma.employee.update({ where: { id: admin }, data: { role: "employee" } });
    const beforeDenied = await prisma.businessAuthorizationState.findUniqueOrThrow({
      where: { orgId: publicationOrg }
    });
    const auditCount = await prisma.auditLog.count({ where: { orgId: publicationOrg } });
    await expect(
      prisma.$transaction(async (tx) => {
        await activateEvidenceReadRequirement(tx, publicationOrg, documentId);
        await tx.document.update({ where: { id: documentId }, data: { status: "active" } });
      })
    ).rejects.toThrow("AUTHORIZATION_ADMIN_REQUIRED");
    expect(
      (
        await prisma.businessAuthorizationState.findUniqueOrThrow({
          where: { orgId: publicationOrg }
        })
      ).version
    ).toBe(beforeDenied.version);
    expect(await prisma.auditLog.count({ where: { orgId: publicationOrg } })).toBe(auditCount);
    await prisma.employee.update({ where: { id: admin }, data: { role: "admin" } });
    await prisma.$transaction(async (tx) => {
      await activateEvidenceReadRequirement(tx, publicationOrg, documentId);
      await tx.document.update({ where: { id: documentId }, data: { status: "active" } });
    });
    expect(
      await prisma.businessResource.findUniqueOrThrow({
        where: {
          orgId_kind_resourceKey: {
            orgId: publicationOrg,
            kind: "evidence",
            resourceKey: documentId
          }
        }
      })
    ).toMatchObject({ valid: true, fileConfidentialityLevel: 3 });
    expect(
      (await prisma.document.findUniqueOrThrow({ where: { id: documentId } })).sourceMetadata
    ).toMatchObject({ historicalSupplement: intent });
    const audit = await prisma.auditLog.findFirstOrThrow({
      where: {
        orgId: publicationOrg,
        action: "resource.historical_supplement.authorized",
        targetId: (
          await prisma.businessResource.findUniqueOrThrow({
            where: {
              orgId_kind_resourceKey: {
                orgId: publicationOrg,
                kind: "evidence",
                resourceKey: documentId
              }
            }
          })
        ).id
      },
      orderBy: { createdAt: "desc" }
    });
    expect(audit).toMatchObject({
      actorEmployeeId: admin,
      metadata: expect.objectContaining({ historicalSupplement: intent })
    });
    await permissions.configureEvidenceDocument({
      ...(await context()),
      ...patch,
      historicalSupplementReason: "New explicit approval by the permission editor"
    });
    expect(
      (await prisma.document.findUniqueOrThrow({ where: { id: documentId } })).sourceMetadata
    ).toMatchObject({
      historicalSupplement: {
        actorEmployeeId: editor,
        reason: "New explicit approval by the permission editor"
      }
    });
  });
  it("rejects suspended historical publication and activation without changing data, resources, version or audits", async () => {
    await prisma.businessCategory.update({
      where: { orgId_id: { orgId: publicationOrg, id: "memo" } },
      data: { retired: true }
    });
    const pending = await uploadHistoricalEvidence("Approved before suspension");
    await prisma.businessAuthorizationState.update({
      where: { orgId: publicationOrg },
      data: { mode: "suspended" }
    });
    const before = await prisma.businessAuthorizationState.findUniqueOrThrow({
      where: { orgId: publicationOrg }
    });
    const resources = await prisma.businessResource.findMany({
      where: { orgId: publicationOrg },
      orderBy: { id: "asc" }
    });
    const partitions = await prisma.structuredPartition.findMany({
      where: { orgId: publicationOrg }
    });
    const audits = await prisma.auditLog.count({ where: { orgId: publicationOrg } });
    const sourceDocumentId = nextId();
    try {
      await expect(
        prisma.$transaction(async (tx) => {
          await tx.document.create({
            data: {
              ...documentData(sourceDocumentId),
              sourceMetadata: {
                enterpriseKey: "enterprise",
                startDate: "20260819",
                endDate: "20260819",
                historicalSupplement: { actorEmployeeId: admin, reason: "Approved historical data" }
              }
            }
          });
          await persistStructuredSourceReadRequirements(tx, {
            orgId: publicationOrg,
            sourceDocumentId,
            dataset: "business",
            rows: [
              { payload: { store_name: "Historical exact store", business_date: "2026-08-19" } }
            ],
            workerId: "internal-worker"
          });
          await tx.document.update({ where: { id: sourceDocumentId }, data: { status: "active" } });
        })
      ).rejects.toThrow("AUTHORIZATION_SUSPENDED");
      expect(await prisma.document.findUnique({ where: { id: sourceDocumentId } })).toBeNull();
      await expect(
        prisma.$transaction(async (tx) => {
          await activateEvidenceReadRequirement(tx, publicationOrg, pending);
          await tx.document.update({ where: { id: pending }, data: { status: "active" } });
        })
      ).rejects.toThrow("AUTHORIZATION_SUSPENDED");
      expect(await prisma.document.findUniqueOrThrow({ where: { id: pending } })).toMatchObject({
        status: "pending_processing"
      });
      expect(
        await prisma.businessResource.findMany({
          where: { orgId: publicationOrg },
          orderBy: { id: "asc" }
        })
      ).toEqual(resources);
      expect(
        await prisma.structuredPartition.findMany({ where: { orgId: publicationOrg } })
      ).toEqual(partitions);
      expect(
        (
          await prisma.businessAuthorizationState.findUniqueOrThrow({
            where: { orgId: publicationOrg }
          })
        ).version
      ).toBe(before.version);
      expect(await prisma.auditLog.count({ where: { orgId: publicationOrg } })).toBe(audits);
    } finally {
      await prisma.businessAuthorizationState.update({
        where: { orgId: publicationOrg },
        data: { mode: "enabled" }
      });
    }
  });
});
