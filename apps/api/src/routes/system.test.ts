import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import type { AuthenticatedEmployee } from "@smedc/domain";
import { createRequestAuth } from "../request-auth.js";
import { registerSystemRoutes } from "./system.js";
import type { ApiServerContext } from "../app-context.js";

const employee: AuthenticatedEmployee = {
  id: "emp_1",
  orgId: "default-org",
  organizationName: "示例餐饮管理有限公司",
  displayName: "Employee One",
  email: "employee@example.com",
  role: "employee",
  disabled: false,
  clearance: 3
};

function context(): ApiServerContext {
  return {
    environment: {},
    delegationProof: "proof",
    runtimeLimits: {} as ApiServerContext["runtimeLimits"],
    cursorSigningSecret: "secret",
    readinessCheck: async () =>
      ({
        ok: false,
        retrievalConfigVersion: "phase3.retrieval.v1",
        checks: [{ name: "database", ok: false, message: "down" }]
      }) as never,
    authCore: undefined,
    authenticateOfficialAccessToken: async (token) => (token === "valid" ? employee : null),
    authenticationClientSource: () => "http_api",
    createBusinessRequestAudit: () => {
      throw new Error("not used");
    },
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

describe("system routes", () => {
  let app: FastifyInstance | undefined;

  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  it("serves health and loopback-only readiness with the existing response shapes", async () => {
    const dependencies = context();
    app = Fastify({ logger: false });
    registerSystemRoutes(app, {
      auth: createRequestAuth(dependencies),
      readinessCheck: dependencies.readinessCheck
    });

    const health = await app.inject({ method: "GET", url: "/healthz" });
    const nonLoopbackReady = await app.inject({
      method: "GET",
      url: "/readyz",
      remoteAddress: "198.51.100.10"
    });
    const loopbackReady = await app.inject({
      method: "GET",
      url: "/readyz",
      remoteAddress: "127.0.0.1"
    });

    expect(health.statusCode).toBe(200);
    expect(health.json()).toEqual({ ok: true, service: "smedc-api" });
    expect(nonLoopbackReady.statusCode).toBe(404);
    expect(nonLoopbackReady.json()).toEqual({
      error: { code: "NOT_FOUND", message: "Not found." }
    });
    expect(loopbackReady.statusCode).toBe(503);
    expect(loopbackReady.json()).toMatchObject({
      ok: false,
      service: "smedc-api"
    });
  });

  it("serves /me only after backend bearer auth", async () => {
    const dependencies = context();
    app = Fastify({ logger: false });
    registerSystemRoutes(app, {
      auth: createRequestAuth(dependencies),
      readinessCheck: dependencies.readinessCheck
    });

    const missing = await app.inject({ method: "GET", url: "/me" });
    const present = await app.inject({
      method: "GET",
      url: "/me",
      headers: { authorization: "Bearer valid" }
    });

    expect(missing.statusCode).toBe(401);
    expect(present.statusCode).toBe(200);
    expect(present.json()).toEqual({
      employee: {
        id: employee.id,
        orgId: employee.orgId,
        organizationName: "示例餐饮管理有限公司",
        displayName: employee.displayName,
        email: employee.email,
        role: employee.role,
        disabled: employee.disabled,
        clearance: employee.clearance
      }
    });
  });
});
