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
