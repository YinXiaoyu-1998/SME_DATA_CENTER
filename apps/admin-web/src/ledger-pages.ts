import { ledgerCopy } from "./ledger-copy.js";
import { ledgerStyles } from "./ledger-styles.js";
import { ledgerClientSource } from "./ledger-client.js";
import { escapeHtml, localized, shell } from "./pages.js";
export interface LedgerWebLimits {
  files: number;
  bytes: number;
  stores: number;
  dates: number;
  pageSize: number;
  deadlineMs: number;
  retentionMs: number;
}
export function renderLedgerLogin(options: {
  nonce: string;
  csrfToken: string;
  error?: boolean;
}): string {
  return shell(
    { nonce: options.nonce, title: { zh: "登录 · 台账 PDF", en: "Sign in · Ledger PDFs" } },
    `<main class="login"><section class="panel"><h1>${localized({ zh: "登录台账下载中心", en: "Sign in to ledger downloads" })}</h1><p>${localized({ zh: "使用你的 SMEDC 员工或管理员账号。登录后可返回原页面继续操作。", en: "Use your SMEDC employee or administrator account. Return to your original page after signing in." })}</p>${options.error ? `<p role="alert">${localized({ zh: "登录失败或安全校验已过期，请重试。", en: "Sign-in failed or the security check expired. Please retry." })}</p>` : ""}<form method="post" action="/ledger-pdfs/login" data-login novalidate><input type="hidden" name="csrfToken" value="${escapeHtml(options.csrfToken)}"><label for="email">${localized({ zh: "邮箱", en: "Email" })}</label><input id="email" name="email" type="email" autocomplete="username" maxlength="320" required><label for="password">${localized({ zh: "密码", en: "Password" })}</label><input id="password" name="password" type="password" autocomplete="current-password" required><p id="login-validation" role="alert" hidden>${localized({ zh: "请填写有效邮箱和密码（最多 128 个字符）。", en: "Enter a valid email and password (up to 128 characters)." })}</p><button type="submit">${localized({ zh: "登录", en: "Sign in" })}</button></form></section></main>`
  );
}
export function renderLedgerPage(options: { nonce: string; limits: LedgerWebLimits }): string {
  const t = (key: keyof typeof ledgerCopy) => localized(ledgerCopy[key]);
  const dialog = (name: string, title: keyof typeof ledgerCopy) =>
    `<dialog class="ledger-dialog" id="ledger-${name}-dialog" aria-labelledby="ledger-${name}-title"><div class="ledger-card-head"><h2 id="ledger-${name}-title">${t(title)}</h2><button type="button" class="secondary" data-close="${name}">${t("close")}</button></div><div class="ledger-dialog-body" id="ledger-${name}-body"></div><div class="ledger-dialog-foot" id="ledger-${name}-foot"></div></dialog>`;
  return shell(
    {
      nonce: options.nonce,
      styles: ledgerStyles,
      title: { zh: "台账 PDF · SMEDC", en: "Ledger PDFs · SMEDC" }
    },
    `<main class="ledger-main">
  <section class="ledger-heading"><div><span class="eyebrow">SMEDC / PDF</span><h1>${t("title")}</h1><p class="muted">${t("intro")}</p></div><div class="ledger-identity"><div id="ledger-identity"></div><button id="ledger-logout" class="secondary" type="button">${t("signOut")}</button></div></section>
  <section id="ledger-session" class="ledger-session" role="status" hidden><p id="ledger-session-text"></p><div class="actions"><a href="/ledger-pdfs/login" target="_blank" rel="noopener" id="ledger-login">${t("signIn")}</a><button id="ledger-resume" type="button" class="secondary">${t("refresh")}</button></div></section>
  <form class="ledger-filters" id="ledger-filter" novalidate><div class="ledger-filter-grid"><div><label for="ledger-store">${t("store")}</label><input id="ledger-store" name="store" list="ledger-stores" maxlength="512" autocomplete="off" aria-describedby="ledger-store-help"><datalist id="ledger-stores"></datalist><small id="ledger-store-help">${t("loadedStores")}</small></div><div><label for="ledger-start">${t("startDate")}</label><input id="ledger-start" name="start" type="date" required></div><div><label for="ledger-end">${t("endDate")}</label><input id="ledger-end" name="end" type="date" required></div><button id="ledger-search" type="submit">${t("search")}</button></div><div class="ledger-filter-hint">${t("allStores")}<br>${t("access")}</div><p id="ledger-query-error" class="error" role="alert" hidden></p></form>
  <div class="ledger-workspace"><section class="ledger-card"><div class="ledger-card-head"><h2>${t("list")}</h2><small id="ledger-list-note"></small></div><div class="ledger-table" id="ledger-results" aria-busy="false"><table><thead><tr><th><input id="ledger-all" type="checkbox" aria-label="全选本批可选文件" data-aria-zh="全选本批可选文件" data-aria-en="Select available files in this batch"></th><th>${t("store")}</th><th>${t("date")}</th><th>${t("status")}</th><th>${t("size")}</th><th>${t("actions")}</th></tr></thead><tbody id="ledger-rows"></tbody></table><p class="empty" id="ledger-empty">${t("initial")}</p></div><div class="ledger-pagination"><button type="button" class="secondary" id="ledger-prev">${t("previous")}</button><span id="ledger-batch"></span><button type="button" class="secondary" id="ledger-next">${t("next")}</button></div></section>
  <aside class="ledger-card ledger-preview" aria-labelledby="ledger-preview-title"><div class="ledger-card-head"><h2 id="ledger-preview-title">${t("previewTitle")}</h2><button type="button" class="secondary" id="ledger-preview-close">${t("close")}</button></div><div id="ledger-preview-info" class="ledger-preview-body"></div><div id="ledger-preview-frame"><p class="empty">${t("previewEmpty")}</p></div><div class="ledger-preview-footer"><p>${t("viewerHint")}</p><div id="ledger-preview-actions" class="ledger-actions"></div></div></aside></div>
  <details class="ledger-card ledger-records"><summary>${t("records")}</summary><div class="ledger-record-body"><p class="muted">${t("recordsHint")}</p><div id="ledger-records"></div></div></details>
  </main><footer class="ledger-bottom"><div><strong id="ledger-selected-summary"></strong><p id="ledger-byte-summary"></p><progress id="ledger-capacity" class="ledger-capacity" max="${options.limits.bytes}" value="0" aria-label="容量使用" data-aria-zh="容量使用" data-aria-en="Capacity used"></progress><p id="ledger-selection-warning" class="error" role="status"></p><p class="muted" id="ledger-limit-note"></p></div><div class="ledger-bottom-actions"><button id="ledger-selected" type="button" class="secondary">${t("selection")}</button><button id="ledger-clear" type="button" class="secondary">${t("clear")}</button><button id="ledger-submit" type="button" disabled>${t("prepare")}</button></div></footer>
  ${dialog("selection", "selection")}${dialog("task", "task")}
  <script nonce="${options.nonce}" type="application/json" id="ledger-config">${JSON.stringify({ limits: options.limits, copy: ledgerCopy }).replace(/</g, "\\u003c")}</script>`,
    ledgerClientSource
  );
}
