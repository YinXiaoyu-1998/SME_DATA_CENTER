import { describe, expect, it } from "vitest";
import { hashOpaqueSecret } from "./primitives.js";

const identity = {
  identityId: "identity_a",
  employeeId: "admin_a",
  orgId: "org_a",
  credentialFingerprint: "a".repeat(64)
};
const principal = {
  ...identity,
  id: "admin_a",
  displayName: "管理员",
  organizationName: "示例企业",
  email: "admin@example.invalid",
  role: "admin" as const,
  clearance: 3,
  disabled: false
};
const audit = { requestId: "req_browser", sourceIp: "127.0.0.1", launcherVersion: null };

async function fixture() {
  const module = await import("./browser-session.js").catch(() => null);
  expect(module, "shared browser sessions must be implemented").not.toBeNull();
  const stored = new Map<
    string,
    {
      principal: typeof principal;
      expiresAt: Date;
      revokedAt: Date | null;
      credentialFingerprint: string;
      currentCredentialFingerprint: string;
    }
  >();
  let now = new Date("2026-10-11T10:00:00Z");
  const repository = {
    async create(input: typeof identity & { secretHash: string; expiresAt: Date }) {
      stored.set(input.secretHash, {
        principal: { ...principal },
        expiresAt: input.expiresAt,
        revokedAt: null,
        credentialFingerprint: input.credentialFingerprint,
        currentCredentialFingerprint: input.credentialFingerprint
      });
      return true;
    },
    async find(secretHash: string) {
      return stored.get(secretHash) ?? null;
    },
    async revoke(secretHash: string) {
      const row = stored.get(secretHash);
      if (row) row.revokedAt = now;
    }
  };
  return {
    sessions: new module!.BrowserSessions(repository, () => now),
    stored,
    advance: (ms: number) => {
      now = new Date(now.getTime() + ms);
    }
  };
}

describe("shared browser identity session", () => {
  it("persists only a hash and authenticates the shared identity with absolute expiry", async () => {
    const { sessions, stored, advance } = await fixture();
    const secret = await sessions.issue(identity, null, audit);
    expect(secret).toMatch(/^eh_bs_/);
    expect(stored.has(secret!)).toBe(false);
    expect(stored.has(hashOpaqueSecret(secret!))).toBe(true);
    expect(await sessions.authenticate(secret)).toMatchObject({ id: "admin_a", orgId: "org_a" });
    advance(29 * 60_000);
    expect(await sessions.authenticate(secret)).not.toBeNull();
    advance(60_000);
    expect(await sessions.authenticate(secret)).toBeNull();
  });
  it("rotates an existing browser session and logout revokes only that browser", async () => {
    const { sessions } = await fixture();
    const old = await sessions.issue(identity, null, audit);
    const next = await sessions.issue(identity, old, audit);
    expect(next).not.toBe(old);
    expect(await sessions.authenticate(old)).toBeNull();
    expect(await sessions.authenticate(next)).not.toBeNull();
    await sessions.logout(next);
    expect(await sessions.authenticate(next)).toBeNull();
  });
  it("refuses missing, malformed, revoked or changed-password identities", async () => {
    const { sessions, stored } = await fixture();
    expect(await sessions.authenticate(null)).toBeNull();
    expect(await sessions.authenticate("untrusted-token")).toBeNull();
    const secret = await sessions.issue(identity, null, audit);
    stored.get(hashOpaqueSecret(secret!))!.currentCredentialFingerprint = "b".repeat(64);
    expect(await sessions.authenticate(secret)).toBeNull();
  });
});
