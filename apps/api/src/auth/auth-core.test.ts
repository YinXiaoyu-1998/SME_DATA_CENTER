import { describe, expect, it } from "vitest";
import {
  AuthCore,
  type AccessAuthenticationRecord,
  type AuthCoreRepository,
  type LoginIdentityRecord,
  type RotateCredentialResult
} from "./auth-core.js";
import { hashOpaqueSecret } from "./primitives.js";

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
  setupExchangeInput: {
    grantTokenHash: string;
    sessionHash: string;
    expiresAt: Date;
    now: Date;
  } | null = null;
  setupConsumeInput: {
    sessionHash: string;
    passwordHash: string;
    now: Date;
  } | null = null;
  sessionBundleInput: Parameters<AuthCoreRepository["createSessionBundle"]>[0] | null = null;
  transactionInput: Parameters<AuthCoreRepository["createAuthorizationTransaction"]>[0] | null =
    null;
  codeInput: {
    transactionHash: string;
    identityId: string;
    employeeId: string;
    orgId: string;
    codeHash: string;
    codeExpiresAt: Date;
    now: Date;
  } | null = null;
  redemptionInput: Parameters<AuthCoreRepository["redeemAuthorizationCode"]>[0] | null = null;
  rotateResult: RotateCredentialResult = { status: "invalid" };
  authenticationRecord: AccessAuthenticationRecord | null = {
    identityId: "identity-1",
    employeeId: "employee-1",
    orgId: "org-1",
    email: "person@example.com",
    role: "employee",
    labels: ["person:employee-1"],
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

  async consumeAuthorizationTransactionAndCreateCode(input: {
    transactionHash: string;
    identityId: string;
    employeeId: string;
    orgId: string;
    codeHash: string;
    codeExpiresAt: Date;
    now: Date;
  }): Promise<{
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

  async createSessionBundle(
    input: Parameters<AuthCoreRepository["createSessionBundle"]>[0]
  ): Promise<string> {
    this.sessionBundleInput = input;
    return "session-1";
  }

  async rotateDurableCredential(): Promise<RotateCredentialResult> {
    return this.rotateResult;
  }

  async authenticateAccessToken(): Promise<AccessAuthenticationRecord | null> {
    return this.authenticationRecord;
  }

  async revokeSessionByDurableCredential(): Promise<boolean> {
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

    const exchanged = await core.exchangePasswordSetupGrant("eh_ps_raw-grant");

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
      core.consumePasswordSetupSession("eh_ps_setup-session", "correct horse")
    ).resolves.toBe(true);

    expect(repository.setupConsumeInput?.sessionHash).toBe(hashOpaqueSecret("eh_ps_setup-session"));
    expect(JSON.stringify(repository.setupConsumeInput)).not.toContain("correct horse");
  });

  it("uses a dummy hash for unknown email and returns a generic failure", async () => {
    const repository = new MemoryAuthRepository();
    repository.identity = null;
    const core = new AuthCore(repository);

    await expect(core.verifyLogin("missing@example.com", "wrong password")).resolves.toEqual({
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

    await expect(core.verifyLogin("person@example.com", "anything")).resolves.toEqual({
      ok: false,
      reason: "invalid_credentials"
    });
    expect(repository.failureCalls).toBe(0);
  });

  it("clears cooldown state after successful verification", async () => {
    const repository = new MemoryAuthRepository();
    const core = new AuthCore(repository);
    const passwordHash = await core.hashAcceptedPassword("correct horse");
    repository.identity = { ...repository.identity!, passwordHash };

    await expect(core.verifyLogin("person@example.com", "correct horse")).resolves.toEqual({
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
        employeeId: "employee-1"
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

    await core.verifyLogin("person@example.com", "wrong password");

    expect(repository.securityEvents.map((event) => event.type)).toEqual([
      "password_login_failed",
      "password_cooldown_entered"
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

    await expect(core.verifyLogin("person@example.com", "correct horse")).resolves.toEqual({
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
    const session = await core.createSession({
      identityId: "identity-1",
      employeeId: "employee-1",
      orgId: "org-1"
    });

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
    expect(JSON.stringify(repository.sessionBundleInput)).not.toContain(session.durableCredential);
    expect(JSON.stringify(repository.sessionBundleInput)).not.toContain(session.accessToken);
  });

  it("atomically completes the transaction cookie using only server-held OAuth bindings", async () => {
    const repository = new MemoryAuthRepository();
    const core = new AuthCore(repository);

    const completed = await core.completeAuthorizationTransaction("eh_tx_cookie", {
      identityId: "identity-1",
      employeeId: "employee-1",
      orgId: "org-1"
    });

    expect(completed).toEqual({
      codeId: "code-1",
      code: expect.stringMatching(/^eh_ac_/),
      clientId: "enterprise-hub-desktop-launcher",
      redirectUri: "http://127.0.0.1:43123/callback",
      state: "stored-launcher-state",
      expiresAt: expect.any(Date)
    });
    expect(repository.codeInput?.codeHash).toBe(hashOpaqueSecret(completed!.code));
    expect(JSON.stringify(repository.codeInput)).not.toContain(completed!.code);
  });

  it("derives the S256 challenge from the raw verifier during code redemption", async () => {
    const repository = new MemoryAuthRepository();
    const core = new AuthCore(repository);
    const verifier = "raw-pkce-verifier-that-never-reaches-the-repository";

    await core.redeemAuthorizationCode({
      secret: "eh_ac_code",
      clientId: "enterprise-hub-desktop-launcher",
      redirectUri: "http://127.0.0.1:43123/callback",
      verifier
    });

    expect(repository.redemptionInput?.pkceChallenge).toBe(
      createHash("sha256").update(verifier).digest("base64url")
    );
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

    const result = await core.rotateDurableCredential("eh_rt_old");

    expect(result.status).toBe("rotated");
    if (result.status === "rotated") {
      expect(result.durableCredential).toMatch(/^eh_rt_/);
      expect(result.accessToken).toMatch(/^eh_at_/);
    }
  });

  it("writes a credential-free renewal failure for an invalid durable credential", async () => {
    const repository = new MemoryAuthRepository();
    const core = new AuthCore(repository);

    await expect(core.rotateDurableCredential("eh_rt_invalid")).resolves.toEqual({
      status: "invalid"
    });
    expect(repository.securityEvents).toContainEqual(
      expect.objectContaining({
        type: "renewal_failed",
        outcome: "failed",
        reason: "invalid_or_expired_credential"
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
    await expect(core.authenticateAccessToken("eh_at_token")).resolves.toBeNull();

    repository.authenticationRecord = {
      ...repository.authenticationRecord!,
      identityDisabled: false,
      employeeDisabled: true
    };
    await expect(core.authenticateAccessToken("eh_at_token")).resolves.toBeNull();
  });
});
import { createHash } from "node:crypto";
