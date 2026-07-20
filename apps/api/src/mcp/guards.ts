import { isIP } from "node:net";

const DEFAULT_PHASE3_SERVICE_LISTEN_HOST = "127.0.0.1";
const MCP_JSON_ENVELOPE_OVERHEAD_BYTES = 64 * 1024;
const DEFAULT_MCP_MAX_CONCURRENT_REQUESTS = 8;
const MAX_MCP_REQUEST_ID_BYTES = 128;
const SAFE_MCP_REQUEST_ID_PATTERN = /^[A-Za-z0-9._:-]+$/;

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
  if (!requestId) {
    return false;
  }

  return (
    Buffer.byteLength(requestId, "utf8") <= MAX_MCP_REQUEST_ID_BYTES &&
    SAFE_MCP_REQUEST_ID_PATTERN.test(requestId)
  );
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

  return Math.min(Number.MAX_SAFE_INTEGER, base64Bytes + MCP_JSON_ENVELOPE_OVERHEAD_BYTES);
}

export function mcpMaxConcurrentRequestsFromEnv(env: NodeJS.ProcessEnv = process.env): number {
  const rawValue = env["MCP_MAX_CONCURRENT_REQUESTS"]?.trim();

  if (!rawValue) {
    return DEFAULT_MCP_MAX_CONCURRENT_REQUESTS;
  }

  const parsed = Number(rawValue);

  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error("MCP_MAX_CONCURRENT_REQUESTS must be a positive integer.");
  }

  return parsed;
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

function normalizePeerAddress(address: string): string {
  const normalized = address.trim().toLowerCase();

  if (normalized.startsWith("[") && normalized.endsWith("]")) {
    return normalized.slice(1, -1);
  }

  return normalized;
}

function hasValidPort(value: string): boolean {
  if (!/^\d+$/.test(value)) {
    return false;
  }

  const port = Number(value);

  return Number.isInteger(port) && port >= 1 && port <= 65_535;
}
