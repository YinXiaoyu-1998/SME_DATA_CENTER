import { expect, test } from "@playwright/test";
import { E2E_ACCOUNTS, E2E_PASSWORD } from "../seed-passwords.js";

const ORG = "default-org";

/**
 * 登录是唯一入口，也是所有页面守卫的前提：
 * 未登录必须落到 /login 并带上 next，登录后回到原路径。
 */
test("未登录访问受保护页面会跳到登录页并保留 next", async ({ page }) => {
  await page.goto(`/admin/${ORG}/permissions`);
  await expect(page).toHaveURL(/\/login\?next=/);
  await expect(page.getByRole("heading", { name: "登录 SMEDC" })).toBeVisible();
});

test("管理员登录后回到原权限页面并看到两段导航", async ({ page }) => {
  await page.goto(`/admin/${ORG}/permissions`);
  await page.getByLabel("邮箱").fill(E2E_ACCOUNTS[0].email);
  await page.getByLabel("密码").fill(E2E_PASSWORD);
  await page.getByRole("button", { name: "登录" }).click();

  await expect(page).toHaveURL(new RegExp(`/admin/${ORG}/permissions$`));
  await expect(page.getByRole("link", { name: "管理设置" })).toBeVisible();
  await expect(page.getByRole("link", { name: "台账下载中心" })).toBeVisible();
  await expect(page.getByRole("link", { name: "权限设置" })).toBeVisible();
  await expect(page.getByRole("link", { name: "自动任务" })).toBeVisible();
});
