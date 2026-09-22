---
name: smedc-manual-test
description: Run or update the official SME_DATA_CENTER SMEDC manual acceptance flow for staging, macOS Codex, official browser auth, pinned MCP launcher, business tool use, and cleanup.
---

# SMEDC Manual Test

Use this skill when the user asks to execute, rerun, validate, diagnose, or improve the
SME_DATA_CENTER / SMEDC manual acceptance flow.

## Current Acceptance Boundary

The active flow is **official staging + macOS Codex + browser auth + published launcher**.
Do not run or recreate the deleted local Phase 3 email-login workflow, do not revive
`/auth/dev-login`, and do not weaken the official launcher's HTTPS requirement.

Windows and OpenClaw are separate gates. If the user says to ignore them, keep the manual run scoped
to macOS Codex and record Windows/OpenClaw as not run.

Full manual acceptance must use fresh synthetic accounts, not the human owner's real account or an
already-authenticated Keychain session. The controller creates a clearance-0 employee, a
clearance-3 employee, and a clearance-0 admin in the same organization and sends their one-time
setup links to the human. The controller must not open setup links or type test credentials. The
human may choose a shared throwaway password, enter it, and disclose it in the current private chat.
The controller then deletes every account and all test data after the run.

A user-requested **scoped QA acceptance** may reuse the current authenticated launcher session
instead of creating accounts when all of these conditions hold:

- the user explicitly scopes the run to selected business flows rather than the full account,
  browser-login, confidentiality, admin-PAO, logout, or password-reset gate;
- `smedc_auth_status` is authenticated and `smedc_get_current_user` identifies
  the expected QA employee;
- the controller verifies through a read-only operator-side lookup that the employee belongs to
  organization ID `default-org`; the employee-client task must not receive database access or an
  organization ID input;
- every upload uses a run-unique cleanup scope, such as a unique `enterpriseName`, so cleanup cannot
  delete pre-existing QA partitions; and
- the run preserves the shared login: do not log out, reset, disable, or delete the reused account.

This shortcut proves only the selected business flows and durable reuse of an existing QA session.
It is not full manual acceptance and must not be reported as proof of onboarding, cross-clearance,
admin, password, logout, or account-deletion behavior.

Full manual acceptance must also look like normal low-technical employee usage. Create multiple
new user-visible Codex tasks/sessions, one ordinary natural-language request at a time. Do not
collapse install, login, upload, search, structured query, reset/logout, and safety probes into one
controller-style mega-prompt. The visible task transcripts are part of the acceptance evidence; it
is fine if this creates many sessions. Leave them visible after the run so the human owner can
inspect them; do not archive or delete them as part of automatic test-data cleanup. Archive them
only when the human explicitly asks afterward.

## Required Sources

Read these files completely before acting:

- `docs/implementation/official-manual-acceptance.md`
- `docs/implementation/test-cases.md`
- `skills/smedc-mcp/SKILL.md` for employee-client behavior

If MCP tool behavior, API contracts, or usage guidance changes, update both:

- repo-local skill `skills/smedc-mcp/`
- standalone skill repo `YinXiaoyu-1998/smedc-mcp-skill`

## Roles

| Role                    | Allowed                                                                                                          | Forbidden                                                                                           |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| Controller/release task | Sync main, run checks, execute operator CLI, send setup links privately, verify safe state, and clean test data  | Open setup links, type test credentials, put credentials in durable artifacts, or weaken auth       |
| Employee-client path    | Use only the official launcher and MCP tools through the configured agent                                        | Direct HTTP, DB, Qdrant, storage, Docker, cloud, logs, code inspection, or service lifecycle access |
| Human test operator     | Open first-party SMEDC setup/login pages, choose and type synthetic passwords, and disclose them in private chat | Reuse a real/user-owned password or place setup links/passwords in files, reports, PRs, or logs     |

## Workflow

1. Confirm this is the repository root and preserve unrelated working-tree changes.
2. Sync local `main` after merged PRs when requested:
   `git fetch origin`, `git switch main`, `git pull --ff-only`.
3. Read the required sources above.
4. Inspect whether the current manual flow still covers account lifecycle, password setup/reset,
   launcher install/config, durable login, normal MCP business tools, evidence, structured data,
   delivery ledgers, quarantine certificates, source-file download links, logout/reset recovery,
   cleanup, default/explicit confidentiality levels, ordinary-read clearance boundaries, and every
   named admin PAO. Update docs/scripts if the coverage is stale.
5. Run normal repository checks proportionate to the change. For documentation-only changes,
   run at least `npm run format:check`. For runner or script changes, run the focused tests plus
   TypeScript checking when practical.
6. For full acceptance, create the three synthetic manual accounts through the operator CLI using
   `manual-full-flow-low-<runId>`, `manual-full-flow-high-<runId>`, and
   `manual-acceptance-admin-<runId>` `@example.invalid` emails. State `--role` and `--clearance`
   explicitly for each. For a scoped QA acceptance, apply the reuse preconditions above instead and
   record the safe current-user identity plus the `default-org` verification. Never use a real
   customer/user email. Keep setup links and synthetic passwords out of reports and commits.
