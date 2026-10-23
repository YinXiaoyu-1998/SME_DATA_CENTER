# SMEDC | TypeScript npm workspaces

## Core boundaries

- 企业资料中枢 is a service/tool for employee-owned agents, CLIs, MCP clients, APIs, and minimal admin UI; do not turn it into an employee-facing AI agent, report generator, dashboard, or skill runner.
- Follow `docs/implementation/implementation-plan.md` phase boundaries. Backend authorization is mandatory for every non-health endpoint; never trust client-side filtering.
- Never commit secrets, `.env`, real customer exports, private tokens, service-account keys, or downloaded third-party data.

## Working discipline

- For small changes, default to one agent, focused tests, one review, and one final full gate. Before materially expanding agents, test scope, documentation, PR/release boundaries, or implementation size, explain why and ask the human.
- Use subagents only for independent workstreams with non-overlapping ownership. Agents that modify files need an isolated branch/worktree; read-only reviewers do not.
- When using subagent-driven development, group related subtasks into coherent implementation batches and review each completed batch. For one coherent change, prefer one consolidated review after implementation rather than separate reviews for every small task. Run focused tests and implementer self-review per task. An earlier separate review requires a concrete blocking risk and an explained reason; it is not the default.
- Keep design and implementation plans concise and decision-focused. Do not commit execution logs, scratch ledgers, review transcripts, or other process-only artifacts unless explicitly requested.
- Keep tests proportional to risk. Cover the critical public path, authorization/data boundaries, and realistic regressions; do not build exhaustive matrices or new harnesses for simple changes.
- During development run the smallest focused tests that prove the change. Run repository-wide gates once on the final tree before PR handoff; do not repeat unchanged full suites without a failure or high-risk reason.
- Check asynchronous CI, publishing, deployment, or DNS state once, then wait at least three minutes before checking the same blocker. If completion is not required for the current turn, report the pending state instead of polling.

## PR handoff

- For completed and verified SMEDC work, default to pushing the feature branch and creating or updating a PR, including coordinated changes in companion repositories. This is the user's standing preference and authorization; do not ask them to choose between merging, creating a PR, and keeping the branch again unless they give different task-specific instructions or a concrete blocker requires input.
- This default covers feature-branch pushes and PR creation, not merging, publishing, deployment, or real-data backfills; follow the separate authorization and release boundaries for those actions.
- Define the base branch in the plan or PR; otherwise verify the repository's current default branch.
- PR descriptions must state scope, tests, environment changes, human inputs, and known limitations.
- Before or with each PR, report approximate inserted/deleted lines for production/config, runtime/CI/deploy, tests/harnesses, docs/plans/reports, and `package-lock.json`.
- After verified work is merged into `main`, remove its clean inactive worktree and run `git worktree prune`; never force-remove a dirty or active worktree.

## Commands and rule discovery

- Run commands from the repository root unless a local rule says otherwise. Install: `npm install`; final checks: `npm run format:check`, `npm run lint`, `npm run typecheck`, `npm test`. Focused tests: `npm test -- <test-file-or-directory>`.
- Before modifying files, read every applicable `AGENTS.md` from this root through their directories; cross-directory work reads all affected scopes. Local rules add detail without weakening core boundaries. Paths in these instructions are repository-relative; do not preload unrelated module rules.
- Read these task entrypoints even when the task does not edit their directories:

| Task                                                                    | Required entrypoint                                                            |
| ----------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| Local services, tests, integration, readiness or performance claims     | `scripts/AGENTS.md`                                                            |
| Cloud/host changes, deployment or rollback, including root Docker files | `deploy/AGENTS.md`; CI changes also read `.github/AGENTS.md`                   |
| MCP behavior, contracts, launcher release or Skill usage guidance       | `packages/mcp-contract/AGENTS.md`                                              |
| Enterprise onboarding or permission administration                      | `apps/api/AGENTS.md`                                                           |
| Employee installation/login or login/password/admin UI changes          | `apps/api/src/auth/AGENTS.md`; UI changes also read `apps/admin-web/AGENTS.md` |
| Full official manual acceptance, only when explicitly requested         | `skills/smedc-manual-test/AGENTS.md`                                           |
| Documentation, plans or progress updates                                | `docs/AGENTS.md`                                                               |

## Agent skills

### Issue tracker

规格与任务使用本仓 GitHub Issues；发布和查重约定见 `docs/agents/issue-tracker.md`。

### Triage labels

分诊角色使用已确认的默认标签；映射见 `docs/agents/triage-labels.md`。

### Domain docs

单一领域上下文，沿用 `CONTEXT.md` 和现行文档入口；读取规则见 `docs/agents/domain.md`。
