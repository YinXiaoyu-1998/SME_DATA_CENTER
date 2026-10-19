# SMEDC

SMEDC is a company knowledge service for employee-owned agents, MCP clients, APIs, and a minimal admin surface. It stores source document catalog metadata, original files, local processing state, current category/scope/clearance authorization, audit logs, structured datasets, and evidence retrieval metadata.

SMEDC is not an employee-facing AI agent, report generator, dashboard service, or skill execution platform. Authorization and permission filtering belong on the backend for every non-health endpoint. The public surface includes evidence retrieval, structured imports and partition downloads, authorized row queries, quarantine certificates, ledger PDF delivery and permission administration.

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
DATABASE_URL="mysql://smedc:smedc_local_password@localhost:3306/smedc"
STORAGE_DRIVER="local"
LOCAL_STORAGE_ROOT="./.data/storage"
CURSOR_SIGNING_SECRET="replace-with-local-development-cursor-secret"
SMEDC_PUBLIC_ORIGIN="https://api.smedatacenter.xyz"
MAX_UPLOAD_BYTES="52428800"
```

Phase 3 retrieval and structured-data work also uses local Qdrant and fake model providers by default:

```dotenv
QDRANT_URL="http://127.0.0.1:6333"
QDRANT_COLLECTION_EVIDENCE="smedc_evidence_local"
RETRIEVAL_CONFIG_VERSION="phase3.retrieval.v1"
LLM_PROVIDER="fake"
LLM_MODEL="fake-rerank"
LLM_EMBEDDING_MODEL="fake-embedding"
STRUCTURED_IMPORT_TRANSACTION_TIMEOUT_MS="120000"
```

Do not commit `.env`, `.data/`, session files, real credentials, real customer data, or downloaded third-party exports.

Authentication uses the same official opaque-token model in every environment. Seeded local identities
have no password; tests create short official sessions through an internal fixture factory. There is no
development email-login or JWT compatibility endpoint.

## Original File Storage

`STORAGE_DRIVER` selects the original-file backend at API and worker startup:

- `local` keeps the existing filesystem adapter and requires `LOCAL_STORAGE_ROOT`.
- `oss` uses Alibaba Cloud OSS through the S3-compatible API and requires `AWS_REGION`, `AWS_ENDPOINT`, `AWS_S3_BUCKET`, `AWS_ACCESS_KEY_ID`, and `AWS_SECRET_ACCESS_KEY`.

The OSS adapter keeps database keys provider-neutral (`org/...`) and maps them to the physical `AWS_S3_PREFIX` namespace, which defaults to `smedc`. `AWS_SESSION_TOKEN`, `AWS_S3_FORCE_PATH_STYLE`, and `AWS_S3_PRESIGN_EXPIRES_SECONDS` are optional. Existing local files are not migrated automatically when the driver changes; switch back to `local` to read them or migrate them explicitly before relying on OSS-only reads.

With the local driver, uploaded files are stored under `LOCAL_STORAGE_ROOT`. The default local path is:

```text
.data/storage/org/<org_id>/documents/<document_id>/original/<filename>
```

Integration and MCP smoke tests use their own ignored storage roots under `.data/integration/storage` and `.data/mcp-local-test/storage`.

To run the credential-gated OSS lifecycle test after configuring an ignored `.env`:

```sh
set -a; source .env; set +a
npm run test:storage:oss
```

The test writes one random object under the configured SMEDC prefix, verifies metadata/read/presigned download, deletes it, and confirms absence. It never prints credentials or the signed URL.

To remove local uploaded files, test storage, and local MySQL document records:

```sh
npm run purge-data
```

To preview the cleanup:

```sh
npm run purge-data -- --dry-run
```

The default command also deletes MySQL document data from the local `smedc`
database, including document rows and derived processing/chunk rows through
database cascades, plus document audit logs. It preserves seeded organizations,
employees, Skill Directory rows, and local login sessions.

`npm run purge-data` only removes local filesystem objects. It does not delete OSS objects or migrate source files between drivers.

To remove the entire ignored `.data` directory, including local CLI/MCP session files:

```sh
npm run purge-data -- --all
```

To remove files only and leave MySQL untouched:

```sh
npm run purge-data -- --files-only
```

For safety, MySQL cleanup only runs when `DATABASE_URL` points at local
`localhost`/`127.0.0.1` MySQL and the database name is `smedc`.

## Start Locally

Start MySQL and Qdrant for the full Phase 3 local runtime:

```sh
MYSQL_PORT=3307 npm run runtime:compose:up
```

Generate the Prisma client, apply migrations, and seed local data:

```sh
DATABASE_URL='mysql://smedc:smedc_local_password@localhost:3307/smedc' npm run db:generate
DATABASE_URL='mysql://smedc:smedc_local_password@localhost:3307/smedc' npm run db:migrate
DATABASE_URL='mysql://smedc:smedc_local_password@localhost:3307/smedc' npm run db:seed
```

Start the API:

```sh
npm run api:dev
```

Initialize the local evidence collection and run readiness checks:

```sh
npm run qdrant:init
DATABASE_URL='mysql://smedc:smedc_local_password@localhost:3307/smedc' \
  STORAGE_DRIVER=local \
  LOCAL_STORAGE_ROOT=./.data/storage \
  npm run readyz:local
