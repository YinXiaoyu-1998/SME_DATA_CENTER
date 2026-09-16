import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  AuthCore,
  type AccessAuthenticationRecord,
  type AuthCoreRepository,
  type DeviceCodeRedemption,
  type LoginIdentityRecord,
  type RotateCredentialResult
} from "./auth-core.js";
import { hashOpaqueSecret } from "./primitives.js";

const browserAudit = {
  requestId: "browser_request_1",
  sourceIp: "198.51.100.7",
  launcherVersion: null
};
const browserEventAudit = { ...browserAudit, launcherVersion: undefined };
const oauthAudit = {
  requestId: "oauth_request_1",
  sourceIp: "203.0.113.9",
  launcherVersion: "0.1.0"
};

class MemoryAuthRepository implements AuthCoreRepository {
  identity: LoginIdentityRecord | null = {
    id: "identity-1",
    orgId: "org-1",
    employeeId: "employee-1",
    passwordHash: null,
    disabled: false,
    employeeDisabled: false,
    failedAttemptCount: 0,
    cooldownLevel: 0,
    cooldownUntil: null
  };
  setupGrantInput: Parameters<AuthCoreRepository["replacePasswordSetupGrant"]>[0] | null = null;
  setupExchangeInput: Parameters<AuthCoreRepository["exchangePasswordSetupGrant"]>[0] | null = null;
  setupConsumeInput: Parameters<AuthCoreRepository["consumePasswordSetupSession"]>[0] | null = null;
  sessionBundleInput: Parameters<AuthCoreRepository["createSessionBundle"]>[0] | null = null;
  transactionInput: Parameters<AuthCoreRepository["createAuthorizationTransaction"]>[0] | null =
    null;
  codeInput:
    Parameters<AuthCoreRepository["consumeAuthorizationTransactionAndCreateCode"]>[0] | null = null;
  redemptionInput: Parameters<AuthCoreRepository["redeemAuthorizationCode"]>[0] | null = null;
  deviceIssueInput: Parameters<AuthCoreRepository["createDeviceAuthorization"]>[0] | null = null;
  deviceLookupInput: Parameters<AuthCoreRepository["findDeviceAuthorizationByUserCode"]>[0] | null =
    null;
  deviceCompleteInput: Parameters<AuthCoreRepository["completeDeviceAuthorization"]>[0] | null =
    null;
  deviceRedeemInput: Parameters<AuthCoreRepository["redeemDeviceAuthorization"]>[0] | null = null;
  deviceRecord: {
    status: "pending" | "completed" | "expired" | "revoked";
    instanceName: string;
    instanceHostname: string;
  } | null = { status: "pending", instanceName: "agent-a", instanceHostname: "vps-1" };
  deviceRedeemResult: DeviceCodeRedemption = { status: "authorization_pending" };
  rotateResult: RotateCredentialResult = { status: "invalid" };
  rotateInput: unknown = null;
  authenticationInput: unknown = null;
  logoutInput: unknown = null;
  authenticationRecord: AccessAuthenticationRecord | null = {
    identityId: "identity-1",
    employeeId: "employee-1",
    orgId: "org-1",
    organizationName: "示例餐饮管理有限公司",
    displayName: "Test Person",
    email: "person@example.com",
    role: "employee",
    clearance: 3,
    identityDisabled: false,
    employeeDisabled: false
  };
  resetCalls = 0;
  failureCalls = 0;
  failureCooldownUntil: Date | null = null;
  securityEvents: Array<Parameters<AuthCoreRepository["writeSecurityEvent"]>[0]> = [];

  async findLoginIdentityByEmail(): Promise<LoginIdentityRecord | null> {
    return this.identity;
  }

  async recordLoginFailure(): Promise<{ cooldownUntil: Date | null }> {
    this.failureCalls += 1;
    return { cooldownUntil: this.failureCooldownUntil };
  }

  async resetLoginFailures(): Promise<void> {
    this.resetCalls += 1;
  }

