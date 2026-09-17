# SMEDC Agent Instructions

## Scope Guardrails

- This repository implements 企业资料中枢 as a service/tool for employee-owned agents, CLIs, MCP clients, APIs, and minimal admin UI.
- Do not turn 企业资料中枢 into a direct employee-facing AI agent, report generator, dashboard service, or skill execution platform.
- Follow `docs/implementation/implementation-plan.md` phase boundaries. Do not implement future-day scope early.
- Backend authorization is mandatory for every non-health endpoint. Client-side filtering is never trusted.
- Do not commit secrets, `.env` files, real customer exports, private tokens, service account keys, or downloaded third-party data.

## Branch And PR Rules

- Define each task's base/lead branch in its plan or PR. If none is specified, verify and use the repository's current default branch; never rely on a permanently fixed historical lead branch.
- Default every spawned subagent and every new Codex task/chat/thread created for project work to model `gpt-5.5` with `high` reasoning effort. An explicit user-selected model or effort takes precedence; if this combination is unavailable, use the best supported configured model without blocking the task and report the fallback.
- Subagents must use their own branch and stay inside their assigned day/workstream.
- Update `docs/implementation/progress.md` at session start/end and for meaningful work milestones only: branch/worktree start, baseline verification, phase/day/workstream completion, merged PR evidence, blocker/readiness state changes, recovery audits, and final handoff state.
- Do not use `docs/implementation/progress.md` as a running design-decision log or chat transcript. During requirements grilling or design discovery, record detailed decisions in a dedicated design document, ADR, API contract draft, or implementation plan section, then add at most one concise progress summary when that design artifact is created or materially completed.
- Subagents must append to `docs/implementation/agent-handoffs.md` before stopping.
- Draft PR descriptions must include scope, tests run, environment changes, human inputs used, and known limitations.
- When creating or materially updating a PR, always report the PR diff composition to the human before or alongside the PR link. Include approximate inserted/deleted line counts by category:
  - production code/config;
  - runtime, CI, and deploy scripts;
  - tests and test/integration harnesses;
  - documentation, plans, and reports;
  - `package-lock.json`.
    Call out any process-only artifacts such as execution plans, SDD reports, scratch ledgers, or handoff logs, and remove them from the PR unless the human explicitly wants them committed.
- SMEDC MCP skill is dual-homed:
  - repo-local skill: `skills/smedc-mcp/`
  - standalone skill repo: `YinXiaoyu-1998/smedc-mcp-skill`
- When MCP tool behavior, API contracts, or usage guidance changes, update both the repo-local skill and the standalone skill repo. If the standalone repo is not already available locally, clone/fetch it from GitHub, create an independent branch there, make the matching skill/documentation change, and open/update a standalone skill PR. Do not assume a machine-specific checkout path.
- Treat `apps/mcp-launcher/` and the MCP contracts bundled into its published artifact as one release boundary. Any change to launcher runtime behavior or bundled tool names/input schemas must bump the launcher version and its alignment/package tests in the same PR; never merge such a contract change while leaving the published launcher version unchanged.
- Publish and independently verify the bumped launcher before updating server recommended-version metadata and both skill pins; complete that synchronization immediately after publication so staging never advertises or documents an unavailable launcher.
- After any lead/subagent task is verified and fully merged into `main`, remove its clean, inactive local worktree and run `git worktree prune`; never force-remove worktrees with changes or active processes.

## Testing Scope

- Keep tests proportional to feature risk. Cover the critical public path, authorization/data-boundary behavior, and regressions that could realistically recur; do not build exhaustive case matrices or new harnesses for simple changes.
- During development, run the smallest focused test set that proves the current change. Run required repository-wide gates once on the final tree before PR handoff; do not repeatedly rerun unchanged long suites after every small edit unless a failure or high-risk change justifies it.
- For runtime/performance optimizations, skip large developer-workstation benchmarks unless the user explicitly requests them. Prove correctness locally, then compare the same fixture/workload and phase timings on staging after the quality-gated deployment; record the release SHA with the results.
- Keep manual acceptance focused on the changed workflow unless the user explicitly requests the full official acceptance suite or the touched release boundary requires it.

## Skill Content Boundaries

- Keep the base `smedc-mcp` skill focused on MCP usage, login/install, tool parameters, status handling, authorization-safe error handling, general upload transport constraints, and structured-query field semantics.
- Do not put dataset-specific file transformation recipes in the base skill, such as exact table-header lists, instructions to rename/reorder headers, duplicate header metadata into detail rows, rewrite workbooks, or generate normalized replacement CSV/XLSX files for a particular business document type.
- If a workflow needs dataset-specific repair or conversion behavior, implement it in the service or in a separate explicit skill for that workflow. The base skill may tell agents to upload original files and report service-returned validation errors.

## CI And Deployment Waiting

