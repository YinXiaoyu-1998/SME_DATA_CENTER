# SMEDC Reporting Release and Acceptance Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Merge, publish, deploy, synchronize, and validate the generic Enterprise Hub query release and the public Maijia SMEDC reporting skill against official staging.

**Architecture:** Release the API/launcher code from SME_DATA_CENTER first, let the trusted launcher workflow publish `0.2.6`, then synchronize recommended-version metadata and both Enterprise Hub MCP skill homes. Publish the new reporting skill only after the required launcher exists. Validate with synthetic staging data and multiple ordinary user-visible Codex tasks, then remove every run-scoped account, document, structured row, storage object, and local artifact.

**Tech Stack:** Git/GitHub CLI, GitHub Actions, npm trusted publishing, official staging, macOS Codex tasks, Enterprise Hub MCP launcher, MySQL/Qdrant/storage operator cleanup

**Spec:** `docs/superpowers/specs/2026-09-04-maijia-smedc-reporting-design.md`

## Global Constraints

- Use latest `main` as the base and PR branches prefixed `codex/`.
- Do not advertise or pin launcher `0.2.6` on a published main branch until npm publication is independently verified.
- Deploy staging only through the canonical GitHub Actions workflow from `main`; do not use an ad-hoc local deployment unless diagnosing an approved recovery.
- Wait at least three minutes between unchanged GitHub Actions/npm/deployment checks.
- Official employee-client validation uses fresh synthetic identities and ordinary natural-language tasks; agents use the official launcher/MCP path.
- Controller database/storage access is operator-only for fixture setup, verification, and cleanup.
- Existing staging business data is QA/test and may be removed or replaced, but cleanup must target resolved records and never broad production directories.
- New public repository is `YinXiaoyu-1998/maijia-business-analyses-smedc`, public, MIT licensed.
- PR handoff must report approximate inserted/deleted lines by production/config, runtime/CI/deploy, tests/harnesses, docs/plans/reports, and lockfile; process-only plans/spec scratch must be absent from the PR diff.

---

### Task 1: Review and open the service PR

**Files:**
- Modify: only defects found by review in the service branch
- Remove before PR diff: `docs/superpowers/plans/2026-09-04-*.md` and the process-only `docs/superpowers/specs/2026-09-04-maijia-smedc-reporting-design.md` unless the human explicitly asks to commit them

**Interfaces:**
- Consumes: completed general structured-query branch and green gates.
- Produces: one reviewable SME_DATA_CENTER PR based on current `main`.

- [ ] **Step 1: Rebase/fetch-check against origin/main and inspect scope**

Run `git fetch origin main`, verify the merge base, inspect `git diff --check`, `git status`, and `git diff --stat origin/main...HEAD`. Preserve unrelated user changes.

- [ ] **Step 2: Run two-stage code review**

Dispatch a spec-compliance reviewer and then a code-quality/security reviewer. The first checks every approved design requirement and the service-boundary/general-query rule; the second checks SQL parameterization, auth predicates, pagination/cursor correctness, public schema parity, and maintainability. Fix and re-run focused tests for every accepted defect.

- [ ] **Step 3: Run verification-before-completion gates**

Read the verification skill and rerun the final required commands on the exact tree to be pushed. Record exit codes and test counts.

- [ ] **Step 4: Prepare and open the PR**

The PR description includes scope, tests, environment changes, human inputs, known limitations, and the required diff composition report. State explicitly that no report engine/intelligence was added to the service.

### Task 2: Merge and verify launcher publication

**Files:**
- No repository edits unless release diagnosis finds a real defect.

**Interfaces:**
- Produces: merged service code on `main` and independently verified `enterprise-hub-mcp-launcher@0.2.6`.

- [ ] **Step 1: Wait for required PR checks and merge**

Use GitHub status once, then wait at least three minutes before checking unchanged jobs. Merge only after required checks and reviews pass.

- [ ] **Step 2: Observe the trusted launcher release workflow**

Confirm the workflow ran from the merge commit, native macOS/Windows acceptance passed, and the publish job either published `0.2.6` or verified byte-equivalent existing tarballs.

- [ ] **Step 3: Independently install and inspect `0.2.6`**

In a fresh temporary directory, run `npm pack enterprise-hub-mcp-launcher@0.2.6`, inspect package metadata/tool contract, and launch `--help`/version without using the workspace copy. Remove the temporary directory afterward.

### Task 3: Synchronize recommended metadata and both Enterprise Hub MCP skills

**Files:**
- Modify in SME_DATA_CENTER: `apps/api/src/auth/http-contract.ts` and its tests
- Modify in SME_DATA_CENTER: `skills/enterprise-hub-mcp/SKILL.md`, `README.md`, and pin/alignment tests
- Modify in standalone repo: matching `SKILL.md`, `README.md`, and metadata/tests

