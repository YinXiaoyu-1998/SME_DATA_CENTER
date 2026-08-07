import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import argon2 from "argon2";
import { COMMON_PASSWORDS } from "./common-passwords.js";

export const ARGON2ID_OPTIONS = {
  memoryCost: 65_536,
  timeCost: 3,
  parallelism: 1,
  hashLength: 32
} as const;

export const AUTH_LIFETIMES_MS = {
  accessToken: 10 * 60_000,
  authorizationCode: 60_000,
  browserTransaction: 10 * 60_000,
  deviceAuthorization: 10 * 60_000,
  passwordSetupSession: 10 * 60_000,
  passwordSetupGrant: 24 * 60 * 60_000,
  durableSession: 30 * 24 * 60 * 60_000,
  securityEventRetention: 90 * 24 * 60 * 60_000
} as const;

export type OpaqueSecretPrefix = "eh_ps_" | "eh_at_" | "eh_rt_" | "eh_ac_" | "eh_tx_" | "eh_dc_";

const DEVICE_USER_CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

export function generateDeviceUserCode(length = 8): string {
  const bytes = randomBytes(length);
  let code = "";
  for (const byte of bytes) {
    code += DEVICE_USER_CODE_ALPHABET[byte % DEVICE_USER_CODE_ALPHABET.length]!;
  }
  return code;
}

export function normalizeLoginEmail(email: string): string {
  return email.trim().normalize("NFC").toLowerCase();
}

export type PasswordValidation =
  { valid: true } | { valid: false; reason: "password_length" | "common_password" };

export function validatePassword(password: string): PasswordValidation {
  const normalized = password.normalize("NFC");
  const codePointCount = Array.from(normalized).length;

  if (codePointCount < 8 || codePointCount > 128) {
    return { valid: false, reason: "password_length" };
  }

  if (COMMON_PASSWORDS.has(normalized.toLowerCase())) {
    return { valid: false, reason: "common_password" };
  }

  return { valid: true };
}

export async function hashPassword(password: string): Promise<string> {
  return argon2.hash(password.normalize("NFC"), {
    type: argon2.argon2id,
    ...ARGON2ID_OPTIONS
  });
}

export async function verifyPassword(password: string, encodedHash: string): Promise<boolean> {
  try {
    return await argon2.verify(encodedHash, password.normalize("NFC"));
  } catch {
    return false;
  }
}

export function cooldownAfterFailure(
  failedAttemptCount: number,
  cooldownLevel: number
): {
  failedAttemptCount: number;
  cooldownLevel: number;
  cooldownMs: number | null;
} {
  const nextFailedAttemptCount = failedAttemptCount + 1;

  if (nextFailedAttemptCount < 5) {
    return {
      failedAttemptCount: nextFailedAttemptCount,
      cooldownLevel,
      cooldownMs: null
    };
  }

  const nextCooldownLevel = Math.min(cooldownLevel + 1, 5);
  const minutes = [5, 10, 20, 40, 60][nextCooldownLevel - 1] ?? 60;
  return {
    failedAttemptCount: nextFailedAttemptCount,
    cooldownLevel: nextCooldownLevel,
    cooldownMs: minutes * 60_000
  };
}

export function generateOpaqueSecret(prefix: OpaqueSecretPrefix): string {
  return `${prefix}${randomBytes(32).toString("base64url")}`;
}

export function hashOpaqueSecret(secret: string): string {
  return createHash("sha256").update(secret, "utf8").digest("hex");
}

export function derivePkceS256Challenge(verifier: string): string {
  return createHash("sha256").update(verifier, "ascii").digest("base64url");
}

export function safeHashEquals(leftHash: string, rightHash: string): boolean {
  const left = Buffer.from(leftHash, "hex");
  const right = Buffer.from(rightHash, "hex");
  return left.length === right.length && timingSafeEqual(left, right);
}
