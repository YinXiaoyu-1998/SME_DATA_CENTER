---
name: smedc-manual-test
description: Run or update the official SME_DATA_CENTER SMEDC manual acceptance flow for staging, macOS Codex or the separate headless Linux support-class-C path, official browser auth, pinned MCP launcher, business tool use, and cleanup.
---

# SMEDC Manual Test

Use this skill when the user asks to execute, rerun, validate, diagnose, or improve the
SME_DATA_CENTER / SMEDC manual acceptance flow.

## Current runner limitation

Before any requested full run, read `docs/implementation/official-manual-acceptance.md`: the runner now requires the exact raw-ledger denial, but evidence-fixture uploads still need explicit category/scopes configuration. Resolve that separate prerequisite before full acceptance; do not infer attributes or relax authorization. Fixing the runner does not authorize executing the official workflow.

## Current Acceptance Boundary

The active flow is **official staging + macOS Codex + browser auth + published launcher**.
Do not run or recreate the deleted local Phase 3 email-login workflow, do not revive
`/auth/dev-login`, and do not weaken the official launcher's HTTPS requirement.

Windows and user-visible OpenClaw-family hosts are separate client gates. Linux launcher
installation itself is supported: the separate support-class-C flow in the official guide covers
no-display link delivery, memory-only session custody, and mandatory re-login after process restart.
If the user asks only for the primary flow, keep the run scoped to macOS Codex and record the other
client gates as not run; do not describe Linux as unsupported.

The default full account-lifecycle profile uses fresh synthetic accounts. When the human explicitly
requests the complete business suite with the existing login, use the existing-session profile below
and preserve that account and session. The controller creates a clearance-0 employee, a
clearance-3 employee, and a clearance-0 admin in the same organization and sends their one-time
setup links to the human. The controller must not open setup links or type test credentials. The
human may choose a shared throwaway password, enter it, and disclose it in the current private chat.
The controller then deletes every account and all test data after the run.

The existing full-suite runner baseline uses launcher `smedc-mcp-launcher@0.9.0` and the scenario manifest; account assignments
apply to the full lifecycle profile and map to the current account in the existing-session profile. All positive uploads
use the clearance-0 admin: evidence, row CSV, business/dishes partitions, unchanged Delivery Ledger
XLSX, and quarantine certificates. Employee c0/c3 upload requests explain the admin requirement
before reading or transforming files. Tools remain visible. Direct HTTP upload endpoints return
HTTP `403`; MCP JSON-RPC transport returns HTTP `200` with `isError: true` in the tool result.
Both carry `UPLOAD_ADMIN_REQUIRED`, exact message `File upload requires the admin role.`,
and `retryable: false`, with no re-login or retry.
Launcher-local prevention creates no backend audit; automated backend tests separately verify
best-effort `file_upload.denied`, partition create/parts/complete denial, and owner abort access.
Clearance is orthogonal: admin c0 may explicitly upload level 2 but cannot ordinarily read it;
employee c3 can read eligible data but cannot upload. Preserve ordinary status/manifest/read rules.

## Existing-session business acceptance

An explicit request to reuse the current login authorizes the complete business suite without
creating accounts, switching identities, login, logout, password resets, or account deletion.
Verify the live MCP identity is the intended active admin. The controller verifies its organization membership without exposing internal IDs to employee chats. Run every applicable business task
in `fixtures/manual-acceptance/scenarios.json`, including evidence, row queries, partitions, receipt
uploads/raw-read denial, PDF coverage/download, and quarantine query/download/archive.

Keep cross-clearance denial, employee upload denial, above-clearance PAO, and session revocation
marked **not run: identity switching excluded**. A clearance-3 admin can prove successful reads and
archive behavior, but cannot prove the low-clearance denial. Do not change role or clearance to
simulate a different account. Report this as the complete business suite with explicit identity
exclusions, never as account-lifecycle acceptance or unrestricted beta readiness.

