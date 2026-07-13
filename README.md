# Enterprise Hub

Enterprise Hub is a company knowledge service for employee-owned agents, MCP clients, APIs, and a minimal admin surface. It stores source document catalog metadata, original files, local processing state, label-based permissions, audit logs, structured datasets, and evidence retrieval metadata.

Enterprise Hub is not an employee-facing AI agent, report generator, dashboard service, or skill execution platform. Authorization and permission filtering belong on the backend for every non-health endpoint. The public product surface is Phase 3-only: evidence upload/search and structured import/query.

For the full Chinese local development guide, see [README.zh.md](./README.zh.md).

## Prerequisites

- Node.js and npm.
- Docker Desktop or compatible Docker Compose.
- A local MySQL port. The default is `3306`; use `MYSQL_PORT=3307` if `3306` is already occupied.

## Install

```sh
npm install
```

## Local Environment

Copy the example env file:

```sh
cp .env.example .env
```

At minimum, local development uses:

```dotenv
DATABASE_URL="mysql://enterprise_hub:enterprise_hub_local_password@localhost:3306/enterprise_hub"
STORAGE_DRIVER="local"
LOCAL_STORAGE_ROOT="./.data/storage"
JWT_SECRET="replace-with-local-development-secret"
DEV_SEED_ADMIN_EMAIL="admin@example.com"
MAX_UPLOAD_BYTES="52428800"
```

Phase 3 retrieval and structured-data work also uses local Qdrant and fake model providers by default:

```dotenv
QDRANT_URL="http://127.0.0.1:6333"
QDRANT_COLLECTION_EVIDENCE="enterprise_hub_evidence_local"
RETRIEVAL_CONFIG_VERSION="phase3.retrieval.v1"
LLM_PROVIDER="fake"
LLM_MODEL="fake-rerank"
LLM_EMBEDDING_MODEL="fake-embedding"
STRUCTURED_IMPORT_TRANSACTION_TIMEOUT_MS="120000"
```

Do not commit `.env`, `.data/`, session files, real credentials, real customer data, or downloaded third-party exports.

## Local Uploaded Files

With the local storage driver, uploaded files are stored under `LOCAL_STORAGE_ROOT`. The default local path is:

```text
.data/storage/org/<org_id>/documents/<document_id>/original/<filename>
```

Integration and MCP smoke tests use their own ignored storage roots under `.data/integration/storage` and `.data/mcp-local-test/storage`.

To remove local uploaded files, test storage, and local MySQL document records:

```sh
npm run purge-data
```

To preview the cleanup:

```sh
npm run purge-data -- --dry-run
```

The default command also deletes MySQL document data from the local `enterprise_hub`
database, including document rows and derived processing/chunk/label rows through
database cascades, plus document audit logs. It preserves seeded organizations,
employees, labels, Skill Directory rows, and local login sessions.

To remove the entire ignored `.data` directory, including local CLI/MCP session files:

```sh
npm run purge-data -- --all
```

To remove files only and leave MySQL untouched:

```sh
npm run purge-data -- --files-only
```

For safety, MySQL cleanup only runs when `DATABASE_URL` points at local
`localhost`/`127.0.0.1` MySQL and the database name is `enterprise_hub`.

## Start Locally

Start MySQL and Qdrant for the full Phase 3 local runtime:

```sh
MYSQL_PORT=3307 npm run runtime:compose:up
```

Generate the Prisma client, apply migrations, and seed local data:

```sh
DATABASE_URL='mysql://enterprise_hub:enterprise_hub_local_password@localhost:3307/enterprise_hub' npm run db:generate
DATABASE_URL='mysql://enterprise_hub:enterprise_hub_local_password@localhost:3307/enterprise_hub' npm run db:migrate
DATABASE_URL='mysql://enterprise_hub:enterprise_hub_local_password@localhost:3307/enterprise_hub' npm run db:seed
```

Start the API:

```sh
npm run api:dev
```

Initialize the local evidence collection and run readiness checks:

```sh
npm run qdrant:init
DATABASE_URL='mysql://enterprise_hub:enterprise_hub_local_password@localhost:3307/enterprise_hub' \
  STORAGE_DRIVER=local \
  LOCAL_STORAGE_ROOT=./.data/storage \
  npm run readyz:local
```

The API entrypoint automatically loads `.env` from the current working directory when it exists, without overriding environment variables already provided by the shell.

Start the API, background worker, and MCP server together:

```sh
npm run mcp-bootup
```

`mcp-bootup` loads `.env`, starts the API in the background, waits for `/healthz`, starts a local worker loop, then starts the MCP stdio server in the foreground. The MCP server still calls the API; the worker loop processes queued uploads so local behavior matches the deployed background-worker model.

When configuring Codex or another MCP client, prefer silent npm mode so npm does not write its own banner into the MCP stdio stream:

```json
{
  "command": "npm",
  "args": ["run", "--silent", "mcp-bootup"],
  "cwd": "/Users/xiaoyuyin/Desktop/YXY_DEV/SME_DATA_CENTER"
}
```

To run only the MCP server when the API is already running:

```sh
ENTERPRISE_HUB_API_URL=http://127.0.0.1:3000 npm run mcp:dev
```

Run the worker directly only when testing or troubleshooting outside `mcp-bootup`:

```sh
npm run worker:dev
```

Run one deterministic worker pass for CI-style checks or manual debugging:

```sh
npm run worker:once
```

## npm Scripts

