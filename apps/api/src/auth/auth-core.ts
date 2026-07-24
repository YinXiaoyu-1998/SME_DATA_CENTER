import type { AuthenticatedEmployee, EmployeeRoleName } from "@enterprise-hub/domain";
import {
  AUTH_LIFETIMES_MS,
  derivePkceS256Challenge,
  generateOpaqueSecret,
  hashOpaqueSecret,
  hashPassword,
  normalizeLoginEmail,
  validatePassword,
  verifyPassword
} from "./primitives.js";

export interface LoginIdentityRecord {
  id: string;
  orgId: string;
  employeeId: string;
  passwordHash: string | null;
  disabled: boolean;
  employeeDisabled: boolean;
  failedAttemptCount: number;
  cooldownLevel: number;
  cooldownUntil: Date | null;
}

export interface AccessAuthenticationRecord {
  identityId: string;
  employeeId: string;
  orgId: string;
  email: string;
  role: EmployeeRoleName;
  labels: string[];
  identityDisabled: boolean;
  employeeDisabled: boolean;
}

export type RotateCredentialResult =
  | {
      status: "rotated";
      sessionId: string;
      identityId: string;
      employeeId: string;
      orgId: string;
    }
  | { status: "replayed"; sessionId: string }
  | { status: "invalid" };

export type AuthorizationCodeRedemption =
  | {
      status: "redeemed";
      identityId: string;
      employeeId: string;
      orgId: string;
    }
  | { status: "invalid" };

export type AuthSecurityEventType =
  | "account_onboarded"
  | "setup_grant_issued"
  | "setup_grant_consumed"
  | "password_setup_completed"
  | "password_login_succeeded"
  | "password_login_failed"
  | "password_cooldown_entered"
  | "session_created"
  | "session_revoked"
  | "session_expired"
  | "credential_replay_detected"
  | "renewal_failed"
  | "security_policy_rejected"
  | "logout";

export interface SecurityEventInput {
  type: AuthSecurityEventType;
  outcome: "succeeded" | "failed" | "denied";
  reason?: string;
  requestId?: string;
  sourceIp?: string;
  launcherVersion?: string;
  orgId?: string;
  identityId?: string;
  employeeId?: string;
  sessionId?: string;
}

export interface AuthCoreRepository {
  findLoginIdentityByEmail(normalizedEmail: string): Promise<LoginIdentityRecord | null>;
  recordLoginFailure(identityId: string, now: Date): Promise<{ cooldownUntil: Date | null }>;
  resetLoginFailures(identityId: string): Promise<void>;
  replacePasswordSetupGrant(input: {
    identityId: string;
    purpose: "initial_setup" | "password_reset";
    tokenHash: string;
    expiresAt: Date;
    now: Date;
  }): Promise<string>;
  exchangePasswordSetupGrant(input: {
    grantTokenHash: string;
    sessionHash: string;
    expiresAt: Date;
    now: Date;
  }): Promise<{
    identityId: string;
    purpose: "initial_setup" | "password_reset";
  } | null>;
  consumePasswordSetupSession(input: {
    sessionHash: string;
    passwordHash: string;
    now: Date;
  }): Promise<boolean>;
  createAuthorizationTransaction(input: {
    transactionHash: string;
    clientId: string;
    redirectUri: string;
    state: string;
    pkceChallenge: string;
    expiresAt: Date;
    now: Date;
  }): Promise<string>;
  consumeAuthorizationTransactionAndCreateCode(input: {
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
  } | null>;
  redeemAuthorizationCode(input: {
    codeHash: string;
    clientId: string;
    redirectUri: string;
    pkceChallenge: string;
    now: Date;
  }): Promise<AuthorizationCodeRedemption>;
  createSessionBundle(input: {
    identityId: string;
    employeeId: string;
    orgId: string;
    credentialHash: string;
    accessTokenHash: string;
    absoluteExpiresAt: Date;
    accessTokenExpiresAt: Date;
    now: Date;
  }): Promise<string>;
  rotateDurableCredential(input: {
    presentedCredentialHash: string;
    replacementCredentialHash: string;
    accessTokenHash: string;
    accessTokenExpiresAt: Date;
    now: Date;
  }): Promise<RotateCredentialResult>;
  authenticateAccessToken(tokenHash: string, now: Date): Promise<AccessAuthenticationRecord | null>;
  revokeSessionByDurableCredential(
    credentialHash: string,
    reason: "logout" | "reset",
    now: Date
  ): Promise<boolean>;
  revokeIdentitySessions(identityId: string, reason: string, now: Date): Promise<number>;
  writeSecurityEvent(event: SecurityEventInput & { createdAt: Date }): Promise<void>;
  pruneSecurityEvents(before: Date): Promise<number>;
}

const DUMMY_PASSWORD_HASH = hashPassword("dummy verification password 4e385b6e");

export class AuthCore {
  constructor(
    private readonly repository: AuthCoreRepository,
    private readonly now: () => Date = () => new Date()
  ) {}

