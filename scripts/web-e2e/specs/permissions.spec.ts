import { expect, test } from "@playwright/test";
import { login, ORG } from "../login-helper.js";

const TABS = ["类别密级", "门店与业务企业", "业务条件", "账号授权", "普通文档", "检查与启用"];

test("权限设置页展示全部区块", async ({ page }) => {
  await login(page, 0, `/admin/${ORG}/permissions`);
  await expect(page.getByRole("heading", { name: "权限设置", level: 1 })).toBeVisible();
  const tablist = page.getByRole("tablist", { name: "权限设置区域" });
  await expect(tablist).toBeVisible();
  for (const tab of TABS) {
    await expect(tablist.getByRole("tab", { name: tab })).toBeVisible();
  }
  await expect(page.getByRole("tab", { name: "类别密级" })).toHaveAttribute(
    "aria-selected",
    "true"
  );
});

test("切换区块后停留在同一组织的权限页", async ({ page }) => {
  await login(page, 0, `/admin/${ORG}/permissions`);
  await page.getByRole("tab", { name: "账号授权" }).click();
  await expect(page.getByRole("tab", { name: "账号授权" })).toHaveAttribute(
    "aria-selected",
    "true"
  );
  await expect(page).toHaveURL(new RegExp(`/admin/${ORG}/permissions`));
});

test("准备检查区块能看到启用前的缺项或就绪状态", async ({ page }) => {
  await login(page, 0, `/admin/${ORG}/permissions`);
  await page.getByRole("tab", { name: "检查与启用" }).click();
  await expect(page.getByRole("tabpanel", { name: "检查与启用" })).toBeVisible();
});
