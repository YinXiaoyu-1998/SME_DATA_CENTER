# 企业资料中枢 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` for parallel tracks or `superpowers:executing-plans` for single-thread execution. Steps use checkbox (`- [ ]`) syntax for tracking. This plan is written for execution inside Codex App and assumes multiple subagents/threads may work in parallel.

**Goal:** Build 企业资料中枢 from zero implementation to local MVP, deployable service, and small-scope internal beta.

**Architecture:** Use a modular monolith first: one backend codebase with modules for employee accounts, labels, document catalog, storage, processing worker, search/query, audit, admin, and Skill Directory. Files live in object storage, authoritative metadata lives in MySQL, derived indexes are rebuildable and never authoritative.

**Tech Stack:** TypeScript, Node.js, Fastify or NestJS, Prisma, MySQL 8, local filesystem or MinIO for MVP storage, Aliyun OSS for online storage, Docker Compose, Vitest/Jest, Playwright for beta admin UI smoke tests, simple Next.js or Vite React admin frontend for beta.

---

## 0. Non-Negotiable Product And Architecture Rules

These rules come from `docs/context/` and `docs/adr/`. Implementation agents must read them before coding:

- `docs/context/CONTEXT.md`
- `docs/context/use-cases.md`
- `docs/context/question_response.md`
- `docs/adr/0001-modular-monolith-and-async-worker.md`
- `docs/adr/0002-document-state-machine-and-active-visibility.md`
- `docs/adr/0003-mysql-object-storage-and-derived-indexes.md`
- `docs/adr/0004-employee-auth-and-backend-authorization.md`
- `docs/adr/0005-idempotent-processing-and-bounded-retry.md`
- `docs/adr/0006-backup-restore-and-rebuildable-derived-indexes.md`

Implementation must preserve these boundaries:

1. 企业资料中枢 is not a direct employee-facing AI agent. It is a service/tool called by 员工自用 agent, CLI, MCP, API, or minimal admin UI.
2. Employee account is the only permission subject. MCP, CLI, web, and API tokens inherit employee permissions.
3. Backend authorization is mandatory. Frontend, MCP, CLI, and employee-owned agents must never be trusted to filter permissions.
4. Object storage paths never express permissions. Permissions come from catalog metadata and ownership labels.
5. Only `active` documents enter ordinary search/query. `pending_processing`, `processing`, `processing_failed`, and `archived` do not appear in ordinary employee query.
6. Upload success is not business availability. The document becomes usable only after processing completes.
7. Derived indexes are rebuildable and must point back to source `document_id`.
8. Archival is metadata state change, not default physical deletion.
9. Skill Directory lists approved business skills and usage instructions. It does not execute skills.
10. First implementation is single-enterprise deployment. `org_id` may be reserved but real SaaS multi-tenancy is deferred.

## 1. Priority Levels

| Priority | Meaning | Examples |
|---|---|---|
| P0 | Required for local MVP and architectural proof | employee auth seed, labels, document upload, local storage, state machine, active-only query, backend permission filtering, audit append, minimal API docs |
| P1 | Required before online-ready service | Local MCP server, `enterprise-hub-mcp` meta skill, agent human-test loop, Docker image, production env config, Aliyun OSS adapter, MySQL migration discipline, structured logs, health checks, token rotation basics, deployment guide |
| P2 | Required for small internal beta quality | admin frontend, failure queue, manual retry, beta MCP connector hardening, signed download URLs, backup runbook, smoke tests |
| P3 | Explicitly deferred until after beta | full SaaS multi-tenancy, field-level permissions, automatic tag creation, advanced vector search, dashboard/report service, skill execution platform, SSO/OAuth device flow polish, region hierarchy |

MVP and beta must not accidentally implement P3 unless a later PR explicitly changes scope.

## 2. Required Progress And Handoff Documents

Long-running multi-agent execution must keep progress outside chat. These files are part of the implementation process and must be maintained.

### 2.1 Files To Create Or Maintain

| File | Owner | Purpose | Update Rule |
|---|---|---|---|
| `AGENTS.md` | human or lead agent | Repo-level Codex instructions, commands, branch rules, secrets policy | Update whenever implementation commands, directory layout, or branch workflow changes |
| `docs/implementation/implementation-plan.md` | lead agent | This master plan and phase checklist | Update only by lead/integration agent after scope changes |
| `docs/implementation/progress.md` | every agent | Current phase, active branches, completed tasks, blocked tasks, next tasks | Update at start and end of every work session or subagent PR |
| `docs/implementation/agent-handoffs.md` | every subagent | What a subagent changed, tests run, PR link, assumptions, unresolved issues | Add one entry before each subagent stops |
| `docs/implementation/env-inventory.md` | lead/devops agent | Required local/staging/prod environment variables and external services | Update whenever a new external service, bucket, key, or secret is needed |
| `docs/implementation/api-contract.md` | backend/API agent | Stable request/response examples for core APIs and MCP tools | Update in the same PR as API behavior changes |
| `docs/implementation/test-cases.md` | QA/integration agent | Manual and automated acceptance scenarios | Update as done criteria become tests |

### 2.2 Progress Document Minimum Template

Create `docs/implementation/progress.md` before coding:

```markdown
# 企业资料中枢 Progress

## Current Phase
- Phase:
- Date:
- Lead branch:
- Deployment target:

## Active Workstreams
| Workstream | Branch | Owner/Agent | Status | PR | Notes |
|---|---|---|---|---|---|

## Completed Checkpoints
| Date | Checkpoint | Evidence |
|---|---|---|

## Blockers
| Blocker | Needed From Human | Since | Stop Rule |
|---|---|---|---|

## Next Actions
- [ ] Assign Day 0 lead agent.
```

### 2.3 Handoff Entry Minimum Template

Every subagent must append to `docs/implementation/agent-handoffs.md`:

```markdown
## YYYY-MM-DD HH:mm - <branch-name> - <workstream>

- Scope:
- Files changed:
- Commands run:
- Done criteria passed:
- PR:
- Known gaps:
- Human blockers:
- Suggested next agent:
```

### 2.4 Done Criteria For Documentation Discipline

- [ ] `docs/implementation/progress.md` exists before implementation starts.
- [ ] Every active branch is listed in `progress.md`.
- [ ] Every subagent PR has a matching handoff entry.
- [ ] Every new environment variable appears in `env-inventory.md`.
- [ ] Every new API endpoint appears in `api-contract.md` with request and response examples.
- [ ] After all criteria above pass, commit current related changes with message `docs: add implementation tracking docs`, push branch, and open/update PR.

## 3. Branch, PR, And Subagent Operating Model

### 3.1 Branch Rules

- Lead integration branch should use `codex/enterprise-hub-implementation` unless user chooses another name.
- Subagents must use separate branches:
  - `codex/hub-mvp-schema-auth`
  - `codex/hub-mvp-documents`
  - `codex/hub-mvp-worker`
  - `codex/hub-mvp-mcp`
  - `codex/hub-online-deploy`
  - `codex/hub-beta-admin-ui`
- Subagents must not share a branch unless the lead agent explicitly assigns it.
- Each subagent branch must push and create a draft PR to `main` or to the lead integration branch, depending on the current integration strategy.
- The lead agent owns conflict resolution and final integration.

### 3.2 Commit Rules

- Commit at the end of each small completed unit.
- Commit messages should be short imperative phrases:
  - `Add document catalog schema`
  - `Implement active-only document search`
  - `Add local file storage adapter`
  - `Add admin document list page`
- Do not commit secrets, `.env`, real customer exports, private access tokens, or downloaded third-party data.

### 3.3 Human Blocker Stop Rules

Agents must stop and ask the human instead of inventing values when any of these are missing:

- Aliyun OSS region, bucket name, endpoint, access key, access secret, RAM policy, or lifecycle policy.
- Online MySQL host, username, password, database name, SSL requirement, backup setting.
- Qwen/DashScope API key, embedding model choice, or paid model budget.
- Domain name, TLS certificate, DNS provider, deploy target, or server credentials.
- Beta user list, admin list, initial employee permissions, initial store labels.
- Whether real company documents may be uploaded to staging.

When blocked, update `docs/implementation/progress.md` with the exact missing item and stop that workstream.

### 3.4 Execution Mode And Subagent Fit

Each task below names both its default execution shape and when a subagent is worth the coordination cost:

- **Execution mode:** whether the task can be done in the main thread, needs lead ownership, or naturally spans a main-thread pair.
- **Subagent fit:** when to create a subagent, usually for parallel tracks, independent validation, specialist implementation, or context-heavy work.
- **Human blocker:** when the task cannot proceed without service, account, data, deployment, or policy decisions from the user.