  async hashAcceptedPassword(password: string): Promise<string> {
    const validation = validatePassword(password);
    if (!validation.valid) {
      throw new Error(validation.reason);
    }
    return hashPassword(password);
  }

  async verifyLogin(
    email: string,
    password: string
  ): Promise<
    | { ok: false; reason: "invalid_credentials" }
    | { ok: true; identityId: string; employeeId: string; orgId: string }
  > {
    const identity = await this.repository.findLoginIdentityByEmail(normalizeLoginEmail(email));
    const now = this.now();

    if (!identity) {
      await verifyPassword(password, await DUMMY_PASSWORD_HASH);
      await this.repository.writeSecurityEvent({
        type: "password_login_failed",
        outcome: "failed",
        reason: "invalid_credentials",
        createdAt: now
      });
      return { ok: false, reason: "invalid_credentials" };
    }

    if (
      identity.disabled ||
      identity.employeeDisabled ||
      !identity.passwordHash ||
      (identity.cooldownUntil !== null && identity.cooldownUntil > now)
    ) {
      await verifyPassword(password, identity.passwordHash ?? (await DUMMY_PASSWORD_HASH));
      await this.repository.writeSecurityEvent({
        type: "password_login_failed",
        outcome: "denied",
        reason:
          identity.cooldownUntil !== null && identity.cooldownUntil > now
            ? "cooldown_active"
            : "identity_or_employee_disabled",
        orgId: identity.orgId,
        identityId: identity.id,
        employeeId: identity.employeeId,
        createdAt: now
      });
      return { ok: false, reason: "invalid_credentials" };
    }

    if (!(await verifyPassword(password, identity.passwordHash))) {
      const failure = await this.repository.recordLoginFailure(identity.id, now);
      await this.repository.writeSecurityEvent({
        type: "password_login_failed",
        outcome: "failed",
        reason: "invalid_credentials",
        orgId: identity.orgId,
        identityId: identity.id,
        employeeId: identity.employeeId,
        createdAt: now
      });
      if (failure.cooldownUntil) {
        await this.repository.writeSecurityEvent({
          type: "password_cooldown_entered",
          outcome: "denied",
          reason: "progressive_cooldown",
          orgId: identity.orgId,
          identityId: identity.id,
          employeeId: identity.employeeId,
          createdAt: now
        });
      }
      return { ok: false, reason: "invalid_credentials" };
    }

    await this.repository.resetLoginFailures(identity.id);
    await this.repository.writeSecurityEvent({
      type: "password_login_succeeded",
      outcome: "succeeded",
      orgId: identity.orgId,
      identityId: identity.id,
      employeeId: identity.employeeId,
      createdAt: now
    });
    return {
      ok: true,
      identityId: identity.id,
      employeeId: identity.employeeId,
      orgId: identity.orgId
    };
  }

  async issuePasswordSetupGrant(
    identityId: string,
    purpose: "initial_setup" | "password_reset"
  ): Promise<{ id: string; secret: string; expiresAt: Date }> {
    const now = this.now();
    const expiresAt = new Date(now.getTime() + AUTH_LIFETIMES_MS.passwordSetupGrant);
    const secret = generateOpaqueSecret("eh_ps_");
    const id = await this.repository.replacePasswordSetupGrant({
      identityId,
      purpose,
      tokenHash: hashOpaqueSecret(secret),
      expiresAt,
      now
    });
    return { id, secret, expiresAt };
  }

  async exchangePasswordSetupGrant(grantSecret: string): Promise<{
    identityId: string;
    purpose: "initial_setup" | "password_reset";
    sessionSecret: string;
    expiresAt: Date;
  } | null> {
    const now = this.now();
    const sessionSecret = generateOpaqueSecret("eh_ps_");
    const expiresAt = new Date(now.getTime() + AUTH_LIFETIMES_MS.passwordSetupSession);
    const result = await this.repository.exchangePasswordSetupGrant({
      grantTokenHash: hashOpaqueSecret(grantSecret),
      sessionHash: hashOpaqueSecret(sessionSecret),
      expiresAt,
      now
    });
    return result ? { ...result, sessionSecret, expiresAt } : null;
  }

  async consumePasswordSetupSession(sessionSecret: string, password: string): Promise<boolean> {
    const passwordHash = await this.hashAcceptedPassword(password);
    return this.repository.consumePasswordSetupSession({
      sessionHash: hashOpaqueSecret(sessionSecret),
      passwordHash,
      now: this.now()
    });
  }

  async issueAuthorizationTransaction(input: {
    clientId: string;
    redirectUri: string;
    state: string;
    pkceChallenge: string;
  }): Promise<{ id: string; secret: string; expiresAt: Date }> {
    const now = this.now();
    const secret = generateOpaqueSecret("eh_tx_");
    const expiresAt = new Date(now.getTime() + AUTH_LIFETIMES_MS.browserTransaction);
    const id = await this.repository.createAuthorizationTransaction({
      transactionHash: hashOpaqueSecret(secret),
      clientId: input.clientId,
      redirectUri: input.redirectUri,
      state: input.state,
      pkceChallenge: input.pkceChallenge,
      expiresAt,
      now
    });
    return { id, secret, expiresAt };
  }