Use unique receipt/store/enterprise names and track every document, partition-job, and PDF-request
ID returned in the visible chats. Cleanup uses these exact IDs plus run markers; never select all
uploads or download requests owned by the reused account. Preserve unrelated supplier snapshots,
partitions, PDF sources, and the existing shared login.

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
   cleanup, explicit evidence levels and attributes, fixed-category levels, current complete business-read boundaries, and every
   named admin PAO. Update docs/scripts if the coverage is stale.
5. Run normal repository checks proportionate to the change. For documentation-only changes,
   run at least `npm run format:check`. For runner or script changes, run the focused tests plus
   TypeScript checking when practical.
6. For the account-lifecycle profile, create the three synthetic manual accounts through the operator CLI using
   `manual-full-flow-low-<runId>`, `manual-full-flow-high-<runId>`, and
   `manual-acceptance-admin-<runId>` `@example.invalid` emails. State `--role` and `--clearance`
   explicitly for each. For existing-session acceptance, apply the reuse preconditions above instead and
   record the safe current-user identity plus the organization verification. Use synthetic emails only when creating accounts. Keep setup links and synthetic passwords out of reports and commits.
7. Human-controlled password setup applies only to the account-lifecycle profile. Generate all required setup
   links, send them directly to the human in the current private chat, and do not open or prefill
   them. The human may use and disclose one shared throwaway password for all synthetic accounts.
   Although links may be generated together, the human must open and finish them one at a time:
   setup pages share a host-only cookie, so opening several before finishing the first can replace
   the active setup session. After each confirmation, verify operator-side `passwordSet=true`
   before proceeding. Never persist the links or password outside the private conversation.
8. Verify the installed macOS launcher without exposing credentials:

   ```sh
   SMEDC_BASE_URL=https://api.smedatacenter.xyz \
     "$HOME/Library/Application Support/SMEDC/launcher/versions/0.9.0/node_modules/.bin/smedc-mcp-launcher" self-check
   ```

9. For the account-lifecycle profile, ensure the launcher starts logged out and switch among only the synthetic
   accounts required by the procedure. For existing-session acceptance, preserve the verified existing
   session and never call `smedc_logout` merely to make the test start clean.
10. Create a sequence of new user-visible Codex tasks/sessions for the employee-client
    interactions. Each task receives exactly one normal employee request in ordinary language. Do not append
    harness instructions such as “只使用某个 Skill/tool”, “不要读取文件”, “禁止某动作”, expected
    answers, or a test checklist. Installed skill behavior is what the test observes. Put fixture
    paths and necessary business names/dates in the request; keep oracles and cleanup IDs in the controller. In the
    account-lifecycle profile, begin with the install/login task. In existing-session acceptance, begin directly with the
    selected business action after the existing session and organization membership are verified;
    do not create a synthetic login task merely for ceremony.
11. Only the account-lifecycle profile starts with an install/login-style request. If the launcher is unauthenticated,
    that task calls `smedc_login` and surfaces the first-party device verification link. The human
    completes browser login with the synthetic password; the controller must not control the
    browser or type the credential.
12. Subsequent tasks should be separate natural chats for explicitly level-0 evidence upload, explicitly requested
    high-level upload, low/high-clearance search, the low-clearance admin normal-read denial, the
    admin receipt-archive PAO, cold search, prompt-injection
    resistance, structured upload/query, logout/reset/re-login, and any scoped recovery probes.
    Upload and cold-search use independent chats. Raw receipt details, aggregates, coverage and original signing are unavailable regardless of the PDF switch: verify their denial and authorized PDF coverage/download instead of an agent-generated row table or maintained CSV. Newly uploaded
    receipts wait for the configured daily schedule; the employee never triggers PDF generation.
    Use an already-ready authorized partition for the successful ZIP case and record a new receipt's
    pending state separately. Quarantine cases cover upload, explicit-receipt query, source download,
    receipt archive, and post-archive absence. Run-scoped test receipts must not collide with real ones.
13. Run the official macOS Codex business-flow runner as an extra smoke, but do not treat
    it as a replacement for the new user-visible task:

