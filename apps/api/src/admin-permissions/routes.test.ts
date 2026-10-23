import Fastify from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  BrowserSessions,
  BROWSER_SESSION_COOKIE,
  type BrowserPrincipal,
  type BrowserSessionRepository
} from "../auth/browser-session.js";
import { registerOfficialAuthRoutes } from "../auth/routes.js";
import { csrfTokenForSecret } from "../auth/http-contract.js";
import {
  createBusinessAuthorizationService,
  type BusinessAuthorizationRepository
} from "../business-authorization.js";
import { registerApiErrorHandler } from "../request-errors.js";

const origin = "https://api.smedatacenter.xyz";
const fingerprint = "a".repeat(64);
const apps: ReturnType<typeof Fastify>[] = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

async function fixture() {
  const module = await import("./routes.js").catch(() => null);
  expect(module, "enterprise-bound permissions routes must exist").not.toBeNull();
  const principals = new Map<string, BrowserPrincipal>(
    ["a", "b"].map((suffix) => [
      `identity_${suffix}`,
      {
        identityId: `identity_${suffix}`,
        id: `admin_${suffix}`,
        orgId: `org_${suffix}`,
        organizationName: suffix === "a" ? "企业甲保密名称" : "企业乙",
        displayName: `管理员${suffix}`,
        email: `${suffix}@example.invalid`,
        role: "admin",
        clearance: 3,
        disabled: false
      }
    ])
  );
  let now = new Date();
  const records = new Map<
    string,
    { identityId: string; expiresAt: Date; revokedAt: Date | null }
  >();
  const repository: BrowserSessionRepository = {
    async create(input) {
      records.set(input.secretHash, {
        identityId: input.identityId,
        expiresAt: input.expiresAt,
        revokedAt: null
      });
      return true;
    },
    async find(hash) {
      const row = records.get(hash);
      const principal = row && principals.get(row.identityId);
      return row && principal
        ? {
            ...row,
            principal,
            credentialFingerprint: fingerprint,
            currentCredentialFingerprint: fingerprint
          }
        : null;
    },
    async revoke(hash, at) {
      const row = records.get(hash);
      if (row) row.revokedAt = at;
    }
  };
  const sessions = new BrowserSessions(repository, () => now);
  const audit = { requestId: "req_ui", sourceIp: "127.0.0.1", launcherVersion: null };
  const secretA = (await sessions.issue(
    {
      identityId: "identity_a",
      employeeId: "admin_a",
      orgId: "org_a",
      credentialFingerprint: fingerprint
    },
    null,
    audit
  ))!;
  const secretB = (await sessions.issue(
    {
      identityId: "identity_b",
      employeeId: "admin_b",
      orgId: "org_b",
      credentialFingerprint: fingerprint
    },
    null,
    audit
  ))!;
  const auth = {
    verifyLogin: vi.fn(async (email: string, password: string) =>
      password === "synthetic password" &&
      ["a@example.invalid", "b@example.invalid"].includes(email)
        ? {
            ok: true as const,
            identityId: `identity_${email[0]}`,
            employeeId: `admin_${email[0]}`,
            orgId: `org_${email[0]}`,
            credentialFingerprint: fingerprint
          }
        : { ok: false as const, reason: "invalid_credentials" as const }
    ),
    findDeviceAuthorizationByUserCode: vi.fn(async () => ({
      status: "pending" as const,
      instanceName: "synthetic-agent",
      instanceHostname: "test-host"
    })),
    completeDeviceAuthorization: vi.fn(async () => true),
    authenticateAccessToken: async () => null,
    consumePasswordSetupSession: async () => false,
    createSession: async () => {
      throw new Error("unused");
    },
    exchangePasswordSetupGrant: async () => null,
    findPasswordSetupAccount: async () => null,
    issueDeviceAuthorization: async () => {
      throw new Error("unused");
    },
    logout: async () => false,
    pruneSecurityEvents: async () => 0,
    redeemDeviceAuthorization: async () => ({ status: "invalid" as const }),
    rotateDurableCredential: async () => ({ status: "invalid" as const })
  };
  const permissionsRepository = {
    initializeFixedCategories: vi.fn(async () => ({
      authorizationVersion: "8",
      value: { createdCount: 1 }
    })),
    loadAuthorizationSnapshot: vi.fn(async (employeeId: string, orgId: string) => ({
      orgId,
      employeeId,
      role: "admin" as const,
      disabled: false,
      clearance: 3,
      mode: "legacy" as const,
      authorizationVersion: "7",
      categories: [],
      grants: []
    })),
    listAccounts: vi.fn(async (orgId: string) => [
      { id: "other", displayName: "同企业员工", orgId, clearance: 0, grants: [] }
    ]),
    listCategories: vi.fn(async () => []),
    listDimensions: vi.fn(async () => []),
    listStores: vi.fn(async () => []),
    declareEnterpriseIdentity: vi.fn(async () => ({
      authorizationVersion: "8",
      value: { enterpriseKey: "示例 小馆 a", enterpriseName: "示例 小馆 A" }
    })),
    configureAccount: vi.fn(async () => ({ authorizationVersion: "8" })),
    inspectAuthorizationCutover: vi.fn(async () => ({
      authorizationVersion: "7",
      mode: "legacy",
      inspection: {
        ready: false,
        missing: [{ code: "FIXED_CATEGORY_CLEARANCE_REQUIRED", targetId: "business" }],
        accountsWithoutGrants: []
      }
    }))
  };
  const permissions = createBusinessAuthorizationService(
    permissionsRepository as unknown as BusinessAuthorizationRepository
  );
  const metadata = {
    listEnterprises: vi.fn(async () => [
      { enterpriseKey: "business-a", enterpriseName: "业务企业甲" }
    ]),
    listDocuments: vi.fn(async () => ({ documents: [], nextCursor: null }))
  };
  const app = Fastify({ logger: false });
  apps.push(app);
  registerApiErrorHandler(app);
  registerOfficialAuthRoutes(app, { auth, browserSessions: sessions, publicOrigin: origin });
  module!.registerAdminPermissionsRoutes(app, {
    auth,
    browserSessions: sessions,
    permissions: () => permissions,
    metadata: () => metadata,
    publicOrigin: origin
  });
  await app.ready();
  const cookie = (secret: string) => `${BROWSER_SESSION_COOKIE}=${secret}`;
  return {
    app,
    auth,
    sessions,
    secretA,
    secretB,
    principals,
    permissionsRepository,
    metadata,
    cookie,
    advance: (ms: number) => {
      now = new Date(now.getTime() + ms);
    },
    expire: () => {
      now = new Date(now.getTime() + 604_800_000);
    }
  };
}

