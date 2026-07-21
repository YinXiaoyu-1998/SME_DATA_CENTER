# Phase 3 Retrieval And Structured Data Decisions

Status: living decision log
Last updated: 2026-07-11
Branch: `codex/phase3-retrieval-readiness-docs`
Worktree: `/Users/xiaoyuyin/Desktop/YXY_DEV/SME_DATA_CENTER_WORKTREES/phase3-retrieval-readiness-docs`

This document captures the current decision record for the new Phase 3 that will be inserted after the current Phase 2. It is not the final implementation plan. After the grilling session is complete, use this file as the source for updating `implementation-plan.md`, `api-contract.md`, `env-inventory.md`, readiness docs, tests, and any phase-number references.

## Phase Renumbering Impact Audit

Before editing `implementation-plan.md`, run a phase-renumbering audit. Do not only insert a new Phase 3 in the plan and leave old Phase 3/4 references ambiguous.

Documents/categories to inspect:

- implementation plan and current design log:
  - `docs/implementation/implementation-plan.md`
  - `docs/implementation/phase-3-retrieval-docs.md`
- progress and handoff logs:
  - `docs/implementation/progress.md`
  - `docs/implementation/agent-handoffs.md`
- staging/readiness docs:
  - `docs/implementation/staging-readiness.md`
  - `docs/implementation/server-runtime-prerequisites.md`
  - any staging/production readiness docs
- ADRs:
  - `docs/adr/`
- repo instructions and developer docs:
  - `AGENTS.md`
  - README/developer docs
- env/deployment docs:
  - `docs/implementation/env-inventory.md`
  - deployment/runbook docs and scripts references
- API/MCP/CLI docs:
  - HTTP API docs
  - MCP docs
  - CLI docs
- test/acceptance docs:
  - integration test docs
  - acceptance/test plan docs
- script/workflow references:
  - `scripts/`
  - `package.json`
  - `docker-compose.yml`
  - CI workflow display names

Classification for every old `Phase 3` / `Phase 4` reference:

1. new Phase 3 retrieval/structured-ingestion scope
2. old Phase 3 staging/readiness scope, now shifted later
3. historical/audit reference that should stay but receive a note
4. stale or incorrect reference that should be updated

Recommended naming principle:

- keep phase numbers in the primary implementation plan
- prefer semantic names for supporting docs so future insertions do not repeat the ambiguity
- examples: retrieval readiness, structured ingestion, staging readiness, production readiness, server runtime prerequisites

Resolved rename:

- `docs/implementation/phase-3-readiness.md` has been renamed to `docs/implementation/staging-readiness.md` after user confirmation.

The semantic target is:

- `docs/implementation/staging-readiness.md`

The previously considered phase-numbered alternative is not used:

- `docs/implementation/phase-4-readiness.md`

Do not rewrite historical records:

- past `progress.md` entries
- existing `agent-handoffs.md` entries
- accepted ADR historical context
- PR descriptions/changelog/commit messages

Instead, add a note such as:

> Phase numbering changed after inserting Retrieval/Structured Ingestion as the new Phase 3. Older entries mentioning Phase 3 may refer to the former staging/readiness phase.

Require user certification before:

- large accepted ADR rewrites
- further readiness file renames
- changing externally referenced filenames, script names, or CI job names
- changing AGENTS.md workflow rules beyond keeping references accurate
- deleting or archiving old docs
- reinterpreting completed phase scope rather than only renumbering it

After updates, run `rg "Phase 3|phase-3|Phase 4|phase-4"` and classify remaining references.

## Phase Intent

New Phase 3 upgrades the MVP into a production-usable retrieval foundation before the online/deployment phase.

It must support exactly five uploaded file types:

- Markdown
- TXT
- DOCX
- XLSX
- CSV

JSON is not supported in the new Phase 3. Existing JSON text-processing remnants should be removed during implementation.

## Evidence Index Data Model

Phase 3 must separate source document authority from retrieval index state. MySQL is the authority for document status, content version, permissions, and index readiness. Qdrant is a rebuildable retrieval index.

MySQL baseline models/fields:

- `documents`: source file and permission anchor
  - `orgId`, uploaded/owner metadata, title/original filename, file type, document kind
  - status such as uploaded, processing, active, failed, archived
  - OSS object key, content hash, `contentVersion`, `labelVisibilityVersion`
  - archive and audit timestamps
- `document_indexes`: one document content version under one retrieval config
  - `documentId`, `orgId`, `contentVersion`, `retrievalConfigVersion`
  - chunker, embedding provider/model/version/dimension, lexical index version, Qdrant collection
  - status such as pending, running, ready, failed, deprecated
  - chunk count, indexed/failed timestamps, error code/summary
  - unique key on `{documentId, contentVersion, retrievalConfigVersion}`
- `document_chunks`: chunk manifest for audit, repair, and revalidation
  - `chunkId`, `documentIndexId`, `documentId`, `orgId`
  - `contentVersion`, `retrievalConfigVersion`, chunker version, chunk ordinal, chunk hash
  - source file type, block type, heading path, page/paragraph/table/row/char location metadata where available
  - Qdrant point id and status such as indexed, stale, deleted
  - MySQL does not need to store full chunk text in baseline if Qdrant stores returnable snippet text and OSS remains source of truth
- `retrieval_configs`: explicit versioned retrieval configuration
  - version, status such as candidate/active/deprecated
  - embedding provider/model/version/dimension
  - chunker version, lexical index version, rerank provider/model/version
  - Qdrant collection and activation timestamps
  - Phase 3 baseline can use one global active retrieval config; org-specific configs are P2/P3

Qdrant point id:

- deterministic id derived from `{documentId, contentVersion, retrievalConfigVersion, chunkOrdinal}`
- can be a readable composite id or a stable hash
- must be idempotent for repeated indexing of the same document version/config
- must change when content version or retrieval config changes

`chunkId` should have the same semantic identity as the Qdrant point id: one stable chunk id for one `{documentId, contentVersion, retrievalConfigVersion, chunkOrdinal}`. Content replacement or retrieval config migration therefore creates new chunk ids and avoids mixing old/new evidence.

Qdrant payload baseline:

- `orgId`
- `documentId`
- `chunkId`
- `documentIndexId`
- `contentVersion`
- `retrievalConfigVersion`
- chunker/embedding/lexical versions and embedding model metadata
- chunk ordinal and chunk hash
- source file type, block type, heading path, and source location metadata
- indexed timestamp
- diagnostic snapshots such as document status and label visibility version

Qdrant payload snapshots are only optimization/diagnostic hints. They are not authorization truth. Avoid storing employee details, label names, or sensitive permission internals in Qdrant payload.

Evidence retrieval revalidation must confirm before returning any chunk:

- employee is enabled
- document exists and is active
- document `contentVersion` matches the chunk
- current active retrieval config matches the chunk/index
- document index exists and is ready
- chunk exists in the MySQL chunk manifest
- caller has current document label visibility

Archive behavior:

- archive commits first in MySQL by setting the document inactive/archived
- Qdrant delete or payload repair is asynchronous
- retrieval revalidation drops any stale Qdrant hit immediately after the MySQL archive commit

Label/visibility behavior:

- update document-label relations in MySQL
- increment `labelVisibilityVersion`
- enqueue Qdrant payload update/repair if useful
- retrieval uses current MySQL label permissions, not Qdrant snapshots

Content replacement behavior:

- Phase 3 baseline uses strict semantics: replacement puts the document into processing/unavailable until the new content version is fully indexed and ready
- create a new `document_indexes` row and new chunk ids for the new `contentVersion`
- publish active only after new index readiness
- mark old index/chunks deprecated/stale and clean Qdrant asynchronously
- zero-downtime dual-version replacement is P2 because it needs explicit active/pending content-version modeling

## Worker And Processing Runs

Phase 3 requires typed asynchronous processing. Heavy work must not be hidden inside `Document.status` alone.

Baseline job types:

- `evidence_document_index`: MD/TXT/DOCX parse, chunk, embed, lexical index, Qdrant upsert, publish active after index readiness
- `structured_import_validate`: CSV/XLSX parse/profile/validate, schema/window/multi-sheet checks, ImportBatch validation state
- `structured_import_apply`: atomic row insert, active-window claim finalization, publish batch as queryable
- `index_repair_or_delete`: Qdrant cleanup or payload/version repair after archive, content replacement, label/status changes

P2 job type:

- `model_reindex`: rebuild embeddings/lexical index for a new retrieval config

`ProcessingRun` should support:

- `orgId`
- `documentId`
- `importBatchId`
- `jobType`
- status: queued, running, succeeded, failed, retrying, canceled
- attempt / max attempts
- idempotency or job dedup key
- `lockedBy` / `lockedUntil` lease
- `availableAt` / retry availability timestamp
- `lastHeartbeatAt`
- started/finished timestamps
- error code/summary
- metrics JSON

Retry policy:

- retry transient failures such as external model timeout/rate limit, temporary DB failure, Qdrant failure, worker crash/lock expiry
- do not retry deterministic failures such as malformed file, schema mismatch, invalid date window, unsupported file type, active import conflict, or idempotency-key conflict
- use bounded exponential backoff and job-type attempt caps

Idempotency keys:

- evidence indexing: `{documentId, contentVersion, chunkerVersion, embeddingVersion, lexicalIndexVersion}`
- structured validation/apply: `{importBatchId}`
- active-window claim: `{orgId, dataset, startDate, endDate}`
- model reindex: `{documentId, contentVersion, targetRetrievalConfigVersion}`

Crash recovery:

- DB-backed leases protect running jobs
- expired leases are requeued by worker poller/watchdog
- jobs must either persist phase progress or be safe to restart
- no document becomes active until final index readiness commit
- no import becomes applied until rows, metadata, claim, and audit commit

Concurrency limits:

- global worker concurrency
- per-org concurrency
- external provider concurrency
- Qdrant upsert concurrency
- structured import concurrency
- max simultaneous imports per dataset/window
- batch insert size
- max document size/chunk count for Phase 3

P2 worker/operator improvements:

- admin retry UI
- progress percentages
- priority queues
- dead-letter UI
- model reindex dashboard
- cost dashboards
- adaptive concurrency
- automated stale-index repair sweeps
- richer per-phase traces

See ADR 0016 for typed processing runs and publish gates.

## Operations, Health, And Metrics

Phase 3 baseline operations must prove the system can safely accept uploads, process jobs, and serve permission-scoped retrieval/query results.

Baseline readiness checks:

- MySQL: connectivity, migration/schema version current, lightweight read/write, job lease acquisition, structured registry loadable
- Qdrant: connectivity, required collections exist, expected dense/sparse configuration, collection health, active retrieval config index available
- OSS: bucket/container reachable, small health object write/read/delete where allowed, signed/download path works where applicable
- worker: heartbeat, queue polling, lease acquire/release or synthetic no-op job, expired locks below threshold, backlog below threshold
- external model providers: enabled config present, credentials valid, lightweight model availability check, timeout/circuit-breaker state; health checks must not send real document content

Baseline metrics:

- structured query count, latency, validation failures, permission-scoped query count, aggregate query count, active import conflicts, idempotency conflicts, slow query count
- import rows, import duration by phase, import failures by error code
- evidence search count and latency, dense/sparse/rerank latency, candidates retrieved, chunks returned, chunks dropped by MySQL revalidation, stale payload mismatch count
- Qdrant upsert/delete/repair failures and collection/chunk counts by org/index version
- OSS upload/read failures, storage latency, source object missing count, source hash mismatch count
- worker queued/running/succeeded/failed/retrying counts by job type, job age/backlog, attempts, expired locks, crash-recovered jobs, per-phase processing duration
- external provider request count, latency, errors, retries, timeouts, rate limits, circuit breaker state, token/character counts, estimated cost, fallback usage

Baseline alerts:

- MySQL unavailable or migration mismatch
- Qdrant unavailable or required collection missing
- OSS unavailable
- worker heartbeat missing
- job backlog/age or expired locks exceed threshold
- import/indexing failure rate spikes
- external provider auth, timeout, or rate-limit failures persist
- stale payload drops exceed threshold
- any permission leak detected by tests/synthetic checks
- document active without ready index
- ImportBatch applied with unexpected zero rows
- active import claim stuck too long

P2 operations:

- operator dashboards with drill-down
- automated stale-index repair sweeps
- retrieval quality trend reports
- per-field structured query usage heatmaps
- cost budget alerts by org/provider
- adaptive concurrency
- anomaly detection
- synthetic golden-query monitor in staging/prod-like environments
- detailed Qdrant optimization metrics
- per-sheet import performance dashboards
- admin UI for failed job retry/dead-letter handling

This belongs in implementation/runbook docs and deployment readiness tests, not a separate ADR.

## Testing And Acceptance Matrix

Phase 3 acceptance is organized around proving the safe core loop: upload/process, authorize, index/query, return evidence/data, and fail without partial publication or leakage.

Test layers:

- unit tests
- integration tests
- acceptance tests
- performance tests
- staging/prod-like readiness tests

Evidence retrieval baseline tests:

- MD parser extracts headings, lists, tables, code blocks, and link text
- TXT parser handles encoding, line breaks, and whitespace normalization
- DOCX parser extracts body paragraphs and deterministic table text
- DOCX unsupported embedded images/screenshots produce warnings and no OCR
- malformed DOCX fails and never becomes active
- chunk ids are deterministic and change when `contentVersion` or retrieval config changes
- chunk metadata includes document id, content version, retrieval config version, block type, heading path, and source location
- document active gate requires parse, chunk, embed, Qdrant upsert, lexical index, metadata, and audit success
- evidence search returns evidence only, not answers

Qdrant/MySQL revalidation tests:

- integration tests must use real Qdrant, not only mocks
- Qdrant payload filter includes org/document/content/retrieval config metadata
- archived document hits are dropped by MySQL revalidation
- stale label/version hits are rechecked against current MySQL permissions
- old content version hits are dropped
- not-ready document index hits are dropped
- disabled employee cannot retrieve evidence
- label changes take effect immediately after MySQL commit, independent of Qdrant cleanup
- stale drops emit metrics/logs but never return content

Structured import tests:

- real 67k-row dishes workbook acceptance
- real 151-column business workbook acceptance
- complete field coverage in MySQL schema and field registry
- schema discovery returns every current field
- exact/alias headers accepted
- unknown, missing required, ambiguous, or mismatched headers fail
- type/null/blank normalization follows registry
- invalid values fail before commit
- strings are not silently truncated
- empty sheets ignored and recorded
- all non-empty sheets, including hidden sheets, must match same dataset schema/date window
- matching hidden sheets participate in import
- row lineage records sheet name/index/hidden/source row number
- metadata business-date window is required and must match content
- active same `{orgId,dataset,startDate,endDate}` conflicts
- failed validation or mid-import failure produces no queryable rows
- idempotency key and request fingerprint semantics are tested
- concurrent same-window imports produce at most one applied batch
- CSV covered with smaller valid/error fixtures; XLSX covered with real large workbooks

Structured query compiler tests:

- no raw SQL accepted
- generated SQL is parameterized
- invalid fields/operators/capabilities/types are rejected
- filter tree depth, condition count, `in` size, sort, group, aggregate, select limits are enforced before SQL execution
- default fields and explicit select behavior match registry
- deterministic sort and opaque cursor behavior are tested
- cursor tampering or changed query shape fails
- aggregation is permission-scoped before grouping
- group pagination paginates group rows
- stable error envelope and request id are returned
- hidden data is scoped out without leaking hidden counts

Permission/security tests:

- backend authorization on every non-health endpoint
- structured rows and evidence chunks inherit source document permissions
- label changes affect evidence, rows, and aggregates
- archive hides evidence and structured rows/batches according to contract
- disabled employees cannot search/query/import/status outside allowed scope
- permission-hidden documents/rows do not leak through counts, aggregate, pagination, or errors
- external provider tests do not log raw chunk/query payloads or secrets
- SQL injection payloads cannot become raw SQL
- unsupported file types, oversized queries, malformed files, and tampered cursors fail safely

Performance/large-file tests:

- real large workbooks parse/validate/import within agreed environment-specific thresholds
- 151-column business import does not exceed DB packet/statement limits
- schema discovery payload remains acceptable
- selected indexed filters/query smoke meet staging thresholds
- evidence indexing records chunk count, embedding calls, and Qdrant upserts
- worker crash/expired lease recovery avoids double insert and double active publication
- CI should avoid brittle millisecond targets; staging sets agreed p95/import-duration thresholds

Golden retrieval evaluation:

- 20–50 realistic MD/TXT/DOCX documents
- at least 100 judged queries
- Chinese business documents and queries are first-class
- include exact keyword, semantic paraphrase, synonyms, table/clause lookup, ambiguous, no-answer, and permission-hidden cases
- compare dense-only, lexical-only, hybrid, and hybrid+rerank
- track permission leaks, archived leaks, stale payload leaks, hitRate@5, recall@10, precision@k, MRR@10, NDCG@10, no-answer false positives, and latency
- leak metrics must be zero
- per-query results must be saved for regression review

Gate split:

- PR/merge gate:
  - lint/typecheck/format
  - unit tests for query compiler, field registry, ImportBatch/idempotency, permission predicates, error envelope, cursor validation
  - integration tests with real MySQL + real Qdrant and deterministic fake embedding/rerank
  - small structured import/query fixtures
  - MySQL revalidation and document active gate tests
- main/nightly gate:
  - larger XLSX fixtures
  - real large samples if available in secure test storage
  - golden retrieval evaluation
  - concurrency/idempotency tests
  - worker crash recovery
  - performance smoke
- staging gate:
  - MySQL migration readiness, Qdrant collection config, OSS read/write, worker heartbeat/lease, model provider config/acknowledgement
  - full evidence indexing/search smoke
  - real structured import acceptance
  - permission/label/archive/disabled employee scenarios
  - golden retrieval suite
  - provider smoke with synthetic text if real provider is enabled
  - backup/rebuild runbook dry-run documented; automated drills are P2

P2 tests:

- Qdrant snapshot/restore drill
- one-command reindex/rebuild test
- admin retry/operator flows
- query template migration tests
- registry diff review reports
- stale repair sweeps
- scheduled retrieval monitor
- larger load/perf suite
- provider cost budget alerts
- richer parser corpus
- downloadable validation reports

## Deployment And Environment Boundaries

Qdrant is a Phase 3 baseline dependency, not an optional experiment. Any environment that claims to validate Phase 3 retrieval must exercise the real Qdrant integration path.

Mainland China / Alibaba Cloud boundary:

- Qdrant OSS is Apache-2.0 licensed per the upstream repository, so Phase 3 can run self-hosted Qdrant on our own approved infrastructure subject to normal open-source compliance review.
- Self-hosted Qdrant cost is therefore infrastructure and operations cost: compute, disk, backup/snapshot, monitoring, security, networking, upgrades, incident response, and capacity planning.
- Qdrant Cloud pricing should be treated as managed infrastructure plus vendor operations/support, not as a required runtime license fee for our baseline self-hosted path.
- Do not assume Qdrant Cloud provides a mainland-China Alibaba Cloud managed region.
- For planned Alibaba Cloud deployment, Phase 3 baseline should use self-hosted Qdrant on Alibaba Cloud infrastructure, such as ECS/docker compose for early staging or ACK/Kubernetes if the deployment model requires it.
- Qdrant Cloud or Qdrant Hybrid/Private Cloud can be reconsidered only after explicit commercial/region/data-residency verification; it is not a baseline dependency.
- Local development remains Docker-based Qdrant and should match the self-hosted API/collection behavior used in staging.
- Because mainland networks may not reliably pull public images at deployment time, staging/prod-like deployment should mirror/pin the Qdrant image into an approved Alibaba Cloud ACR repository or another approved internal artifact registry.

Local development / MVP bootup:

- `docker compose` and local bootup should include MySQL, Qdrant, API, worker, and local OSS-compatible storage or an explicit local storage substitute.
- Local development may default to deterministic fake embedding/rerank providers so developers do not need external API keys or incur model cost.
- A separate explicit switch should run the same flow with a real external provider for integration/acceptance checks.

CI/test layers:

- unit tests may mock Qdrant, OSS, and model providers
- merge-gating integration tests must use real MySQL and real Qdrant via service container/testcontainer or equivalent
- integration tests should use deterministic fake embedding/rerank providers by default
- optional external-provider smoke tests run manually, nightly, or in staging preflight and use synthetic text only

Staging/prod-like readiness:

- Qdrant must be a readiness gate before go-live.
- Staging/prod-like checks must use a real Qdrant deployment, not mocks or in-process substitutes.
- readiness must verify Qdrant connectivity, required collections, dense/sparse config, collection health, active retrieval config/index version, and upsert/search/delete smoke behavior.
- readiness must also verify MySQL metadata/index-version consistency, OSS read/write, worker lease/job processing, and explicit external-provider or fake-provider mode.
- A fake provider environment can be valid for internal demos or CI, but must not be reported as production-ready external-model operation.

Baseline deployment/runbook scope:

- compose support for MySQL + Qdrant + API + worker + local storage/fake storage
- schema, migration, and Qdrant collection initialization
- self-hosted Qdrant deployment path for Alibaba Cloud staging/prod-like environments
- approved image mirroring/pinning path for Qdrant artifacts
- readiness/preflight command for MySQL, Qdrant, OSS, worker, and model provider config
- deterministic fake embedding/rerank provider for local and CI
- documented recovery paths for MySQL restore, OSS source-object issues, Qdrant rebuild, external provider outage, and worker crash recovery
- MySQL and OSS are source-of-truth systems and must have backup/persistence expectations
- Qdrant indexes are rebuildable from MySQL + OSS + retrieval config, but staging/prod-like runbooks should document snapshot or rebuild strategy

P2 deployment/operator improvements:

- Qdrant snapshot automation and restore drill
- one-command reindex/rebuild from MySQL + OSS
- scheduled golden retrieval monitor in staging/prod-like environments
- provider cost/latency dashboards
- operator UI for failed jobs and reindex status
- adaptive worker concurrency
- performance CI with larger fixtures
- Qdrant optimization/compaction runbook
- blue/green retrieval index promotion workflow

P3 deployment/operator improvements:

- multi-node/high-availability Qdrant, unless real production scale requires it earlier
- cross-region disaster recovery
- dedicated lexical backend such as OpenSearch/Meilisearch
- automatic multi-provider failover
- per-tenant custom Qdrant clusters
- advanced backup verification automation
- chaos testing for Qdrant/OSS/provider outages
- Kubernetes/operator deployment if the deployment model later requires it

See ADR 0017 for the decision that Qdrant is a baseline dependency and staging readiness gate.

## Environment, Secrets, And Versioned Config

Phase 3 config should be split by responsibility:

- env/secrets: dependency connection information, credentials, and deployment-level limits
- DB/versioned config: retrieval config, model/index versions, field registry, and dataset contract
- code defaults/tests: conservative defaults and deterministic fake providers

Existing model-related env variables must remain supported as the Phase 3 baseline control surface:

- `LLM_PROVIDER`
- `LLM_MODEL`
- `LLM_EMBEDDING_MODEL`
- `OPENAI_COMPATIBLE_API_KEY`
- `OPENAI_COMPATIBLE_BASE_URL`

Interpretation for Phase 3:

- these variables configure embedding/rerank provider access for retrieval infrastructure
- they do not enable Enterprise Hub to generate final natural-language answers
- `LLM_EMBEDDING_MODEL` identifies the embedding model
- `LLM_MODEL` may identify rerank or other provider-side model only if the configured rerank adapter uses it
- secrets must never be logged, included in docs as real values, committed, or returned through API/MCP
- clearer `EMBEDDING_*` / `RERANK_*` aliases may be added later, but baseline must not require renaming the existing `.env` variables

Baseline Qdrant env/secrets:

- `QDRANT_URL`
- `QDRANT_API_KEY` (empty allowed for local-only unsecured compose)
- `QDRANT_COLLECTION_EVIDENCE`
- `QDRANT_TIMEOUT_MS`
- optional client-specific TLS/gRPC toggles if the selected client requires them

Baseline retrieval config:

- env may specify the expected active retrieval config version, such as `RETRIEVAL_CONFIG_VERSION`
- actual retrieval config details belong in DB/versioned seed data:
  - retrieval config version
  - chunker version
  - embedding provider/model/version/dimension/config hash
  - lexical index version
  - rerank provider/model/version
  - Qdrant collection
  - status: candidate, active, deprecated
- document indexes, Qdrant payload, retrieval responses, migrations, and rollback all reference this versioned config

Fake versus real model provider:

- local and CI may use deterministic fake embedding/rerank provider
- real external provider usage requires configured provider/base URL/key/model and explicit data-egress acknowledgement
- if rerank is disabled or fake, responses/logs must expose `rerank_disabled` or equivalent status rather than implying real rerank happened
- staging/prod-like readiness must clearly report whether it validated fake-provider flow or real external-provider flow

External model data-egress gate:

- baseline should include an env/readiness gate such as `EXTERNAL_MODEL_EGRESS_ACKNOWLEDGED=true|false`
- fake-only environments can leave it false
- any real external embedding/rerank provider requires it true or startup/readiness must fail
- a formal DB-backed admin acknowledgement workflow is P2

Baseline storage env/secrets:

- reuse existing storage envs where present
- Phase 3 env inventory must cover provider (`local`, Alibaba OSS, or S3-compatible), bucket/container, prefix, endpoint, region, access key id, secret, path-style flag if needed, and local storage directory
- local storage is acceptable only for local development/testing
- staging/prod-like source documents must use persistent object storage because source files are authority for reprocessing and audit

Baseline worker/env limits:

- worker concurrency, lease duration, poll interval, retry attempts, backoff settings
- per-job concurrency for evidence indexing, structured import, Qdrant upsert, and embedding calls
- max upload bytes, max document chars, max chunks per document, max structured import rows, max XLSX sheets

Baseline structured query/import limits:

- structured query default/max limit, boolean depth, condition count, `in` values, sort fields, group-by fields, aggregate count, selected fields, and cursor TTL
- structured import max rows/columns, batch insert size, validation error example limit
- final effective values must be returned in schema discovery so HTTP, MCP, tests, and docs stay aligned
- product invariants such as active-window uniqueness must not be casually disabled by env outside tests

Versioned config, not env:

- `dishes` / `business` field registry
- field aliases, types, nullability, sensitivity, lifecycle, capabilities, operators, indexes, and limits
- retrieval config records
- model/index/chunker versions used by `DocumentIndex` and Qdrant payload

P2:

- DB-backed org-level provider configuration
- admin UI for external model data-egress acknowledgement
- retrieval config promotion/rollback API
- per-org cost budgets
- adaptive worker concurrency
- Qdrant snapshot schedule/config
- scheduled golden retrieval monitor config
- separate Qdrant read/write endpoints if needed
- provider circuit-breaker tuning
- per-dataset structured query limits

P3:

- multi-provider automatic failover
- per-tenant model routing
- per-tenant Qdrant collections/clusters
- cross-region DR config
- user-defined schema registry config
- runtime field capability editing
- dedicated lexical backend config

`env-inventory.md` should record for each variable: name, local/CI/staging/prod requirement, secret status, default, allowed values, owning process, description, and failure behavior when missing.

## HTTP API Surface

HTTP API is the canonical backend contract. MCP tools are thin adapters over these endpoints and must not become a second implementation.

See ADR 0018 for the canonical HTTP API / thin MCP adapter boundary.

Baseline endpoint groups:

- `POST /v1/documents/evidence`: upload MD/TXT/DOCX evidence documents for indexing
- `POST /v1/evidence/search`: evidence-only search over authorized, active, index-ready MD/TXT/DOCX documents
- `POST /v1/structured/imports`: upload/create CSV/XLSX structured import task for `dishes` or `business`
- `GET /v1/structured/imports/{importBatchId}`: safe status and validation errors for a structured import
- `GET /v1/structured/datasets`: schema discovery for dataset field registry, capabilities, operators, limits, lifecycle, sensitivity, and versions
- `POST /v1/structured/query`: controlled read-only structured query over `dishes` / `business`
- optional/reused status endpoint such as `GET /v1/documents/{documentId}/processing-runs` if existing document processing status is not sufficient

Evidence search request shape:

- query string from the employee-owned agent
- optional filters such as document ids, file types, labels, created/uploaded time window, and source metadata
- limit and opaque cursor

Evidence search response shape:

- result chunks with `chunkId`, `documentId`, document title, chunk text, score object, `matched_by`, and source location metadata
- retrieval metadata: retrieval config version, embedding version, lexical index version, rerank version/status
- pagination metadata, warnings, and `requestId`
- no final answer, summary, recommendation, or user-facing analysis

Structured import request shape:

- multipart upload or equivalent source-object reference
- `dataset: dishes | business`
- `enterprise_name`
- `startDate` / `endDate` as business-date window
- labels / visibility metadata
- client idempotency key

Structured import response/status shape:

- `documentId`, `importBatchId`, dataset, status, business-date window, row count when known, sheet summary, safe validation errors, timestamps, and `requestId`
- same idempotency key + same request fingerprint returns existing status
- same idempotency key + different fingerprint returns `IDEMPOTENCY_KEY_CONFLICT`
- existing active/applied import window returns `ACTIVE_IMPORT_EXISTS`
- in-progress same window returns `IMPORT_IN_PROGRESS`

Schema discovery response shape:

- API/schema version
- dataset ids and display names
- per-dataset registry version and limits
- field registry entries: canonical name, source aliases, type, nullable, sensitivity, lifecycle/volatility, capabilities, operators, default-return flag, index status, and value limits

Structured query request shape:

- `dataset`
- optional `registryVersion`
- `select`
- bounded `filter` tree
- bounded `sort`
- optional explicit `groupBy`
- optional explicit mechanical `aggregates`
- page limit and opaque cursor

Structured query response shape:

- dataset, effective registry version, query id
- rows for detail queries, or grouped rows/aggregate values for explicit aggregate queries
- page metadata, warnings, and `requestId`
- no natural-language interpretation, trend analysis, business conclusion, or generated SQL

Error envelope:

- all failures return a stable machine-readable envelope with `code`, safe `message`, `retryable`, bounded `details`, and `requestId`
- baseline codes include `INVALID_QUERY`, `INVALID_FIELD`, `UNSUPPORTED_OPERATOR`, `UNSUPPORTED_CAPABILITY`, `TYPE_MISMATCH`, `INVALID_AGGREGATION`, `LIMIT_EXCEEDED`, `REGISTRY_VERSION_UNSUPPORTED`, `REGISTRY_VERSION_MISMATCH`, `DATASET_FORBIDDEN`, `ACTIVE_IMPORT_EXISTS`, `IMPORT_IN_PROGRESS`, `IDEMPOTENCY_KEY_CONFLICT`, `INVALID_CURSOR`, `CURSOR_EXPIRED`, `VALIDATION_FAILED`, `PROCESSING_FAILED`, `TEMPORARILY_UNAVAILABLE`, and `INTERNAL_ERROR`
- permission-hidden rows/documents are scoped out; no visible rows returns `200` with empty rows; dataset-level denial returns `403 DATASET_FORBIDDEN`
- responses must not expose hidden row counts, hidden batch counts, or backend offsets

Pagination / cursors:

- baseline API uses cursor-based pagination, not offset as a stable external contract
- cursors are opaque and internally bind caller, org, dataset/query shape, registry version, and sort
- query-shape changes invalidate old cursors
- structured queries must have deterministic sort; if the caller does not provide one, the service uses a stable default and returns a warning
- evidence cursors are signed opaque offset cursors with a bounded TTL; they bind org, employee, role, current label digest, query/filter/limit, retrieval config version, and next offset, and every page reruns retrieval plus authorization before slicing

Structured query pagination and consistency:

