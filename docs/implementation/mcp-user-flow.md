# Enterprise Hub MCP User Flow

> **Official implementation:** This is the implemented employee flow. The pinned npm package
> `enterprise-hub-mcp-launcher@0.2.7` is published and the official service is deployed in staging.
> Native macOS/Windows package acceptance and the headless Linux loop pass; user-visible OpenClaw
> and support-class-C phone/browser acceptance remain release evidence. There is no
> development-login or JWT compatibility path.

Last updated: 2026-08-10

This document describes the employee-facing trust boundary, not a service-operations runbook. The
authoritative agent runbook is the dual-homed `enterprise-hub-mcp` skill. The official remote origin
is `https://api.smedatacenter.xyz`; the only approved launcher distribution is
`enterprise-hub-mcp-launcher@0.2.7`.

## Participants And Credential Boundary

```mermaid
flowchart LR
  Employee["Employee"] -->|"Natural-language request"| Agent["Employee-owned agent / MCP client"]
  Agent -->|"Reads installation and recovery guidance"| Skill["enterprise-hub-mcp skill"]
  Agent <-->|"Local stdio; no credential in configuration"| Launcher["Pinned local launcher"]
  Launcher -->|"Opens or surfaces verification link"| Browser["Enterprise Hub HTTPS verification page"]
  Browser -->|"Password + pairing confirmation"| Auth["Enterprise Hub identity endpoints"]
  Launcher <-->|"Device Authorization polling"| Auth
  Launcher -->|"Streamable HTTP POST /mcp\nopaque bearer access token"| Api["https://api.smedatacenter.xyz"]
  Api --> Data["Backend-authorized service\nAPI, storage, worker, MySQL, Qdrant"]
```

| Boundary             | Credential rule                                                                                                                                                                         |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Employee -> agent    | The employee requests an action, but never gives a password, token, authorization code, or credential-store record to the agent.                                                        |
| Agent -> launcher    | The configured local stdio entry contains no secret. The agent may invoke only `enterprise_hub_login`, `enterprise_hub_logout`, and `enterprise_hub_auth_status` for session lifecycle. |
| Launcher -> browser  | The employee enters a password and confirms the agent instance only in the Enterprise Hub HTTPS page; the browser never returns credentials through the agent/model.                    |
| Launcher -> API/MCP  | The launcher polls the token endpoint, protects and attaches opaque access tokens, and uses Keychain/Credential Manager or memory-only custody on genuinely headless hosts.             |
| MCP -> business data | Every request is authenticated and backend-authorized. The skill/launcher never directly operate API infrastructure, database, Qdrant, storage, Docker, worker, or cloud resources.     |

## Installation Or Update

1. The employee asks their agent to install, update, or repair Enterprise Hub.
2. The agent confirms macOS or Windows, checks current-user Node.js/npm availability, and uses the
   skill-approved exact launcher package in the platform versioned directory.
3. Before modifying the invoking agent's MCP configuration, it inspects and creates a backup.
   It then adds only an `enterprise-hub` **stdio** entry for the pinned launcher and leaves all
   unrelated entries unchanged.
4. Codex uses its supported current configuration mechanism. OpenClaw uses
   `openclaw mcp add`/`set`, then `openclaw mcp doctor enterprise-hub --probe`; it does not use
   direct remote OAuth storage. Other agents use guarded adaptive discovery and stop if their
   safe stdio configuration mechanism cannot be established.
5. The agent runs the launcher's credential-free self-check and reloads/restarts the MCP client as
   needed. It never lets the launcher self-update or installs npm `latest`.

## Login And One-Retry Recovery

```mermaid
sequenceDiagram
  autonumber
  participant E as "Employee"
  participant A as "Agent / MCP client"
  participant L as "Pinned launcher"
  participant B as "System browser"
  participant S as "Enterprise Hub service"

  E->>A: "Upload/search/query Enterprise Hub"
  A->>L: "enterprise_hub_auth_status or business tool"
  alt authentication_required
    A->>L: "enterprise_hub_login"
    L->>S: "Request Device Authorization"
    S-->>L: "Verification link and user code"
    L->>B: "Open or surface HTTPS verification link"
    E->>B: "Enter credentials only in browser"
    B->>S: "Confirm pairing and authorize"
    L->>S: "Poll token endpoint"
    S-->>L: "Opaque credentials remain launcher-only"
    L-->>A: "Safe login outcome"
    A->>L: "Retry original business operation once"
  else usable session
    L->>S: "Authenticated POST /mcp"
    S-->>L: "Authorized tool result"
  end
  L-->>A: "Token-free result"
  A-->>E: "Visible status or records"
```

`authentication_required` means the agent calls `enterprise_hub_login`, waits for browser
completion, and retries the original operation once. Browser cancellation, timeout, or failed login
ends that attempt without an automatic browser loop or business-operation retry. `service_unavailable`
means the agent reports the connection failure and does not open a browser or repair service
infrastructure. `forbidden` and not-found results do not prove hidden data exists.

`enterprise_hub_logout` is explicit. It removes the shared current-OS-user local session and asks
the service to revoke it when reachable, which signs out all Enterprise Hub agents sharing that
secure-store record. Removing one agent's MCP entry is not logout; complete uninstall is a separate,
explicitly authorized lifecycle action.

## Business Tool Use

- List labels before uploads and use only returned label keys. Do not supply an organization ID.
- Read only a user-selected or explicitly assigned file's exact bytes. Prefer the launcher's
  `file.encoding="path"` input with an absolute local path; use inline base64 only for small files.
  Never reconstruct, normalize, translate, or retype the content.
- Status polling is allowed only to observe service state. Do not start workers or operate any
  Enterprise Hub service component.
- After a text/evidence or structured-table upload returns `202`, keep its Document ID and, for a
  structured upload, ImportBatch ID. Poll the matching status tool after 2 seconds, then 5 seconds,
  then 10 seconds, then every 15 seconds, up to 10 minutes. Report success only at a terminal
  success state; safely summarize `rejected`/`failed` with correction advice. At 10 minutes without
  a terminal result, say still processing with the IDs and how to check later; do not report failure
  or re-upload instead of polling.
- Reuse a structured-import idempotency key only for exact replay. Treat an import-status 404 as
  not visible or missing, without inferring a hidden batch.
- For structured queries, discover the dataset registry first, send only `canonicalName` field
  values, and use source columns or aliases only to understand the user's wording or label result
  columns.
- `describe_structured_dataset_coverage` reports currently readable applied source windows or
  snapshots for one dataset. It is source coverage, not a completeness guarantee or automatic
  answer-quality verdict; the agent decides whether to query, narrow, or ask a clarification.
- Treat evidence cursors as opaque same-query continuations. On `INVALID_CURSOR`, restart without
  it. On `CURSOR_EXPIRED`, explain the expiry and restart only if the employee still wants more.
- `enterprise_hub_list_skills` returns directory metadata only. Do not execute an entry, generate a
  report, or turn Enterprise Hub into a direct employee-facing AI service.

## Current Release Boundary

The code implements OAuth Device Authorization, opaque access tokens, rotating durable credentials,
desktop secure-store and headless memory-only custody, public HTTPS `/mcp`, and the pinned launcher.
The staging migration, official-session fixture smoke, native macOS/Windows package acceptance, and
headless Linux login-to-business-tool loop have passed. Full user-visible OpenClaw and
support-class-C phone/browser acceptance remain. The retained Authorization Code + PKCE endpoints
serve minimum-compatible 0.1.x launchers only; removed `/auth/dev-login`, JWT, and local email-login
tools must remain absent.