```

The API entrypoint automatically loads `.env` from the current working directory when it exists, without overriding environment variables already provided by the shell.

## Official Employee MCP

The official employee path is remote `https://api.smedatacenter.xyz` through the pinned
`smedc-mcp-launcher@0.12.0` local stdio launcher. The dual-homed
`skills/smedc-mcp/` skill is the authoritative current-user install, configuration,
browser-login, recovery, logout, and uninstall runbook. It prohibits agent-visible
email/password/token/code input, uses `smedc_login`, `smedc_logout`,
`smedc_auth_status`, and the self-scoped `smedc_get_current_user`, and never
operates service infrastructure.

The official identity, launcher, and public MCP code are implemented.
`smedc-mcp-launcher@0.12.0` is published on npm and its registry integrity, clean install,
CLI, packaging, and production dependency audit have been verified. The supported installation
matrix is macOS, Windows, and Linux. macOS/Windows use their native secure stores; Linux uses a
compatible Secret Service when available and otherwise keeps the session in launcher-process
memory, so headless Linux requires a fresh tap-link login after restart. Client/business acceptance and target service rollout remain separate from npm package verification. The service source recommends and requires at least launcher 0.12.0 for OAuth issuance and refresh.
The verified live deployment recommends 0.12.0 with minimum 0.6.0; the source minimum increase
awaits merge and deployment. Below-minimum launchers receive `LAUNCHER_UPGRADE_REQUIRED`.
Launcher 0.12.0 allows 45 seconds for business MCP calls; connection and profile checks retain
30 seconds. It supports store-filtered coverage/range downloads and optional prepare/status/requestId
ZIP downloads, plus cost-card directory lookup, per-card CSV downloads and single-card archive.
It also exposes atomic store-review upserts, authorized queries, operation-specific enterprise
candidates and platform reply-status fields (`replyStatus` / `replyStatuses`); see [store reviews](skills/smedc-mcp/references/store-reviews.md).
Cost-card recipe/item/store analysis remains local to the employee agent. Transfer requests and stalls have 30-second bounds, and downloads have a
240-second invocation budget. Use the coordinated service deployment and verified exact pin.
Multipart uploads count progress only when the HTTPS transport consumes bytes, preventing
source files from draining before a new connection is ready.