function cookiePair(value: string | string[] | undefined, name: string) {
  const list = Array.isArray(value) ? value : [value ?? ""];
  return list.find((v) => v.startsWith(`${name}=`))!.split(";")[0]!;
}

describe("enterprise-bound browser permission management", () => {
  it("requires tenant-bound browser CSRF and expectedVersion for fixed-category initialization", async () => {
    const { app, cookie, secretA, secretB, permissionsRepository } = await fixture();
    const url = "/admin/permissions/org_a/api/categories/initialize";
    for (const headers of [
      { cookie: cookie(secretA), origin },
      {
        cookie: cookie(secretA),
        origin: "https://foreign.example.invalid",
        "x-csrf-token": csrfTokenForSecret(secretA)
      },
      { cookie: cookie(secretB), origin, "x-csrf-token": csrfTokenForSecret(secretB) }
    ])
      expect(
        (await app.inject({ method: "POST", url, headers, payload: { expectedVersion: "7" } }))
          .statusCode
      ).toBe(403);
    expect(permissionsRepository.initializeFixedCategories).not.toHaveBeenCalled();
    const headers = {
      cookie: cookie(secretA),
      origin,
      "x-csrf-token": csrfTokenForSecret(secretA)
    };
    expect((await app.inject({ method: "POST", url, headers, payload: {} })).statusCode).toBe(400);
    const response = await app.inject({
      method: "POST",
      url,
      headers,
      payload: { expectedVersion: "7" }
    });
    expect(response.json()).toEqual({ authorizationVersion: "8", value: { createdCount: 1 } });
    expect(permissionsRepository.initializeFixedCategories).toHaveBeenCalledExactlyOnceWith({
      orgId: "org_a",
      actorId: "admin_a",
      expectedVersion: "7"
    });
  });
  it("reuses device login for one absolute week without verifying a second password", async () => {
    const { app, auth, advance } = await fixture();
    const page = await app.inject({ url: "/oauth/device/verify?user_code=ABCDEFGH" });
    expect(page.headers["set-cookie"]).toContain("Max-Age=600;");
    const verifyCookie = cookiePair(page.headers["set-cookie"], "__Host-eh_device_verify");
    const secret = verifyCookie.slice(verifyCookie.indexOf("=") + 1);
    const login = await app.inject({
      method: "POST",
      url: "/oauth/device/verify/login",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        cookie: verifyCookie,
        origin
      },
      payload: new URLSearchParams({
        userCode: "ABCDEFGH",
        csrfToken: csrfTokenForSecret(secret),
        email: "a@example.invalid",
        password: "synthetic password"
      }).toString()
    });
    expect(login.statusCode).toBe(200);
    expect(login.headers["set-cookie"]).toEqual(
      expect.arrayContaining([
        expect.stringMatching(
          /^__Host-smedc_browser=[^;]+; Max-Age=604800; Path=\/; HttpOnly; Secure; SameSite=Lax$/
        )
      ])
    );
    const sharedCookie = cookiePair(login.headers["set-cookie"], BROWSER_SESSION_COOKIE);
    expect(sharedCookie).not.toContain("eh_at_");
    const permissions = await app.inject({
      url: "/admin/permissions/org_a",
      headers: { cookie: sharedCookie }
    });
    expect(permissions.statusCode).toBe(200);
    expect(permissions.headers["referrer-policy"]).toBe("same-origin");
    expect(permissions.body).toContain("企业甲保密名称");
    expect(permissions.body).not.toContain('name="password"');
    expect(auth.verifyLogin).toHaveBeenCalledTimes(1);
    const reuseLogin = await app.inject({
      url: "/admin/permissions/org_a/login",
      headers: { cookie: sharedCookie }
    });
    expect(reuseLogin.statusCode).toBe(303);
    expect(reuseLogin.headers.location).toBe("/admin/permissions/org_a");
    advance(604_799_000);
    const lastSecond = await app.inject({
      url: "/admin/permissions/org_a/api/accounts",
      headers: { cookie: sharedCookie }
    });
    expect(lastSecond.statusCode).toBe(200);
    expect(lastSecond.headers["set-cookie"]).toBeUndefined();
    advance(1000);
    expect(
      (
        await app.inject({
          url: "/admin/permissions/org_a/api/accounts",
          headers: { cookie: sharedCookie }
        })
      ).statusCode
    ).toBe(401);
  });
  it("refuses another enterprise's page and every management read/write without leaking its metadata", async () => {
    const { app, cookie, secretB, permissionsRepository, metadata } = await fixture();
    const targets = [
      "",
      "/login",
      "/api/accounts",
      "/api/categories",
      "/api/stores",
      "/api/dimensions",
      "/api/cutover",
      "/api/documents",
      "/api/enterprises",
      "/api/me"
    ];
    for (const suffix of targets) {
      const response = await app.inject({
        url: `/admin/permissions/org_a${suffix}`,
        headers: { cookie: cookie(secretB) }
      });
      expect(response.statusCode, suffix).toBe(403);
      expect(response.body).not.toContain("企业甲保密名称");
      expect(response.body).not.toContain("业务企业甲");
    }
    const write = await app.inject({
      method: "PATCH",
      url: "/admin/permissions/org_a/api/accounts/other",
      headers: { cookie: cookie(secretB), origin, "x-csrf-token": csrfTokenForSecret(secretB) },
      payload: { expectedVersion: "7", clearance: 3, grants: [] }
    });
    expect(write.statusCode).toBe(403);
    const declaration = await app.inject({
      method: "POST",
      url: "/admin/permissions/org_a/api/enterprises",
      headers: { cookie: cookie(secretB), origin, "x-csrf-token": csrfTokenForSecret(secretB) },
      payload: { name: "示例 小馆 A", expectedVersion: "7" }
    });
    expect(declaration.statusCode).toBe(403);
    expect(permissionsRepository.declareEnterpriseIdentity).not.toHaveBeenCalled();
    expect(permissionsRepository.loadAuthorizationSnapshot).not.toHaveBeenCalled();
    expect(permissionsRepository.configureAccount).not.toHaveBeenCalled();
    expect(metadata.listEnterprises).not.toHaveBeenCalled();
  });
  it("shows only generic login to an anonymous visitor and refuses B after logging in through A's URL", async () => {
    const { app } = await fixture();
    const entry = await app.inject({ url: "/admin/permissions/org_a" });
    expect(entry.statusCode).toBe(303);
    expect(entry.headers.location).toBe("/admin/permissions/org_a/login");
    const page = await app.inject({ url: entry.headers.location! });
    expect(page.statusCode).toBe(200);
    expect(page.body).not.toContain("企业甲保密名称");
    const loginCookie = cookiePair(page.headers["set-cookie"], "__Host-smedc_login");
    const secret = loginCookie.slice(loginCookie.indexOf("=") + 1);
    const login = await app.inject({
      method: "POST",
      url: "/admin/permissions/org_a/login",
      headers: { cookie: loginCookie, origin, "content-type": "application/x-www-form-urlencoded" },
      payload: new URLSearchParams({
        csrfToken: csrfTokenForSecret(secret),
        email: "b@example.invalid",
        password: "synthetic password",
        returnTo: "https://attacker.invalid"
      }).toString()
    });
    expect(login.statusCode).toBe(403);
    expect(login.headers.location).toBeUndefined();
    expect(login.body).not.toContain("企业甲保密名称");
  });
  it("gates expired, disabled and downgraded browser identities before management access", async () => {
    const { app, secretA, cookie, principals, expire } = await fixture();
    principals.get("identity_a")!.role = "employee";
    expect(
      (await app.inject({ url: "/admin/permissions/org_a", headers: { cookie: cookie(secretA) } }))
        .statusCode
    ).toBe(403);
    principals.get("identity_a")!.role = "admin";
    principals.get("identity_a")!.disabled = true;
    expect(
      (
        await app.inject({
          url: "/admin/permissions/org_a/api/accounts",
          headers: { cookie: cookie(secretA) }
        })
      ).statusCode
    ).toBe(401);
    principals.get("identity_a")!.disabled = false;
    expire();
    expect(
      (await app.inject({ url: "/admin/permissions/org_a", headers: { cookie: cookie(secretA) } }))
        .statusCode
    ).toBe(303);
    const expiredLogout = await app.inject({
      method: "POST",
      url: "/admin/permissions/org_a/logout",
      headers: { cookie: cookie(secretA), origin },
      payload: {}
    });
    expect(expiredLogout.statusCode).toBe(401);
    expect(expiredLogout.headers["content-type"]).toContain("text/html");
    expect(expiredLogout.body).toContain("请重新登录");
    expect(expiredLogout.body).toContain("Sign in again");
  });
  it("requires matching Origin and CSRF for writes, and revokes browser access on logout", async () => {
    const { app, cookie, secretA, permissionsRepository } = await fixture();
    const url = "/admin/permissions/org_a/api/accounts/other";
    for (const headers of [
      { cookie: cookie(secretA) },
      {
        cookie: cookie(secretA),
        origin: "https://attacker.invalid",
        "x-csrf-token": csrfTokenForSecret(secretA)
      },
      { cookie: cookie(secretA), origin, "x-csrf-token": "wrong" }
    ]) {
      expect(
        (
          await app.inject({
            method: "PATCH",
            url,
            headers,
            payload: { expectedVersion: "7", clearance: 1, grants: [] }
          })
        ).statusCode
      ).toBe(403);
    }
    const save = await app.inject({
      method: "PATCH",
      url,
      headers: { cookie: cookie(secretA), origin, "x-csrf-token": csrfTokenForSecret(secretA) },
      payload: { expectedVersion: "7", clearance: 1, grants: [] }
    });
    expect(save.statusCode).toBe(200);
    expect(permissionsRepository.configureAccount).toHaveBeenCalledTimes(1);
    const logout = await app.inject({
      method: "POST",
      url: "/admin/permissions/org_a/logout",
      headers: {
        cookie: cookie(secretA),
        origin,
        "content-type": "application/x-www-form-urlencoded"
      },
      payload: new URLSearchParams({ csrfToken: csrfTokenForSecret(secretA) }).toString()
    });
    expect(logout.statusCode).toBe(303);
    expect(
      (
        await app.inject({
          url: "/admin/permissions/org_a/api/accounts",
          headers: { cookie: cookie(secretA) }
        })
      ).statusCode
    ).toBe(401);
  });
  it("keeps malformed sign-in validation in the bilingual HTML flow", async () => {
    const { app } = await fixture();
    const page = await app.inject({ url: "/admin/permissions/org_a/login" });
    const loginCookie = cookiePair(page.headers["set-cookie"], "__Host-smedc_login");
    const secret = loginCookie.slice(loginCookie.indexOf("=") + 1);
    const response = await app.inject({
      method: "POST",
      url: "/admin/permissions/org_a/login",
      headers: { cookie: loginCookie, origin, "content-type": "application/x-www-form-urlencoded" },
      payload: new URLSearchParams({
        csrfToken: csrfTokenForSecret(secret),
        email: "a@example.invalid",
        password: ""
      }).toString()
    });
    expect(response.statusCode).toBe(400);
    expect(response.headers["content-type"]).toContain("text/html");
    expect(response.body).toContain("邮箱或密码错误");
    expect(response.body).toContain("email or password is incorrect");
  });
  it("does not accept a launcher bearer token as a browser login", async () => {
    const { app } = await fixture();
    const response = await app.inject({
      url: "/admin/permissions/org_a/api/accounts",
      headers: { authorization: "Bearer eh_at_launcher" }
    });
    expect(response.statusCode).toBe(401);
  });
  it("persists confirmed names through the versioned permission transaction and reports conflicts", async () => {
    const { app, cookie, secretA, permissionsRepository } = await fixture();
    const request = {
      method: "POST" as const,
      url: "/admin/permissions/org_a/api/enterprises",
      headers: { cookie: cookie(secretA), origin, "x-csrf-token": csrfTokenForSecret(secretA) },
      payload: { name: "示例 小馆 A", expectedVersion: "7" }
    };
    expect(
      (await app.inject({ ...request, headers: { cookie: cookie(secretA), origin } })).statusCode
    ).toBe(403);
    const saved = await app.inject(request);
    expect(saved.statusCode).toBe(200);
    expect(saved.json().value.enterpriseName).toBe("示例 小馆 A");
    expect(permissionsRepository.declareEnterpriseIdentity).toHaveBeenCalledWith({
      orgId: "org_a",
      actorId: "admin_a",
      name: "示例 小馆 A",
      expectedVersion: "7"
    });
    permissionsRepository.declareEnterpriseIdentity.mockRejectedValueOnce(
      new Error("AUTHORIZATION_VERSION_CONFLICT")
    );
    expect((await app.inject(request)).statusCode).toBe(409);
  });
});
