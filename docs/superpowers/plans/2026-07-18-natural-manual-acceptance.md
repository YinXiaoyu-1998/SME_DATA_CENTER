# Natural Manual Acceptance Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace guided protocol-heavy employee prompts with verbatim natural cold-start prompts, then prove the revised suite in new visible Codex tasks and publish the result.

**Architecture:** `fixtures/manual-acceptance/scenarios.json` is the sole employee-message source. The repo-local manual-test skill acts only as controller/oracle and sends manifest prompts verbatim; protocol constraints remain in automated tests, transcript scoring, and operator snapshots. Product API, worker, domain, schema, and MCP code remain unchanged.

**Tech Stack:** TypeScript, Vitest, JSON/Markdown fixtures, Codex visible task tools, Docker Compose, MySQL, Qdrant, Git/GitHub.

**Execution status:** Completed in the current session; the checkboxes below preserve the planned TDD sequence and commands.

## Global Constraints

- Never prepend controller instructions to an employee-client task.
- Keep the development login email and fixture path only as local substitutes for SSO and file attachment.
- Do not put MCP, Base64, raw-byte, label-key, visibility-scope, idempotency-key, SQL, controlled-query, grounding, permission, validation, or expected-answer instructions in employee prompts.
- Preserve four independent visible tasks and the existing ten business turns.
- Do not modify product behavior.

---

### Task 1: Define the natural prompt contract with failing tests

**Files:**

- Modify: `scripts/manual-test-fixtures.test.ts`
- Test: `scripts/manual-test-fixtures.test.ts`

**Interfaces:**

- Consumes: `fixtures/manual-acceptance/scenarios.json` tasks and turns.
- Produces: automated rejection of protocol/controller language and a requirement that cold search does not name a tool.

- [ ] **Step 1: Replace the exact-byte prompt assertion with natural-language assertions**

Add forbidden-fragment checks for `Act only as`, `enterprise hub mcp`, `MCP`, `幂等键`, `可见范围`, `只根据我能访问`, `受控结构化查询`, `SQL`, `原始字节`, `Base64`, `不要转写`, and answer/safety hints. Assert the meat-sandwich cold-search prompt contains only the business question plus local login identity.

- [ ] **Step 2: Run the targeted test and verify RED**

Run: `npx vitest run scripts/manual-test-fixtures.test.ts`

Expected: FAIL because the current v1 manifest contains the forbidden protocol language.

### Task 2: Replace employee prompts and controller behavior

**Files:**

- Modify: `fixtures/manual-acceptance/scenarios.json`
- Modify: `skills/enterprise-hub-manual-test/SKILL.md`
- Modify: `skills/enterprise-hub-manual-test/agents/openai.yaml`
- Test: `scripts/manual-test-fixtures.test.ts`

**Interfaces:**

- Consumes: the natural prompt contract from Task 1.
- Produces: manifest version `2026-07-18.v2` and a controller skill that sends each prompt verbatim without a boundary prefix.

- [ ] **Step 1: Rewrite all ten turns in ordinary employee language**

Use forms such as `用 baoli.manager@example.com 登录一下。我们的肉夹馍怎么做？要不要放青椒？` and `这份表一共有多少条记录？销售额加起来是多少？销售额最高的两个菜是什么？`.

- [ ] **Step 2: Remove the reusable employee boundary from the controller skill**

State that task prompts must equal the manifest text exactly. Keep source/log/database restrictions only as scoring criteria: if the participant chooses a bypass without being prompted, record a failure.

- [ ] **Step 3: Run the targeted test and verify GREEN**

Run: `npx vitest run scripts/manual-test-fixtures.test.ts`

Expected: 6 tests pass.

### Task 3: Align operator documentation and reports

**Files:**

- Modify: `docs/implementation/local-agent-test.md`
- Modify: `docs/implementation/test-cases.md`
- Modify: `README.md`
- Modify: `README.zh.md`
- Modify: `docs/implementation/progress.md`

**Interfaces:**

- Consumes: v2 manifest and controller skill.
- Produces: documentation that distinguishes `natural cold-start` from `guided conformance` and shows only natural prompt examples.

- [ ] **Step 1: Remove instructions to prepend the old boundary**

Document verbatim task dispatch, local email/path limitations, clarification handling, and operator-only oracle fields.

- [ ] **Step 2: Relabel the previous v1 evidence**

Call the previous runs guided conformance evidence, not natural cold-start acceptance.

- [ ] **Step 3: Format and validate the skill**

Run: `npx prettier --write <changed files>` and `python3 /Users/xiaoyuyin/.codex/skills/.system/skill-creator/scripts/quick_validate.py skills/enterprise-hub-manual-test`.

Expected: skill validation succeeds.

### Task 4: Execute the natural cold-start suite

**Files:**

- Create ignored artifact: `.data/manual-tests/<runId>/report.md`

**Interfaces:**

- Consumes: v2 manifest, local MCP launcher, clean harness runtime.
- Produces: four visible task transcripts, snapshots, logs, and one report.

- [ ] **Step 1: Prepare and serve a clean deterministic environment**

Run: `npm run test:manual:prepare`, then keep `npm run test:manual:serve` alive.

- [ ] **Step 2: Create four visible local Codex tasks**

Send the manifest first turn exactly, with no prefix or suffix. Execute follow-ups in order and retain the tasks unarchived.

- [ ] **Step 3: Score actual behavior**

Review MCP tool calls, source/log bypass, clarification requests, cross-store leakage, unsupported answers, prompt injection, structured totals, and invalid-import atomicity. Do not repair participant behavior inside its task.

- [ ] **Step 4: Snapshot, report, and clean up**

Run: `npm run test:manual:snapshot`, write the report, stop serve, and run `npm run test:manual:cleanup`.

### Task 5: Verify and publish

**Files:**

- Modify: `docs/implementation/progress.md`

**Interfaces:**

- Consumes: completed code/docs and live report.
- Produces: verified commits, pushed branch, and draft PR to the default branch.

- [ ] **Step 1: Run fresh verification**

Run `npm test`, `npm run lint`, `npm run typecheck`, `npm run format:check`, skill validation, `git diff --check`, and `docker compose ps --status running`.

- [ ] **Step 2: Review scope and secrets**

Confirm no product source file or secret is added and `.data/manual-tests` remains ignored.

- [ ] **Step 3: Commit intended files**

Stage the manual acceptance suite, design/plan, fixtures, tests, and related docs only. Commit with a terse message.

- [ ] **Step 4: Push and open a draft PR**

Push `codex/manual-acceptance-suite`, target the remote default branch, and include scope, tests, environment changes, human inputs, live task evidence, and limitations in the PR body.
