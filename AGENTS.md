# SMEDC Agent Instructions

## Scope

- 企业资料中枢 is a service/tool for employee-owned agents, CLIs, MCP clients, APIs, and minimal admin UI; do not turn it into an employee-facing AI agent, report generator, dashboard, or skill runner.
- Follow `docs/implementation/implementation-plan.md` phase boundaries. Backend authorization is mandatory for every non-health endpoint; never trust client-side filtering.
- Never commit secrets, `.env`, real customer exports, private tokens, service-account keys, or downloaded third-party data.

## Execution Discipline

- For small changes, default to one agent, focused tests, one review, and one final full gate. Before materially expanding agents, test scope, documentation, PR/release boundaries, or implementation size, explain why and ask the human.
- Use subagents only for independent workstreams with non-overlapping ownership. Agents that modify files need an isolated branch/worktree; read-only reviewers do not.
- When using subagent-driven development, group related subtasks into coherent implementation batches and review each completed batch. For one coherent change, prefer one consolidated review after implementation rather than separate reviews for every small task. Run focused tests and implementer self-review per task. An earlier separate review requires a concrete blocking risk and an explained reason; it is not the default.
- Update `docs/implementation/progress.md` only for durable milestones, merged releases, blockers, recovery audits, and final readiness. Record a handoff only when ownership actually transfers; never use progress or handoff files as transcripts.
- Keep design and implementation plans concise and decision-focused. Do not commit execution logs, scratch ledgers, review transcripts, or other process-only artifacts unless explicitly requested.

## Branches And PRs

- For completed and verified SMEDC work, default to pushing the feature branch and creating or updating a PR, including coordinated changes in companion repositories. This is the user's standing preference and authorization; do not ask them to choose between merging, creating a PR, and keeping the branch again unless they give different task-specific instructions or a concrete blocker requires input.
- This default covers feature-branch pushes and PR creation, not merging, publishing, deployment, or real-data backfills; follow the separate authorization and release boundaries for those actions.
- Define the base branch in the plan or PR; otherwise verify the repository's current default branch.
- PR descriptions must state scope, tests, environment changes, human inputs, and known limitations.
- Before or with each PR, report approximate inserted/deleted lines for production/config, runtime/CI/deploy, tests/harnesses, docs/plans/reports, and `package-lock.json`.
- After verified work is merged into `main`, remove its clean inactive worktree and run `git worktree prune`; never force-remove a dirty or active worktree.

## Release Boundaries

- The SMEDC MCP skill is dual-homed in `skills/smedc-mcp/` and `YinXiaoyu-1998/smedc-mcp-skill`. Changes to MCP behavior, contracts, or usage guidance must update both and use an independent branch/PR in the standalone repository.
- Treat `apps/mcp-launcher/` and its bundled MCP contracts as one release boundary. Runtime or tool-contract changes must bump the launcher version and package/alignment tests in the same PR.
- Publish and independently verify the launcher before updating server recommended-version metadata and both Skill pins.

## Testing

- Keep tests proportional to risk. Cover the critical public path, authorization/data boundaries, and realistic regressions; do not build exhaustive matrices or new harnesses for simple changes.
- During development run the smallest focused tests that prove the change. Run repository-wide gates once on the final tree before PR handoff; do not repeat unchanged full suites without a failure or high-risk reason.
- For runtime/performance work, prove correctness locally, then compare the same fixture/workload on staging after deployment; skip large workstation benchmarks unless requested.
- Keep manual acceptance focused on the changed workflow. Release approval does not authorize the full official acceptance suite.

## Skills

- Keep `smedc-mcp` limited to MCP usage, login/install, tool parameters, status/error handling, upload transport, and structured-query semantics.
- Dataset-specific repair/conversion belongs in the service or a separate workflow Skill; the base Skill may upload originals and report service validation errors.

## Official Manual Acceptance

- Run the full official workflow only when explicitly requested. First read `skills/smedc-manual-test/SKILL.md` and `docs/implementation/official-manual-acceptance.md`.
- Use official staging, macOS Codex, browser auth, and the launcher version specified by the acceptance document. Use fresh synthetic accounts; the agent must not open setup links or type test credentials. The human may disclose that synthetic password in the current private chat and must complete setup one at a time; never persist credentials.
- Employee-client steps must use the official launcher/MCP path. Controller access is for setup, verification, and cleanup only.
- Run `npm run test:official-manual`; delete all run-scoped DB/storage/Qdrant data and synthetic accounts before reporting success.

## Commands

- Install: `npm install`; quality: `npm run format:check`, `npm run lint`, `npm run typecheck`, `npm test`.
- Integration: `MYSQL_PORT=3307 npm run test:integration`; MCP smoke: `MYSQL_PORT=3307 npm run test:mcp`.
- API/worker: `npm run api:dev`, `npm run worker:dev`, `npm run worker:once`.
- Launcher: `SMEDC_BASE_URL=https://api.smedatacenter.xyz npm run mcp:launcher`.
- Local services: `docker compose up -d mysql qdrant`; stop: `docker compose down`; purge uploads/data: `npm run purge-data`.
- Other scripts, including retrieval evaluations and the Calamine reader, are documented in `package.json`.

## Local Safety And Cleanup

- After local tests, delete run-created `.data/` artifacts and stop/remove repository-owned containers, volumes, and networks. Verify with Docker inventories and `git worktree list`.
- Agents may reset this repository's Prisma/MySQL development/test databases and Docker volumes only after verifying the host is local (`localhost`/`127.0.0.1`). This never applies to staging, production, remote, externally managed, or real-customer databases.
- Copy `.env.example` to `.env` for local development. Required variables are in `docs/implementation/env-inventory.md`; never commit `.env`.
- End-to-end, readiness, staging, or provider claims must load the real local `.env` provider configuration. CI and routine tests may use deterministic fake providers.

## Employee Client

- Follow `docs/implementation/official-user-install-and-login.md`. Real or user-owned account passwords remain out of scope; synthetic manual-test credentials follow the official acceptance instructions above.

## Cloud And Staging

- Prefer Alibaba Cloud CLI/OpenAPI for authorized cloud work. Inspect product help before mutation; use SSH or OS tools for host-level checks.
- ACR Personal Edition has no OpenAPI for console-only resource mutation. Give the human exact targets for those changes, then continue with CLI/docker verification.
- Never request AccessKey secrets in chat or expose credentials in commands, logs, PRs, or repository files. Store non-secret readiness facts in `docs/implementation/staging-readiness.md`.
- Before host changes read `docs/implementation/server-runtime-prerequisites.md` and `docs/implementation/staging-readiness.md`. Use the account-owned Beijing ACR; do not configure unapproved registry mirrors.
- The canonical release is `npm run deploy:staging` through the GitHub `staging` Environment after `main` quality gates. PRs never deploy; local deployment is only for explicitly approved recovery/diagnosis.
- Staging workflows use the `smedc-staging` concurrency group. Rollback restores the previous image and never reverses Prisma migrations.

## External Waiting

- Check asynchronous CI, publishing, deployment, or DNS state once, then wait at least three minutes before checking the same blocker. If completion is not required for the current turn, report the pending state instead of polling.
