import { describe, expect, it } from "vitest";
import {
  OAUTH_CLIENT_ID,
  PASSWORD_SETUP_COOKIE,
  authorizationRequest,
  cookieValue,
  csrfTokenForSecret,
  hostOnlyCookie,
  matchesCsrfToken,
  oauthMetadata,
  pkceChallengeForVerifier
} from "./http-contract.js";

describe("official OAuth HTTP contract", () => {
  const validQuery = {
    response_type: "code",
    client_id: OAUTH_CLIENT_ID,
    redirect_uri: "http://127.0.0.1:43123/oauth/callback",
    state: "state_value-with-enough-entropy",
    code_challenge: "A".repeat(43),
    code_challenge_method: "S256"
  };

  it("accepts only the fixed client and exact IPv4 loopback callback shape", () => {
    expect(authorizationRequest(validQuery)).toEqual({
      clientId: OAUTH_CLIENT_ID,
      redirectUri: validQuery.redirect_uri,
      state: validQuery.state,
      pkceChallenge: validQuery.code_challenge
    });

    for (const redirectUri of [
      "http://localhost:43123/oauth/callback",
      "http://[::1]:43123/oauth/callback",
      "http://127.0.0.1/oauth/callback",
      "http://127.0.0.1:43123/other",
      "http://127.0.0.1:43123/oauth/callback?x=1",
      "https://127.0.0.1:43123/oauth/callback",
      "http://user@127.0.0.1:43123/oauth/callback"
    ]) {
      expect(() => authorizationRequest({ ...validQuery, redirect_uri: redirectUri })).toThrow(
        "invalid OAuth authorization request"
      );
    }
  });

  it("rejects client, response type, state, or PKCE deviations", () => {
    const invalid = [
      { ...validQuery, client_id: "other-client" },
      { ...validQuery, response_type: "token" },
      { ...validQuery, state: "short" },
      { ...validQuery, code_challenge_method: "plain" },
      { ...validQuery, code_challenge: "not+base64/url" }
    ];

    for (const query of invalid) {
      expect(() => authorizationRequest(query)).toThrow("invalid OAuth authorization request");
    }
  });

  it("uses bounded host-only secure cookies and parses them exactly", () => {
    const header = hostOnlyCookie(PASSWORD_SETUP_COOKIE, "eh_pss_secret", 600);

    expect(header).toBe(
      "__Host-eh_password_setup=eh_pss_secret; Max-Age=600; Path=/; HttpOnly; Secure; SameSite=Lax"
    );
    expect(cookieValue(header, PASSWORD_SETUP_COOKIE)).toBe("eh_pss_secret");
    expect(cookieValue(`${header}; other=value`, "other")).toBe("value");
    expect(() => hostOnlyCookie(PASSWORD_SETUP_COOKIE, "bad; injected=true", 600)).toThrow(
      "invalid cookie value"
    );
  });

  it("derives a separate constant-time CSRF value from the HttpOnly transaction secret", () => {
    const csrf = csrfTokenForSecret("eh_tx_private");

    expect(csrf).not.toContain("eh_tx_private");
    expect(matchesCsrfToken("eh_tx_private", csrf)).toBe(true);
    expect(matchesCsrfToken("eh_tx_private", `${csrf}x`)).toBe(false);
    expect(matchesCsrfToken("other", csrf)).toBe(false);
  });

  it("derives S256 from a bounded verifier and publishes fixed OAuth metadata", () => {
    const verifier = "v".repeat(43);

    expect(pkceChallengeForVerifier(verifier)).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(() => pkceChallengeForVerifier("short")).toThrow("invalid PKCE verifier");
    expect(() => pkceChallengeForVerifier(`${"v".repeat(42)}+`)).toThrow("invalid PKCE verifier");

    expect(oauthMetadata("https://api.smedatacenter.xyz")).toEqual({
      issuer: "https://api.smedatacenter.xyz",
      authorization_endpoint: "https://api.smedatacenter.xyz/oauth/authorize",
      device_authorization_endpoint: "https://api.smedatacenter.xyz/oauth/device_authorization",
      token_endpoint: "https://api.smedatacenter.xyz/oauth/token",
      revocation_endpoint: "https://api.smedatacenter.xyz/oauth/revoke",
      response_types_supported: ["code"],
      grant_types_supported: [
        "authorization_code",
        "refresh_token",
        "urn:ietf:params:oauth:grant-type:device_code"
      ],
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["none"],
      enterprise_hub_launcher_package: "enterprise-hub-mcp-launcher",
      enterprise_hub_launcher_minimum_version: "0.1.0",
      enterprise_hub_launcher_recommended_version: "0.2.6"
    });
    expect(() => oauthMetadata("http://api.smedatacenter.xyz")).toThrow(
      "public origin must be canonical HTTPS"
    );
    expect(() => oauthMetadata("https://api.smedatacenter.xyz/path")).toThrow(
      "public origin must be canonical HTTPS"
    );
  });
});
