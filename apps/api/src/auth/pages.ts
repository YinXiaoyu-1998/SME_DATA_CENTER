import { browserPageStyles } from "@smedc/admin-web";
import type { PasswordSetupAccount } from "./auth-core.js";

export interface AuthPageHeaders {
  "cache-control": string;
  "content-security-policy": string;
  "permissions-policy": string;
  "referrer-policy": string;
  "x-content-type-options": string;
  "x-frame-options": string;
}

interface PageOptions {
  nonce: string;
}

export interface LocalizedText {
  zh: string;
  en: string;
}

interface FormPageOptions extends PageOptions {
  csrfToken: string;
  error?: LocalizedText;
}

export function authPageHeaders(nonce: string): AuthPageHeaders {
  assertCspNonce(nonce);

  return {
    "cache-control": "no-store",
    "content-security-policy": [
      "default-src 'none'",
      "base-uri 'none'",
      "form-action 'self'",
      "frame-ancestors 'none'",
      `script-src 'nonce-${nonce}'`,
      `style-src 'nonce-${nonce}'`
    ].join("; "),
    "permissions-policy": "camera=(), microphone=(), geolocation=()",
    "referrer-policy": "no-referrer",
    "x-content-type-options": "nosniff",
    "x-frame-options": "DENY"
  };
}

export function renderDeviceVerificationPage(
  options: FormPageOptions & {
    userCode: string;
    instanceName: string;
    instanceHostname: string;
  }
): string {
  const error = options.error
    ? `<p role="alert" class="error">${localized(options.error)}</p>`
    : "";

  return pageShell(
    {
      nonce: options.nonce,
      title: { zh: "登录 SMEDC", en: "Sign in to SMEDC" }
    },
    `<main class="login"><section class="panel">
      <h1>${localized({ zh: "登录 SMEDC", en: "Sign in to SMEDC" })}</h1>
      <p class="device" data-locale="zh-CN">本次登录将授权 <strong>${escapeHtml(
        options.instanceName
      )}</strong>（主机：${escapeHtml(options.instanceHostname)}）。</p>
      <p class="device" data-locale="en" hidden>This sign-in authorizes <strong>${escapeHtml(
        options.instanceName
      )}</strong> on ${escapeHtml(options.instanceHostname)}.</p>
      ${error}
      <form method="post" action="/oauth/device/verify/login">
        <input type="hidden" name="csrfToken" value="${escapeHtml(options.csrfToken)}">
        <input type="hidden" name="userCode" value="${escapeHtml(options.userCode)}">
        <label for="email">${localized({ zh: "邮箱", en: "Email" })}</label>
        <input id="email" name="email" type="email" autocomplete="username" required>
        <label for="password">${localized({ zh: "密码", en: "Password" })}</label>
        <input id="password" name="password" type="password" autocomplete="current-password" required>
        <button type="submit">${localized({ zh: "登录", en: "Sign in" })}</button>
      </form>
    </section></main>`
  );
}

export function renderPasswordSetupBootstrapPage(options: PageOptions): string {
  return pageShell(
    {
      nonce: options.nonce,
      title: { zh: "设置 SMEDC 密码", en: "Set your SMEDC password" }
    },
    `<main class="login"><section class="panel">
      <h1>${localized({ zh: "正在准备密码设置…", en: "Preparing password setup…" })}</h1>
      <p role="status">
        <span id="status-zh" data-locale="zh-CN">正在检查此安全链接。</span>
        <span id="status-en" data-locale="en" hidden>Checking this secure link.</span>
      </p>
      <noscript>${localized({
        zh: "此密码设置链接需要启用 JavaScript，以保护其中的一次性令牌。",
        en: "This password setup link requires JavaScript to protect its one-time token."
      })}</noscript>
    </section></main>
    <script nonce="${escapeHtml(options.nonce)}">
      (() => {
        const fragment = new URLSearchParams(window.location.hash.slice(1));
        const token = fragment.get("token");
        window.history.replaceState(null, "", window.location.pathname);
        if (!token) {
          document.getElementById("status-zh").textContent = "此密码设置链接无效或已过期。";
          document.getElementById("status-en").textContent = "This password setup link is invalid or expired.";
          return;
        }
        const form = document.createElement("form");
        form.method = "post";
        form.action = "/auth/password/setup/session";
        const input = document.createElement("input");
        input.type = "hidden";
        input.name = "token";
        input.value = token;
        form.appendChild(input);
        document.body.appendChild(form);
        form.submit();
      })();
    </script>`
  );
}