For single linear work, prefer the main thread. Use subagents when the task boundary, inputs, outputs, and integration point are clear enough that parallel work will save more time than it costs to coordinate.

## 4. Target System Shape

### 4.1 Suggested Repository Layout

The repo currently contains docs and video artifacts, not the service implementation. The first implementation PR should create this layout unless a later architecture decision changes the stack.

```text
apps/
  api/                 # HTTP API modular monolith
  worker/              # async processing worker using same domain modules
  admin-web/           # beta admin UI, added in small-scope beta phase
  mcp-server/          # local MCP adapter added in Phase 2
packages/
  domain/              # shared types, state machine, permission helpers
  storage/             # local filesystem, MinIO, Aliyun OSS adapters
  db/                  # Prisma schema, migrations, seed scripts
  testing/             # test factories and API test utilities
docs/
  implementation/
    implementation-plan.md
    progress.md
    agent-handoffs.md
    env-inventory.md
    api-contract.md
    test-cases.md
```

### 4.2 Core Data Model

Minimum entities:

- `organizations`: reserve `org_id`; single row in MVP.
- `employees`: employee account, disabled flag, role.
- `labels`: `store`, `personal`, `all_staff`, later extensible.
- `employee_labels`: many-to-many.
- `documents`: catalog record with status, type, storage object key, uploader, source metadata.
- `document_labels`: many-to-many.
- `processing_runs`: attempts, status, retry count, error summary.
- `document_chunks`: derived text chunks with `document_id`, `chunk_hash`, model/version fields.
- `audit_logs`: append-only events.
- `skill_entries`: approved skill catalog.
- `business_events`: optional P1/P2 entity for operational facts.
- `access_tokens`: employee-bound tokens for CLI/MCP/API.

### 4.3 Minimum API Surface

P0 APIs:

- `POST /auth/dev-login`
- `GET /me`
- `GET /labels`
- `POST /documents`
- `GET /documents`
- `GET /documents/:id`
- `GET /documents/:id/download`
- `POST /documents/:id/archive`
- `POST /documents/:id/labels`
- `GET /documents/:id/status`
- `GET /skills`
- `GET /audit`
- `GET /healthz`

P1/P2 APIs:

- `POST /tokens`
- `DELETE /tokens/:id`
- `POST /documents/:id/retry`
- `GET /admin/documents`
- `GET /admin/processing-failures`
- `POST /business-events`
- `GET /business-events`

All non-health endpoints must accept an authenticated employee context and must call backend permission helpers before returning document data.

## 5. Phase 1: MVP, Local Only

**Goal:** Service runs locally with Docker Compose and proves the core loop: seed employees/labels, upload a file, store original file locally, create catalog record, process into active state, query only accessible active documents, download selected file, write audit logs.

**Timebox:** 5-8 focused days.

**Deployment target:** Developer machine only.

**Storage:** MySQL in Docker, local filesystem or MinIO in Docker. Prefer local filesystem first if it speeds up P0; storage adapter must make OSS swap possible later.

**Scope tradeoffs allowed:**

- Dev login is acceptable; production auth can wait.
- Keyword search over title/metadata/chunks is acceptable; vector search can wait.
- Worker can poll MySQL job table; Redis queue can wait.
- Admin UI can wait; API and CLI smoke scripts are enough.
- Physical delete is not needed.

### Day 0: Project Skeleton And Tracking Docs

**Execution mode:** Main-thread lead.
**Subagent fit:** Simple docs subagent optional after the lead sets structure.

**Dependencies:** None.

**Steps:**

- [ ] Create `docs/implementation/progress.md` from template.
- [ ] Create `docs/implementation/agent-handoffs.md` with initial entry for the lead agent.
- [ ] Create `docs/implementation/env-inventory.md` with local-only variables:
  - `DATABASE_URL`
  - `STORAGE_DRIVER=local`
  - `LOCAL_STORAGE_ROOT=./.data/storage`
  - `JWT_SECRET`
  - `DEV_SEED_ADMIN_EMAIL`
- [ ] Create `docs/implementation/api-contract.md` with the P0 API list and initial response examples for `/healthz`, `/auth/dev-login`, and `/me`.
- [ ] Update `AGENTS.md` with implementation commands once package scripts exist.
- [ ] Create initial service workspace layout under `apps/` and `packages/`.
- [ ] Add root `package.json`, lockfile, formatter, lint, TypeScript config, test config.
- [ ] Add `docker-compose.yml` for MySQL.

**Done criteria:**

- [ ] `npm install` or selected package manager install succeeds.
- [ ] `docker compose up -d mysql` starts MySQL locally.
- [ ] `npm run lint` and `npm test` exist, even if only smoke tests run.
- [ ] Progress docs exist and list Day 0 as current checkpoint.
- [ ] No secrets are committed.
- [ ] After all criteria pass, commit current related changes with message `chore: scaffold enterprise hub service`, push branch, and open/update PR.

### Day 1A: Data Model, Migrations, And Seeds

**Execution mode:** Main-thread or subagent.
**Subagent fit:** Specialist subagent recommended when running parallel Day 1 tracks; new thread useful if context gets large.

**Can run parallel with:** Day 1B API contract refinement, Day 1C storage adapter interface.

**Dependencies:** Day 0 skeleton.

**Files likely touched:**

- `packages/db/prisma/schema.prisma`
- `packages/db/src/seed.ts`
- `packages/domain/src/document-state.ts`
- `packages/domain/src/permissions.ts`
- `docs/implementation/api-contract.md`
- `docs/implementation/test-cases.md`

**Steps:**

- [ ] Define Prisma schema for `organizations`, `employees`, `labels`, `employee_labels`, `documents`, `document_labels`, `processing_runs`, `document_chunks`, `audit_logs`, `skill_entries`, `access_tokens`.
- [ ] Encode document status enum: `uploading`, `pending_processing`, `processing`, `active`, `processing_failed`, `archived`.
- [ ] Encode document type enum: `raw_material`, `structured_dataset`, `analysis_artifact`, `business_event`, `management_knowledge`.
- [ ] Implement seed data:
  - org: `default-org`
  - employees: `admin@example.com`, `baoli.manager@example.com`, `suzhou.manager@example.com`
  - labels: `all_staff`, `store:baoli`, `store:suzhou`, personal labels for each employee
  - employee-label assignments matching use cases.
- [ ] Add migration and seed commands.
- [ ] Write tests for permission helper:
  - user with `store:baoli` can access document with `store:baoli`.
  - user with personal label can access personally shared document.
  - `all_staff` document is visible to all active employees.
  - no matching label returns false.
  - disabled employee cannot access anything.

**Done criteria:**

- [ ] `npm run db:migrate` creates all tables in local MySQL.
- [ ] `npm run db:seed` inserts exactly one org, three employees, expected labels, and no duplicate personal labels when run twice.
- [ ] Permission unit tests pass.
- [ ] Database constraints prevent duplicate employee email, duplicate label key per org, duplicate document-label pair.
- [ ] `docs/implementation/api-contract.md` lists exact enum values.
- [ ] After all criteria pass, commit current related changes with message `Add metadata schema and seed data`, push branch, and open/update PR.

### Day 1B: API App Shell And Auth Context

**Execution mode:** Main-thread or subagent.
**Subagent fit:** Simple subagent optional when parallelizing with Day 1A and Day 1C.

**Can run parallel with:** Day 1A and Day 1C after skeleton exists.

**Dependencies:** Day 0 skeleton. Can use mock DB until Day 1A merges, but must integrate before completion.

**Files likely touched:**

- `apps/api/src/server.ts`
- `apps/api/src/auth/*`
- `apps/api/src/routes/health.ts`
- `apps/api/src/routes/me.ts`
- `packages/domain/src/auth.ts`
- `docs/implementation/api-contract.md`

**Steps:**

- [ ] Implement `GET /healthz` returning `{ "ok": true, "service": "enterprise-hub-api" }`.
- [ ] Implement local-only `POST /auth/dev-login` accepting `{ "email": "admin@example.com" }` and returning `{ "accessToken": "...", "employee": {...} }`.
- [ ] Implement middleware that resolves employee from bearer token.
- [ ] Implement `GET /me` returning employee id, email, role, disabled flag, and label keys.
- [ ] Add request id middleware and structured JSON logs.
- [ ] Add API tests for health, dev login, invalid token, disabled employee rejection.

**Done criteria:**

