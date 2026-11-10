import { afterEach, describe, expect, it } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import {
  BROWSER_SESSION_COOKIE,
  BrowserSessions,
  type BrowserLoginIdentity,
  type BrowserSessionRepository
} from "../auth/browser-session.js";
import { registerApiErrorHandler } from "../request-errors.js";
import { registerWebSessionRoutes } from "./session.js";

const WEB_ORIGIN = "https://app.smedatacenter.example";
const API_ORIGIN = "https://api.smedatacenter.example";

const identity: BrowserLoginIdentity = {
  identityId: "idn_1",
  userAccountId: "emp_1",
  orgId: "org_1",
  credentialFingerprint: "a".repeat(64)
};

function createSessions() {
  const records = new Map<
    string,
    {
      principal: {
        id: string;
        identityId: string;
        orgId: string;
        organizationName: string;
        displayName: string;
        email: string;
        role: "admin" | "employee";
        clearance: number;
        disabled: boolean;
      };
      expiresAt: Date;
      revokedAt: Date | null;
      credentialFingerprint: string;
      currentCredentialFingerprint: string;
    }
  >();
  const repository: BrowserSessionRepository = {
    async create(input) {
      records.set(input.secretHash, {
        principal: {
          id: input.userAccountId,
          identityId: input.identityId,
          orgId: input.orgId,
          organizationName: "示例企业",
          displayName: "张三",
          email: "admin@example.com",
          role: "admin",
          clearance: 3,
          disabled: false
        },
        expiresAt: input.expiresAt,
        revokedAt: null,
        credentialFingerprint: input.credentialFingerprint,
        currentCredentialFingerprint: input.credentialFingerprint
      });
      return true;
    },
    async find(secretHash) {
      const record = records.get(secretHash);
      return record ? { ...record } : null;
    },
    async revoke(secretHash, now) {
      const record = records.get(secretHash);
      if (record) record.revokedAt = now;
    }
  };
  return new BrowserSessions(repository);
}

interface Fixture {
  app: FastifyInstance;
  sessions: BrowserSessions;
}

const apps: FastifyInstance[] = [];

async function build(overrides: { verifyLogin?: () => Promise<unknown> } = {}): Promise<Fixture> {
  const app = Fastify({ logger: false });
  apps.push(app);
  registerApiErrorHandler(app);
  const sessions = createSessions();
  registerWebSessionRoutes(app, {
    auth: {
      verifyLogin:
        (overrides.verifyLogin as never) ??
        (async (email: string, password: string) =>
          email === "admin@example.com" && password === "correct-horse"
            ? { ok: true as const, ...identity }
            : { ok: false as const, reason: "invalid_credentials" as const })
    },
    browserSessions: sessions,
    webOrigin: WEB_ORIGIN
  });
  await app.ready();
  return { app, sessions };
}

function cookieOf(response: { headers: Record<string, unknown> }): string {
  const header = response.headers["set-cookie"];
  const raw = Array.isArray(header) ? String(header[0]) : String(header);
  return raw.split(";")[0] ?? "";
}

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

describe("web session routes", () => {
  it("rejects login without a same-origin Origin", async () => {
    const { app } = await build();
    const response = await app.inject({
      method: "POST",
      url: "/api/web/v1/session",
      payload: { email: "admin@example.com", password: "correct-horse" }
    });
    expect(response.statusCode).toBe(403);
    expect(response.json()).toEqual({
      error: { code: "BROWSER_SECURITY_CHECK_FAILED", message: expect.any(String) }
    });
  });

  it("rejects invalid credentials with a typed code and no cookie", async () => {
    const { app } = await build();
    const response = await app.inject({
      method: "POST",
      url: "/api/web/v1/session",
      headers: { origin: WEB_ORIGIN },
      payload: { email: "admin@example.com", password: "wrong" }
    });
    expect(response.statusCode).toBe(401);
    expect(response.json().error.code).toBe("BROWSER_INVALID_CREDENTIALS");
    expect(response.headers["set-cookie"]).toBeUndefined();
  });

  it("rejects a body that does not match the contract", async () => {
    const { app } = await build();
    const response = await app.inject({
      method: "POST",
      url: "/api/web/v1/session",
      headers: { origin: WEB_ORIGIN },
      payload: { email: "admin@example.com" }
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe("WEB_API_INVALID_REQUEST");
  });

  it("logs in, reads the session and logs out", async () => {
    const { app } = await build();
    const login = await app.inject({
      method: "POST",
      url: "/api/web/v1/session",
      headers: { origin: WEB_ORIGIN },
      payload: { email: "admin@example.com", password: "correct-horse" }
    });
    expect(login.statusCode).toBe(200);
    expect(login.headers["cache-control"]).toBe("no-store");
    const body = login.json();
    expect(body.identity).toEqual({
      userAccountId: "emp_1",
      displayName: "张三",
      email: "admin@example.com",
      orgId: "org_1",
      organizationName: "示例企业",
      role: "admin",
      clearance: 3
    });
    expect(body.canManageSettings).toBe(true);
    const cookie = cookieOf(login);
    expect(cookie.startsWith(`${BROWSER_SESSION_COOKIE}=`)).toBe(true);

    const read = await app.inject({
      method: "GET",
      url: "/api/web/v1/session",
      headers: { cookie }
    });
    expect(read.statusCode).toBe(200);
    expect(read.json().csrfToken).toBe(body.csrfToken);

    const missingCsrf = await app.inject({
      method: "DELETE",
      url: "/api/web/v1/session",
      headers: { cookie, origin: WEB_ORIGIN }
    });
    expect(missingCsrf.statusCode).toBe(403);

    const logout = await app.inject({
      method: "DELETE",
      url: "/api/web/v1/session",
      headers: { cookie, origin: WEB_ORIGIN, "x-csrf-token": body.csrfToken }
    });
    expect(logout.statusCode).toBe(200);
    expect(logout.json()).toEqual({ signedOut: true });

    const after = await app.inject({
      method: "GET",
      url: "/api/web/v1/session",
      headers: { cookie }
    });
    expect(after.statusCode).toBe(401);
    expect(after.json().error.code).toBe("BROWSER_SIGN_IN_REQUIRED");
  });

  it("rejects a write from another origin even with a valid CSRF token", async () => {
    const { app } = await build();
    const login = await app.inject({
      method: "POST",
      url: "/api/web/v1/session",
      headers: { origin: WEB_ORIGIN },
      payload: { email: "admin@example.com", password: "correct-horse" }
    });
    const cookie = cookieOf(login);
    const body = login.json();
    const response = await app.inject({
      method: "DELETE",
      url: "/api/web/v1/session",
      headers: { cookie, origin: API_ORIGIN, "x-csrf-token": body.csrfToken }
    });
    expect(response.statusCode).toBe(403);
  });
});
