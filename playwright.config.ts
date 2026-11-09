import { defineConfig } from "@playwright/test";

/**
 * 浏览器端到端只覆盖真实用户路径，不进默认 npm test。
 * 需要先按 scripts/web-e2e/README.md 起好 API 与静态站点。
 */
export default defineConfig({
  testDir: "./scripts/web-e2e/specs",
  timeout: 30_000,
  expect: { timeout: 5_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [["list"]],
  use: {
    baseURL: process.env["WEB_E2E_BASE_URL"] ?? "http://localhost:5300",
    trace: "retain-on-failure",
    locale: "zh-CN"
  }
});
