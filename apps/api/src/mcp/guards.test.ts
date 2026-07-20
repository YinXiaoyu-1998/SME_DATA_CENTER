import { describe, expect, it } from "vitest";
import {
  createMcpConcurrencyLimiter,
  isLoopbackAddress,
  isLoopbackHost,
  mcpBodyLimitBytes,
  isSafeMcpRequestId,
  resolvePhase3ServiceListenHost
} from "./guards.js";

describe("MCP endpoint guards", () => {
  it("accepts only explicit loopback host headers", () => {
    expect(isLoopbackHost("localhost")).toBe(true);
    expect(isLoopbackHost("localhost:3000")).toBe(true);
    expect(isLoopbackHost("127.0.0.1:3000")).toBe(true);
    expect(isLoopbackHost("[::1]:3000")).toBe(true);

    expect(isLoopbackHost("enterprise-hub.example.com")).toBe(false);
    expect(isLoopbackHost("127.0.0.2")).toBe(false);
    expect(isLoopbackHost("[::ffff:127.0.0.1]")).toBe(false);
    expect(isLoopbackHost("localhost.evil.example")).toBe(false);
    expect(isLoopbackHost("localhost:3000@evil.example")).toBe(false);
  });

  it("accepts only loopback peer addresses", () => {
    expect(isLoopbackAddress("127.0.0.1")).toBe(true);
    expect(isLoopbackAddress("127.42.0.8")).toBe(true);
    expect(isLoopbackAddress("::1")).toBe(true);
    expect(isLoopbackAddress("::ffff:127.0.0.1")).toBe(true);

    expect(isLoopbackAddress("198.51.100.10")).toBe(false);
    expect(isLoopbackAddress("10.0.0.2")).toBe(false);
    expect(isLoopbackAddress("::ffff:198.51.100.10")).toBe(false);
    expect(isLoopbackAddress(undefined)).toBe(false);
  });

  it("bounds MCP request IDs to safe structured values", () => {
    expect(isSafeMcpRequestId("req-123_abc.def:456")).toBe(true);
    expect(isSafeMcpRequestId("x".repeat(128))).toBe(true);

    expect(isSafeMcpRequestId("")).toBe(false);
    expect(isSafeMcpRequestId("bad id")).toBe(false);
    expect(isSafeMcpRequestId("bad/id")).toBe(false);
    expect(isSafeMcpRequestId("x".repeat(129))).toBe(false);
  });

  it("derives the JSON body limit from MAX_UPLOAD_BYTES with bounded envelope overhead", () => {
    expect(mcpBodyLimitBytes(3)).toBe(65_540);
  });

  it("fails closed for explicitly non-loopback Phase 3 service listener hosts", () => {
    expect(resolvePhase3ServiceListenHost({})).toBe("127.0.0.1");
    expect(resolvePhase3ServiceListenHost({ HOST: "localhost" })).toBe("localhost");
    expect(resolvePhase3ServiceListenHost({ HOST: "127.0.0.1" })).toBe("127.0.0.1");
    expect(resolvePhase3ServiceListenHost({ HOST: "::1" })).toBe("::1");
    expect(resolvePhase3ServiceListenHost({ HOST: "0:0:0:0:0:0:0:1" })).toBe("0:0:0:0:0:0:0:1");

    expect(() => resolvePhase3ServiceListenHost({ HOST: "0.0.0.0" })).toThrow(
      "HOST must be loopback for the Phase 3 service listener."
    );
    expect(() => resolvePhase3ServiceListenHost({ HOST: "::" })).toThrow(
      "HOST must be loopback for the Phase 3 service listener."
    );
    expect(() => resolvePhase3ServiceListenHost({ HOST: "enterprise-hub.example.com" })).toThrow(
      "HOST must be loopback for the Phase 3 service listener."
    );
  });

  it("bounds concurrent work with a nonblocking acquire", () => {
    const limiter = createMcpConcurrencyLimiter(1);
    const firstRelease = limiter.tryAcquire();
    const secondRelease = limiter.tryAcquire();

    expect(firstRelease).toEqual(expect.any(Function));
    expect(secondRelease).toBeNull();

    firstRelease?.();
    expect(limiter.tryAcquire()).toEqual(expect.any(Function));
  });
});
