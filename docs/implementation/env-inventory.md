# 企业资料中枢 Environment Inventory

This file tracks required variables and external services. Do not store secret values here.

## Local Development

| Variable                          |                        Required | Example / Default                                                                    | Secret? | Used By             | Notes                                                                                                                                  |
| --------------------------------- | ------------------------------: | ------------------------------------------------------------------------------------ | ------: | ------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `DATABASE_URL`                    |                             Yes | `mysql://enterprise_hub:enterprise_hub_local_password@localhost:3306/enterprise_hub` |     Yes | API, worker, Prisma | Local-only example is in `.env.example`; replace for personal environments.                                                            |
| `STORAGE_DRIVER`                  |                             Yes | `local`                                                                              |      No | Storage package     | Phase 1 implements the local filesystem adapter only.                                                                                  |
| `LOCAL_STORAGE_ROOT`              | Yes when `STORAGE_DRIVER=local` | `./.data/storage`                                                                    |      No | Storage package     | Local adapter root for original file objects; `.data/` is ignored by git.                                                              |
| `JWT_SECRET`                      |                             Yes | `replace-with-local-development-secret`                                              |     Yes | API auth module     | Development value only; production must come from a secret store.                                                                      |
| `DEV_SEED_ADMIN_EMAIL`            |                             Yes | `admin@example.com`                                                                  |      No | Future seed script  | Used for local seed data in later phases.                                                                                              |
| `HUB_API_URL`                     |                              No | `http://127.0.0.1:3000`                                                              |      No | CLI                 | Optional API base URL override for local CLI smoke commands.                                                                           |
| `HUB_CLI_SESSION_FILE`            |                              No | `.data/hub-cli/session.json`                                                         |      No | CLI                 | Optional local token session file path; the file itself is ignored by git.                                                             |
| `HUB_INTEGRATION_PORT`            |                              No | auto-assigned                                                                        |      No | Integration test    | Optional API port override for `npm run test:integration`.                                                                             |
| `HUB_MCP_TEST_PORT`               |                              No | auto-assigned                                                                        |      No | MCP smoke test      | Optional API port override for `npm run test:mcp`; the script sets `ENTERPRISE_HUB_API_URL` to this local port.                        |
| `ENTERPRISE_HUB_API_URL`          |               Yes for local MCP | `http://127.0.0.1:3000`                                                              |      No | MCP server          | Explicit API base URL for the local MCP adapter. The MCP server does not start the API itself.                                         |
| `ENTERPRISE_HUB_MCP_SESSION_FILE` |                              No | `.data/enterprise-hub-mcp/session.json`                                              |     Yes | MCP server          | Optional local session file path for Phase 2 MCP auth/session work; may contain development bearer tokens; `.data/` is ignored by git. |
| `ENTERPRISE_HUB_MCP_PROFILE`      |                              No | `local-development`                                                                  |      No | MCP server          | Optional profile selector. Phase 2 implements only `local-development`.                                                                |
| `PORT`                            |                              No | `3000`                                                                               |      No | API server          | Optional local HTTP port override.                                                                                                     |
| `HOST`                            |                              No | `0.0.0.0`                                                                            |      No | API server          | Optional local bind host override.                                                                                                     |

## Local Docker Compose

| Variable              | Required | Default                              | Secret? | Used By              | Notes                                                          |
| --------------------- | -------: | ------------------------------------ | ------: | -------------------- | -------------------------------------------------------------- |
| `MYSQL_DATABASE`      |       No | `enterprise_hub`                     |      No | `docker-compose.yml` | Local container database name.                                 |
| `MYSQL_USER`          |       No | `enterprise_hub`                     |      No | `docker-compose.yml` | Local container user.                                          |
| `MYSQL_PASSWORD`      |       No | `enterprise_hub_local_password`      |     Yes | `docker-compose.yml` | Development-only default, not suitable outside local machines. |
| `MYSQL_ROOT_PASSWORD` |       No | `enterprise_hub_local_root_password` |     Yes | `docker-compose.yml` | Development-only default, not suitable outside local machines. |
| `MYSQL_PORT`          |       No | `3306`                               |      No | `docker-compose.yml` | Override if port 3306 is busy locally.                         |

## Phase 3 Retrieval And Structured Data

These variables are required or introduced by the new Phase 3 retrieval/data foundation. Real secret values belong only in ignored `.env`, CI secret stores, or deployment runtime configuration.

### Qdrant