7. Human-controlled password setup is required for full acceptance. Generate all required setup
   links, send them directly to the human in the current private chat, and do not open or prefill
   them. The human may use and disclose one shared throwaway password for all synthetic accounts.
   Although links may be generated together, the human must open and finish them one at a time:
   setup pages share a host-only cookie, so opening several before finishing the first can replace
   the active setup session. After each confirmation, verify operator-side `passwordSet=true`
   before proceeding. Never persist the links or password outside the private conversation.
8. Verify the installed macOS launcher without exposing credentials:

   ```sh
   SMEDC_BASE_URL=https://api.smedatacenter.xyz \
     "$HOME/Library/Application Support/SMEDC/launcher/versions/0.5.1/node_modules/.bin/smedc-mcp-launcher" self-check
   ```

9. For full acceptance, ensure the launcher starts logged out and switch among only the synthetic
   accounts required by the procedure. For scoped QA acceptance, preserve the verified existing
   session and never call `smedc_logout` merely to make the test start clean.
10. Create a sequence of new user-visible Codex tasks/sessions for the employee-client
    interactions. Each task receives exactly one normal employee request in ordinary language and
    must follow `skills/smedc-mcp/SKILL.md`; it must not inspect service internals. In full
    acceptance, begin with the install/login task. In scoped QA acceptance, begin directly with the
    selected business action after the existing session and `default-org` membership are verified;
    do not create a synthetic login task merely for ceremony.
11. The first task should be an install/login-style request. If the launcher is unauthenticated,
    that task calls `smedc_login` and surfaces the first-party device verification link. The human
    completes browser login with the synthetic password; the controller must not control the
    browser or type the credential.
12. Subsequent tasks should be separate natural chats for default-level upload, explicitly requested
    high-level upload, low/high-clearance search, the low-clearance admin normal-read denial, the
    admin receipt-archive PAO, cold search, prompt-injection
    resistance, structured upload/query, logout/reset/re-login, and any scoped recovery probes.
    Upload and cold-search must not be collapsed into the same employee-client task when independent
    retrieval evidence matters. When the local-only delivery samples are available, include separate
    supplier-catalog, XLSX-receipt, and CSV-receipt tasks, followed by one ordinary request to query
    all visible delivery-ledger rows and display them as a row-level Markdown table. The query task
    must follow every returned page cursor until no page remains; a receipt-level count or enrichment
    summary is not a substitute for displaying the ledger.
    For the quarantine-certificate slice, have the clearance-0 employee explicitly request level 2
    when uploading `fixtures/manual-acceptance/quarantine/animal-quarantine-certificate.jpg` for an
    explicit `receiptId`; a filename must never choose the level. The clearance-3 employee queries
    that receipt and requests a 24-hour source-file download link for its returned
    `sourceDocumentId`. The clearance-0 admin then uses receipt-ID archive as the named PAO; it must
    not query the certificate first. Do not query all certificates, fetch file bytes directly, or
    visually verify downloaded image contents in the automated flow.
13. Optionally run the official macOS Codex business-flow runner as an extra smoke, but do not treat
    it as a replacement for the new user-visible task:

```sh
npm run test:official-manual
```

Use `--run-id=<safe-id>` for repeatability. The runner must clean before and after the run unless
there is an explicit reason to keep data temporarily.

14. Clean all run-scoped uploaded documents, Qdrant points, OSS objects, structured rows/imports,
    and, for full acceptance only, delete every synthetic test account:

    ```sh
    npm run auth:operator -- delete-test-account \
      --email <one-synthetic-manual-email> \
      --confirm-email <same-synthetic-manual-email>
    ```

15. Record results in `docs/implementation/progress.md` only as a concise milestone, not as a chat
    transcript. The detailed evidence is the created Codex task list/transcripts plus any local
    report path under `.data/official-manual-acceptance/<runId>/`.
16. If files changed, create a branch/commit/PR with scope, tests, environment changes, human inputs,
    and known limitations.

## Cleanup Requirements

Manual staging uploads must not accumulate.

- Evidence uploads must use `sourceSystem=manual_acceptance_<runId>`.
- Runner-owned structured uploads must use unique `enterpriseName=ManualAcceptance_<runId>` and a
  dedicated date window. Natural employee tasks may use the real business/store name; cleanup must
  therefore also select every document uploaded by the run's synthetic employee.
- Scoped QA acceptance must use a run-unique enterprise or equivalent exact cleanup selector. Never
  rely on the reused employee ID alone, because that employee may own unrelated QA data.
- Cleanup must remove test documents, quarantine certificates, all structured row types (including
  delivery and supplier rows), import batches/window claims, OSS objects, and Qdrant points
  associated with the run.
- Synthetic test accounts must be deleted with `delete-test-account` after uploaded documents are
  removed. A reused `default-org` QA account must not be deleted, logged out, reset, or disabled.
- If cleanup fails, stop and report that as a release blocker before further beta testing.

## Integrity Rules

- The employee-client path must use the official launcher and MCP tools; controller DB/storage
  access is only for setup, verification, and cleanup.
- Do not inspect, print, copy, or store Keychain/credential values.
- Real/user-owned passwords and every access token, refresh token, authorization code, full DSN,
  provider key, and raw header must never be requested or exposed. Synthetic manual-test setup links
  and passwords may appear only in the current private human-agent conversation and never in durable
  artifacts or command output.
- Do not report "beta-ready" unless the browser login, launcher persistence, business tools,
  quarantine/source-download coverage when in scope, and cleanup have actually run.
- When Windows/OpenClaw are skipped by scope, say so explicitly.
