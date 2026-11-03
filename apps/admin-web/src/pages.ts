import { browserPageStyles } from "./styles.js";
import { permissionsClientSource } from "./client.js";
import { permissionsCopy } from "./copy.js";
import { workflowCopy } from "./workflow-copy.js";
import { workflowClientSource } from "./workflow-client.js";
export interface LocalizedText {
  zh: string;
  en: string;
}
interface PageOptions {
  nonce: string;
  orgId: string;
  csrfToken: string;
}
export function escapeHtml(value: string): string {
  return value.replace(
    /[&<>"']/g,
    (character) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]!
  );
}
export function localized(value: LocalizedText): string {
  return `<span data-locale="zh-CN">${escapeHtml(value.zh)}</span><span data-locale="en" hidden>${escapeHtml(value.en)}</span>`;
}
const localeSource = String.raw`
(() => {
 const key = "smedc-locale";
 const apply = value => {
   const locale = value === "en" ? "en" : "zh-CN";
   document.documentElement.lang = locale;
   document.querySelectorAll("[data-locale]").forEach(el => { el.hidden = el.dataset.locale !== locale; });
   document.querySelectorAll("[data-locale-option]").forEach(el => el.setAttribute("aria-pressed", String(el.dataset.localeOption === locale)));
   const title = document.querySelector("title");
   if (title) title.textContent = locale === "en" ? title.dataset.titleEn : title.dataset.titleZh;
   document.querySelectorAll("[data-aria-zh]").forEach(el => el.setAttribute("aria-label", locale === "en" ? el.dataset.ariaEn : el.dataset.ariaZh));
   try { localStorage.setItem(key, locale); } catch {}
   window.dispatchEvent(new CustomEvent("smedc-locale-changed", { detail: locale }));
 };
 let stored = "zh-CN";
 try { stored = localStorage.getItem(key); } catch {}
 apply(stored);
 document.querySelectorAll("[data-locale-option]").forEach(button => button.addEventListener("click", () => apply(button.dataset.localeOption)));
 const form = document.querySelector("form[data-login]");
 if (form) form.addEventListener("submit", event => {
   const email = form.elements.namedItem("email").value.trim();
   const password = form.elements.namedItem("password").value;
   if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 320 || !password || Array.from(password.normalize("NFC")).length > 128) {
     event.preventDefault();
     document.getElementById("login-validation").hidden = false;
   }
 });
})();`;
export function shell(
  options: { nonce: string; title: LocalizedText; styles?: string },
  body: string,
  script = ""
): string {
  if (!/^[A-Za-z0-9_-]{8,128}$/.test(options.nonce)) throw new Error("Invalid page nonce");
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title data-title-zh="${escapeHtml(options.title.zh)}" data-title-en="${escapeHtml(options.title.en)}">${escapeHtml(options.title.zh)}</title><style nonce="${options.nonce}">
  ${browserPageStyles}
  ${options.styles ?? ""}
  </style></head><body><header><div class="brand">SMEDC</div><nav class="language-switcher" aria-label="语言" data-aria-zh="语言" data-aria-en="Language"><button type="button" data-locale-option="zh-CN" aria-pressed="true">中文</button><button type="button" data-locale-option="en" aria-pressed="false">English</button></nav></header>${body}<script nonce="${options.nonce}">${localeSource}</script>${script ? `<script nonce="${options.nonce}">${script}</script>` : ""}</body></html>`;
}
export function renderPermissionsLogin(
  options: PageOptions & { error?: "invalid" | "expired"; workflow?: string }
): string {
  const invalid = { zh: "邮箱或密码错误。", en: "The email or password is incorrect." };
  const expired = {
    zh: "登录已过期，请重新登录。",
    en: "Your sign-in expired. Please sign in again."
  };
  return shell(
    {
      nonce: options.nonce,
      title: { zh: "管理员登录 · SMEDC", en: "Administrator sign-in · SMEDC" }
    },
    `<main class="login"><section class="panel"><h1>${localized({ zh: "管理员登录", en: "Administrator sign-in" })}</h1><p class="muted">${localized({ zh: "请使用此企业的 SMEDC 管理员账号登录。", en: "Sign in with this enterprise's SMEDC administrator account." })}</p>${options.error ? `<p role="alert" class="error">${localized(options.error === "invalid" ? invalid : expired)}</p>` : ""}<form method="post" action="/admin/permissions/${escapeHtml(encodeURIComponent(options.orgId))}/login${options.workflow === undefined ? "" : `?workflow=${escapeHtml(encodeURIComponent(options.workflow))}`}" data-login novalidate><input type="hidden" name="csrfToken" value="${escapeHtml(options.csrfToken)}"><label for="email">${localized({ zh: "邮箱", en: "Email" })}</label><input id="email" name="email" type="email" autocomplete="username" maxlength="320" required><label for="password">${localized({ zh: "密码", en: "Password" })}</label><input id="password" name="password" type="password" autocomplete="current-password" required><p id="login-validation" role="alert" class="error" hidden>${localized({ zh: "请填写有效邮箱和密码（密码最多 128 个字符）。", en: "Enter a valid email and password (up to 128 characters)." })}</p><div class="actions"><button type="submit">${localized({ zh: "登录", en: "Sign in" })}</button></div></form></section></main>`
  );
}
export function renderPermissionsMessage(options: {
  nonce: string;
  kind: "denied" | "expired";
}): string {
  const title =
    options.kind === "denied"
      ? { zh: "无法访问", en: "Access unavailable" }
      : { zh: "请重新登录", en: "Sign in again" };
  const message =
    options.kind === "denied"
      ? {
          zh: "当前账号无权访问此权限设置入口。请核对账号与收到的链接。",
          en: "This account cannot access this permissions entry. Check your account and the link you received."
        }
      : {
          zh: "登录已过期或安全校验失败。请重新打开原权限设置链接并登录。",
          en: "Your sign-in expired or the security check failed. Reopen the original permissions link and sign in."
        };
  return shell(
    { nonce: options.nonce, title },
    `<main class="login"><section class="panel"><h1>${localized(title)}</h1><p>${localized(message)}</p></section></main>`
  );
}
export const settingsNavigationSource = String.raw`
(() => {
 const nav = document.getElementById("settings-navigation");
 const links = [...nav.querySelectorAll("a")];
 const permissions = links[0];
 function show(path) {
   const current = path === permissions.pathname ? permissions : links[1];
   for (const link of links) {
     const active = link === current;
     document.getElementById(link.dataset.settingsPanel).hidden = !active;
     if (active) link.setAttribute("aria-current", "page");
     else link.removeAttribute("aria-current");
   }
 }
 for (const link of links) link.addEventListener("click", event => {
   if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
   event.preventDefault();
   if (location.pathname !== link.pathname) history.pushState(null, "", link.href);
   show(location.pathname);
 });
 window.addEventListener("popstate", () => show(location.pathname));
})();`;

function settingsConfig(nonce: string, id: string, value: object): string {
  return `<script nonce="${nonce}" type="application/json" id="${id}">${JSON.stringify(value).replace(/</g, "\\u003c")}</script>`;
}

export function renderPermissionsPage(
  options: PageOptions & {
    organizationName: string;
    employeeName: string;
    workflows?: { active?: boolean; enterpriseKey?: string };
  }
): string {
  const base = `/admin/permissions/${encodeURIComponent(options.orgId)}`;
  const active = Boolean(options.workflows?.active);
  const enterpriseKey = options.workflows?.enterpriseKey;
  const workflowPath = `${base}/workflows${enterpriseKey ? "/" + encodeURIComponent(enterpriseKey) : ""}`;
  const permissionsTitle = { zh: "权限设置", en: "Permissions" };
  const navigation = options.workflows
    ? `<nav id="settings-navigation" class="settings-navigation" aria-label="管理设置" data-aria-zh="管理设置" data-aria-en="Admin settings"><a href="${base}" data-settings-panel="permissions-settings"${active ? "" : ' aria-current="page"'}>${localized(permissionsTitle)}</a><a href="${workflowPath}" data-settings-panel="workflow-settings"${active ? ' aria-current="page"' : ""}>${localized(workflowCopy.title!)}</a></nav>`
    : "";
  const workflowPanel = options.workflows
    ? `<section id="workflow-settings" aria-labelledby="workflow-settings-title"${active ? "" : " hidden"}><h2 id="workflow-settings-title">${localized(workflowCopy.title!)}</h2><p>${localized(workflowCopy.intro!)}</p><div id="workflow-notice" role="alert" hidden></div><div id="workflows-app" aria-busy="true"><p role="status">${localized(workflowCopy.loading!)}</p></div></section>`
    : "";
  return shell(
    {
      nonce: options.nonce,
      title: options.workflows
        ? { zh: "管理设置 · SMEDC", en: "Admin settings · SMEDC" }
        : { zh: "权限设置 · SMEDC", en: "Permissions · SMEDC" }
    },
    `<main><h1>${localized(options.workflows ? { zh: "管理设置", en: "Admin settings" } : permissionsTitle)}</h1><p class="identity">${escapeHtml(options.organizationName)} · ${escapeHtml(options.employeeName)}</p>${navigation}<section id="permissions-settings" aria-labelledby="permissions-settings-title"${active ? " hidden" : ""}><h2 id="permissions-settings-title"${options.workflows ? "" : " hidden"}>${localized(permissionsTitle)}</h2><div id="permission-global-status" role="alert" hidden></div><section id="permissions-app" class="panel"><p role="status">${localized({ zh: "正在读取配置…", en: "Loading configuration…" })}</p></section></section>${workflowPanel}<form method="post" action="${base}/logout"><input type="hidden" name="csrfToken" value="${escapeHtml(options.csrfToken)}"><button type="submit" class="secondary">${localized({ zh: "退出网页登录", en: "Sign out of browser" })}</button></form></main>` +
      settingsConfig(options.nonce, "smedc-ui-config", {
        orgId: options.orgId,
        csrfToken: options.csrfToken,
        copy: permissionsCopy
      }) +
      (options.workflows
        ? settingsConfig(options.nonce, "workflow-config", {
            orgId: options.orgId,
            enterpriseKey,
            csrfToken: options.csrfToken,
            copy: workflowCopy
          })
        : ""),
    options.workflows
      ? [settingsNavigationSource, permissionsClientSource, workflowClientSource].join("\n")
      : permissionsClientSource
  );
}
