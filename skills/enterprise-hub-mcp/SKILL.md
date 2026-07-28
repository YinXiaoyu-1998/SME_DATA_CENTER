---
name: enterprise-hub-mcp
description: Install, configure, authenticate, and use the official Enterprise Hub remote MCP launcher without exposing employee credentials or operating service infrastructure.
---

# Enterprise Hub MCP

Use Enterprise Hub only through its official remote MCP launcher. This skill is the
current-user installation and recovery runbook for an employee-owned agent; it is not a
service-operations runbook.

The approved service origin is `https://api.smedatacenter.xyz`. The approved launcher is
the exact npm package `enterprise-hub-mcp-launcher@0.1.0`. Do not substitute another
origin, package, tag, or version. In particular, never install npm `latest` and never let
the launcher update itself.

## Hard Boundaries

- The employee enters an account password only in the Enterprise Hub browser page. Never ask
  for, accept, read, store, paste, or transmit an email/password, access token, durable
  credential, authorization code, raw `Authorization` header, or credential-store record.
- Use only launcher configuration and tools. Do not call Enterprise Hub API endpoints directly
  and do not operate its API, database, Qdrant, storage, Docker, worker, cloud resources, or
  deployment.
- Do not create reports, dashboards, or final business conclusions. Return only tool-visible
  records, statuses, and evidence within the employee's backend-authorized scope.
- Do not provide an organization ID. The service derives organization and label visibility from
  the authenticated Employee Account; never infer hidden data from a forbidden/not-found result.
- The launcher stores its durable credential only in the operating-system secure store. Never
  put credentials in configuration, environment variables, arguments, ordinary files, logs, or
  chat.

## Official Install Or Update

An employee may ask in natural language to install, update, or repair Enterprise Hub. The
employee does not need to run these commands personally. Work only for the current OS user and
only on the invoking agent's configuration.

1. Confirm the host is macOS or Windows and that the user authorizes this current-user install.
   Run `node --version` and `npm --version`. Require Node.js major version **22 or newer** and a
   working npm. If Node.js is missing or older than 22, install or upgrade Node.js/npm for the
   current user before continuing; do not use administrator privileges or alter unrelated tools.
2. Use the fixed platform directory:

   | Platform | Launcher directory                                                      |
   | -------- | ----------------------------------------------------------------------- |
   | macOS    | `~/Library/Application Support/Enterprise Hub/launcher/versions/0.1.0/` |
   | Windows  | `%LOCALAPPDATA%\\Enterprise Hub\\launcher\\versions\\0.1.0\\`           |

3. Install or repair the exact package idempotently. Substitute only the platform directory
   above; do not add credentials or a global install:

   ```sh
   npm install --prefix "<launcher-directory>" --save-exact enterprise-hub-mcp-launcher@0.1.0
   ```

4. Preserve the existing installation if the same pinned package is already present. For an
   approved update, install the newly approved exact version into its own versioned directory,
   update the one launcher path in the invoking agent's MCP entry, then run the self-check.
   Updating does not delete the secure-store session or unrelated MCP servers.
5. Run the installed launcher's credential-free self-check before changing or declaring an MCP
   configuration healthy:

   ```sh
   ENTERPRISE_HUB_BASE_URL=https://api.smedatacenter.xyz \
     "$HOME/Library/Application Support/Enterprise Hub/launcher/versions/0.1.0/node_modules/.bin/enterprise-hub-mcp-launcher" self-check
   ```

   ```powershell
   $env:ENTERPRISE_HUB_BASE_URL = "https://api.smedatacenter.xyz"
   & "$env:LOCALAPPDATA\Enterprise Hub\launcher\versions\0.1.0\node_modules\.bin\enterprise-hub-mcp-launcher.cmd" self-check
   ```

   The stable self-check contract is safe machine-readable JSON with this shape:

   ```json
   {
     "ok": true,
     "launcherVersion": "0.1.0",
     "serviceOrigin": "https://api.smedatacenter.xyz",
     "platform": "<safe platform>",
     "secureStore": {
       "available": true,
       "durableCredentialPresent": false
     },
     "server": {
       "reachable": true,
       "metadataCompatible": true,
       "minimumLauncherVersion": "<safe version>",
       "recommendedLauncherVersion": "<safe version>",
       "recommendedUpdateAvailable": false
     },
     "mcp": {
       "handshake": "ok"
     }
   }
   ```

   `mcp.handshake` is `ok`, `not_authenticated`, or `unavailable`. Self-check never performs
   browser login and never returns credential contents. If it reports a typed failure, follow the
   focused recovery below; do not inspect secure storage or repair the remote service.