- When waiting on GitHub Actions, npm publishing, staging deployment, DNS, or another external asynchronous blocker, check once, then wait at least 3 minutes before checking the same blocker again. Prefer a quiet long-interval watch or one-shot status checks over frequent polling, and do not narrate unchanged intermediate states.
- If deployment completion is not a hard blocker for the current turn, report the pending state and hand off instead of babysitting it.

## Local Manual Acceptance Trigger

- A request such as “执行 SME_DATA_CENTER 手动测试”, “跑一遍 SMEDC 人工验收”, or an equivalent request explicitly authorizes the official manual acceptance workflow.
- Before running that workflow, read `skills/smedc-manual-test/SKILL.md` and `docs/implementation/official-manual-acceptance.md`. The old local email-login/HTTP-launcher manual acceptance document has been deleted; do not look for or recreate it.
- The active default is official staging + macOS Codex + browser auth + `smedc-mcp-launcher@0.5.0`. Do not revive the deleted development email-login or HTTP-launcher assumptions.
- Full manual acceptance must create a fresh synthetic account such as `manual-full-flow-<runId>@example.invalid`, generate its own throwaway password, control Chrome to complete password setup/login, then hard-delete that account after all test data is cleaned. Do not use the human owner's real account or require the human to type test credentials.
- Full manual acceptance must mimic normal low-technical employee usage with multiple new user-visible Codex tasks/sessions. Each employee-client task should receive exactly one ordinary natural-language request, such as install/login, upload a file, ask a business question, or query a structured file. Do not collapse the flow into one controller-style prompt that lists internal expected steps; the resulting task transcripts are part of the acceptance evidence and may be archived by the human afterward.
- The employee-client path must use the official launcher and MCP tools. Controller DB/storage/Qdrant access is allowed only for operator setup, verification, and run-scoped cleanup.
- Manual staging uploads must clean up after themselves; use `npm run test:official-manual` and confirm run-scoped DB/storage/Qdrant residue is gone before reporting success.

## Commands

- Install dependencies: `npm install`
- Lint: `npm run lint`
- Typecheck: `npm run typecheck`
- Test: `npm test`
- Integration test: `npm run test:integration`
- Format check: `npm run format:check`
- Run local API: `npm run api:dev`
- Build the local Calamine XLSX reader: `npm run build:calamine-reader`
- Run local worker loop: `npm run worker:dev`
- Run one deterministic worker pass: `npm run worker:once`
- Run the official MCP launcher: `SMEDC_BASE_URL=https://api.smedatacenter.xyz npm run mcp:launcher`
- Run local MCP smoke: `MYSQL_PORT=3307 npm run test:mcp`
- Run official macOS Codex/staging manual acceptance: `npm run test:official-manual`
- Run Phase 3 golden retrieval evaluation: `npm run test:phase3:golden`
- Run Phase 3 performance gates: `npm run test:phase3:perf`
- Purge local MySQL document data and uploaded/test storage files: `npm run purge-data`
- Start local MySQL: `docker compose up -d mysql`
- Start local MySQL + Qdrant: `docker compose up -d mysql qdrant`
- Initialize local Qdrant evidence collection: `npm run qdrant:init`
- Run local readiness checks: `DATABASE_URL='mysql://smedc:smedc_local_password@localhost:3307/smedc' npm run readyz:local`
- Stop local services: `docker compose down`
- Run local MVP demo loop: `MYSQL_PORT=3307 npm run test:integration`
- During local testing and debugging, agents may freely remove or recreate local Docker containers and volumes created by this repository or stale local worktrees, including MySQL and Qdrant test data. This permission is local-only and never applies to staging/production hosts or real customer data.

## Local Test Cleanup

After every local test run (unit, integration, benchmark, manual acceptance, or MCP smoke), remove everything the run created before stopping or handing off:

- Delete generated test files and run-scoped data under `.data/` (benchmark artifacts, evaluation reports, storage, manual-test output).
- Stop and remove local Docker containers, volumes, and networks started by this repository for the run (for example `docker compose -p <project> down -v` or explicit `docker rm -f` / `docker volume rm` / `docker network rm`).
- Remove clean, inactive test worktrees and run `git worktree prune` after their branch is merged.
- Verify no repo-owned leftovers remain with `docker ps -a`, `docker volume ls`, `docker network ls`, and `git worktree list`.

This cleanup is local-only and never applies to staging/production hosts or real customer data.

## Local Development Database Reset Authorization

The user has authorized agents to reset or clear this repository's local Prisma/MySQL development
and test databases whenever a local development or verification workflow requires it. This includes
`prisma migrate reset --force` when its configured database host is local (for example,
`localhost`/`127.0.0.1`) and the database is the repository's development/test database. It also
includes the repository-owned Docker volumes created for that workflow. This standing authorization
never applies to staging, production, remote hosts, externally managed databases, real customer
data, or any database whose local-development/test identity cannot be verified first.

## Environments

Copy `.env.example` to `.env` for local development. Use development-only values locally and never commit `.env`.

