# 企业资料中枢 Environment Inventory

This file tracks required variables and external services. Do not store secret values here.

## Local Development

| Variable                   |                        Required | Example / Default                                                                    |     Secret? | Used By                | Notes                                                                                                                                |
| -------------------------- | ------------------------------: | ------------------------------------------------------------------------------------ | ----------: | ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `DATABASE_URL`             |                             Yes | `mysql://enterprise_hub:enterprise_hub_local_password@localhost:3306/enterprise_hub` |         Yes | API, worker, Prisma    | Local-only example is in `.env.example`; replace for personal environments.                                                          |
| `STORAGE_DRIVER`           |                             Yes | `local` or `oss`                                                                     |          No | API, worker, readiness | Selects the filesystem or Alibaba OSS/S3-compatible adapter at process startup; unsupported values fail fast.                        |
| `LOCAL_STORAGE_ROOT`       | Yes when `STORAGE_DRIVER=local` | `./.data/storage`                                                                    |          No | Storage package        | Local adapter root for original file objects; `.data/` is ignored by git.                                                            |
| `JWT_SECRET`               |                             Yes | `replace-with-local-development-secret`                                              |         Yes | API auth module        | Development value only; production must come from a secret store.                                                                    |
| `DEV_SEED_ADMIN_EMAIL`     |                             Yes | `admin@example.com`                                                                  |          No | Future seed script     | Used for local seed data in later phases.                                                                                            |
| `HUB_INTEGRATION_PORT`     |                              No | auto-assigned                                                                        |          No | Integration test       | Optional API port override for `npm run test:integration`.                                                                           |
| `HUB_MCP_TEST_PORT`        |                              No | auto-assigned                                                                        |          No | MCP smoke test         | Optional API port override for HTTP `/mcp` smoke.                                                                                    |
| `ENTERPRISE_HUB_BASE_URL`  |      Yes for local MCP launcher | `http://127.0.0.1:3000`                                                              |          No | MCP launcher           | URL only. Launcher does not start the service and supports no token environment variable.                                            |
| `MANUAL_TEST_DATABASE_URL` |                              No | local `enterprise_hub` on `127.0.0.1:3307`                                           | Yes locally | manual-test controller | Optional override; the harness refuses remote hosts and other database names and never writes this value to the public run manifest. |
| `MANUAL_TEST_API_URL`      |                              No | `http://127.0.0.1:3000`                                                              |          No | manual-test controller | Optional loopback-only API override for a manual run.                                                                                |
| `MANUAL_TEST_QDRANT_URL`   |                              No | `http://127.0.0.1:6333`                                                              |          No | manual-test controller | Optional loopback-only Qdrant override; each run uses a dedicated `enterprise_hub_evidence_manual_*` collection.                     |
| `PORT`                     |                              No | `3000`                                                                               |          No | API server             | Optional local HTTP port override.                                                                                                   |
| `HOST`                     |                              No | `127.0.0.1`                                                                          |          No | API server             | Phase 3 accepts loopback bind hosts only because `/mcp` is local-only.                                                               |

## Local Docker Compose

| Variable              | Required | Default                              | Secret? | Used By              | Notes                                                          |
| --------------------- | -------: | ------------------------------------ | ------: | -------------------- | -------------------------------------------------------------- |
| `MYSQL_DATABASE`      |       No | `enterprise_hub`                     |      No | `docker-compose.yml` | Local container database name.                                 |
| `MYSQL_USER`          |       No | `enterprise_hub`                     |      No | `docker-compose.yml` | Local container user.                                          |
| `MYSQL_PASSWORD`      |       No | `enterprise_hub_local_password`      |     Yes | `docker-compose.yml` | Development-only default, not suitable outside local machines. |
| `MYSQL_ROOT_PASSWORD` |       No | `enterprise_hub_local_root_password` |     Yes | `docker-compose.yml` | Development-only default, not suitable outside local machines. |
| `MYSQL_PORT`          |       No | `3306`                               |      No | `docker-compose.yml` | Override if port 3306 is busy locally.                         |
| `QDRANT_HTTP_PORT`    |       No | `6333`                               |      No | `docker-compose.yml` | Local Qdrant HTTP API host port.                               |
| `QDRANT_GRPC_PORT`    |       No | `6334`                               |      No | `docker-compose.yml` | Local Qdrant gRPC host port.                                   |

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

Local Compose pins `qdrant/qdrant:v1.15.4` and stores data in the local `qdrant_data` volume. Later Phase 4 staging/prod work should self-host Qdrant OSS on approved infrastructure unless a compliant managed Qdrant option is explicitly validated. For Alibaba Cloud deployment, mirror the pinned Qdrant image into an approved account-owned ACR or internal artifact registry before relying on it in staging/prod; do not deploy with `latest` or depend on ad-hoc public image pulls.

