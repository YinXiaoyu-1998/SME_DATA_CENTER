import Fastify from "fastify";
import { describe, expect, it, vi } from "vitest";
import type { AuthorizationSnapshot } from "@smedc/domain";
import type { RequestAuth } from "../request-auth.js";
import { registerBusinessAuthorizationRoutes } from "./business-authorization.js";
import {
  createBusinessAuthorizationService,
  type BusinessAuthorizationRepository
} from "../business-authorization.js";

function fixture(role: "admin" | "employee" = "admin") {
  const snapshot: AuthorizationSnapshot = {
    orgId: "org",
    employeeId: "actor",
    role,
    disabled: false,
    clearance: 0,
    mode: "enabled",
    authorizationVersion: "7",
    categories: [],
    grants: []
  };
  const repository = {
    loadPermissionCard: vi.fn(async () => ({
      ...snapshot,
      storeReviewEnterprises: { complete: true, write: [], read: [] }
    })),
    initializeFixedCategories: vi.fn(async () => ({
      authorizationVersion: "8",
      value: { createdCount: 1 }
    })),
    loadAuthorizationSnapshot: vi.fn(async (id: string, orgId: string) => {
      if (id === "foreign") throw new Error("AUTHORIZATION_ACCOUNT_NOT_FOUND");
      return { ...snapshot, employeeId: id, orgId };
    }),
    listAccounts: vi.fn(async () => [{ employeeId: "other", clearance: 3, grants: [] }]),
    configureAccount: vi.fn(async (input: unknown) => ({
      authorizationVersion: "8",
      value: input
    })),
    listCategories: vi.fn(
      async (): Promise<
        {
          id: string;
          kind: string;
          key: string;
          allowStore: boolean;
          dimensions: { dimensionId: string }[];
        }[]
      > => []
    ),
    configureCategory: vi.fn(async () => ({ authorizationVersion: "8" })),
    defineDimension: vi.fn(async () => ({ authorizationVersion: "8" })),
    defineDimensionValue: vi.fn(async () => ({ authorizationVersion: "8" })),
    configureEvidenceDocument: vi.fn(async () => ({
      authorizationVersion: "8",
      value: { authorizationVersion: 1n }
    })),
    inspectAuthorizationCutover: vi.fn(async () => ({
      authorizationVersion: "7",
      mode: "legacy",
      inspection: { ready: true, missing: [], accountsWithoutGrants: [] }
    })),
    activateAuthorizationCutover: vi.fn(async () => ({
      authorizationVersion: "8",
      value: { mode: "enabled" }
    })),
    suspendAuthorizationReads: vi.fn(async () => ({
      authorizationVersion: "8",
      value: { mode: "suspended" }
    })),
    listStores: vi.fn(async () => [
      { enterpriseKey: "enterprise", name: "Store A ", retired: false }
    ]),
    putStore: vi.fn(async () => ({ authorizationVersion: "8" })),
    listDimensions: vi.fn(async () => [])
  };
  const app = Fastify();
  registerBusinessAuthorizationRoutes(app, {
    auth: {
      authenticate: async () => true,
      employee: () => ({ id: "actor", orgId: "org", role: "admin", disabled: false })
    } as unknown as RequestAuth,
    permissions: () =>
      createBusinessAuthorizationService(repository as unknown as BusinessAuthorizationRepository)
  });
  return { app, snapshot, repository };
}

