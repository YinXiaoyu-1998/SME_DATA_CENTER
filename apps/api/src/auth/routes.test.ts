import Fastify from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import { csrfTokenForSecret, pkceChallengeForVerifier } from "./http-contract.js";
import { registerOfficialAuthRoutes } from "./routes.js";
import { registerApiErrorHandler } from "../request-errors.js";

const transactionSecret = "eh_tx_abcdefghijklmnopqrstuvwxyz0123456789";
const setupSecret = "eh_ps_abcdefghijklmnopqrstuvwxyz0123456789";
const verifier = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-._~";
const browserAudit = {
  requestId: "browser_request_1",
  sourceIp: "198.51.100.7",
  launcherVersion: null
};
const oauthAudit = {
  requestId: "oauth_request_1",
  sourceIp: "203.0.113.9",
  launcherVersion: "0.1.0"
};

function authFake() {
  return {
    authenticateAccessToken: vi.fn(),
    issueAuthorizationTransaction: vi.fn(async () => ({
      id: "tx_1",
      secret: transactionSecret,
      expiresAt: new Date(Date.now() + 600_000)
    })),
    verifyLogin: vi.fn(async () => ({
      ok: true as const,
      identityId: "identity_1",
      employeeId: "employee_1",
      orgId: "org_1"
    })),
    completeAuthorizationTransaction: vi.fn(async () => ({
      codeId: "code_1",
      code: "eh_ac_abcdefghijklmnopqrstuvwxyz0123456789",
      clientId: "smedc-desktop-launcher" as const,
      redirectUri: "http://127.0.0.1:43121/oauth/callback",
      state: "abcdefghijklmnop",
      expiresAt: new Date(Date.now() + 60_000)
    })),
    redeemAuthorizationCode: vi.fn(async () => ({
      status: "redeemed" as const,
      identityId: "identity_1",
      employeeId: "employee_1",
      orgId: "org_1"
    })),
    issueDeviceAuthorization: vi.fn(async () => ({
      deviceCode: "eh_dc_devicecode",
      userCode: "ABCDEFGH",
      expiresAt: new Date(Date.now() + 600_000),
      intervalSeconds: 5
    })),
    findDeviceAuthorizationByUserCode: vi.fn(async () => ({
      status: "pending" as const,
      instanceName: "agent-a",
      instanceHostname: "vps-1"
    })),
    completeDeviceAuthorization: vi.fn(async () => true),
    redeemDeviceAuthorization: vi.fn(async () => ({
      status: "redeemed" as const,
      identityId: "identity_1",
      employeeId: "employee_1",
      orgId: "org_1"
    })),
    createSession: vi.fn(async () => ({
      sessionId: "session_1",
      durableCredential: "eh_rt_durable",
      accessToken: "eh_at_access",
      absoluteExpiresAt: new Date(Date.now() + 30 * 86_400_000),
      accessTokenExpiresAt: new Date(Date.now() + 600_000)
    })),
    rotateDurableCredential: vi.fn(async () => ({
      status: "rotated" as const,
      durableCredential: "eh_rt_rotated",
      accessToken: "eh_at_rotated",
      accessTokenExpiresAt: new Date(Date.now() + 600_000)
    })),
    logout: vi.fn(async () => true),
    exchangePasswordSetupGrant: vi.fn(async () => ({
      identityId: "identity_1",
      purpose: "initial_setup" as const,
      sessionSecret: setupSecret,
      expiresAt: new Date(Date.now() + 600_000)
    })),
    consumePasswordSetupSession: vi.fn(async () => true),
    pruneSecurityEvents: vi.fn(async () => 0)
  };
}

const apps: ReturnType<typeof Fastify>[] = [];

async function build() {
  const app = Fastify({ logger: false, requestIdHeader: "x-request-id" });
  const auth = authFake();
  registerApiErrorHandler(app);
  registerOfficialAuthRoutes(app, {
    auth,
    publicOrigin: "https://api.smedatacenter.xyz"
  });
  apps.push(app);
  await app.ready();
  return { app, auth };
}

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

