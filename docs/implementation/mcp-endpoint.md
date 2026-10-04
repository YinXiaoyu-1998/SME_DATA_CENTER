# Historical Phase 3 Local MCP Endpoint Decisions

> **Withdrawn implementation record.** This file records the superseded Phase 3 development
> boundary only. It is not installation, authentication, or operational guidance.

Last updated: 2026-07-28

Phase 3 introduced a stateless Streamable HTTP endpoint at `POST /mcp` and a local stdio adapter.
Its temporary email login, JWT bearer, memory-only session, loopback-only endpoint, and legacy
launcher tool names were removed in the Phase 4 official-auth cutover. There is no compatibility
mode for those contracts.

The retained architectural decisions are:

- the Fastify API owns the stateless Streamable HTTP `/mcp` endpoint;
- the desktop launcher exposes stdio to an employee-owned agent and delegates business tools to
  that endpoint;
- the service performs authorization on every request and tool invocation;
- upload tools carry explicitly selected bytes and metadata, never a server-visible client path;
- request size, concurrency, timeout, and protocol bounds remain enforced.

Current authoritative sources:

- [official-user-install-and-login.md](./official-user-install-and-login.md) — browser login,
  OAuth/PKCE, durable credentials, installation, and supported desktop clients;
- [mcp-user-flow.md](./mcp-user-flow.md) and
  [mcp-user-flow.zh.md](./mcp-user-flow.zh.md) — current end-to-end user flows;
- [ledger-pdf-operations.md](./ledger-pdf-operations.md) — archived ledger delivery, CLI backfill, flags and recovery;
- [api-contract.md](./api-contract.md) — current HTTP and MCP contract;
- [staging-deploy-runbook.md](./staging-deploy-runbook.md) — staging release boundary;
- [ADR 0020](../adr/0020-local-streamable-http-mcp-endpoint.md) — historical transport decision;
- [ADR 0021](../adr/0021-remote-mcp-opaque-token-bridge.md) — explicitly withdrawn token bridge.

The current launcher adds `describe_ledger_pdf_coverage`, `refresh_ledger_pdfs`,
`get_ledger_pdf_request_status` `prepare_ledger_pdf_download` and `get_ledger_pdf_download_url`. These delegate through
the authenticated HTTP boundary; the service still owns generation and
authorization. The employee agent requests a ZIP, polls its status, obtains a download URL and saves the file locally. Refresh requires an admin.
These capabilities require launcher 0.7.0 after its independent publication and
verification; publication and recommended-version updates are a later release
step. The historical transport decisions above do not change.
