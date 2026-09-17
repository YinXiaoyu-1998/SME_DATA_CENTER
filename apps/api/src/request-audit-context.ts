import { timingSafeEqual } from "node:crypto";
import type { FastifyRequest } from "fastify";

const MAX_REQUEST_ID_BYTES = 128;
const MAX_SOURCE_IP_CHARS = 128;
const MAX_LAUNCHER_VERSION_CHARS = 64;
const SAFE_REQUEST_ID_PATTERN = /^[A-Za-z0-9._:-]+$/;
const LAUNCHER_VERSION_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?$/;
const INTERNAL_DELEGATION_PROOF_ENCODED_CHARS = 43;
const INTERNAL_DELEGATION_PROOF_PATTERN = /^[A-Za-z0-9_-]{43}$/;

export const INTERNAL_DELEGATION_PROOF_BYTES = 32;

export type ClientSource = "http_api" | "browser_auth" | "oauth_launcher" | "mcp_launcher";

export type RequestAuditContext = Readonly<{
  requestId: string;
  sourceIp: string;
  clientSource: ClientSource;
  launcherVersion: string | null;
}>;

export function launcherVersionAtLeast(version: string | null, minimum: string): boolean {
  const current = semanticVersion(version);
  const required = semanticVersion(minimum);
  if (!current || !required) return false;
  for (let index = 0; index < 3; index += 1) {
    if (current.numbers[index]! !== required.numbers[index]!)
      return current.numbers[index]! > required.numbers[index]!;
  }
  return !current.prerelease || Boolean(required.prerelease);
}

export function normalizeRequestId(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }

  if (
    Buffer.byteLength(value, "utf8") > MAX_REQUEST_ID_BYTES ||
    !SAFE_REQUEST_ID_PATTERN.test(value) ||
    value.includes("\n") ||
    value.includes("\r")
  ) {
    return null;
  }

  return value;
}

export function normalizeLauncherVersion(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }

  if (
    value.length > MAX_LAUNCHER_VERSION_CHARS ||
    !LAUNCHER_VERSION_PATTERN.test(value) ||
    value.includes("\n") ||
    value.includes("\r")
  ) {
    return null;
  }

  return value;
}

export function isTrustedLoopbackProxy(address: string | undefined): boolean {
  if (!address) {
    return false;
  }

  const normalized = normalizePeerAddress(address);

  return (
    normalized === "127.0.0.1" ||
    normalized === "::1" ||
    normalized === "0:0:0:0:0:0:0:1" ||
    normalized === "::ffff:127.0.0.1"
  );
}

export function verifyInternalDelegationProof(
  presentedProof: unknown,
  expectedProof: unknown
): boolean {
  const presented = internalDelegationProofBuffer(presentedProof);
  const expected = internalDelegationProofBuffer(expectedProof);

  if (!presented || !expected || presented.length !== expected.length) {
    return false;
  }

  return timingSafeEqual(presented, expected);
}

export function createRequestAuditContext(
  request: Pick<FastifyRequest, "id" | "ip" | "headers">,
  clientSource: ClientSource
): RequestAuditContext {
  const launcherVersion =
    clientSource === "oauth_launcher" || clientSource === "mcp_launcher"
      ? normalizeLauncherVersion(request.headers["x-smedc-launcher-version"])
      : null;

  return Object.freeze({
    requestId: request.id,
    sourceIp: request.ip.slice(0, MAX_SOURCE_IP_CHARS),
    clientSource,
    launcherVersion
  });
}

function normalizePeerAddress(address: string): string {
  const normalized = address.trim().toLowerCase();

  if (normalized.startsWith("[") && normalized.endsWith("]")) {
    return normalized.slice(1, -1);
  }

  return normalized;
}

function semanticVersion(value: string | null) {
  if (!value) return null;
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z.-]+))?$/.exec(value);
  return match
    ? {
        numbers: [Number(match[1]), Number(match[2]), Number(match[3])] as const,
        prerelease: match[4] ?? null
      }
    : null;
}

function internalDelegationProofBuffer(value: unknown): Buffer | null {
  if (
    typeof value !== "string" ||
    value.length !== INTERNAL_DELEGATION_PROOF_ENCODED_CHARS ||
    Buffer.byteLength(value, "utf8") !== INTERNAL_DELEGATION_PROOF_ENCODED_CHARS ||
    !INTERNAL_DELEGATION_PROOF_PATTERN.test(value)
  ) {
    return null;
  }

  const proof = Buffer.from(value, "base64url");

  if (proof.length !== INTERNAL_DELEGATION_PROOF_BYTES || proof.toString("base64url") !== value) {
    return null;
  }

  return proof;
}
