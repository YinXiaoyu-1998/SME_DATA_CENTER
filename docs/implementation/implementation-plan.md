# 企业资料中枢 Implementation Plan

Last updated: 2026-07-13

## Product Boundary

企业资料中枢 is a backend retrieval/data foundation for employee-owned agents, MCP clients, API clients, and minimal admin operations.

It must not become:

- an employee-facing AI chat agent;
- a report or dashboard generator;
- a skill execution platform;
- a natural-language-to-SQL service;
- a client-side authorization/filtering system.

The active public product surface is Phase 3-only:

1. Evidence documents: `upload_evidence_document` → evidence indexing → `get_evidence_document_status` / `search_document_evidence`.
2. Structured datasets: `upload_structured_dataset` → strict MySQL import → `get_import_status` / `list_structured_datasets` / `query_structured_dataset`.

The old ordinary document upload/search/detail/download/archive public surface has been removed. The internal documents catalog remains as source-file, label, status, storage, processing, and audit infrastructure.

## Phase Summary

| Phase | Status | Scope |
| ----- | ------ | ----- |
| Phase 1 | Complete / internalized | Core API, auth, labels, source document catalog, storage, audit, local seed data |
| Phase 2 | Complete / current MCP adapter retained | Local MCP login/session, labels, skills, Phase 3 tool adapter surface |
| Phase 3 | Implemented, final cleanup in progress | Production-grade retrieval/data foundation before online launch |
| Phase 4 | In progress | Go-online/staging deployment readiness; runtime/ACR/TLS/fixture-smoke slice is deployed |
| Phase 5 | Not started | Post-launch operations, beta feedback, hardening |

## Phase 3 Scope

### Evidence Retrieval

Supported files:

- Markdown
- TXT
- DOCX

Required behavior:

- semantic/layout-aware parsing and chunking;
- embedding through configured provider;
- Qdrant evidence index with dense/vector retrieval, lexical signal, payload filters, and rerank metadata;
- backend authorization and metadata filters before returning evidence;
- no direct final answer generation;
- no fallback to primitive fixed-size text chunk keyword search.

Active HTTP endpoints:

- `POST /v1/documents/evidence`
- `GET /v1/documents/evidence/:documentId/status`
- `POST /v1/evidence/search`

Active MCP tools:

- `upload_evidence_document`
- `get_evidence_document_status`
- `search_document_evidence`

Done criteria:

- upload stores source file and labels;
- worker indexes into Qdrant with versioned retrieval config;
- status exposes document/index readiness to uploader/admin only;
- search returns evidence chunks and metadata for visible active ready documents only;
- inaccessible documents do not leak title, filename, chunk text, row count, or existence.

### Structured Data

Supported files:

- CSV
- XLSX

Supported datasets:

- `dishes`
- `business`

Required behavior:

- metadata supplies enterprise identity/name, dataset, business-day `startDate`/`endDate`, idempotency key, and labels;
- file name is not trusted for business logic;
- every sheet/table in an XLSX must satisfy the dataset structure;
- controlled header aliases map uploaded headers to canonical fields;
- entire import fails atomically on validation/date/permission/idempotency/active-window failure;
- ingestion validates CSV/XLSX format and resource limits before storage or DB publication;
- exact idempotent replay returns the first persisted document/batch/storage key rather than creating duplicates;
- imported rows are stored in dataset-specific MySQL tables;
- structured query is controlled read-only JSON, not raw SQL;
- numeric/date comparisons, sorting, and aggregates use field-type semantics rather than string ordering.

Active HTTP endpoints:

- `POST /v1/structured/imports`
- `GET /v1/structured/imports/:importBatchId`
- `GET /v1/structured/datasets`
- `POST /v1/structured/query`

Active MCP tools:

- `upload_structured_dataset`
- `get_import_status`
- `list_structured_datasets`
- `query_structured_dataset`

Done criteria:

- strict schema/date-window validation;
- source file storage and audit;
- atomic MySQL row import;
- backend permission filtering;
- no mutation operators exposed through query;
- explicit mechanical aggregates are supported only when requested by the query.

### Phase 3 Hardening Baselines

- Organization scope is derived only from the authenticated employee record.
- Document visibility uses one shared policy: disabled denied, same-org admins allowed on supported management paths, active same-org non-admins allowed by `all_staff` or current label intersection.
- Structured imports use reservation-first idempotency and deterministic storage keys.
- Evidence search uses signed opaque cursor pagination; each page reruns retrieval and authorization.
- Worker processing uses database leases, heartbeat, retry classification, and bounded worker concurrency.
- Parser/import resource limits and evidence document/chunk limits are enforced from typed runtime config.

### Removed Legacy Surface

The following are intentionally absent and must remain covered by negative tests/removal notes only.

Removed endpoints:

- `POST /documents`
- `GET /documents`
- `GET /documents/:id`
- `GET /documents/:id/download`
- `GET /documents/:id/status`
- `POST /documents/:id/archive`
- `POST /documents/:id/labels`

Removed MCP tools:

- `enterprise_hub_upload_document`
- `enterprise_hub_get_document_status`
- `enterprise_hub_search_documents`
- `enterprise_hub_get_document`
- `enterprise_hub_get_document_download_url`
- `enterprise_hub_archive_document`

Removed local CLI surface:

- root `npm run hub`
- `apps/cli`
- `hub documents ...`

## Current Phase 3 Cleanup Workstream

Branch: `codex/remove-legacy-upload-search`

### Task A: API / Worker Cleanup

Scope:

- remove old public API routes;
- keep internal document catalog/storage/labels/audit helpers needed by evidence and structured flows;
- add evidence status endpoint;
- remove worker legacy text extraction fallback;
- require explicit processing job type;
- fail unsupported worker job types explicitly.

Done criteria:

- old public routes return 404;
- evidence upload/status/search still work;
- structured import/query still work;
- worker only processes `evidence_document_index`;
- `legacy_text_extract` is removed from active domain enum and Prisma schema.

### Task B: MCP / CLI / Smoke Cleanup

Scope:

- remove old MCP tools and tool bodies;
- add `get_evidence_document_status`;
- remove CLI package and root script;
- rewrite integration and MCP smoke tests to Phase 3-only.

Done criteria:

- MCP tool list contains only current tools;
- old tool names are covered by negative tests only;
- no active `hub documents` command remains;
- local MCP smoke covers login, labels, structured import/status/query, evidence upload/status/search.

### Task C: Docs / Skills Cleanup

Scope:

- update repo-local `skills/enterprise-hub-mcp/SKILL.md`;
- sync standalone `enterprise-hub-mcp-skill` repository;
- update README, API contract, test cases, local agent test, env inventory, progress, and handoffs.

Done criteria:

- current docs and skill instruct only Phase 3 flows;
- no active docs recommend removed endpoints/tools/CLI;
- standalone skill PR is linked from the main PR.

## Verification Gates

Before final PR:

```sh
npm run format:check
npm run lint
npm run typecheck
npm test
MYSQL_PORT=3307 npm run test:integration
MYSQL_PORT=3307 npm run test:mcp
npm run test:phase3:golden
npm run test:phase3:perf
```

Additional cleanup gate:

```sh
rg -n "enterprise_hub_(upload_document|get_document_status|search_documents|get_document|get_document_download_url|archive_document)|hub documents|POST /documents|GET /documents|/documents/:id" .
```

Allowed matches:

- negative tests;
- migrations or historical removal notes;
- this removed-surface section.

### Task 13: Local Streamable HTTP MCP Endpoint

Execution order: establish the shared contract; implement endpoint guards, read/upload delegation, and launcher bootstrap; then add launcher proxy, verification, legacy removal, and documentation sync.

| Subtask | Dependency | Done criteria |
| --- | --- | --- |
| 13.0 shared contract | none | Shared strict schemas/error results contain the nine business tools and inline Base64 file object, with no session name, legacy login, or service file path. |
| 13.1 endpoint guards | 13.0 | API exposes only authenticated stateless Streamable HTTP `POST /mcp`, hard loopback-only, bounded, redacted, and stable on transport errors. |
| 13.2/13.3 tools | 13.0/13.1 | Read and upload handlers delegate request-scoped to existing authenticated API routes; upload bytes are checked then internally multipart-adapted. |
| 13.4/13.5 launcher | 13.0/13.1 | `apps/mcp-launcher` provides memory-only local login/logout and proxies every remote MCP request with bearer auth. |
| 13.6 removal/verification | 13.1-13.5 | No server stdio/session/file-path implementation remains; HTTP/launcher smoke verifies representative tools and safe failures. |
| 13.7 docs/skill sync | 13.5/13.6 | Main docs and both skill homes describe launcher plus HTTP only, never service lifecycle operations. |

Task 13 completion criteria:

- Service `/mcp` is HTTP-only; launcher stdio is local client-to-launcher only.
- All initialize, discovery, and tool requests are bearer-authenticated and preserve existing authorization/audit behavior.
- Launcher stores no token beyond its process lifetime and needs fresh login after restart.
- Root `mcp:launcher` starts only the launcher; it never starts or operates service dependencies.

## Phase 4: Go Online (In Progress)

Phase 3 verification and review were merged before the first Phase 4 implementation track started. Phase 4 tracks remain independently gated by `staging-readiness.md`.

