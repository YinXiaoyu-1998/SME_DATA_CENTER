import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApiServer } from "./server.js";
import type { RequestAuditContext } from "./request-audit-context.js";
import {
  adminEmployee,
  disabledEmployee,
  accessTokenFor,
  authenticateTestAccessToken,
  buildTestServer,
  createDocumentRepository,
  createEvidenceSearchRepository,
  createRepository,
  jwtSecret
} from "./test-support/api-server-fixtures.js";

describe("api auth shell", () => {
  let app: FastifyInstance | undefined;

  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  it("returns the health check response", async () => {
    app = buildTestServer();

    const response = await app.inject({
      method: "GET",
      url: "/healthz"
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      ok: true,
      service: "enterprise-hub-api"
    });
    expect(response.headers["x-request-id"]).toBeTruthy();
  });

  it("uses forwarded client IPs only from a loopback proxy peer", async () => {
    app = buildTestServer();
    app.get("/__test/request-audit-ip", async (request) => ({ sourceIp: request.ip }));

    const trustedProxyResponse = await app.inject({
      method: "GET",
      url: "/__test/request-audit-ip",
      remoteAddress: "127.0.0.1",
      headers: { "x-forwarded-for": "203.0.113.9" }
    });
    const forgedForwardingResponse = await app.inject({
      method: "GET",
      url: "/__test/request-audit-ip",
      remoteAddress: "198.51.100.8",
      headers: { "x-forwarded-for": "203.0.113.9" }
    });

    expect(trustedProxyResponse.json()).toEqual({ sourceIp: "203.0.113.9" });
    expect(forgedForwardingResponse.json()).toEqual({ sourceIp: "198.51.100.8" });
  });

  it("replaces invalid request IDs with bounded server-generated values", async () => {
    app = buildTestServer();

    for (const requestId of ["x".repeat(129), "invalid request id"]) {
      const response = await app.inject({
        method: "GET",
        url: "/healthz",
        headers: { "x-request-id": requestId }
      });
      const responseRequestId = response.headers["x-request-id"];

      expect(responseRequestId).toMatch(
        /^req_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
      );
      expect(Buffer.byteLength(responseRequestId as string, "utf8")).toBeLessThanOrEqual(128);
    }
  });

  it("echoes valid structured request IDs unchanged", async () => {
    app = buildTestServer();

    const response = await app.inject({
      method: "GET",
      url: "/healthz",
      headers: { "x-request-id": "req_valid-123" }
    });

    expect(response.headers["x-request-id"]).toBe("req_valid-123");
  });

  it("returns local readiness results and maps failures to 503", async () => {
    app = buildApiServer({
      employeeRepository: createRepository([adminEmployee]),
      cursorSigningSecret: jwtSecret,
      authenticateAccessToken: authenticateTestAccessToken,
      logger: false,
      readinessCheck: async () => ({
        ok: false,
        retrievalConfigVersion: "test-retrieval",
        checks: [
          {
            name: "mysql",
            ok: true,
            message: "mysql readiness check passed."
          },
          {
            name: "qdrant",
            ok: false,
            message: "Qdrant evidence collection is missing."
          }
        ]
      })
    });

    const response = await app.inject({
      method: "GET",
      url: "/readyz",
      remoteAddress: "127.0.0.1"
    });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({
      ok: false,
      service: "enterprise-hub-api",
      retrievalConfigVersion: "test-retrieval",
      checks: [
        {
          name: "mysql",
          ok: true,
          message: "mysql readiness check passed."
        },
        {
          name: "qdrant",
          ok: false,
          message: "Qdrant evidence collection is missing."
        }
      ]
    });
  });

  it("does not expose readiness to non-loopback clients", async () => {
    app = buildApiServer({
      employeeRepository: createRepository([adminEmployee]),
      cursorSigningSecret: jwtSecret,
      authenticateAccessToken: authenticateTestAccessToken,
      logger: false,
      readinessCheck: async () => {
        throw new Error("readiness should not run for non-loopback clients");
      }
    });

    const response = await app.inject({
      method: "GET",
      url: "/readyz",
      remoteAddress: "203.0.113.10"
    });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({
      error: {
        code: "NOT_FOUND",
        message: "Not found."
      }
    });
  });

  it("does not expose the removed development login endpoint", async () => {
    app = buildTestServer();

    const response = await app.inject({
      method: "POST",
      url: "/auth/dev-login",
      payload: {
        email: "admin@example.com"
      }
    });

    expect(response.statusCode).toBe(404);
  });

  it("returns the authenticated employee from /me", async () => {
    app = buildTestServer();
    const accessToken = await accessTokenFor(adminEmployee);

    const response = await app.inject({
      method: "GET",
      url: "/me",
      headers: {
        authorization: `Bearer ${accessToken}`
      }
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      employee: adminEmployee
    });
  });

  it("rejects missing and invalid bearer tokens", async () => {
    app = buildTestServer();

    const missingToken = await app.inject({
      method: "GET",
      url: "/me"
    });
    const invalidToken = await app.inject({
      method: "GET",
      url: "/me",
      headers: {
        authorization: "Bearer not-a-real-token"
      }
    });

    expect(missingToken.statusCode).toBe(401);
    expect(missingToken.json()).toMatchObject({
      error: {
        code: "UNAUTHENTICATED"
      }
    });
    expect(invalidToken.statusCode).toBe(401);
    expect(invalidToken.json()).toMatchObject({
      error: {
        code: "UNAUTHENTICATED"
      }
    });
  });

  it("passes API and MCP route metadata into access-token authentication", async () => {
    const calls: Array<{
      token: string;
      audit: Pick<RequestAuditContext, "requestId" | "sourceIp" | "launcherVersion"> | undefined;
    }> = [];
    app = buildApiServer({
      employeeRepository: createRepository([adminEmployee]),
      cursorSigningSecret: jwtSecret,
      authenticateAccessToken: async (
        token: string,
        audit?: Pick<RequestAuditContext, "requestId" | "sourceIp" | "launcherVersion">
      ) => {
        calls.push({ token, audit });
        return adminEmployee;
      },
      logger: false
    });

    const apiResponse = await app.inject({
      method: "GET",
      url: "/me",
      headers: {
        authorization: "Bearer eh_at_api",
        "x-request-id": "api_request_1",
        "x-enterprise-hub-launcher-version": "9.9.9"
      },
      remoteAddress: "198.51.100.8"
    });
    const mcpResponse = await app.inject({
      method: "POST",
      url: "/mcp",
      headers: {
        host: "127.0.0.1:3000",
        authorization: "Bearer eh_at_mcp",
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        "x-request-id": "mcp_request_1",
        "x-enterprise-hub-launcher-version": "0.1.0"
      },
      remoteAddress: "127.0.0.1",
      payload: {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-11-25",
          capabilities: {},
          clientInfo: { name: "audit-test", version: "1.0.0" }
        }
      }
    });

    expect(apiResponse.statusCode).toBe(200);
    expect(mcpResponse.statusCode).toBe(200);
    expect(calls).toEqual([
      {
        token: "eh_at_api",
        audit: {
          requestId: "api_request_1",
          sourceIp: "198.51.100.8",
          launcherVersion: null
        }
      },
      {
        token: "eh_at_mcp",
        audit: {
          requestId: "mcp_request_1",
          sourceIp: "127.0.0.1",
          launcherVersion: "0.1.0"
        }
      }
    ]);
  });

  it("keeps the authoritative organization in authenticated employee responses", async () => {
    app = buildTestServer();
    const accessToken = await accessTokenFor(adminEmployee);

    const response = await app.inject({
      method: "GET",
      url: "/me",
      headers: {
        authorization: `Bearer ${accessToken}`
      }
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      employee: {
        id: adminEmployee.id,
        orgId: "default-org"
      }
    });
  });

  it("does not register removed ordinary document endpoints", async () => {
    app = buildTestServer();
    const removedEndpoints = [
      { method: "POST", url: "/documents" },
      { method: "GET", url: "/documents" },
      { method: "GET", url: "/documents/doc_removed" },
      { method: "GET", url: "/documents/doc_removed/download" },
      { method: "GET", url: "/documents/doc_removed/status" },
      { method: "POST", url: "/documents/doc_removed/archive" },
      { method: "POST", url: "/documents/doc_removed/labels" }
    ] as const;

    for (const endpoint of removedEndpoints) {
      const response = await app.inject(endpoint);
      expect(response.statusCode).toBe(404);
    }
  });

  it("rejects disabled employees even when the token is otherwise valid", async () => {
    app = buildTestServer();
    const accessToken = await accessTokenFor(disabledEmployee);

    const response = await app.inject({
      method: "GET",
      url: "/me",
      headers: {
        authorization: `Bearer ${accessToken}`
      }
    });

    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({
      error: {
        code: "EMPLOYEE_DISABLED"
      }
    });
  });

  it("requires backend authorization for every non-health Phase 3 endpoint", async () => {
    app = buildApiServer({
      employeeRepository: createRepository([adminEmployee]),
      documentRepository: createDocumentRepository(),
      evidenceRepository: createEvidenceSearchRepository(),
      cursorSigningSecret: jwtSecret,
      authenticateAccessToken: authenticateTestAccessToken,
      logger: false
    });
    const phase3Endpoints = [
      {
        method: "POST",
        url: "/v1/documents/evidence",
        headers: {
          "content-type": "multipart/form-data; boundary=phase3-auth-check"
        },
        payload: Buffer.from("--phase3-auth-check--\r\n")
      },
      {
        method: "POST",
        url: "/v1/evidence/search",
        payload: { query: "差评处理" }
      },
      {
        method: "GET",
        url: "/v1/documents/evidence/doc_auth/status"
      },
      {
        method: "POST",
        url: "/v1/structured/imports",
        headers: {
          "content-type": "multipart/form-data; boundary=phase3-auth-check"
        },
        payload: Buffer.from("--phase3-auth-check--\r\n")
      },
      {
        method: "GET",
        url: "/v1/structured/imports/imp_hidden"
      },
      {
        method: "GET",
        url: "/v1/structured/datasets"
      },
      {
        method: "POST",
        url: "/v1/structured/query",
        payload: { dataset: "dishes", select: ["business_date"] }
      }
    ] as const;

    for (const endpoint of phase3Endpoints) {
      const response = await app.inject(endpoint);

      expect(response.statusCode, `${endpoint.method} ${endpoint.url}`).toBe(401);
      expect(response.json(), `${endpoint.method} ${endpoint.url}`).toMatchObject({
        error: {
          code: "UNAUTHENTICATED"
        }
      });
    }
  });
});
