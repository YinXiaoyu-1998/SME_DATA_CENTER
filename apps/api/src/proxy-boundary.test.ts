import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { buildApiServer } from "./server.js";

const nginxConfigPath = fileURLToPath(
  new URL("../../../deploy/staging/nginx-enterprise-hub.conf", import.meta.url)
);

function buildReadinessServer(): FastifyInstance {
  return buildApiServer({
    cursorSigningSecret: "test-proxy-boundary-secret",
    authenticateAccessToken: async () => null,
    logger: false,
    readinessCheck: async () => ({
      ok: true,
      retrievalConfigVersion: "test-retrieval",
      checks: []
    })
  });
}

describe("reverse-proxy boundary", () => {
  let app: FastifyInstance | undefined;

  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  it("overwrites forwarded client provenance with its direct peer", async () => {
    const nginx = await readFile(nginxConfigPath, "utf8");

    expect(nginx).toContain("proxy_set_header X-Forwarded-For $remote_addr;");
    expect(nginx).not.toContain("$proxy_add_x_forwarded_for");
  });

  it("allows direct host-loopback readiness without forwarding", async () => {
    app = buildReadinessServer();

    const response = await app.inject({
      method: "GET",
      url: "/readyz",
      remoteAddress: "127.0.0.1"
    });

    expect(response.statusCode).toBe(200);
  });

  it("conceals readiness when a loopback proxy forwards a public client", async () => {
    app = buildReadinessServer();

    const response = await app.inject({
      method: "GET",
      url: "/readyz",
      remoteAddress: "127.0.0.1",
      headers: { "x-forwarded-for": "203.0.113.9" }
    });

    expect(response.statusCode).toBe(404);
  });

  it("does not trust forwarding headers from a non-loopback peer", async () => {
    app = buildReadinessServer();

    const response = await app.inject({
      method: "GET",
      url: "/readyz",
      remoteAddress: "203.0.113.9",
      headers: { "x-forwarded-for": "127.0.0.1" }
    });

    expect(response.statusCode).toBe(404);
  });
});
