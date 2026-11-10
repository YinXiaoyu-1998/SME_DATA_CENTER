import { expect, type Page } from "@playwright/test";

export const ORG = "default-org";

/** 与 seed-passwords.ts 保持一致；单独放常量，避免把 Prisma 拖进浏览器测试进程。 */
export const E2E_PASSWORD = "smedc-e2e-password-2026";
export const E2E_ACCOUNTS = [
  { userAccountId: "emp_admin", email: "admin@example.com" },
  { userAccountId: "emp_baoli_employee", email: "baoli.employee@example.com" },
  { userAccountId: "emp_suzhou_employee", email: "suzhou.employee@example.com" }
] as const;

export async function login(page: Page, accountIndex: 0 | 1 | 2, next = "/") {
  await page.goto(`/login?next=${encodeURIComponent(next)}`);
  await page.getByLabel("邮箱").fill(E2E_ACCOUNTS[accountIndex].email);
  await page.getByLabel("密码").fill(E2E_PASSWORD);
  await page.getByRole("button", { name: "登录" }).click();
  await expect(page).not.toHaveURL(/\/login/);
}