  async replacePasswordSetupGrant(
    input: Parameters<AuthCoreRepository["replacePasswordSetupGrant"]>[0]
  ): Promise<string> {
    this.setupGrantInput = input;
    return "grant-1";
  }

  async exchangePasswordSetupGrant(
    input: NonNullable<MemoryAuthRepository["setupExchangeInput"]>
  ): Promise<{
    identityId: string;
    purpose: "initial_setup" | "password_reset";
  } | null> {
    this.setupExchangeInput = input;
    return { identityId: "identity-1", purpose: "password_reset" };
  }

  async consumePasswordSetupSession(
    input: NonNullable<MemoryAuthRepository["setupConsumeInput"]>
  ): Promise<boolean> {
    this.setupConsumeInput = input;
    return true;
  }

  async createAuthorizationTransaction(
    input: Parameters<AuthCoreRepository["createAuthorizationTransaction"]>[0]
  ): Promise<string> {
    this.transactionInput = input;
    return "transaction-1";
  }

  async consumeAuthorizationTransactionAndCreateCode(
    input: Parameters<AuthCoreRepository["consumeAuthorizationTransactionAndCreateCode"]>[0]
  ): Promise<{
    codeId: string;
    clientId: string;
    redirectUri: string;
    state: string;
  } | null> {
    this.codeInput = input;
    return {
      codeId: "code-1",
      clientId: "enterprise-hub-desktop-launcher",
      redirectUri: "http://127.0.0.1:43123/callback",
      state: "stored-launcher-state"
    };
  }

  async redeemAuthorizationCode(
    input: Parameters<AuthCoreRepository["redeemAuthorizationCode"]>[0]
  ): Promise<{
    status: "redeemed";
    identityId: string;
    employeeId: string;
    orgId: string;
  }> {
    this.redemptionInput = input;
    return {
      status: "redeemed",
      identityId: "identity-1",
      employeeId: "employee-1",
      orgId: "org-1"
    };
  }

  async createDeviceAuthorization(
    input: Parameters<AuthCoreRepository["createDeviceAuthorization"]>[0]
  ): Promise<void> {
    this.deviceIssueInput = input;
  }

  async findDeviceAuthorizationByUserCode(
    input: Parameters<AuthCoreRepository["findDeviceAuthorizationByUserCode"]>[0]
  ): Promise<{
    status: "pending" | "completed" | "expired" | "revoked";
    instanceName: string;
    instanceHostname: string;
  } | null> {
    this.deviceLookupInput = input;
    return this.deviceRecord ? { ...this.deviceRecord } : null;
  }

  async completeDeviceAuthorization(
    input: Parameters<AuthCoreRepository["completeDeviceAuthorization"]>[0]
  ): Promise<boolean> {
    this.deviceCompleteInput = input;
    return this.deviceRecord?.status === "pending";
  }

  async redeemDeviceAuthorization(
    input: Parameters<AuthCoreRepository["redeemDeviceAuthorization"]>[0]
  ): Promise<DeviceCodeRedemption> {
    this.deviceRedeemInput = input;
    return this.deviceRedeemResult;
  }

  async createSessionBundle(
    input: Parameters<AuthCoreRepository["createSessionBundle"]>[0]
  ): Promise<string> {
    this.sessionBundleInput = input;
    return "session-1";
  }

  async rotateDurableCredential(...input: unknown[]): Promise<RotateCredentialResult> {
    this.rotateInput = input;
    return this.rotateResult;
  }

  async authenticateAccessToken(...input: unknown[]): Promise<AccessAuthenticationRecord | null> {
    this.authenticationInput = input;
    return this.authenticationRecord;
  }

  async revokeSessionByDurableCredential(...input: unknown[]): Promise<boolean> {
    this.logoutInput = input;
    return true;
  }

  async revokeIdentitySessions(): Promise<number> {
    return 1;
  }

  async writeSecurityEvent(
    event: Parameters<AuthCoreRepository["writeSecurityEvent"]>[0]
  ): Promise<void> {
    this.securityEvents.push(event);
  }