Use this exact stdio launch tuple after installation. `ENTERPRISE_HUB_BASE_URL` is the only
launcher environment variable; do not add another environment value or any credential.

| Platform | Command                                                                                                              | Arguments | Environment                                             |
| -------- | -------------------------------------------------------------------------------------------------------------------- | --------- | ------------------------------------------------------- |
| macOS    | `~/Library/Application Support/Enterprise Hub/launcher/versions/0.1.0/node_modules/.bin/enterprise-hub-mcp-launcher` | `serve`   | `ENTERPRISE_HUB_BASE_URL=https://api.smedatacenter.xyz` |
| Windows  | `%LOCALAPPDATA%\\Enterprise Hub\\launcher\\versions\\0.1.0\\node_modules\\.bin\\enterprise-hub-mcp-launcher.cmd`     | `serve`   | `ENTERPRISE_HUB_BASE_URL=https://api.smedatacenter.xyz` |

The command, its single `serve` argument, and the one URL-only environment value are the complete
stdio configuration. It must never contain a password, token, header, client secret, or OAuth
setting.

## Configure The Invoking Agent

Always inspect the existing configuration first, create a timestamped backup before modifying it,
then make the smallest idempotent change: one `enterprise-hub` stdio MCP entry. Preserve every
unrelated server and setting. Do not configure a direct HTTP/OAuth Enterprise Hub server because
the local launcher owns browser login and credential storage.

### Codex

Use the verified Codex CLI MCP registry. On macOS, prefer `codex` from `PATH`; when it is absent,
use the bundled `/Applications/ChatGPT.app/Contents/Resources/codex` fallback. On Windows, resolve
`codex.exe` from `PATH`. Stop if neither verified binary exists.

Before the first mutation, inspect with `codex mcp list --json` and
`codex mcp get enterprise-hub --json`. Back up `~/.codex/config.toml` (Windows:
`%USERPROFILE%\.codex\config.toml`) to a timestamped sibling file when it exists. If the existing
entry already matches the exact command, `serve` argument, and sole BASE_URL environment value, do
nothing.

For macOS add/repair:

```sh
CODEX_BIN="$(command -v codex 2>/dev/null || true)"
if [ -z "$CODEX_BIN" ] && [ -x "/Applications/ChatGPT.app/Contents/Resources/codex" ]; then
  CODEX_BIN="/Applications/ChatGPT.app/Contents/Resources/codex"
fi
test -n "$CODEX_BIN"
CODEX_CONFIG="$HOME/.codex/config.toml"
if [ -f "$CODEX_CONFIG" ]; then
  cp -p "$CODEX_CONFIG" "$CODEX_CONFIG.enterprise-hub.bak.$(date +%Y%m%d%H%M%S)"
fi
"$CODEX_BIN" mcp list --json
"$CODEX_BIN" mcp get enterprise-hub --json
```

If `get` reports the entry absent, add it. If it is present and exact, stop without mutation. Only
when it is present and mismatched, remove that one entry immediately before running the same add
command:

```sh
# Mismatched entry only:
"$CODEX_BIN" mcp remove enterprise-hub
# Missing or just-removed entry:
"$CODEX_BIN" mcp add \
  --env ENTERPRISE_HUB_BASE_URL=https://api.smedatacenter.xyz \
  enterprise-hub -- \
  "$HOME/Library/Application Support/Enterprise Hub/launcher/versions/0.1.0/node_modules/.bin/enterprise-hub-mcp-launcher" serve
"$CODEX_BIN" mcp get enterprise-hub --json
```

