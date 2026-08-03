import type { FastifyRequest } from "fastify";

const MAX_REQUEST_ID_BYTES = 128;
const MAX_SOURCE_IP_CHARS = 128;
const MAX_LAUNCHER_VERSION_CHARS = 64;
const SAFE_REQUEST_ID_PATTERN = /^[A-Za-z0-9._:-]+$/;
const LAUNCHER_VERSION_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?$/;

export type ClientSource = "http_api" | "browser_auth" | "oauth_launcher" | "mcp_launcher";

export type RequestAuditContext = Readonly<{
  requestId: string;
  sourceIp: string;
  clientSource: ClientSource;
  launcherVersion: string | null;
}>;

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

export function createRequestAuditContext(
  request: Pick<FastifyRequest, "id" | "ip" | "headers">,
  clientSource: ClientSource
): RequestAuditContext {
  const launcherVersion =
    clientSource === "oauth_launcher" || clientSource === "mcp_launcher"
      ? normalizeLauncherVersion(request.headers["x-enterprise-hub-launcher-version"])
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
