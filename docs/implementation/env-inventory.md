# 企业资料中枢 Environment Inventory

This file tracks required variables and external services. Do not store secret values here.

## Local Development

| Variable                       |                        Required | Example / Default                                                                    |     Secret? | Used By                | Notes                                                                                                                                |
| ------------------------------ | ------------------------------: | ------------------------------------------------------------------------------------ | ----------: | ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `DATABASE_URL`                 |                             Yes | `mysql://enterprise_hub:enterprise_hub_local_password@localhost:3306/enterprise_hub` |         Yes | API, worker, Prisma    | Local-only example is in `.env.example`; replace for personal environments.                                                          |
| `STORAGE_DRIVER`               |                             Yes | `local` or `oss`                                                                     |          No | API, worker, readiness | Selects the filesystem or Alibaba OSS/S3-compatible adapter at process startup; unsupported values fail fast.                        |
| `LOCAL_STORAGE_ROOT`           | Yes when `STORAGE_DRIVER=local` | `./.data/storage`                                                                    |          No | Storage package        | Local adapter root for original file objects; `.data/` is ignored by git.                                                            |
| `CURSOR_SIGNING_SECRET`        |                             Yes | `replace-with-local-development-cursor-secret`                                       |         Yes | API cursor signing     | Signs evidence and structured-query cursors only; it is never an authentication credential.                                          |
| `ENTERPRISE_HUB_PUBLIC_ORIGIN` |                             Yes | `https://api.smedatacenter.xyz`                                                      |          No | OAuth/API              | Canonical HTTPS issuer and browser-login origin.                                                                                     |
| `HUB_INTEGRATION_PORT`         |                              No | auto-assigned                                                                        |          No | Integration test       | Optional API port override for `npm run test:integration`.                                                                           |
| `HUB_MCP_TEST_PORT`            |                              No | auto-assigned                                                                        |          No | MCP smoke test         | Optional API port override for HTTP `/mcp` smoke.                                                                                    |
| `ENTERPRISE_HUB_BASE_URL`      |   Yes for official MCP launcher | `https://api.smedatacenter.xyz`                                                      |          No | MCP launcher           | Canonical HTTPS origin only. Launcher does not start the service and supports no token environment variable.                         |
| `MANUAL_TEST_DATABASE_URL`     |                              No | local `enterprise_hub` on `127.0.0.1:3307`                                           | Yes locally | manual-test controller | Optional override; the harness refuses remote hosts and other database names and never writes this value to the public run manifest. |
| `MANUAL_TEST_API_URL`          |                              No | `http://127.0.0.1:3000`                                                              |          No | manual-test controller | Optional loopback-only API override for a manual run.                                                                                |
| `MANUAL_TEST_QDRANT_URL`       |                              No | `http://127.0.0.1:6333`                                                              |          No | manual-test controller | Optional loopback-only Qdrant override; each run uses a dedicated `enterprise_hub_evidence_manual_*` collection.                     |
| `PORT`                         |                              No | `3000`                                                                               |          No | API server             | Optional local HTTP port override.                                                                                                   |
| `HOST`                         |                              No | `127.0.0.1`                                                                          |          No | API server             | API remains loopback-bound; nginx is the only public TLS entry point.                                                                |

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

### Performance gate execution

