import { randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { createDatabaseAdapter } from "@smedc/db";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import {
  parsePermissionsOperatorArgs,
  planPermissionChange,
  runPermissionsOperator,
  type PermissionOperation
} from "./cli.js";
import { openPermissionsOperatorRuntime } from "./runtime.js";

const run = process.env["RUN_PERMISSIONS_OPERATOR_PRISMA_INTEGRATION"] === "1";
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
      "Permissions operator tests require a runner-owned loopback integration database"
    );
}
const suite = run ? describe : describe.skip;
suite("internal permissions operator with Prisma", () => {
  const prisma = new PrismaClient({ adapter: createDatabaseAdapter(url) });
  let orgId: string;
  let adminId: string;
  let employeeId: string;
  let documentId: string;
  let foreignOrgId: string;
  let foreignAdminId: string;
  let version: string;
  const scopeArgs = () => ["--org-id", orgId, "--requested-by-admin-id", adminId];
  const applyArgs = (
    operation: PermissionOperation,
    execute: boolean,
    expectedVersion = version
  ) => [
    "apply",
    ...scopeArgs(),
    "--operator-id",
    "synthetic-developer",
    "--request-reference",
    "synthetic-admin-request",
    "--reason",
    "Synthetic administrator requested configuration",
    "--expected-version",
    expectedVersion,
    "--operation",
    operation,
    "--input",
    "-",
    ...(execute ? ["--execute"] : [])
  ];
  async function invoke(args: string[], payload: unknown = {}) {
    let output = "";
    await runPermissionsOperator(parsePermissionsOperatorArgs(args), {
      open: (command) => openPermissionsOperatorRuntime(command, url),
      readInput: async () => payload,
      stdout: (line) => {
        output = line;
      }
    });
    return JSON.parse(output) as Record<string, unknown>;
  }
  async function save(operation: PermissionOperation, payload: unknown) {
    const output = await invoke(applyArgs(operation, true), payload);
    version = output["authorizationVersion"] as string;
    return output;
  }
  beforeEach(async () => {
    const suffix = randomUUID().replaceAll("-", "").slice(0, 12);
    orgId = `operator_${suffix}`;
    adminId = `${suffix}_admin`;
    employeeId = `${suffix}_employee`;
    documentId = `${suffix}_document`;
    foreignOrgId = `foreign_${suffix}`;
    foreignAdminId = `${suffix}_foreign_admin`;
    version = "0";
    await prisma.organization.createMany({
      data: [
        { id: orgId, name: "Synthetic operator tenant" },
        { id: foreignOrgId, name: "Synthetic foreign tenant" }
      ]
    });
    await prisma.employee.createMany({
      data: [
        {
          id: adminId,
          orgId,
          email: `${adminId}@example.invalid`,
          displayName: "Requesting admin",
          role: "admin",
          clearance: 3
        },
        {
          id: employeeId,
          orgId,
          email: `${employeeId}@example.invalid`,
          displayName: "Target employee",
          role: "employee",
          clearance: 0
        },
        {
          id: foreignAdminId,
          orgId: foreignOrgId,
          email: `${foreignAdminId}@example.invalid`,
          displayName: "Other tenant admin",
          role: "admin",
          clearance: 3
        }
      ]
    });
    await prisma.businessAuthorizationState.create({ data: { orgId } });
    await prisma.document.create({
      data: {
        id: documentId,
        orgId,
        uploaderId: adminId,
        title: "Synthetic evidence",
        documentType: "management_knowledge",
        documentKind: "evidence",
        status: "active",
        storageObjectKey: "synthetic/operator.md"
      }
    });
  });
  afterAll(() => prisma.$disconnect());

  it("previews without writes, then configures exact scopes and records both audit identities atomically", async () => {
    const preview = await invoke(applyArgs("enterprise.declare", false), {
      name: "Synthetic enterprise"
    });
    expect(preview).toMatchObject({ dryRun: true, current: { authorizationVersion: "0" } });
    expect(await prisma.businessEnterpriseIdentity.count({ where: { orgId } })).toBe(0);
    expect(await prisma.businessAuthorizationAudit.count({ where: { orgId } })).toBe(0);
    await save("enterprise.declare", { name: "Synthetic enterprise" });
    const enterprise = await prisma.businessEnterpriseIdentity.findFirstOrThrow({
      where: { orgId }
    });
    await save("dimension.create", { id: "project", name: "Project" });
    await save("value.create", { dimensionId: "project", id: "x", name: "Project X" });
    await save("category.create", {
      id: "memo",
      name: "Memo",
      ownerships: ["store"],
      requiredDimensionIds: ["project"]
    });
    await save("store.set", { enterpriseKey: enterprise.enterpriseKey, name: "A " });
    const grants = [
      {
        id: "grant",
        orgId,
        enterpriseKey: enterprise.enterpriseKey,
        categoryIds: ["memo"],
        ownership: "store",
        stores: { kind: "fixed", values: ["A "] },
        dimensions: { project: { kind: "fixed", values: ["x"] } }
      }
    ];
    await save("account.set", { employeeId, clearance: 2, grants });
    const scopes = [
      {
        enterpriseKey: enterprise.enterpriseKey,
        ownership: "store",
        storeName: "A ",
        dimensions: { project: "x" }
      }
    ];
    await save("document.set", {
      documentId,
      categoryId: "memo",
      fileConfidentialityLevel: 2,
      scopes
    });
    const snapshot = await invoke(["inspect", ...scopeArgs()]);
    expect(snapshot).toMatchObject({
      authorizationVersion: "7",
      mode: "legacy",
      stores: [{ name: "A " }],
      accounts: expect.arrayContaining([expect.objectContaining({ id: employeeId, clearance: 2 })]),
      documents: {
        documents: [expect.objectContaining({ id: documentId, categoryId: "memo", scopes })]
      }
    });
    expect(await prisma.businessGrant.count({ where: { orgId, employeeId } })).toBe(1);
    expect(
      (await prisma.document.findUniqueOrThrow({ where: { id: documentId } })).storageObjectKey
    ).toBe("synthetic/operator.md");
    const audits = await prisma.businessAuthorizationAudit.findMany({
      where: { orgId, outcome: "succeeded" },
      orderBy: { version: "asc" }
    });
    expect(audits).toHaveLength(7);
    expect(
      audits.every((row) => row.actorId === adminId && row.action.startsWith("operator."))
    ).toBe(true);
    const logs = await prisma.auditLog.findMany({
      where: { orgId, action: "permissions.operator.change" }
    });
    expect(logs).toHaveLength(7);
    expect(
      logs.every((row) => row.actorEmployeeId === null && row.clientSource === "operator_cli")
    ).toBe(true);
    expect(new Set(logs.map((row) => row.targetId))).toEqual(new Set(audits.map((row) => row.id)));
    expect(logs[0]!.metadata).toMatchObject({
      requestedByAdminId: adminId,
      operator: { operatorId: "synthetic-developer", requestReference: "synthetic-admin-request" }
    });
  });

  it("rejects foreign targets, foreign or disabled requesting admins and invalid policy references", async () => {
    await expect(
      invoke(["inspect", "--org-id", foreignOrgId, "--requested-by-admin-id", adminId])
    ).rejects.toThrow("AUTHORIZATION_ADMIN_REQUIRED");
    await expect(
      invoke(applyArgs("account.set", true), {
        employeeId: foreignAdminId,
        clearance: 1,
        grants: []
      })
    ).rejects.toThrow("AUTHORIZATION_ACCOUNT_NOT_FOUND");
    await expect(
      save("category.create", {
        id: "invalid",
        name: "Invalid",
        ownerships: ["store"],
        requiredDimensionIds: ["missing"]
      })
    ).rejects.toThrow("INVALID_PERMISSION_REFERENCE");
    await prisma.employee.update({ where: { id: adminId }, data: { disabled: true } });
    await expect(invoke(["inspect", ...scopeArgs()])).rejects.toThrow(
      "AUTHORIZATION_ADMIN_REQUIRED"
    );
    expect(
      (await prisma.businessAuthorizationState.findUniqueOrThrow({ where: { orgId } })).version
    ).toBe(0n);
    expect(
      (await prisma.employee.findUniqueOrThrow({ where: { id: foreignAdminId } })).clearance
    ).toBe(3);
  });

  it("rechecks version and admin status inside the write path after the preview", async () => {
    const command = parsePermissionsOperatorArgs(applyArgs("store.set", true));
    if (command.kind !== "apply") throw new Error("Invalid fixture");
    const runtime = await openPermissionsOperatorRuntime(command, url);
    const change = planPermissionChange(
      "store.set",
      { enterpriseKey: "enterprise", name: "A" },
      "0"
    );
    try {
      await runtime.inspect("stores");
      await prisma.businessAuthorizationState.update({ where: { orgId }, data: { version: 1n } });
      await expect(runtime.apply(change)).rejects.toThrow("AUTHORIZATION_VERSION_CONFLICT");
      await prisma.employee.update({ where: { id: adminId }, data: { role: "employee" } });
      await expect(
        runtime.apply({ ...change, body: { ...change.body, expectedVersion: "1" } })
      ).rejects.toThrow("AUTHORIZATION_ADMIN_REQUIRED");
      expect(await prisma.businessStore.count({ where: { orgId } })).toBe(0);
      expect(
        (await prisma.businessAuthorizationState.findUniqueOrThrow({ where: { orgId } })).version
      ).toBe(1n);
      expect(
        await prisma.businessAuthorizationAudit.count({ where: { orgId, outcome: "succeeded" } })
      ).toBe(0);
    } finally {
      await runtime.close();
    }
  });

  it("rolls back the permission change and version when operator audit persistence fails", async () => {
    // Scoped to this disposable database; proves both successful audit rows are in the write transaction.
    await prisma.$executeRawUnsafe(
      "CREATE TRIGGER reject_operator_audit BEFORE INSERT ON audit_logs FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'synthetic audit failure'"
    );
    try {
      await expect(save("store.set", { enterpriseKey: "enterprise", name: "A" })).rejects.toThrow();
      expect(await prisma.businessStore.count({ where: { orgId } })).toBe(0);
      expect(
        (await prisma.businessAuthorizationState.findUniqueOrThrow({ where: { orgId } })).version
      ).toBe(0n);
      expect(
        await prisma.businessAuthorizationAudit.count({ where: { orgId, outcome: "succeeded" } })
      ).toBe(0);
    } finally {
      await prisma.$executeRawUnsafe("DROP TRIGGER reject_operator_audit");
    }
  });
});