As of 2026-07-23, the first online skeleton slice is live in staging: API, worker, and Qdrant run on the Alibaba Cloud Simple Application Server from fixed Beijing ACR image tags behind nginx and Let’s Encrypt. The repeatable `npm run deploy:staging` boundary now builds, scans, publishes, migrates, rolls out, verifies, and records an immutable release. Merged PR #76 also proved the full trusted-main automation chain: quality-gate run `29977759504` triggered deployment run `29977876905`, which deployed merge SHA tag `708128503656`. RDS `prisma migrate deploy`, synthetic seed, Qdrant init, local `/readyz`, public HTTPS `/healthz`, blocked public `/readyz`, certbot renew dry-run, and fixture-only staging smoke have passed.

The official-auth implementation branch now replaces the temporary login boundary with local
password identities, browser Authorization Code + PKCE, rotating opaque credentials, public
authenticated `/mcp`, an independently publishable desktop launcher, operator onboarding, and
Codex/OpenClaw installation skills. It is not yet a live beta release until that atomic change is
merged, deployed, the launcher is published, and macOS/Windows desktop acceptance is recorded.
Database SSL/recovery, monitoring/alerting, rollback rehearsal, and real-data governance remain
separate Phase 4 gates.

Scope:

- staging runtime prerequisites;
- Alibaba Cloud / approved infrastructure deployment path;
- MySQL, Qdrant, storage, secret, domain, TLS, and registry readiness;
- official browser authentication and desktop launcher;
- staging smoke and rollback.

### Day 2: Alibaba Cloud OSS Storage Adapter

The OSS track is independently ready because its region, endpoint, bucket, effective object permissions, and credential location are verified.

Completion criteria:

- preserve `LocalFileSystemStorageAdapter` and select `local|oss` only through `STORAGE_DRIVER`;
- implement the existing put/read/stat/presign/delete contract through the Alibaba OSS S3-compatible endpoint;
- keep database object keys provider-neutral and isolate physical objects under a configurable service prefix;
- wire API, worker, and readiness through the same runtime factory;
- retain credentials only in ignored local env or secure deployment runtime configuration;
- pass unit tests, a credential-gated live lifecycle test with cleanup, full repository gates, and the documented manual acceptance suite;
- document that switching drivers does not automatically migrate historical local objects.

### Deployed Staging Runtime Slice

The current staging deployment uses:

- `https://api.smedatacenter.xyz` for public API liveness through nginx/TLS;
- private `/readyz` on the server loopback only;
- Alibaba Cloud ACR Personal Edition registry `crpi-yyglilct3xi9outz.cn-beijing.personal.cr.aliyuncs.com`;
- namespace `enterprise-hub` with private repositories `api`, `worker`, and `qdrant`;
- API/worker fixed image tag `708128503656`;
- mirrored Qdrant image tag `v1.15.4`;
- root-only server runtime env at `/opt/enterprise-hub/runtime.env`.

The deployed slice is intentionally staging-only and uses fixture documents plus synthetic seed
data. The earlier ADR 0021 opaque-token bridge was withdrawn and must not be implemented. The
accepted official employee installation, browser login, and durable session contract is defined in
`official-user-install-and-login.md`; implementation is complete on the integration branch but
still requires staging deployment and desktop acceptance before beta use. The fixed launcher
`enterprise-hub-mcp-launcher@0.1.0` is published and its registry integrity, clean install, CLI,
and production dependency audit have been verified.

### Remaining Phase 4 Tracks

- Official user access: merge and deploy the atomic auth cutover, merge the synchronized skill, and
  pass real macOS and Windows Codex/OpenClaw browser-login acceptance. The fixed launcher
  `enterprise-hub-mcp-launcher@0.1.0` is already public. A real user may first use fixture or
  explicitly approved non-sensitive data.
- Database policy: choose final RDS SSL mode. Provider CLI now verifies 7-day automated full-backup retention plus 7-day log backups and one successful full backup, but restore ownership/RPO/RTO and a recovery drill remain open.
- Security/auth: ADR 0021 is withdrawn. The accepted identity, employee mapping, browser
  authorization, token lifecycle, password setup/reset, and operator onboarding contract is
  implemented on the official-auth integration branch; staging security acceptance remains.
- Deployment automation: verified. The merged `npm run deploy:staging` release/rollback boundary is reused by GitHub Actions; trusted `main` quality success deployed immutable tag `708128503656`, recorded the GitHub staging deployment, and passed independent host inspection. Manual deploy/rollback remains available from `main`.
- Operations: monitoring, alerting, rollback runbook validation, log retention, and cost/resource review.
- Data governance: define real customer import, retention, deletion, and staging-data policy before customer data. A real beta employee using repo fixtures is an earlier, separate acceptance gate.

## Phase 5 Preview: Operations And Hardening

Do not start Phase 5 until Phase 4 staging/launch gates pass.

Scope:

- operational runbooks;
- monitoring/alerts;
- beta feedback loop;
- retrieval quality tuning using approved data;
- performance/cost hardening;
- retention/admin lifecycle features.
