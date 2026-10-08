import { describe, expect, it } from "vitest";
import {
  PASSWORD_SETUP_COOKIE,
  cookieValue,
  csrfTokenForSecret,
  hostOnlyCookie,
  matchesCsrfToken,
  oauthMetadata
} from "./http-contract.js";

describe("official OAuth HTTP contract", () => {
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
    const csrf = csrfTokenForSecret("csrf_private");

    expect(csrf).not.toContain("csrf_private");
    expect(matchesCsrfToken("csrf_private", csrf)).toBe(true);
    expect(matchesCsrfToken("csrf_private", `${csrf}x`)).toBe(false);
    expect(matchesCsrfToken("other", csrf)).toBe(false);
  });

  it("publishes only the current device authorization metadata", () => {
    expect(oauthMetadata("https://api.smedatacenter.xyz")).toEqual({
      issuer: "https://api.smedatacenter.xyz",
      device_authorization_endpoint: "https://api.smedatacenter.xyz/oauth/device_authorization",
      token_endpoint: "https://api.smedatacenter.xyz/oauth/token",
      revocation_endpoint: "https://api.smedatacenter.xyz/oauth/revoke",
      grant_types_supported: ["refresh_token", "urn:ietf:params:oauth:grant-type:device_code"],
      token_endpoint_auth_methods_supported: ["none"],
      smedc_launcher_package: "smedc-mcp-launcher",
      smedc_launcher_minimum_version: "0.6.0",
      smedc_launcher_recommended_version: "0.8.2"
    });
    expect(() => oauthMetadata("http://api.smedatacenter.xyz")).toThrow(
      "public origin must be canonical HTTPS"
    );
    expect(() => oauthMetadata("https://api.smedatacenter.xyz/path")).toThrow(
      "public origin must be canonical HTTPS"
    );
  });
});
