# Official User Installation, Login, and Session Design

Status: desktop browser flow accepted and ready for implementation planning; remote/headless and
secondary-device login reopened and in progress

Last updated: 2026-08-07

## Purpose

This document is the working source of truth for how an employee installs the Enterprise Hub client
components, signs in to the remote MCP service, remains authenticated across later agent sessions,
signs out, and recovers from authentication failures.

The filename uses “official user” to distinguish this flow from development login and synthetic
staging identities. In the product language, the person is an **employee user**, and the backend
permission subject is the existing **Employee Account** (`员工账号`). “Account” must not be used to
mean an MCP client, agent installation, launcher process, token, or device.

This document records product and security decisions. Current implementation details are included
only where they constrain the design. Detailed instructions for agents belong in the dual-homed
Enterprise Hub MCP skill after the design is implemented.

## Scope

In scope:

- installing the Enterprise Hub MCP skill and local launcher;
- initial interactive browser login;
- browser-to-launcher authorization completion;
- access-token and refresh-token lifecycle;
- local secure credential storage;
- automatic reuse, refresh, reauthentication, logout, and revocation;
- the boundary between the employee, agent/model, launcher, browser, identity system, and API;
- macOS and Windows client behavior;
- remote/headless and secondary-device (mobile) login via OAuth Device Authorization Grant semantics,
  including the first-party tap-link verification page and headless-agent token polling
  (design and implementation in progress).

Out of scope for this design:

- how an administrator initially creates or invites an Employee Account;
- registration as a growth or self-service acquisition flow;
- employee labels and business-data authorization rules beyond preserving the existing backend
  authority;
- service deployment, RDS, Qdrant, OSS, ACR, or worker operations.

## Withdrawn Development Code Reality

The official flow has replaced the temporary implementation described below. This table is retained
only as historical rationale and is not a compatibility constraint or current runtime description.

| Boundary             | Current implementation                                                                                                                          | Design consequence                                                                    |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| Employee Account     | Prisma `Employee` contains email, display name, role, disabled state, organization, and labels; it has no password or external-identity field   | The future password-verification owner and identity mapping must be designed          |
| Development login    | `POST /auth/dev-login` accepts only a seeded employee email and issues a one-hour HS256 JWT                                                     | Delete the route, JWT issuance, verification, configuration, tests, and documentation |
| API authentication   | Every protected API and MCP request requires a bearer token; the API reloads the Employee Account and rejects disabled employees                | Preserve this request-level authentication and backend authorization boundary         |
| MCP service          | Stateless Streamable HTTP at `POST /mcp`; every initialize, discovery, and tool call is authenticated                                           | The launcher must attach a valid access token to every remote MCP request             |
| Launcher             | A local stdio adapter configured with the service base URL; it exposes development login/logout tools and stores the JWT only in process memory | Replace rather than preserve this temporary authentication behavior                   |
| Existing token table | Prisma `AccessToken` can store a token hash, employee, expiry, revocation, and last use, but no runtime code uses it                            | It is not evidence that the official session model has been chosen                    |
| Public staging       | Production dev login is closed and public MCP is still blocked by the Phase 3 loopback guard                                                    | No real employee can currently sign in and use remote MCP                             |

## Confirmed Product Decisions

### Employee experience

- The Enterprise Hub MCP service runs remotely; the employee uses it through a general-purpose
  agent and its MCP client.
- Target employees are low- or no-technical-skill users on an ordinary interactive macOS or Windows
  personal computer with a functioning system browser.
- An employee may understand that a browser login is occurring, but should not need to understand
  that the launcher exists.
- Normal installation, login, later use, refresh, and logout must not require the employee to
  personally use a terminal, type commands, edit environment variables, edit MCP configuration, or
  manage an operating-system credential store.
- Remote/headless and secondary-device login is now in scope: an agent running without a local
  system browser can send the employee a first-party login/verification link, the employee
  authenticates in a mobile or desktop browser, and the agent completes the flow by polling the
  token endpoint. This extension is under active design and implementation (see
  “In-Progress: Remote/Headless And Secondary-Device Login”).

### Installation

- An npm-distributed launcher is a valid official distribution mechanism.
- After the employee authorizes installation, the agent may follow the Enterprise Hub MCP skill to
  install Node.js or other prerequisites, install a pinned launcher package, run scripts, write the
  MCP client configuration, and verify connectivity.
- “No-command-line user experience” constrains what the employee must do, not which implementation
  tools the agent may use invisibly on the employee's behalf.
- The MCP client should start the configured launcher when needed; the employee should not manually
  manage its process lifecycle.

### Password and secret boundary

- The employee must never provide an account password through agent chat, an agent-readable file,
  an environment variable, MCP configuration, or a launcher command.
- Password entry occurs only in a first-party browser authentication page.
- The agent/model must not receive or retain the password, access token, refresh token, authorization
  code, credential-store record, or raw `Authorization` header.
- The launcher may handle protocol credentials internally and attach bearer access tokens to remote
  MCP requests, but must not expose them through MCP tool inputs, results, logs, or normal
  configuration.

### Continued use

- A successful login must survive launcher exit, MCP client restart, and ordinary computer restart
  without requiring the employee to log in again every few hours.
- When the durable session can no longer be refreshed, the launcher may reopen the system browser
  and ask the employee to authenticate again.
- Disabling the Employee Account remains an immediate backend authorization control; a locally
  cached credential must not preserve access for a disabled employee.

## Accepted Identity Boundary

- Login Identity and Employee Account are separate concepts even when both are implemented in the
  Enterprise Hub codebase. Login success alone grants no document permission.
- A replaceable Identity Verifier owns login credentials, password verification, browser login
  sessions, throttling/lockout, and session revocation.
- For the controlled beta, the Identity Verifier will be an internal module in the existing modular
  monolith rather than a paid managed identity service or a new microservice.
- Enterprise Hub maps the verifier's stable login subject to exactly one Employee Account.
- The Employee Account remains the sole business authorization subject and continues to own
  organization, role, labels, disabled state, and audit attribution.