| Script               | What It Does                                                                    | How To Run                                                                                                                  | Notes                                                               |
| -------------------- | ------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| `format`             | Formats the repository with Prettier.                                           | `npm run format`                                                                                                            | Writes changes to files.                                            |
| `format:check`       | Checks Prettier formatting without writing files.                               | `npm run format:check`                                                                                                      | Useful before commits and PRs.                                      |
| `lint`               | Runs ESLint across the repository.                                              | `npm run lint`                                                                                                              | Static code-quality check.                                          |
| `test`               | Runs the Vitest unit/integration-style test suite configured in the repo.       | `npm test`                                                                                                                  | Same as `npm run test`.                                             |
| `test:integration`   | Runs the local Phase 3 API/worker integration flow.                             | `MYSQL_PORT=3307 npm run test:integration`                                                                                  | Resets the local development database.                              |
| `test:mcp`           | Runs the local MCP smoke test, including Phase 3 structured/evidence MCP tools. | `MYSQL_PORT=3307 npm run test:mcp`                                                                                          | Starts local MySQL/Qdrant test services and resets local test data. |
| `test:phase3:golden` | Runs the synthetic Phase 3 golden retrieval evaluation.                         | `npm run test:phase3:golden`                                                                                                | Uses deterministic fake providers and synthetic evidence.           |
| `test:phase3:perf`   | Runs deterministic Phase 3 performance smoke gates.                             | `npm run test:phase3:perf`                                                                                                  | Covers synthetic retrieval/query/import/worker gates.               |
| `test:watch`         | Runs Vitest in watch mode.                                                      | `npm run test:watch`                                                                                                        | Useful while editing tests.                                         |
| `typecheck`          | Runs TypeScript without emitting compiled files.                                | `npm run typecheck`                                                                                                         | Verifies TS types across the repo.                                  |
| `api:dev`            | Starts the Fastify API service.                                                 | `npm run api:dev`                                                                                                           | Auto-loads `.env` when present.                                     |
| `mcp-bootup`         | Starts the API, starts a worker loop, then starts the MCP stdio server.         | `npm run mcp-bootup`                                                                                                        | For MCP client config, prefer `npm run --silent mcp-bootup`.        |
| `mcp:dev`            | Starts the local stdio MCP server.                                              | `ENTERPRISE_HUB_API_URL=http://127.0.0.1:3000 npm run mcp:dev`                                                              | Requires the API to already be running.                             |
| `purge-data`         | Removes local MySQL document data plus ignored upload/test storage files.       | `npm run purge-data`; preview with `npm run purge-data -- --dry-run`; remove all `.data` with `npm run purge-data -- --all` | Use `--files-only` to leave MySQL untouched.                        |
| `worker:dev`         | Starts a local worker loop that continuously processes queued documents.        | `npm run worker:dev`                                                                                                        | Auto-loads `.env` when present.                                     |
| `worker:once`        | Runs one deterministic worker pass.                                             | `npm run worker:once`                                                                                                       | Auto-loads `.env` when present.                                     |
| `db:compose:up`      | Starts the local MySQL Docker Compose service.                                  | `MYSQL_PORT=3307 npm run db:compose:up`                                                                                     | Uses `docker compose up -d mysql`.                                  |
| `runtime:compose:up` | Starts local MySQL and Qdrant Docker Compose services.                          | `MYSQL_PORT=3307 npm run runtime:compose:up`                                                                                | Uses `docker compose up -d mysql qdrant`.                           |
| `qdrant:init`        | Creates/updates the local Phase 3 evidence collection.                          | `npm run qdrant:init`                                                                                                       | Requires Qdrant to be running.                                      |
| `readyz:local`       | Runs local runtime readiness checks.                                            | `DATABASE_URL='mysql://enterprise_hub:enterprise_hub_local_password@localhost:3307/enterprise_hub' npm run readyz:local`    | Checks MySQL, storage, model config, and Qdrant.                    |
| `db:compose:down`    | Stops local Docker Compose services.                                            | `npm run db:compose:down`                                                                                                   | Uses `docker compose down`.                                         |
| `db:generate`        | Generates the Prisma client.                                                    | `DATABASE_URL='mysql://enterprise_hub:enterprise_hub_local_password@localhost:3307/enterprise_hub' npm run db:generate`     | Run after dependency/schema changes when needed.                    |
| `db:migrate`         | Applies Prisma migrations in development.                                       | `DATABASE_URL='mysql://enterprise_hub:enterprise_hub_local_password@localhost:3307/enterprise_hub' npm run db:migrate`      | Updates the local development database.                             |
| `db:seed`            | Seeds local development data.                                                   | `DATABASE_URL='mysql://enterprise_hub:enterprise_hub_local_password@localhost:3307/enterprise_hub' npm run db:seed`         | Creates local demo employees, labels, and skills.                   |

## Useful Checks

```sh
npm test
npm run typecheck
npm run lint
npm run format:check
```

## Further Documentation

- `AGENTS.md`: repository rules and common commands.
- `docs/implementation/env-inventory.md`: environment and secret inventory.
- `docs/implementation/server-runtime-prerequisites.md`: Phase 4 staging host provisioning, verification, ACR boundary, and rollback.
- `docs/implementation/api-contract.md`: API and MCP tool contracts.
- `docs/implementation/local-agent-test.md`: Codex/MCP human-test flow.
- `skills/enterprise-hub-mcp/SKILL.md`: repository-local MCP skill.
