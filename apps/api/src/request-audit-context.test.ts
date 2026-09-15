import type { FastifyRequest } from "fastify";
import { describe, expect, it } from "vitest";
import {
  createRequestAuditContext,
  isTrustedLoopbackProxy,
  launcherVersionAtLeast,
  normalizeLauncherVersion,
  normalizeRequestId,
  verifyInternalDelegationProof
} from "./request-audit-context.js";

const delegationProof = Buffer.alloc(32, 0x5a).toString("base64url");

function requestForAuditContext(
  input: {
    id?: string;
    ip?: string;
    launcherVersion?: string | string[];
  } = {}
): FastifyRequest {
  return {
    id: input.id ?? "req_http_1",
    ip: input.ip ?? "203.0.113.9",
    headers: {
      ...(input.launcherVersion === undefined
        ? {}
        : { "x-enterprise-hub-launcher-version": input.launcherVersion })
    }
  } as FastifyRequest;
}

describe("request audit context", () => {
  it("normalizes request IDs to bounded structured values", () => {
    expect(normalizeRequestId("req_valid-123")).toBe("req_valid-123");
    expect(normalizeRequestId("x".repeat(129))).toBeNull();
    expect(normalizeRequestId("contains space")).toBeNull();
    expect(normalizeRequestId("req_valid-123\n")).toBeNull();
  });

  it("normalizes only bounded semantic launcher versions", () => {
    expect(normalizeLauncherVersion("0.1.0")).toBe("0.1.0");
    expect(normalizeLauncherVersion("0.1.0-rc.1")).toBe("0.1.0-rc.1");
    expect(normalizeLauncherVersion("0.1.0\nforged")).toBeNull();
    expect(normalizeLauncherVersion("1".repeat(65))).toBeNull();
    expect(normalizeLauncherVersion("01.1.0")).toBeNull();
  });

  it("compares launcher capabilities without accepting prereleases as a stable release", () => {
    expect(launcherVersionAtLeast("0.4.0", "0.4.0")).toBe(true);
    expect(launcherVersionAtLeast("0.5.0", "0.4.0")).toBe(true);
    expect(launcherVersionAtLeast("0.4.0-rc.1", "0.4.0")).toBe(false);
    expect(launcherVersionAtLeast("0.3.9", "0.4.0")).toBe(false);
    expect(launcherVersionAtLeast(null, "0.4.0")).toBe(false);
  });

  it("trusts only loopback reverse-proxy peers", () => {
    expect(isTrustedLoopbackProxy("127.0.0.1")).toBe(true);
    expect(isTrustedLoopbackProxy("::1")).toBe(true);
    expect(isTrustedLoopbackProxy("::ffff:127.0.0.1")).toBe(true);
    expect(isTrustedLoopbackProxy("127.42.0.8")).toBe(false);
    expect(isTrustedLoopbackProxy("198.51.100.8")).toBe(false);
  });

  it("records launcher metadata only for launcher-derived sources", () => {
    const browserAudit = createRequestAuditContext(
      requestForAuditContext({ launcherVersion: "0.1.0" }),
      "browser_auth"
    );
    const httpAudit = createRequestAuditContext(
      requestForAuditContext({ launcherVersion: "0.1.0" }),
      "http_api"
    );
    const oauthAudit = createRequestAuditContext(
      requestForAuditContext({ launcherVersion: "0.1.0" }),
      "oauth_launcher"
    );
    const mcpAudit = createRequestAuditContext(
      requestForAuditContext({ launcherVersion: "0.1.0" }),
      "mcp_launcher"
    );

    expect(browserAudit.launcherVersion).toBeNull();
    expect(httpAudit.launcherVersion).toBeNull();
    expect(oauthAudit.launcherVersion).toBe("0.1.0");
    expect(mcpAudit.launcherVersion).toBe("0.1.0");
    expect(Object.isFrozen(mcpAudit)).toBe(true);
  });

  it("bounds source IPs to the audit storage width", () => {
    const context = createRequestAuditContext(
      requestForAuditContext({ ip: "x".repeat(129) }),
      "http_api"
    );

    expect(context.sourceIp).toBe("x".repeat(128));
  });

  it("verifies only an exact opaque internal delegation proof", () => {
    const unequalProof = Buffer.alloc(32, 0xa5).toString("base64url");

    expect(verifyInternalDelegationProof(delegationProof, delegationProof)).toBe(true);
    expect(verifyInternalDelegationProof(unequalProof, delegationProof)).toBe(false);
  });

  it("rejects absent, malformed, and overlong delegation proofs without throwing", () => {
    expect(verifyInternalDelegationProof(undefined, delegationProof)).toBe(false);
    expect(verifyInternalDelegationProof(delegationProof, undefined)).toBe(false);
    expect(verifyInternalDelegationProof(`${delegationProof.slice(0, -1)}!`, delegationProof)).toBe(
      false
    );
    expect(verifyInternalDelegationProof(delegationProof.slice(1), delegationProof)).toBe(false);
    expect(verifyInternalDelegationProof("x".repeat(128), delegationProof)).toBe(false);
  });
});