- Disabling an Employee Account must immediately block business access even if an identity
  token has not naturally expired. Normal offboarding also disables the Login Identity and revokes
  its sessions.
- Employee Accounts are normally disabled rather than physically deleted so historical uploads and
  audits retain their actor.
- A future paid-user phase may replace the internal verifier with a managed OIDC provider without
  changing Employee Account authorization.

## Accepted Beta Operating Model

- Beta is limited to a small, controlled population expected to be approximately four or five
  users.
- Enterprise Hub will not purchase or depend on a managed identity service for this beta slice.
- There is no public self-registration, self-service forgotten-password email, SMS recovery,
  identity federation, or MFA in the initial beta.
- A developer/operator CLI owns beta login-identity onboarding and password-reset initiation.
  General disablement and session-administration commands are deferred.
- The CLI creates or resets access by issuing a short-lived, single-use browser password-setup link
  that the developer conveys to the employee through a trusted private channel. The beta does not
  use temporary passwords or recovery email.
- The identity module lives inside the existing API modular monolith. Separate tables and interfaces
  preserve a future migration boundary, but no additional identity deployment is introduced.

The reduced feature scope does not reduce the password-security baseline. The implementation must
use a reviewed password-authentication library and, at minimum:

- store only salted adaptive password hashes, using Argon2id with benchmarked parameters; never
  plaintext or reversible encryption;
- enforce HTTPS-only browser password submission;
- accept long passphrases, reject common/compromised values, and avoid arbitrary composition or
  periodic-change rules;
- return generic login failures and apply the accepted per-identity progressive cooldown without
  creating a permanent account lockout;
- use short-lived access tokens and revocable, rotating durable sessions whose server-side secrets
  are stored only as hashes;
- revoke existing durable sessions when an operator resets a password, disables a Login Identity,
  or disables its Employee Account;
- keep passwords and session credentials out of CLI arguments, environment variables, process
  listings, logs, audit payloads, agent/model context, and ordinary configuration;
- audit login success/failure safely, password reset initiation/completion, session refresh/reuse,
  logout, revocation, and identity/employee disablement;
- test timing-safe verification, enumeration resistance, brute-force controls, replay, revocation,
  concurrent refresh, and future identity-provider migration boundaries.

## Accepted End-To-End Browser And Launcher Direction

The official flow is a browser login with an authorization-code handoff:

1. the MCP client starts the launcher;
2. the launcher creates a one-time request, proof challenge, and state;
3. the launcher opens the system browser to the Enterprise Hub HTTPS login page;
4. the employee enters the login identifier and password only in that page;
5. after successful authentication, the browser returns a short-lived one-time result to the
   initiating launcher through a protected callback;
6. the launcher exchanges it for a short-lived access token and a rotating refresh token;
7. the launcher keeps the access token in memory and stores only the refresh token in the
   operating-system secure credential store;
8. subsequent MCP requests refresh silently when possible and reopen the browser only when user
   authentication is required.

The handoff uses the accepted OAuth public-client contract and reviewed protocol/library support,
not an improvised password-to-token exchange. Future external OIDC migration remains a mandatory
design constraint.

## Documentation Conflicts To Retire

- ADR 0021 is a proposed, unimplemented beta bridge based on an operator-issued opaque token handed
  to a local credential helper. It was withdrawn on 2026-07-23 and must not be implemented.
- `mcp-user-flow.md`, `mcp-user-flow.zh.md`, `mcp-endpoint.md`, the implementation plan, beta
  readiness document, and both Enterprise Hub MCP skill copies describe the current development
  email-login or the earlier opaque-token proposal. They remain implementation history/current-state
  evidence, not the official future login design.
- Old implementation and design documents never take precedence over this accepted decision log.
  Retain old material only when it accurately describes current code or useful history, and mark it
  accordingly; delete or supersede conflicting recommendations.
- The remaining documents and skills must be reconciled after this design interview reaches an
  implementable boundary.

## Decision Log