### Model Provider For Embedding And Rerank

Phase 3 baseline uses the existing `.env` names as the supported control surface. These configure retrieval infrastructure only; they do not enable answer generation inside Enterprise Hub.

| Variable                             |                                                                          Required | Example / Default                                                                    |                      Secret? | Used By                | Notes                                                                                                                      |
| ------------------------------------ | --------------------------------------------------------------------------------: | ------------------------------------------------------------------------------------ | ---------------------------: | ---------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `LLM_PROVIDER`                       |                                               Yes for real embedding / fake in CI | `openai-compatible` or `fake`                                                        |                           No | API, worker, tests     | Provider family for embedding adapters. Keep `openai-compatible` for DashScope compatible embeddings.                      |
| `LLM_MODEL`                          |                                                   Yes when real rerank is enabled | provider-specific rerank model, for example `qwen3-rerank`                           |                           No | API, worker            | Rerank model name. For DashScope rerank use a DashScope rerank model, not a chat model.                                    |
| `LLM_EMBEDDING_MODEL`                |                                                            Yes for real embedding | provider-specific embedding model, for example `text-embedding-v4`                   |                           No | API, worker            | Embedding model name recorded in retrieval config and chunk metadata.                                                      |
| `LLM_EMBEDDING_DIMENSION`            |                                  Yes when selected embedding differs from default | `1024` for DashScope `text-embedding-v4`; default fake `8`, openai-compatible `1536` |                           No | API, worker, readiness | Dense vector dimension used by provider validation and Qdrant collection readiness.                                        |
| `RERANK_PROVIDER`                    |                          No locally / Yes when rerank differs from `LLM_PROVIDER` | `dashscope`, `openai-compatible`, or `fake`                                          |                           No | API, worker, readiness | Allows OpenAI-compatible embeddings with DashScope-native rerank.                                                          |
| `OPENAI_COMPATIBLE_API_KEY`          |                                                            Yes for real embedding | runtime secret only                                                                  |                          Yes | API, worker            | Never print, commit, or return through API/MCP. Can also be reused for DashScope rerank when `DASHSCOPE_API_KEY` is unset. |
| `OPENAI_COMPATIBLE_BASE_URL`         |                                                            Yes for real embedding | provider base URL                                                                    | No unless credential-bearing | API, worker            | Do not include credentials in URL.                                                                                         |
| `DASHSCOPE_API_KEY`                  | No if reusing `OPENAI_COMPATIBLE_API_KEY` / Yes for separate DashScope credential | runtime secret only                                                                  |                          Yes | API, worker            | Optional separate API key for DashScope-native rerank. Never print or commit.                                              |
| `DASHSCOPE_API_BASE_URL`             |                                                          Yes for DashScope rerank | `https://dashscope.aliyuncs.com/api/v1`                                              |                           No | API, worker            | Base URL for DashScope-native rerank endpoint.                                                                             |
| `EXTERNAL_MODEL_EGRESS_ACKNOWLEDGED` |                                                    Yes when real provider enabled | `false` locally, `true` when approved                                                |                           No | API, worker, readiness | Real embedding/rerank calls must fail readiness/startup unless acknowledged.                                               |

Optional clearer aliases may be added later (`EMBEDDING_*`, `RERANK_*`), but Phase 3 must continue to support the existing names above.

Task 3 implements the env-backed provider factory with `LLM_PROVIDER=fake` as the local/CI default and `LLM_PROVIDER=openai-compatible` as the real external embedding path. DashScope-native rerank is selected independently with `RERANK_PROVIDER=dashscope`; it calls `/services/rerank/text-rerank/text-rerank` under `DASHSCOPE_API_BASE_URL`. The 2026-07-17 local smoke used synthetic text to verify `text-embedding-v4` returns 1024-dimensional embeddings through the compatible embeddings endpoint and `qwen3-rerank` returns `output.results[].index/relevance_score` through the DashScope-native rerank endpoint. Real embedding and rerank adapter calls require `EXTERNAL_MODEL_EGRESS_ACKNOWLEDGED=true`; otherwise the provider call is blocked before any injected or global fetch executes. Unit tests use injected fetch and never call external networks.

### Runtime Limits

