---
name: enterprise-hub-manual-test
description: Run or update the official SME_DATA_CENTER Enterprise Hub manual acceptance flow for staging, macOS Codex, official browser auth, pinned MCP launcher, business tool use, and cleanup.
---

# Enterprise Hub Manual Test

Use this skill when the user asks to execute, rerun, validate, diagnose, or improve the
SME_DATA_CENTER / Enterprise Hub manual acceptance flow.

## Current Acceptance Boundary

The active flow is **official staging + macOS Codex + browser auth + published launcher**.
Do not run or recreate the deleted local Phase 3 email-login workflow, do not revive
`/auth/dev-login`, and do not weaken the official launcher's HTTPS requirement.

Windows and OpenClaw are separate gates. If the user says to ignore them, keep the manual run scoped
to macOS Codex and record Windows/OpenClaw as not run.

Full manual acceptance must use a fresh synthetic account, not the human owner's real account or an
already-authenticated Keychain session. The controller creates the test account, generates a
throwaway password, controls Chrome to complete password setup/login, then deletes the test account
and all test data.

Full manual acceptance must also look like normal low-technical employee usage. Create multiple
new user-visible Codex tasks/sessions, one ordinary natural-language request at a time. Do not
collapse install, login, upload, search, structured query, reset/logout, and safety probes into one
controller-style mega-prompt. The visible task transcripts are part of the acceptance evidence; it
is fine if this creates many sessions because the human owner can inspect, archive, or delete them
afterward.

## Required Sources

Read these files completely before acting:

- `docs/implementation/official-manual-acceptance.md`
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
| Browser controller      | Type the generated synthetic test password only into first-party Enterprise Hub browser pages              | Put passwords/tokens in chat, env vars, files, MCP config, CLI args, docs, PRs, or logs             |

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
6. Create a synthetic manual account through the operator CLI, using an email like
   `manual-full-flow-<runId>@example.invalid`. Never use a real customer/user email. Keep the setup
   link and generated password out of reports and commits.
7. Control Chrome to open the setup link and set the generated password. This is allowed for full
   manual acceptance; do not ask the human to type it.
8. Verify the installed macOS launcher without exposing credentials:

   ```sh
   ENTERPRISE_HUB_BASE_URL=https://api.smedatacenter.xyz \
     "$HOME/Library/Application Support/Enterprise Hub/launcher/versions/0.1.0/node_modules/.bin/enterprise-hub-mcp-launcher" self-check
   ```

9. Ensure the launcher starts logged out; call `enterprise_hub_logout` first when needed.
10. Create a sequence of new user-visible Codex tasks/sessions for the employee-client
    interactions. Each task receives exactly one normal employee request in ordinary language and
    must follow `skills/enterprise-hub-mcp/SKILL.md`; it must not inspect service internals.
11. The first task should be an install/login-style request. If the launcher is unauthenticated,
    that task calls `enterprise_hub_login`; for synthetic full-flow accounts, the controller
    finishes the browser login in Chrome using the generated test password. Do not ask the human to
    type it.
12. Subsequent tasks should be separate natural chats for upload, cold search, prompt-injection
    resistance, structured upload/query, logout/reset/re-login, and any scoped recovery probes.
    Upload and cold-search must not be collapsed into the same employee-client task when independent
    retrieval evidence matters.
13. Optionally run the official macOS Codex business-flow runner as an extra smoke, but do not treat
    it as a replacement for the new user-visible task:

```sh
npm run test:official-manual
```

Use `--run-id=<safe-id>` for repeatability. The runner must clean before and after the run unless
there is an explicit reason to keep data temporarily.

14. Clean all run-scoped uploaded documents, Qdrant points, OSS objects, structured rows/imports,
    and then delete the synthetic test account:

    ```sh
    npm run auth:operator -- delete-test-account \
      --email manual-full-flow-<runId>@example.invalid \
      --confirm-email manual-full-flow-<runId>@example.invalid
    ```

15. Record results in `docs/implementation/progress.md` only as a concise milestone, not as a chat
    transcript. The detailed evidence is the created Codex task list/transcripts plus any local
    report path under `.data/official-manual-acceptance/<runId>/`.
16. If files changed, create a branch/commit/PR with scope, tests, environment changes, human inputs,
    and known limitations.

## Cleanup Requirements

Manual staging uploads must not accumulate.

- Evidence uploads must use `sourceSystem=manual_acceptance_<runId>`.
- Structured uploads must use unique `enterpriseName=ManualAcceptance_<runId>` and a dedicated
  date window.
- Cleanup must remove test documents, import rows/batches/window claims, OSS objects, and Qdrant
  points associated with the run.
- Synthetic test accounts must be deleted with `delete-test-account` after uploaded documents are
  removed.
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