  async completeAuthorizationTransaction(
    transactionSecret: string,
    identity: { identityId: string; employeeId: string; orgId: string }
  ): Promise<{
    codeId: string;
    code: string;
    clientId: string;
    redirectUri: string;
    state: string;
    expiresAt: Date;
  } | null> {
    const now = this.now();
    const code = generateOpaqueSecret("eh_ac_");
    const expiresAt = new Date(now.getTime() + AUTH_LIFETIMES_MS.authorizationCode);
    const result = await this.repository.consumeAuthorizationTransactionAndCreateCode({
      transactionHash: hashOpaqueSecret(transactionSecret),
      ...identity,
      codeHash: hashOpaqueSecret(code),
      codeExpiresAt: expiresAt,
      now
    });
    return result ? { ...result, code, expiresAt } : null;
  }

  redeemAuthorizationCode(input: {
    secret: string;
    clientId: string;
    redirectUri: string;
    verifier: string;
  }): Promise<AuthorizationCodeRedemption> {
    return this.repository.redeemAuthorizationCode({
      codeHash: hashOpaqueSecret(input.secret),
      clientId: input.clientId,
      redirectUri: input.redirectUri,
      pkceChallenge: derivePkceS256Challenge(input.verifier),
      now: this.now()
    });
  }

  async createSession(input: { identityId: string; employeeId: string; orgId: string }): Promise<{
    sessionId: string;
    durableCredential: string;
    accessToken: string;
    absoluteExpiresAt: Date;
    accessTokenExpiresAt: Date;
  }> {
    const now = this.now();
    const durableCredential = generateOpaqueSecret("eh_rt_");
    const accessToken = generateOpaqueSecret("eh_at_");
    const absoluteExpiresAt = new Date(now.getTime() + AUTH_LIFETIMES_MS.durableSession);
    const accessTokenExpiresAt = new Date(now.getTime() + AUTH_LIFETIMES_MS.accessToken);
    const sessionId = await this.repository.createSessionBundle({
      ...input,
      credentialHash: hashOpaqueSecret(durableCredential),
      accessTokenHash: hashOpaqueSecret(accessToken),
      absoluteExpiresAt,
      accessTokenExpiresAt,
      now
    });
    return {
      sessionId,
      durableCredential,
      accessToken,
      absoluteExpiresAt,
      accessTokenExpiresAt
    };
  }

  async rotateDurableCredential(presentedCredential: string): Promise<
    | { status: "invalid" | "replayed" }
    | {
        status: "rotated";
        durableCredential: string;
        accessToken: string;
        accessTokenExpiresAt: Date;
      }
  > {
    const now = this.now();
    const durableCredential = generateOpaqueSecret("eh_rt_");
    const accessToken = generateOpaqueSecret("eh_at_");
    const accessTokenExpiresAt = new Date(now.getTime() + AUTH_LIFETIMES_MS.accessToken);
    const result = await this.repository.rotateDurableCredential({
      presentedCredentialHash: hashOpaqueSecret(presentedCredential),
      replacementCredentialHash: hashOpaqueSecret(durableCredential),
      accessTokenHash: hashOpaqueSecret(accessToken),
      accessTokenExpiresAt,
      now
    });
    if (result.status !== "rotated") {
      if (result.status === "invalid") {
        await this.repository.writeSecurityEvent({
          type: "renewal_failed",
          outcome: "failed",
          reason: "invalid_or_expired_credential",
          createdAt: now
        });
      }
      return { status: result.status };
    }
    return { status: "rotated", durableCredential, accessToken, accessTokenExpiresAt };
  }

  async authenticateAccessToken(accessToken: string): Promise<AuthenticatedEmployee | null> {
    const record = await this.repository.authenticateAccessToken(
      hashOpaqueSecret(accessToken),
      this.now()
    );
    if (!record || record.identityDisabled || record.employeeDisabled) {
      return null;
    }
    return {
      id: record.employeeId,
      orgId: record.orgId,
      email: record.email,
      role: record.role,
      disabled: false,
      labels: [...record.labels].sort()
    };
  }

  logout(durableCredential: string): Promise<boolean> {
    return this.repository.revokeSessionByDurableCredential(
      hashOpaqueSecret(durableCredential),
      "logout",
      this.now()
    );
  }

  revokeIdentitySessions(identityId: string, reason: string): Promise<number> {
    return this.repository.revokeIdentitySessions(identityId, reason, this.now());
  }

  writeSecurityEvent(event: SecurityEventInput): Promise<void> {
    return this.repository.writeSecurityEvent({ ...event, createdAt: this.now() });
  }

  pruneSecurityEvents(): Promise<number> {
    return this.repository.pruneSecurityEvents(
      new Date(this.now().getTime() - AUTH_LIFETIMES_MS.securityEventRetention)
    );
  }
}