```sh
npm run test:official-manual
# When reusing the explicitly selected admin:
npm run test:official-manual -- --run-id=<safe-id> --reuse-session=<expected-email>
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
- Existing-session acceptance must use a run-unique enterprise or explicit returned document/job/request IDs. Never
  rely on the reused employee ID alone, because that employee may own unrelated QA data.
- Cleanup must remove test documents, quarantine certificates, all structured row types (including
  delivery and supplier rows), import batches/window claims, OSS objects, and Qdrant points
  associated with the run.
- Synthetic test accounts must be deleted with `delete-test-account` after uploaded documents are
  removed. A reused account must not be deleted, logged out, reset, or disabled.
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

## Cost-card changed workflow (published launcher, separate acceptance)

Cost-card launcher 0.10.1 is published and independently verified. Cost-card acceptance remains
separate from the existing 0.9.0 full-suite baseline; this update does not authorize a manual run
or installation into the user runtime. After matching service/tenant verification and an
explicit changed-workflow request, use `candidateCostCards` in the existing scenario manifest and
`structured/cost-cards-known-values.csv`: three same-name cards, two specifications under one SPU,
a reused SKU under another SPU, standard/exception rows, leading-zero codes and exact/null/zero values.

Use directory lookup → complete per-card CSV download → local 38-column checks through
`readCostCardAcceptanceCsv` in existing support. Preserve each card's revision/sourceDocumentId/
importBatchId and verify byte/schema/identity/count integrity and same-name filename separation.
Do not request server-side item/recipe/store aggregates. Read units and exception semantics as
source values; do not invent a final store recipe. Clean only that download directory in finally.

The controller separately archives a synthetic original through the approved operator path;
ordinary directory and CSV reads must still succeed. Current same-org admin archives one resolved
card, which disappears from lookup/download; a fresh identical upload restores it, while old
idempotency replay does not. Do not invent an original-archive MCP tool or infer admin read rights.
Test permissions/category initialization with one small synthetic enabled enterprise; no default
new-category grants, old-category changes or tenant reactivation. Record explicit-ID denial,
manifest signing race/whole-batch expiry retry and publication-summary truncation/current-read
boundaries through existing focused runtime tests; do not add a broad manual permission matrix.

Run-scoped cleanup inventories current/archived card object keys plus StorageGarbage candidates,
removes cost_card resources and directory before restrictive source batches/documents, preserves
unrelated group cards/config/accounts and verifies exact keys/counts. Full suite, real cleanup,
staging and tenant actions always retain their separate authorization boundaries.

Tested route details are in api-contract.md: flat manifest selection; explicit IDs
all-or-error 403; count cap 409 without truncation; signing change retryable 409 “成本卡已变化，请重新下载”;
condition zero-card success; archive with no business body and string revision. Coverage counts
only currently readable active directory cards and groups sources by sourceDocumentId/importBatchId.
For a separately authorized synthetic enabled enterprise, exercise “补齐资料类别 / Add missing categories”
after saving/resolving drafts, current version and same-origin/CSRF checks; GET never initializes.
Matching service rollout and tenant configuration remain separate gates; do not bypass missing tools with HTTP.

Published tool/output oracle: upload the unchanged absolute local file with enterpriseName
and idempotencyKey, no date/confidentiality override; poll get_import_status({importBatchId}) with
outer document/processing/importBatch. Download returns localDirectory/dataset/cardCount/
totalItemRowCount/files, CSV basenames cost_card_<costCardId>.csv; manifest.json is inside that
directory and each URL-free entry adds fileName while retaining string revision and its own
sourceDocumentId/importBatchId. Zero cards has files=[] plus an empty manifest. Use
archive_cost_card({costCardId}) for the resolved card and verify archived:true/string revision.
Authorized failed/rejected readers see returned locations/ignored arrays; owner-only status is safe
progress/errorCode and revoked access is 404, with no raw storage key or original-read entitlement.
