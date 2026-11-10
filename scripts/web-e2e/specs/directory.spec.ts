import { randomUUID } from "node:crypto";
import { expect, test } from "@playwright/test";
import { login, ORG } from "../login-helper.js";

test("an administrator without employee read access can create a directory record", async ({
  page
}) => {
  const route = `/admin/${ORG}/directory`;
  const enterprise = `E2E 员工档案企业 ${randomUUID().slice(0, 8)}`;
  await login(page, 0, route);

  const session = await page.request.get("/api/web/v1/session");
  expect(session.ok()).toBe(true);
  const { csrfToken } = (await session.json()) as { csrfToken: string };
  const enterprisesPath = `/api/web/v1/orgs/${ORG}/permissions/enterprises`;
  const current = await page.request.get(enterprisesPath);
  expect(current.ok()).toBe(true);
  const { authorizationVersion } = (await current.json()) as { authorizationVersion: string };
  const declare = await page.request.post(enterprisesPath, {
    headers: { origin: new URL(page.url()).origin, "x-csrf-token": csrfToken },
    data: { expectedVersion: authorizationVersion, name: enterprise }
  });
  expect(declare.ok()).toBe(true);

  await page.reload();
  await expect(page.getByRole("heading", { name: "企业资料" })).toBeVisible();
  await page.getByLabel("当前业务企业").selectOption({ label: enterprise });
  await page.getByRole("button", { name: "部门目录" }).click();
  await page.getByLabel("新部门名称").fill("合成前厅");
  await page.getByRole("button", { name: "新增部门" }).click();
  await expect(page.getByRole("cell", { name: "合成前厅" })).toBeVisible();

  await page.getByRole("button", { name: "员工档案" }).click();
  await expect(page.getByText("当前没有员工档案读取权限。仍可尝试新增。")).toBeVisible();
  await page.getByRole("button", { name: "新增员工" }).click();
  const form = page.getByRole("heading", { name: "新增员工" }).locator("xpath=..");
  await form.getByLabel("姓名").fill("合成员工");
  await form.getByLabel("部门").selectOption({ label: "合成前厅" });
  await form.getByLabel("归属").selectOption("group");
  await form.getByRole("button", { name: "保存" }).click();

  await expect(page.getByText("员工档案标识", { exact: false })).toBeVisible();
  await expect(page.getByRole("cell", { name: "合成员工" })).toHaveCount(0);
});