- [ ] `curl http://localhost:3000/healthz` returns HTTP 200 and `ok: true`.
- [ ] `POST /auth/dev-login` for seeded employee returns a token and never returns password fields.
- [ ] `GET /me` with the token returns assigned labels.
- [ ] `GET /me` without token returns HTTP 401 with `{ "error": { "code": "UNAUTHENTICATED" } }`.
- [ ] API tests pass locally.
- [ ] `api-contract.md` contains request/response JSON for `/auth/dev-login` and `/me`.
- [ ] After all criteria pass, commit current related changes with message `Add local auth context`, push branch, and open/update PR.

### Day 1C: Storage Adapter

**Execution mode:** Main-thread or subagent.
**Subagent fit:** Simple subagent optional when parallelizing with Day 1A and Day 1B.

**Can run parallel with:** Day 1A and Day 1B.

**Dependencies:** Day 0 skeleton.

**Files likely touched:**

- `packages/storage/src/storage-adapter.ts`
- `packages/storage/src/local-storage.ts`
- `packages/storage/src/index.ts`
- `packages/storage/test/local-storage.test.ts`
- `docs/implementation/env-inventory.md`

**Steps:**

- [ ] Define `StorageAdapter` interface with `putObject`, `getObjectStream`, `statObject`, `createDownloadUrl`.
- [ ] Implement local filesystem adapter using `LOCAL_STORAGE_ROOT`.
- [ ] Store files under deterministic keys: `org/<orgId>/documents/<documentId>/original/<safeFileName>`.
- [ ] Add content hash calculation for uploaded file bytes.
- [ ] Add tests that write a file, stat it, read it back, and create a local download URL.

**Done criteria:**

- [ ] Local adapter writes file bytes to `.data/storage/org/default-org/documents/<id>/original/<name>`.
- [ ] `statObject` returns size, content type if known, and hash.
- [ ] Test verifies downloaded/read bytes match original bytes exactly.
- [ ] Storage path contains no permission semantics beyond org/document physical grouping.
- [ ] `env-inventory.md` documents `STORAGE_DRIVER=local` and `LOCAL_STORAGE_ROOT`.
- [ ] After all criteria pass, commit current related changes with message `Add local storage adapter`, push branch, and open/update PR.

### Day 2: Document Upload And Catalog

**Execution mode:** Main-thread or subagent.
**Subagent fit:** Specialist subagent recommended when running this beside independent Day 4B work; new thread useful for upload/catalog context.

**Can run parallel with:** Day 4B Skill Directory after Day 1A schema has merged.

**Dependencies:** Day 1A, Day 1B, Day 1C.

**Files likely touched:**

- `apps/api/src/routes/documents.ts`
- `packages/domain/src/documents.ts`
- `packages/domain/src/audit.ts`
- `packages/db/prisma/schema.prisma`
- `packages/storage/*`
- `docs/implementation/api-contract.md`
- `docs/implementation/test-cases.md`

**Steps:**

- [ ] Implement `POST /documents` multipart upload with fields:
  - `file`
  - `title`
  - `documentType`
  - `sourceSystem`
  - `sourceTime`
  - `labelKeys[]`
- [ ] Validate all requested labels exist in label catalog.
- [ ] Always add uploader personal label to the document.
- [ ] Reject upload if final label set would be empty.
- [ ] Save file via storage adapter.
- [ ] Create document record with status `pending_processing`.
- [ ] Create first processing run with status `queued`.
- [ ] Append audit log event `document.uploaded`.
- [ ] Implement `GET /documents/:id/status`.

**Done criteria:**

- [ ] Uploading `fixtures/baoli-june-meituan.csv` as `baoli.manager@example.com` returns HTTP 201 with:
  - `id`
  - `status: "pending_processing"`
  - `labels` containing `store:baoli` and uploader personal label
  - `storageObjectKey`
- [ ] Database contains one `documents` row and expected `document_labels` rows.
- [ ] Local storage contains the uploaded file bytes at the object key.
- [ ] `processing_runs` contains a queued run for the document.
- [ ] `audit_logs` contains `document.uploaded` with actor employee id and document id.
- [ ] Upload with unknown label returns HTTP 400 and creates no document/file.
- [ ] Upload with no labels still adds uploader personal label.
- [ ] API contract includes upload and status examples.
- [ ] After all criteria pass, commit current related changes with message `Implement document upload catalog`, push branch, and open/update PR.

### Day 3: Processing Worker And Active Visibility

**Execution mode:** Main-thread or subagent.
**Subagent fit:** Specialist subagent recommended when running this beside Skill Directory or audit work; new thread useful for worker/state-machine context.

**Can run parallel with:** Day 4B Skill Directory after Day 1A schema has merged, and Day 4C audit query after upload API exists.

**Dependencies:** Day 2.

**Files likely touched:**

- `apps/worker/src/worker.ts`
- `packages/domain/src/processing.ts`
- `packages/domain/src/document-state.ts`
- `packages/db/src/processing-run-repository.ts`
- `packages/db/src/chunk-repository.ts`
- `docs/implementation/test-cases.md`

**Steps:**

- [ ] Implement worker command `npm run worker:once` for deterministic tests.
- [ ] Worker claims queued/pending processing runs using DB transaction.
- [ ] Worker sets document status from `pending_processing` to `processing`.
- [ ] Worker reads file from storage and extracts text for `.txt`, `.md`, `.csv`, `.json`; unsupported files fail with error code `UNSUPPORTED_FILE_TYPE`.
- [ ] Worker chunks text using deterministic paragraph/line splitting.
- [ ] Worker writes `document_chunks` with unique `(document_id, chunk_hash, index_type)`.
- [ ] Worker sets document status `active` on success.
- [ ] Worker increments retry count and eventually sets `processing_failed` after 3 failures.
- [ ] Worker append audit events `document.processing_started`, `document.activated`, `document.processing_failed`.

**Done criteria:**

- [ ] Running `npm run worker:once` after CSV upload changes status to `active`.
- [ ] `document_chunks` contains at least one chunk linked to uploaded document id.
- [ ] Running `npm run worker:once` a second time does not duplicate chunks.
- [ ] Unsupported binary test file becomes `processing_failed` after bounded retry path in test.
- [ ] `processing_failed` document is visible only to uploader/admin status endpoints, not ordinary search.
- [ ] Unit/integration tests cover success, idempotent rerun, and failure.
- [ ] After all criteria pass, commit current related changes with message `Add idempotent document worker`, push branch, and open/update PR.

### Day 4A: Permission-Filtered Search And Download

**Execution mode:** Main-thread or subagent.
**Subagent fit:** Specialist subagent recommended when parallelizing Day 4 API tracks.

**Can run parallel with:** Day 4B Skill Directory, Day 4C audit API.

**Dependencies:** Day 3 active documents.

**Files likely touched:**

- `apps/api/src/routes/documents.ts`
- `packages/domain/src/permissions.ts`
- `packages/domain/src/search.ts`
- `packages/db/src/document-query-repository.ts`
- `docs/implementation/api-contract.md`
- `docs/implementation/test-cases.md`

**Steps:**

- [ ] Implement `GET /documents` with query params `q`, `documentType`, `labelKey`, `limit`, `cursor`.
- [ ] Always filter by employee accessible labels before returning results.
- [ ] Always filter `status = active` for ordinary employee search.
- [ ] Implement simple keyword search over title, source system, metadata, and chunks.
- [ ] Implement stable sort: newest `sourceTime` first, then `createdAt` descending.
- [ ] Implement `GET /documents/:id` with permission check.
- [ ] Implement `GET /documents/:id/download` with permission and active-state check.
- [ ] Append audit logs for query and download.

**Done criteria:**

- [ ] Baoli manager sees active Baoli document.
- [ ] Suzhou manager does not see Baoli document, and response does not reveal existence.
- [ ] Admin can list all active documents.
- [ ] Archived, pending, processing, and failed documents do not appear in ordinary search.
- [ ] `GET /documents/:id` for inaccessible document returns HTTP 404, not 403.
- [ ] `GET /documents/:id/download` returns a usable local URL or stream for accessible active document.
- [ ] Audit logs record query count/result count without leaking inaccessible document titles.
- [ ] API contract includes search, detail, and download examples.
- [ ] After all criteria pass, commit current related changes with message `Add permission filtered document query`, push branch, and open/update PR.

### Day 4B: Skill Directory

**Execution mode:** Main-thread or subagent.
**Subagent fit:** Simple subagent optional when Day 1A schema is merged and Day 4 work is parallelized.

**Can run parallel with:** Day 4A and Day 4C.