| Variable                           | Required | Default | Secret? | Used By                    | Notes                                                                                                                                                 |
| ---------------------------------- | -------: | ------- | ------: | -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PHASE3_PERF_THRESHOLD_MULTIPLIER` |       No | `1`     |      No | Phase 3 performance script | Bounded from `1` through `2`; GitHub shared runners use `1.25`, while local runs keep strict unscaled thresholds. The active value appears in output. |

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
| `LLM_MODEL`                          |                                                   Yes when real rerank is enabled | provider-specific rerank model, for example `qwen3.7-text-rerank`                    |                           No | API, worker            | Rerank model name. For DashScope rerank use a DashScope rerank model, not a chat model.                                    |
| `LLM_EMBEDDING_MODEL`                |                                                            Yes for real embedding | provider-specific embedding model, for example `text-embedding-v4`                   |                           No | API, worker            | Embedding model name recorded in retrieval config and chunk metadata.                                                      |
| `LLM_EMBEDDING_DIMENSION`            |                                  Yes when selected embedding differs from default | `1024` for DashScope `text-embedding-v4`; default fake `8`, openai-compatible `1536` |                           No | API, worker, readiness | Dense vector dimension used by provider validation and Qdrant collection readiness.                                        |
| `RERANK_PROVIDER`                    |                          No locally / Yes when rerank differs from `LLM_PROVIDER` | `dashscope`, `openai-compatible`, or `fake`                                          |                           No | API, worker, readiness | Allows OpenAI-compatible embeddings with DashScope-native rerank.                                                          |
| `OPENAI_COMPATIBLE_API_KEY`          |                                                            Yes for real embedding | runtime secret only                                                                  |                          Yes | API, worker            | Never print, commit, or return through API/MCP. Can also be reused for DashScope rerank when `DASHSCOPE_API_KEY` is unset. |
| `OPENAI_COMPATIBLE_BASE_URL`         |                                                            Yes for real embedding | provider base URL                                                                    | No unless credential-bearing | API, worker            | Do not include credentials in URL.                                                                                         |
| `DASHSCOPE_API_KEY`                  | No if reusing `OPENAI_COMPATIBLE_API_KEY` / Yes for separate DashScope credential | runtime secret only                                                                  |                          Yes | API, worker            | Optional separate API key for DashScope-native rerank. Never print or commit.                                              |
| `DASHSCOPE_API_BASE_URL`             |                                                          Yes for DashScope rerank | `https://dashscope.aliyuncs.com/api/v1`                                              |                           No | API, worker            | Base URL for DashScope-native rerank endpoint.                                                                             |
| `EXTERNAL_MODEL_EGRESS_ACKNOWLEDGED` |                                                    Yes when real provider enabled | `false` locally, `true` when approved                                                |                           No | API, worker, readiness | Real embedding/rerank calls must fail readiness/startup unless acknowledged.                                               |

Optional clearer aliases may be added later (`EMBEDDING_*`, `RERANK_*`), but Phase 3 must continue to support the existing names above.

Task 3 implements the env-backed provider factory with `LLM_PROVIDER=fake` as the local/CI default and `LLM_PROVIDER=openai-compatible` as the real external embedding path. DashScope-native rerank is selected independently with `RERANK_PROVIDER=dashscope`; it calls `/services/rerank/text-rerank/text-rerank` under `DASHSCOPE_API_BASE_URL`. The 2026-07-17 local smoke used synthetic text to verify `text-embedding-v4` returns 1024-dimensional embeddings through the compatible embeddings endpoint and `qwen3.7-text-rerank` returns `output.results[].index/relevance_score` through the DashScope-native rerank endpoint. Real embedding and rerank adapter calls require `EXTERNAL_MODEL_EGRESS_ACKNOWLEDGED=true`; otherwise the provider call is blocked before any injected or global fetch executes. Unit tests use injected fetch and never call external networks.

### Runtime Limits