  async pruneSecurityEvents(): Promise<number> {
    return 0;
  }
}

describe("AuthCore", () => {
  it("persists only the hash when issuing a setup grant", async () => {
    const repository = new MemoryAuthRepository();
    const core = new AuthCore(repository);

    const issued = await core.issuePasswordSetupGrant("identity-1", "password_reset");

    expect(issued.secret).toMatch(/^eh_ps_/);
    expect(repository.setupGrantInput?.tokenHash).toBe(hashOpaqueSecret(issued.secret));
    expect(JSON.stringify(repository.setupGrantInput)).not.toContain(issued.secret);
  });

  it("exchanges a raw setup grant for a hash-only ten-minute setup session", async () => {
    const repository = new MemoryAuthRepository();
    const core = new AuthCore(repository);

    const exchanged = await core.exchangePasswordSetupGrant("eh_ps_raw-grant", browserAudit);

    expect(exchanged?.sessionSecret).toMatch(/^eh_ps_/);
    expect(exchanged?.purpose).toBe("password_reset");
    expect(repository.setupExchangeInput?.grantTokenHash).toBe(hashOpaqueSecret("eh_ps_raw-grant"));
    expect(repository.setupExchangeInput?.sessionHash).toBe(
      hashOpaqueSecret(exchanged!.sessionSecret)
    );
    expect(JSON.stringify(repository.setupExchangeInput)).not.toContain(exchanged!.sessionSecret);
    expect(
      repository.setupExchangeInput!.expiresAt.getTime() -
        repository.setupExchangeInput!.now.getTime()
    ).toBe(10 * 60_000);
  });

  it("consumes the setup session cookie rather than the raw grant on password completion", async () => {
    const repository = new MemoryAuthRepository();
    const core = new AuthCore(repository);

    await expect(
      core.consumePasswordSetupSession("eh_ps_setup-session", "correct horse", browserAudit)
    ).resolves.toBe(true);

    expect(repository.setupConsumeInput?.sessionHash).toBe(hashOpaqueSecret("eh_ps_setup-session"));
    expect(repository.setupConsumeInput).toMatchObject({ audit: browserAudit });
    expect(JSON.stringify(repository.setupConsumeInput)).not.toContain("correct horse");
  });

  it("uses a dummy hash for unknown email and returns a generic failure", async () => {
    const repository = new MemoryAuthRepository();
    repository.identity = null;
    const core = new AuthCore(repository);

    await expect(
      core.verifyLogin("missing@example.com", "wrong password", browserAudit)
    ).resolves.toEqual({
      ok: false,
      reason: "invalid_credentials"
    });
    expect(repository.failureCalls).toBe(0);
  });

  it("does not increment or extend attempts during cooldown", async () => {
    const repository = new MemoryAuthRepository();
    repository.identity = {
      ...repository.identity!,
      cooldownUntil: new Date(Date.now() + 60_000),
      failedAttemptCount: 5,
      cooldownLevel: 1
    };
    const core = new AuthCore(repository);

    await expect(core.verifyLogin("person@example.com", "anything", browserAudit)).resolves.toEqual(
      {
        ok: false,
        reason: "invalid_credentials"
      }
    );
    expect(repository.failureCalls).toBe(0);
  });

  it("clears cooldown state after successful verification", async () => {
    const repository = new MemoryAuthRepository();
    const core = new AuthCore(repository);
    const passwordHash = await core.hashAcceptedPassword("correct horse");
    repository.identity = { ...repository.identity!, passwordHash };

    await expect(
      core.verifyLogin("person@example.com", "correct horse", browserAudit)
    ).resolves.toEqual({
      ok: true,
      identityId: "identity-1",
      employeeId: "employee-1",
      orgId: "org-1"
    });
    expect(repository.resetCalls).toBe(1);
    expect(repository.securityEvents).toContainEqual(
      expect.objectContaining({
        type: "password_login_succeeded",
        outcome: "succeeded",
        identityId: "identity-1",
        employeeId: "employee-1",
        ...browserEventAudit
      })
    );
  });

  it("writes credential-free login failure and cooldown-entry events", async () => {
    const repository = new MemoryAuthRepository();
    const core = new AuthCore(repository);
    repository.identity = {
      ...repository.identity!,
      passwordHash: await core.hashAcceptedPassword("correct horse")
    };
    repository.failureCooldownUntil = new Date(Date.now() + 300_000);

    await core.verifyLogin("person@example.com", "wrong password", browserAudit);

    expect(repository.securityEvents.map((event) => event.type)).toEqual([
      "password_login_failed",
      "password_cooldown_entered"
    ]);
    expect(repository.securityEvents).toEqual([
      expect.objectContaining(browserEventAudit),
      expect.objectContaining(browserEventAudit)
    ]);
    expect(JSON.stringify(repository.securityEvents)).not.toContain("wrong password");
  });

  it("returns the same generic login failure for a disabled Employee Account", async () => {
    const repository = new MemoryAuthRepository();
    const core = new AuthCore(repository);
    const passwordHash = await core.hashAcceptedPassword("correct horse");
    repository.identity = {
      ...repository.identity!,
      passwordHash,
      employeeDisabled: true
    };

    await expect(
      core.verifyLogin("person@example.com", "correct horse", browserAudit)
    ).resolves.toEqual({
      ok: false,
      reason: "invalid_credentials"
    });
    expect(repository.resetCalls).toBe(0);
  });

  it("issues transaction, access, and durable secrets without persisting plaintext", async () => {
    const repository = new MemoryAuthRepository();
    const core = new AuthCore(repository);

    const transaction = await core.issueAuthorizationTransaction({
      clientId: "enterprise-hub-desktop-launcher",
      redirectUri: "http://127.0.0.1:43123/callback",
      state: "launcher-state",
      pkceChallenge: "challenge"
    });
    const session = await core.createSession(
      {
        identityId: "identity-1",
        employeeId: "employee-1",
        orgId: "org-1"
      },
      oauthAudit
    );

    expect(transaction.secret).toMatch(/^eh_tx_/);
    expect(session.durableCredential).toMatch(/^eh_rt_/);
    expect(session.accessToken).toMatch(/^eh_at_/);
    expect(JSON.stringify(repository.transactionInput)).not.toContain(transaction.secret);
    expect(repository.sessionBundleInput?.credentialHash).toBe(
      hashOpaqueSecret(session.durableCredential)
    );
    expect(repository.sessionBundleInput?.accessTokenHash).toBe(
      hashOpaqueSecret(session.accessToken)
    );
    expect(repository.sessionBundleInput).toMatchObject({ audit: oauthAudit });
    expect(JSON.stringify(repository.sessionBundleInput)).not.toContain(session.durableCredential);
    expect(JSON.stringify(repository.sessionBundleInput)).not.toContain(session.accessToken);
  });

  it("atomically completes the transaction cookie using only server-held OAuth bindings", async () => {
    const repository = new MemoryAuthRepository();
    const core = new AuthCore(repository);

    const completed = await core.completeAuthorizationTransaction(
      "eh_tx_cookie",
      {
        identityId: "identity-1",
        employeeId: "employee-1",
        orgId: "org-1"
      },
      browserAudit
    );

    expect(completed).toEqual({
      codeId: "code-1",
      code: expect.stringMatching(/^eh_ac_/),
      clientId: "enterprise-hub-desktop-launcher",
      redirectUri: "http://127.0.0.1:43123/callback",
      state: "stored-launcher-state",
      expiresAt: expect.any(Date)
    });
    expect(repository.codeInput?.codeHash).toBe(hashOpaqueSecret(completed!.code));
    expect(repository.codeInput).toMatchObject({ audit: browserAudit });
    expect(JSON.stringify(repository.codeInput)).not.toContain(completed!.code);
  });

  it("derives the S256 challenge from the raw verifier during code redemption", async () => {
    const repository = new MemoryAuthRepository();
    const core = new AuthCore(repository);
    const verifier = "raw-pkce-verifier-that-never-reaches-the-repository";

    await core.redeemAuthorizationCode(
      {
        secret: "eh_ac_code",
        clientId: "enterprise-hub-desktop-launcher",
        redirectUri: "http://127.0.0.1:43123/callback",
        verifier
      },
      oauthAudit
    );

    expect(repository.redemptionInput?.pkceChallenge).toBe(
      createHash("sha256").update(verifier).digest("base64url")
    );
    expect(repository.redemptionInput).toMatchObject({ audit: oauthAudit });
    expect(JSON.stringify(repository.redemptionInput)).not.toContain(verifier);
  });

  it("returns rotated credentials only after atomic repository rotation", async () => {
    const repository = new MemoryAuthRepository();
    repository.rotateResult = {
      status: "rotated",
      sessionId: "session-1",
      identityId: "identity-1",
      employeeId: "employee-1",
      orgId: "org-1"
    };
    const core = new AuthCore(repository);

    const result = await core.rotateDurableCredential("eh_rt_old", oauthAudit);

    expect(result.status).toBe("rotated");
    if (result.status === "rotated") {
      expect(result.durableCredential).toMatch(/^eh_rt_/);
      expect(result.accessToken).toMatch(/^eh_at_/);
    }
    expect(repository.rotateInput).toEqual([
      expect.objectContaining({
        presentedCredentialHash: hashOpaqueSecret("eh_rt_old"),
        audit: oauthAudit
      })
    ]);
  });

  it("writes a credential-free renewal failure for an invalid durable credential", async () => {
    const repository = new MemoryAuthRepository();
    const core = new AuthCore(repository);

    await expect(core.rotateDurableCredential("eh_rt_invalid", oauthAudit)).resolves.toEqual({
      status: "invalid"
    });
    expect(repository.securityEvents).toContainEqual(
      expect.objectContaining({
        type: "renewal_failed",
        outcome: "failed",
        reason: "invalid_or_expired_credential",
        ...oauthAudit
      })
    );
    expect(JSON.stringify(repository.securityEvents)).not.toContain("eh_rt_invalid");
  });

  it("rejects access when either identity or employee is disabled", async () => {
    const repository = new MemoryAuthRepository();
    const core = new AuthCore(repository);

    repository.authenticationRecord = {
      ...repository.authenticationRecord!,
      identityDisabled: true
    };
    await expect(core.authenticateAccessToken("eh_at_token", oauthAudit)).resolves.toBeNull();

    repository.authenticationRecord = {
      ...repository.authenticationRecord!,
      identityDisabled: false,
      employeeDisabled: true
    };
    await expect(core.authenticateAccessToken("eh_at_token", oauthAudit)).resolves.toBeNull();
  });

  it("returns the authenticated employee display name for self-profile consumers", async () => {
    const repository = new MemoryAuthRepository();
    const core = new AuthCore(repository);

    await expect(core.authenticateAccessToken("eh_at_token", oauthAudit)).resolves.toEqual({
      id: "employee-1",
      orgId: "org-1",
      organizationName: "示例餐饮管理有限公司",
      displayName: "Test Person",
      email: "person@example.com",
      role: "employee",
      disabled: false,
      clearance: 3
    });
  });

  it("passes route-derived audit metadata into access-token authentication", async () => {
    const repository = new MemoryAuthRepository();
    const core = new AuthCore(repository);

    await core.authenticateAccessToken("eh_at_token", oauthAudit);

    expect(repository.authenticationInput).toEqual([
      hashOpaqueSecret("eh_at_token"),
      expect.any(Date),
      oauthAudit
    ]);
  });

  it("passes OAuth request metadata into logout events", async () => {
    const repository = new MemoryAuthRepository();
    const core = new AuthCore(repository);

    await core.logout("eh_rt_token", oauthAudit);

    expect(repository.logoutInput).toEqual([
      hashOpaqueSecret("eh_rt_token"),
      "logout",
      expect.any(Date),
      oauthAudit
    ]);
  });
});