Required local variables are tracked in `docs/implementation/env-inventory.md`.

## Employee Client Design

- Follow `docs/implementation/official-user-install-and-login.md` for official client installation, login, and session decisions. Keep the evolving design in that document rather than duplicating it here; never ask a user to expose an account password or authentication token to the agent/model.

## Alibaba Cloud CLI

- Prefer Alibaba Cloud CLI/OpenAPI over manual console clicks for Alibaba Cloud DevOps work when the requested action is authorized. This includes RDS, Simple Application Server/SWAS, ECS, VPC, OSS, ACR, DNS/domain, RAM/STS, logs/monitoring, and other Alibaba Cloud products.
- Alibaba Cloud CLI is not RDS-only. CLI plugins cover most console-backed resources; use `aliyun plugin search/list-remote`, install missing product plugins on demand, and run `aliyun <product> <command> --help` before constructing commands. Prefer plugin kebab-case commands; use legacy OpenAPI-style commands only as fallback.
- This workstation has `aliyun` installed at `/usr/local/bin/aliyun`; version `3.4.4`, auto-plugin-install enabled, and the `oauth` profile are valid for `cn-beijing` as of 2026-07-21. The `swas-open` and `cr` product plugins are installed at version `0.7.0`; the `rds` product plugin is installed at version `0.7.2`.
- For Simple Application Server, use `aliyun swas-open` where available for instance discovery and command-assistant flows such as `list-instances`, `create-command`, `invoke-command`, and `describe-command-invocations`. Use normal `ssh`, `curl`, `nc`, or app commands for OS-level checks when that is the right interface.
- For ACR, prefer CLI/OpenAPI for instance-backed Container Registry resources. Alibaba Cloud documents that ACR Personal Edition does not provide OpenAPI; if the current staging decision remains Personal Edition, agents cannot create the personal instance, namespace, repository, or registry password with `aliyun cr`. Ask the human only for that one-time console activation/password step, then continue with CLI/docker login, push, pull, and verification.
- If `aliyun` or a needed product plugin is missing, install/update it first, then configure OAuth when possible. Ask the human only for browser/MFA login, new authorization, destructive/costly scope confirmation, or secrets that cannot be obtained securely. Do not request AccessKey ID/secret in chat and do not commit CLI credentials.
- Use `aliyun configure list` for non-secret profile checks; use product help and official docs before mutating cloud resources. For agent-attributed Alibaba CLI work, enable the Alibaba Cloud agent user-agent mode only for the active workflow and disable it before finishing.
- Cloud resource readiness facts and non-secret IDs belong in `docs/implementation/staging-readiness.md`; passwords and full DSNs with passwords must stay in secure runtime storage only.

The local integration test defaults to `MYSQL_PORT=3307` when no `MYSQL_PORT` is set, starts local MySQL + Qdrant, resets the local development database, seeds sample employees/skills, starts the API on an available local port, verifies Phase 3 structured import/query at the applicable confidentiality levels, uploads an evidence document, runs one worker pass, checks evidence index status, and verifies evidence search.

When an agent performs local end-to-end, go-online, staging-readiness, or external-provider validation, it must explicitly load the real local provider configuration from `.env` and run the relevant path with the real provider, for example `set -a; source .env; set +a; MYSQL_PORT=3307 npm run test:integration` plus any focused fixture smoke needed for the claim. Do not treat the default fake/mock provider path as evidence that real embedding/rerank/provider integration works. CI and routine automated tests may continue to use deterministic fake providers by default to avoid external secrets, network egress, cost, and flakiness.

- Before staging host changes, read `docs/implementation/server-runtime-prerequisites.md` and `docs/implementation/staging-readiness.md`; provision with `sudo bash scripts/provision-staging-runtime.sh`.
- Staging image delivery must use an account-owned Beijing ACR repository; do not use unapproved third-party mirrors or configure a general ACR registry hostname as `registry-mirrors`.
- Keep SSH keys and ACR credentials outside the repo; do not deploy the app until its MySQL, registry, secret, domain, and TLS readiness gates pass.
- The canonical staging release boundary is `npm run deploy:staging`. After `.github/workflows/staging-deploy.yml` is present on `main`, successful `main` quality gates invoke that same command through the GitHub `staging` Environment. Prefer the workflow over an ad-hoc local release; use the local command only for an explicitly approved recovery or workflow diagnosis.
- GitHub staging credentials are environment secrets named `ACR_PASSWORD`, `STAGING_CURSOR_SIGNING_SECRET`, and `STAGING_SSH_PRIVATE_KEY`. Non-secret target metadata is stored as environment variables. Agents may list names and update approved values through `gh`, but must never print secret values, copy them into repository files, or expose them in logs/PR text.
- Staging workflows are serialized by the `smedc-staging` concurrency group. PR branches never deploy. Manual deploy/rollback must be dispatched from `main`; rollback restores the immediately previous image release and never reverses a Prisma migration.