| Date       | Status                    | Decision                                                                                                                                                                                                                 |
| ---------- | ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 2026-07-23 | Confirmed                 | Official employee clients need support only on interactive macOS and Windows computers with a system browser                                                                                                             |
| 2026-07-23 | Confirmed                 | The launcher is normally invisible to the employee; browser login is an acceptable visible interaction                                                                                                                   |
| 2026-07-23 | Confirmed                 | The employee must not personally operate installation commands or configuration, but an authorized agent may automate Node.js/npm installation and MCP configuration through the skill                                   |
| 2026-07-23 | Confirmed                 | Account passwords never enter agent/model-visible channels and are entered only on the browser login page                                                                                                                |
| 2026-07-23 | Confirmed                 | Authentication must persist across later agent sessions and ordinary restarts                                                                                                                                            |
| 2026-07-23 | Rejected                  | Asking the employee to give a password to an agent through chat, environment variables, or files                                                                                                                         |
| 2026-07-23 | Deferred | Device-code/headless/secondary-device login for the current target audience; deferred from the initial beta launch window rather than excluded as a product direction |
| 2026-07-23 | Rejected as official flow | Operator-to-user long-lived opaque-token handoff proposed by ADR 0021                                                                                                                                                    |
| 2026-07-23 | Confirmed                 | Obsolete temporary authentication designs do not constrain the official design; conflicting recommendations must be deleted, withdrawn, or marked historical/current-code-only                                           |
| 2026-07-23 | Superseded                | A mature independent OIDC identity system immediately owns login identities and passwords; revised after choosing a controlled internal beta verifier                                                                    |
| 2026-07-23 | Confirmed                 | The controlled beta uses a minimal internal identity-verification module in the existing modular monolith, with developer CLI lifecycle/reset and no paid provider or email recovery                                     |
| 2026-07-23 | Confirmed                 | The beta identity module must preserve a stable Login Identity → Employee Account mapping so a future managed OIDC provider can replace password verification without replacing business authorization                   |
| 2026-07-23 | Superseded                | The developer CLI generates a temporary password and communicates it to the employee; replaced by the browser password-setup link                                                                                        |
| 2026-07-23 | Confirmed                 | The developer CLI issues a short-lived, single-use browser password-setup link; the employee sets the password privately in the browser, with no temporary password or recovery email                                    |
| 2026-07-23 | Confirmed                 | Password-setup links expire after 24 hours, are single use, are superseded by a replacement, and revoke existing durable sessions when successfully consumed                                                             |
| 2026-07-23 | Confirmed                 | Login Identity has an explicit stable `employeeId` binding; email is only a mutable normalized login identifier and never causes automatic Employee Account creation or binding                                          |
| 2026-07-23 | Confirmed                 | The schema permits multiple Login Identities to bind to one Employee Account, but beta implements only one active local-password identity per employee and no general add/link/switch identity entry point               |
| 2026-07-23 | Confirmed                 | One developer CLI onboarding operation atomically creates the Employee Account, personal authorization label, and sole active local-password Login Identity, then issues its password-setup link                         |
| 2026-07-23 | Confirmed                 | The normalized login email is globally unique, trimmed and compared case-insensitively, without provider-specific dot or plus-address rewriting; public failures never disclose identity existence                       |
| 2026-07-23 | Confirmed                 | Password login allows five consecutive failures, then applies per-identity cooldowns of 5, 10, 20, 40, and at most 60 minutes; cooldown requests neither increment nor extend it                                         |
| 2026-07-23 | Deferred                  | Beta has no employee-facing or admin-UI account disable/reactivate/delete lifecycle; an emergency developer CLI operation may be added, while hard-delete semantics are explicitly outside this design                   |
| 2026-07-23 | Confirmed                 | The launcher uses the native-app Authorization Code flow with PKCE, system browser, exact IPv4 loopback callback on an ephemeral port, one-time code, and no embedded client secret                                      |
| 2026-07-23 | Confirmed                 | Login, password setup, and safe error pages are server-rendered by the existing Fastify API on its current HTTPS origin; beta adds no frontend framework, container, domain, or admin-web implementation                 |
| 2026-07-23 | Confirmed                 | The browser keeps no durable login session; clearing or closing it after code handoff has no effect, while incomplete flows simply restart and durable MCP access belongs only to the launcher                           |
| 2026-07-24 | Confirmed                 | Enterprise Hub's token endpoint issues a 10-minute bearer access token kept only in launcher memory; the launcher renews it automatically from the durable session, including after a launcher restart                   |
| 2026-07-24 | Confirmed                 | Access tokens are opaque 256-bit-or-stronger random bearer strings; MySQL stores only their hashes and authoritative expiry, revocation, session, and Employee Account association                                       |
| 2026-07-24 | Confirmed                 | A launcher durable session has one absolute 30-day lifetime from browser password login, no separate inactivity timeout, and cannot be extended by token renewal                                                         |
| 2026-07-24 | Confirmed                 | The opaque durable credential rotates after every access-token renewal; reuse of any consumed generation revokes the whole session family and requires browser login                                                     |
| 2026-07-24 | Confirmed                 | Durable credentials are stored only in macOS Keychain or Windows Credential Manager; unavailable or failed secure storage stops authentication and never falls back to plaintext                                         |
| 2026-07-24 | Confirmed                 | One operating-system user has one active Enterprise Hub account per service origin; every local agent client shares it, account switching is absent, and refresh is cross-process single-flight                          |
| 2026-07-24 | Confirmed                 | All official launchers use one fixed non-secret public client ID, Authorization Code + PKCE endpoints and server metadata; there is no dynamic registration, password grant, client secret, scope, or audience selection |
| 2026-07-24 | Confirmed                 | Authoritative launcher source remains in `apps/mcp-launcher` in the product monorepo and is released as a public, versioned npm package; skills pin and install the package but do not duplicate its source              |
| 2026-07-24 | Confirmed                 | The skill is the installation runbook and the employee-owned agent performs its steps; the employee requests installation in natural language and only directly interacts with the browser login                         |
| 2026-07-24 | Confirmed                 | Codex and OpenClaw on macOS and Windows are the first explicitly verified clients; the skill also gives other capable agents a guarded adaptive path to locate and update their own MCP configuration                    |
| 2026-07-24 | Confirmed                 | The launcher never self-updates; server metadata reports compatibility, while synchronized repo-local and standalone skills decide when and how the agent installs an exact approved version                             |
| 2026-07-24 | Confirmed                 | Logout revokes and removes the shared local session; removing one client integration affects only that client; complete uninstall removes all safely discovered integrations and local credentials but not account data  |
| 2026-07-24 | Confirmed                 | Each OS user and canonical service origin has one versioned secure-store record containing only the durable credential; failed rotation storage revokes/fails closed and requires browser login                          |
| 2026-07-24 | Confirmed                 | Authentication, connectivity, authorization, and upgrade failures are distinct typed conditions; the skill guides recovery and the agent retries the original operation once after successful browser reauthentication   |
| 2026-07-24 | Deferred                  | Beta does not add session inventory, single-session revoke CLI, or a device/session UI; lost-device recovery uses the existing password-reset flow, whose successful completion revokes all old sessions                 |
| 2026-07-24 | Confirmed                 | Beta retains a minimal credential-free authentication security-event trail for 90 days; it has operator-only read access and no dashboard, user history, or real-time alerting                                           |
| 2026-07-24 | Deferred                  | Source-IP and endpoint-specific authentication limits, CAPTCHA, and external anti-bot services are not part of the minimal beta; the accepted per-identity progressive cooldown remains                                  |
| 2026-07-24 | Confirmed                 | Beta passwords are 8–128 Unicode characters with no composition or periodic-change rule, a small local common-password blocklist, and reviewed benchmarked Argon2id storage                                              |
| 2026-07-24 | Confirmed                 | The temporary development email/JWT authentication system is deleted completely; every environment and test moves to the official identity/session model with no compatibility period                                    |
| 2026-08-07 | Confirmed | Device-code/headless/secondary-device login is reopened and in progress: adopt the OAuth Device Authorization Grant (RFC 8628) semantics with a first-party mobile-friendly tap-link verification page and headless-agent token polling; open branches are recorded in the In-Progress section |

