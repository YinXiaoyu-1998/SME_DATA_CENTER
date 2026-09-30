# SMEDC MCP Launcher

Official stdio MCP launcher for SMEDC. It reads `SMEDC_BASE_URL`, which must
be a canonical HTTPS origin. Browser sign-in uses OAuth Device Authorization; credentials are
never accepted through command arguments, environment variables, or MCP tool inputs.

Commands: `serve`, `self-check`, `logout`, and `--version`.

Release target: `smedc-mcp-launcher@0.7.0` (`smedc-mcp-launcher --version` reports `0.7.0`).

All three file-upload tools remain discoverable and require the admin role. The launcher
rejects cached employee-role uploads before reading a local file or processing upload input.
For a newly established session without a cached profile, it first queries authenticated `/me` and securely caches
only display name, email, role, clearance, and organization name with the credential. Profile
lookup failures stop the upload. Logout clears the cached profile. The service remains the
authority for upload authorization, including when a local cache has been modified.

The `serve` command exposes the authenticated `smedc_get_current_user` tool so an
employee can confirm the current SMEDC display name, email, and role without exposing
credentials or accepting a selector for another account.
This tool always reads the live service profile; `smedc_auth_status` does not reveal the cache.

`self-check` writes one safe JSON object with `ok`, `launcherVersion`, `serviceOrigin`, `platform`,
`credentialProfile`, `secureStore`, `server`, and `mcp` fields. `logout` always attempts local cleanup and writes
`remoteRevocationConfirmed` and `localCredentialRemoved` booleans. Neither command writes
credential contents.

This public package has no npm provenance because the source repository is private.

Evidence upload/search also supports PDF when the service enables new PDF uploads.
The service verifies file signatures, parser readiness and its compatible rollback runtime
before accepting a new PDF; existing authorized PDF status/search/download remains available
during parser outages.

`SMEDC_CREDENTIAL_PROFILE` optionally selects a local credential namespace. Omission or
`default` preserves the existing Keychain service/account and lock. Named profiles must match
`[A-Za-z0-9_-]{1,64}` and have separate credentials and locks; missing credentials never fall
back to the default profile. Use explicit `pdf-<runId>-<role>` profiles for isolated test sessions.
This setting does not select an organization or change server authorization.