For Windows PowerShell, use the same `list`/`get`/`remove`/`add` sequence:

```powershell
$CodexBin = (Get-Command codex.exe -ErrorAction Stop).Source
$CodexConfig = Join-Path $env:USERPROFILE ".codex\config.toml"
if (Test-Path $CodexConfig) {
  Copy-Item $CodexConfig "$CodexConfig.enterprise-hub.bak.$(Get-Date -Format yyyyMMddHHmmss)"
}
$LauncherBin = "$env:LOCALAPPDATA\Enterprise Hub\launcher\versions\0.1.0\node_modules\.bin\enterprise-hub-mcp-launcher.cmd"
& $CodexBin mcp list --json
& $CodexBin mcp get enterprise-hub --json
```

If `get` reports the entry absent, add it. If it is present and exact, stop without mutation. Only
for a present mismatched entry, run:

```powershell
# Mismatched entry only:
& $CodexBin mcp remove enterprise-hub
# Missing or just-removed entry:
& $CodexBin mcp add --env "ENTERPRISE_HUB_BASE_URL=https://api.smedatacenter.xyz" enterprise-hub -- $LauncherBin serve
& $CodexBin mcp get enterprise-hub --json
```

After add/repair, run the platform self-check above, restart/reload Codex, run
`codex mcp list --json` and `codex mcp get enterprise-hub --json`, and confirm the discovered tools.
If add fails after removal, restore the timestamped backup and report the focused failure. For
per-agent removal, back up first, run `codex mcp remove enterprise-hub`, then verify
`codex mcp list --json` no longer contains it and `codex mcp get enterprise-hub --json` reports it
absent.

### OpenClaw

Use OpenClaw's MCP CLI registry for a **stdio** launcher; do not use OpenClaw's direct remote
OAuth store, `openclaw mcp login`, or `openclaw mcp logout` for Enterprise Hub.

1. Inspect first: `openclaw mcp status --verbose` and, when present,
   `openclaw mcp show enterprise-hub --json`.
2. Back up the OpenClaw configuration using its supported current-user mechanism.
3. Add the entry with the platform-specific launcher path from the table, its single `serve`
   argument, and the sole URL-only environment value. On macOS, the verified OpenClaw CLI form is:

   ```sh
   openclaw mcp add enterprise-hub \
     --command "$HOME/Library/Application Support/Enterprise Hub/launcher/versions/0.1.0/node_modules/.bin/enterprise-hub-mcp-launcher" \
     --arg serve \
     --env ENTERPRISE_HUB_BASE_URL=https://api.smedatacenter.xyz
   ```

   If the entry already exists, use `openclaw mcp set enterprise-hub '<one stdio JSON object>'`
   with exactly `command`, `args: ["serve"]`, and the one `ENTERPRISE_HUB_BASE_URL` environment
   value. Do not add an HTTP URL or `auth: oauth` configuration.

4. Verify with `openclaw mcp doctor enterprise-hub --probe`. Reload or restart the owning
   OpenClaw runtime when required by its current setup.

`openclaw mcp add/set/doctor --probe` are the supported configuration/proof path. The launcher,
not OpenClaw's OAuth store, opens the browser and manages the Enterprise Hub secure session.

### Other Agents

Use guarded adaptive discovery. Inspect the installed client's help, current configuration, and
MCP capabilities to confirm that it can start a local stdio server. Back up its configuration,
add only the pinned Enterprise Hub launcher entry, validate its handshake, and preserve every
unrelated server. If its supported configuration mechanism is not clear, report the narrow blocker
instead of editing guessed files or configuring direct remote OAuth.

## Browser Login And Normal Use