## Design Tree

Resolve these branches in dependency order:

1. **Identity authority**: resolved for beta — an internal identity-verification module owns login
   credentials; a future paid-user phase may replace it with a managed OIDC provider.
2. **Identity-system operating model**: resolved — implement it as a module in the existing modular
   monolith, not a separate deployment.
3. **Initial credential and operator reset**: resolved — the developer CLI issues a short-lived,
   single-use browser password-setup link and never sets the employee's password.
4. **Employee identity mapping**: resolved — every Login Identity explicitly and stably binds to
   one Employee Account; email is not the mapping key. The schema permits multiple identities per
   employee, while beta exposes no multi-identity entry point and enforces at most one active local
   password identity per employee.
5. **Account creation and recovery**: resolved for current scope — new beta employee creation is
   atomic; login emails are globally unique after conservative normalization; initial password and
   reset use the 24-hour setup-link flow; failed passwords use the accepted finite progressive
   cooldown. Disable/reactivate/delete lifecycle design is deferred.
6. **OAuth/OIDC client shape**: resolved — one fixed public client uses the system browser,
   Authorization Code, PKCE `S256`, `state`, an exact ephemeral IPv4 loopback callback, fixed
   Enterprise Hub resource, token endpoint, and authorization-server metadata. Dynamic client
   registration and password grant do not exist.
7. **Session model**: resolved — opaque access tokens last 10 minutes and remain in launcher memory;
   opaque durable credentials rotate on every renewal within a fixed 30-day family, and replay
   revokes the family. Both token types are restricted to the Enterprise Hub API/MCP resource.
8. **Credential storage**: resolved — use one versioned Keychain/Credential Manager record per
   operating-system user and canonical service origin, shared by local agent clients. Store only
   the durable credential and minimal schema metadata; rotation-write failure fails closed and
   pre-official development credentials are not migrated.
9. **Installation lifecycle**: resolved for beta — launcher source remains in the monorepo, a
   versioned public npm package is the official artifact, and the skill instructs the agent to
   perform current-user installation and safe configuration. Codex and OpenClaw are the first
   verified adapters, with a guarded adaptive path for other agents. Updates are skill-driven and
   exact-version pinned; logout, per-agent removal, and complete uninstall have distinct,
   non-destructive meanings. Repair reuses the same idempotent skill-driven install and self-check.
10. **Runtime recovery**: resolved for current scope — authentication, connectivity, authorization,
    and upgrade failures are distinct typed conditions; the skill guides recovery, browser
    cancellation does not loop, callback binding retries once, and the agent retries the original
    operation once after successful reauthentication.
11. **Multiple contexts**: resolved for beta — one account is shared across all agent clients under
    one OS user; concurrent refresh is single-flight; separate computers/OS users have separate
    server sessions; account switching and multi-account UX do not exist.
12. **Operational controls**: resolved for beta — session inventory, per-session revoke,
    IP/endpoint limits, CAPTCHA, and external anti-bot services are deferred. A minimal
    credential-free 90-day security audit, per-identity progressive cooldown, and secret-free
    launcher self-check are accepted; dashboards and real-time alerts are not beta requirements.
13. **Acceptance**: resolved at the design level — verify macOS/Windows first-run and repeat-use for
    Codex/OpenClaw plus login, expiry, retry, logout, password reset, reinstall, upgrade,
    interrupted callback, and lost-device recovery. Exact automated/manual cases belong in the
    implementation plan.
14. **Remote/headless login**: resolved at the design level — the OAuth Device Authorization Grant
    is the single official flow; split secrets, pairing confirmation, headless credential custody,
    and the per-instance session model are resolved. See ADR 0022 and the In-Progress section;
    implementation has not started.

## Accepted Password-Setup Policy

The minimal page and backend flow are shared by initial setup and developer-initiated reset:

- the CLI generates a high-entropy random setup token and displays the complete HTTPS link once in
  an operator-controlled interactive terminal;
- the database stores only the token hash, target Login Identity, purpose, creation time, expiry,
  use time, and revocation time;
- the employee opens the link and enters the new password plus confirmation only in the browser;
- successful submission stores the Argon2id password hash, consumes the setup token atomically, and
  revokes all existing durable sessions for that Login Identity;
- issuing a replacement link immediately revokes every earlier unused setup link for the identity;
- expired, used, revoked, malformed, and wrong-purpose links return the same safe invalid-link page;
- the raw setup token and complete link never enter logs, audit payloads, agent/model context, or
  ordinary configuration.

Initial-setup and beta password-reset links use one 24-hour expiry. If the employee misses the
window, the developer issues a replacement link.

## Accepted Browser Authorization Flow

1. The launcher binds an ephemeral HTTP listener on `127.0.0.1`, generates a random `state` and PKCE
   verifier/challenge, and opens the system browser.
2. The employee enters email and password only on the Enterprise Hub HTTPS page.
3. After successful authentication, the server redirects the browser with a short-lived,
   single-use authorization code to the exact loopback callback.
4. The launcher validates `state` and exchanges the code plus PKCE verifier directly with the HTTPS
   token endpoint.
5. Only that back-channel response contains the access and durable session credentials. The
   loopback listener returns “登录成功，可以返回 Codex” and then closes.

The launcher is a public client and has no embedded client secret. The redirect never carries an
access or refresh token. The launcher binds only to IPv4 loopback on a random available port, the
server enforces the exact callback from the authorization request, and requests without PKCE are
rejected. No custom URL scheme is required.

## In-Progress: Remote/Headless And Secondary-Device Login

Status: design completed on 2026-08-07; implementation pending. The desktop browser flow above
remains the accepted, shipped boundary until the device-code flow ships; this section records the
active extension.

