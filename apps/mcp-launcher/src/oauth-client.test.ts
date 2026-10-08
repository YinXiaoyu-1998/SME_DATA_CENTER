import { createServer } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { SmedcOAuthClient, mapOAuthError } from "./oauth-client.js";

const servers: ReturnType<typeof createServer>[] = [];

afterEach(async () => {
  await Promise.all(
    servers
      .splice(0)
      .map(
        (server) =>
          new Promise<void>((resolve, reject) =>
            server.close((error) => (error ? reject(error) : resolve()))
          )
      )
  );
});

describe("OAuth typed failures", () => {
  it("distinguishes authentication, authorization, and availability", () => {
    expect(mapOAuthError({ status: 401 }).code).toBe("AUTHENTICATION_REQUIRED");
    expect(mapOAuthError({ status: 403 }).code).toBe("FORBIDDEN");
    expect(mapOAuthError(new Error("network timeout")).code).toBe("SERVICE_UNAVAILABLE");
  });

  it("accepts device-only metadata without an authorization endpoint", async () => {
    const server = createServer((request, response) => {
      const origin = `https://127.0.0.1:${(server.address() as { port: number }).port}`;
      if (request.url === "/.well-known/oauth-authorization-server") {
        response.setHeader("content-type", "application/json");
        response.end(
          JSON.stringify({
            issuer: origin,
            device_authorization_endpoint: `${origin}/oauth/device_authorization`,
            token_endpoint: `${origin}/oauth/token`,
            revocation_endpoint: `${origin}/oauth/revoke`,
            grant_types_supported: [
              "refresh_token",
              "urn:ietf:params:oauth:grant-type:device_code"
            ],
            smedc_launcher_minimum_version: "0.6.0",
            smedc_launcher_recommended_version: "0.6.0"
          })
        );
        return;
      }
      response.statusCode = 404;
      response.end();
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const origin = new URL(`https://127.0.0.1:${(server.address() as { port: number }).port}`);
    const client = new SmedcOAuthClient(origin, async (input, init) => {
      const rewritten = new URL(
        typeof input === "string" || input instanceof URL ? input.toString() : input.url
      );
      rewritten.protocol = "http:";
      const response = await fetch(rewritten, init);
      return new Response(await response.arrayBuffer(), {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers
      });
    });

    const metadata = await client.metadata();
    expect(metadata).toMatchObject({ compatible: true, recommendedUpdateAvailable: false });
    expect(metadata.deviceAuthorizationEndpoint.href).toBe(
      `${origin.href}oauth/device_authorization`
    );
  });
});

describe("device authorization grant", () => {
  it("requests a device authorization with the declared instance identity", async () => {
    let deviceRequest: { body: URLSearchParams; launcherVersion?: string } | undefined;
    const server = createServer((request, response) => {
      const origin = `https://127.0.0.1:${(server.address() as { port: number }).port}`;
      if (request.url === "/.well-known/oauth-authorization-server") {
        response.setHeader("content-type", "application/json");
        response.end(
          JSON.stringify({
            issuer: origin,
            device_authorization_endpoint: `${origin}/oauth/device_authorization`,
            token_endpoint: `${origin}/oauth/token`,
            revocation_endpoint: `${origin}/oauth/revoke`,
            grant_types_supported: [
              "refresh_token",
              "urn:ietf:params:oauth:grant-type:device_code"
            ],
            smedc_launcher_minimum_version: "0.6.0",
            smedc_launcher_recommended_version: "0.6.0"
          })
        );
        return;
      }
      if (request.url === "/oauth/device_authorization" && request.method === "POST") {
        let body = "";
        request.setEncoding("utf8");
        request.on("data", (chunk: string) => {
          body += chunk;
        });
        request.on("end", () => {
          deviceRequest = {
            body: new URLSearchParams(body),
            launcherVersion: request.headers["x-smedc-launcher-version"] as string | undefined
          };
          response.setHeader("content-type", "application/json");
          response.setHeader("cache-control", "no-store");
          response.end(
            JSON.stringify({
              device_code: "eh_dc_device",
              user_code: "ABCDEFGH",
              verification_uri: `${origin}/oauth/device/verify`,
              verification_uri_complete: `${origin}/oauth/device/verify?user_code=ABCDEFGH`,
              expires_in: 600,
              interval: 5
            })
          );
        });
        return;
      }
      response.statusCode = 404;
      response.end();
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const origin = new URL(`https://127.0.0.1:${(server.address() as { port: number }).port}`);
    const client = new SmedcOAuthClient(origin, async (input, init) => {
      const rewritten = new URL(
        typeof input === "string" || input instanceof URL ? input.toString() : input.url
      );
      rewritten.protocol = "http:";
      return fetch(rewritten, init);
    });

    const device = await client.requestDeviceAuthorization({
      instanceName: "agent-a",
      instanceHostname: "vps-1"
    });

    expect(device).toMatchObject({
      deviceCode: "eh_dc_device",
      userCode: "ABCDEFGH",
      expiresInSeconds: 600,
      intervalSeconds: 5
    });
    expect(device.verificationUriComplete?.toString()).toContain("user_code=ABCDEFGH");
    expect(deviceRequest?.launcherVersion).toBe("0.8.0");
    expect(deviceRequest?.body.get("client_id")).toBe("smedc-desktop-launcher");
    expect(deviceRequest?.body.get("instanceName")).toBe("agent-a");
    expect(deviceRequest?.body.get("instanceHostname")).toBe("vps-1");
  });

  it("maps device-code poll states to typed results", async () => {
    let polls = 0;
    const server = createServer((request, response) => {
      const origin = `https://127.0.0.1:${(server.address() as { port: number }).port}`;
      if (request.url === "/.well-known/oauth-authorization-server") {
        response.setHeader("content-type", "application/json");
        response.end(
          JSON.stringify({
            issuer: origin,
            device_authorization_endpoint: `${origin}/oauth/device_authorization`,
            token_endpoint: `${origin}/oauth/token`,
            revocation_endpoint: `${origin}/oauth/revoke`,
            grant_types_supported: [
              "refresh_token",
              "urn:ietf:params:oauth:grant-type:device_code"
            ],
            smedc_launcher_minimum_version: "0.6.0",
            smedc_launcher_recommended_version: "0.6.0"
          })
        );
        return;
      }
      if (request.url === "/oauth/token" && request.method === "POST") {
        request.resume();
        request.on("end", () => {
          polls += 1;
          response.setHeader("content-type", "application/json");
          if (polls === 1) {
            response.statusCode = 400;
            response.end(JSON.stringify({ error: "authorization_pending" }));
            return;
          }
          if (polls === 2) {
            response.statusCode = 400;
            response.end(JSON.stringify({ error: "slow_down" }));
            return;
          }
          if (polls === 3) {
            response.statusCode = 400;
            response.end(JSON.stringify({ error: "expired_token" }));
            return;
          }
          response.end(
            JSON.stringify({
              access_token: "eh_at_device",
              token_type: "Bearer",
              expires_in: 600,
              refresh_token: "eh_rt_device"
            })
          );
        });
        return;
      }
      response.statusCode = 404;
      response.end();
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const origin = new URL(`https://127.0.0.1:${(server.address() as { port: number }).port}`);
    const client = new SmedcOAuthClient(origin, async (input, init) => {
      const rewritten = new URL(
        typeof input === "string" || input instanceof URL ? input.toString() : input.url
      );
      rewritten.protocol = "http:";
      return fetch(rewritten, init);
    });

    await expect(client.pollDeviceAuthorization("eh_dc_device")).resolves.toEqual({
      status: "pending"
    });
    await expect(client.pollDeviceAuthorization("eh_dc_device")).resolves.toEqual({
      status: "slow_down",
      intervalSeconds: 5
    });
    await expect(client.pollDeviceAuthorization("eh_dc_device")).resolves.toEqual({
      status: "expired"
    });
    await expect(client.pollDeviceAuthorization("eh_dc_device")).resolves.toMatchObject({
      status: "complete",
      accessToken: "eh_at_device",
      refreshToken: "eh_rt_device"
    });
  });
});
