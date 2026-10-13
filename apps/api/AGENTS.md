# API service

- Preserve the internal developer permission path alongside the admin UI: follow `docs/implementation/internal-permissions-cli.md` for administrator-requested changes, with explicit tenant/requesting admin, version protection and operator audit attribution.

## Enterprise onboarding

- Follow `docs/implementation/tenant-onboarding.md` and `docs/implementation/admin-permissions-ui-design.md`: enterprise-bound UI entry + shared browser sign-in + live server-side tenant/admin checks is the primary flow; Developers share the verified URL after an approved rollout. Reuse enterprise rules for new accounts; never require customers to fill JSON.
- JSON is internal only; customer records/snapshots stay outside Git. Org/account/role/password operations stay with operators. Saving differs from activation; ready preparation and explicit admin confirmation precede new-model handoff.

## Implementation

- Keep HTTP routes thin; reuse domain policies and service/repository boundaries. MCP under `apps/api/src/mcp/` adapts controlled HTTP/service operations, never arbitrary API paths or SQL.
- For business authorization, read `packages/domain/AGENTS.md` and `docs/implementation/business-related-authorization-design.md`. Load live account/tenant permissions; administrative configuration access must not expose ordinary content, rows, photos or download links.
- Permission writes require version protection and atomic audit attribution; stale writes must not partially apply. See `apps/api/src/admin-permissions/` and `packages/db/AGENTS.md`.
- UI and login/password language rules: `apps/admin-web/AGENTS.md`.
- Focused checks: `npm test -- apps/api/src`; narrow to changed route/service tests. Use `scripts/AGENTS.md` integration entrypoints when real persistence is affected.