**Motivation.** Agents that run on a headless remote server — for example OpenClaw-family
deployments controlled from a phone, such as QClaw/小艺Claw-style setups — have no local system
browser, no loopback callback target, and no macOS Keychain or Windows Credential Manager. The
employee must still be able to authenticate from any device and let the remote agent obtain a
session without the agent/model ever reading the credentials.

**Confirmed scope (2026-08-07).** The supported agent forms for the new flow are:

- A — interactive desktop agents on macOS/Windows with a local system browser;
- B — phone-remote-controlled agents running on the employee's own PC;
- C — headless remote agents on VPS/cloud hosts with no local browser or OS credential store.

Support class D (fully unattended agents with no interactive login) is out of scope for login
flows. The design assumes every supported form has an employee channel that can present the
first-party login link to the employee, and that the employee can open that link in a mobile or
desktop browser.

**Agreed direction.**

- Implement the OAuth Device Authorization Grant semantics (RFC 8628) on the existing public-client
  contract rather than inventing a bespoke protocol.
- Use one uniform flow for all supported agent forms (A, B, and C): the launcher obtains a
  first-party login/verification link, the employee opens it in any mobile or desktop browser and
  authenticates, and the launcher completes the flow by polling the token endpoint. No loopback
  callback is required.
- Link delivery does not degrade the desktop experience: when the launcher runs on a machine with
  an interactive system browser (support class A), the launcher opens the link automatically;
  otherwise it returns the link so the agent surfaces it through the employee channel (support
  classes B and C).
- The employee-facing link pre-fills the one-time `user_code`; the employee's only credential
  input remains email and password on the first-party verification page. No one-time code is
  typed by hand.
- Preserve the existing secret boundaries: passwords and tokens never enter agent/model-visible
  channels; the browser never receives durable credentials; tokens continue to flow only over the
  back-channel poll response.
- Once shipped, this flow becomes the single official login flow and replaces the loopback
  Authorization Code flow described above; the accepted loopback sections remain current shipped
  state until then.

**Resolved design decisions (2026-08-07).**

- Split secrets: an unguessable, single-use, short-lived pending-login handle (the `device_code`
  equivalent) stays with the launcher, while the employee-facing link carries only the
  verification handle / `user_code`, so chat or link leakage cannot transfer the session.
- Pairing confirmation: the verification page displays the declared agent instance name and
  hostname, the employee channel mirrors the same identity, and the employee visually confirms the
  match before entering the password. The instance metadata is client-declared and accepted for
  the controlled beta, matching the existing treatment of launcher-version metadata.
- Headless credential custody: on hosts without a secure store (support class C), the launcher
  holds credentials in memory only and never writes a durable credential to disk; a launcher
  process restart therefore requires a new tap-link login. On macOS/Windows where Keychain or
  Credential Manager is available (support classes A and B), the existing durable secure-store
  behavior is unchanged. The launcher selects memory-only mode only after confirming no secure
  store is available (reusing the existing `secureStore.available` signal).
- Session model: support classes A and B keep one shared session per OS user per origin via the
  secure store. On support class C each launcher process owns one independent server-side session
  family and there is no cross-process sharing or local coordination file (memory-only mode cannot
  share across processes). The server already permits multiple session families per Employee
  Account; session inventory and single-session revoke stay deferred for beta.
- Pending-login record defaults: a pending login (`device_code` + `user_code`) expires after
  10 minutes; the launcher polls every 5 seconds with RFC 8628 `slow_down` backoff; `device_code`
  is single use, bound to the creating launcher instance and, at completion, to the Login
  Identity / Employee Account; records are stored as hashes only; each launcher instance has one
  active pending request (a new request revokes the old); the employee link is the standard
  `verification_uri_complete`; audit events cover creation, completion, expiry, and revocation.

All design branches for this flow are resolved. Implementation has not started; the remaining work
is implementation decomposition, server endpoints, the verification page, launcher flow selection,
and test mechanics.

This section does not yet change shipped desktop launcher behavior.

## Accepted Browser Page Delivery

Current staging runs one Fastify API container behind nginx and TLS at
`https://api.smedatacenter.xyz`. The same API renders:

- the authorization/login form and safe error state;
- the initial/reset password form;
- the invalid or expired setup-link page.

The launcher loopback listener renders the successful-login page. Pages use plain server-rendered
HTML with no React/Next.js bundle, client-side authentication state, external script/CDN, separate
frontend container, new domain, or `apps/admin-web` implementation. They require strict security
headers, CSRF and authorization-transaction checks, form-level tests, accessibility basics, and
neutral styling. Login pages keep the normal same-origin form target and add only
`http://127.0.0.1:*` to CSP `form-action` so Chrome can follow the successful form POST's redirect
to the validated ephemeral launcher callback; all non-login auth pages remain
`form-action 'self'`. Exact redirect validation, `state`, and PKCE remain mandatory. Existing
Docker, nginx, TLS, and deployment topology remains unchanged.

## Accepted Browser Session Behavior

The browser has no durable SSO session. It receives only a short-lived, `Secure`, `HttpOnly`,
`SameSite=Lax` authorization-transaction cookie that expires after 10 minutes and is deleted on
completion. Once the authorization code reaches the launcher, closing the page or clearing all
browser cookies has no effect on continued MCP use.

Closing or clearing the browser before code handoff leaves no authenticated launcher session; the
launcher safely starts a new browser flow when needed. A revoked, removed, or missing launcher
session also requires a new browser password login. Durable login state belongs only to the
launcher and operating-system credential store.

## Accepted Access-Token Lifetime

After authorization-code exchange, Enterprise Hub's token endpoint issues the launcher a bearer
access token valid for 10 minutes. The launcher keeps it only in process memory and automatically
uses its durable session credential to obtain a replacement shortly before expiry. A launcher
restart discards any access token and obtains a new one without opening the browser.

Token validity is evaluated when an MCP/API request begins; expiry during processing does not abort
an already accepted request. The employee never handles or sees the access token.

## Accepted Access-Token Format

