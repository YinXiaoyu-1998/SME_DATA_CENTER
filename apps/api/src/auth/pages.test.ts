import { describe, expect, it } from "vitest";
import {
  authPageHeaders,
  renderDeviceVerificationPage,
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

  it("renders Chinese by default with a persistent Chinese-English switch", () => {
    const html = renderDeviceVerificationPage({
      csrfToken: "csrf-device",
      userCode: "ABCDEFGH",
      instanceName: "agent-a",
      instanceHostname: "vps-1",
      nonce: "device-nonce",
      error: {
        zh: "邮箱或密码错误。",
        en: "The email or password is incorrect."
      }
    });

    expect(html).toContain('<html lang="zh-CN">');
    expect(html).toContain('data-locale-option="zh-CN"');
    expect(html).toContain('data-locale-option="en"');
    expect(html).toContain("smedc-locale");
    expect(html).toContain("登录 SMEDC");
    expect(html).toContain("Sign in to SMEDC");
    expect(html).toContain("邮箱或密码错误。");
    expect(html).toContain("The email or password is incorrect.");
    expect(html).toContain("agent-a");
    expect(html).toContain("vps-1");
    expect(html).toContain('action="/oauth/device/verify/login"');
    expect(html).toContain('name="userCode" value="ABCDEFGH"');
    expect(html).toContain('autocomplete="username"');
    expect(html).toContain('autocomplete="current-password"');
  });

  it("escapes pairing metadata so agent-declared names cannot inject markup", () => {
    const html = renderDeviceVerificationPage({
      csrfToken: "csrf-device",
      userCode: "ABCDEFGH",
      instanceName: `<img src=x onerror=alert(1)>`,
      instanceHostname: "vps-1",
      nonce: "device-nonce"
    });

    expect(html).toContain("&lt;img src=x onerror=alert(1)&gt;");
    expect(html).not.toContain("<img src=x onerror=alert(1)>");
  });

  it("clears the setup fragment before posting the one-time token", () => {
    const html = renderPasswordSetupBootstrapPage({ nonce: "setup-nonce" });

    expect(html).toContain("正在准备密码设置…");
    expect(html).toContain("Preparing password setup…");
    expect(html).toContain('window.history.replaceState(null, "", window.location.pathname)');
    expect(html).toContain('form.action = "/auth/password/setup/session"');
    expect(html).toContain('input.name = "token"');
    expect(html).not.toContain("innerHTML");
  });

  it("renders an accessible password setup form without echoing secrets", () => {
    const html = renderPasswordSetupForm({
      csrfToken: "csrf-setup",
      nonce: "form-nonce",
      error: { zh: "两次输入的密码不一致。", en: "Passwords do not match." },
      account: {
        displayName: `殷啸宇 <script>alert(1)</script>`,
        email: "yxy@example.invalid",
        organizationName: "麦家小馆",
        role: "admin"
      }
    });

    expect(html).toContain("显示名称");
    expect(html).toContain("Display name");
    expect(html).toContain("殷啸宇 &lt;script&gt;alert(1)&lt;/script&gt;");
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("yxy@example.invalid");
    expect(html).toContain("麦家小馆");
    expect(html).toContain("Role");
    expect(html).toContain("管理员");
    expect(html).toContain("Admin");
    expect(html).toContain('<label for="password">');
    expect(html).toContain("New password");
    expect(html).toContain('<label for="passwordConfirmation">');
    expect(html).toContain("Confirm new password");
    expect(html).toContain('autocomplete="new-password"');
    expect(html).toContain("Passwords do not match.");
    expect(html).not.toContain("eh_ps_");
  });
});