**Interfaces:**
- Produces: server recommendation and both skill homes aligned to verified launcher `0.2.6` and the new tool/query contract.

- [ ] **Step 1: Update the repo-local recommendation and pin**

Change `0.2.5` expectations to `0.2.6`, retain exact tool names/input examples from the released contract, and run focused auth/skill/alignment tests.

- [ ] **Step 2: Update the standalone skill on an independent branch**

Fetch its latest default branch, create a new `codex/` branch, apply the same guidance without dataset-specific recipes, run its validation tests, and open a standalone PR.

- [ ] **Step 3: Open/merge the synchronization PRs promptly**

Include separate diff composition reports. Merge the standalone skill PR and SME_DATA_CENTER alignment PR only after checks pass; verify the next staging deployment advertises `0.2.6`.

### Task 4: Publish the public reporting skill repository

**Files:**
- Modify only review fixes in the standalone `maijia-business-analyses-smedc` repository.

**Interfaces:**
- Produces: public GitHub repository `YinXiaoyu-1998/maijia-business-analyses-smedc` with default branch `main`.

- [ ] **Step 1: Review the skill against the released service**

Run skill-creator validation, all unittest/CLI smokes, placeholder scan, secret scan, and grep for removed profit/local-file/direct-HTTP flows. Generate one weekly and one monthly HTML from committed synthetic bundles and inspect them visually.

- [ ] **Step 2: Create the public repository**

Use `gh repo create YinXiaoyu-1998/maijia-business-analyses-smedc --public --source <local-path> --remote origin`, push the reviewed history, set `main` as default, and confirm anonymous `gh api repos/...` visibility is public.

- [ ] **Step 3: Add repository metadata**

Set a concise description/topics, confirm MIT license detection, and verify installation instructions use `/Users/xiaoyuyin/.agents/skills` only as a local example rather than a required machine-specific path.

### Task 5: Deploy and validate official staging APIs

**Files:**
- Modify: `docs/implementation/progress.md`
- Modify: `docs/implementation/staging-readiness.md` only if non-secret readiness facts changed

**Interfaces:**
- Verifies: deployed dataset registry v2, coverage endpoint/tool, multi-field grouping, weighted average, alias sort, cursor pagination, and authorization boundaries.

- [ ] **Step 1: Confirm the canonical staging deployment**

Wait for the main quality gate and serialized staging deploy. Verify health/readiness and release identity without printing secrets.

- [ ] **Step 2: Create a fresh synthetic acceptance account and fixtures**

Follow `skills/enterprise-hub-manual-test/SKILL.md` and `docs/implementation/official-manual-acceptance.md`. Create synthetic `business`, `dishes`, and `dish_catalog` files with enough rows for weekly/monthly comparisons, trends, channels, dayparts, stalls, weighted metrics, and at least one intentionally absent optional window.

Before importing v2 fixtures, resolve and hard-delete existing QA `business` and `dishes` v1 documents/imports using targeted operator queries/API operations. Verify the resolved import-batch, row, document-label, document, and storage-object set before deletion; never use a broad database or bucket purge.

- [ ] **Step 3: Validate raw API/MCP semantics**

Through the official launcher, verify registry discovery, coverage visibility, one three-field group, one weighted average with hand-calculated expected value, aggregate alias ordering, a second cursor page, and a manager unable to see a document carrying an unrelated label.

- [ ] **Step 4: Record a concise deployment milestone**

Update progress with deployment run/commit and validation evidence, not a command transcript.

### Task 6: Multi-task end-user skill acceptance and cleanup

**Files:**
- Generated run artifacts only; do not commit them.

**Interfaces:**
- Produces: evidence that ordinary Codex users can install/use the public skill with Enterprise Hub to create weekly, monthly, and partial reports.

- [ ] **Step 1: Create separate user-visible Codex tasks**

Create at least four projectless tasks with one natural-language request each: install/connect, upload synthetic sources, generate a weekly report, generate a monthly report with intentional partial coverage. Do not send controller checklists or internal expected steps to employee-client tasks.

- [ ] **Step 2: Wait for and inspect outputs**

Use task waiting/status tools at bounded intervals. Confirm both HTML reports open, numbers match fixture expectations, source provenance appears, and the partial report identifies omitted modules without claiming the service failed.

- [ ] **Step 3: Clean staging and local artifacts**

Delete run-scoped documents/rows/storage/Qdrant points through the official acceptance cleanup, hard-delete the synthetic account, run the official cleanup verifier, remove generated local reports/temp directories, stop Docker resources, remove clean inactive worktrees, and run `git worktree prune`.

- [ ] **Step 4: Final handoff**

Report service PR(s), standalone MCP skill PR, public reporting repo, launcher npm version, staging deployment run, acceptance task IDs/results, cleanup proof, known limitations, and required diff composition. Mark the project complete only when all required work is merged/deployed/published and cleanup passes.
