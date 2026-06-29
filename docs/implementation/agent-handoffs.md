# 企业资料中枢 Agent Handoffs

## 2026-06-29 17:44 - codex/enterprise-hub-implementation - Day 0 lead skeleton

- Scope: Lead agent started Phase 1 / Day 0 only; create tracking docs, repo instructions, initial workspace layout, npm tooling, and local MySQL compose.
- Files changed: `AGENTS.md`, `.env.example`, npm/TypeScript/lint/format/test config, `docker-compose.yml`, `apps/*`, `packages/*`, and `docs/implementation/*` tracking docs.
- Commands run: `git switch -c codex/enterprise-hub-implementation`, `node --version`, `npm --version`, `docker --version`, `docker compose version`, `npm install`, `npm run lint`, `npm run typecheck`, `npm test`, `MYSQL_PORT=3307 docker compose up -d mysql`, Docker health inspect.
- Done criteria passed: Dependency install succeeded; local MySQL started and became healthy on port 3307; lint/test scripts exist and pass; progress docs exist; no business APIs or P1/P2/P3 scope implemented.
- PR: [#2](https://github.com/YinXiaoyu-1998/SME_DATA_CENTER/pull/2).
- Known gaps: No Day 1 business functionality implemented in this workstream; local port 3306 was occupied, so MySQL was verified with `MYSQL_PORT=3307`.
- Human blockers: None for Day 0 local skeleton.
- Suggested next agent: Lead agent should run verification, commit, push, and open/update draft PR before assigning Day 1 workstreams.

## 2026-06-29 18:12 - codex/hub-mvp-schema-auth - Day 1A schema/auth seed

- Scope: Implemented Phase 1 / Day 1A only: Prisma metadata schema, initial migration, idempotent local seed data, pure permission helper, and Day 1A documentation updates. Did not implement API routes, auth middleware, storage adapter, worker, MCP, admin UI, skill execution, or employee-facing AI behavior.
- Files changed: `package.json`, `package-lock.json`, `docker-compose.yml`, `docker/mysql/init/001-grant-prisma-shadow.sql`, `packages/db/package.json`, `packages/db/prisma.config.ts`, `packages/db/prisma/schema.prisma`, `packages/db/prisma/migrations/20260629101009_init_day_1a/migration.sql`, `packages/db/src/seed.ts`, `packages/domain/src/index.ts`, `packages/domain/src/permissions.ts`, `packages/domain/src/permissions.test.ts`, `docs/implementation/api-contract.md`, `docs/implementation/test-cases.md`, `docs/implementation/progress.md`, `docs/implementation/agent-handoffs.md`.
- Commands run: `git branch --show-current`; required doc reads; `npm install --workspace @enterprise-hub/db @prisma/client`; `npm install --save-dev prisma tsx`; `npm install --workspace @enterprise-hub/db @prisma/adapter-mariadb`; `npx prisma validate --config packages/db/prisma.config.ts`; `MYSQL_PORT=3307 docker compose up -d mysql`; Docker health inspect; local MySQL grant for Prisma shadow DB; `DATABASE_URL='mysql://enterprise_hub:enterprise_hub_local_password@localhost:3307/enterprise_hub' npm run db:migrate -- --name init_day_1a`; `npm run db:generate`; `DATABASE_URL='mysql://enterprise_hub:enterprise_hub_local_password@localhost:3307/enterprise_hub' npm run db:seed` twice; local DB count/index inspection queries; `npm test`; `npm test -- packages/domain/src/permissions.test.ts`; `npm run typecheck`; `npm run lint`; `npm run format:check`; targeted Prettier write for touched files.
- Done criteria passed: Migration creates all required Day 1A tables; seed is idempotent at one org, three employees, six labels, and three personal labels; employee-label assignments match store/personal/all-staff use cases; permission unit tests cover store match, personal match, all-staff, no match false, and disabled false; DB unique constraints exist for employee email, label key per org, and document-label pair; API contract lists exact document status and type enum values.
- PR: Not opened by subagent per lead instruction; lead will review, commit, push, and open/update draft PR.
- Known gaps: Prisma 7 requires a driver adapter, so seed uses `@prisma/adapter-mariadb` for the MySQL-family local database. Local `prisma migrate dev` required granting the Docker `enterprise_hub` user privileges for Prisma shadow DB creation; a Docker init SQL file now handles fresh local volumes, and the existing Day 0 volume was granted manually during verification. No production or external DB settings were introduced.
- Human blockers: None.
- Suggested next agent: Day 1B API/auth agent can consume the seeded employees/labels and permission helper after lead review/merge.
