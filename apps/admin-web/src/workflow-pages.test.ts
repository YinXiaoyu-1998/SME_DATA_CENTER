import { Script } from "node:vm";
import { expect, it } from "vitest";

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
