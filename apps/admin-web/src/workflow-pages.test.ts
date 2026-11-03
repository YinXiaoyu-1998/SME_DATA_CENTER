import { Script, runInNewContext } from "node:vm";
import { expect, it, vi } from "vitest";

it("renders bilingual enterprise-bound workflow settings without exposing untrusted markup or persistent drafts", async () => {
  const { renderWorkflowPage } = await import("./workflow-pages.js");
  const { workflowClientSource } = await import("./workflow-client.js");
  const { workflowCopy } = await import("./workflow-copy.js");
  const html = renderWorkflowPage({
    nonce: "abcdefgh12345678",
    orgId: "org_a",
    enterpriseKey: "business-a",
    organizationName: "<script>bad()</script>",
    employeeName: "Admin",
    csrfToken: "csrf"
  });
  expect(html).toContain('<html lang="zh-CN">');
  expect(html).toContain("自动任务");
  expect(html).toContain("Automatic tasks");
  expect(html).not.toContain("<script>bad()</script>");
  expect(() => new Script(workflowClientSource)).not.toThrow();
  expect(workflowClientSource).not.toMatch(/innerHTML|localStorage|sessionStorage/);
  for (const [, key] of workflowClientSource.matchAll(
    /(?:pair|button|field|heading|notice|check)\("([A-Za-z_]+)"/g
  ))
    expect(workflowCopy).toHaveProperty(key!);
  for (const value of Object.values(workflowCopy)) {
    expect(value.zh.trim()).not.toBe("");
    expect(value.en.trim()).not.toBe("");
  }
});

it("switches the mounted settings panels in place and follows browser history", async () => {
  const { settingsNavigationSource } = await import("./pages.js");
  const handlers = new Map<string, (event: object) => void>();
  const base = "/admin/permissions/org_a";
  const panels = { permissions: { hidden: false }, workflows: { hidden: true } };
  const links = Object.keys(panels).map((panel, index) => ({
    pathname: index === 0 ? base : base + "/workflows",
    get href() {
      return this.pathname;
    },
    dataset: { settingsPanel: panel },
    addEventListener: (_type: string, handler: (event: object) => void) =>
      handlers.set(panel, handler),
    setAttribute: vi.fn(),
    removeAttribute: vi.fn()
  }));
  const location = { pathname: base };
  const history = {
    pushState: vi.fn((_state: unknown, _title: string, path: string) => {
      location.pathname = path;
    })
  };
  runInNewContext(settingsNavigationSource, {
    document: {
      getElementById: (id: string) =>
        id === "settings-navigation"
          ? { querySelectorAll: () => links }
          : panels[id as keyof typeof panels]
    },
    window: {
      addEventListener: (event: string, handler: (event: object) => void) =>
        handlers.set(event, handler)
    },
    location,
    history
  });
  const preventDefault = vi.fn();
  handlers.get("workflows")!({ button: 0, preventDefault });
  expect(preventDefault).toHaveBeenCalledOnce();
  expect(history.pushState).toHaveBeenCalledWith(null, "", base + "/workflows");
  expect(panels).toEqual({ permissions: { hidden: true }, workflows: { hidden: false } });
  expect(links[1]!.setAttribute).toHaveBeenCalledWith("aria-current", "page");
  location.pathname = base;
  handlers.get("popstate")!({});
  expect(panels).toEqual({ permissions: { hidden: false }, workflows: { hidden: true } });
});
