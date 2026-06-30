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
- Update `docs/implementation/progress.md` at the start and end of every work session.
- Subagents must append to `docs/implementation/agent-handoffs.md` before stopping.
- Draft PR descriptions must include scope, tests run, environment changes, human inputs used, and known limitations.

## Commands

- Install dependencies: `npm install`
- Lint: `npm run lint`
- Typecheck: `npm run typecheck`
- Test: `npm test`
- Format check: `npm run format:check`
- Run one deterministic worker pass: `npm run worker:once`
- Start local MySQL: `docker compose up -d mysql`
- Stop local services: `docker compose down`

## Local Environment

Copy `.env.example` to `.env` for local development. Use development-only values locally and never commit `.env`.

Required local variables are tracked in `docs/implementation/env-inventory.md`.
