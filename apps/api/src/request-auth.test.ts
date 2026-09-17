import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import { AUTH_ERROR_CODES, type AuthenticatedEmployee } from "@smedc/domain";
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
    structuredQueries: () => {
      throw new Error("not used");
    },
    structuredCoverage: () => {
      throw new Error("not used");
    },
    skills: () => {
      throw new Error("not used");
    },
    evidence: () => {
      throw new Error("not used");
    },
    quarantineCertificates: () => {
      throw new Error("not used");
    },
    sourceDocuments: () => {
      throw new Error("not used");
    },
    close: async () => undefined
  };
}

describe("request authentication", () => {
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
