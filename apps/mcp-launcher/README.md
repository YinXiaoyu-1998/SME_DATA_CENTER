# SMEDC MCP Launcher

Official stdio MCP launcher. This checkout targets candidate `0.10.1`. The approved public package is `smedc-mcp-launcher@0.10.0`; the service recommends 0.10.0 and requires at least 0.6.0. Release/target deployment evidence is maintained in the repository's `docs/implementation/staging-readiness.md`.

## Installation and identity

Use the dual-homed `smedc-mcp` Skill for exact current-user installation, host configuration, login, recovery and removal. Supported OS platforms are macOS, Windows and Linux with Node.js 22+. Never install an implicit npm `latest` or make the launcher self-update.

The only service configuration is `SMEDC_BASE_URL`, a canonical HTTPS origin. Commands are `serve`, `self-check`, `logout` and `--version`. Credentials are never accepted through arguments, environment variables or MCP input.

Login uses OAuth Device Authorization. The employee authenticates and confirms the agent instance on the first-party page; protocol credentials remain inside the launcher. An available OS secure store protects the durable credential. A headless host without one uses memory-only custody and requires login after process restart; a denied/broken desktop store is not a reason to write secrets to ordinary files.

## Current tool behavior

- Permission cards and admin configuration use current server state. Grants are not cached. Writes carry the current expected version; conflicts require rereading state.
- Active admins upload. Cached profiles provide an early denial before local file access; the service remains authoritative. The cache holds display name, email, role, clearance and organization name only. Current-user lookup reads live state.
- Evidence uploads require explicit category, complete scopes and file level. Photos require one enterprise and exact store. Fixed-category uploads cannot override enabled server category levels with a legacy level field.
- Business/dishes local file paths use launcher-owned multipart transport. Status is polled by job ID; accepted uploads are not completed processing.
- Range partition download is the default. Optional prepared ZIP download uses prepare, status and then a succeeded requestId, with no selectors mixed into that final call. Confirm matching service support; tools/list alone is insufficient. Verify scope, ZIP/CSV integrity and safe paths before returning local extracts. Internal signed partition URLs never reach the agent.
- Ledger tools expose coverage, preparation, request status and URL issuance. They do not generate PDFs; changed/missing outputs wait for the configured daily service job. PDF delivery is independently enabled on the target service.
- No tool accepts arbitrary API paths or SQL. Account/tenant authorization, safe status views and content access remain distinct server contracts.

Business MCP calls have a 45-second deadline; connection/profile calls have 30 seconds. Downloads enforce request/stall limits, a 240-second invocation budget and bounded whole-file retries; cancellation removes incomplete output. Multipart progress counts transport-consumed bytes, with a 30-second stall deadline while progressing transfers may continue.

## Diagnostics and logout

`self-check` returns safe version/origin/platform/store/server/MCP status and never logs in or reveals a credential. `smedc_get_current_user` returns only the current user's display identity and role/clearance/organization name; `smedc_auth_status` does not expose cached identity.

`logout` attempts remote family revocation and local credential deletion, reporting `remoteRevocationConfirmed` and `localCredentialRemoved`. Removing one host's MCP entry is distinct from logout or complete uninstall.

The package is published through npm Trusted Publisher from a private source repository; npm provenance is unavailable. Source, API schemas and full usage guidance remain in the product repository and official Skill; this README does not authorize publishing, deployment or tenant activation.