**Dependencies:** Day 1A schema.

**Files likely touched:**

- `apps/api/src/routes/skills.ts`
- `packages/domain/src/skills.ts`
- `packages/db/src/skill-repository.ts`
- `packages/db/src/seed.ts`
- `docs/implementation/api-contract.md`

**Steps:**

- [ ] Seed two approved skill entries:
  - `weekly-store-report`
  - `menu-gross-margin-analysis`
- [ ] Implement `GET /skills` with optional `q` and `category`.
- [ ] Return fields: `id`, `name`, `description`, `version`, `category`, `inputRequirements`, `installInstructions`, `examplePrompts`, `status`.
- [ ] Do not implement skill execution.

**Done criteria:**

- [ ] `GET /skills?q=菜单` returns the menu analysis skill.
- [ ] Response includes install/use instructions, not execution result.
- [ ] Disabled/unapproved skills are not returned to ordinary employees.
- [ ] API contract includes skill directory response example.
- [ ] After all criteria pass, commit current related changes with message `Add skill directory API`, push branch, and open/update PR.

### Day 4C: Audit, Archive, And Label Sharing

**Execution mode:** Main-thread or subagent.
**Subagent fit:** Specialist subagent recommended when parallelizing Day 4 API tracks.

**Can run parallel with:** Day 4A and Day 4B.

**Dependencies:** Day 2 upload, Day 4A permission helper.

**Files likely touched:**

- `apps/api/src/routes/documents.ts`
- `apps/api/src/routes/audit.ts`
- `packages/domain/src/audit.ts`
- `packages/domain/src/labels.ts`
- `docs/implementation/api-contract.md`

**Steps:**

- [ ] Implement `POST /documents/:id/archive`.
- [ ] Implement `POST /documents/:id/labels` to add existing labels only.
- [ ] Enforce only uploader or admin can change labels in MVP.
- [ ] Enforce all labels come from label catalog.
- [ ] Implement `GET /audit` for admin only.
- [ ] Make audit logs append-only in application layer; no update/delete endpoint.

**Done criteria:**

- [ ] Archiving an active document changes status to `archived`.
- [ ] Archived document disappears from ordinary search.
- [ ] Archiving does not delete storage object.
- [ ] Adding personal label `person:lijie` makes document visible to that employee after seed/test creates that employee.
- [ ] Non-uploader non-admin cannot add label.
- [ ] `GET /audit` returns ordered audit events to admin and HTTP 403 to non-admin.
- [ ] API contract includes archive, label change, audit examples.
- [ ] After all criteria pass, commit current related changes with message `Add archive sharing and audit APIs`, push branch, and open/update PR.

### Day 5: Minimal CLI Smoke Interface

**Execution mode:** Main-thread or subagent.
**Subagent fit:** Simple subagent optional if the API is stable; full MCP work belongs to Phase 2.

**Can run parallel with:** Integration tests after Day 4.

**Dependencies:** Day 4 APIs.

**Scope:** P0 uses a CLI smoke client to prove the local MVP loop without raw curl. Full MCP work is now the dedicated Phase 2 because MCP is the realistic employee-agent interaction surface and deserves its own local human-test phase before online deployment.

**Files likely touched:**

- `apps/cli/src/*`
- `docs/implementation/api-contract.md`
- `docs/implementation/test-cases.md`

**Steps:**

- [ ] Implement CLI command `hub login --email baoli.manager@example.com` for dev token storage in local ignored file.
- [ ] Implement CLI command `hub documents search "保利店 美团"` calling API.
- [ ] Implement CLI command `hub documents upload ./fixtures/baoli.csv --label store:baoli`.
- [ ] Document explicit invocation examples using `@企业资料中枢`.

**Done criteria:**

- [ ] A developer can upload a fixture and search it through CLI without using raw curl.
- [ ] Returned results match API permission filtering.
- [ ] CLI never receives documents that API would deny.
- [ ] Test or smoke script proves Baoli/Suzhou isolation.
- [ ] `api-contract.md` documents CLI commands.
- [ ] After all criteria pass, commit current related changes with message `Add local agent-facing smoke interface`, push branch, and open/update PR.

### Day 6: MVP Integration Test And Local Demo

**Execution mode:** Main-thread or subagent.
**Subagent fit:** Specialist QA/integration subagent recommended when the lead needs an independent validation pass.

**Dependencies:** Days 1-5 merged.

**Steps:**

- [ ] Add `fixtures/` with non-sensitive sample docs:
  - `baoli-june-meituan.csv`
  - `suzhou-performance.md`
  - `management-knowledge.md`
- [ ] Add integration test script that:
  - starts API and worker against local MySQL
  - seeds data
  - logs in as Baoli manager
  - uploads Baoli file
  - runs worker
  - searches as Baoli manager and finds it
  - searches as Suzhou manager and does not find it
  - downloads as Baoli manager
  - archives as uploader/admin
  - verifies it disappears from ordinary search
- [ ] Update `docs/implementation/test-cases.md` with same manual steps.
- [ ] Update `AGENTS.md` with exact commands to run local MVP.

**Done criteria:**

- [ ] `npm test` passes.
- [ ] `npm run test:integration` passes from a clean local database.
- [ ] Local demo can be run with documented commands only.
- [ ] The demo proves upload -> processing -> active search -> download -> archive.
- [ ] `progress.md` marks MVP core loop complete with evidence.
- [ ] After all criteria pass, commit current related changes with message `Add MVP integration test`, push branch, and open/update PR.

## 6. Phase 2: Local MCP And Agent Human Test

**Goal:** Turn the local API service into a locally runnable MCP surface so an employee-owned agent can use 企业资料中枢 in a realistic way before any remote deployment exists. This phase proves the agent interaction model: connect, authenticate as a seeded employee, list labels, upload a document, observe processing state, search only accessible active documents, fetch details/download URLs, archive, list approved skills, and verify permission isolation through MCP.

**Timebox:** 3-5 focused days after Phase 1 local MVP and P0 API corrections.

**Deployment target:** Developer machine only. The API, worker, MySQL, storage, and MCP server all run locally.

**Primary user:** A developer or operator using Codex or another MCP-capable employee-owned agent to human-test 企业资料中枢 locally.

**Core architectural decision:** MCP is an agent-facing adapter over the existing HTTP API. It must not become a second backend, must not direct-read MySQL, must not direct-read local storage, and must not implement independent authorization logic. All permissions still come from the API and employee context.

**Companion meta skill:** Create a stable `enterprise-hub-mcp` meta skill. The skill name must not include `local`; local development is only the first environment profile. Future remote/staging/production profiles should update the skill content without renaming the skill.

### Phase 2 Scope Boundaries

Phase 2 should make MCP usable locally, but it must not pull online-readiness work forward:

- Do not deploy API, worker, MCP, or storage to a remote environment.
- Do not add Aliyun OSS, online MySQL, TLS, domain, or production secret-store integration.
- Do not implement production password login, SSO, OAuth device flow, or long-lived production token management.
- Do not make 企业资料中枢 a direct employee-facing AI agent.
- Do not build a report/dashboard generator or skill execution platform.
- Do not let the MCP server filter permissions client-side or claim inaccessible documents exist.

Allowed local-only tradeoffs:

- MCP can use local development login through existing `POST /auth/dev-login`.
- The local worker can still be triggered through `npm run worker:once` by the test harness or human-test guide; the MCP document tools should continue to call the API rather than mutate storage/DB directly.
- File upload tools may accept local file paths because the MCP server is running on the same developer machine during this phase.

### Phase 2 Environment Profiles

The `enterprise-hub-mcp` meta skill and MCP docs should introduce profiles from the beginning:

| Profile | Phase Implemented | Connection Shape | Auth Shape | Notes |
|---|---|---|---|---|
| `local-development` | Phase 2 | Local stdio command or local MCP server command, backed by local API URL such as `http://127.0.0.1:3000` | Seeded employee email via local dev login | Required in Phase 2 |
| `staging-remote` | Phase 3 | Remote MCP endpoint or deployed command config | Employee-bound token from staging auth/token flow | Document placeholder only in Phase 2 |
| `production` | Later | Production MCP endpoint | Production employee auth/token policy | Out of scope |

### Phase 2 Human Inputs Required

No external infrastructure human inputs are required for Phase 2. Stop and ask only if the human wants a specific MCP client target beyond Codex/local MCP defaults, such as a particular desktop app, managed MCP gateway, or custom installation location.

Do not ask for or invent:

- OSS credentials.
- Online MySQL credentials.
- Domain/TLS settings.
- Production employee passwords.
- Real company documents.