- detail row queries paginate rows
- aggregate queries paginate group rows, not source rows
- no `groupBy` aggregate has at most one row and does not need pagination
- detail default sort should be stable lineage order, such as `importBatchId`, `sourceSheetIndex`, `sourceRowNumber`, and row id
- aggregate default sort should be group key ascending
- caller sort is allowed only for fields with registry `sort=true`; service appends stable tie-breakers
- cursor binds org, caller/auth-scope hash, dataset, registry version, query-shape hash, effective filters, effective sort, limit, last seen sort values/tie-breakers, query mode, visible active import scope/version, creation time, and expiry
- Phase 3 baseline does not promise long transaction snapshot consistency across pages
- every page rechecks permissions and current visibility
- if active import visibility scope or registry compatibility changes during pagination, return cursor-expired/invalid and require a fresh query

Baseline structured query limits:

- default row limit: 50
- max detail row limit: 200
- max aggregate group limit: 100
- max boolean depth: 3
- max total conditions: 20
- max children per `and`/`or`: 10
- max `in` values: 100
- max sort fields: 2
- max group-by fields: 1
- max aggregate functions: 5
- max selected fields: 50 unless a future export-style endpoint is added

Structured query performance boundary:

- all query limits and field capabilities are checked before SQL execution
- SQL is parameterized and generated only from registry-approved dataset, field, operator, sort, pagination, and aggregate definitions
- no unindexed/high-cost filter is allowed by default; registry may expose `filterCost` and `indexed` to support safe rejection
- `contains` requires explicit field allowlist and performance strategy
- groupBy requires registry `groupBy=true` and should be limited to low/medium-cardinality fields
- aggregate runs after backend permission scoping and user filters
- baseline indexes should cover permission/dataset/import scope, source lineage order, import date windows/status, and a small set of common filter/sort/group fields selected from profiling

HTTP/admin-only capabilities:

- worker force retry/cancel/dead-letter
- force reindex
- Qdrant repair/delete/snapshot/restore
- model config creation, promotion, rollback, and provider API key management
- external data-egress acknowledgement
- field registry/capability/sensitivity editing
- ImportWindowClaim repair and manual active import repair
- audit export
- permission/label administration unless already exposed through existing admin API
- destructive purge/delete administrative actions
- ops readiness/preflight
- cost/latency/provider dashboards

## Upload Entry Points And Unified Status

Phase 3 should use shared underlying `Document`, OSS, audit, worker, and `ProcessingRun` models, while exposing separate semantic HTTP endpoints for evidence documents and structured imports.

Evidence document upload:

- endpoint: `POST /v1/documents/evidence`
- file types: MD, TXT, DOCX
- required metadata: file, labels/visibility, title or original filename
- optional metadata: description/source metadata if already supported
- forbidden metadata: dataset, start date, end date
- creates `Document(documentKind=evidence, fileType=md|txt|docx)`
- creates `ProcessingRun(jobType=evidence_document_index)`
- creates/updates `DocumentIndex` and chunk manifest during processing
- active only after `Document.status=active` and `DocumentIndex.status=ready`

Structured import upload:

- endpoint: `POST /v1/structured/imports`
- file types: XLSX, CSV
- required metadata: file, `dataset`, `enterprise_name`, `startDate`, `endDate`, labels/visibility, idempotency key
- creates `Document(documentKind=structured, fileType=xlsx|csv)`
- creates `ImportBatch`
- creates `ProcessingRun` for validation/apply
- queryable only after `Document.status=active` and `ImportBatch.status=applied`

`Document.status` is source-file level status:

- `uploaded`: Document/OSS/audit created
- `processing`: worker is processing
- `active`: source file has completed its required baseline processing
- `failed`: processing failed, not searchable/queryable
- `archived`: source file archived, not searchable/queryable

Fine-grained processing status lives in:

- `DocumentIndex` for evidence documents
- `ImportBatch` for structured imports
- `ProcessingRun` for worker attempts, retries, leases, and errors

Do not rely on `Document.status` alone for query/retrieval gates. Evidence retrieval must also require ready `DocumentIndex`; structured query must also require applied `ImportBatch`.

Unsupported types:

- Phase 3 supports only MD/TXT/DOCX/XLSX/CSV
- JSON is explicitly unsupported
- JSON and other unsupported uploads return `415 UNSUPPORTED_FILE_TYPE` or equivalent stable error
- mismatched endpoint/file type returns `UNSUPPORTED_FILE_TYPE` or `INVALID_DOCUMENT_KIND_FILE_TYPE`
- dataset/schema mismatch returns `VALIDATION_FAILED`
- old JSON upload/indexing code and docs should be removed or marked unsupported during implementation

Unified upload response shape:

- evidence upload returns document id/kind/file type/status, processing run id/status, document index status/config version, and request id
- structured import returns document id/kind/file type/status, processing run id/status, import batch id/dataset/status, business-date window, and request id

MCP upload boundary:

- MCP baseline must expose search/discovery/query and upload/status for both structured imports and evidence documents
- baseline MCP tools include `upload_structured_dataset` and `upload_evidence_document`
- evidence document upload through MCP must be named separately, require labels/visibility, restrict file types to MD/TXT/DOCX, return status only, and never generate answers
- structured upload through MCP must require dataset/date/idempotency metadata and cannot bypass active-window or validation rules

## Structured Schema Profiling And Registry

Phase 3 uses real `dishes` and `business` XLSX exports as schema/profile inputs, but runtime ingestion must not automatically guess or evolve production schema. The workflow is sample-driven generation followed by human review and versioned contract publication.

Authoritative artifacts:

- MySQL physical schema/migrations for `dishes` and `business` row tables
- versioned structured field registry used by schema discovery, import validation, query validation, and tests

Profiling inputs:

- real `dishes` XLSX sample
- real `business` XLSX sample
- declared dataset
- declared business-date window semantics
- all non-empty sheets, including hidden sheets

Header/alias workflow:

- preserve the real source column names
- generate stable public field names that do not depend on fragile Chinese export headers as the only API field names
- generate controlled aliases from exact header, trimmed/normalized whitespace, full-width/half-width normalization, and known punctuation/case variants
- reject alias conflicts within a dataset
- do not accept fuzzy header matches at runtime; renamed columns require human confirmation and registry update

Type/profile workflow:

- produce candidate types such as string, integer, decimal, money, percent, date, datetime, boolean, and enum-like string
- profile parse success rate, precision/scale, percent/currency markers, date formats, unique count/ratio, max length, null/blank rate, and anomaly examples
- manually review and freeze types into registry and MySQL migrations
- store money as decimal, not float
- treat business codes/ids as strings unless semantics prove numeric calculation is valid
- explicitly define percent storage semantics, such as ratio versus percentage points
- default uncertain fields to string with limited query capabilities

Nullable/required workflow:

- every field declares `nullable`, `requiredForImport`, and blank normalization behavior
- current export columns are required for import unless deliberately marked otherwise
- value nullability is based on real null/blank profile plus business semantics
- whitespace, empty strings, `-`, `N/A`, and similar placeholders require explicit normalization rules
- no silent truncation of overlong strings

Cardinality/capability workflow:

- profile distinct count, distinct ratio, top values, max length, and candidate enum status
- use low/medium/high cardinality classes to decide capabilities
- all current export fields should be discoverable/selectable unless security policy blocks them
- low-cardinality category/status fields may allow `eq/in` and `groupBy`
- high-cardinality/free-text fields default to select-only or limited `eq/in`; `contains` requires explicit allowlist
- numeric/date/money fields can allow range filter and sort
- mechanical aggregation is allowlisted per field and function
- percent fields usually allow avg/min/max, not sum by default

Default return workflow:

- default responses return only a small useful set of identifying/common business fields
- sensitive, long text, noisy export, debug/source, and low-value fields are explicit-select only
- source lineage fields remain available where safe, but should not clutter default responses

Schema evolution:

- unknown columns in an uploaded workbook fail the import in baseline
- missing required columns fail the import in baseline
- confirmed renamed columns are added as aliases while preserving stable public field names
- semantic changes require a new field or lifecycle change, not silent reuse
- confirmed removed fields are marked deprecated/removed in a new registry version; MySQL columns may remain nullable for compatibility
- any schema change requires profiling, registry/schema diff review, migration, registry version bump, and tests

Baseline deliverables:

- repeatable profiling script/report for the two real workbook types
- complete `dishes` and `business` field registries
- MySQL migrations covering every current export column
- schema discovery exposing every current field with capabilities and limits
- import validation for full header set, multi-sheet consistency, date-window consistency, null/type rules, and unknown/missing columns
- registry snapshot tests and real-file acceptance tests
- profile/diff output sufficient for human review

P2:

- generated HTML/profile diff report
- field usage telemetry
- enum drift monitoring
- schema compatibility checker
- date bucket capability
- query-template migration helper
- unknown-column quarantine/profile-only mode
- index/capability suggestions that still require human approval

P3:

- runtime self-serve schema evolution
- user-defined datasets/schemas
- automatic acceptance of new queryable columns
- automatic fuzzy header matching
- cross-version semantic mapping
- JSON structured ingestion
- semantic metrics layer / derived business indicators
- per-tenant custom field capability configuration

## Structured Import Lifecycle

Phase 3 baseline uses conservative structured import lifecycle semantics: imports are auditable batches, not automatically replaceable mutable datasets.

See ADR 0019 for structured import lifecycle, archive, duplicate-window, and no-replacement baseline semantics.

Source document archive:

- when the source `Document` is archived, all rows derived from that document become immediately non-queryable
- rows may remain in MySQL for audit, troubleshooting, future recovery, and compliance retention
- query eligibility must include both `ImportBatch.status = applied` and `Document.status = active`
- permission scoping through the source document applies before detail rows, counts, aggregation, groupBy, and pagination
- archive effectiveness is the MySQL `Document.status` commit, not physical row deletion

Baseline `ImportBatch` states:

- `pending`: request created, waiting for worker
- `validating`: parsing/profiling/validating source file
- `applying`: validation passed and rows are being written
- `applied`: rows written and queryable only while the source document is active and visible
- `failed`: system/processing failure after retries
- `rejected`: deterministic validation/business failure, such as schema mismatch, invalid date window, active import conflict, or idempotency conflict
- `archived`: source document or batch archived; rows retained but non-queryable
- `canceled`: optional state for not-yet-applied work; not exposed to ordinary users in baseline

Query eligibility:

- source `Document` active
- `ImportBatch.status = applied`
- caller can access the source document labels/visibility
- employee/account is enabled

Hard delete / purge:

- no ordinary production hard delete or purge API in Phase 3 baseline
- local development purge command remains a dev/test utility, not a production feature
- production purge requires future admin-only design, retention policy, audit tombstones, OSS deletion semantics, backup implications, and likely a separate ADR/security review