describe("official OAuth and password routes", () => {
  it("publishes fixed discovery metadata without caching", async () => {
    const { app } = await build();
    const response = await app.inject({ url: "/.well-known/oauth-authorization-server" });

    expect(response.statusCode).toBe(200);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.json()).toMatchObject({
      issuer: "https://api.smedatacenter.xyz",
      authorization_endpoint: "https://api.smedatacenter.xyz/oauth/authorize",
      smedc_launcher_package: "smedc-mcp-launcher",
      smedc_launcher_minimum_version: "0.5.0",
      smedc_launcher_recommended_version: "0.5.1"
    });
  });

  it("binds an authorization transaction to a secure host-only cookie", async () => {
    const { app, auth } = await build();
    const response = await app.inject({
      url:
        "/oauth/authorize?response_type=code&client_id=smedc-desktop-launcher" +
        "&redirect_uri=http%3A%2F%2F127.0.0.1%3A43121%2Foauth%2Fcallback" +
        "&state=abcdefghijklmnop&code_challenge=" +
        pkceChallengeForVerifier(verifier) +
        "&code_challenge_method=S256"
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers["set-cookie"]).toContain("__Host-eh_oauth_transaction=eh_tx_");
    expect(response.headers["set-cookie"]).toContain("Secure");
    expect(response.headers["content-security-policy"]).toContain("frame-ancestors 'none'");
    expect(response.headers["content-security-policy"]).toContain(
      "form-action 'self' http://127.0.0.1:*"
    );
    expect(auth.issueAuthorizationTransaction).toHaveBeenCalledWith(
      expect.objectContaining({ redirectUri: "http://127.0.0.1:43121/oauth/callback" })
    );
  });

  it("keeps invalid credentials generic and never redirects", async () => {
    const { app, auth } = await build();
    auth.verifyLogin.mockResolvedValueOnce({
      ok: false,
      reason: "invalid_credentials"
    } as never);

    const response = await app.inject({
      method: "POST",
      url: "/oauth/authorize/login",
      headers: {
        cookie: `__Host-eh_oauth_transaction=${transactionSecret}`,
        "content-type": "application/x-www-form-urlencoded",
        "x-request-id": browserAudit.requestId
      },
      remoteAddress: browserAudit.sourceIp,
      payload: new URLSearchParams({
        csrfToken: csrfTokenForSecret(transactionSecret),
        email: "unknown@example.com",
        password: "wrong password"
      }).toString()
    });

    expect(response.statusCode).toBe(401);
    expect(response.body).toContain("The email or password is incorrect.");
    expect(response.headers.location).toBeUndefined();
    expect(auth.verifyLogin).toHaveBeenCalledWith(
      "unknown@example.com",
      "wrong password",
      browserAudit
    );
  });

  it("passes browser request metadata through successful login and authorization completion", async () => {
    const { app, auth } = await build();

    const response = await app.inject({
      method: "POST",
      url: "/oauth/authorize/login",
      headers: {
        cookie: `__Host-eh_oauth_transaction=${transactionSecret}`,
        "content-type": "application/x-www-form-urlencoded",
        "x-request-id": browserAudit.requestId
      },
      remoteAddress: browserAudit.sourceIp,
      payload: new URLSearchParams({
        csrfToken: csrfTokenForSecret(transactionSecret),
        email: "person@example.com",
        password: "correct horse"
      }).toString()
    });

    expect(response.statusCode).toBe(303);
    expect(auth.verifyLogin).toHaveBeenCalledWith(
      "person@example.com",
      "correct horse",
      browserAudit
    );
    expect(auth.completeAuthorizationTransaction).toHaveBeenCalledWith(
      transactionSecret,
      expect.objectContaining({ identityId: "identity_1" }),
      browserAudit
    );
  });

  it("redeems a code and returns only standard token response fields", async () => {
    const { app, auth } = await build();
    const response = await app.inject({
      method: "POST",
      url: "/oauth/token",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        "x-smedc-launcher-version": "0.1.0",
        "x-request-id": oauthAudit.requestId
      },
      remoteAddress: oauthAudit.sourceIp,
      payload: new URLSearchParams({
        grant_type: "authorization_code",
        client_id: "smedc-desktop-launcher",
        code: "eh_ac_code",
        redirect_uri: "http://127.0.0.1:43121/oauth/callback",
        code_verifier: verifier
      }).toString()
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      access_token: "eh_at_access",
      token_type: "Bearer",
      expires_in: 600,
      refresh_token: "eh_rt_durable"
    });
    expect(auth.redeemAuthorizationCode).toHaveBeenCalledWith(
      expect.objectContaining({ verifier }),
      oauthAudit
    );
    expect(auth.createSession).toHaveBeenCalledWith(
      expect.objectContaining({ identityId: "identity_1" }),
      oauthAudit
    );
  });

  it("passes normalized OAuth request metadata through refresh rotation", async () => {
    const { app, auth } = await build();

    const response = await app.inject({
      method: "POST",
      url: "/oauth/token",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        "x-smedc-launcher-version": "0.1.0",
        "x-request-id": oauthAudit.requestId
      },
      remoteAddress: oauthAudit.sourceIp,
      payload: new URLSearchParams({
        grant_type: "refresh_token",
        client_id: "smedc-desktop-launcher",
        refresh_token: "eh_rt_old"
      }).toString()
    });

    expect(response.statusCode).toBe(200);
    expect(auth.rotateDurableCredential).toHaveBeenCalledWith("eh_rt_old", oauthAudit);
  });

  it("passes observable OAuth request metadata into revoke and logout", async () => {
    const { app, auth } = await build();

    const response = await app.inject({
      method: "POST",
      url: "/oauth/revoke",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        "x-smedc-launcher-version": "0.1.0",
        "x-request-id": oauthAudit.requestId
      },
      remoteAddress: oauthAudit.sourceIp,
      payload: "token=eh_rt_old"
    });

    expect(response.statusCode).toBe(200);
    expect(auth.logout).toHaveBeenCalledWith("eh_rt_old", oauthAudit);
  });

  it("rejects missing or obsolete launcher versions with a stable upgrade code", async () => {
    const { app } = await build();
    const response = await app.inject({
      method: "POST",
      url: "/oauth/token",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      payload: new URLSearchParams({
        grant_type: "refresh_token",
        client_id: "smedc-desktop-launcher",
        refresh_token: "eh_rt_old"
      }).toString()
    });

    expect(response.statusCode).toBe(426);
    expect(response.json()).toMatchObject({ code: "LAUNCHER_UPGRADE_REQUIRED" });
  });

  it("exchanges a fragment-derived setup token for an HttpOnly setup cookie", async () => {
    const { app, auth } = await build();
    const bootstrap = await app.inject({ url: "/auth/password/setup#token=never-sent" });
    expect(bootstrap.statusCode).toBe(200);
    expect(bootstrap.body).not.toContain("never-sent");

    const response = await app.inject({
      method: "POST",
      url: "/auth/password/setup/session",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        "x-request-id": browserAudit.requestId
      },
      remoteAddress: browserAudit.sourceIp,
      payload: "token=eh_ps_grant"
    });

    expect(response.statusCode).toBe(303);
    expect(response.headers.location).toBe("/auth/password/setup/form");
    expect(response.headers["set-cookie"]).toContain("__Host-eh_password_setup=eh_ps_");
    expect(response.headers["set-cookie"]).toContain("HttpOnly");
    expect(auth.exchangePasswordSetupGrant).toHaveBeenCalledWith("eh_ps_grant", browserAudit);
  });

  it("sets a password only with matching confirmation and CSRF", async () => {
    const { app, auth } = await build();
    const response = await app.inject({
      method: "POST",
      url: "/auth/password/setup/complete",
      headers: {
        cookie: `__Host-eh_password_setup=${setupSecret}`,
        "content-type": "application/x-www-form-urlencoded",
        "x-request-id": browserAudit.requestId
      },
      remoteAddress: browserAudit.sourceIp,
      payload: new URLSearchParams({
        csrfToken: csrfTokenForSecret(setupSecret),
        password: "a secure beta password",
        passwordConfirmation: "a secure beta password"
      }).toString()
    });

    expect(response.statusCode).toBe(200);
    expect(response.body).toContain("Password saved");
    expect(auth.consumePasswordSetupSession).toHaveBeenCalledWith(
      setupSecret,
      "a secure beta password",
      browserAudit
    );
    expect(response.headers["set-cookie"]).toContain("Max-Age=0");
  });

  it("does not expose unexpected password setup repository failures", async () => {
    const { app, auth } = await build();
    auth.consumePasswordSetupSession.mockRejectedValueOnce(
      new Error("provider detail: private-auth-db.internal")
    );

    const response = await app.inject({
      method: "POST",
      url: "/auth/password/setup/complete",
      headers: {
        cookie: `__Host-eh_password_setup=${setupSecret}`,
        "content-type": "application/x-www-form-urlencoded"
      },
      payload: new URLSearchParams({
        csrfToken: csrfTokenForSecret(setupSecret),
        password: "a secure beta password",
        passwordConfirmation: "a secure beta password"
      }).toString()
    });

    expect(response.statusCode).toBe(500);
    expect(response.json()).toEqual({
      error: {
        code: "INTERNAL_ERROR",
        message: "Internal server error.",
        requestId: expect.any(String)
      }
    });
    expect(response.body).not.toContain("private-auth-db.internal");
  });
});

