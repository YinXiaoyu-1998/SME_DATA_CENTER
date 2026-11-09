import { expect, test } from "@playwright/test";
import { login, ORG } from "../login-helper.js";

/** 组织与角色边界：导航只按服务端判定渲染，跨组织与越权都在服务端拒绝。 */
test("普通员工只看到台账下载中心", async ({ page }) => {
  await login(page, 1, "/ledger");
  await expect(page.getByRole("link", { name: "台账下载中心" })).toBeVisible();
  await expect(page.getByRole("link", { name: "管理设置" })).toHaveCount(0);
});

test("普通员工直接打开管理设置会被拒绝", async ({ page }) => {
  await login(page, 1, `/admin/${ORG}/permissions`);
  await expect(page.getByText(/无权访问|无访问权限/).first()).toBeVisible();
});

test("管理员能看到管理设置与台账两段导航", async ({ page }) => {
  await login(page, 0, "/ledger");
  await expect(page.getByRole("link", { name: "管理设置" })).toBeVisible();
  await expect(page.getByRole("link", { name: "台账下载中心" })).toBeVisible();
});

test("跨组织管理员打开别的组织会被拒绝", async ({ page }) => {
  await login(page, 0, "/admin/other-org/permissions");
  await expect(page.getByText(/无权访问|无访问权限/).first()).toBeVisible();
});
