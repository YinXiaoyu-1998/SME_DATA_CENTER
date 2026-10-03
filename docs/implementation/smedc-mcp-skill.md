# SMEDC MCP Skill Scope And Review Checklist

This document records the companion skill scope and review checklist for `skills/smedc-mcp/SKILL.md`.

## Skill Location

- Skill name: `smedc-mcp`
- Skill file: `skills/smedc-mcp/SKILL.md`
- UI metadata: `skills/smedc-mcp/agents/openai.yaml`

The skill is repo-local and dual-homed with the standalone
`YinXiaoyu-1998/smedc-mcp-skill` repository. The complete distributed skill directories, including references, must remain
byte-identical. The standalone repository is the distributable copy; this repository's copy is the
product-side source of synchronized guidance.

## Required Behavior

The skill teaches an employee-owned agent how to safely use 企业资料中枢 through the official remote
MCP launcher. It must keep 企业资料中枢 as a service/tool layer, not an employee-facing AI agent,
report generator, dashboard service, or skill execution platform.

The official target profile must be actionable enough for an agent to:

1. Verify Node.js 22 or newer plus npm, then install only
   `smedc-mcp-launcher@0.6.0` with `npm install --prefix ... --save-exact` in the approved
   macOS/Windows/Linux current-user versioned directory; never install `latest` or self-update.
   Linux uses `${XDG_DATA_HOME:-$HOME/.local/share}/SMEDC/launcher/versions/0.6.0/` and resolves it
   to an absolute MCP command path.
2. Back up and idempotently configure the invoking agent's local **stdio** entry. Full old-version
   cleanup additionally migrates safely discoverable current-user SMEDC integrations, removes
   duplicate entries, and stops obsolete processes before deleting old installations. Codex uses
   its verified `mcp list`/`get`/`add`/`remove` CLI and bundled macOS binary fallback; OpenClaw uses
   `mcp add`/`set` and `mcp doctor --probe`, not direct remote OAuth storage. Linux examples use
   the same stdio tuple and never configure a remote OAuth store.
3. Use `smedc_auth_status`, `smedc_login`, `smedc_logout`, and the
   zero-input `smedc_get_current_user`; account lookup returns only the authenticated
   employee's display name, email, role, clearance, and organization name, while login never exposes passwords, tokens, device
   codes, headers, or secure-store records to the agent/model.
4. Treat browser cancellation, `authentication_required`, `service_unavailable`, `forbidden`, and
   `launcher_upgrade_required` as distinct typed outcomes. Retry the original operation exactly
   once after successful browser login.
5. Resolve upload role before local file access. Only active admins upload; known employees must
   not read or transform the file. Tools remain visible. Direct HTTP upload endpoints return
   HTTP `403`; MCP JSON-RPC transport returns HTTP `200` with `isError: true` in the tool result.
   Both carry `UPLOAD_ADMIN_REQUIRED`, `File upload requires the admin role.`, and
   `retryable: false`, which must not cause re-login or retry.
   Clearance is independent: admins may explicitly upload above their clearance without a read
   bypass. Upload original files, report service validation errors, and poll status without starting
   a worker; use only API-visible records and never supply an organization ID. There are no labels.
6. Reuse structured-import idempotency keys only for exact file/metadata replay; treat
   inaccessible import-status 404s as non-enumerating not-found results; use evidence cursors
   only as opaque same-query continuations.
7. Support per-agent removal, shared logout, and complete uninstall without deleting Node.js/npm,
   Employee Accounts, service data, or unrelated MCP configuration.
8. Invoke the exact platform launcher path with only `SMEDC_BASE_URL`: `serve` for stdio,
   `self-check` for safe machine-readable version/origin/store/compatibility/connectivity status,
   and `logout` for safe local-deletion/remote-revocation status.
9. Treat Linux `secureStore.available:false` as supported memory-only custody, surface the
   first-party Device Authorization link when `openedBrowser:false`, and require a fresh login after
   launcher or host restart rather than writing a credential to an ordinary file.

10. Complete `references/upgrade-cleanup.md` on upgrades: refresh the official skill, verify the
    approved package, reconnect hosts and prove the running version, then remove superseded
    installations and temporary backups. A self-check alone is not host-version evidence. Report
    pending restarts, inaccessible integrations, or remaining old versions as incomplete.

## Profile Boundaries

| Profile                   | Requirement                                                                                                                    |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `official-remote`         | The only employee-facing guidance: pinned launcher, `https://api.smedatacenter.xyz`, Device Authorization, and typed recovery. |
| `pre-cutover-development` | Historical current-code detail belongs in implementation/testing docs, never in the official skill.                            |

## Safety Review Checklist

- [x] Skill name is exactly `smedc-mcp`.
- [x] Skill includes only the official remote employee profile.
- [x] Skill pins `smedc-mcp-launcher@0.6.0`, rejects `latest`, and never directs launcher self-update.
- [x] Admin-only guidance includes Delivery Ledger, static discovery, local preflight without a backend audit, best-effort backend `file_upload.denied`, and the partition owner-abort exception.
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
- [x] Skill provides macOS, Windows, and Linux install/config/self-check/logout paths and explains
      Linux secure-store versus memory-only session behavior.
- [x] Removed dev-login/JWT behavior is not presented as a current or compatible path.

## Validation

Required checks:

```sh
python3 /Users/xiaoyuyin/.codex/skills/.system/skill-creator/scripts/quick_validate.py skills/smedc-mcp
npm run format:check
git diff --check
```

Recommended local confidence check:

```sh
MYSQL_PORT=3307 npm run test:mcp
```

`npm run test:mcp` proves the MCP behavior that the meta skill describes; the skill itself does not add MCP tool behavior.
