import { Script } from "node:vm";
import { expect, it } from "vitest";
import { renderLedgerPage, renderLedgerLogin } from "./ledger-pages.js";
import { ledgerCopy } from "./ledger-copy.js";
const limits = {
  files: 5000,
  stores: 50,
  dates: 366,
  bytes: 1073741824,
  pageSize: 200,
  deadlineMs: 600000,
  retentionMs: 86400000
};
it("ships the localized responsive download workspace with executable real client code and safe config", async () => {
  const html = renderLedgerPage({ nonce: "nonce_example", limits });
  expect(html).toContain('id="ledger-filter"');
  expect(html).toContain('id="ledger-preview-frame"');
  expect(html).toContain('id="ledger-selection-dialog"');
  expect(html).toContain('id="ledger-task-dialog"');
  expect(html).toContain("已加载门店");
  expect(html).toContain("smedc-locale");
  expect(html).toContain('lang="zh-CN"');
  const module = await import("./ledger-client.js").catch(() => null);
  expect(module).not.toBeNull();
  expect(() => new Script(module!.ledgerClientSource)).not.toThrow();
  expect(module!.ledgerClientSource).not.toContain("innerHTML");
  expect(module!.ledgerClientSource).not.toContain("localStorage");
  for (const [, key] of module!.ledgerClientSource.matchAll(
    /(?:text|button|label)\("([A-Za-z_]+)"/g
  ))
    expect(ledgerCopy).toHaveProperty(key!);
  for (const value of Object.values(ledgerCopy)) {
    expect(value.zh.trim()).not.toBe("");
    expect(value.en.trim()).not.toBe("");
  }
  const login = renderLedgerLogin({ nonce: "nonce_example", csrfToken: '<secret"' });
  expect(login).not.toContain('<secret"');
  expect(login).toContain('action="/ledger-pdfs/login"');
});
