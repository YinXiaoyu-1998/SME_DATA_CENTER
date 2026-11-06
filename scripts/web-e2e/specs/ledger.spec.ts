import { expect, test } from "@playwright/test";
import { login } from "../login-helper.js";

test("台账页加载上下文并渲染筛选与空列表", async ({ page }) => {
  await login(page, 1, "/ledger");
  await expect(page.getByRole("heading", { name: "台账下载中心", level: 1 })).toBeVisible();
  await expect(page.getByRole("combobox", { name: "门店精确名称" })).toBeVisible();
  await expect(page.getByRole("textbox", { name: "进货日期 · 起" })).toBeVisible();
  await expect(page.getByRole("textbox", { name: "进货日期 · 止" })).toBeVisible();
  await expect(page.getByRole("button", { name: "查询台账" })).toBeVisible();
  await expect(page.getByRole("table", { name: "台账文件" })).toBeVisible();
});

test("查询后显示本批数量与空结果", async ({ page }) => {
  await login(page, 1, "/ledger");
  await page.getByRole("button", { name: "查询台账" }).click();
  await expect(page.getByText(/本批 \d+ 项/)).toBeVisible();
});