Only active admins upload evidence, structured datasets (including Delivery Ledger), and quarantine
certificates. Employee uploads at every clearance receive HTTP `403` from direct HTTP endpoints;
MCP JSON-RPC transport returns HTTP `200` with `isError: true` in the tool result. Both carry
`UPLOAD_ADMIN_REQUIRED`, `File upload requires the admin role.`, and `retryable: false`.
Tools stay visible; launcher 0.12.0 preflights the role
before reading a file, while the backend remains authoritative for accepted requests. Current category/scope grants and sufficient clearance jointly govern ordinary reads. See the [upload endpoint and audit contract](docs/implementation/api-contract.md#file-upload-capability).
Launcher 0.12.0 exposes the four ledger PDF download tools and no employee PDF generation tool.
Archive delivery is gated by the service rollout; until enabled, report `LEDGER_PDF_NOT_ENABLED`.
The service automatically updates affected daily PDFs; uploads reaching `applied`
do not mean PDF completion. Current release/deployment evidence is maintained in [staging readiness](docs/implementation/staging-readiness.md); tenant activation is separate.

## Official MCP Launcher

The API exposes authenticated Streamable HTTP at `POST /mcp`; it does not start a service-side stdio
adapter. The launcher accepts only a canonical HTTPS origin:

```json
{
  "command": "npm",
  "args": ["run", "--silent", "mcp:launcher"],
  "cwd": "/Users/xiaoyuyin/Desktop/YXY_DEV/SME_DATA_CENTER",
  "env": { "SMEDC_BASE_URL": "https://api.smedatacenter.xyz" }
}
```

The launcher does not start or repair the API, worker, database, Qdrant, or storage. It opens the
browser for official login and stores only the rotating durable credential in the operating-system
secure store; access tokens stay in memory. Local API/worker development is exercised through the
repository's unit and integration harnesses, which create official short-lived sessions internally
and do not weaken the launcher's HTTPS requirement.

MCP callers never provide an organization ID; the service derives organization scope from the logged-in employee. Evidence search cursors are opaque, short-lived continuation tokens: pass `page.nextCursor` back unchanged with the same query/filter/limit to fetch the next page. Restart without a cursor on `INVALID_CURSOR`; on `CURSOR_EXPIRED`, explain the expiry and restart only if the user still wants more results. Structured import retries should reuse an `idempotencyKey` only for the exact same file and metadata; exact replay returns the original persisted IDs/storage key, while inaccessible import status returns the same non-enumerating 404 as a missing batch. For structured tables, discover `canonicalName` fields before querying and use `describe_structured_dataset_coverage` only to inspect readable applied source windows or snapshots; the client decides whether that coverage is enough for the user's question.

`business` and `dishes` are not MySQL row-query datasets. The official launcher streams one
original CSV/XLSX (up to the configured 2 GiB source limit) through multipart upload, the worker
atomically publishes canonical store-day CSV partitions to OSS, and MySQL stores only current
partition metadata. Clients poll `get_partition_import_status`, inspect coverage, and use
`download_structured_partitions` for authorized local analysis; presigned URLs stay inside the
launcher and callers must clean the returned scratch directory. Generic
`query_structured_dataset` intentionally rejects these two datasets.

## Dish catalog snapshots

`dish_catalog` is a complete, append-only menu snapshot, not a business-date-window import. Upload
it with `snapshotDate` (`YYYYMMDD`) and without `startDate` or `endDate`; the service internally
uses the same date for both. The organization has one date-ordered timeline: historical snapshots
may be uploaded out of order, but only one non-archived snapshot may occupy a date. Archive an
incorrect same-date snapshot before uploading a corrected one. New snapshots do not auto-archive
older ones.

Both CSV and XLSX use exactly these ten controlled headers, in any column order:
`菜品编码（SPUID）`, `菜品编码（SKUID）`, `菜品名称`, `品牌`, `基础分类`, `一级分类编码`,
`二级分类编码`, `规格名称`, `售卖价`, and `菜品别名`. The latter three nullable fields are
`二级分类编码`, `规格名称`, and `菜品别名`; the other seven are required. Sale price is decimal and
may be zero. A complete snapshot must contain unique SKUID values; SPUID can repeat for different
specifications.

For XLSX, all visible sheets with the exact schema are merged; sheet names are irrelevant.
Nonmatching sheets (including a headquarters-combo sheet) are ignored with a safe summary, while a
matching hidden sheet rejects the import. Query catalog history through `snapshot_date` returned by
dataset discovery. The service does not choose a current/latest menu, calculate diffs, or infer
added, removed, discontinued, or other cross-snapshot state.

To run the launcher manually when the API is already running:

```sh
SMEDC_BASE_URL=https://api.smedatacenter.xyz npm run mcp:launcher
```

Run the worker directly only when testing or troubleshooting:

```sh
npm run worker:dev
```

Run one deterministic worker pass for CI-style checks or manual debugging:

```sh
npm run worker:once
```

The former local user-visible suite is withdrawn because it depended on the removed development
email login and an HTTP launcher origin. Official acceptance now uses the published launcher,
browser login, and staging service. The primary desktop flow remains macOS/Windows; Linux has
separate installed-package/no-display and headless Device Authorization coverage. See
`docs/implementation/official-user-install-and-login.md` and `docs/implementation/test-cases.md`.

## npm Scripts

| Script                 | What It Does                                                              | How To Run                                                                                                                  | Notes                                                             |
| ---------------------- | ------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| `format`               | Formats the repository with Prettier.                                     | `npm run format`                                                                                                            | Writes changes to files.                                          |
| `format:check`         | Checks Prettier formatting without writing files.                         | `npm run format:check`                                                                                                      | Useful before commits and PRs.                                    |
| `lint`                 | Runs ESLint across the repository.                                        | `npm run lint`                                                                                                              | Static code-quality check.                                        |
| `test`                 | Runs the Vitest unit/integration-style test suite configured in the repo. | `npm test`                                                                                                                  | Same as `npm run test`.                                           |
| `test:integration`     | Runs the local Phase 3 API/worker integration flow.                       | `MYSQL_PORT=3307 npm run test:integration`                                                                                  | Resets the local development database.                            |
| `test:storage:oss`     | Runs the gated live Alibaba OSS object lifecycle.                         | Load ignored `.env`, then run `npm run test:storage:oss`                                                                    | Creates and deletes one isolated random object.                   |
| `test:mcp`             | Runs HTTP `/mcp` plus launcher smoke checks.                              | `npm run test:mcp`                                                                                                          | Does not start service dependencies.                              |
| `test:phase3:golden`   | Runs the synthetic Phase 3 golden retrieval evaluation.                   | `npm run test:phase3:golden`                                                                                                | Uses deterministic fake providers and synthetic evidence.         |
| `test:phase3:perf`     | Runs deterministic Phase 3 performance smoke gates.                       | `npm run test:phase3:perf`                                                                                                  | Measures real local compiler, CSV parser, and payload workloads.  |
| `test:manual:prepare`  | Recreates the local-only manual acceptance runtime.                       | `npm run test:manual:prepare`; add `-- --profile=real` for acknowledged real providers                                      | Deletes this repository's local Compose volumes.                  |
| `test:manual:serve`    | Starts and holds the manual-test API and worker.                          | `npm run test:manual:serve`                                                                                                 | Keep the terminal alive during client tasks.                      |
| `test:manual:snapshot` | Writes a local operator state snapshot.                                   | `npm run test:manual:snapshot`                                                                                              | Never run from an employee-client task.                           |
| `test:manual:cleanup`  | Writes the final snapshot and stops Compose dependencies.                 | `npm run test:manual:cleanup`                                                                                               | Preserves ignored run reports and logs.                           |
| `test:watch`           | Runs Vitest in watch mode.                                                | `npm run test:watch`                                                                                                        | Useful while editing tests.                                       |
| `typecheck`            | Runs TypeScript without emitting compiled files.                          | `npm run typecheck`                                                                                                         | Verifies TS types across the repo.                                |
| `api:dev`              | Starts the Fastify API service.                                           | `npm run api:dev`                                                                                                           | Auto-loads `.env` when present.                                   |
| `mcp:launcher`         | Starts the user-side stdio launcher for the official HTTPS MCP endpoint.  | `SMEDC_BASE_URL=https://api.smedatacenter.xyz npm run mcp:launcher`                                                         | Requires an already-running service; never starts it.             |
| `purge-data`           | Removes local MySQL document data plus ignored upload/test storage files. | `npm run purge-data`; preview with `npm run purge-data -- --dry-run`; remove all `.data` with `npm run purge-data -- --all` | Use `--files-only` to leave MySQL untouched.                      |
| `worker:dev`           | Starts a local worker loop that continuously processes queued documents.  | `npm run worker:dev`                                                                                                        | Auto-loads `.env` when present.                                   |
| `worker:once`          | Runs one deterministic worker pass.                                       | `npm run worker:once`                                                                                                       | Auto-loads `.env` when present.                                   |
| `db:compose:up`        | Starts the local MySQL Docker Compose service.                            | `MYSQL_PORT=3307 npm run db:compose:up`                                                                                     | Uses `docker compose up -d mysql`.                                |
| `runtime:compose:up`   | Starts local MySQL and Qdrant Docker Compose services.                    | `MYSQL_PORT=3307 npm run runtime:compose:up`                                                                                | Uses `docker compose up -d mysql qdrant`.                         |
| `qdrant:init`          | Creates/updates the local Phase 3 evidence collection.                    | `npm run qdrant:init`                                                                                                       | Requires Qdrant to be running.                                    |
| `readyz:local`         | Runs local runtime readiness checks.                                      | `DATABASE_URL='mysql://smedc:smedc_local_password@localhost:3307/smedc' npm run readyz:local`                               | Checks MySQL, storage, model config, and Qdrant.                  |
| `db:compose:down`      | Stops local Docker Compose services.                                      | `npm run db:compose:down`                                                                                                   | Uses `docker compose down`.                                       |
| `db:generate`          | Generates the Prisma client.                                              | `DATABASE_URL='mysql://smedc:smedc_local_password@localhost:3307/smedc' npm run db:generate`                                | Run after dependency/schema changes when needed.                  |
| `db:migrate`           | Applies Prisma migrations in development.                                 | `DATABASE_URL='mysql://smedc:smedc_local_password@localhost:3307/smedc' npm run db:migrate`                                 | Updates the local development database.                           |
| `db:seed`              | Seeds local development data.                                             | `DATABASE_URL='mysql://smedc:smedc_local_password@localhost:3307/smedc' npm run db:seed`                                    | Creates local demo employees, confidentiality levels, and skills. |

## Useful Checks

```sh
npm test
npm run typecheck
npm run lint
npm run format:check
```

## Further Documentation

Start with the [current documentation index](docs/README.md); it separates current contracts from historical records.

- `AGENTS.md`: repository rules and common commands.
- [Enterprise onboarding](docs/implementation/tenant-onboarding.md): current administrator UI entry, default-Chinese i18n, account setup and controlled activation; JSON is internal only.
- [Permissions UI design](docs/implementation/admin-permissions-ui-design.md): enterprise-bound entry and shared browser sign-in; implemented in the current service; verify the target URL before handoff.
- `docs/implementation/env-inventory.md`: environment and secret inventory.
- `docs/implementation/server-runtime-prerequisites.md`: Phase 4 staging host provisioning, verification, ACR boundary, and rollback.
- `docs/implementation/api-contract.md`: API and MCP tool contracts.
- `docs/implementation/local-agent-test.md`: Codex/MCP human-test flow.
- `skills/smedc-mcp/SKILL.md`: repository-local MCP skill.