| Variable                                   | Required | Example / Default                        | Secret? | Used By      | Notes                                                                             |
| ------------------------------------------ | -------: | ---------------------------------------- | ------: | ------------ | --------------------------------------------------------------------------------- |
| `MAX_UPLOAD_BYTES`                         |       No | `52428800`                               |      No | API          | Multipart and MCP decoded-upload file-size guard (50 MiB).                        |
| `MAX_STRUCTURED_IMPORT_ROWS`               |       No | `100000`                                 |      No | API          | Enforced structured ingestion row limit before storage/DB publication.            |
| `MAX_XLSX_SHEETS`                          |       No | `20`                                     |      No | API          | Enforced XLSX sheet-count limit during ZIP/workbook preflight.                    |
| `MAX_STRUCTURED_CELL_CHARS`                |       No | `32767`                                  |      No | API          | Enforced structured scalar/cell character limit during ingestion.                 |
| `MAX_XLSX_UNCOMPRESSED_BYTES`              |       No | `209715200`                              |      No | API          | Enforced XLSX total uncompressed-size limit during ZIP preflight.                 |
| `MAX_XLSX_ZIP_ENTRIES`                     |       No | `10000`                                  |      No | API          | Enforced XLSX ZIP central-directory entry-count limit.                            |
| `MAX_XLSX_COMPRESSION_RATIO`               |       No | `100`                                    |      No | API          | Enforced XLSX per-entry compression-ratio limit.                                  |
| `STRUCTURED_IMPORT_BATCH_INSERT_SIZE`      |       No | `500`                                    |      No | API + worker | Atomic structured row insert batch size.                                          |
| `STRUCTURED_IMPORT_TRANSACTION_TIMEOUT_MS` |       No | `120000`                                 |      No | API + worker | Prisma transaction timeout for atomic XLSX/CSV imports.                           |
| `MCP_MAX_CONCURRENT_REQUESTS`              |       No | `8`                                      |      No | API `/mcp`   | Bounded concurrent Streamable HTTP MCP requests.                                  |
| `MAX_DOCUMENT_CHARS`                       |       No | `5000000`                                |      No | worker       | Enforced evidence parser character limit before index publication.                |
| `MAX_CHUNKS_PER_DOCUMENT`                  |       No | `5000`                                   |      No | worker       | Enforced evidence chunk-count limit before index publication.                     |
| `WORKER_CONCURRENCY`                       |       No | `2`                                      |      No | worker       | Enforced bounded worker pool size for the dev loop.                               |
| `WORKER_LEASE_SECONDS`                     |       No | `120`                                    |      No | worker       | Enforced database lease duration for claim/heartbeat/complete/fail.               |
| `WORKER_POLL_INTERVAL_MS`                  |       No | `1000`                                   |      No | worker       | Poll interval (minimum `100` ms).                                                 |
| `WORKER_MAX_ATTEMPTS`                      |       No | `3`                                      |      No | worker       | Enforced transient retry cap.                                                     |
| `WORKER_RETRY_BASE_MS`                     |       No | `1000`                                   |      No | worker       | Enforced exponential retry base delay; cannot exceed retry maximum.               |
| `WORKER_RETRY_MAX_MS`                      |       No | `60000`                                  |      No | worker       | Enforced exponential retry maximum delay.                                         |
| `PARTITION_IMPORT_MAX_SOURCE_BYTES`        |       No | `2147483648`                             |      No | API + worker | Maximum business/dishes source object size (2 GiB).                               |
| `PARTITION_IMPORT_MAX_ROWS`                |       No | `5000000`                                |      No | worker       | Maximum source rows accepted by one partition import.                             |
| `PARTITION_IMPORT_MAX_PARTITIONS`          |       No | `10000`                                  |      No | worker       | Maximum store-day partitions produced by one source.                              |
| `PARTITION_IMPORT_MAX_CANONICAL_BYTES`     |       No | `8589934592`                             |      No | worker       | Maximum total canonical CSV bytes produced by one source.                         |
| `PARTITION_IMPORT_WORK_DIR`                |       No | `/var/lib/enterprise-hub/partition-work` |      No | worker       | Worker-local temporary extraction directory; contents are removed after each job. |
| `PARTITION_IMPORT_MIN_FREE_BYTES`          |       No | `12884901888`                            |      No | worker       | Minimum free disk required before partition processing starts.                    |
| `PARTITION_IMPORT_JOB_RETENTION_DAYS`      |       No | `30`                                     |      No | worker       | Retention for terminal job/status records.                                        |
| `PARTITION_UPLOAD_PART_BYTES`              |       No | `16777216`                               |      No | API          | Multipart upload part size (16 MiB; never below 5 MiB).                           |
| `PARTITION_UPLOAD_SESSION_TTL_SECONDS`     |       No | `86400`                                  |      No | API          | Lifetime of an unfinished multipart upload session.                               |
| `PARTITION_MANIFEST_MAX_PARTITIONS`        |       No | `10000`                                  |      No | API          | Maximum authorized partitions returned in one manifest.                           |
| `PARTITION_MANIFEST_URL_TTL_SECONDS`       |       No | `900`                                    |      No | API          | Lifetime of generated partition download URLs.                                    |

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

