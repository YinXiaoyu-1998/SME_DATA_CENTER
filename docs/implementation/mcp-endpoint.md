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
- [api-contract.md](./api-contract.md) — current HTTP and MCP contract;
- [staging-deploy-runbook.md](./staging-deploy-runbook.md) — staging release boundary;
- [ADR 0020](../adr/0020-local-streamable-http-mcp-endpoint.md) — historical transport decision;
- [ADR 0021](../adr/0021-remote-mcp-opaque-token-bridge.md) — explicitly withdrawn token bridge.
