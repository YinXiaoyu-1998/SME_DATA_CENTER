import type { PrismaClient } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";
import { createBusinessAuthorizationRepository } from "./business-authorization.js";

describe("transaction-local account permission listing", () => {
  it("batches shared configuration and grants without mixing accounts or trusting an inactive admin", async () => {
    const accounts = Array.from({ length: 20 }, (_, i) => ({
      id: `account-${i}`,
      displayName: `Account ${i}`,
      email: `${i}@example.invalid`,
      role: i === 0 ? "admin" : "employee",
      disabled: false,
      clearance: i % 4
    }));
    const tx = {
      employee: { findMany: vi.fn(async () => accounts) },
      businessAuthorizationState: {
        findUnique: vi.fn(async () => ({ mode: "enabled", version: 7n }))
      },
      businessCategory: {
        findMany: vi.fn(async () => [
          {
            id: "memo",
            key: null,
            kind: "evidence",
            confidentialityLevel: null,
            allowGroup: true,
            allowStore: false,
            dimensions: []
          }
        ])
      },
      businessGrant: {
        findMany: vi.fn(async () => [
          {
            id: "only-one-account",
            orgId: "org",
            employeeId: "account-1",
            enterpriseKey: "enterprise",
            ownership: "group",
            categories: [{ categoryId: "memo" }],
            stores: [],
            dimensions: []
          }
        ])
      }
    };
    const prisma = {
      $transaction: vi.fn(async (operation: (client: typeof tx) => unknown) => operation(tx))
    };
    const repository = createBusinessAuthorizationRepository({
      prisma: prisma as unknown as PrismaClient
    });
    const result = await repository.listAccounts("org", "account-0");
    expect(result).toHaveLength(20);
    expect(result[0]).toMatchObject({
      employeeId: "account-0",
      clearance: 0,
      authorizationVersion: "7",
      grants: []
    });
    expect(result[1]?.grants.map((grant) => grant.id)).toEqual(["only-one-account"]);
    expect(result.slice(2).every((account) => account.grants.length === 0)).toBe(true);
    expect(tx.employee.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { orgId: "org" } })
    );
    for (const read of [
      tx.employee.findMany,
      tx.businessAuthorizationState.findUnique,
      tx.businessCategory.findMany,
      tx.businessGrant.findMany
    ])
      expect(read).toHaveBeenCalledTimes(1);
    expect(tx.businessGrant.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { orgId: "org" } })
    );
    accounts[0]!.disabled = true;
    await expect(repository.listAccounts("org", "account-0")).rejects.toThrow(
      "AUTHORIZATION_ADMIN_REQUIRED"
    );
    accounts[0]!.disabled = false;
    accounts[0]!.role = "employee";
    await expect(repository.listAccounts("org", "account-0")).rejects.toThrow(
      "AUTHORIZATION_ADMIN_REQUIRED"
    );
    await expect(repository.listAccounts("org", "foreign-admin")).rejects.toThrow(
      "AUTHORIZATION_ADMIN_REQUIRED"
    );
    expect(tx.businessGrant.findMany).toHaveBeenCalledTimes(1);
  });
});

describe("operator permission attribution", () => {
  const operatorAudit = {
    operatorId: "developer",
    requestReference: "request-1",
    reason: "Admin requested change"
  };
  function fixture(conflict = false) {
    const actor = { id: "admin", orgId: "org", role: "admin", disabled: false };
    const businessAudit = { create: vi.fn(async () => ({ id: "change-audit" })) };
    const operatorLog = { create: vi.fn(async () => ({})) };
    const tx = {
      $queryRaw: vi.fn(async () => []),
      employee: { findUnique: vi.fn(async () => actor) },
      businessAuthorizationState: {
        updateMany: vi.fn(async () => ({ count: conflict ? 0 : 1 })),
        findUnique: vi.fn(async () => ({ version: 7n }))
      },
      businessStore: {
        findUnique: vi.fn(async () => null),
        upsert: vi.fn(async () => ({ name: "A ", retired: true }))
      },
      businessEnterpriseIdentity: {
        findUnique: vi.fn(async () => ({
          orgId: "org",
          enterpriseKey: "enterprise",
          enterpriseName: "Enterprise"
        }))
      },
      businessAuthorizationAudit: businessAudit,
      auditLog: operatorLog
    };
    const prisma = {
      ...tx,
      $transaction: vi.fn(async (operation: (client: typeof tx) => unknown) => operation(tx))
    };
    const repository = createBusinessAuthorizationRepository({
      prisma: prisma as unknown as PrismaClient,
      operatorAudit
    });
    return { repository, businessAudit, operatorLog, tx };
  }
  it("records the requesting admin and actual operator in correlated audits", async () => {
    const { repository, businessAudit, operatorLog } = fixture();
    await repository.putStore({
      orgId: "org",
      actorId: "admin",
      expectedVersion: "7",
      enterpriseKey: "enterprise",
      name: "A ",
      retired: true
    });
    expect(businessAudit.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          actorId: "admin",
          action: "operator.store.configure",
          outcome: "succeeded",
          version: 8n
        })
      })
    );
    expect(operatorLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        actorEmployeeId: null,
        clientSource: "operator_cli",
        targetId: "change-audit",
        metadata: expect.objectContaining({
          operator: operatorAudit,
          requestedByAdminId: "admin",
          targetId: "A "
        })
      })
    });
  });
  it("records rejected writes without changing the store or exposing attempted attributes", async () => {
    const { repository, operatorLog, tx } = fixture(true);
    await expect(
      repository.putStore({
        orgId: "org",
        actorId: "admin",
        expectedVersion: "6",
        enterpriseKey: "enterprise",
        name: "A ",
        retired: true
      })
    ).rejects.toThrow("AUTHORIZATION_VERSION_CONFLICT");
    expect(tx.businessStore.upsert).not.toHaveBeenCalled();
    expect(operatorLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        result: "denied",
        metadata: expect.objectContaining({ operator: operatorAudit, requestedByAdminId: "admin" })
      })
    });
  });
});
