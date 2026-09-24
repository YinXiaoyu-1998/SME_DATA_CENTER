# SMEDC MCP Launcher

Official stdio MCP launcher for SMEDC. It reads only `SMEDC_BASE_URL`, which must
be a canonical HTTPS origin. Browser sign-in uses OAuth Authorization Code with PKCE; credentials
are never accepted through command arguments, environment variables, or MCP tool inputs.

Commands: `serve`, `self-check`, `logout`, and `--version`.

Release: `smedc-mcp-launcher@0.5.2` (`smedc-mcp-launcher --version` reports `0.5.2`).

All three file-upload tools remain discoverable and require the admin role. The launcher
rejects cached employee-role uploads before reading a local file or processing upload input.
For an unknown or legacy profile, it first queries authenticated `/me` and securely caches
only display name, email, role, clearance, and organization name with the credential. Profile
lookup failures stop the upload. Logout clears the cached profile. The service remains the
authority for upload authorization, including when a local cache has been modified.

The `serve` command exposes the authenticated `smedc_get_current_user` tool so an
employee can confirm the current SMEDC display name, email, and role without exposing
credentials or accepting a selector for another account.
This tool always reads the live service profile; `smedc_auth_status` does not reveal the cache.

`self-check` writes one safe JSON object with `ok`, `launcherVersion`, `serviceOrigin`, `platform`,
`secureStore`, `server`, and `mcp` fields. `logout` always attempts local cleanup and writes
`remoteRevocationConfirmed` and `localCredentialRemoved` booleans. Neither command writes
credential contents.

This public package has no npm provenance because the source repository is private.