describe("business permission administration", () => {
  it("initializes missing fixed categories only through a current admin versioned write", async () => {
    const { app, repository, snapshot } = fixture();
    try {
      await app.inject({ url: "/v1/admin/permissions/categories" });
      expect(repository.initializeFixedCategories).not.toHaveBeenCalled();
      expect(
        (
          await app.inject({
            method: "POST",
            url: "/v1/admin/permissions/categories/initialize",
            payload: { expectedVersion: "7", orgId: "foreign" }
          })
        ).statusCode
      ).toBe(400);
      const response = await app.inject({
        method: "POST",
        url: "/v1/admin/permissions/categories/initialize",
        payload: { expectedVersion: "7" }
      });
      expect(response.statusCode).toBe(200);
      expect(repository.initializeFixedCategories).toHaveBeenCalledExactlyOnceWith({
        orgId: "org",
        actorId: "actor",
        expectedVersion: "7"
      });
      snapshot.role = "employee";
      expect(
        (
          await app.inject({
            method: "POST",
            url: "/v1/admin/permissions/categories/initialize",
            payload: { expectedVersion: "8" }
          })
        ).statusCode
      ).toBe(403);
      expect(repository.initializeFixedCategories).toHaveBeenCalledTimes(1);
    } finally {
      await app.close();
    }
  });
  it("requires a current admin and explicit versioned tenant confirmation for activation and safe suspension", async () => {
    const { app, repository, snapshot } = fixture();
    try {
      expect((await app.inject({ url: "/v1/admin/permissions/cutover" })).json()).toMatchObject({
        ready: true,
        authorizationVersion: "7"
      });
      for (const operation of ["activate", "suspend"]) {
        expect(
          (
            await app.inject({
              method: "POST",
              url: `/v1/admin/permissions/cutover/${operation}`,
              payload: { expectedVersion: "7" }
            })
          ).statusCode
        ).toBe(400);
        expect(
          (
            await app.inject({
              method: "POST",
              url: `/v1/admin/permissions/cutover/${operation}`,
              payload: { expectedVersion: "7", confirm: true, orgId: "foreign" }
            })
          ).statusCode
        ).toBe(400);
        expect(
          (
            await app.inject({
              method: "POST",
              url: `/v1/admin/permissions/cutover/${operation}`,
              payload: { expectedVersion: "7", confirm: true }
            })
          ).statusCode
        ).toBe(200);
      }
      expect(repository.activateAuthorizationCutover).toHaveBeenCalledWith(
        { orgId: "org", actorId: "actor", expectedVersion: "7", confirm: true },
        expect.any(Function)
      );
      snapshot.role = "employee";
      expect((await app.inject({ url: "/v1/admin/permissions/cutover" })).statusCode).toBe(403);
      expect(
        (
          await app.inject({
            method: "POST",
            url: "/v1/admin/permissions/cutover/activate",
            payload: { expectedVersion: "7", confirm: true }
          })
        ).statusCode
      ).toBe(403);
    } finally {
      await app.close();
    }
  });
  it("preserves exact persisted store names in admin directory and controlled versioned maintenance", async () => {
    const { app, repository } = fixture();
    try {
      expect(
        (await app.inject({ url: "/v1/admin/permissions/stores" })).json().stores[0].name
      ).toBe("Store A ");
      expect(
        (
          await app.inject({
            method: "POST",
            url: "/v1/admin/permissions/stores",
            payload: {
              expectedVersion: "7",
              enterpriseKey: "enterprise",
              name: "Store A ",
              retired: true
            }
          })
        ).statusCode
      ).toBe(200);
      expect(repository.putStore).toHaveBeenCalledWith({
        orgId: "org",
        actorId: "actor",
        expectedVersion: "7",
        enterpriseKey: "enterprise",
        name: "Store A ",
        retired: true
      });
    } finally {
      await app.close();
    }
  });
  it("accepts an explicit enterprise name in the ordinary store save and reports identity errors", async () => {
    const { app, repository } = fixture();
    try {
      const payload = { expectedVersion: "7", enterpriseName: "Fresh Cafe", name: "First store" };
      expect(
        (await app.inject({ method: "POST", url: "/v1/admin/permissions/stores", payload }))
          .statusCode
      ).toBe(200);
      expect(repository.putStore).toHaveBeenCalledWith({
        orgId: "org",
        actorId: "actor",
        ...payload
      });
      for (const code of ["ENTERPRISE_NAME_REQUIRED", "ENTERPRISE_NAME_CONFLICT"]) {
        repository.putStore.mockRejectedValueOnce(new Error(code));
        const response = await app.inject({
          method: "POST",
          url: "/v1/admin/permissions/stores",
          payload
        });
        expect(response.statusCode).toBe(400);
        expect(response.json().error.code).toBe(code);
      }
    } finally {
      await app.close();
    }
  });
  it("allows an admin without content grants to inspect and update another account and self", async () => {
    const { app, repository } = fixture();
    try {
      expect((await app.inject({ url: "/v1/admin/permissions/accounts" })).statusCode).toBe(200);
      for (const id of ["actor", "other"]) {
        const read = await app.inject({ url: `/v1/admin/permissions/accounts/${id}` });
        expect(read.statusCode).toBe(200);
        expect(read.json().employeeId).toBe(id);
        const update = await app.inject({
          method: "PATCH",
          url: `/v1/admin/permissions/accounts/${id}`,
          payload: { expectedVersion: "7", clearance: 2, grants: [] }
        });
        expect(update.statusCode).toBe(200);
      }
      expect(repository.configureAccount).toHaveBeenCalledTimes(2);
      expect(repository.configureAccount).toHaveBeenLastCalledWith({
        orgId: "org",
        actorId: "actor",
        employeeId: "other",
        expectedVersion: "7",
        clearance: 2,
        grants: []
      });
    } finally {
      await app.close();
    }
  });
  it("uses the current role and disabled state, permits only an employee's own profile", async () => {
    const { app, snapshot, repository } = fixture("employee");
    try {
      expect((await app.inject({ url: "/v1/permissions/me" })).statusCode).toBe(200);
      expect((await app.inject({ url: "/v1/admin/permissions/accounts/other" })).statusCode).toBe(
        403
      );
      expect(repository.listAccounts).not.toHaveBeenCalled();
      snapshot.disabled = true;
      expect((await app.inject({ url: "/v1/permissions/me" })).statusCode).toBe(403);
    } finally {
      await app.close();
    }
  });
  it("rejects cross-organization accounts and reports stale writes without data", async () => {
    const { app, repository } = fixture();
    repository.configureAccount.mockRejectedValueOnce(new Error("AUTHORIZATION_VERSION_CONFLICT"));
    try {
      expect((await app.inject({ url: "/v1/admin/permissions/accounts/foreign" })).statusCode).toBe(
        404
      );
      const result = await app.inject({
        method: "PATCH",
        url: "/v1/admin/permissions/accounts/other",
        payload: { expectedVersion: "6", clearance: 2, grants: [] }
      });
      expect(result.statusCode).toBe(409);
      expect(result.json().error.code).toBe("AUTHORIZATION_VERSION_CONFLICT");
      expect(result.body).not.toMatch(/download|正文|content|token/);
    } finally {
      await app.close();
    }
  });
  it("validates malformed writes before repository mutation", async () => {
    const { app, repository } = fixture();
    try {
      const result = await app.inject({
        method: "PATCH",
        url: "/v1/admin/permissions/accounts/other",
        payload: { expectedVersion: "7", clearance: 4, grants: [] }
      });
      expect(result.statusCode).toBe(400);
      expect(repository.configureAccount).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });
  it("keeps fixed category structure developer-owned and creates evidence-only categories", async () => {
    const { app, repository } = fixture();
    repository.listCategories.mockResolvedValue([
      { id: "sales", key: "business", kind: "fixed", allowStore: true, dimensions: [] }
    ]);
    try {
      expect(
        (
          await app.inject({
            method: "PATCH",
            url: "/v1/admin/permissions/categories/sales",
            payload: { expectedVersion: "7", name: "Sales", confidentialityLevel: 2 }
          })
        ).statusCode
      ).toBe(200);
      expect(repository.configureCategory).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({
          kind: "fixed",
          key: "business",
          confidentialityLevel: 2,
          ownerships: ["store"]
        })
      );
      expect(
        (
          await app.inject({
            method: "PATCH",
            url: "/v1/admin/permissions/categories/sales",
            payload: {
              expectedVersion: "7",
              name: "Sales",
              confidentialityLevel: 2,
              ownerships: ["group"]
            }
          })
        ).statusCode
      ).toBe(400);
      expect(
        (
          await app.inject({
            method: "POST",
            url: "/v1/admin/permissions/categories",
            payload: {
              expectedVersion: "7",
              id: "memo",
              name: "Memo",
              ownerships: ["group"],
              requiredDimensionIds: []
            }
          })
        ).statusCode
      ).toBe(200);
      expect(repository.configureCategory).toHaveBeenLastCalledWith(
        expect.objectContaining({ kind: "evidence", createOnly: true, confidentialityLevel: null })
      );
      expect(
        (
          await app.inject({
            method: "PATCH",
            url: "/v1/admin/permissions/documents/structured-source",
            payload: {
              expectedVersion: "7",
              categoryId: "sales",
              fileConfidentialityLevel: 1,
              scopes: []
            }
          })
        ).statusCode
      ).toBe(400);
      expect(repository.configureEvidenceDocument).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });
  it("manages evidence attributes and dimension values without content or BigInt serialization errors", async () => {
    const { app, snapshot, repository } = fixture();
    snapshot.categories = [
      {
        id: "memo",
        kind: "evidence",
        confidentialityLevel: null,
        ownerships: ["group"],
        requiredDimensionIds: []
      }
    ];
    try {
      const result = await app.inject({
        method: "PATCH",
        url: "/v1/admin/permissions/documents/memo-doc",
        payload: {
          expectedVersion: "7",
          categoryId: "memo",
          fileConfidentialityLevel: 2,
          scopes: [{ enterpriseKey: "enterprise", ownership: "group", dimensions: {} }]
        }
      });
      expect(result.statusCode).toBe(200);
      expect(result.json().value.authorizationVersion).toBe("1");
      expect(repository.configureEvidenceDocument).toHaveBeenCalledWith(
        expect.objectContaining({ documentId: "memo-doc", categoryId: "memo", orgId: "org" })
      );
      expect(
        (
          await app.inject({
            method: "PATCH",
            url: "/v1/admin/permissions/dimensions/project/values/X",
            payload: { expectedVersion: "7", name: "Old project", retired: true }
          })
        ).statusCode
      ).toBe(200);
      expect(repository.defineDimensionValue).toHaveBeenCalledWith(
        expect.objectContaining({
          dimensionId: "project",
          id: "X",
          retired: true,
          updateOnly: true
        })
      );
    } finally {
      await app.close();
    }
  });
});

it("returns complete review enterprise options in the fresh permission card", async () => {
  const { app, repository } = fixture();
  try {
    const response = await app.inject({ url: "/v1/permissions/me" });
    expect(response.statusCode).toBe(200);
    expect(response.json().storeReviewEnterprises).toEqual({ complete: true, write: [], read: [] });
    expect(repository.loadPermissionCard).toHaveBeenCalledWith("actor", "org");
  } finally {
    await app.close();
  }
});
