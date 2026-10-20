# Operational scripts and local verification

## Local setup and safety

- After local tests, delete run-created `.data/` artifacts and stop/remove repository-owned containers, volumes, and networks. Verify with Docker inventories and `git worktree list`.
- Agents may reset this repository's Prisma/MySQL development/test databases and Docker volumes only after verifying the host is local (`localhost`/`127.0.0.1`). This never applies to staging, production, remote, externally managed, or real-customer databases.
- Copy `.env.example` to `.env` for local development. Required variables are in `docs/implementation/env-inventory.md`; never commit `.env`.
- End-to-end, readiness, staging, or provider claims must load the real local `.env` provider configuration. CI and routine tests may use deterministic fake providers.
- Cleanup must remain run-scoped; do not remove another active task's resources.
- For runtime/performance work, prove correctness locally, then compare the same fixture/workload on staging after deployment; skip large workstation benchmarks unless requested.
- Keep manual acceptance focused on the changed workflow. Release approval does not authorize the full official acceptance suite.
- Full official acceptance follows `skills/smedc-manual-test/AGENTS.md`.

## Commands

- Integration: `MYSQL_PORT=3307 npm run test:integration`; MCP smoke: `MYSQL_PORT=3307 npm run test:mcp`.
- API/worker: `npm run api:dev`, `npm run worker:dev`, `npm run worker:once`.
- Launcher: `SMEDC_BASE_URL=https://api.smedatacenter.xyz npm run mcp:launcher`.
- Local services: `docker compose up -d mysql qdrant`; stop: `docker compose down`; purge uploads/data: `npm run purge-data`.
- Other scripts, including retrieval evaluations and the Calamine reader, are documented in `package.json`.

## Script contracts

- Deployment, host provisioning and remote cleanup read `deploy/AGENTS.md` even when only a script is edited or run.
- Keep fixture generation synthetic and commands explicit about targets. Reuse existing harnesses and adjacent script tests.
- `quality-gate-scope.sh` fails closed for unknown changes/revisions. Documentation-only PRs may skip runtime jobs; test/Skill-only PRs retain unit and integration checks but may skip image builds. Main/manual runs retain the full release gate.