### Day 1: MCP Server Skeleton And Tool Contract

**Execution mode:** Main-thread or specialist integration subagent.
**Subagent fit:** Useful if the lead wants a separate agent to focus on MCP protocol wiring while another prepares docs/tests.

**Dependencies:** Phase 1 local API, CLI smoke, `GET /labels`, document search/detail/download/archive APIs, Skill Directory API.

**Files likely touched:**

- `apps/mcp-server/package.json`
- `apps/mcp-server/src/index.ts`
- `apps/mcp-server/src/server.ts`
- `apps/mcp-server/src/tools.ts`
- `apps/mcp-server/src/schemas.ts`
- `docs/implementation/api-contract.md`
- `docs/implementation/test-cases.md`

**Steps:**

- [ ] Choose and document the MCP server transport for local development, preferably stdio because it is easiest for local agent clients to launch.
- [ ] Add root command `npm run mcp:dev`.
- [ ] Define a small API-client boundary used by MCP tools to call the existing HTTP API.
- [ ] Define MCP tool names, descriptions, input schemas, and result shapes before implementing tool bodies.
- [ ] Include an explicit local profile config:
  - `ENTERPRISE_HUB_API_URL`
  - optional `ENTERPRISE_HUB_MCP_SESSION_FILE`
  - optional `ENTERPRISE_HUB_MCP_PROFILE=local-development`
- [ ] Document that the MCP server is an adapter over the API, not an independent authorization layer.
- [ ] Update `api-contract.md` with the MCP tool list and local-development profile.

**Required MCP tool names for Phase 2:**

- `enterprise_hub_login_dev`
- `enterprise_hub_list_labels`
- `enterprise_hub_upload_document`
- `enterprise_hub_get_document_status`
- `enterprise_hub_search_documents`
- `enterprise_hub_get_document`
- `enterprise_hub_get_document_download_url`
- `enterprise_hub_archive_document`
- `enterprise_hub_list_skills`

**Done criteria:**

- [ ] `npm run mcp:dev` starts the MCP server locally without starting API or MySQL itself.
- [ ] MCP startup fails clearly if `ENTERPRISE_HUB_API_URL` is missing or invalid for the selected local mode.
- [ ] Tool schemas are deterministic and documented.
- [ ] MCP docs state that all non-health data access is delegated to the API.
- [ ] No tool calls Prisma, local storage adapter, or filesystem storage directly except reading a user-supplied upload file path for local upload.
- [ ] `api-contract.md` documents each tool name, purpose, required inputs, and high-level response shape.
- [ ] After all criteria pass, commit current related changes with message `Add local MCP server skeleton`, push branch, and open/update PR.

### Day 2: Local MCP Authentication And Session Handling

**Execution mode:** Main-thread or subagent.
**Subagent fit:** Useful if auth/session behavior needs focused testing across multiple employee identities.

**Dependencies:** Day 1 MCP skeleton, existing `POST /auth/dev-login`.

**Files likely touched:**

- `apps/mcp-server/src/auth.ts`
- `apps/mcp-server/src/session-store.ts`
- `apps/mcp-server/src/api-client.ts`
- `apps/mcp-server/src/tools/login-dev.ts`
- `apps/mcp-server/src/*.test.ts`
- `docs/implementation/env-inventory.md`
- `docs/implementation/api-contract.md`
- `docs/implementation/test-cases.md`

**Steps:**

- [ ] Implement `enterprise_hub_login_dev` for local development only.
- [ ] Accept `email` and optional `sessionName`.
- [ ] Call `POST /auth/dev-login` on the configured local API.
- [ ] Store the returned token in an ignored local session file, or return a session handle that subsequent tools can use.
- [ ] Do not print raw tokens in normal tool output.
- [ ] Support at least two local sessions so tests can switch between `baoli.manager@example.com` and `suzhou.manager@example.com`.
- [ ] Define consistent unauthenticated/session-missing error messages for document and skill tools.
- [ ] Update `env-inventory.md` for local MCP variables and ignored session file behavior.

**Done criteria:**

- [ ] `enterprise_hub_login_dev` logs in a seeded employee by email against local API.
- [ ] The token is not exposed in normal result text.
- [ ] A Baoli session and Suzhou session can coexist without overwriting each other accidentally.
- [ ] Document tools fail with a clear MCP error when no session/sessionName is supplied.
- [ ] Production/staging auth is explicitly out of scope and not faked.
- [ ] Tests cover successful login, unknown employee, disabled employee, token non-disclosure, and multiple local sessions.
- [ ] After all criteria pass, commit current related changes with message `Add local MCP dev login`, push branch, and open/update PR.

### Day 3: MCP Document, Label, And Skill Tools

**Execution mode:** Main-thread or specialist integration subagent.
**Subagent fit:** Good candidate for a subagent because the tools are bounded adapters over already-implemented API endpoints.

**Dependencies:** Day 1 and Day 2.

**Files likely touched:**

- `apps/mcp-server/src/tools/list-labels.ts`
- `apps/mcp-server/src/tools/upload-document.ts`
- `apps/mcp-server/src/tools/get-document-status.ts`
- `apps/mcp-server/src/tools/search-documents.ts`
- `apps/mcp-server/src/tools/get-document.ts`
- `apps/mcp-server/src/tools/get-document-download-url.ts`
- `apps/mcp-server/src/tools/archive-document.ts`
- `apps/mcp-server/src/tools/list-skills.ts`
- `apps/mcp-server/src/api-client.ts`
- `docs/implementation/api-contract.md`
- `docs/implementation/test-cases.md`

**Steps:**

- [ ] Implement `enterprise_hub_list_labels` by calling authenticated `GET /labels`.
- [ ] Implement `enterprise_hub_upload_document` by calling `POST /documents` with multipart form data:
  - `filePath`
  - `title`
  - `documentType`
  - optional `sourceSystem`
  - optional `sourceTime`
  - `labelKeys`
- [ ] Validate local file path existence before upload and return a safe error if missing.
- [ ] Implement `enterprise_hub_get_document_status` by calling `GET /documents/:id/status`.
- [ ] Implement `enterprise_hub_search_documents` by calling `GET /documents`.
- [ ] Implement `enterprise_hub_get_document` by calling `GET /documents/:id`.
- [ ] Implement `enterprise_hub_get_document_download_url` by calling `GET /documents/:id/download`.
- [ ] Implement `enterprise_hub_archive_document` by calling `POST /documents/:id/archive`.
- [ ] Implement `enterprise_hub_list_skills` by calling `GET /skills`.
- [ ] Preserve API error semantics in tool output, especially 401, 403, and not-found/inaccessible cases.
- [ ] Ensure tool results do not add summaries, guesses, report text, or AI-generated analysis of document content.

**Done criteria:**

- [ ] MCP list-labels returns catalog labels with `key`, `name`, and `type`, not internal label ids.
- [ ] MCP upload returns a pending document id and labels assigned by the API.
- [ ] MCP status can show `pending_processing`, `active`, and `processing_failed` when the API allows the actor.
- [ ] MCP search returns only API-visible active documents for the selected employee session.
- [ ] MCP detail and download URL tools return not-found/inaccessible semantics without leaking hidden document titles.
- [ ] MCP archive hides the document from ordinary search after API archive succeeds.
- [ ] MCP list-skills returns approved skill metadata and instructions only; no skill is executed.
- [ ] Unit tests mock API responses for success and important errors for each tool.
- [ ] After all criteria pass, commit current related changes with message `Add local MCP document tools`, push branch, and open/update PR.

### Day 4: Agent Human Test Loop And Permission Isolation

**Execution mode:** Main-thread with optional QA subagent.
**Subagent fit:** QA subagent recommended for independent validation because this phase exists to test the real agent interaction model.

**Dependencies:** Day 3 MCP tools.

**Files likely touched:**

- `scripts/test-mcp-local.ts`
- `docs/implementation/local-agent-test.md`
- `docs/implementation/test-cases.md`
- `docs/implementation/progress.md`

**Steps:**

- [ ] Add `npm run test:mcp` or equivalent local MCP smoke script.
- [ ] The smoke script should:
  - start or connect to local API as configured
  - login as Baoli manager through MCP
  - list labels through MCP
  - upload `fixtures/baoli-june-meituan.csv` through MCP with `store:baoli`
  - run or instruct the deterministic local worker pass
  - poll or read status through MCP until `active`
  - search through MCP as Baoli and find the document
  - login as Suzhou manager through MCP
  - search the same query through MCP and not find the Baoli document
  - get download URL through MCP as Baoli
  - archive through MCP as uploader/admin
  - verify ordinary MCP search no longer returns the archived document
