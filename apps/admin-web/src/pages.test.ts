import { describe, expect, it } from "vitest";

describe("permissions browser pages", () => {
  it("renders Chinese initially with bilingual titles, accessible language switching and escaped business names", async () => {
    const module = await import("./pages.js").catch(() => null);
    expect(module, "permissions HTML must exist").not.toBeNull();
    const html = module!.renderPermissionsPage({
      nonce: "abcdefgh12345678",
      orgId: "org_a",
      organizationName: '<script>alert("x")</script>',
      employeeName: "管理员",
      csrfToken: "public-csrf"
    });
    expect(html).toContain('<html lang="zh-CN">');
    expect(html).toContain("权限设置");
    expect(html).toContain("Permissions");
    expect(html).toContain("smedc-locale");
    expect(html).not.toContain('<script>alert("x")</script>');
    expect(html).not.toContain("navigator.language");
    expect(html).toContain('data-locale-option="en"');
  });
  it("renders a generic bilingual login form and only the bounded local action", async () => {
    const module = await import("./pages.js").catch(() => null);
    expect(module).not.toBeNull();
    const html = module!.renderPermissionsLogin({
      nonce: "abcdefgh12345678",
      orgId: "org_a",
      csrfToken: "public-csrf",
      error: "invalid"
    });
    expect(html).toContain('action="/admin/permissions/org_a/login"');
    expect(html).toContain('name="password"');
    expect(html).toContain("邮箱或密码错误");
    expect(html).toContain("email or password is incorrect");
    expect(html).toContain("novalidate");
    expect(html).not.toContain("returnTo");
  });
});
