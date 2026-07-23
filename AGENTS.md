# Enterprise Hub Agent Instructions

## Scope Guardrails

- This repository implements 企业资料中枢 as a service/tool for employee-owned agents, CLIs, MCP clients, APIs, and minimal admin UI.
- Do not turn 企业资料中枢 into a direct employee-facing AI agent, report generator, dashboard service, or skill execution platform.
- Follow `docs/implementation/implementation-plan.md` phase boundaries. Do not implement future-day scope early.
- Backend authorization is mandatory for every non-health endpoint. Client-side filtering is never trusted.
- Do not commit secrets, `.env` files, real customer exports, private tokens, service account keys, or downloaded third-party data.

## Branch And PR Rules

- Lead integration branch: `codex/enterprise-hub-implementation`.
- Subagents must use their own branch and stay inside their assigned day/workstream.
- Update `docs/implementation/progress.md` at session start/end and for meaningful work milestones only: branch/worktree start, baseline verification, phase/day/workstream completion, merged PR evidence, blocker/readiness state changes, recovery audits, and final handoff state.
- Do not use `docs/implementation/progress.md` as a running design-decision log or chat transcript. During requirements grilling or design discovery, record detailed decisions in a dedicated design document, ADR, API contract draft, or implementation plan section, then add at most one concise progress summary when that design artifact is created or materially completed.
- Subagents must append to `docs/implementation/agent-handoffs.md` before stopping.
- Draft PR descriptions must include scope, tests run, environment changes, human inputs used, and known limitations.
- Enterprise Hub MCP skill is dual-homed:
  - repo-local skill: `skills/enterprise-hub-mcp/`
  - standalone skill repo: `YinXiaoyu-1998/enterprise-hub-mcp-skill`
- When MCP tool behavior, API contracts, or usage guidance changes, update both the repo-local skill and the standalone skill repo. If the standalone repo is not already available locally, clone/fetch it from GitHub, create an independent branch there, make the matching skill/documentation change, and open/update a standalone skill PR. Do not assume a machine-specific checkout path.
- After any lead/subagent task is verified and fully merged into `main`, remove its clean, inactive local worktree and run `git worktree prune`; never force-remove worktrees with changes or active processes.

## Local Manual Acceptance Trigger

- A request such as “执行 SME_DATA_CENTER 手动测试”, “跑一遍 Enterprise Hub 人工验收”, or an equivalent request explicitly authorizes creation of separate user-visible Codex tasks for the test record.
- Before running that workflow, read and follow `skills/enterprise-hub-manual-test/SKILL.md` and `docs/implementation/local-agent-test.md`.
- Send each employee-client turn exactly as written in `fixtures/manual-acceptance/scenarios.json`; never add a controller boundary, tool/protocol hint, safety instruction, or expected answer to the visible message.
- The controller task operates only this repository's local test runtime. Employee-client tasks must use `skills/enterprise-hub-mcp/` and must not inspect or operate service internals.
- If user-visible task creation is unavailable, report that limitation instead of silently substituting same-context or direct-API execution.

## Commands

- Install dependencies: `npm install`
- Lint: `npm run lint`
- Typecheck: `npm run typecheck`
- Test: `npm test`
- Integration test: `npm run test:integration`
- Format check: `npm run format:check`
- Run local API: `npm run api:dev`
- Run local worker loop: `npm run worker:dev`
- Run one deterministic worker pass: `npm run worker:once`
- Run local MCP launcher: `ENTERPRISE_HUB_BASE_URL=http://127.0.0.1:3000 npm run mcp:launcher`
- Run local MCP smoke: `MYSQL_PORT=3307 npm run test:mcp`
- Run Phase 3 golden retrieval evaluation: `npm run test:phase3:golden`
- Run Phase 3 performance gates: `npm run test:phase3:perf`
- Purge local MySQL document data and uploaded/test storage files: `npm run purge-data`
- Start local MySQL: `docker compose up -d mysql`
- Start local MySQL + Qdrant: `docker compose up -d mysql qdrant`
- Initialize local Qdrant evidence collection: `npm run qdrant:init`
- Run local readiness checks: `DATABASE_URL='mysql://enterprise_hub:enterprise_hub_local_password@localhost:3307/enterprise_hub' npm run readyz:local`
- Stop local services: `docker compose down`
- Run local MVP demo loop: `MYSQL_PORT=3307 npm run test:integration`
- During local testing and debugging, agents may freely remove or recreate local Docker containers and volumes created by this repository or stale local worktrees, including MySQL and Qdrant test data. This permission is local-only and never applies to staging/production hosts or real customer data.

## Environments

Copy `.env.example` to `.env` for local development. Use development-only values locally and never commit `.env`.