- [ ] Write `docs/implementation/local-agent-test.md` with natural-language Codex prompts for human testing.
- [ ] Include expected results and failure triage for API not running, MySQL not seeded, worker not run, missing session, and permission-denied cases.
- [ ] Make clear that the agent must not claim inaccessible documents exist.

**Done criteria:**

- [ ] A developer can run `npm run test:mcp` from a clean local database after documented setup.
- [ ] The MCP smoke proves upload -> processing -> active MCP search -> download URL -> archive.
- [ ] The MCP smoke proves Baoli/Suzhou permission isolation using different employee sessions.
- [ ] Local human-test docs include copy-pasteable Codex prompts and expected outcomes.
- [ ] The human-test flow does not require OSS, online MySQL, real documents, or production credentials.
- [ ] `test-cases.md` records automated and manual MCP acceptance scenarios.
- [ ] After all criteria pass, commit current related changes with message `Add local MCP human test`, push branch, and open/update PR.

### Day 5: `enterprise-hub-mcp` Meta Skill

**Execution mode:** Main-thread or docs/skill subagent.
**Subagent fit:** Good candidate for a focused documentation/skill authoring subagent after MCP behavior is stable.

**Dependencies:** Day 1-Day 4 MCP behavior and local-agent test docs.

**Files likely touched:**

- `skills/enterprise-hub-mcp/SKILL.md` or another lead-approved repo location for distributable skills.
- `docs/implementation/enterprise-hub-mcp-skill.md`
- `docs/implementation/local-agent-test.md`
- `docs/implementation/test-cases.md`

**Steps:**

- [ ] Create the companion meta skill named exactly `enterprise-hub-mcp`.
- [ ] State the skill purpose: teach an employee-owned agent how to connect to, authenticate with, and safely use 企业资料中枢 through MCP across local, staging, and future production profiles.
- [ ] Implement the `local-development` profile instructions fully.
- [ ] Include placeholders for `staging-remote` and `production` profiles without inventing endpoints or credentials.
- [ ] Include setup checks:
  - verify API is running
  - verify MCP command/config is available
  - verify employee email/session
  - verify labels can be listed
- [ ] Include standard operating flow:
  - login/select session
  - list labels
  - upload document
  - check status
  - search
  - fetch detail/download URL
  - archive when requested
  - verify permission isolation when testing
- [ ] Include safety rules:
  - do not invent inaccessible documents
  - do not ask for production passwords in local mode
  - do not expose raw tokens
  - do not execute Skill Directory entries
  - do not upload real customer documents unless the human explicitly authorizes test data

**Done criteria:**

- [ ] The meta skill is named `enterprise-hub-mcp`, not `enterprise-hub-local-mcp`.
- [ ] The local-development profile is complete enough for an agent to connect and run the MCP human-test loop.
- [ ] Future remote profiles are represented as configuration profiles, not separate skill names.
- [ ] The skill contains no real tokens, passwords, customer data, endpoint secrets, or service-account material.
- [ ] The skill does not turn 企业资料中枢 into a skill execution platform or direct employee-facing AI agent.
- [ ] A fresh Codex thread using the skill can follow the documented local MCP setup and run the expected smoke path.
- [ ] After all criteria pass, commit current related changes with message `Add enterprise hub MCP meta skill`, push branch, and open/update PR.

### Day 6: Phase 2 Packaging, Docs, And Final Verification

**Execution mode:** Main-thread lead.
**Subagent fit:** Optional QA subagent for independent final MCP verification.

**Dependencies:** Day 1-Day 5.

**Files likely touched:**

- `AGENTS.md`
- `docs/implementation/api-contract.md`
- `docs/implementation/env-inventory.md`
- `docs/implementation/test-cases.md`
- `docs/implementation/progress.md`
- `docs/implementation/agent-handoffs.md`

**Steps:**

- [ ] Update `AGENTS.md` with MCP commands:
  - install dependencies
  - start local MySQL
  - run API
  - run worker once
  - run MCP server
  - run MCP smoke
- [ ] Update `env-inventory.md` with MCP local-development variables.
- [ ] Update `api-contract.md` with final MCP tool examples.
- [ ] Update `test-cases.md` with local MCP automated and human-test cases.
- [ ] Confirm `progress.md` lists Phase 2 active/completed workstreams and evidence.
- [ ] Confirm every subagent has a handoff entry.
- [ ] Run final verification commands.

**Done criteria:**

- [ ] `npm test` passes.
- [ ] `npm run typecheck` passes.
- [ ] `npm run lint` passes.
- [ ] `npm run format:check` passes.
- [ ] `npm run test:integration` still passes.
- [ ] `npm run test:mcp` or equivalent MCP smoke passes.
- [ ] A human can use Codex with `enterprise-hub-mcp` instructions to complete the local agent test without raw curl or direct DB access.
- [ ] `progress.md` marks Phase 2 complete and records remaining gaps.
- [ ] After all criteria pass, commit current related changes with message `Document local MCP verification`, push branch, and open/update PR.

### Phase 2 Global Done Criteria

Phase 2 is complete only when all of these are true:

- [ ] Local MCP server exists and runs through documented commands.
- [ ] MCP tools cover the Phase 1 MVP loop and Skill Directory read path.
- [ ] MCP tools call the HTTP API and inherit API authorization.
- [ ] MCP tests prove Baoli/Suzhou permission isolation.
- [ ] `enterprise-hub-mcp` meta skill exists with a complete local-development profile and future remote profile placeholders.
- [ ] Codex human-test instructions are documented and runnable.
- [ ] No Phase 3 online infrastructure assumptions were introduced.
- [ ] No secrets, real customer exports, production credentials, or private tokens are committed.

## 7. Phase 3: Online-Ready Service

**Goal:** Convert local MVP into a deployable service using real infrastructure, production-like configuration, OSS-backed storage, container images, deployment runbook, structured logs, and basic operational safety.

**Timebox:** 4-7 focused days after local MCP and agent human testing.

**Deployment target:** Staging environment, not yet open to real internal beta users.

### Phase 3 Human Inputs Required

Stop and ask the human before starting Phase 3 implementation unless these are available in `docs/implementation/env-inventory.md` or a secure secret store:

| Item | Example Value | Human Required? | Notes |
|---|---|---|---|
| Deployment target | ECS, ACK, Docker host, Railway-like service | Yes | Decide where API, worker, admin run |
| Public/staging domain | `hub-staging.example.com` | Yes | Needed before final CORS/TLS config |
| MySQL instance | host, port, db, username, SSL mode | Yes | Local Docker no longer enough |
| Aliyun OSS region | `oss-cn-hangzhou` | Yes | Must match bucket |
| OSS bucket for original files | `enterprise-hub-originals-staging` | Yes | Required |
| OSS bucket for derived artifacts | `enterprise-hub-derived-staging` or same bucket prefix | Human decision | Could be same bucket with prefixes |
| OSS access key/secret | secret manager only | Yes | Never commit |
| RAM policy | least privilege for required buckets | Yes | Need create/list/get/put, maybe signed URL |
| JWT/session secret | secret manager only | Yes | Required |
| Allowed admin emails | list | Yes | Initial online admin list |
| Qwen/DashScope key | optional for P2 search enhancements | Human decision | Not required for keyword-only online readiness |

### Day 1: Containerization And Runtime Config

**Execution mode:** Main-thread or subagent.
**Subagent fit:** Specialist devops subagent recommended when parallelizing online-readiness work; new thread useful for deployment context.

**Can run parallel with:** OSS adapter if env contract is agreed.

**Dependencies:** MVP.

**Steps:**

- [ ] Add `Dockerfile` for API.
- [ ] Add `Dockerfile` or target for worker.
- [ ] Add production `docker-compose.yml` example with API, worker, MySQL disabled or externalized.
- [ ] Add `/readyz` endpoint that checks DB connectivity and storage adapter health.
- [ ] Add config validation on boot; missing required env causes startup failure with clear variable name.
- [ ] Document environment variables in `env-inventory.md`.

**Done criteria:**

- [ ] `docker build` succeeds for API and worker.
- [ ] API container starts with local Docker Compose and passes `/healthz` and `/readyz`.
- [ ] Missing `DATABASE_URL` fails boot with explicit error mentioning `DATABASE_URL`.
- [ ] Worker container can process one queued document in local compose.
- [ ] `AGENTS.md` contains Docker commands.
- [ ] After all criteria pass, commit current related changes with message `Containerize API and worker`, push branch, and open/update PR.

