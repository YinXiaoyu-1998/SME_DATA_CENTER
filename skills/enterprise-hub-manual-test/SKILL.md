---
name: enterprise-hub-manual-test
description: Run or update the official SME_DATA_CENTER Enterprise Hub manual acceptance flow for staging, macOS Codex, official browser auth, pinned MCP launcher, business tool use, and cleanup.
---

# Enterprise Hub Manual Test

Use this skill when the user asks to execute, rerun, validate, diagnose, or improve the
SME_DATA_CENTER / Enterprise Hub manual acceptance flow.

## Current Acceptance Boundary

The active flow is **official staging + macOS Codex + browser auth + published launcher**.
Do not run the withdrawn local Phase 3 email-login workflow, do not revive `/auth/dev-login`, and
do not weaken the official launcher's HTTPS requirement.

Windows and OpenClaw are separate gates. If the user says to ignore them, keep the manual run scoped
to macOS Codex and record Windows/OpenClaw as not run.

## Required Sources

Read these files completely before acting:

- `docs/implementation/official-manual-acceptance.md`
- `docs/implementation/local-agent-test.md` only to confirm the old flow is withdrawn
- `docs/implementation/test-cases.md`
- `skills/enterprise-hub-mcp/SKILL.md` for employee-client behavior

If MCP tool behavior, API contracts, or usage guidance changes, update both:

- repo-local skill `skills/enterprise-hub-mcp/`
- standalone skill repo `YinXiaoyu-1998/enterprise-hub-mcp-skill`

## Roles

| Role                    | Allowed                                                                                                    | Forbidden                                                                                           |
| ----------------------- | ---------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| Controller/release task | Sync main, run checks, execute operator CLI, verify safe state, run the official manual runner, clean data | Use employee credentials, paste setup links/tokens into reports, or weaken staging auth boundaries  |
| Employee-client path    | Use only the official launcher and MCP tools through the configured agent                                  | Direct HTTP, DB, Qdrant, storage, Docker, cloud, logs, code inspection, or service lifecycle access |
| Browser user            | Type email/password only into first-party Enterprise Hub browser pages                                     | Put passwords/tokens in chat, env vars, files, MCP config, CLI args, or logs                        |

## Workflow

1. Confirm this is the repository root and preserve unrelated working-tree changes.
2. Sync local `main` after merged PRs when requested:
   `git fetch origin`, `git switch main`, `git pull --ff-only`.
3. Read the required sources above.
4. Inspect whether the current manual flow still covers account lifecycle, password setup/reset,
   launcher install/config, durable login, normal MCP business tools, logout/reset recovery, and
   cleanup. Update docs/scripts if the coverage is stale.
5. Run normal repository checks proportionate to the change. For documentation-only changes,
   run at least `npm run format:check`. For runner or script changes, run the focused tests plus
   TypeScript checking when practical.
6. Verify the installed macOS launcher without exposing credentials:

   ```sh
   ENTERPRISE_HUB_BASE_URL=https://api.smedatacenter.xyz \
     "$HOME/Library/Application Support/Enterprise Hub/launcher/versions/0.1.0/node_modules/.bin/enterprise-hub-mcp-launcher" self-check
   ```

7. If the launcher is unauthenticated and the user wants a full flow, call `enterprise_hub_login`
   through the configured MCP client or launcher test path, then wait for the user to finish
   browser login. Never ask for or handle the password in chat.
8. Run the official macOS Codex business-flow runner:

   ```sh
   npm run test:official-manual
   ```

   Use `--run-id=<safe-id>` for repeatability. The runner must clean before and after the run unless
   there is an explicit reason to keep data temporarily.

9. For account lifecycle proof, use synthetic operator accounts only. Create/reset via
   `npm run auth:operator`, open or deliver the one-time setup link without recording it, and have
   the browser user set the password privately.
10. Record results in `docs/implementation/progress.md` only as a concise milestone, not as a chat
    transcript. Link the local report path under `.data/official-manual-acceptance/<runId>/`.
11. If files changed, create a branch/commit/PR with scope, tests, environment changes, human inputs,
    and known limitations.

## Cleanup Requirements

Manual staging uploads must not accumulate.

- Evidence uploads must use `sourceSystem=manual_acceptance_<runId>`.
- Structured uploads must use unique `enterpriseName=ManualAcceptance_<runId>` and a dedicated
  date window.
- Cleanup must remove test documents, import rows/batches/window claims, OSS objects, and Qdrant
  points associated with the run.
- If cleanup fails, stop and report that as a release blocker before further beta testing.

## Integrity Rules

- The employee-client path must use the official launcher and MCP tools; controller DB/storage
  access is only for setup, verification, and cleanup.
- Do not inspect, print, copy, or store Keychain/credential values.
- Do not ask the user to expose passwords, setup links, access tokens, refresh tokens, authorization
  codes, full DSNs, provider keys, or raw headers.
- Do not report "beta-ready" unless the browser login, launcher persistence, business tools, and
  cleanup have actually run.
- When Windows/OpenClaw are skipped by scope, say so explicitly.
