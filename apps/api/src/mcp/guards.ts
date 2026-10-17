import { STORE_REVIEW_LIMITS } from "@smedc/domain";
import { isIP } from "node:net";
import { normalizeRequestId } from "../request-audit-context.js";

const DEFAULT_PHASE3_SERVICE_LISTEN_HOST = "127.0.0.1";
const MCP_JSON_ENVELOPE_OVERHEAD_BYTES = 64 * 1024;

export function isLoopbackHost(hostHeader: string | undefined): boolean {
  if (!hostHeader) {
    return false;
  }

  const host = hostHeader.trim().toLowerCase();

  if (!host || /[\s/@\\]/.test(host)) {
    return false;
  }

  if (host === "localhost" || host === "localhost.") {
    return true;
  }

  if (host.startsWith("localhost:") || host.startsWith("localhost.:")) {
    return hasValidPort(host.slice(host.indexOf(":") + 1));
  }

  if (host === "127.0.0.1") {
    return true;
  }

  if (host.startsWith("127.0.0.1:")) {
    return hasValidPort(host.slice("127.0.0.1:".length));
  }

  if (host === "[::1]") {
    return true;
  }

  if (host.startsWith("[::1]:")) {
    return hasValidPort(host.slice("[::1]:".length));
  }

  return false;
}

export function isAllowedMcpHost(
  hostHeader: string | undefined,
  publicOrigin: string | undefined
): boolean {
  if (isLoopbackHost(hostHeader)) {
    return true;
  }

  if (!hostHeader || !publicOrigin) {
    return false;
  }

  const origin = parseMcpPublicOrigin(publicOrigin);
  const suppliedHost = hostHeader.trim().toLowerCase();

  if (!suppliedHost || /[\s/@\\]/.test(suppliedHost)) {
    return false;
  }

  return suppliedHost === origin.hostname || suppliedHost === `${origin.hostname}:443`;
}

export function assertValidMcpPublicOrigin(publicOrigin: string | undefined): void {
  if (publicOrigin) {
    parseMcpPublicOrigin(publicOrigin);
  }
}

export function isLoopbackAddress(address: string | undefined): boolean {
  if (!address) {
    return false;
  }

  const normalized = normalizePeerAddress(address);

  if (normalized === "::1" || normalized === "0:0:0:0:0:0:0:1") {
    return true;
  }

  const ipv4Mapped = normalized.startsWith("::ffff:")
    ? normalized.slice("::ffff:".length)
    : normalized;

  if (isIP(ipv4Mapped) !== 4) {
    return false;
  }

  const octets = ipv4Mapped.split(".");

  return octets.length === 4 && octets[0] === "127";
}

export function isSafeMcpRequestId(requestId: string | undefined): boolean {
  return normalizeRequestId(requestId) !== null;
}

export function resolvePhase3ServiceListenHost(env: NodeJS.ProcessEnv = process.env): string {
  const rawHost = env["HOST"]?.trim();

  if (!rawHost) {
    return DEFAULT_PHASE3_SERVICE_LISTEN_HOST;
  }

  const normalizedHost = rawHost.toLowerCase();

  if (
    normalizedHost === "localhost" ||
    normalizedHost === "127.0.0.1" ||
    normalizedHost === "::1" ||
    normalizedHost === "0:0:0:0:0:0:0:1"
  ) {
    return rawHost;
  }

  throw new Error(
    "HOST must be loopback for the Phase 3 service listener. Supported values: localhost, 127.0.0.1, ::1, 0:0:0:0:0:0:0:1."
  );
}

export function mcpBodyLimitBytes(maxUploadBytes: number): number {
  const base64Bytes = Math.ceil((maxUploadBytes * 4) / 3);

  return Math.min(
    Number.MAX_SAFE_INTEGER,
    Math.max(base64Bytes, STORE_REVIEW_LIMITS.batchBytes) + MCP_JSON_ENVELOPE_OVERHEAD_BYTES
  );
}

export function createMcpConcurrencyLimiter(maxConcurrentRequests: number) {
  if (!Number.isSafeInteger(maxConcurrentRequests) || maxConcurrentRequests <= 0) {
    throw new Error("maxConcurrentRequests must be a positive integer.");
  }

  let activeRequests = 0;

  return {
    tryAcquire(): (() => void) | null {
      if (activeRequests >= maxConcurrentRequests) {
        return null;
      }

      activeRequests += 1;
      let released = false;

      return () => {
        if (released) {
          return;
        }

        released = true;
        activeRequests -= 1;
      };
    }
  };
}

function hasValidPort(value: string): boolean {
  if (!/^\d+$/.test(value)) {
    return false;
  }

  const port = Number(value);

  return Number.isInteger(port) && port >= 1 && port <= 65_535;
}

function normalizePeerAddress(address: string): string {
  const normalized = address.trim().toLowerCase();

  if (normalized.startsWith("[") && normalized.endsWith("]")) {
    return normalized.slice(1, -1);
  }

  return normalized;
}

function parseMcpPublicOrigin(value: string): URL {
  const origin = new URL(value);

  if (origin.protocol !== "https:") {
    throw new Error("MCP public origin must use HTTPS.");
  }

  if (origin.username || origin.password) {
    throw new Error("MCP public origin must not include credentials.");
  }

  if (origin.pathname !== "/" || origin.search || origin.hash) {
    throw new Error("MCP public origin must not include a path, query, or fragment.");
  }

  if (origin.port && origin.port !== "443") {
    throw new Error("MCP public origin must use the default HTTPS port.");
  }

  return origin;
}