The access token is an opaque bearer string containing at least 256 random bits and a recognizable
non-secret prefix such as `eh_at_`. MySQL stores only its cryptographic hash plus authoritative
session, Employee Account, expiry, and revocation metadata.

Every authenticated MCP/API request hashes the presented token and performs an indexed lookup.
Missing, expired, revoked, or database-unavailable validation fails closed. The token contains no
decodable employee, organization, or permission claims. A future managed OIDC provider may replace
password authentication while Enterprise Hub continues issuing the same internal access-token
contract.

## Accepted Durable-Session Lifetime

The launcher durable session has one absolute lifetime of 30 days from the most recent browser
password login, with no separate inactivity timeout. Access-token renewal and ordinary activity do
not extend it.

Within that window, launcher, agent, and computer restarts do not require browser login. At expiry,
the launcher automatically opens a new browser flow; successful password authentication starts a
new 30-day session. A developer-initiated password reset revokes the session earlier.

## Accepted Durable-Credential Rotation

The durable credential is an opaque bearer string containing at least 256 random bits and a
recognizable non-secret prefix such as `eh_rt_`. Each successful renewal atomically consumes the
presented generation and returns a new 10-minute access token plus a new durable credential. MySQL
stores hashes only and links all generations into one session family. The launcher immediately
replaces the old operating-system credential-store value.

Presenting any already consumed generation is treated as possible credential copying and revokes
the whole family. The launcher then starts browser login. There is no replay grace window. A lost
network response, launcher crash, or credential-store write failure at the exact rotation boundary
may therefore require browser login but cannot silently weaken replay detection.

## Accepted Secure-Store Policy

The launcher stores a durable credential only in macOS Keychain or Windows Credential Manager. It
never writes one to `.env`, JSON, MCP configuration, shell profiles, logs, the clipboard, or an
ordinary file. These stores are operating-system features and require no separate account,
subscription, or application installation, although the operating system may display its own
permission or unlock prompt.

Unavailable, locked, denied, or failed secure storage stops the authentication flow with a safe
actionable status. A failed rotating-credential write causes the launcher to discard the associated
access token and start browser login after secure storage is usable. A missing record means signed
out; there is no insecure fallback.

## Accepted Local Account And Concurrency Scope

Each operating-system user has one active Enterprise Hub account per service origin. Every Codex or
other supported agent client running as that OS user shares the same secure-store record. Beta has
no account list, account switching, or concurrent multi-account behavior.

Durable-credential refresh uses a cross-process single-flight lock. The winning process re-reads the
secure-store value, rotates it, and stores the replacement; waiting processes re-read after
acquiring the lock. Non-secret lock and coordination metadata may live in the normal per-user
application-state directory.

Different computers and different OS users receive independent server-side session families.
Explicit local sign-out removes the shared record and signs every local agent client out without
affecting other computers.

## Accepted OAuth Public-Client Contract

All official launcher instances use the fixed, non-secret client ID
`enterprise-hub-desktop-launcher`. Enterprise Hub exposes:

- `GET /oauth/authorize` with `response_type=code`, the fixed client ID, exact IPv4 loopback
  redirect URI, random `state`, and mandatory PKCE `S256`;
- `POST /oauth/token` for authorization-code exchange and rotating durable-credential renewal;
- `GET /.well-known/oauth-authorization-server` metadata advertising the authoritative issuer,
  endpoints, code flow, and PKCE methods.

Authorization codes contain at least 256 random bits, expire after 60 seconds, are single use, are
stored only as hashes, and bind to the client ID, exact redirect URI, PKCE challenge, Login
Identity, and authorization transaction. The token endpoint has no password grant, client secret,
arbitrary audience, or arbitrary scope. Issued tokens are restricted to the Enterprise Hub API/MCP
resource. Dynamic client registration does not exist.

## Accepted Launcher Source And Distribution Boundary

The authoritative launcher source remains in this product monorepo under `apps/mcp-launcher`.
Server API, OAuth contract, launcher implementation, tests, and compatible release changes can
therefore be reviewed together.

The official distribution artifact is a public, versioned npm package with a CLI `bin` and no
embedded secrets. The private main GitHub repository publishes through npm Trusted Publisher/OIDC;
Trusted Publisher supports a private source repository, but npm provenance is unavailable for
private source repositories. The workflow therefore must not request, claim, or gate approval on
npm provenance. The standalone Enterprise Hub skill repository contains installation and usage
guidance plus the exact approved launcher version. It may direct an authorized employee-owned agent
to install Node.js/npm when needed, install or update the launcher, and write MCP client
configuration, but it must not contain a second copy of launcher source.

Release status as of 2026-07-28: `enterprise-hub-mcp-launcher@0.1.0` is public. Its registry
integrity matches the reviewed tarball; exact-version clean installation, CLI execution, and the
installed production dependency audit passed. The npm Trusted Publisher is bound to
`YinXiaoyu-1998/SME_DATA_CENTER` and `launcher-release.yml` with stage-publish-only permission.
Because `0.1.0` required the one-time first publish, the first live OIDC staged publish will be
verified on a later version.

The launcher CLI has stable `serve`, `self-check`, and `logout` commands. Every invocation receives
only `ENTERPRISE_HUB_BASE_URL` with the canonical HTTPS origin. `serve` is the stdio MCP process.
`self-check` emits only the safe fields `ok`, `launcherVersion`, `serviceOrigin`, `platform`,
`secureStore.{available,durableCredentialPresent}`,
`server.{reachable,metadataCompatible,minimumLauncherVersion,recommendedLauncherVersion,recommendedUpdateAvailable}`,
and `mcp.handshake`, whose value is `ok`, `not_authenticated`, or `unavailable`. It never logs in or
returns credential contents. `logout` emits only `remoteRevocationConfirmed` and
`localCredentialRemoved` booleans, attempts family revocation when reachable, and always attempts
local credential deletion; local logout is successful only when `localCredentialRemoved` is true.