export function renderPasswordSetupForm(
  options: FormPageOptions & { account: PasswordSetupAccount }
): string {
  const error = options.error
    ? `<p role="alert" class="error">${localized(options.error)}</p>`
    : "";

  return pageShell(
    {
      nonce: options.nonce,
      title: { zh: "设置 SMEDC 密码", en: "Set your SMEDC password" }
    },
    `<main class="login"><section class="panel">
      <h1>${localized({ zh: "设置 SMEDC 密码", en: "Set your SMEDC password" })}</h1>
      <p>${localized({
        zh: "请选择一个长度为 8–128 个字符的密码。",
        en: "Choose a password with 8–128 characters."
      })}</p>
      <section class="account-details subpanel" aria-labelledby="account-details-heading">
        <h2 id="account-details-heading">${localized({ zh: "账户", en: "Account" })}</h2>
        <dl>
          <div><dt>${localized({ zh: "显示名称", en: "Display name" })}</dt><dd>${escapeHtml(options.account.displayName)}</dd></div>
          <div><dt>${localized({ zh: "邮箱", en: "Email" })}</dt><dd>${escapeHtml(options.account.email)}</dd></div>
          <div><dt>${localized({ zh: "组织", en: "Organization" })}</dt><dd>${escapeHtml(options.account.organizationName)}</dd></div>
          <div><dt>${localized({ zh: "角色", en: "Role" })}</dt><dd>${localized(
            options.account.role === "admin"
              ? { zh: "管理员", en: "Admin" }
              : { zh: "员工", en: "Employee" }
          )}</dd></div>
        </dl>
      </section>
      ${error}
      <form method="post" action="/auth/password/setup/complete">
        <input type="hidden" name="csrfToken" value="${escapeHtml(options.csrfToken)}">
        <label for="password">${localized({ zh: "新密码", en: "New password" })}</label>
        <input id="password" name="password" type="password" autocomplete="new-password" minlength="8" maxlength="128" required>
        <label for="passwordConfirmation">${localized({
          zh: "确认新密码",
          en: "Confirm new password"
        })}</label>
        <input id="passwordConfirmation" name="passwordConfirmation" type="password" autocomplete="new-password" minlength="8" maxlength="128" required>
        <button type="submit">${localized({ zh: "设置密码", en: "Set password" })}</button>
      </form>
    </section></main>`
  );
}

export function renderSafeMessagePage(
  options: PageOptions & { title: LocalizedText; message: LocalizedText }
): string {
  return pageShell(
    {
      nonce: options.nonce,
      title: options.title
    },
    `<main class="login"><section class="panel"><h1>${localized(options.title)}</h1><p>${localized(options.message)}</p></section></main>`
  );
}

function pageShell(options: PageOptions & { title: LocalizedText }, body: string): string {
  assertCspNonce(options.nonce);

  return `<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title data-title-zh="${escapeHtml(options.title.zh)}" data-title-en="${escapeHtml(
      options.title.en
    )}">${escapeHtml(options.title.zh)}</title>
    <style nonce="${escapeHtml(options.nonce)}">
      ${browserPageStyles}
      .login form > button { margin-top: 1rem; }
      .device { color: #536761; overflow-wrap: anywhere; }
      .account-details h2 { font-size: 1rem; }
      .account-details dl { display: grid; gap: 0.5rem; margin: 0; }
      .account-details dl div { display: grid; grid-template-columns: 8rem minmax(0, 1fr); gap: 0.75rem; }
      .account-details dt { font-weight: 600; }
      .account-details dd { margin: 0; overflow-wrap: anywhere; }
      @media (max-width: 400px) {
        .account-details dl div { grid-template-columns: 1fr; gap: 0.125rem; }
      }
    </style>
  </head>
  <body>
    <header>
    <div class="brand">SMEDC</div>
    <nav class="language-switcher" aria-label="语言 / Language">
      <button type="button" data-locale-option="zh-CN" aria-pressed="true">中文</button>
      <button type="button" data-locale-option="en" aria-pressed="false">English</button>
    </nav>
    </header>
    ${body}
    <script nonce="${escapeHtml(options.nonce)}">
      (() => {
        const storageKey = "smedc-locale";
        const applyLocale = (locale) => {
          const selected = locale === "en" ? "en" : "zh-CN";
          document.documentElement.lang = selected;
          document.querySelectorAll("[data-locale]").forEach((element) => {
            element.hidden = element.dataset.locale !== selected;
          });
          document.querySelectorAll("[data-locale-option]").forEach((button) => {
            button.setAttribute("aria-pressed", String(button.dataset.localeOption === selected));
          });
          const title = document.querySelector("title");
          if (title) title.textContent = selected === "en" ? title.dataset.titleEn : title.dataset.titleZh;
          try { window.localStorage.setItem(storageKey, selected); } catch {}
        };
        let storedLocale = "zh-CN";
        try { storedLocale = window.localStorage.getItem(storageKey) || "zh-CN"; } catch {}
        applyLocale(storedLocale);
        document.querySelectorAll("[data-locale-option]").forEach((button) => {
          button.addEventListener("click", () => applyLocale(button.dataset.localeOption));
        });
      })();
    </script>
  </body>
</html>`;
}

function localized(value: LocalizedText): string {
  return `<span data-locale="zh-CN">${escapeHtml(value.zh)}</span><span data-locale="en" hidden>${escapeHtml(value.en)}</span>`;
}

function escapeHtml(value: string): string {
  return value.replace(
    /[&<>"']/g,
    (character) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;"
      })[character]!
  );
}

function assertCspNonce(nonce: string): void {
  if (!/^[A-Za-z0-9_-]{8,128}$/.test(nonce)) {
    throw new Error("Authentication page CSP nonce is invalid.");
  }
}
