import { randomBytes } from "node:crypto";
import type { AuthenticatedEmployee } from "@smedc/domain";
import type { AuthRequestAudit } from "./auth-core.js";
import { hashOpaqueSecret } from "./primitives.js";

export const BROWSER_SESSION_COOKIE = "__Host-smedc_browser";
export const BROWSER_SESSION_SECONDS = 30 * 60;
export interface BrowserPrincipal extends AuthenticatedEmployee {
  identityId: string;
}
export interface BrowserLoginIdentity {
  identityId: string;
  employeeId: string;
  orgId: string;
  /** Internal proof of the password verified by AuthCore, never sent to a browser. */
  credentialFingerprint: string;
}
export interface BrowserSessionRepository {
  create(
    input: BrowserLoginIdentity & {
      secretHash: string;
      expiresAt: Date;
      now: Date;
      audit: AuthRequestAudit;
    }
  ): Promise<boolean>;
  find(secretHash: string): Promise<{
    principal: BrowserPrincipal;
    expiresAt: Date;
    revokedAt: Date | null;
    credentialFingerprint: string;
    currentCredentialFingerprint: string;
  } | null>;
  revoke(secretHash: string, now: Date): Promise<void>;
}
export class BrowserSessions {
  constructor(
    private readonly repository: BrowserSessionRepository,
    private readonly now: () => Date = () => new Date()
  ) {}
  async issue(
    identity: BrowserLoginIdentity,
    previousSecret: string | null,
    audit: AuthRequestAudit
  ): Promise<string | null> {
    const now = this.now();
    const secret = `eh_bs_${randomBytes(32).toString("base64url")}`;
    if (!/^[a-f0-9]{64}$/.test(identity.credentialFingerprint)) return null;
    const created = await this.repository.create({
      ...identity,
      secretHash: hashOpaqueSecret(secret),
      now,
      expiresAt: new Date(now.getTime() + BROWSER_SESSION_SECONDS * 1000),
      audit
    });
    if (!created) return null;
    if (previousSecret) await this.logout(previousSecret);
    return secret;
  }
  async authenticate(secret: string | null): Promise<BrowserPrincipal | null> {
    if (!secret || !/^eh_bs_[A-Za-z0-9_-]{43}$/.test(secret)) return null;
    const record = await this.repository.find(hashOpaqueSecret(secret));
    if (
      !record ||
      record.revokedAt ||
      record.expiresAt <= this.now() ||
      record.principal.disabled ||
      record.credentialFingerprint !== record.currentCredentialFingerprint
    )
      return null;
    return record.principal;
  }
  async logout(secret: string | null): Promise<void> {
    if (secret && /^eh_bs_[A-Za-z0-9_-]{43}$/.test(secret))
      await this.repository.revoke(hashOpaqueSecret(secret), this.now());
  }
}
