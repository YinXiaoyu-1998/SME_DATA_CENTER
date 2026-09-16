import type { AuthenticatedEmployee, EmployeeRoleName } from "@enterprise-hub/domain";
import type { RequestAuditContext } from "../request-audit-context.js";
import {
  AUTH_LIFETIMES_MS,
  derivePkceS256Challenge,
  generateDeviceUserCode,
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
  organizationName: string;
  displayName: string;
  email: string;
  role: EmployeeRoleName;
  clearance: number;
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

export type DeviceCodeRedemption =
  | {
      status: "redeemed";
      identityId: string;
      employeeId: string;
      orgId: string;
    }
  | { status: "authorization_pending" }
  | { status: "expired" }
  | { status: "invalid" };

export type AuthSecurityEventType =
  | "account_onboarded"
  | "setup_grant_issued"
  | "setup_grant_consumed"
  | "password_setup_completed"
  | "password_login_succeeded"
  | "password_login_failed"
  | "password_cooldown_entered"
  | "device_authorization_issued"
  | "device_authorization_completed"
  | "device_authorization_expired"
  | "device_authorization_revoked"
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

export type AuthRequestAudit = Pick<
  RequestAuditContext,
  "requestId" | "sourceIp" | "launcherVersion"
>;

export function eventAudit(audit: AuthRequestAudit | undefined) {
  return audit
    ? {
        requestId: audit.requestId,
        sourceIp: audit.sourceIp,
        launcherVersion: audit.launcherVersion ?? undefined
      }
    : {};
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
    audit: AuthRequestAudit;
  }): Promise<{
    identityId: string;
    purpose: "initial_setup" | "password_reset";
  } | null>;
  consumePasswordSetupSession(input: {
    sessionHash: string;
    passwordHash: string;
    now: Date;
    audit: AuthRequestAudit;
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
    audit: AuthRequestAudit;
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
    audit: AuthRequestAudit;
  }): Promise<AuthorizationCodeRedemption>;
  createDeviceAuthorization(input: {
    deviceCodeHash: string;
    userCodeHash: string;
    clientId: string;
    instanceName: string;
    instanceHostname: string;
    expiresAt: Date;
    now: Date;
    audit: AuthRequestAudit;
  }): Promise<void>;
  findDeviceAuthorizationByUserCode(input: { userCodeHash: string; now: Date }): Promise<{
    status: "pending" | "completed" | "expired" | "revoked";
    instanceName: string;
    instanceHostname: string;
  } | null>;
  completeDeviceAuthorization(input: {
    userCodeHash: string;
    identityId: string;
    employeeId: string;
    orgId: string;
    now: Date;
    audit: AuthRequestAudit;
  }): Promise<boolean>;
  redeemDeviceAuthorization(input: {
    deviceCodeHash: string;
    clientId: string;
    now: Date;
    audit: AuthRequestAudit;
  }): Promise<DeviceCodeRedemption>;
  createSessionBundle(input: {
    identityId: string;
    employeeId: string;
    orgId: string;
    credentialHash: string;
    accessTokenHash: string;
    absoluteExpiresAt: Date;
    accessTokenExpiresAt: Date;
    now: Date;
    audit?: AuthRequestAudit;
  }): Promise<string>;
  rotateDurableCredential(input: {
    presentedCredentialHash: string;
    replacementCredentialHash: string;
    accessTokenHash: string;
    accessTokenExpiresAt: Date;
    now: Date;
    audit: AuthRequestAudit;
  }): Promise<RotateCredentialResult>;
  authenticateAccessToken(
    tokenHash: string,
    now: Date,
    audit?: AuthRequestAudit
  ): Promise<AccessAuthenticationRecord | null>;
  revokeSessionByDurableCredential(
    credentialHash: string,
    reason: "logout" | "reset",
    now: Date,
    audit?: AuthRequestAudit
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
    password: string,
    audit: AuthRequestAudit
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
        ...eventAudit(audit),
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
        ...eventAudit(audit),
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
        ...eventAudit(audit),
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
          ...eventAudit(audit),
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
      ...eventAudit(audit),
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

  async exchangePasswordSetupGrant(
    grantSecret: string,
    audit: AuthRequestAudit
  ): Promise<{
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
      now,
      audit
    });
    return result ? { ...result, sessionSecret, expiresAt } : null;
  }

  async consumePasswordSetupSession(
    sessionSecret: string,
    password: string,
    audit: AuthRequestAudit
  ): Promise<boolean> {
    const passwordHash = await this.hashAcceptedPassword(password);
    return this.repository.consumePasswordSetupSession({
      sessionHash: hashOpaqueSecret(sessionSecret),
      passwordHash,
      now: this.now(),
      audit
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
    identity: { identityId: string; employeeId: string; orgId: string },
    audit: AuthRequestAudit
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
      now,
      audit
    });
    return result ? { ...result, code, expiresAt } : null;
  }

  redeemAuthorizationCode(
    input: {
      secret: string;
      clientId: string;
      redirectUri: string;
      verifier: string;
    },
    audit: AuthRequestAudit
  ): Promise<AuthorizationCodeRedemption> {
    return this.repository.redeemAuthorizationCode({
      codeHash: hashOpaqueSecret(input.secret),
      clientId: input.clientId,
      redirectUri: input.redirectUri,
      pkceChallenge: derivePkceS256Challenge(input.verifier),
      now: this.now(),
      audit
    });
  }

  async issueDeviceAuthorization(input: {
    clientId: string;
    instanceName: string;
    instanceHostname: string;
    audit: AuthRequestAudit;
  }): Promise<{
    deviceCode: string;
    userCode: string;
    expiresAt: Date;
    intervalSeconds: number;
  }> {
    const now = this.now();
    const expiresAt = new Date(now.getTime() + AUTH_LIFETIMES_MS.deviceAuthorization);
    const deviceCode = generateOpaqueSecret("eh_dc_");
    const userCode = generateDeviceUserCode();
    await this.repository.createDeviceAuthorization({
      deviceCodeHash: hashOpaqueSecret(deviceCode),
      userCodeHash: hashOpaqueSecret(userCode),
      clientId: input.clientId,
      instanceName: input.instanceName,
      instanceHostname: input.instanceHostname,
      expiresAt,
      now,
      audit: input.audit
    });
    return { deviceCode, userCode, expiresAt, intervalSeconds: 5 };
  }

  async findDeviceAuthorizationByUserCode(userCode: string): Promise<{
    status: "pending" | "completed" | "expired" | "revoked";
    instanceName: string;
    instanceHostname: string;
  } | null> {
    return this.repository.findDeviceAuthorizationByUserCode({
      userCodeHash: hashOpaqueSecret(userCode),
      now: this.now()
    });
  }

  async completeDeviceAuthorization(
    userCode: string,
    identity: { identityId: string; employeeId: string; orgId: string },
    audit: AuthRequestAudit
  ): Promise<boolean> {
    return this.repository.completeDeviceAuthorization({
      userCodeHash: hashOpaqueSecret(userCode),
      ...identity,
      now: this.now(),
      audit
    });
  }

  async redeemDeviceAuthorization(
    deviceCode: string,
    clientId: string,
    audit: AuthRequestAudit
  ): Promise<DeviceCodeRedemption> {
    return this.repository.redeemDeviceAuthorization({
      deviceCodeHash: hashOpaqueSecret(deviceCode),
      clientId,
      now: this.now(),
      audit
    });
  }

  async createSession(
    input: { identityId: string; employeeId: string; orgId: string },
    audit?: AuthRequestAudit
  ): Promise<{
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
      now,
      audit
    });
    return {
      sessionId,
      durableCredential,
      accessToken,
      absoluteExpiresAt,
      accessTokenExpiresAt
    };
  }

  async rotateDurableCredential(
    presentedCredential: string,
    audit: AuthRequestAudit
  ): Promise<
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
      now,
      audit
    });
    if (result.status !== "rotated") {
      if (result.status === "invalid") {
        await this.repository.writeSecurityEvent({
          type: "renewal_failed",
          outcome: "failed",
          reason: "invalid_or_expired_credential",
          ...eventAudit(audit),
          createdAt: now
        });
      }
      return { status: result.status };
    }
    return { status: "rotated", durableCredential, accessToken, accessTokenExpiresAt };
  }

  async authenticateAccessToken(
    accessToken: string,
    audit: AuthRequestAudit
  ): Promise<AuthenticatedEmployee | null> {
    const record = await this.repository.authenticateAccessToken(
      hashOpaqueSecret(accessToken),
      this.now(),
      audit
    );
    if (!record || record.identityDisabled || record.employeeDisabled) {
      return null;
    }
    return {
      id: record.employeeId,
      orgId: record.orgId,
      organizationName: record.organizationName,
      displayName: record.displayName,
      email: record.email,
      role: record.role,
      clearance: record.clearance,
      disabled: false
    };
  }

  logout(durableCredential: string, audit?: AuthRequestAudit): Promise<boolean> {
    return this.repository.revokeSessionByDurableCredential(
      hashOpaqueSecret(durableCredential),
      "logout",
      this.now(),
      audit
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
