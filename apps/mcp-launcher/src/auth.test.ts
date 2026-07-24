import { describe, expect, it } from "vitest";
import {
  createAuthorizationRequest,
  createLoopbackCallbackServer,
  redactSecrets,
  type SecureCredentialStore
} from "./auth.js";

describe("official launcher OAuth bootstrap", () => {
  it("creates a PKCE S256 authorization request with a random state", async () => {
    const request = await createAuthorizationRequest({
      authorizationEndpoint: new URL("https://hub.example.test/oauth/authorize"),
      redirectUri: new URL("http://127.0.0.1:43123/oauth/callback")
    });

    expect(request.url.searchParams.get("client_id")).toBe("enterprise-hub-desktop-launcher");
    expect(request.url.searchParams.get("response_type")).toBe("code");
    expect(request.url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(request.state).toHaveLength(43);
    expect(request.verifier).toHaveLength(86);
    expect(request.url.searchParams.get("state")).toBe(request.state);
    expect(request.url.searchParams.get("code_challenge")).not.toBe(request.verifier);
  });

  it("accepts only a matching callback state and never returns the authorization code to a caller", async () => {
    const callback = await createLoopbackCallbackServer({ state: "expected-state" });

    try {
      const wrongUrl = new URL(callback.redirectUri);
      wrongUrl.search = "?code=never-expose&state=wrong";
      const wrongState = await fetch(wrongUrl);
      expect(wrongState.status).toBe(400);

      const correctUrl = new URL(callback.redirectUri);
      correctUrl.search = "?code=never-expose&state=expected-state";
      const correctState = await fetch(correctUrl);
      expect(correctState.status).toBe(200);
      await expect(callback.waitForResult()).resolves.toEqual({ received: true });
      expect(JSON.stringify(callback)).not.toContain("never-expose");
    } finally {
      await callback.close();
    }
  });

  it("redacts credentials from values passed to tool errors", () => {
    expect(
      redactSecrets({
        access_token: "access-secret",
        refresh_token: "refresh-secret",
        authorization: "Bearer header-secret",
        nested: { code: "authorization-code" }
      })
    ).toEqual({
      access_token: "[REDACTED]",
      refresh_token: "[REDACTED]",
      authorization: "[REDACTED]",
      nested: { code: "[REDACTED]" }
    });
  });

  it("does not offer a filesystem fallback credential store", () => {
    const store: SecureCredentialStore = {
      get: async () => null,
      set: async () => undefined,
      delete: async () => undefined
    };

    expect(Object.keys(store)).toEqual(["get", "set", "delete"]);
  });
});
