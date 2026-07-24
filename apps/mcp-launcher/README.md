# Enterprise Hub MCP Launcher

Official stdio MCP launcher for Enterprise Hub. It reads only `ENTERPRISE_HUB_BASE_URL`, which must
be a canonical HTTPS origin. Browser sign-in uses OAuth Authorization Code with PKCE; credentials
are never accepted through command arguments, environment variables, or MCP tool inputs.

Commands: `serve`, `self-check`, `logout`, and `--version`.

This public package has no npm provenance because the source repository is private.
