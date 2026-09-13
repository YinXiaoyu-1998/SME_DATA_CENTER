# Enterprise Hub MCP Skill Scope And Review Checklist

This document records the companion skill scope and review checklist for `skills/enterprise-hub-mcp/SKILL.md`.

## Skill Location

- Skill name: `enterprise-hub-mcp`
- Skill file: `skills/enterprise-hub-mcp/SKILL.md`
- UI metadata: `skills/enterprise-hub-mcp/agents/openai.yaml`

The skill is repo-local and dual-homed with the standalone
`YinXiaoyu-1998/enterprise-hub-mcp-skill` repository. The two `SKILL.md` copies must remain
byte-identical. The standalone repository is the distributable copy; this repository's copy is the
product-side source of synchronized guidance.

## Required Behavior

The skill teaches an employee-owned agent how to safely use 企业资料中枢 through the official remote
MCP launcher. It must keep 企业资料中枢 as a service/tool layer, not an employee-facing AI agent,
report generator, dashboard service, or skill execution platform.

The official target profile must be actionable enough for an agent to:

1. Verify Node.js 22 or newer plus npm, then install only
   `enterprise-hub-mcp-launcher@0.3.0` with `npm install --prefix ... --save-exact` in the approved
   macOS/Windows versioned directory; never install `latest` or self-update.
2. Back up and idempotently configure only the invoking agent's local **stdio** entry. Codex uses
   its verified `mcp list`/`get`/`add`/`remove` CLI and bundled macOS binary fallback; OpenClaw uses
   `mcp add`/`set` and `mcp doctor --probe`, not direct remote OAuth storage.
3. Use `enterprise_hub_auth_status`, `enterprise_hub_login`, `enterprise_hub_logout`, and the
   zero-input `enterprise_hub_get_current_user`; account lookup returns only the authenticated
   employee's display name, email, and role, while login never exposes passwords, tokens, device
   codes, headers, or secure-store records to the agent/model.
4. Treat browser cancellation, `authentication_required`, `service_unavailable`, `forbidden`, and
   `launcher_upgrade_required` as distinct typed outcomes. Retry the original operation exactly
   once after successful browser login.
5. List labels before upload; read assigned file bytes exactly; poll status without starting a
   worker; use only API-visible records and never supply an organization ID.
6. Reuse structured-import idempotency keys only for exact file/metadata replay; treat
   inaccessible import-status 404s as non-enumerating not-found results; use evidence cursors
   only as opaque same-query continuations.
7. Support per-agent removal, shared logout, and complete uninstall without deleting Node.js/npm,
   Employee Accounts, service data, or unrelated MCP configuration.
8. Invoke the exact platform launcher path with only `ENTERPRISE_HUB_BASE_URL`: `serve` for stdio,
   `self-check` for safe machine-readable version/origin/store/compatibility/connectivity status,
   and `logout` for safe local-deletion/remote-revocation status.

## Profile Boundaries

| Profile                   | Requirement                                                                                                                    |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `official-remote`         | The only employee-facing guidance: pinned launcher, `https://api.smedatacenter.xyz`, Device Authorization, and typed recovery. |
| `pre-cutover-development` | Historical current-code detail belongs in implementation/testing docs, never in the official skill.                            |

## Safety Review Checklist

- [x] Skill name is exactly `enterprise-hub-mcp`.
- [x] Skill includes only the official remote employee profile.
- [x] Skill pins `enterprise-hub-mcp-launcher@0.3.0`, rejects `latest`, and never directs launcher self-update.
- [x] Skill contains no real tokens, passwords, customer data, endpoint secrets, or service-account material.
- [x] Skill says MCP tools must use the HTTP API and inherit API authorization.
- [x] Skill forbids direct DB/storage reads for data access.
- [x] Skill forbids agent-visible passwords, raw bearer tokens, authorization codes, session files, or token persistence.
- [x] Skill forbids claiming inaccessible documents exist.
- [x] Skill forbids client-supplied org scope.
- [x] Skill uses the self-scoped current-user tool without employee selectors, internal IDs, labels, or credentials.
- [x] Skill explains import exact replay and non-enumerating import-status 404 behavior.
- [x] Skill explains evidence cursor continuation and `INVALID_CURSOR`/`CURSOR_EXPIRED` handling.
- [x] Skill forbids executing Skill Directory entries.
- [x] Skill forbids report/dashboard generation and direct employee-facing AI behavior.
- [x] Skill requires exact client-side file-byte reads and forbids retyping, normalizing, translating, or reconstructing upload payloads.
- [x] Skill requires explicit human authorization before uploading real company documents or customer exports.
- [x] Skill separates per-agent removal, shared logout, and complete uninstall.
- [x] Removed dev-login/JWT behavior is not presented as a current or compatible path.

## Validation

Required checks:

```sh
python3 /Users/xiaoyuyin/.codex/skills/.system/skill-creator/scripts/quick_validate.py skills/enterprise-hub-mcp
npm run format:check
git diff --check
```

Recommended local confidence check:

```sh
MYSQL_PORT=3307 npm run test:mcp
```

`npm run test:mcp` proves the MCP behavior that the meta skill describes; the skill itself does not add MCP tool behavior.
