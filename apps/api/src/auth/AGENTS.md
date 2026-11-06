# Authentication and employee login

- Follow `docs/implementation/official-user-install-and-login.md`. Real or user-owned account passwords remain out of scope; synthetic manual-test credentials follow `skills/smedc-manual-test/AGENTS.md`.

- Preserve the official device-authorization flow and separation between login identity, employee account, launcher credentials and browser identity session. Do not revive deleted development login endpoints.
- Browser sessions store secret hashes, rotate on login and check current account/identity validity; password reset/revocation must invalidate relevant sessions. Never expose credentials or setup links in errors, logs or model-visible output.
- Browser admin requests retain same-origin/CSRF checks, secure HttpOnly cookies, no-store responses and existing CSP. Browser sessions must not broaden launcher/API authentication.
- 仅剩的两个服务端渲染页面（设备授权、首次设密码）保持 zh-CN 默认、en 切换，并保留用户已明确选择的语言偏好；业务名称原样显示。其余网页已迁至独立前端仓 `SMEDC_FRONTEND`。
- Focused checks: `npm test -- apps/api/src/auth`; use the documented integration runner when changing session persistence.