Required local variables are tracked in `docs/implementation/env-inventory.md`.

## Alibaba Cloud CLI

- Prefer Alibaba Cloud CLI/OpenAPI over manual console clicks for Alibaba Cloud DevOps work when the requested action is authorized. This includes RDS, Simple Application Server/SWAS, ECS, VPC, OSS, ACR, DNS/domain, RAM/STS, logs/monitoring, and other Alibaba Cloud products.
- Alibaba Cloud CLI is not RDS-only. CLI plugins cover most console-backed resources; use `aliyun plugin search/list-remote`, install missing product plugins on demand, and run `aliyun <product> <command> --help` before constructing commands. Prefer plugin kebab-case commands; use legacy OpenAPI-style commands only as fallback.
- This workstation has `aliyun` installed at `/usr/local/bin/aliyun`; version `3.4.4`, auto-plugin-install enabled, and the `oauth` profile are valid for `cn-beijing` as of 2026-07-21. The `swas-open` and `cr` product plugins are installed at version `0.7.0`; the `rds` product plugin is installed at version `0.7.2`.
- For Simple Application Server, use `aliyun swas-open` where available for instance discovery and command-assistant flows such as `list-instances`, `create-command`, `invoke-command`, and `describe-command-invocations`. Use normal `ssh`, `curl`, `nc`, or app commands for OS-level checks when that is the right interface.
- For ACR, prefer CLI/OpenAPI for instance-backed Container Registry resources. Alibaba Cloud documents that ACR Personal Edition does not provide OpenAPI; if the current staging decision remains Personal Edition, agents cannot create the personal instance, namespace, repository, or registry password with `aliyun cr`. Ask the human only for that one-time console activation/password step, then continue with CLI/docker login, push, pull, and verification.
- If `aliyun` or a needed product plugin is missing, install/update it first, then configure OAuth when possible. Ask the human only for browser/MFA login, new authorization, destructive/costly scope confirmation, or secrets that cannot be obtained securely. Do not request AccessKey ID/secret in chat and do not commit CLI credentials.
- Use `aliyun configure list` for non-secret profile checks; use product help and official docs before mutating cloud resources. For agent-attributed Alibaba CLI work, enable the Alibaba Cloud agent user-agent mode only for the active workflow and disable it before finishing.
- Cloud resource readiness facts and non-secret IDs belong in `docs/implementation/staging-readiness.md`; passwords and full DSNs with passwords must stay in secure runtime storage only.

The local integration test defaults to `MYSQL_PORT=3307` when no `MYSQL_PORT` is set, starts local MySQL + Qdrant, resets the local development database, seeds sample employees/labels/skills, starts the API on an available local port, verifies Phase 3 structured import/query, uploads an evidence document, runs one worker pass, checks evidence index status, and verifies evidence search.

When an agent performs local end-to-end, go-online, staging-readiness, or external-provider validation, it must explicitly load the real local provider configuration from `.env` and run the relevant path with the real provider, for example `set -a; source .env; set +a; MYSQL_PORT=3307 npm run test:integration` plus any focused fixture smoke needed for the claim. Do not treat the default fake/mock provider path as evidence that real embedding/rerank/provider integration works. CI and routine automated tests may continue to use deterministic fake providers by default to avoid external secrets, network egress, cost, and flakiness.

- Before staging host changes, read `docs/implementation/server-runtime-prerequisites.md` and `docs/implementation/staging-readiness.md`; provision with `sudo bash scripts/provision-staging-runtime.sh`.
- Staging image delivery must use an account-owned Beijing ACR repository; do not use unapproved third-party mirrors or configure a general ACR registry hostname as `registry-mirrors`.
- Keep SSH keys and ACR credentials outside the repo; do not deploy the app until its MySQL, registry, secret, domain, and TLS readiness gates pass.
- The canonical staging release boundary is `npm run deploy:staging`. After `.github/workflows/staging-deploy.yml` is present on `main`, successful `main` quality gates invoke that same command through the GitHub `staging` Environment. Prefer the workflow over an ad-hoc local release; use the local command only for an explicitly approved recovery or workflow diagnosis.
- GitHub staging credentials are environment secrets named `ACR_PASSWORD`, `STAGING_JWT_SECRET`, and `STAGING_SSH_PRIVATE_KEY`. Non-secret target metadata is stored as environment variables. Agents may list names and update approved values through `gh`, but must never print secret values, copy them into repository files, or expose them in logs/PR text.
- Staging workflows are serialized by the `enterprise-hub-staging` concurrency group. PR branches never deploy. Manual deploy/rollback must be dispatched from `main`; rollback restores the immediately previous image release and never reverses a Prisma migration.