Call `enterprise_hub_auth_status` before beginning work when the authentication state is unknown.
If it reports `authentication_required`, call `enterprise_hub_login`. The launcher opens the
system browser; ask the employee to finish login there and never request any credential in chat.
The launcher returns only a safe outcome.

After successful login, retry the employee's original business tool call exactly once. Do not
retry repeatedly after browser cancellation or an unsuccessful login. Use
`enterprise_hub_logout` only when the employee asks to sign out. It clears the shared local
session for Enterprise Hub under the current OS user, so all locally configured agents on that
OS user are signed out.

For authorized service tools:

- List labels before uploading; use only returned label keys.
- Read only a user-attached or explicitly assigned file, preserve its exact bytes, and encode
  those bytes mechanically for an inline file input. Never send a local path to the service or
  reconstruct/normalize/translate upload contents.
- Poll document/import status gently when the employee asks; never start a worker.
- Reuse a structured-import idempotency key only for the exact same file and metadata. Treat an
  import-status 404 as "not visible or missing" and do not infer hidden metadata.
- Treat evidence cursors as opaque, short-lived continuations. Return `page.nextCursor` unchanged
  with the same query, filters, and limit. Restart without it on `INVALID_CURSOR`; on
  `CURSOR_EXPIRED`, explain the expiry and restart only if the employee still wants more results.
- `enterprise_hub_list_skills` exposes approved directory metadata only; do not execute an entry.

## Typed Recovery

| Condition                                     | Required response                                                                                                                            |
| --------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `authentication_required`                     | Call `enterprise_hub_login`, wait for browser completion, then retry the original business operation once.                                   |
| Browser cancelled, timed out, or login failed | Report the safe outcome. Do not reopen the browser automatically or retry the business operation.                                            |
| `service_unavailable`                         | Report that the official service cannot be reached. Do not start, repair, or diagnose service infrastructure.                                |
| `forbidden` or not-found                      | Treat the resource as unavailable to this employee; do not infer hidden data.                                                                |
| `launcher_upgrade_required`                   | Install the skill-approved exact launcher version, re-run self-check, then retry the original operation once if installation succeeds.       |
| Local configuration/self-check failure        | Restore the backup only when the agent can do so safely; otherwise report the focused configuration failure. Never delete unrelated entries. |

## Removal And Complete Uninstall

For **per-agent removal**, back up that agent's configuration and delete only its
`enterprise-hub` MCP entry. Leave the launcher package, secure-store session, and other agent
configurations intact.

For **shared logout**, use `enterprise_hub_logout` while the MCP connection is available, or invoke
the pinned launcher directly:

```sh
ENTERPRISE_HUB_BASE_URL=https://api.smedatacenter.xyz \
  "$HOME/Library/Application Support/Enterprise Hub/launcher/versions/0.1.0/node_modules/.bin/enterprise-hub-mcp-launcher" logout
```

```powershell
$env:ENTERPRISE_HUB_BASE_URL = "https://api.smedatacenter.xyz"
& "$env:LOCALAPPDATA\Enterprise Hub\launcher\versions\0.1.0\node_modules\.bin\enterprise-hub-mcp-launcher.cmd" logout
```

The stable logout contract returns only
`{"remoteRevocationConfirmed":<boolean>,"localCredentialRemoved":<boolean>}`. It attempts remote
family revocation when reachable and always attempts local credential deletion;
`localCredentialRemoved` must be `true` before reporting local logout success. It never returns
credential contents. If the service is unreachable, report that remote revocation was not
confirmed.

For **complete uninstall**, with explicit employee authorization: perform shared logout; remove
Enterprise Hub entries only from safely discoverable local agents; remove the current-user pinned
launcher directory and its non-secret Enterprise Hub state; retain backups until the employee
confirms success. Never remove Node.js/npm, the Employee Account, server-side business data, or
unrelated MCP entries.

## Pre-Cutover Note

This is the official target runbook. It intentionally does not describe repository development-only
authentication behavior. Until the official identity, launcher package, and public MCP
implementation land together, do not represent this skill as proof that the remote flow is live.
