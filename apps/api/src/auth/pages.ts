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

interface FormPageOptions extends PageOptions {
  csrfToken: string;
  error?: string;
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

export function renderLoginPage(options: FormPageOptions): string {
  const error = options.error
    ? `<p role="alert" class="error">${escapeHtml(options.error)}</p>`
    : "";

  return pageShell(
    {
      nonce: options.nonce,
      title: "Sign in to Enterprise Hub"
    },
    `<main>
      <h1>Sign in to Enterprise Hub</h1>
      <p>Use the account provided by your organization.</p>
      ${error}
      <form method="post" action="/oauth/authorize/login">
        <input type="hidden" name="csrfToken" value="${escapeHtml(options.csrfToken)}">
        <label for="email">Email</label>
        <input id="email" name="email" type="email" autocomplete="username" required>
        <label for="password">Password</label>
        <input id="password" name="password" type="password" autocomplete="current-password" required>
        <button type="submit">Sign in</button>
      </form>
    </main>`
  );
}

export function renderPasswordSetupBootstrapPage(options: PageOptions): string {
  return pageShell(
    {
      nonce: options.nonce,
      title: "Set your Enterprise Hub password"
    },
    `<main>
      <h1>Preparing password setup…</h1>
      <p id="status" role="status">Checking this secure link.</p>
      <noscript>This password setup link requires JavaScript to protect its one-time token.</noscript>
    </main>
    <script nonce="${escapeHtml(options.nonce)}">
      (() => {
        const fragment = new URLSearchParams(window.location.hash.slice(1));
        const token = fragment.get("token");
        window.history.replaceState(null, "", window.location.pathname);
        if (!token) {
          document.getElementById("status").textContent = "This password setup link is invalid or expired.";
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

export function renderPasswordSetupForm(options: FormPageOptions): string {
  const error = options.error
    ? `<p role="alert" class="error">${escapeHtml(options.error)}</p>`
    : "";

  return pageShell(
    {
      nonce: options.nonce,
      title: "Set your Enterprise Hub password"
    },
    `<main>
      <h1>Set your Enterprise Hub password</h1>
      <p>Choose a password with 8–128 characters.</p>
      ${error}
      <form method="post" action="/auth/password/setup/complete">
        <input type="hidden" name="csrfToken" value="${escapeHtml(options.csrfToken)}">
        <label for="password">New password</label>
        <input id="password" name="password" type="password" autocomplete="new-password" minlength="8" maxlength="128" required>
        <label for="passwordConfirmation">Confirm new password</label>
        <input id="passwordConfirmation" name="passwordConfirmation" type="password" autocomplete="new-password" minlength="8" maxlength="128" required>
        <button type="submit">Set password</button>
      </form>
    </main>`
  );
}

export function renderSafeMessagePage(
  options: PageOptions & { title: string; message: string }
): string {
  return pageShell(
    {
      nonce: options.nonce,
      title: options.title
    },
    `<main><h1>${escapeHtml(options.title)}</h1><p>${escapeHtml(options.message)}</p></main>`
  );
}

function pageShell(options: PageOptions & { title: string }, body: string): string {
  assertCspNonce(options.nonce);

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>${escapeHtml(options.title)}</title>
    <style nonce="${escapeHtml(options.nonce)}">
      :root { color-scheme: light dark; font-family: system-ui, sans-serif; }
      body { margin: 0; padding: 2rem 1rem; }
      main { max-width: 28rem; margin: 8vh auto; }
      form { display: grid; gap: 0.75rem; }
      input, button { box-sizing: border-box; font: inherit; min-height: 2.75rem; padding: 0.6rem; }
      button { cursor: pointer; margin-top: 0.5rem; }
      .error { color: #b42318; }
    </style>
  </head>
  <body>${body}</body>
</html>`;
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
