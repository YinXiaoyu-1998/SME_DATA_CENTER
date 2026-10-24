# DeepSeek Harness (dsh) wiring

This file is for **DeepSeek Harness (dsh)** only, and describes the configuration shape of the
current dsh release. Other hosts (Codex, Claude Code, OpenClaw, and the adaptive path in
"Other Agents") do not need it; their sections in `SKILL.md` remain authoritative. If anything
here conflicts with `SKILL.md`, `SKILL.md` wins.

dsh is not configured with a `mcp add` CLI or a JSON client file. It composes plugins from a
cordis profile, and the user-editable layer of that profile is `cordis.patch.yml`.

## Where the entry goes

- Profile directory: `~/.dsh/profiles/<profile>/cordis.patch.yml`.
- Add exactly one insert entry for `@deepseek-ai/dsh-mcp-client`.
- dsh resolves the MCP client plugin from its own dependency set; installing it into the profile
  is not required. Verified on a fresh profile with no profile-level install.
- Keep every other entry in that file untouched. Preserve unrelated plugins and settings.

## Copy-paste entry

```yaml
- insert:
    - id: mcp-smedc
      name: "@deepseek-ai/dsh-mcp-client"
      config:
        serverName: smedc
        transport: stdio
        command: "<absolute path to the launcher executable>"
        args: ["serve"]
        env:
          SMEDC_BASE_URL: "https://api.smedatacenter.xyz"
```

`command` must be an absolute path resolved for the current user, for example on macOS:

```
$HOME/Library/Application Support/SMEDC/launcher/versions/0.13.0/node_modules/.bin/smedc-mcp-launcher
```

Use the same versioned launcher directory that `SKILL.md` installs into. Do not point
`command` at a globally installed package, an `npx` wrapper, or a shell that expands
variables at run time. Do not add an HTTP URL or OAuth configuration: the launcher owns browser
login and credential storage.

The entry contains no secrets. Do not add tokens, cookies, or credentials to `env`; the only
environment value is `SMEDC_BASE_URL`.

## Tool naming on dsh

dsh registers every MCP tool under a server-qualified name, so the tools in this skill appear as
`mcp__smedc__<tool>`. Nothing is renamed on the wire; the launcher still receives the bare name.

| This skill says                                | dsh exposes                                                            |
| ---------------------------------------------- | ---------------------------------------------------------------------- |
| `smedc_auth_status`                            | `mcp__smedc__smedc_auth_status`                                        |
| `smedc_login` / `smedc_logout`                 | `mcp__smedc__smedc_login` / `mcp__smedc__smedc_logout`                 |
| `get_my_permissions`                           | `mcp__smedc__get_my_permissions`                                       |
| `query_store_reviews` / `upsert_store_reviews` | `mcp__smedc__query_store_reviews` / `mcp__smedc__upsert_store_reviews` |
| `query_structured_dataset`                     | `mcp__smedc__query_structured_dataset`                                 |
| `upload_structured_dataset`                    | `mcp__smedc__upload_structured_dataset`                                |

Map names one-to-one; a tool that does not appear in the session's tool list is not connected,
not renamed differently.

## Tool-schema rejection before a turn starts

If dsh reports `Invalid schema for function` with `is not a "regex"` for an SMEDC upload
tool, the provider rejected its tool definition before model execution. Repeating the request or
logging in again will not repair it. Report the installed launcher version and affected tool;
the employee may switch to PTC mode as a temporary workaround. A source fix alone does not
update the installed launcher. Use the approved exact pin in `SKILL.md` when a verified release
becomes available, then reconnect the owning host and verify its loaded tools.

## Verify the connection

After the profile loads, confirm in this order:

1. `mcp__smedc__smedc_auth_status` returns `authenticated: true` and the expected service URL.
2. `mcp__smedc__smedc_get_current_user` returns the employee identity, role, clearance, and
   organization. Report only what the employee needs; do not echo the full record into files.
3. `mcp__smedc__get_my_permissions` is called freshly before any business call, as required by
   `SKILL.md`; do not cache it.

A missing tool list after editing `cordis.patch.yml` means the profile has not reloaded, not that
the launcher is broken. Check the entry, then reload or restart the profile through its supported
mechanism.

## Launcher process hygiene

One launcher child process per connected host is normal. Several hosts — including a previous dsh
session, Codex, or another MCP client — can legitimately run their own copy of the same launcher
at the same time, from the same versioned directory.

- **Never kill or remove launcher processes or configuration entries you did not create.** An idle
  or seemingly redundant launcher may belong to another host that is still using it. Leaving a
  foreign entry in place is always safer than cleaning it up.
- Identify a process by its resolved executable path and parent process, not by its argv shape
  alone, and never print secret arguments.
- To refresh this host, disconnect or restart only dsh's own connection. Do not stop the shared
  daemon, do not remove other hosts' entries, and do not uninstall the launcher to "reset".
- `self-check` is credential-free and safe to run repeatedly; prefer it over restarting anything.
- Do not delete files under the versioned launcher directory as part of troubleshooting.

## Scope reminder

This wiring exists so the launcher runs through dsh's native MCP client. It does not change
authentication, permission checks, tenant gating, upload semantics, or any review/publication
boundary described in `SKILL.md`.
