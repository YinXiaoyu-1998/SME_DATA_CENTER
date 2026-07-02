# Enterprise Hub

Enterprise Hub is a company knowledge service for employee-owned agents, CLIs, MCP clients, APIs, and a minimal admin surface. It stores document catalog metadata, original files, local processing state, label-based permissions, audit logs, and Skill Directory metadata.

Enterprise Hub is not an employee-facing AI agent, report generator, dashboard service, or skill execution platform. Authorization and permission filtering belong on the backend for every non-health endpoint.

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
```

Do not commit `.env`, `.data/`, session files, real credentials, real customer data, or downloaded third-party exports.

## Start Locally

Start MySQL:

```sh
MYSQL_PORT=3307 npm run db:compose:up
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

The API entrypoint automatically loads `.env` from the current working directory when it exists, without overriding environment variables already provided by the shell.

Start the MCP server after the API is running:

```sh
ENTERPRISE_HUB_API_URL=http://127.0.0.1:3000 npm run mcp:dev
```

Run one worker pass after uploading documents:

```sh
set -a
source .env
set +a
npm run worker:once
```

## npm Scripts

| Script             | What It Does                                                              | How To Run                                                                                                              | Notes                                                              |
| ------------------ | ------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| `format`           | Formats the repository with Prettier.                                     | `npm run format`                                                                                                        | Writes changes to files.                                           |
| `format:check`     | Checks Prettier formatting without writing files.                         | `npm run format:check`                                                                                                  | Useful before commits and PRs.                                     |
| `lint`             | Runs ESLint across the repository.                                        | `npm run lint`                                                                                                          | Static code-quality check.                                         |
| `test`             | Runs the Vitest unit/integration-style test suite configured in the repo. | `npm test`                                                                                                              | Same as `npm run test`.                                            |
| `test:integration` | Runs the local MVP integration flow.                                      | `MYSQL_PORT=3307 npm run test:integration`                                                                              | Resets the local development database.                             |
| `test:mcp`         | Runs the local MCP smoke test.                                            | `MYSQL_PORT=3307 npm run test:mcp`                                                                                      | Starts local test services and resets local test data.             |
| `test:watch`       | Runs Vitest in watch mode.                                                | `npm run test:watch`                                                                                                    | Useful while editing tests.                                        |
| `typecheck`        | Runs TypeScript without emitting compiled files.                          | `npm run typecheck`                                                                                                     | Verifies TS types across the repo.                                 |
| `api:dev`          | Starts the Fastify API service.                                           | `npm run api:dev`                                                                                                       | Auto-loads `.env` when present.                                    |
| `hub`              | Runs the Enterprise Hub CLI.                                              | `npm run hub -- <command>`                                                                                              | Example: `npm run hub -- login --email baoli.manager@example.com`. |
| `mcp:dev`          | Starts the local stdio MCP server.                                        | `ENTERPRISE_HUB_API_URL=http://127.0.0.1:3000 npm run mcp:dev`                                                          | Requires the API to already be running.                            |
| `worker:once`      | Runs one deterministic worker pass.                                       | `npm run worker:once`                                                                                                   | Load env first with `set -a; source .env; set +a` if needed.       |
| `db:compose:up`    | Starts the local MySQL Docker Compose service.                            | `MYSQL_PORT=3307 npm run db:compose:up`                                                                                 | Uses `docker compose up -d mysql`.                                 |
| `db:compose:down`  | Stops local Docker Compose services.                                      | `npm run db:compose:down`                                                                                               | Uses `docker compose down`.                                        |
| `db:generate`      | Generates the Prisma client.                                              | `DATABASE_URL='mysql://enterprise_hub:enterprise_hub_local_password@localhost:3307/enterprise_hub' npm run db:generate` | Run after dependency/schema changes when needed.                   |
| `db:migrate`       | Applies Prisma migrations in development.                                 | `DATABASE_URL='mysql://enterprise_hub:enterprise_hub_local_password@localhost:3307/enterprise_hub' npm run db:migrate`  | Updates the local development database.                            |
| `db:seed`          | Seeds local development data.                                             | `DATABASE_URL='mysql://enterprise_hub:enterprise_hub_local_password@localhost:3307/enterprise_hub' npm run db:seed`     | Creates local demo employees, labels, and skills.                  |

## Useful Checks

```sh
npm test
npm run typecheck
npm run lint
npm run format:check
```