These deployment/CI variables describe the account-owned Alibaba Cloud ACR repository used by the current Phase 4 staging slice in `cn-beijing`. Store credentials outside git.

| Variable                               | Required For           | Secret? | Safe To Record? | Notes                                                                                                              |
| -------------------------------------- | ---------------------- | ------: | --------------: | ------------------------------------------------------------------------------------------------------------------ |
| `ENTERPRISE_HUB_ACR_REGISTRY`          | Image push/pull        |      No |             Yes | Current staging registry: `crpi-yyglilct3xi9outz.cn-beijing.personal.cr.aliyuncs.com`; do not include credentials. |
| `ENTERPRISE_HUB_ACR_NAMESPACE`         | Image naming           |      No |             Yes | Current staging namespace: `enterprise-hub`.                                                                       |
| `ENTERPRISE_HUB_ACR_API_REPOSITORY`    | API image naming       |      No |             Yes | Current staging repository: `api`.                                                                                 |
| `ENTERPRISE_HUB_ACR_WORKER_REPOSITORY` | Worker image naming    |      No |             Yes | Current staging repository: `worker`.                                                                              |
| `ENTERPRISE_HUB_ACR_QDRANT_REPOSITORY` | Qdrant image naming    |      No |             Yes | Current staging repository: `qdrant`.                                                                              |
| `ENTERPRISE_HUB_ACR_USERNAME`          | Registry login         |      No |             Yes | Keep in protected deployment runtime or CI configuration.                                                          |
| `ENTERPRISE_HUB_ACR_PASSWORD`          | Registry login         |     Yes |              No | Use `docker login --password-stdin`; never print or commit.                                                        |
| `ENTERPRISE_HUB_IMAGE_TAG`             | Immutable image deploy |      No |             Yes | Use a commit SHA or release version; never deploy `latest`.                                                        |

`release-ops` has no repository variable: its image uses the existing API
repository with the sibling tag `ops-<12-character-git-sha>`. This does not
require an additional ACR credential or runtime secret.

| Runtime variable                   | Required For                | Secret? | Safe To Record? | Notes                                                                                                       |
| ---------------------------------- | --------------------------- | ------: | --------------: | ----------------------------------------------------------------------------------------------------------- |
| `ENTERPRISE_HUB_API_IMAGE`         | Long-running staging API    |      No |             Yes | Immutable API image reference written into root-only `runtime.env` by deployment.                           |
| `ENTERPRISE_HUB_WORKER_IMAGE`      | Long-running staging worker |      No |             Yes | Immutable worker image reference written into root-only `runtime.env` by deployment.                        |
| `ENTERPRISE_HUB_RELEASE_OPS_IMAGE` | On-demand `release-ops`     |      No |             Yes | Existing API repository sibling tag `ops-<12-character-git-sha>`; used only with Compose profile `release`. |

The semi-automated `npm run deploy:staging` command has safe defaults for the
current target. These optional overrides exist for later non-interactive
execution; secret overrides must come from an approved process-level secret
manager, never a checked-in env file.

