# Official stdio launcher

- Release/contract coordination: `packages/mcp-contract/AGENTS.md`. Do not copy current release pins here; inspect package metadata and verified release records.
- Read `docs/implementation/official-user-install-and-login.md` and `apps/mcp-launcher/README.md` for supported commands/transport behavior.
- The launcher owns credentials, upload bytes and local download verification. Never accept credentials through tool inputs, arguments or environment variables, or return credentials/model-carried file bytes. Preserve OS secure-store support and headless memory-only sessions.
- Cached profiles are only an early client guard; current-user/permission results and final authorization come from the service.
- Reserve stdout for stdio MCP protocol/explicit CLI output. Preserve cancellation, transfer stall deadlines, bounded retries and cleanup of incomplete downloads.
- Verify download scope, checksums and safe extraction paths before returning local files; never expose internal presigned partition URLs to the agent.
- Focused checks: `npm test -- apps/mcp-launcher`; include package/alignment and contract tests for public changes.