Duplicate active window recovery:

- same idempotency key + same request fingerprint returns existing batch/status
- same idempotency key + different fingerprint returns `IDEMPOTENCY_KEY_CONFLICT`
- new request for an active/applied `{orgId,dataset,startDate,endDate}` returns `ACTIVE_IMPORT_EXISTS`
- new request for an in-progress same window returns `IMPORT_IN_PROGRESS`
- failed/rejected imports do not permanently occupy the active window; same idempotency key still returns that failed/rejected result, while a new key may retry according to the API contract
- if an existing active import is wrong, the baseline recovery path is explicit: archive the old source document/import batch, then upload a new file for the same window

Why replace/overwrite/append are deferred:

- they require version switching semantics for old/new rows
- they affect cursor consistency and aggregate interpretation
- they require stronger audit and rollback semantics
- they raise label/permission inheritance questions
- they complicate active-window claims and concurrency
- Phase 3 baseline therefore uses `archive old -> upload new`; admin-assisted atomic replacement is P2, self-serve overwrite/append/delta import is P3

Audit requirements:

- structured import requested
- source document uploaded
- validation started/succeeded/failed
- import applied
- active-window conflict rejected
- idempotency conflict rejected
- document/import archived
- import became non-queryable due to archive
- failed/rejected import summary
- permission-sensitive query/access events if required by the existing audit model

Audit metadata should include org, actor, document, import batch, dataset, business-date window, source hash, row count, sheet summary, action, status, error code, timestamp, and request id. Do not store full file contents or large row payloads in audit logs.

## MCP Surface

Phase 3 MCP remains a thin, permission-preserving adapter over the HTTP API. MCP must not become a second backend.

MCP must not:

- access MySQL, Qdrant, OSS, or model providers directly
- duplicate authorization logic
- implement separate structured query validation
- expose worker/admin/operator controls to employee-owned agents
- add business analysis or answer generation

HTTP API remains the canonical contract and test target. MCP request/response schemas should mirror HTTP contracts, pass through stable error codes, and be covered by contract tests or shared generated types.

Baseline employee-agent MCP tools:

- `search_document_evidence`: evidence-only retrieval over authorized MD/TXT/DOCX documents
- `list_structured_datasets`: schema discovery for dataset field registry, capabilities, operators, limits, lifecycle, and versions
- `query_structured_dataset`: controlled structured query wrapper for `dishes` / `business`
- `upload_structured_dataset`: structured CSV/XLSX upload through the same HTTP upload/import endpoint, including dataset, metadata, labels, idempotency key, active-window conflicts, audit, and import batch status
- `get_import_status`: status and safe validation errors for uploads/imports the caller can access

HTTP/admin-only surfaces:

- worker retry controls
- force reindex
- model provider config
- external model data-egress acknowledgement
- import claim repair
- Qdrant repair/delete jobs
- schema registry editing and field capability changes
- retrieval config migration/promotion/rollback
- operator dashboards
- audit export
- purge/delete administrative actions
- permission/label administration beyond already-approved employee surfaces

If retrying an upload is needed, it should use normal idempotent upload/request behavior through HTTP/MCP, not a worker-control MCP tool.

## Product Boundary

企业资料中枢 is a data and retrieval foundation for employee-owned agents. It is not an employee-facing AI agent, report generator, BI analyst, or answer-generation service.

For document retrieval, caller agents send retrieval queries such as `差评处理 SOP` or `客户反馈跟进`. The hub returns permission-filtered evidence chunks and metadata. It does not know the user's original question and does not generate natural-language answers.

For structured data, caller agents send controlled structured queries. The hub returns rows, column definitions, pagination metadata, source/import ids, and caller-explicit mechanical aggregates. It does not generate conclusions, trend judgments, recommendations, or business explanations.

Confirmed analogy: the hub acts like a BI data provider. If a boss asks finance "how much did we earn this week", finance may ask BI for sales data. BI does not need to know the boss's original question; it returns the requested data.

## Storage Responsibilities

MySQL stores:

- authoritative metadata
- organization and employee permission context
- upload and processing state
- audit logs
- CSV/XLSX structured rows for dishes and business datasets

The vector database stores:

- MD/TXT/DOCX chunk text
- embeddings
- chunk metadata
- retrieval index data

The stores remain linked by ids and metadata, including `orgId`, `documentId`, chunk/source ids, and model metadata. MySQL remains authoritative for document status and permissions. Vector DB hits must still be checked against MySQL before returning results.

MySQL is not the text RAG store. The vector DB is not the structured business-data table store.

Qdrant payload filters are a narrowing optimization, not the authorization source of truth. Evidence retrieval must:

1. authenticate the caller and resolve employee/account state in MySQL
2. reject disabled employees before retrieval
3. build authorized active document scope from MySQL labels/status/org context
4. query Qdrant with narrowing filters such as `orgId`, authorized `documentId`, file type, embedding/chunker version, and optional metadata
5. revalidate every returned chunk against MySQL before returning it
6. drop stale, archived, invisible, wrong-version, or otherwise unauthorized chunks
7. return source metadata from MySQL rather than trusting Qdrant payload as authoritative

Qdrant payload should include staleness/repair metadata such as:

- `orgId`
- `documentId`
- `chunkId`
- `documentVersion` or `contentVersion`
- `visibilityVersion`
- `documentStatusSnapshot`
- label visibility snapshot if useful for filtering
- `embeddingModel` and `embeddingVersion`
- `chunkerVersion`
- `sourceFileType`
- `sourceUpdatedAt`
- `indexedAt`

MySQL should track document status, labels, visibility/content versions, and indexing status by embedding/chunker version. Archive, label change, employee disable, and content replacement must take effect through MySQL immediately; Qdrant deletes/payload updates/reindex jobs may be asynchronous, because stale vector hits are filtered out by retrieval-time MySQL revalidation.

See ADR 0010 for the retrieval authorization decision.

## Document Evidence Retrieval

New Phase 3 uses hybrid evidence retrieval for MD/TXT/DOCX:

- file-aware parsing and chunking
- embedding-based dense vector search
- lexical/keyword retrieval
- candidate fusion
- reranking
- evidence-only response

Phase 3 default lexical retrieval should use Qdrant sparse vectors / native hybrid retrieval when supported by the selected Qdrant version and client. Dense embeddings, sparse lexical vectors, chunk text, and payload metadata should share the same Qdrant collection/chunk ids for the first production-grade implementation.

Rationale:

- one retrieval index to operate for MD/TXT/DOCX chunks
- same chunk ids and payload metadata for dense and lexical paths
- simpler consistency and reindex lifecycle
- lower operational burden than adding OpenSearch or Meilisearch in Phase 3
- avoids using MySQL as the chunk-level text search engine
- more production-suitable than in-process BM25

Tradeoff:

- Qdrant lexical tooling may be less mature than a dedicated search engine
- Chinese tokenization and keyword behavior must be validated on production-like documents
- retrieval adapter boundaries should allow future migration to Qdrant dense + OpenSearch/Meilisearch lexical if evaluation shows Qdrant lexical quality is insufficient

The retrieval service should expose an internal adapter boundary such as `HybridCandidateProvider` so backend migration does not change the external evidence API.

See ADR 0012 for the lexical index placement decision.

Evidence retrieval acceptance requires a golden evaluation suite before Phase 3 is considered production-usable.

Minimal golden corpus:

- 20-50 realistic MD/TXT/DOCX enterprise/business documents
- Chinese documents as first-class samples
- Markdown policies/procedures, TXT notes/plain exports, DOCX reports/manuals/contracts
- headings, subheadings, tables, numbered clauses, Chinese punctuation, mixed Chinese/English terms
- realistic product, store, dish, policy, feedback, and business terms
- permission scenarios including visible, hidden-by-label, archived, label-changed-after-indexing, disabled employee, and stale vector payload

Minimal query set:

- at least 100 judged queries
- each query records caller identity, expected visible document scope, relevant document/chunk/passages, unacceptable chunks where relevant, and query type
- query types include exact keyword lookup, semantic paraphrase, Chinese synonym/near-synonym, business terminology, policy/procedure lookup, table/clause lookup, ambiguous multi-candidate query, no-answer query, and permission-hidden relevant document

Metrics:

- `hitRate@k`
- `recall@k`
- `precision@k`
- `MRR@k`
- `NDCG@k` where graded relevance exists
- `permissionLeakCount`
- `archivedLeakCount`
- `stalePayloadLeakCount`
- no-answer false-positive rate
- retrieval and rerank p50/p95 latency

Suggested initial gates:

- permission/security leaks: zero tolerated
- archived/stale/disabled-user leaks: zero tolerated
- `hitRate@5` at least 85% on the initial golden set
- `recall@10` at least 80%
- `MRR@10` at least 0.70
- p95 latency tracked separately for candidate retrieval and rerank, with product-specific thresholds finalized in test docs

Baselines to compare:

- dense-only
- lexical-only
- hybrid dense + lexical
- hybrid + rerank

Hybrid + rerank should outperform dense-only and lexical-only on the golden set, or the release requires explicit review. Any change to chunking, embedding model, lexical config, rerank model, permission filtering, Qdrant payload schema, or retrieval fusion must run the suite. Release is blocked on any permission leak and should be blocked or explicitly approved on meaningful retrieval metric regression.

MD/TXT/DOCX source documents become evidence-queryable only after the complete evidence index is ready. A document must not become retrieval `active` before parsing, chunking, embedding, Qdrant upsert, lexical index availability, indexing metadata, OSS storage, MySQL metadata, and audit writes all succeed.

Evidence retrieval eligibility:

- source `Document` status is active
- a versioned document index record is ready
- content version matches retrieval policy
- embedding model/version matches retrieval policy
- chunker version matches retrieval policy
- lexical index version matches retrieval policy

If parsing, chunking, embedding, Qdrant upsert, lexical indexing, metadata commit, or audit write fails, the document remains out of evidence retrieval. The original source object should remain available for authorized diagnostics/download, but not as searchable evidence.

Retry behavior:

- retry creates a new `ProcessingRun`
- reuse the same source `Document` and OSS object when content did not change
- use idempotent chunk/vector ids based on document id, content version, chunker version, and chunk hash/ordinal
- Qdrant upsert should be idempotent
- successful retry marks the versioned index ready, then publishes the document as active
- content replacement increments content version and old chunks must not be retrieval-eligible

See ADR 0011 for the evidence-index active gate decision.

The API returns evidence, not answers.

Each evidence result should include at least:

- `document_id`
- `chunk_id`
- chunk text
- relevance score
- source title
- file type
- heading path or equivalent structure
- page/paragraph/position or equivalent locator
- matched-by details, such as dense, lexical, rerank
- embedding model metadata
- rerank model metadata
- rerank status