Do not create a separate launcher repository until it has a genuinely independent maintainer or
release cadence. The employee is not expected to run npm commands personally.

## Accepted Agent-Driven Installation Contract

After the Enterprise Hub skill is available, the employee asks the agent in natural language to
install and log in to Enterprise Hub. The skill is the authoritative installation runbook; the
employee-owned agent, not the employee and not an autonomous launcher self-installer, performs the
machine changes described by that runbook.

The runbook directs the agent to:

1. detect supported macOS or Windows;
2. require Node.js 22 or newer plus npm and install/upgrade them for the current user when absent or
   too old;
3. install the skill-approved exact launcher package version for the current user;
4. back up and idempotently update only the invoking agent's MCP configuration;
5. run a local launcher self-check; and
6. start the launcher, which opens the system browser for password login.

The normal path must not require `sudo` or administrator rights and must not alter unrelated MCP
servers or agent configuration. If a safe automatic step is unavailable, the runbook stops and
gives the agent a narrow, plain-language recovery instruction instead of making broad machine
changes. The employee's only routine visible actions are the natural-language request and entering
credentials in the Enterprise Hub browser page.

## Accepted Agent Compatibility Boundary

The launcher and remote protocol are agent-neutral. Codex and OpenClaw on macOS and Windows form the
first explicit support and end-to-end acceptance matrix. Each must pass skill discovery,
current-user launcher installation, MCP configuration, required reload/restart, browser login,
fixture upload, and later retrieval.

The skill must not stop merely because the host agent is not named. For other agents such as Qoder,
it provides a guarded adaptive path telling the host agent to determine its own supported local MCP
configuration mechanism from available product help, existing configuration, and environment
context. The agent may choose the appropriate installation/configuration location when no named
adapter applies, provided that it:

- confirms the client can run a local MCP launcher;
- backs up an existing configuration and makes the smallest idempotent change;
- preserves every unrelated MCP server and setting;
- validates the resulting configuration and launcher handshake; and
- reports a narrow blocker instead of guessing destructively when the correct mechanism cannot be
  established.

This adaptive path is best-effort interoperability, not an untested support guarantee. A client
becomes explicitly supported only after its full acceptance path is verified.

## Accepted Skill-Driven Launcher Update Policy

The launcher never installs npm packages or mutates its own executable. It reports its version and
consumes server metadata containing the minimum-supported and recommended launcher versions.
Supported versions continue normal use; a recommended-version difference may produce a
machine-readable, non-blocking notice. A version below the minimum returns the stable
`launcher_upgrade_required` condition without entering a login loop.

The repo-local and standalone Enterprise Hub skills are the joint distribution runbooks and must
remain synchronized. They determine whether an update is needed, select the exact approved package
version, instruct the employee-owned agent to install it for the current user, and rerun the
launcher self-check. The launcher and server do not independently choose or install a version.

Never install npm `latest` implicitly. A release is approved only when its exact public package,
Trusted Publisher workflow, compatibility tests, server version policy, and versions pinned by both
skill copies agree. Npm provenance is neither available nor an approval gate while the source
repository remains private. Updating the launcher preserves the secure-store session, non-secret
local state, and MCP configuration.

Implementing this design therefore requires material coordinated changes in both the repo-local
skill and the standalone skills repository; launcher/package work alone is incomplete.

## Accepted Logout And Uninstall Semantics

All local lifecycle operations are described by the skill and executed by the employee-owned agent
with narrow, idempotent changes:

- **Log out**: invoke the launcher to revoke the current server-side session family when reachable,
  delete the shared Keychain/Credential Manager record, and discard any in-memory access token.
  Because the secure-store session is shared, every local agent under that operating-system user is
  signed out.
- **Remove from one agent**: delete only Enterprise Hub's entry from that agent's MCP
  configuration. The shared launcher package, secure-store session, and integrations in other
  agents remain usable.
- **Completely uninstall Enterprise Hub**: revoke the session; remove Enterprise Hub MCP entries
  from every safely discoverable local agent; remove the current-user launcher package and
  Enterprise Hub non-secret local state; and delete the secure-store record.

These operations never delete the server-side Employee Account or business data. Uninstall never
removes Node.js/npm because unrelated software may depend on them. If the API is unreachable, local
credential removal still completes, but the agent reports that remote revocation was not confirmed;
the server session then ends through its fixed absolute expiry or a developer revoke operation.

## Accepted Secure-Store Record And Failure Policy

Each operating-system user has one versioned Keychain/Credential Manager record per canonical
Enterprise Hub HTTPS origin. A platform-specific key is deterministically derived from that origin.
The protected value contains only the opaque durable credential and the minimum schema/version
metadata required to read it. It never contains the employee password or a short-lived access
token.

The canonical origin, launcher version, refresh lock, and diagnostics containing no secrets live in
the normal per-user application-state directory. Refresh acquires the cross-process lock, re-reads
the current secure-store value, exchanges it, replaces the value with the rotated credential, and
verifies the replacement before releasing the lock.

If the server rotated the credential but the replacement cannot be stored and verified, the
launcher attempts to revoke the session family, removes any unusable local record, and requires
browser login. It never writes the credential to a normal file and never continues using the
consumed old value. The safe failure mode is one extra browser login.

Development JWTs and other pre-official credential formats are not migrated. The official launcher
has no code to read them and requires the employee to complete the browser login once.

## Accepted Reauthentication And Interrupted-Request Recovery

When an MCP operation has no usable durable session, the launcher returns the stable,
machine-readable `authentication_required` condition. Missing, expired, revoked, and
replay-revoked sessions use this condition; they never masquerade as an empty result or permission
denial.

The skill tells the agent to run the launcher login command. After browser login succeeds, the agent
retries the employee's original MCP operation once without asking the employee to repeat the
request. Browser cancellation or the ten-minute authorization-transaction timeout ends the attempt
without reopening the browser or retrying the MCP operation.

Failure classes remain distinct:

- API, DNS, TLS, and other connectivity failures return `service_unavailable` and do not open the
  browser;
