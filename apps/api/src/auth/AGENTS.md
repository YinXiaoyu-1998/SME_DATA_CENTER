# Authentication and employee login

- Follow `docs/implementation/official-user-install-and-login.md`. Real or user-owned account passwords remain out of scope; synthetic manual-test credentials follow `skills/smedc-manual-test/AGENTS.md`.

- Preserve the official device-authorization flow and separation between login identity, employee account, launcher credentials and browser identity session. Do not revive deleted development login endpoints.
- Browser sessions store secret hashes, rotate on login and check current account/identity validity; password reset/revocation must invalidate relevant sessions. Never expose credentials or setup links in errors, logs or model-visible output.
- Browser admin requests retain same-origin/CSRF checks, secure HttpOnly cookies, no-store responses and existing CSP. Browser sessions must not broaden launcher/API authentication.
- Login/password page changes also follow shared UI/language rules in `apps/admin-web/AGENTS.md`.
- Focused checks: `npm test -- apps/api/src/auth`; use the documented integration runner when changing session persistence.