describe("device authorization endpoints", () => {
  const launcherHeaders = {
    "content-type": "application/x-www-form-urlencoded",
    "x-smedc-launcher-version": "0.1.0",
    "x-request-id": oauthAudit.requestId
  };

  it("issues a device authorization and returns the tap-link contract", async () => {
    const { app, auth } = await build();

    const response = await app.inject({
      method: "POST",
      url: "/oauth/device_authorization",
      headers: launcherHeaders,
      remoteAddress: oauthAudit.sourceIp,
      payload: new URLSearchParams({
        client_id: "smedc-desktop-launcher",
        instanceName: "agent-a",
        instanceHostname: "vps-1"
      }).toString()
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.json()).toMatchObject({
      device_code: "eh_dc_devicecode",
      user_code: "ABCDEFGH",
      verification_uri: "https://api.smedatacenter.xyz/oauth/device/verify",
      verification_uri_complete:
        "https://api.smedatacenter.xyz/oauth/device/verify?user_code=ABCDEFGH",
      expires_in: 600,
      interval: 5
    });
    expect(auth.issueDeviceAuthorization).toHaveBeenCalledWith({
      clientId: "smedc-desktop-launcher",
      instanceName: "agent-a",
      instanceHostname: "vps-1",
      audit: oauthAudit
    });
  });

  it("rejects device authorization requests without a supported launcher version", async () => {
    const { app } = await build();

    const response = await app.inject({
      method: "POST",
      url: "/oauth/device_authorization",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      payload: new URLSearchParams({ client_id: "smedc-desktop-launcher" }).toString()
    });

    expect(response.statusCode).toBe(426);
    expect(response.json()).toMatchObject({ code: "LAUNCHER_UPGRADE_REQUIRED" });
  });

  it("rejects device authorization requests from an unknown client or missing instance identity", async () => {
    const { app } = await build();

    const response = await app.inject({
      method: "POST",
      url: "/oauth/device_authorization",
      headers: launcherHeaders,
      payload: new URLSearchParams({ client_id: "not-our-client" }).toString()
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: "invalid_request" });
  });

  it("renders the mobile verification page with pairing details and a secure cookie", async () => {
    const { app } = await build();

    const response = await app.inject({
      url: "/oauth/device/verify?user_code=ABCDEFGH",
      headers: { "x-request-id": browserAudit.requestId },
      remoteAddress: browserAudit.sourceIp
    });

    expect(response.statusCode).toBe(200);
    expect(response.body).toContain("agent-a");
    expect(response.body).toContain("vps-1");
    expect(response.body).toContain('action="/oauth/device/verify/login"');
    expect(response.headers["set-cookie"]).toContain("__Host-eh_device_verify=");
  });

  it("rejects malformed verification links", async () => {
    const { app } = await build();

    const response = await app.inject({ url: "/oauth/device/verify?user_code=bad" });

    expect(response.statusCode).toBe(400);
    expect(response.body).toContain("Sign-in link invalid");
  });

  it("completes a device login with the verified identity", async () => {
    const { app, auth } = await build();
    const page = await app.inject({
      url: "/oauth/device/verify?user_code=ABCDEFGH",
      headers: { "x-request-id": browserAudit.requestId }
    });
    const cookieHeader = page.headers["set-cookie"] as string;
    const verifySecret = /__Host-eh_device_verify=([^;]+)/.exec(cookieHeader)?.[1] ?? "";

    const response = await app.inject({
      method: "POST",
      url: "/oauth/device/verify/login",
      headers: {
        cookie: `__Host-eh_device_verify=${verifySecret}`,
        "content-type": "application/x-www-form-urlencoded",
        "x-request-id": browserAudit.requestId
      },
      remoteAddress: browserAudit.sourceIp,
      payload: new URLSearchParams({
        csrfToken: csrfTokenForSecret(verifySecret),
        userCode: "ABCDEFGH",
        email: "person@example.com",
        password: "correct horse"
      }).toString()
    });

    expect(response.statusCode).toBe(200);
    expect(response.body).toContain("Sign-in complete");
    expect(auth.verifyLogin).toHaveBeenCalledWith(
      "person@example.com",
      "correct horse",
      browserAudit
    );
    expect(auth.completeDeviceAuthorization).toHaveBeenCalledWith(
      "ABCDEFGH",
      { identityId: "identity_1", employeeId: "employee_1", orgId: "org_1" },
      browserAudit
    );
  });

  it("re-renders the verification page with a generic error on failed credentials", async () => {
    const { app, auth } = await build();
    auth.verifyLogin.mockResolvedValueOnce({
      ok: false,
      reason: "invalid_credentials"
    } as never);
    const page = await app.inject({ url: "/oauth/device/verify?user_code=ABCDEFGH" });
    const verifySecret =
      /__Host-eh_device_verify=([^;]+)/.exec(page.headers["set-cookie"] as string)?.[1] ?? "";

    const response = await app.inject({
      method: "POST",
      url: "/oauth/device/verify/login",
      headers: {
        cookie: `__Host-eh_device_verify=${verifySecret}`,
        "content-type": "application/x-www-form-urlencoded"
      },
      payload: new URLSearchParams({
        csrfToken: csrfTokenForSecret(verifySecret),
        userCode: "ABCDEFGH",
        email: "person@example.com",
        password: "wrong password"
      }).toString()
    });

    expect(response.statusCode).toBe(401);
    expect(response.body).toContain("The email or password is incorrect.");
    expect(auth.completeDeviceAuthorization).not.toHaveBeenCalled();
  });

  it("exchanges a redeemed device code for tokens", async () => {
    const { app } = await build();

    const response = await app.inject({
      method: "POST",
      url: "/oauth/token",
      headers: launcherHeaders,
      payload: new URLSearchParams({
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
        client_id: "smedc-desktop-launcher",
        device_code: "eh_dc_devicecode"
      }).toString()
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      access_token: "eh_at_access",
      token_type: "Bearer",
      refresh_token: "eh_rt_durable"
    });
  });

  it("returns authorization_pending while the employee has not completed the link", async () => {
    const { app, auth } = await build();
    auth.redeemDeviceAuthorization.mockResolvedValueOnce({
      status: "authorization_pending"
    } as never);

    const response = await app.inject({
      method: "POST",
      url: "/oauth/token",
      headers: launcherHeaders,
      payload: new URLSearchParams({
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
        client_id: "smedc-desktop-launcher",
        device_code: "eh_dc_devicecode"
      }).toString()
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: "authorization_pending" });
  });

  it("returns expired_token when the device code has expired", async () => {
    const { app, auth } = await build();
    auth.redeemDeviceAuthorization.mockResolvedValueOnce({ status: "expired" } as never);

    const response = await app.inject({
      method: "POST",
      url: "/oauth/token",
      headers: launcherHeaders,
      payload: new URLSearchParams({
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
        client_id: "smedc-desktop-launcher",
        device_code: "eh_dc_devicecode"
      }).toString()
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: "expired_token" });
  });
});
