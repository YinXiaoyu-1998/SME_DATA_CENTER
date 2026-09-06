# Enterprise Hub MCP Launcher

Official stdio MCP launcher for Enterprise Hub. It reads only `ENTERPRISE_HUB_BASE_URL`, which must
be a canonical HTTPS origin. Browser sign-in uses OAuth Device Authorization; credentials are never
accepted through command arguments, environment variables, or MCP tool inputs.

Commands: `serve`, `self-check`, `logout`, and `--version`.

`self-check` writes one safe JSON object with `ok`, `launcherVersion`, `serviceOrigin`, `platform`,
`secureStore`, `server`, and `mcp` fields. `logout` always attempts local cleanup and writes
`remoteRevocationConfirmed` and `localCredentialRemoved` booleans. Neither command writes
credential contents.

This public package has no npm provenance because the source repository is private.