### Day 2: Aliyun OSS Storage Adapter

**Execution mode:** Main-thread or subagent.
**Subagent fit:** Specialist subagent recommended when storage work can proceed independently from containerization.

**Can run parallel with:** Containerization after adapter interface exists.

**Dependencies:** Storage adapter interface, human-provided OSS info.

**Human blocker:** Stop if OSS region, bucket, AccessKey, AccessSecret, and endpoint are unavailable in secure environment.

**Steps:**

- [ ] Add Aliyun OSS SDK dependency.
- [ ] Implement `AliyunOssStorageAdapter`.
- [ ] Support `putObject`, `statObject`, `getObjectStream`, `createDownloadUrl`.
- [ ] Use key prefix `org/<orgId>/documents/<documentId>/original/<safeFileName>`.
- [ ] Add integration test gated by `RUN_OSS_INTEGRATION=1`.
- [ ] Add dry-run smoke command that uploads a tiny non-sensitive text file and deletes only if a human has approved physical deletion behavior for test prefixes. Otherwise leave it and document cleanup.

**Done criteria:**

- [ ] Local unit tests pass without real OSS credentials.
- [ ] With real staging env, test upload writes object visible in configured OSS bucket/prefix.
- [ ] Download URL can fetch exact bytes within signed URL expiration.
- [ ] OSS object key is stored in `documents.storage_object_key`.
- [ ] Permissions are still enforced by API before URL creation.
- [ ] `env-inventory.md` lists OSS variables and bucket names.
- [ ] After all criteria pass, commit current related changes with message `Add Aliyun OSS storage adapter`, push branch, and open/update PR.

### Day 3: Online Database And Migration Discipline

**Execution mode:** Main-thread or subagent.
**Subagent fit:** Specialist backend/devops subagent recommended when staging database work can proceed independently.

**Dependencies:** Human-provided MySQL staging database.

**Human blocker:** Stop if staging MySQL connection info is unavailable.

**Steps:**

- [ ] Add migration command for deploy: `npm run db:deploy`.
- [ ] Add seed command that is safe for staging and creates only configured admin/user/labels.
- [ ] Add migration rollback notes; do not rely on destructive reset.
- [ ] Add backup runbook section for staging and production.
- [ ] Add CI or local script to verify migrations from empty database.

**Done criteria:**

- [ ] Migrations apply successfully to fresh staging MySQL.
- [ ] Seed creates initial org, admin, personal labels, and no duplicate rows on rerun.
- [ ] API connects to staging MySQL and `/readyz` passes.
- [ ] `docs/implementation/env-inventory.md` records DB variables without secret values.
- [ ] `docs/implementation/progress.md` records staging migration timestamp and commit SHA.
- [ ] After all criteria pass, commit current related changes with message `Add online database deployment flow`, push branch, and open/update PR.

### Day 4: Security And Operational Basics

**Execution mode:** Main-thread or subagent.
**Subagent fit:** Specialist security/backend subagent recommended when auth, audit, and operational hardening can be isolated from deployment work.

**Dependencies:** API and online config.

**Steps:**

- [ ] Replace or gate `dev-login` behind `NODE_ENV !== "production"` or `ENABLE_DEV_LOGIN=true`.
- [ ] Implement employee-bound access tokens for CLI/MCP with hashed token storage.
- [ ] Add token revoke endpoint.
- [ ] Add request id, actor id, IP/client fields to audit logs.
- [ ] Add rate limit for auth/token endpoints.
- [ ] Add structured logs for upload, processing, query, download, archive.
- [ ] Add basic metrics logs: upload processing duration, processing failure count, query result count, object storage error count.

**Done criteria:**

- [ ] Production config refuses `dev-login` unless explicitly enabled.
- [ ] Token plaintext is shown only once and stored hashed.
- [ ] Revoked token returns HTTP 401.
- [ ] Audit events include actor, action, target, result, timestamp, request id.
- [ ] No logs print access tokens, OSS secrets, JWT secrets, or file content.
- [ ] After all criteria pass, commit current related changes with message `Harden auth and audit for staging`, push branch, and open/update PR.

### Day 5: Staging Deployment Runbook

**Execution mode:** Main-thread or subagent.
**Subagent fit:** Devops subagent recommended when deployment credentials and targets are available; new thread useful for runbook-heavy work.

**Dependencies:** Containers, OSS, online DB, human deployment target.

**Human blocker:** Stop if deployment target or credentials are missing.

**Steps:**

- [ ] Write `docs/implementation/deploy-runbook.md`.
- [ ] Include exact commands for building images, setting env, running migrations, starting API, starting worker, checking health.
- [ ] Include rollback steps: stop new containers, restart previous image, do not rollback DB destructively without human approval.
- [ ] Include smoke test:
  - login/token
  - upload non-sensitive file
  - run worker
  - search
  - download
  - archive
- [ ] Deploy staging once and record deployed image tags/commit SHA in `progress.md`.

**Done criteria:**

- [ ] Staging API public or VPN URL responds to `/healthz`.
- [ ] `/readyz` passes.
- [ ] Smoke upload writes object to OSS and row to staging MySQL.
- [ ] Worker activates uploaded document.
- [ ] Search and download work with employee token.
- [ ] Runbook is complete enough for a fresh agent to redeploy.
- [ ] After all criteria pass, commit current related changes with message `Document staging deployment runbook`, push branch, and open/update PR.

## 8. Phase 4: Small-Scope Internal Beta

**Goal:** Deploy a beta version for a small internal user group with a simple admin frontend, enough operational visibility, and high-confidence permission behavior.

**Timebox:** 5-10 focused days after online-ready staging.

**Deployment target:** Online staging/beta environment.

**Required beta scope:**

- Admin can see all uploaded documents for the single enterprise.
- Admin can filter by status, type, label, uploader.
- Admin can inspect failure reason and retry processing.
- Employee/agent path can upload, search, download active documents.
- Permission isolation is tested for at least two non-admin employees.

### Phase 4 Human Inputs Required

Stop and ask the human before beta launch unless these are available:

- Beta user list with emails and roles.
- Initial label list: store labels, all-staff label, personal labels.
- Which real or synthetic documents may be uploaded.
- Admin users.
- Beta feedback channel.
- Whether beta is allowed to use real employee data.
- Domain and access restriction decision: public internet with auth, VPN, or IP allowlist.

### Day 1: Admin Frontend Skeleton

**Execution mode:** Main-thread or subagent.
**Subagent fit:** Specialist frontend subagent recommended when backend admin APIs are stable; new thread useful for UI context.

**Can run parallel with:** Backend admin APIs if API contract is agreed.

**Dependencies:** Online API auth/token path.

**Files likely touched:**

- `apps/admin-web/*`
- `apps/api/src/routes/admin.ts`
- `docs/implementation/api-contract.md`
- `docs/implementation/test-cases.md`

**Steps:**

- [ ] Create admin web app.
- [ ] Implement login/token entry screen for beta.
- [ ] Implement document list page.
- [ ] Implement filters: status, document type, label, uploader.
- [ ] Implement document detail drawer/page with labels, status, source metadata, storage key, processing runs, audit summary.
- [ ] Add empty/loading/error states.

**Done criteria:**

- [ ] Admin can open `/admin/documents` and see uploaded documents.
- [ ] Non-admin employee token cannot load admin document list.
- [ ] Filters change API query and visible rows.
- [ ] Document detail shows labels, uploader, status, source time, object key, and processing run summary.
- [ ] Playwright smoke test loads admin list after seeded data.
- [ ] After all criteria pass, commit current related changes with message `Add beta admin document list`, push branch, and open/update PR.

### Day 2: Admin Failure Queue And Manual Retry

**Execution mode:** Main-thread pair or subagents.
**Subagent fit:** Use two simple subagents only if the API contract is frozen and frontend/backend work can proceed independently.

**Dependencies:** Admin frontend skeleton, worker retry logic.

**Steps:**

- [ ] Add `GET /admin/processing-failures`.
- [ ] Add `POST /documents/:id/retry`.
- [ ] Admin UI shows failed documents with error code, summary, retry count, last failed time.
- [ ] Admin can click retry after confirmation.
- [ ] Retry creates new processing run and sets status back to `pending_processing` or `processing`.

**Done criteria:**

- [ ] Failed fixture appears in failure queue.
- [ ] Retry button creates new processing run.
- [ ] Successful retry moves document to `active`.
- [ ] Retry action appends audit event with admin actor.
- [ ] Non-admin cannot retry.
- [ ] After all criteria pass, commit current related changes with message `Add processing failure retry`, push branch, and open/update PR.

