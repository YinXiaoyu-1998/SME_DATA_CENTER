import { describe, expect, it } from "vitest";
import {
  ARGON2ID_OPTIONS,
  AUTH_LIFETIMES_MS,
  cooldownAfterFailure,
  generateOpaqueSecret,
  hashOpaqueSecret,
  hashPassword,
  normalizeLoginEmail,
  safeHashEquals,
  validatePassword,
  verifyPassword
} from "./primitives.js";

describe("auth primitives", () => {
  it("normalizes login email with trim, NFC, and locale-independent lowercase", () => {
    expect(normalizeLoginEmail("  U\u0308SER@EXAMPLE.COM  ")).toBe("üser@example.com");
  });

  it("counts normalized Unicode code points without trimming passwords", () => {
    expect(validatePassword(" pass word ")).toEqual({ valid: true });
    expect(validatePassword("😀😀😀😀😀😀😀")).toEqual({
      valid: false,
      reason: "password_length"
    });
    expect(validatePassword(`${"😀".repeat(128)}`)).toEqual({ valid: true });
    expect(validatePassword(`${"😀".repeat(129)}`)).toEqual({
      valid: false,
      reason: "password_length"
    });
  });

  it("rejects bundled common and service-specific passwords without composition rules", () => {
    expect(validatePassword("password")).toEqual({
      valid: false,
      reason: "common_password"
    });
    expect(validatePassword("smedatacenter")).toEqual({
      valid: false,
      reason: "common_password"
    });
    expect(validatePassword("all lower case passphrase")).toEqual({ valid: true });
  });

  it("hashes and verifies the NFC password with the required Argon2id parameters", async () => {
    expect(ARGON2ID_OPTIONS).toEqual({
      memoryCost: 65_536,
      timeCost: 3,
      parallelism: 1,
      hashLength: 32
    });

    const hash = await hashPassword("e\u0301ight88");

    expect(hash).not.toContain("e\u0301ight88");
    expect(await verifyPassword("éight88", hash)).toBe(true);
    expect(await verifyPassword("not-the-password", hash)).toBe(false);
  });

  it("starts cooldown on the fifth failure and caps the progression at 60 minutes", () => {
    expect(cooldownAfterFailure(4, 0)).toEqual({
      failedAttemptCount: 5,
      cooldownLevel: 1,
      cooldownMs: 5 * 60_000
    });
    expect(cooldownAfterFailure(5, 1).cooldownMs).toBe(10 * 60_000);
    expect(cooldownAfterFailure(6, 2).cooldownMs).toBe(20 * 60_000);
    expect(cooldownAfterFailure(7, 3).cooldownMs).toBe(40 * 60_000);
    expect(cooldownAfterFailure(8, 4).cooldownMs).toBe(60 * 60_000);
    expect(cooldownAfterFailure(50, 20).cooldownMs).toBe(60 * 60_000);
  });

  it("generates recognizable secrets with at least 256 random bits and hashes them safely", () => {
    for (const prefix of ["eh_ps_", "eh_at_", "eh_rt_", "eh_ac_", "eh_tx_"] as const) {
      const secret = generateOpaqueSecret(prefix);
      expect(secret.startsWith(prefix)).toBe(true);
      expect(Buffer.from(secret.slice(prefix.length), "base64url")).toHaveLength(32);
      expect(hashOpaqueSecret(secret)).toMatch(/^[a-f0-9]{64}$/);
      expect(safeHashEquals(hashOpaqueSecret(secret), hashOpaqueSecret(secret))).toBe(true);
      expect(safeHashEquals(hashOpaqueSecret(secret), hashOpaqueSecret(`${secret}x`))).toBe(false);
    }
  });

  it("exports the accepted fixed lifetimes", () => {
    expect(AUTH_LIFETIMES_MS).toEqual({
      accessToken: 10 * 60_000,
      authorizationCode: 60_000,
      browserTransaction: 10 * 60_000,
      deviceAuthorization: 10 * 60_000,
      passwordSetupSession: 10 * 60_000,
      passwordSetupGrant: 24 * 60 * 60_000,
      durableSession: 30 * 24 * 60 * 60_000,
      securityEventRetention: 90 * 24 * 60 * 60_000
    });
  });
});