| Variable                                         | Required For                  | Secret? | Safe To Record? | Notes                                                                               |
| ------------------------------------------------ | ----------------------------- | ------: | --------------: | ----------------------------------------------------------------------------------- |
| `ENTERPRISE_HUB_STAGING_HOST`                    | SSH target override           |      No |             Yes | Defaults to `39.96.66.185`; strict host checking uses `deploy/staging/known_hosts`. |
| `ENTERPRISE_HUB_STAGING_SSH_USER`                | SSH user override             |      No |             Yes | Defaults to `root` for the current SWAS host.                                       |
| `ENTERPRISE_HUB_STAGING_SSH_KEY`                 | SSH private-key path          |     Yes |              No | Defaults to `~/.ssh/id_ed25519`; the key stays outside the repository.              |
| `ENTERPRISE_HUB_STAGING_PUBLIC_URL`              | Public release verification   |      No |             Yes | Defaults to `https://api.smedatacenter.xyz`.                                        |
| `ENTERPRISE_HUB_ACR_KEYCHAIN_SERVICE`            | Local ACR secret lookup       |      No |             Yes | Defaults to `com.sme_data_center.acr.personal.enterprise-hub`.                      |
| `ENTERPRISE_HUB_STAGING_CURSOR_KEYCHAIN_SERVICE` | Local cursor secret lookup    |      No |             Yes | Defaults to `com.sme_data_center.cursor.staging`.                                   |
| `ENTERPRISE_HUB_STAGING_CURSOR_KEYCHAIN_ACCOUNT` | Local cursor secret lookup    |      No |             Yes | Defaults to `enterprise-hub-staging`.                                               |
| `ENTERPRISE_HUB_STAGING_CURSOR_SIGNING_SECRET`   | Non-interactive cursor secret |     Yes |              No | Installed into root-only runtime env; never printed or committed.                   |

### GitHub staging environment

GitHub Actions maps Environment-level configuration onto the process variables
above. The GitHub names intentionally stay provider-neutral at the workflow
boundary.

| GitHub name                     | Kind     | Maps To                                        | Secret? | Notes                                                                           |
| ------------------------------- | -------- | ---------------------------------------------- | ------: | ------------------------------------------------------------------------------- |
| `ACR_PASSWORD`                  | Secret   | `ENTERPRISE_HUB_ACR_PASSWORD`                  |     Yes | ACR Personal Edition registry password.                                         |
| `STAGING_CURSOR_SIGNING_SECRET` | Secret   | `ENTERPRISE_HUB_STAGING_CURSOR_SIGNING_SECRET` |     Yes | Signs opaque pagination cursors; deploy installs it into root-only runtime env. |
| `STAGING_SSH_PRIVATE_KEY`       | Secret   | temporary SSH key file                         |     Yes | Written with a restrictive umask on the ephemeral runner, then removed.         |
| `ACR_REGISTRY`                  | Variable | `ENTERPRISE_HUB_ACR_REGISTRY`                  |      No | Beijing ACR registry hostname.                                                  |
| `ACR_NAMESPACE`                 | Variable | `ENTERPRISE_HUB_ACR_NAMESPACE`                 |      No | `enterprise-hub`.                                                               |
| `ACR_USERNAME`                  | Variable | `ENTERPRISE_HUB_ACR_USERNAME`                  |      No | Registry login account.                                                         |
| `STAGING_HOST`                  | Variable | `ENTERPRISE_HUB_STAGING_HOST`                  |      No | SWAS public host; SSH still uses the committed strict host identity.            |
| `STAGING_SSH_USER`              | Variable | `ENTERPRISE_HUB_STAGING_SSH_USER`              |      No | Current value is `root`.                                                        |
| `STAGING_PUBLIC_URL`            | Variable | `ENTERPRISE_HUB_STAGING_PUBLIC_URL`            |      No | HTTPS API base URL used by public checks and fixture smoke.                     |

List Environment secret names with `gh secret list --env staging` and
non-secret values with `gh variable list --env staging`. Never retrieve or
echo secret values during diagnostics.

For the current Phase 4 staging slice, the human-selected ACR target is Personal Edition in
`cn-beijing`. Alibaba Cloud documents that Personal Edition does not expose OpenAPI, so initial
Personal Edition activation, namespace creation, repository creation, and registry password setup
must happen once in the console if they do not already exist. That one-time setup is complete for
the current staging namespace. Agents should continue with Keychain-backed `docker login`,
fixed-tag push/pull verification, and runtime deployment automation.

The dependency risk policy applies to repository production dependencies and
all runtime image targets. New high/critical findings or unregistered moderate
findings block CI. The registered ExcelJS read-only XLSX exception is reviewed
no later than `2027-01-31`.