### Day 3: Beta User And Label Administration

**Execution mode:** Main-thread or subagent.
**Subagent fit:** Specialist backend/frontend subagent recommended when admin API and UI changes can be developed as a bounded slice.

**Dependencies:** Admin auth, seed model.

**Scope tradeoff:** Full HR integration and self-service onboarding are P3. Beta can use admin-created employees.

**Steps:**

- [ ] Add admin APIs to create/disable employee.
- [ ] Add admin APIs to assign existing labels to employee.
- [ ] Add admin APIs to list label catalog.
- [ ] Add admin UI for employees and labels.
- [ ] Preserve one personal label per employee.
- [ ] Do not allow ordinary employee to create arbitrary labels.

**Done criteria:**

- [ ] Admin can create beta employee and personal label is created.
- [ ] Admin can assign `store:baoli` to employee.
- [ ] Newly assigned employee can search Baoli active documents.
- [ ] Disabling employee causes tokens/login to fail.
- [ ] Audit logs record employee create/disable and label assignment.
- [ ] After all criteria pass, commit current related changes with message `Add beta employee label admin`, push branch, and open/update PR.

### Day 4: Beta MCP Connector Hardening And Setup

**Execution mode:** Main-thread or subagent.
**Subagent fit:** Specialist integration subagent recommended when API and token flows are stable; new thread useful for MCP/connector context.

**Dependencies:** Stable API, token issuance, search/upload/download.

**Steps:**

- [ ] Adapt the Phase 2 MCP server/config for the online beta environment.
- [ ] Use employee-bound staging/beta tokens instead of local `dev-login`.
- [ ] Update the `enterprise-hub-mcp` meta skill `staging-remote` profile with real non-secret endpoint/config instructions.
- [ ] Verify tools against the deployed API:
  - `enterprise_hub_list_labels`
  - `enterprise_hub_search_documents`
  - `enterprise_hub_get_document`
  - `enterprise_hub_upload_document`
  - `enterprise_hub_list_skills`
  - `enterprise_hub_get_document_status`
  - `enterprise_hub_get_document_download_url`
- [ ] Document installation for Codex/OpenClaw-like agent environments.
- [ ] Add explicit examples using `@企业资料中枢`.
- [ ] Add beta warning: agent must not claim inaccessible docs exist.

**Done criteria:**

- [ ] A beta tester can configure MCP using a staging/beta token.
- [ ] Search tool returns same results as API for the same employee.
- [ ] Upload tool creates pending document with uploader personal label.
- [ ] Status tool shows pending/active/failed for uploader.
- [ ] Installation doc is in `docs/implementation/beta-agent-setup.md`.
- [ ] `enterprise-hub-mcp` includes a working `staging-remote` profile without embedding secrets.
- [ ] After all criteria pass, commit current related changes with message `Harden beta agent connector`, push branch, and open/update PR.

### Day 5: Beta Launch Checklist And Observation

**Execution mode:** Main-thread lead, optionally with subagent validation.
**Subagent fit:** QA subagent recommended for an independent beta-launch verification pass.

**Dependencies:** Admin UI, connector, online deployment.

**Steps:**

- [ ] Create `docs/implementation/beta-runbook.md`.
- [ ] List beta users and labels in `progress.md` without secrets.
- [ ] Run full smoke test with two beta employees and one admin.
- [ ] Upload at least three non-sensitive beta documents:
  - one store-specific raw file
  - one management knowledge doc
  - one analysis artifact
- [ ] Verify visibility matrix manually.
- [ ] Verify admin can see all uploaded docs.
- [ ] Verify processing failure path with an unsupported file.
- [ ] Open feedback channel and record first feedback items.

**Done criteria:**

- [ ] Beta environment URL is available to approved users.
- [ ] Admin document list shows all uploaded beta docs.
- [ ] Employee A cannot see Employee B/store-only docs unless label matches.
- [ ] Upload/search/download flow works from employee agent connector or CLI.
- [ ] Failure queue and retry work.
- [ ] `progress.md` records launch commit SHA, deployment time, beta users, and known issues.
- [ ] After all criteria pass, commit current related changes with message `Document beta launch runbook`, push branch, and open/update PR.

## 9. Deferred Work After Small-Scope Beta

Do not block beta on these unless user explicitly changes priority:

| Item | Priority | Why Deferred |
|---|---|---|
| Full vector search with Qwen embeddings | P2/P3 | Keyword and chunk search validate permissions and lifecycle first |
| OAuth device flow | P2/P3 | Employee-bound tokens are enough for early beta |
| Full SaaS multi-tenancy | P3 | Current architecture is single enterprise |
| Field-level permissions | P3 | Coarse labels are the chosen first-stage model |
| Automatic tag creation | P3 | Tags must come from controlled catalog |
| Report/dashboard generation | P3 | Belongs to employee agent or future separate service |
| Skill execution | P3 | Hub lists skills but does not run them |
| Physical deletion workflow | P2/P3 | Archival is default; physical deletion needs stricter human policy |
| Advanced frontend knowledge portal | P3 | Admin minimal UI is enough for beta |
| Real third-party platform ingestion | P3 | Initial upload flow proves value without direct platform integrations |

## 10. End-To-End Acceptance Matrix

| Scenario | MVP | Local MCP | Online Ready | Beta |
|---|---:|---:|---:|---:|
| Local API starts | Required | Required | Required | Required |
| MySQL authoritative metadata | Required | Required | Required | Required |
| Local/OSS file storage | Local | Local | OSS | OSS |
| Employee auth context | Dev token | Dev token through MCP local profile | Employee token | Employee token |
| Upload creates catalog record | Required | Required through MCP | Required | Required |
| Upload stores original file | Local | Local via API | OSS | OSS |
| Worker activates supported file | Required | Required in local MCP smoke | Required | Required |
| Failed processing visible to admin/uploader only | Required | Required through MCP status | Required | Required |
| Active-only ordinary search | Required | Required through MCP search | Required | Required |
| Backend permission filtering | Required | Required through MCP/API inheritance | Required | Required |
| Download requires permission | Required | Required through MCP download URL | Required | Required |
| Archive removes from ordinary search | Required | Required through MCP archive | Required | Required |
| Label catalog returns controlled labels | Required | Required through MCP list-labels | Required | Required |
| Skill Directory returns approved skills | Required | Required through MCP list-skills | Required | Required |
| Agent-facing connector | CLI acceptable | MCP required | MCP staging profile required | MCP or documented connector required |
| `enterprise-hub-mcp` meta skill | Not required | Local profile required | Staging profile updated | Beta setup profile required |
| Admin frontend | Not required | Not required | Optional | Required |
| Failure retry UI | Not required | Not required | Optional | Required |
| Deployment runbook | Not required | Not required | Required | Required |
| Beta feedback tracking | Not required | Not required | Not required | Required |

## 11. Global Done Criteria Before Any Phase Is Considered Complete

For each phase:

- [ ] All phase-specific done criteria pass.
- [ ] `npm test` passes.
- [ ] Relevant integration/smoke tests pass.
- [ ] `git status --short` is clean after commit.
- [ ] `docs/implementation/progress.md` records completed tasks, evidence, commit SHA, and open gaps.
- [ ] Every subagent has appended handoff notes.
- [ ] Any human blocker has either been resolved or documented as out of scope.
- [ ] Current related changes are committed, pushed, and represented by a PR.
- [ ] The PR description includes:
  - scope
  - tests run
  - environment changes
  - human inputs used
  - known limitations

## 12. Recommended Initial Parallelization

Once Day 0 skeleton exists, dispatch these subagents:

1. **Schema/Auth subagent:** Day 1A and Day 1B integration.
2. **Storage subagent:** Day 1C and later OSS adapter.
3. **Document API subagent:** Day 2 and Day 4A.
4. **Worker subagent:** Day 3.
5. **Skill/Audit subagent:** Day 4B and Day 4C.
6. **QA/Docs subagent:** Day 6, `api-contract.md`, `test-cases.md`, `progress.md` consistency.

For Phase 2, start new threads for MCP protocol/tooling, local agent human-test QA, and `enterprise-hub-mcp` meta-skill documentation if parallelism is useful. For Phase 3, start new threads for DevOps, OSS, and security hardening. For Phase 4, start new threads for admin frontend, beta connector hardening, and QA/beta runbook.

The lead agent should not let subagents invent missing infrastructure. If a subagent needs human-provided OSS, MySQL, domain, or API key information, it must update `progress.md` and stop.
