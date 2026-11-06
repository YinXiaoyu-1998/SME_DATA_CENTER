import { expect, test } from "@playwright/test";
import { login, ORG } from "../login-helper.js";

/** 自动任务页：企业选择、来源、设置、授权、控制与只读状态。 */
test("从权限页切到自动任务并渲染页面结构", async ({ page }) => {
  await login(page, 0, `/admin/${ORG}/permissions`);
  await page.getByRole("link", { name: "自动任务" }).click();
  await expect(page).toHaveURL(new RegExp(`/admin/${ORG}/workflows`));
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  await expect(page.getByRole("region").first()).toBeVisible();
});

test("深链直接打开自动任务页", async ({ page }) => {
  await login(page, 0, `/admin/${ORG}/workflows`);
  await expect(page).toHaveURL(new RegExp(`/admin/${ORG}/workflows`));
  await expect(page.getByRole("link", { name: "自动任务" })).toHaveAttribute(
    "aria-current",
    "page"
  );
});
