import { createServer } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { EnterpriseHubOAuthClient, mapOAuthError } from "./oauth-client.js";

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

  it("uses the server OAuth metadata and interoperable form contract for code exchange", async () => {
    let tokenRequest: { body: URLSearchParams; launcherVersion?: string } | undefined;
    const server = createServer((request, response) => {
      const origin = `https://127.0.0.1:${(server.address() as { port: number }).port}`;
      if (request.url === "/.well-known/oauth-authorization-server") {
        response.setHeader("content-type", "application/json");
        response.end(
          JSON.stringify({
            issuer: origin,
            authorization_endpoint: `${origin}/oauth/authorize`,
            token_endpoint: `${origin}/oauth/token`,
            revocation_endpoint: `${origin}/oauth/revoke`,
            response_types_supported: ["code"],
            grant_types_supported: ["authorization_code", "refresh_token"],
            code_challenge_methods_supported: ["S256"],
            enterprise_hub_launcher_minimum_version: "0.1.0",
            enterprise_hub_launcher_recommended_version: "0.1.0"
          })
        );
        return;
      }
      if (request.url === "/oauth/token" && request.method === "POST") {
        let body = "";
        request.setEncoding("utf8");
        request.on("data", (chunk: string) => {
          body += chunk;
        });
        request.on("end", () => {
          tokenRequest = {
            body: new URLSearchParams(body),
            launcherVersion: request.headers["x-enterprise-hub-launcher-version"] as
              string | undefined
          };
          response.setHeader("content-type", "application/json");
          response.setHeader("cache-control", "no-store");
          response.end(
            JSON.stringify({
              access_token: "eh_at_test",
              token_type: "Bearer",
              expires_in: 600,
              refresh_token: "eh_rt_test"
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
    const client = new EnterpriseHubOAuthClient(origin, async (input, init) => {
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
    const callbackParameters = client.validateCallback(
      new URL("http://127.0.0.1:43121/oauth/callback?code=eh_ac_test&state=expected-state"),
      "expected-state"
    );
    const token = await client.exchange(
      callbackParameters,
      new URL("http://127.0.0.1:43121/oauth/callback"),
      "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-._~"
    );

    expect(metadata).toMatchObject({ compatible: true, recommendedUpdateAvailable: false });
    expect(token).toMatchObject({ accessToken: "eh_at_test", refreshToken: "eh_rt_test" });
    expect(tokenRequest?.launcherVersion).toBe("0.1.1");
    expect(Object.fromEntries(tokenRequest!.body)).toMatchObject({
      grant_type: "authorization_code",
      client_id: "enterprise-hub-desktop-launcher",
      code: "eh_ac_test",
      redirect_uri: "http://127.0.0.1:43121/oauth/callback"
    });
    expect(tokenRequest?.body.get("code_verifier")).toHaveLength(66);
  });
});