| Variable                     |                    Required | Example / Default               | Secret? | Used By            | Notes                                                                               |
| ---------------------------- | --------------------------: | ------------------------------- | ------: | ------------------ | ----------------------------------------------------------------------------------- |
| `QDRANT_URL`                 |             Yes for Phase 3 | `http://127.0.0.1:6333`         |      No | API, worker, tests | Local Docker Compose should provide real Qdrant.                                    |
| `QDRANT_API_KEY`             | No locally / Yes if secured | empty locally                   |     Yes | API, worker        | Never print; empty is only acceptable for local unsecured Compose.                  |
| `QDRANT_COLLECTION_EVIDENCE` |             Yes for Phase 3 | `enterprise_hub_evidence_local` |      No | API, worker        | Evidence collection for MD/TXT/DOCX chunks.                                         |
| `QDRANT_TIMEOUT_MS`          |                          No | `5000`                          |      No | API, worker        | Client timeout.                                                                     |
| `RETRIEVAL_CONFIG_VERSION`   |             Yes for Phase 3 | `phase3.retrieval.v1`           |      No | API, worker        | Expected active retrieval config version; details live in versioned config/DB seed. |

### Model Provider For Embedding And Rerank

Phase 3 baseline uses the existing `.env` names as the supported control surface. These configure retrieval infrastructure only; they do not enable answer generation inside Enterprise Hub.

| Variable                             |                                 Required | Example / Default                     |                      Secret? | Used By                | Notes                                                                        |
| ------------------------------------ | ---------------------------------------: | ------------------------------------- | ---------------------------: | ---------------------- | ---------------------------------------------------------------------------- |
| `LLM_PROVIDER`                       |       Yes for real provider / fake in CI | `openai-compatible` or `fake`         |                           No | worker, tests          | Provider family for embedding/rerank adapters.                               |
| `LLM_MODEL`                          | Yes for real rerank when adapter uses it | provider-specific rerank model        |                           No | worker                 | Used for rerank or provider-side scoring model where applicable.             |
| `LLM_EMBEDDING_MODEL`                |                   Yes for real embedding | provider-specific embedding model     |                           No | worker                 | Embedding model name recorded in retrieval config and chunk metadata.        |
| `OPENAI_COMPATIBLE_API_KEY`          |                    Yes for real provider | runtime secret only                   |                          Yes | worker                 | Never print, commit, or return through API/MCP.                              |
| `OPENAI_COMPATIBLE_BASE_URL`         |                    Yes for real provider | provider base URL                     | No unless credential-bearing | worker                 | Do not include credentials in URL.                                           |
| `EXTERNAL_MODEL_EGRESS_ACKNOWLEDGED` |           Yes when real provider enabled | `false` locally, `true` when approved |                           No | API, worker, readiness | Real embedding/rerank calls must fail readiness/startup unless acknowledged. |

Optional clearer aliases may be added later (`EMBEDDING_*`, `RERANK_*`), but Phase 3 must continue to support the existing names above.

### Worker, Import, And Query Limits

| Variable                                   | Required | Example / Default      | Secret? | Used By     | Notes                                         |
| ------------------------------------------ | -------: | ---------------------- | ------: | ----------- | --------------------------------------------- |
| `WORKER_CONCURRENCY`                       |       No | `2`                    |      No | worker      | Global worker concurrency.                    |
| `WORKER_LEASE_SECONDS`                     |       No | `120`                  |      No | worker      | DB lease duration for processing runs.        |
| `WORKER_POLL_INTERVAL_MS`                  |       No | `1000`                 |      No | worker      | Poll interval.                                |
| `WORKER_MAX_ATTEMPTS`                      |       No | `3`                    |      No | worker      | Transient retry cap.                          |
| `WORKER_EVIDENCE_INDEX_CONCURRENCY`        |       No | `1`                    |      No | worker      | Evidence indexing concurrency.                |
| `WORKER_STRUCTURED_IMPORT_CONCURRENCY`     |       No | `1`                    |      No | worker      | Structured import concurrency.                |
| `WORKER_QDRANT_UPSERT_CONCURRENCY`         |       No | `2`                    |      No | worker      | Qdrant write concurrency.                     |
| `WORKER_EMBEDDING_CONCURRENCY`             |       No | `2`                    |      No | worker      | External embedding concurrency.               |
| `MAX_UPLOAD_BYTES`                         |       No | implementation default |      No | API         | Upload size guard.                            |
| `MAX_DOCUMENT_CHARS`                       |       No | implementation default |      No | worker      | Evidence parser guard.                        |
| `MAX_CHUNKS_PER_DOCUMENT`                  |       No | implementation default |      No | worker      | Prevent runaway indexing.                     |
| `MAX_STRUCTURED_IMPORT_ROWS`               |       No | implementation default |      No | worker      | Import safety guard.                          |
| `MAX_XLSX_SHEETS`                          |       No | implementation default |      No | worker      | Import safety guard.                          |
| `STRUCTURED_QUERY_DEFAULT_LIMIT`           |       No | `50`                   |      No | API, MCP    | Must match schema discovery effective limits. |
| `STRUCTURED_QUERY_MAX_LIMIT`               |       No | `200`                  |      No | API, MCP    | Detail row max.                               |
| `STRUCTURED_QUERY_MAX_BOOLEAN_DEPTH`       |       No | `3`                    |      No | API         | Query compiler guard.                         |
| `STRUCTURED_QUERY_MAX_CONDITIONS`          |       No | `20`                   |      No | API         | Query compiler guard.                         |
| `STRUCTURED_QUERY_MAX_IN_VALUES`           |       No | `100`                  |      No | API         | Query compiler guard.                         |
| `STRUCTURED_QUERY_MAX_SORT_FIELDS`         |       No | `2`                    |      No | API         | Query compiler guard.                         |
| `STRUCTURED_QUERY_MAX_GROUP_BY_FIELDS`     |       No | `1`                    |      No | API         | Query compiler guard.                         |
| `STRUCTURED_QUERY_MAX_AGGREGATES`          |       No | `5`                    |      No | API         | Query compiler guard.                         |
| `STRUCTURED_QUERY_MAX_SELECTED_FIELDS`     |       No | `50`                   |      No | API         | Query compiler guard.                         |
| `STRUCTURED_QUERY_CURSOR_TTL_SECONDS`      |       No | `900`                  |      No | API         | Opaque cursor expiry.                         |
| `STRUCTURED_IMPORT_BATCH_INSERT_SIZE`      |       No | implementation default |      No | worker      | Batch row insert size.                        |
| `STRUCTURED_IMPORT_VALIDATION_ERROR_LIMIT` |       No | `20`                   |      No | API, worker | Max examples returned to caller.              |

