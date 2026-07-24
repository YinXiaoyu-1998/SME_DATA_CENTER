import { describe, expect, it } from "vitest";
import {
  authPageHeaders,
  renderLoginPage,
  renderPasswordSetupBootstrapPage,
  renderPasswordSetupForm
} from "./pages.js";

describe("official authentication browser pages", () => {
  it("returns strict browser security headers", () => {
    expect(authPageHeaders("nonce-value")).toEqual({
      "cache-control": "no-store",
      "content-security-policy":
        "default-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'; script-src 'nonce-nonce-value'; style-src 'nonce-nonce-value'",
      "permissions-policy": "camera=(), microphone=(), geolocation=()",
      "referrer-policy": "no-referrer",
      "x-content-type-options": "nosniff",
      "x-frame-options": "DENY"
    });
  });

  it("escapes login errors and CSRF values while preserving accessible labels", () => {
    const html = renderLoginPage({
      csrfToken: `csrf"><script>alert(1)</script>`,
      error: `<img src=x onerror=alert(1)>`,
      nonce: "login-nonce"
    });

    expect(html).toContain('<label for="email">Email</label>');
    expect(html).toContain('<label for="password">Password</label>');
    expect(html).toContain('autocomplete="username"');
    expect(html).toContain('autocomplete="current-password"');
    expect(html).toContain("&lt;img src=x onerror=alert(1)&gt;");
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).not.toContain("<img src=x onerror=alert(1)>");
  });

  it("clears the setup fragment before posting the one-time token", () => {
    const html = renderPasswordSetupBootstrapPage({ nonce: "setup-nonce" });

    expect(html).toContain('window.history.replaceState(null, "", window.location.pathname)');
    expect(html).toContain('form.action = "/auth/password/setup/session"');
    expect(html).toContain('input.name = "token"');
    expect(html).not.toContain("innerHTML");
  });

  it("renders an accessible password setup form without echoing secrets", () => {
    const html = renderPasswordSetupForm({
      csrfToken: "csrf-setup",
      nonce: "form-nonce",
      error: "Passwords do not match."
    });

    expect(html).toContain('<label for="password">New password</label>');
    expect(html).toContain('<label for="passwordConfirmation">Confirm new password</label>');
    expect(html).toContain('autocomplete="new-password"');
    expect(html).toContain("Passwords do not match.");
    expect(html).not.toContain("eh_ps_");
  });
});