- authorization denial returns `forbidden` and does not open the browser;
- an incompatible launcher returns `launcher_upgrade_required` and follows the skill-driven update
  path; and
- failure to bind the loopback callback retries once with a new ephemeral port, then returns a
  focused diagnostic.

The launcher reports typed conditions; the skill guides the agent's recovery while preserving the
employee's original intent.

## Deferred Session Administration

Beta does not add a session inventory, single-session revoke CLI, or employee-facing devices page.
That complexity is disproportionate for the initial four or five users.

Lost-device recovery uses the accepted developer-issued password-reset link. When the employee
successfully sets the replacement password, all existing durable sessions for that Login Identity
are revoked. Until that happens, the fixed 30-day absolute session lifetime remains the outer bound.
Per-session identification and immediate operator revoke may be reconsidered only when real usage
demonstrates the need.

The reopened remote/headless flow does create such a need for the new path: each headless agent
instance requires its own identifiable session family, so session identification and inventory are
open branches there even though the desktop beta keeps them deferred (see
“In-Progress: Remote/Headless And Secondary-Device Login”).

## Accepted Minimal Authentication Security Audit

Beta persists a durable security-event trail for:

- account onboarding;
- setup/reset link issuance and consumption;
- password-login success, failure, and cooldown entry;
- durable-session creation, revocation, and expiry;
- detected credential replay, suspicious or failed renewal, and security-policy rejection; and
- logout.

Routine successful ten-minute token renewals do not create an event. Each event contains a
timestamp, event type, outcome/reason, request ID, source IP, launcher version, and Login
Identity/Employee/session IDs only when known. Browser events record the request ID and source IP
but always have a null launcher version. OAuth token/refresh/revoke and MCP-authentication security
events record a launcher version only when the launcher actually supplied a valid version header.
That value is client-declared observational metadata, not launcher attestation; the client is not
required to supply it outside the existing OAuth compatibility contract. Operator and system paths
have null request metadata because they do not originate from an HTTP request.

Audit events never contain passwords, password hashes, access tokens, durable credentials,
authorization codes, PKCE material, setup/reset tokens, or full request bodies. They are retained
for 90 days and then purged. Reads are operator-only and outside employee MCP tools. Beta adds no
audit dashboard, employee-facing history, or real-time alerting.

## Deferred Layered Authentication Abuse Limits

Beta does not add source-IP budgets, endpoint-specific failure budgets, CAPTCHA, or an external
anti-bot service. The accepted per-identity five-attempt progressive cooldown remains the sole
authentication attempt limiter for the minimal beta.

These additional controls can be introduced if public signup, a larger user population, or observed
abuse changes the threat model. Their absence must not weaken generic login failures, high-entropy
one-time credentials, HTTPS, password hashing, or the existing identity cooldown.

## Accepted Minimal Password Policy

Beta accepts passwords from 8 through 128 Unicode characters. The eight-character minimum is an
explicit beta usability decision despite the stronger current recommendation for a 15-character
minimum when a password is the only authentication factor.

The password form:

- permits spaces, paste, password-manager/browser autofill, and a show/hide control;
- applies Unicode NFC normalization consistently before hashing and verification;
- never trims, truncates, or applies hidden case conversion;
- imposes no uppercase/lowercase/digit/symbol composition rule; and
- imposes no periodic password expiry.

The complete normalized password is rejected only when it appears in a small bundled list of
common/compromised passwords or equals an obvious service/account-specific value. Beta does not
call an external breach-password service.

The server stores only a uniquely salted Argon2id hash produced by a reviewed library. Parameters
are benchmarked on the staging host and must meet at least OWASP's current minimum Argon2id cost.
Verification processes the complete normalized password.

## Accepted Hard Cutover From Development Authentication

The temporary development email/JWT authentication system is deleted completely. There is no
compatibility period and no environment retains `/auth/dev-login`, JWT issuance, JWT bearer
verification, or a JWT-based launcher login/logout flow.

The cutover includes:

- migrating local, integration, CI, staging, and production tests and runtime behavior to the
  official Login Identity, Authorization Code + PKCE, opaque access-token, and rotating
  durable-session model;
- deleting `JWT_SECRET` and `STAGING_JWT_SECRET` from code, environment inventories, local/staging
  runtime configuration, GitHub staging secrets, deployment scripts, and runbooks;
- deleting obsolete JWT dependencies, fixtures, helpers, route contracts, and documentation rather
  than preserving adapters;
- requiring one official browser login after the cutover, with no migration of temporary
  credentials; and
- updating the repo-local and standalone skills plus every official user-facing document in the
  same release so none teaches the old email/JWT flow.

Tests may use internal factories and fixtures for deterministic setup, but no test-only runtime
authentication endpoint or alternate token format exists.

## Accepted Minimal Repair And Diagnostics

Repair is the accepted agent-driven installation flow run idempotently: the skill detects the host
agent and operating system, verifies the exact approved launcher version, backs up and minimally
repairs only Enterprise Hub's MCP entry, and reruns self-check. It preserves the secure-store
session whenever that record is valid.

The launcher provides a machine-readable self-check containing only non-secret facts needed by the
skill, such as launcher version, canonical service origin, platform, secure-store availability,
whether a durable record exists, server reachability, compatibility status, and MCP handshake
status. It never emits email, Employee/Login Identity IDs, tokens, credential hashes, setup links,
authorization codes, PKCE material, passwords, or complete configuration files.

## Design Interview Status

The official beta installation, browser login, token/session, local storage, skill orchestration,
recovery, password, audit, and hard-cutover decisions have reached an implementable boundary.
Remaining choices are implementation decomposition and test mechanics, not unresolved employee
experience or authentication policy.

The remote/headless and secondary-device login flow reached its implementable boundary on
2026-08-07: the device-code flow, link delivery, pairing, credential custody, and session model are
resolved. Remaining work is implementation decomposition, server endpoints, verification-page UX,
launcher flow selection, and test mechanics (see the In-Progress section).