Field registry and retrieval config details are versioned config/DB seed data, not env secrets.

## Human-Provided Inputs

No human-provided external service, API key, domain, OSS bucket, online MySQL, or deployment credential is required for Phase 1 or Phase 2 local MCP work.

Staging online-readiness inputs are tracked in `docs/implementation/staging-readiness.md`.

Use that readiness document to record non-secret values, secret handling locations, validation status, blocker state, and per-track gates. Do not store secret values in this inventory or in the readiness document.

## Staging OSS / S3-Compatible Readiness

These variables may be present in a local ignored `.env` or a future secret/runtime environment when validating OSS/S3-compatible storage. Do not commit real secret values.

| Variable                | Required For              | Secret? | Safe To Record? | Notes                                                                |
| ----------------------- | ------------------------- | ------: | --------------: | -------------------------------------------------------------------- |
| `AWS_REGION`            | OSS/S3-compatible storage |      No |             Yes | Current provided value is tracked in `staging-readiness.md`.         |
| `AWS_ENDPOINT`          | OSS/S3-compatible storage |      No |             Yes | Endpoint URL without credentials is safe to record.                  |
| `AWS_S3_BUCKET`         | OSS/S3-compatible storage |      No |             Yes | Bucket name is tracked as provided but not yet verified.             |
| `AWS_ACCESS_KEY_ID`     | OSS/S3-compatible storage |     Yes |              No | Record only that the variable exists in secure runtime/local `.env`. |
| `AWS_SECRET_ACCESS_KEY` | OSS/S3-compatible storage |     Yes |              No | Never print, commit, or copy into readiness docs or PR descriptions. |

## Staging Container Registry Readiness

These deployment/CI variables are pending an account-owned Alibaba Cloud ACR repository in `cn-beijing`. Store credentials outside git.

| Variable                               | Required For           | Secret? | Safe To Record? | Notes                                                       |
| -------------------------------------- | ---------------------- | ------: | --------------: | ----------------------------------------------------------- |
| `ENTERPRISE_HUB_ACR_REGISTRY`          | Image push/pull        |      No |             Yes | Exact ACR registry hostname; do not include credentials.    |
| `ENTERPRISE_HUB_ACR_NAMESPACE`         | Image naming           |      No |             Yes | Recommended namespace: `enterprise-hub`, if available.      |
| `ENTERPRISE_HUB_ACR_API_REPOSITORY`    | API image naming       |      No |             Yes | Recommended repository: `api`.                              |
| `ENTERPRISE_HUB_ACR_WORKER_REPOSITORY` | Worker image naming    |      No |             Yes | Recommended repository: `worker`.                           |
| `ENTERPRISE_HUB_ACR_USERNAME`          | Registry login         |      No |             Yes | Keep in protected deployment runtime or CI configuration.   |
| `ENTERPRISE_HUB_ACR_PASSWORD`          | Registry login         |     Yes |              No | Use `docker login --password-stdin`; never print or commit. |
| `ENTERPRISE_HUB_IMAGE_TAG`             | Immutable image deploy |      No |             Yes | Use a commit SHA or release version; never deploy `latest`. |
