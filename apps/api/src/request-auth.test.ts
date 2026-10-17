import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import {
  AUTH_ERROR_CODES,
  type AuthorizationSnapshot,
  type AuthenticatedEmployee
} from "@smedc/domain";
import { createRequestAuth } from "./request-auth.js";
import type { ApiServerContext } from "./app-context.js";

const enabledEmployee: AuthenticatedEmployee = {
  id: "emp_1",
  orgId: "default-org",
  organizationName: "Default Organization",
  displayName: "Employee One",
  email: "employee@example.com",
  role: "employee",
  disabled: false,
  clearance: 3
};

const disabledEmployee: AuthenticatedEmployee = {
  ...enabledEmployee,
  id: "emp_disabled",
  disabled: true
};

function minimalContext(
  authenticateOfficialAccessToken: ApiServerContext["authenticateOfficialAccessToken"]
): ApiServerContext {
  return {
    permissions: () => {
      throw new Error("unused");
    },
    environment: {},
    delegationProof: "proof",
    runtimeLimits: {} as ApiServerContext["runtimeLimits"],
    cursorSigningSecret: "secret",
    readinessCheck: async () =>
      ({
        ok: true,
        checks: []
      }) as never,
    authCore: undefined,
    authenticateOfficialAccessToken,
    authenticationClientSource: () => "http_api",
    createBusinessRequestAudit: () => ({
      requestId: "req_test",
      sourceIp: "127.0.0.1",
      clientSource: "http_api",
      launcherVersion: null
    }),
    documents: () => {
      throw new Error("not used");
    },
    storage: () => {
      throw new Error("not used");
    },
    structuredImports: () => {
      throw new Error("not used");
    },
    structuredPartitions: () => {
      throw new Error("not used");
    },
    partitionDownloads: () => {
      throw new Error("not used");
    },
    partitionDownloadAudit: () => {
      throw new Error("not used");
    },
    structuredQueries: () => {
      throw new Error("not used");
    },
    structuredCoverage: () => {
      throw new Error("not used");
    },
    storeReviews: () => {
      throw new Error("not used");
    },
    costCards: () => {
      throw new Error("not used");
    },
    skills: () => {
      throw new Error("not used");
    },
    ledgerPdfs: () => {
      throw new Error("Unexpected ledger PDF dependency");
    },
    evidence: () => {
      throw new Error("not used");
    },
    uploadAuthorizationAudit: () => {
      throw new Error("not used");
    },
    quarantineCertificates: () => {
      throw new Error("not used");
    },
    sourceDocuments: () => {
      throw new Error("not used");
    },
    sourceDocumentDownloads: () => {
      throw new Error("not used");
    },
    close: async () => undefined
  };
}

describe("request authentication", () => {
  it("memoizes mode and permissions together for a request and reloads after a tenant cutover", async () => {
    const app = Fastify({ logger: false });
    let loads = 0;
    const current: AuthorizationSnapshot = {
      orgId: enabledEmployee.orgId,
      employeeId: enabledEmployee.id,
      role: "employee",
      disabled: false,
      clearance: 3,
      mode: "legacy",
      authorizationVersion: "7",
      categories: [],
      grants: []
    };
    const context = minimalContext(async () => enabledEmployee);
    context.permissions = () =>
      ({
        current: async () => {
          loads++;
          return structuredClone(current);
        }
      }) as unknown as ReturnType<ApiServerContext["permissions"]>;
    const auth = createRequestAuth(context);
    app.get("/protected", async (request, reply) => {
      if (!(await auth.authenticate(request, reply))) return;
      const first = await auth.authorization(request);
      current.mode = "enabled";
      current.authorizationVersion = "8";
      const second = await auth.authorization(request);
      expect(second).toBe(first);
      return second;
    });
    try {
      const options = { url: "/protected", headers: { authorization: "Bearer token" } };
      expect((await app.inject(options)).json()).toMatchObject({
        mode: "legacy",
        authorizationVersion: "7"
      });
      expect((await app.inject(options)).json()).toMatchObject({
        mode: "enabled",
        authorizationVersion: "8"
      });
      expect(loads).toBe(2);
    } finally {
      await app.close();
    }
  });

  it("binds the authoritative employee to the request after bearer auth succeeds", async () => {
    const app = Fastify({ logger: false });
    const auth = createRequestAuth(
      minimalContext(async (token) => (token === "valid-token" ? enabledEmployee : null))
    );

    app.get("/protected", async (request, reply) => {
      if (!(await auth.authenticate(request, reply))) {
        return;
      }

      return { employee: auth.employee(request) };
    });

    try {
      const response = await app.inject({
        method: "GET",
        url: "/protected",
        headers: { authorization: "Bearer valid-token" }
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ employee: enabledEmployee });
    } finally {
      await app.close();
    }
  });

  it("keeps the existing unauthenticated and disabled response bodies", async () => {
    const app = Fastify({ logger: false });
    const auth = createRequestAuth(minimalContext(async () => disabledEmployee));

    app.get("/protected", async (request, reply) => {
      await auth.authenticate(request, reply);
    });

    try {
      const missing = await app.inject({ method: "GET", url: "/protected" });
      const disabled = await app.inject({
        method: "GET",
        url: "/protected",
        headers: { authorization: "Bearer disabled-token" }
      });

      expect(missing.statusCode).toBe(401);
      expect(missing.json()).toEqual({
        error: {
          code: AUTH_ERROR_CODES.unauthenticated,
          message: "Authentication is required."
        }
      });
      expect(disabled.statusCode).toBe(403);
      expect(disabled.json()).toEqual({
        error: {
          code: AUTH_ERROR_CODES.employeeDisabled,
          message: "Employee account is disabled."
        }
      });
    } finally {
      await app.close();
    }
  });
});
