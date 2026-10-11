import { permissionsClientSource } from "./client.js";
import { permissionsCopy } from "./copy.js";
export interface LocalizedText {
  zh: string;
  en: string;
}
interface PageOptions {
  nonce: string;
  orgId: string;
  csrfToken: string;
}
function escapeHtml(value: string): string {
  return value.replace(
    /[&<>"']/g,
    (character) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]!
  );
}
function localized(value: LocalizedText): string {
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
function shell(
  options: { nonce: string; title: LocalizedText },
  body: string,
  script = ""
): string {
  if (!/^[A-Za-z0-9_-]{8,128}$/.test(options.nonce)) throw new Error("Invalid page nonce");
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title data-title-zh="${escapeHtml(options.title.zh)}" data-title-en="${escapeHtml(options.title.en)}">${escapeHtml(options.title.zh)}</title><style nonce="${options.nonce}">
  :root{font-family:system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:#192b32;background:#f4f6f5;line-height:1.55;color-scheme:light}*{box-sizing:border-box}[hidden]{display:none!important}body{margin:0}header{background:#fff;border-bottom:1px solid #dbe3df;padding:1rem clamp(1rem,4vw,3rem);display:flex;gap:1rem;align-items:center;justify-content:space-between}.brand{font-weight:750;letter-spacing:.06em;color:#22584a}.language-switcher{display:flex;gap:.35rem;align-items:center}.language-switcher button{background:transparent;color:#22584a;padding:.35rem .55rem;min-height:2.25rem}.language-switcher button[aria-pressed=true]{background:#e1ede7;font-weight:700}main{max-width:1100px;margin:2rem auto;padding:0 1rem}.login{max-width:440px;margin:8vh auto}.panel{background:white;border:1px solid #dbe3df;border-radius:12px;padding:1.5rem;margin:1rem 0}h1{font-size:1.75rem;line-height:1.3;margin:.3rem 0 1rem}h2{font-size:1.2rem;margin:0 0 1rem}h3{font-size:1rem;margin:0 0 .75rem}p{margin:.5rem 0 1rem}.muted,small{color:#536761}label{display:block;font-weight:600;margin:.75rem 0 .25rem}input,select,button,textarea{font:inherit}input,select,textarea{border:1px solid #aabbb4;border-radius:6px;padding:.6rem;background:#fff;color:inherit;max-width:100%;width:100%;min-height:2.65rem}input[type=checkbox]{width:1.1rem;min-height:1.1rem;vertical-align:middle}button{border:1px solid transparent;border-radius:6px;padding:.6rem 1rem;min-height:2.65rem;background:#22584a;color:#fff;cursor:pointer}button:disabled{opacity:.5;cursor:wait}button.secondary{background:#edf2ef;color:#244f42;border-color:#c4d3cb}button.danger{background:#9d3535}button:focus-visible,a:focus-visible,input:focus-visible,select:focus-visible{outline:3px solid #d09c46;outline-offset:2px}.error{color:#9d2828}.notice{padding:.8rem 1rem;background:#eaf2ed;border-radius:6px}.actions{display:flex;gap:.6rem;flex-wrap:wrap;align-items:center;margin-top:1rem}.row{display:flex;gap:1rem;align-items:flex-start;flex-wrap:wrap}.row>*{flex:1;min-width:160px}.check{display:flex;gap:.5rem;align-items:center;font-weight:400}.check input{flex:none}.subpanel{padding:1rem;border:1px solid #dbe3df;border-radius:8px;margin:.75rem 0}.tabs{display:flex;flex-wrap:wrap;gap:.4rem}.tabs button{background:transparent;color:#365d50;border-color:#c4d3cb}.tabs button[aria-selected=true]{background:#22584a;color:white}.summary{white-space:pre-wrap;overflow-wrap:anywhere}.table-wrap{overflow:auto}table{border-collapse:collapse;width:100%;text-align:left}th,td{border-bottom:1px solid #e0e7e3;padding:.65rem;vertical-align:top}dialog{max-width:min(620px,95vw);border:1px solid #aabbb4;border-radius:12px;padding:1.5rem;color:inherit}dialog::backdrop{background:#192b3266}.step{display:inline-block;border-radius:30px;background:#e1ede7;padding:.2rem .7rem;font-size:.85rem}details>summary{cursor:pointer;font-weight:600}pre{white-space:pre-wrap}.empty{padding:1rem;color:#536761}.identity{overflow-wrap:anywhere}@media(max-width:600px){main{margin:1rem auto}.panel{padding:1rem}header{flex-wrap:wrap}.row{display:block}.row>*{margin:.5rem 0}h1{font-size:1.5rem}}
  </style></head><body><header><div class="brand">SMEDC</div><nav class="language-switcher" aria-label="语言" data-aria-zh="语言" data-aria-en="Language"><button type="button" data-locale-option="zh-CN" aria-pressed="true">中文</button><button type="button" data-locale-option="en" aria-pressed="false">English</button></nav></header>${body}<script nonce="${options.nonce}">${localeSource}</script>${script ? `<script nonce="${options.nonce}">${script}</script>` : ""}</body></html>`;
}
export function renderPermissionsLogin(
  options: PageOptions & { error?: "invalid" | "expired" }
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
    `<main class="login"><section class="panel"><h1>${localized({ zh: "管理员登录", en: "Administrator sign-in" })}</h1><p class="muted">${localized({ zh: "请使用此企业的 SMEDC 管理员账号登录。", en: "Sign in with this enterprise's SMEDC administrator account." })}</p>${options.error ? `<p role="alert" class="error">${localized(options.error === "invalid" ? invalid : expired)}</p>` : ""}<form method="post" action="/admin/permissions/${escapeHtml(encodeURIComponent(options.orgId))}/login" data-login novalidate><input type="hidden" name="csrfToken" value="${escapeHtml(options.csrfToken)}"><label for="email">${localized({ zh: "邮箱", en: "Email" })}</label><input id="email" name="email" type="email" autocomplete="username" maxlength="320" required><label for="password">${localized({ zh: "密码", en: "Password" })}</label><input id="password" name="password" type="password" autocomplete="current-password" required><p id="login-validation" role="alert" class="error" hidden>${localized({ zh: "请填写有效邮箱和密码（密码最多 128 个字符）。", en: "Enter a valid email and password (up to 128 characters)." })}</p><div class="actions"><button type="submit">${localized({ zh: "登录", en: "Sign in" })}</button></div></form></section></main>`
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
export function renderPermissionsPage(
  options: PageOptions & { organizationName: string; employeeName: string }
): string {
  return shell(
    { nonce: options.nonce, title: { zh: "权限设置 · SMEDC", en: "Permissions · SMEDC" } },
    `<main><h1>${localized({ zh: "权限设置", en: "Permissions" })}</h1><p class="identity">${escapeHtml(options.organizationName)} · ${escapeHtml(options.employeeName)}</p><div id="permission-global-status" role="alert" hidden></div><section id="permissions-app" class="panel"><p role="status">${localized({ zh: "正在读取配置…", en: "Loading configuration…" })}</p></section><form method="post" action="/admin/permissions/${escapeHtml(encodeURIComponent(options.orgId))}/logout"><input type="hidden" name="csrfToken" value="${escapeHtml(options.csrfToken)}"><button class="secondary" type="submit">${localized({ zh: "退出网页登录", en: "Sign out of browser" })}</button></form></main><script nonce="${options.nonce}" type="application/json" id="smedc-ui-config">${JSON.stringify({ orgId: options.orgId, csrfToken: options.csrfToken, copy: permissionsCopy }).replace(/</g, "\\u003c")}</script>`,
    permissionsClientSource
  );
}