describe("device authorization flow", () => {
  it("issues a device authorization that stores only hashes and returns plaintext once", async () => {
    const repository = new MemoryAuthRepository();
    const now = new Date("2026-08-07T00:00:00.000Z");
    const core = new AuthCore(repository, () => now);

    const issued = await core.issueDeviceAuthorization({
      clientId: "enterprise-hub-desktop-launcher",
      instanceName: "agent-a",
      instanceHostname: "vps-1",
      audit: oauthAudit
    });

    expect(issued.userCode).toMatch(/^[A-HJ-NP-Z2-9]{8}$/);
    expect(issued.expiresAt.getTime()).toBe(now.getTime() + 10 * 60_000);
    expect(issued.intervalSeconds).toBe(5);
    expect(repository.deviceIssueInput?.deviceCodeHash).toBe(hashOpaqueSecret(issued.deviceCode));
    expect(repository.deviceIssueInput?.userCodeHash).toBe(hashOpaqueSecret(issued.userCode));
    expect(repository.deviceIssueInput).toMatchObject({
      clientId: "enterprise-hub-desktop-launcher",
      instanceName: "agent-a",
      instanceHostname: "vps-1",
      audit: oauthAudit,
      now
    });
    expect(repository.deviceIssueInput?.expiresAt.getTime()).toBe(now.getTime() + 10 * 60_000);
  });

  it("completes a pending device authorization with the verified identity", async () => {
    const repository = new MemoryAuthRepository();
    const core = new AuthCore(repository);

    const completed = await core.completeDeviceAuthorization(
      "ABCDEFGH",
      { identityId: "identity-1", employeeId: "employee-1", orgId: "org-1" },
      browserAudit
    );

    expect(completed).toBe(true);
    expect(repository.deviceCompleteInput?.userCodeHash).toBe(hashOpaqueSecret("ABCDEFGH"));
    expect(repository.deviceCompleteInput).toMatchObject({
      identityId: "identity-1",
      employeeId: "employee-1",
      orgId: "org-1",
      audit: browserAudit
    });
  });

  it("looks up a pending device authorization by user-code hash", async () => {
    const repository = new MemoryAuthRepository();
    const core = new AuthCore(repository);

    const found = await core.findDeviceAuthorizationByUserCode("ABCDEFGH");

    expect(repository.deviceLookupInput?.userCodeHash).toBe(hashOpaqueSecret("ABCDEFGH"));
    expect(found).toMatchObject({
      status: "pending",
      instanceName: "agent-a",
      instanceHostname: "vps-1"
    });
  });

  it("redeems a completed device code and passes the launcher audit", async () => {
    const repository = new MemoryAuthRepository();
    const core = new AuthCore(repository);
    repository.deviceRedeemResult = {
      status: "redeemed",
      identityId: "identity-1",
      employeeId: "employee-1",
      orgId: "org-1"
    };

    const result = await core.redeemDeviceAuthorization(
      "eh_dc_secret",
      "enterprise-hub-desktop-launcher",
      oauthAudit
    );

    expect(result).toEqual({
      status: "redeemed",
      identityId: "identity-1",
      employeeId: "employee-1",
      orgId: "org-1"
    });
    expect(repository.deviceRedeemInput?.deviceCodeHash).toBe(hashOpaqueSecret("eh_dc_secret"));
    expect(repository.deviceRedeemInput?.clientId).toBe("enterprise-hub-desktop-launcher");
    expect(repository.deviceRedeemInput?.audit).toEqual(oauthAudit);
  });

  it("reports authorization_pending while the employee has not completed the link", async () => {
    const repository = new MemoryAuthRepository();
    const core = new AuthCore(repository);
    repository.deviceRedeemResult = { status: "authorization_pending" };

    await expect(
      core.redeemDeviceAuthorization("eh_dc_secret", "enterprise-hub-desktop-launcher", oauthAudit)
    ).resolves.toEqual({ status: "authorization_pending" });
  });
});