Rerank must be implemented as a capability and observability path. If no rerank model is configured, responses/logs must explicitly mark `rerank_disabled`.

## Chunking Rules

Fixed-size chunking such as `1024/512` must not be the primary strategy.

Markdown:

- chunk by heading hierarchy, lists, tables, code blocks, and natural section boundaries
- preserve heading path

DOCX:

- parse DOCX structure rather than treating it as plain text
- use title styles, paragraphs, tables, and page/paragraph positions where available

TXT:

- use paragraphs, blank lines, sentence boundaries, and semantic similarity

Fixed-size splitting is only an exceptional fallback for very long sections, malformed content, or unparseable structure. Fallback use must be marked in chunk metadata.

Each chunk must retain enough source location data for an employee-owned agent to cite or inspect the original source.

## Text Extraction Scope

Phase 3 evidence retrieval indexes text evidence extracted from MD/TXT/DOCX. It is not full layout understanding, OCR, image captioning, or embedded-object extraction.

Markdown baseline:

- preserve headings, lists, tables, code blocks, links, and natural section boundaries where parseable
- keep code blocks as text with `blockType=code`
- preserve heading hierarchy for chunk metadata

TXT baseline:

- extract plain text with deterministic encoding detection/fallback
- normalize line endings and excessive whitespace
- preserve line or character offsets for source traceability

DOCX baseline:

- extract normal body paragraphs
- extract DOCX table text in deterministic row/cell order
- include headers/footers and footnotes/endnotes only when parser support is reliable, marked as separate section types
- extract hyperlink display text and URL metadata where available
- handle tracked changes using one documented deterministic view, preferably accepted/current visible text if supported
- ignore comments unless extraction is reliable and explicitly marked
- do not OCR embedded images or screenshots

Hard-to-parse content:

- DOCX tables are in scope as serialized text evidence with table/row metadata where available
- embedded images/screenshots are not OCR'd in Phase 3; detect and warn, such as `embedded_image_not_indexed`
- unsupported embedded objects may be skipped with warnings if reliable main text is extracted
- malformed files fail processing and never become evidence-retrieval active
- hyperlinks are not crawled

Processing-run parser metadata should record parser name/version, file type, content hash, parse status, warnings/errors, extracted character/block counts, table/image/hyperlink/footnote counts, header/footer inclusion, comments inclusion, and track-changes mode.

Chunk metadata should include parser version and source location fields such as block type, heading path, paragraph index, table index, row range, page number if available, and char start/end if available.

Deferred beyond Phase 3:

- OCR for images/screenshots/scanned docs
- image captioning
- layout-aware DOCX rendering
- embedded object extraction
- comment-thread search
- semantic table understanding
- cross-reference resolution
- PDF support unless separately scoped
- hyperlink crawling
- page-perfect DOCX citations

See ADR 0013 for the text extraction scope decision.

## Vector Database Choice

Default Phase 3 vector database: Qdrant.

Rationale:

- suitable for MD/TXT/DOCX retrieval indexes
- supports payload metadata filtering
- fits the MySQL authoritative metadata split
- lighter operational footprint than Milvus for the current phase
- avoids introducing PostgreSQL solely for pgvector while the authoritative DB remains MySQL

Milvus remains a future option for very large vector counts, GPU retrieval, or heavier distributed-cluster throughput.

pgvector is not the default for Phase 3 because the current authoritative database is MySQL. If the system later moves to PostgreSQL, pgvector can be reevaluated.

## Model Configuration

Embedding and reranking may use external model APIs.

Model provider and endpoint must be configured, not hard-coded. The current variable names are:

- `LLM_PROVIDER`
- `LLM_MODEL`
- `LLM_EMBEDDING_MODEL`
- `OPENAI_COMPATIBLE_API_KEY`
- `OPENAI_COMPATIBLE_BASE_URL`

Secrets must be read only from the runtime environment. Do not commit or print actual secret values.

Embedding and rerank are different model responsibilities:

- embedding turns query/chunk text into vectors for recall
- rerank scores query + candidate chunk pairs for final ordering

They may share a provider but should not be treated as the same model capability.

Each indexed chunk must record embedding model name, dimension, and model/config version. Rerank calls must record rerank model name/version when enabled.

Phase 3 baseline must include real rerank provider integration. Local/CI can use deterministic fake rerank, and quality tuning can happen late in Phase 3, but adapter/provider/config/call-chain/status recording cannot be deferred. Production-like readiness should fail if a real rerank provider is expected but missing. Any explicitly disabled local/test rerank path must return and log `rerank_disabled` rather than implying rerank was performed.

Embedding and rerank still use environment/secret configuration for operational simplicity. The runtime resolves those env values into an explicit retrieval config record/version. Model changes must then be handled as versioned retrieval infrastructure changes, not as invisible `.env` edits that silently alter retrieval behavior.

Required version metadata:

- document/content version
- chunker version
- embedding provider/model/dimension/version
- embedding config hash
- lexical index version
- rerank provider/model/version when enabled
- retrieval config version
- indexedAt / promotedAt timestamps where applicable

Embedding migration strategy:

- update env/secret values for the candidate provider/model, then register the resolved retrieval model config as candidate
- build embeddings into a new versioned Qdrant collection or equivalent parallel index
- use a separate collection when embedding dimensions change
- do not query old vectors with new query embeddings
- run golden retrieval evaluation old versus new
- promote the new retrieval config only after acceptance gates pass
- retain old index during a rollback window
- retire/delete old vectors only after the retention window

Query-time model selection:

- default retrieval uses the active retrieval config for the environment/org
- caller agents do not choose arbitrary embedding/rerank models
- internal/admin evaluation can override config in controlled paths
- evidence responses include retrieval/index version metadata

Rerank migration:

- rerank does not require reindexing, but still requires versioned config and golden evaluation
- rerank rollback should be independent from embedding rollback where possible
- if rerank is disabled or falls back to hybrid score ordering, response metadata must say so

Cost and reliability safeguards:

- cap rerank candidate count
- cap returned evidence count
- timeout external model calls
- batch embedding calls during indexing
- rate-limit migration jobs
- track provider cost, latency, error rate, retry count, and token/input size
- do not automatically re-embed the full corpus on config change without an explicit migration job
- fail indexing closed when embedding fails
- do not silently use mismatched fallback embeddings

See ADR 0014 for retrieval model versioning and migration.

Priority note: keep the configuration source simple in Phase 3. Env/secret values remain the input mechanism; registry/config records provide traceability, compatibility checks, and migration control.

External model providers are explicit external data processors. Phase 3 must not send content to embedding/rerank providers implicitly or without admin configuration and acknowledgement.

Data sent to providers:

- embedding indexing sends document chunk text
- embedding retrieval sends query text
- rerank sends query text plus candidate chunk text/snippets

Providers must not receive raw files, full documents, user secrets/tokens, internal auth headers, employee private metadata, unrelated tenant/org data, or label/org/employee names when opaque ids are sufficient.

Data minimization:

- send only text needed for the model call
- cap rerank candidate count and chunk length
- avoid source file names, employee names, label names, and org names in provider metadata unless required
- do not batch multiple orgs into one external model request

Secret handling:

- provider API keys come only from runtime environment or secret manager
- `.env.example` lists variable names only
- secrets must not appear in logs, traces, audit records, errors, or client responses
- model config should be referenced by internal config id

Logging:

- do not log raw chunk text, raw document text, full query text, or provider request/response bodies by default
- safe logs may include provider, model, config id, orgId, documentId, chunkId, content/index versions, token/character counts, latency, status/error code, retry count, and cost estimate
- content debug logging is out of Phase 3 unless separately designed with strict admin controls and short retention

Audit metadata should record external processing without payload text:

- orgId
- actor or system actor
- documentId / processingRunId / retrievalRequestId where applicable
- provider/model/version
- external processing type: embedding or rerank
- content/chunker/embedding version
- input/chunk/token counts
- status and timestamp

Retry/fallback:

- retries are bounded with backoff and do not expand payload scope
- indexing provider failure leaves the document/index version not ready
- retrieval provider failure returns controlled error or uses only an explicitly configured safe fallback
- the system must not silently send data to another provider

Admin acknowledgement:

- admins must explicitly configure and acknowledge external model data egress before embedding/rerank is enabled
- acknowledgement states that document chunks and retrieval queries may be sent to configured providers, and rerank sends query plus candidate evidence chunks
- acknowledgement records provider/model/region where applicable

See ADR 0015 for external model data-egress boundaries.

## Structured Upload Scope

CSV/XLSX are only supported for two datasets:

- `dishes`
- `business`

The upload metadata must explicitly provide:

- `dataset`: `dishes` or `business`
- `enterprise_name`
- `start_date`
- `end_date`

`start_date` and `end_date` use `YYYYMMDD` and refer to `business_date`, not `order_time`.

`enterprise_name` is a display and canonical file-name component. It is not the durable enterprise key, permission key, duplicate-import key, or query key.

The durable enterprise boundary uses the existing organization context:

- `Organization.id`
- `orgId`
- authenticated employee's server-side org context

Current implementation evidence: Prisma has `organizations.id` and `documents.orgId`, and authenticated API paths derive organization scope from the reloaded employee record rather than a caller-supplied org parameter or `defaultOrgId()` fallback.

Structured imports should introduce an `ImportBatch` or equivalent first-class model in MySQL. A CSV/XLSX upload is both a source document asset and an atomic dataset import; `Document` alone should not carry row-level lineage, idempotency, validation status, import window uniqueness, and rollback/audit boundaries.

Minimal relationships:

- `Document` remains the uploaded source file, permission, state, and OSS asset anchor
- `ImportBatch` represents one structured import attempt/result for one dataset and one declared business-date window
- `ProcessingRun` should reference both `Document` and `ImportBatch` for structured import runs
- `DishRow` and `BusinessRow` rows belong to exactly one `ImportBatch` and retain `documentId` for lineage
- audit logs for structured data changes should reference both `Document` and `ImportBatch`

Structured rows inherit source document permissions. A caller may query rows from an import batch only if they are authorized to access the source `Document` that produced that batch. `orgId` and dataset alone are not sufficient authorization. Backend permission predicates must be applied before row filtering, aggregation, grouping, sorting, and pagination.

The shared source-document visibility policy is: disabled employees are denied; same-org admins can access supported management/status paths; active same-org non-admin employees need either `all_staff` on the source document or an intersection with their current labels. This policy applies consistently to evidence retrieval, structured import status, and structured query.

`ImportBatch` should include at least:

- `id`
- `orgId`
- `documentId`
- `dataset`
- `startDate`
- `endDate`
- `sourceOssObjectKey`
- `sourceContentHash`
- `schemaRegistryVersion`
- `status`: pending, validating, applied, failed, rejected, canceled
- `idempotencyKey`
- `requestFingerprint`
- `rowCount`
- `validationErrorCount`
- `processingRunId`
- `createdBy`
- timestamps such as `createdAt`, `appliedAt`
- rejection/error summary fields

Phase 3 should not include automatic `replacesBatchId`, superseding, append, overwrite, or reuse semantics.

The hardened import flow is reservation-first: parse/profile/validate and compute the request fingerprint before storage publication; reserve source `Document`, `ImportBatch`, `ImportWindowClaim`, deterministic storage key, and started audit in one database transaction; write storage only for the reserved key; then apply rows, activation, processing-run success, and applied audit in one transaction. Exact replay reuses the persisted IDs/key and cannot produce duplicate objects, rows, claims, or audits.

## Canonical Naming

User-uploaded filenames may be arbitrary. They are preserved as original metadata only and must not drive business logic.

Canonical import/source names:

- `{enterprise_name}_dishes_{start_date}_{end_date}`
- `{enterprise_name}_business_{start_date}_{end_date}`

After validation, the source file copy in OSS should be stored once under the canonical import batch name. Do not split multi-day XLSX/CSV uploads into daily OSS files. Day-level filtering is handled through MySQL fields such as `business_date`.

## Spreadsheet Validation

CSV/XLSX imports are whole-file atomic.

The file becomes active only after all of the following succeed:

- source file is saved to OSS
- schema validation passes
- metadata/content consistency validation passes
- all rows are written to MySQL using a transaction or equivalent atomic flow
- import batch/source document records are written
- audit log is written

Any failure keeps the upload out of ordinary structured query results.

Validation must be robust against real exports. Some real rows have empty cells; nullable fields must be defined from real sample data and should not be treated as malformed simply because they are blank.

The dishes and business MySQL schemas and structured API field registry must fully cover the current real export column sets. Do not implement only a demo subset of fields. If a field exists in the supported real export, the caller's agent should be able to discover its definition and request it through the structured API when authorized.

Complete coverage does not mean every field supports every query capability. Phase 3 uses a complete but capability-scoped field registry: every current export field has a public canonical definition, while filter/sort/group/aggregation/operator support is declared per field.

Each structured field must define:

- canonical name
- source header aliases
- data type
- nullable status
- allowed operators
- sortability
- aggregation eligibility
- sensitivity class
- volatility/compatibility status, such as stable, provisional, deprecated
- whether returned by default
- whether selectable only by explicit projection
- whether redaction or masking applies
- indexing status
- value limits, such as max string length, max filter values, or range bounds

Query safety rules:

- all current export fields are discoverable through schema metadata
- fields are selectable unless explicitly blocked by security policy
- filtering/sorting/aggregation/grouping require per-field allowlist capability
- free-text or high-cardinality fields should not receive unbounded `contains`, grouping, or broad sorting by default
- non-indexed fields may be selectable but should have restricted filter/sort support unless promoted after review
- the query compiler must reject plans that exceed safe bounds before executing SQL
- field capability metadata and physical indexing metadata should be separate, so API compatibility does not require indexing every column

See ADR 0007 for the complete coverage and capability-scoped API decision.

Schema discovery:

- Phase 3 should expose `GET /structured/datasets` as the minimal schema discovery API
- the response includes API/schema version, dataset metadata, dataset limits, registry version, and field registry entries
- add `GET /structured/datasets/{datasetId}` only if the combined registry payload is too large
- caller agents must use discovery before constructing structured queries or cache it with registry-version checks
- caller agents must not assume every field supports filtering, sorting, grouping, or aggregation just because it exists
- caller agents should use stable public field names rather than source/export column names

Discovery metadata should include:

- `apiVersion`
- `schemaVersion`
- per-dataset `registryVersion`
- dataset `status`
- default/max page size
- boolean tree and `in` list limits
- field name, source columns, type, nullable, description
- sensitivity and lifecycle status
- capabilities and allowed operators
- default-return behavior
- indexing status
- deprecation/replacement metadata where applicable

Failure responses should be actionable without leaking internals. Return structured error details such as:

- `error_code`
- `summary`
- `failed_stage`
- `sheet_name`
- `row_number`
- `field`
- `reason`
- a bounded set of example validation errors

Full internal stack traces belong in service logs only, not API responses.

Metadata date consistency:

- all table `business_date` values must fall inside the metadata closed interval
- minimum table `business_date` must equal `start_date`
- maximum table `business_date` must equal `end_date`
- mismatch fails the whole file
- the hub must not infer or repair caller-supplied metadata

Header mapping:

- column order may vary
- headers map through a static controlled alias map to canonical MySQL fields
- example: `营业日 -> business_date`
- alias mapping is not semantic inference

Header detection:

- do not hard-code row 3 as the header
- scan the first 10 rows
- exactly one row must satisfy the target schema header mapping
- zero or multiple candidates fail the file

XLSX sheet rules:

- multiple sheets are supported
- fully empty sheets may be ignored
- every non-empty sheet, including hidden or explanation sheets, must match the same declared dataset schema
- a workbook cannot mix `dishes` and `business`
- any non-conforming non-empty sheet fails the whole file

Unknown extra columns, missing required fields, duplicate canonical mappings, unmapped headers, and type failures all fail the whole file.

Structured ingestion acceptance requires real-export and adversarial fixtures before Phase 3 is considered production-usable.

Minimum acceptance datasets:

- the provided 67k-row dishes workbook
- the provided 151-column business workbook
- small hand-made CSV and XLSX fixtures for both datasets
- invalid variants for missing required columns, unknown extra columns, renamed columns, invalid date windows, bad numeric/date values, wrong dataset metadata, duplicate active windows, empty rows, row-level validation errors, and multi-sheet edge cases

Full column coverage tests:

- every current export column maps to a stored field
- every current export column appears in schema discovery
- every field includes canonical name, source aliases, type, nullable rule, capabilities, sensitivity, lifecycle, indexing, and value constraints
- registry output for `dishes` and `business` is snapshot-tested

Real sample profiling before finalizing validators:

- blank/null rate per column
- inferred type consistency
- maximum string lengths
- enum/cardinality candidates
- min/max numeric and date values
- currency/percent/unit formatting
- weird whitespace and Chinese punctuation
- duplicate source rows
- formula cells versus displayed values
- sheet names, hidden status, and empty/non-empty sheets

Multi-sheet acceptance:

- inspect every sheet in the workbook
- ignore and record empty sheets
- every non-empty sheet, including hidden sheets, must match the declared dataset schema and metadata business-date window
- matching hidden non-empty sheets participate in import; hidden sheets are not silently skipped
- any non-empty sheet that does not match schema or date window fails the whole workbook
- the workbook imports atomically across all accepted non-empty sheets
- `ImportBatch` records imported sheet count, ignored empty sheet count, imported sheet names, ignored empty sheet names, and per-sheet row counts
- row tables include `sourceSheetName`, `sourceSheetIndex`, `sourceSheetHidden`, `sourceRowNumber`, and `sourceRowHash`
- validation errors include sheet name/index/hidden status, row number, column name, error code, and reason

Atomicity and idempotency tests:

- validation failure creates no queryable rows
- mid-import DB failure leaves no active batch
- worker crash before commit leaves no active rows
- retry cannot double-insert rows
- failed batch is auditable but not queryable
- existing active imports remain untouched when a new import fails
- same idempotency key + same fingerprint returns the same batch/status
- same idempotency key + different fingerprint fails
- new idempotency key + existing active window returns conflict
- concurrent uploads for the same window produce exactly one winner

Permission inheritance tests:

- authorized caller can query visible batch rows
- unauthorized caller receives no rows and no aggregate leakage
- aggregation applies permission before grouping/counting
- source document label changes affect structured row visibility
- source document archival removes rows from query visibility or marks the batch non-queryable according to lifecycle rules

Performance acceptance:

- the 67k-row dishes workbook parses, validates, and inserts within a product-defined threshold on local/staging hardware
- the 151-column business workbook maps and stores every column without DB packet/statement issues
- importer uses streaming/batched parsing and bulk insert; memory should not scale with entire workbook size where avoidable
- metrics record rows parsed, rows inserted, validation errors, duration by phase, batch id, source hash, sheet counts, and per-sheet row counts
- representative filters and paginated queries on imported data meet p95 targets defined in test docs

This belongs in acceptance/test documentation rather than a separate ADR; ADRs 0007, 0008, and 0009 cover the architectural decisions being verified.

Duplicate import policy:

- if an active/applied import already exists for `{orgId, dataset, start_date, end_date}`, a new upload fails with a conflict such as `ACTIVE_IMPORT_EXISTS`, even if the file is byte-identical
- no automatic overwrite
- no automatic append
- explicit replacement import can be designed later
- no automatic reuse for new duplicate uploads
- retrying the same request uses idempotency key + request fingerprint and returns the existing in-progress/success/failure status rather than creating a duplicate batch
- the same idempotency key with a different request fingerprint fails as an idempotency conflict
- pending/validating imports for the same window block concurrent new uploads with an in-progress conflict
- failed imports do not block the window forever; a new attempt after failure requires a new idempotency key and no active/in-progress claim

Because MySQL partial unique indexes are limited, Phase 3 should use an `ImportWindowClaim` table or equivalent transactional claim keyed by `{orgId, dataset, startDate, endDate}` to prevent concurrent imports and active duplicates.

Permission enforcement for structured query:

- `Document` remains the permission anchor
- `ImportBatch.documentId` points to the source document
- row tables should retain `orgId`, `importBatchId`, and `documentId`
- structured queries must restrict rows to visible source documents/import batches
- hidden batches must not leak through counts, sums, groups, pagination counts, or error messages
- if visible and hidden active batches exist for different windows, a query includes only visible rows rather than failing because hidden batches exist
- row-level labels independent from the source document are out of scope for Phase 3

Useful indexes include:

- `(orgId, dataset, documentId)`
- `(orgId, dataset, importBatchId)`
- field-specific indexes from the registry

See ADR 0009 for the structured row authorization decision.

## Structured Query API Boundary

The structured query API receives a controlled JSON query structure. It does not accept raw SQL, SQL fragments, `WHERE` clauses, `LIKE` snippets, regexes, arbitrary expressions, arbitrary functions, writes, deletes, inserts, or DDL.

The design may mirror common Java/MySQL query-wrapper or specification style APIs: readable JSON, semantically close to normal MySQL querying, but validated and compiled by the server into parameterized SQL.

Structured API errors must use a stable machine-readable envelope. Caller agents must not parse prose to decide how to recover.

Error envelope fields:

- `code`
- safe `message`
- `retryable`
- `details`
- `requestId`

Core structured query error codes should include:

- `INVALID_QUERY`
- `INVALID_FIELD`
- `UNSUPPORTED_OPERATOR`
- `UNSUPPORTED_CAPABILITY`
- `TYPE_MISMATCH`
- `INVALID_AGGREGATION`
- `INVALID_DATE_WINDOW`
- `LIMIT_EXCEEDED` or `QUERY_TOO_LARGE`
- `REGISTRY_VERSION_UNSUPPORTED`
- `REGISTRY_VERSION_MISMATCH`
- `DATASET_FORBIDDEN`
- `ACTIVE_IMPORT_EXISTS`
- `IMPORT_IN_PROGRESS`
- `IDEMPOTENCY_KEY_CONFLICT`
- `TEMPORARILY_UNAVAILABLE`
- `INTERNAL_ERROR`

Registry/version behavior:

- callers may include an expected `registryVersion`
- if omitted, the current registry is used
- if provided and still supported, execute against that registry semantics where feasible
- if no longer supported, return `REGISTRY_VERSION_UNSUPPORTED`
- incompatible field/capability changes return registry/capability errors with safe details
- successful responses include effective `registryVersion`

Permission-hidden data behavior:

- hidden rows/import batches are scoped out, not reported
- no visible rows is a successful empty result, not an error
- aggregate over no visible rows returns empty groups or zero counts according to query shape
- dataset-level denial returns `DATASET_FORBIDDEN`
- never reveal hidden counts, hidden import ids, or hidden field values in errors

Warnings should communicate non-fatal behavior such as deprecated field use, provisional field use, result truncation, or fallback sort.

Detailed error code definitions belong in API contract and acceptance tests, not a standalone ADR unless the compatibility strategy changes materially.

Allowed capabilities are service-defined:

- dataset allowlist
- field allowlist
- per-field operator allowlist
- sorting
- pagination
- explicit grouping and mechanical aggregation

Confirmed operator family:

- `eq`
- `neq`
- `in`
- `not_in`
- `gt`
- `gte`
- `lt`
- `lte`
- `between`
- `contains`
- `starts_with`
- `ends_with`
- `is_null`
- `is_not_null`

Each field must declare allowed operators, type, nullable status, and value constraints.

AND/OR condition trees are supported, but depth, total condition count, `in` list length, and other complexity limits will be finalized later in the API contract and implementation.

Explicit mechanical aggregation is allowed. The service must not infer aggregation from natural-language intent. If the caller does not send `metrics` / `group_by`, the service returns matching records.

Aggregation is a mechanical query primitive, not a semantic metrics layer or analysis service.

Field registry aggregation metadata should distinguish:

- `groupBy` capability
- `aggregateInput` capability
- allowed aggregate functions
- group cardinality limits
- whether grouping requires an indexed/bounded field
- units and scale for money, rate, percentage, or quantity fields

Supported aggregate functions for Phase 3:

- all field types: `count`
- bounded string/enum/status/category fields: `countDistinct`, `groupBy` when allowed
- numeric/decimal/integer fields: `sum`, `avg`, `min`, `max` when arithmetic is semantically valid
- date/datetime fields: `min`, `max`, and only explicitly modeled buckets such as day/month if implemented
- boolean fields: `count`; `sum` only if explicitly meaningful for that field

Avoid in Phase 3:

- percentiles and medians
- window functions
- arbitrary formulas
- cross-dataset joins
- server-side derived metrics such as growth rate, share, conversion, ranking explanation, or trend labels
- natural-language analysis or chart-ready conclusions
- `HAVING` unless later expressed as a separate controlled aggregate-filter capability

Aggregation safety limits should be defined in the API contract, including maximum group-by fields, aggregate functions per query, returned groups, grouped page size, boolean tree depth, `IN` list size, query timeout, scanned-row guardrails, and deterministic sort requirements for grouped pagination.

Authorization filters must apply before aggregation. Aggregate queries touching sensitive fields should be audited.

Structured query responses should include:

- `rows`
- `columns`
- accepted/normalized controlled query echo
- pagination metadata
- row count/truncated flags
- dataset metadata
- source/import batch/document ids

No business explanation is returned.

Pagination is required:

- default `limit`
- maximum `limit`
- cursor-based continuation
- no unbounded one-shot full export path in Phase 3

## Deferred Or Out Of Scope

Structured entity/name expansion is out of scope for new Phase 3.

Example deferred capability: expanding `肉夹馍` to candidate real dish names such as `青椒肉夹馍` or `优质肉夹馍`.

The current Phase 3 baseline should use deterministic structured querying only. Entity expansion can be designed later as a separate feature.

## Phase 3 Priority Split

Use the repository priority language:

- Baseline / MVP-critical: required for the new Phase 3 to safely upload, process, authorize, retrieve, and query.
- P2: required for small internal beta quality, but not needed for the narrowest production-grade baseline.
- P3: explicitly deferred until after beta.

### Baseline / MVP-Critical

- `Document` plus `ImportBatch` model for structured CSV/XLSX
- no-overwrite active import policy for `{orgId, dataset, startDate, endDate}`
- idempotency handling that distinguishes true retries from new duplicate uploads
- full current export column coverage for `dishes` and `business`
- capability-scoped field registry for every current export column
- schema discovery endpoint for datasets, fields, capabilities, limits, and versions
- controlled structured query API: no raw SQL, allowlisted fields/operators, bounded filters, pagination, explicit select, permission scoping before filtering/aggregation
- minimal mechanical aggregation: `count`, numeric `sum`/`avg`/`min`/`max`, date/numeric `min`/`max`, group-by only where explicitly allowed
- CSV/XLSX validation: full columns, deterministic type/null handling, multi-sheet same-schema/same-window rule, atomic failure, real workbook performance acceptance
- structured row permission inheritance from source `Document` labels
- MD/TXT/DOCX evidence ingestion: text parsing, DOCX table text extraction, file-aware chunking, embeddings, lexical index, Qdrant upsert, audit/metadata writes, active only after full index readiness
- evidence retrieval: MySQL authorization/status source of truth, Qdrant filters as optimization, MySQL revalidation before return, hybrid dense + lexical retrieval, rerank, evidence-only response
- external model config through env/secret values, secrets outside repo, no raw payload logging, explicit admin acknowledgement of model data egress
- golden evaluation gates for retrieval quality/security and structured importer acceptance, with zero permission/archive/stale leaks

### P2

- richer schema-discovery ergonomics: descriptions, lifecycle, sensitivity/volatility display, registry diff/checksum
- better structured query diagnostics: rejected-query reasons, field capability errors, query-limit warnings
- query template validation against registry versions
- stronger aggregate guardrails: aggregate aliases, deterministic aggregate pagination/sorting, group-count truncation warnings
- import profiling report per batch: null rates, cardinality estimates, max lengths, parse warnings
- downloadable validation error report
- explicit `ImportWindowClaim` operational hardening if not included in the baseline implementation detail
- structured query performance tuning based on beta usage
- retrieval quality CLI/report for golden-set regressions
- stale Qdrant payload repair job and metrics
- reindex job visibility, failed-run retry UX/API, and admin-facing document non-queryable reasons
- versioned retrieval config promotion/rollback workflow for internal operators
- provider cost/latency metrics and circuit-breaker alerts
- Chinese tokenizer/relevance tuning beyond the minimum acceptance gate
- DOCX parser warnings surfaced clearly in document status/details

### P3

- OCR for embedded images, screenshots, and scanned documents
- image captioning or visual document understanding
- PDF support unless separately scoped
- crawling hyperlink targets
- comment-thread search, rich track-changes semantics, or legal-grade DOCX redline interpretation
- layout-perfect DOCX citations/page rendering
- semantic table understanding beyond serialized table text
- cross-dataset joins between `dishes` and `business`
- arbitrary formulas, window functions, percentiles, median, custom metrics, or HAVING-style analytical queries
- natural-language-to-structured-query generation inside Enterprise Hub
- server-generated analysis, summaries, recommendations, dashboards, or reports
- dedicated OpenSearch/Meilisearch deployment unless Qdrant sparse/hybrid fails evaluation
- multi-provider automatic fallback that silently sends data to a different external model provider
- per-row independent permissions separate from source `Document` labels
- automatic overwrite, append, replacement, or reuse of active structured imports
- JSON structured ingestion
- user-facing AI agent behavior inside Enterprise Hub
- static SDK generation from schema discovery
- org-specific custom schema authoring beyond the two current datasets
- advanced tenant-specific model routing unless beta customers require it

## Evidence Gathered

Current code baseline:

- worker currently treats `.txt`, `.md`, `.csv`, and `.json` as UTF-8 text
- worker splits on line boundaries and blank lines
- chunks are stored in MySQL
- search is in-process lowercase substring matching
- no DOCX parsing
- no XLSX parsing
- no strict spreadsheet schema validation
- no embeddings
- no vector DB
- no hybrid retrieval
- no rerank

Sample workbook facts:

- `maijia_dishes_20260701_20260705.xlsx`
  - sheet name: `菜品主题数据`
  - title row: row 1
  - filter description row: row 2
  - header row in sample: row 3
  - 51 columns
- `maijia_business_20260701_20260705.xlsx`
  - sheet name: `营业分组表`
  - title row: row 1
  - filter description row: row 2
  - header row in sample: row 3
  - 151 columns

Date check on the dishes sample:

- 67,581 comparable rows
- 1,235 rows have `下单时间` calendar date different from `营业日`
- therefore `order_time` and `business_date` must remain distinct fields
- the hub defines fields; caller agents decide which field maps to user intent

## Existing Docs To Update Later

Phase insertion:

- insert new Phase 3 after current Phase 2
- current Phase 3 becomes Phase 4
- current Phase 4 becomes Phase 5
- update every phase reference to avoid ambiguity

Known files with phase references include:

- `AGENTS.md`
- `README.md`
- `README.zh.md`
- `docs/implementation/agent-handoffs.md`
- `docs/implementation/api-contract.md`
- `docs/implementation/env-inventory.md`
- `docs/implementation/implementation-plan.md`
- `docs/implementation/staging-readiness.md`
- `docs/implementation/progress.md`
- `docs/implementation/server-runtime-prerequisites.md`
- `docs/implementation/test-cases.md`

The existing `phase-3-readiness.md` has been renamed to `staging-readiness.md` after user confirmation. Historical references may still mention the former path.

## Continue Updating This File

For every remaining grilling decision:

1. Append the confirmed decision here.
2. Reflect product-language changes in `docs/context/CONTEXT.md`.
3. Do not add a `progress.md` row for each design decision.
4. Add at most one concise `progress.md` summary when this design artifact is created, materially completed, or handed off.
5. Only after decisions are settled, update implementation-plan, API contract, env inventory, readiness docs, and test cases.