| Variable                                   | Required | Example / Default | Secret? | Used By    | Notes                                                                  |
| ------------------------------------------ | -------: | ----------------- | ------: | ---------- | ---------------------------------------------------------------------- |
| `MAX_UPLOAD_BYTES`                         |       No | `52428800`        |      No | API        | Multipart and MCP decoded-upload file-size guard (50 MiB).             |
| `MAX_STRUCTURED_IMPORT_ROWS`               |       No | `100000`          |      No | API        | Enforced structured ingestion row limit before storage/DB publication. |
| `MAX_XLSX_SHEETS`                          |       No | `20`              |      No | API        | Enforced XLSX sheet-count limit during ZIP/workbook preflight.         |
| `MAX_STRUCTURED_CELL_CHARS`                |       No | `32767`           |      No | API        | Enforced structured scalar/cell character limit during ingestion.      |
| `MAX_XLSX_UNCOMPRESSED_BYTES`              |       No | `209715200`       |      No | API        | Enforced XLSX total uncompressed-size limit during ZIP preflight.      |
| `MAX_XLSX_ZIP_ENTRIES`                     |       No | `10000`           |      No | API        | Enforced XLSX ZIP central-directory entry-count limit.                 |
| `MAX_XLSX_COMPRESSION_RATIO`               |       No | `100`             |      No | API        | Enforced XLSX per-entry compression-ratio limit.                       |
| `STRUCTURED_IMPORT_BATCH_INSERT_SIZE`      |       No | `500`             |      No | API        | Atomic structured row insert batch size.                               |
| `STRUCTURED_IMPORT_TRANSACTION_TIMEOUT_MS` |       No | `120000`          |      No | API        | Prisma transaction timeout for atomic XLSX/CSV imports.                |
| `MCP_MAX_CONCURRENT_REQUESTS`              |       No | `8`               |      No | API `/mcp` | Bounded concurrent Streamable HTTP MCP requests.                       |
| `MAX_DOCUMENT_CHARS`                       |       No | `5000000`         |      No | worker     | Enforced evidence parser character limit before index publication.     |
| `MAX_CHUNKS_PER_DOCUMENT`                  |       No | `5000`            |      No | worker     | Enforced evidence chunk-count limit before index publication.          |
| `WORKER_CONCURRENCY`                       |       No | `2`               |      No | worker     | Enforced bounded worker pool size for the dev loop.                    |
| `WORKER_LEASE_SECONDS`                     |       No | `120`             |      No | worker     | Enforced database lease duration for claim/heartbeat/complete/fail.    |
| `WORKER_POLL_INTERVAL_MS`                  |       No | `1000`            |      No | worker     | Poll interval (minimum `100` ms).                                      |
| `WORKER_MAX_ATTEMPTS`                      |       No | `3`               |      No | worker     | Enforced transient retry cap.                                          |
| `WORKER_RETRY_BASE_MS`                     |       No | `1000`            |      No | worker     | Enforced exponential retry base delay; cannot exceed retry maximum.    |
| `WORKER_RETRY_MAX_MS`                      |       No | `60000`           |      No | worker     | Enforced exponential retry maximum delay.                              |

Field registry and retrieval config details are versioned config/DB seed data, not env secrets.

## Human-Provided Inputs

No human-provided external service, API key, domain, OSS bucket, online MySQL, or deployment credential is required for Phase 1 or Phase 2 local MCP work.

Staging online-readiness inputs are tracked in `docs/implementation/staging-readiness.md`.

Use that readiness document to record non-secret values, secret handling locations, validation status, blocker state, and per-track gates. Do not store secret values in this inventory or in the readiness document.

## Staging OSS / S3-Compatible Readiness

These variables may be present in a local ignored `.env` or a deployment secret/runtime environment when `STORAGE_DRIVER=oss`. Do not commit real secret values.

| Variable                         | Required For              | Secret? | Safe To Record? | Notes                                                                                             |
| -------------------------------- | ------------------------- | ------: | --------------: | ------------------------------------------------------------------------------------------------- |
| `AWS_REGION`                     | OSS/S3-compatible storage |      No |             Yes | Required when the OSS driver is selected.                                                         |
| `AWS_ENDPOINT`                   | OSS/S3-compatible storage |      No |             Yes | Required S3-compatible endpoint URL without credentials.                                          |
| `AWS_S3_BUCKET`                  | OSS/S3-compatible storage |      No |             Yes | Required original-file bucket.                                                                    |
| `AWS_ACCESS_KEY_ID`              | OSS/S3-compatible storage |     Yes |              No | Required; record only that it exists in secure runtime/local `.env`.                              |
| `AWS_SECRET_ACCESS_KEY`          | OSS/S3-compatible storage |     Yes |              No | Required; never print, commit, or copy into docs or PR descriptions.                              |
| `AWS_SESSION_TOKEN`              | temporary OSS credentials |     Yes |              No | Optional session credential; omit for long-lived RAM access keys.                                 |
| `AWS_S3_PREFIX`                  | OSS object isolation      |      No |             Yes | Optional physical namespace; defaults to `enterprise-hub`. Database keys remain provider-neutral. |
| `AWS_S3_FORCE_PATH_STYLE`        | endpoint compatibility    |      No |             Yes | Optional `true`/`false`; defaults to `false` for OSS virtual-hosted requests.                     |
| `AWS_S3_PRESIGN_EXPIRES_SECONDS` | document download links   |      No |             Yes | Optional positive integer; defaults to 900 seconds.                                               |

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
