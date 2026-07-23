# 企业资料中枢 Test Cases

Last updated: 2026-07-20

This file records the active verification matrix. Historical Phase 1/2 ordinary document upload/search tests are no longer current because that public surface has been removed.

## Required Repository Checks

| Check             | Command                                          | Expected                                                                                      |
| ----------------- | ------------------------------------------------ | --------------------------------------------------------------------------------------------- |
| Format            | `npm run format:check`                           | No Prettier diffs                                                                             |
| Lint              | `npm run lint`                                   | No ESLint failures                                                                            |
| Typecheck         | `npm run typecheck`                              | TypeScript compiles with no emit                                                              |
| Unit tests        | `npm test`                                       | All Vitest suites pass                                                                        |
| Local integration | `MYSQL_PORT=3307 npm run test:integration`       | Phase 3 API + worker path passes                                                              |
| MCP smoke         | `npm run test:mcp`                               | HTTP `/mcp` and memory-only launcher path pass                                                |
| Manual acceptance | Ask Codex to run the SME_DATA_CENTER manual test | Natural, verbatim employee prompts plus user-visible task records pass                        |
| Golden retrieval  | `npm run test:phase3:golden`                     | Deterministic synthetic retrieval thresholds pass                                             |
| Perf smoke        | `npm run test:phase3:perf`                       | Real local workloads pass and report workload size, elapsed time, Node version, and threshold |

## Active Phase 3 API / Worker Cases

| Case                                     | Test / Command                                                                                                                                         | Expected                                                                                                                                                                                                                       |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Evidence upload accepts MD/TXT/DOCX only | `npm test -- apps/api/src/server.test.ts`                                                                                                              | Creates source document, labels, storage object, audit, and `evidence_document_index` processing run                                                                                                                           |
| Evidence status authorization            | `npm test -- apps/api/src/server.test.ts`                                                                                                              | Uploader/admin can read `GET /v1/documents/evidence/:documentId/status`; other employees receive non-leaking not-found                                                                                                         |
| Evidence indexing worker                 | `npm test -- apps/worker/src/worker.test.ts`                                                                                                           | Worker parses, chunks, embeds/indexes, records ready document index, and activates document                                                                                                                                    |
| Unsupported worker job type              | `npm test -- apps/worker/src/worker.test.ts`                                                                                                           | Unknown job type fails explicitly with `UNSUPPORTED_PROCESSING_JOB_TYPE`; no fallback text extraction                                                                                                                          |
| Evidence search permission filtering     | `npm test -- apps/api/src/evidence.test.ts apps/api/src/server.test.ts`                                                                                | Search returns only visible active indexed chunks and does not leak inaccessible evidence                                                                                                                                      |
| Evidence signed pagination               | `npm test -- apps/api/src/evidence.test.ts apps/api/src/mcp/http.test.ts` plus `MYSQL_PORT=3307 npm run test:integration`                              | Tampered/expired/scope-mismatch cursors fail; stable pages have no duplicate/skip; integration proof `phase3_evidence_signed_pagination` passes                                                                                |
| Structured import validation             | `npm test -- apps/api/src/server.test.ts`                                                                                                              | CSV/XLSX imports require supported `dishes`/`business` structure and reject whole file on validation failure                                                                                                                   |
| Structured import atomicity              | `npm test -- apps/api/src/server.test.ts`                                                                                                              | Invalid rows/sheets create no partial dataset rows                                                                                                                                                                             |
| Structured import exact replay/recovery  | `npm test -- apps/api/src/server.test.ts apps/api/src/mcp/http.test.ts` plus `MYSQL_PORT=3307 npm run test:integration`                                | Same fingerprint replay reuses persisted IDs/storage key; conflicts happen before durable side effects; integration proofs `phase3_structured_concurrent_exact_replay` and `phase3_structured_storage_and_apply_recovery` pass |
| Structured import status authorization   | `npm test -- apps/api/src/server.test.ts`                                                                                                              | Only authorized employees can see import status                                                                                                                                                                                |
| Structured query compiler limits         | `npm test -- apps/api/src/structured-query*.test.ts`                                                                                                   | Only controlled read-only fields/operators/aggregates/sort/pagination are accepted                                                                                                                                             |
| Structured query typed semantics         | `npm test -- packages/domain/src/structured-query.test.ts apps/api/src/structured-query-route.test.ts` plus `MYSQL_PORT=3307 npm run test:integration` | Numeric/date filters, sort, min/max/sum/avg use typed semantics; cursor scope includes org/employee/role/current labels; integration proof `phase3_structured_typed_query` passes                                              |
| Archived source docs excluded            | `npm test -- apps/api/src/server.test.ts`                                                                                                              | Rows remain stored but inactive/archived source documents are not queryable                                                                                                                                                    |
| Worker lease and crash recovery          | `npm test -- apps/worker/src/worker.test.ts apps/worker/src/evidence-index.test.ts` plus `MYSQL_PORT=3307 npm run test:integration`                    | DB CAS lease, heartbeat, terminal/transient retry classification, and old-worker publish protection pass; integration proof `phase3_worker_lease_crash_recovery` passes                                                        |

## Active MCP Cases

| Case                     | Test / Command                                        | Expected                                                                                        |
| ------------------------ | ----------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| HTTP endpoint guards     | `npm test -- apps/api/src/mcp/http.test.ts`           | Auth, loopback, stateless protocol, size/concurrency, and discovery are enforced                |
| Core MCP contract        | `npm test -- packages/mcp-contract/src/index.test.ts` | Strict tool inputs reject legacy session/path fields and invalid inline upload content          |
| API MCP tool delegation  | `npm test -- apps/api/src/mcp`                        | Read/upload tools preserve existing API authorization and multipart validation                  |
| Launcher bootstrap/proxy | `npm test -- apps/mcp-launcher/src`                   | Login/logout is memory-only and every remote MCP request carries bearer auth                    |
| Local MCP smoke          | `MYSQL_PORT=3307 npm run test:mcp`                    | Launcher entrypoint, authenticated HTTP `/mcp`, and launcher-to-HTTP proxy representatives pass |

## User-Visible Codex Manual Acceptance

The repeatable controller workflow is defined in `docs/implementation/local-agent-test.md` and `skills/enterprise-hub-manual-test/SKILL.md`. It resets only the repository's local test runtime, starts API/worker, creates independent user-visible Codex tasks from `fixtures/manual-acceptance/scenarios.json`, captures operator snapshots, and writes an ignored `.data/manual-tests/<runId>/report.md`.

The controller sends manifest prompts verbatim. Visible messages contain ordinary business language only; local email and fixture path stand in for SSO and file attachment. Automated fixture tests reject controller boundaries and MCP/Base64/label/idempotency/SQL/query-shape/grounding hints in those prompts. Protocol-heavy or boundary-prefixed runs count only as guided conformance evidence.

The deterministic fake-provider pass verifies orchestration, authorization, grounding, uploads, state, prompt-injection safety, and structured queries. It must not be cited as proof of semantic retrieval quality. The real-provider subset requires explicit local `.env` configuration and `EXTERNAL_MODEL_EGRESS_ACKNOWLEDGED=true`.

## Legacy Removal Negative Cases

| Case                       | Test / Command                                | Expected                                                                                             |
| -------------------------- | --------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| Removed HTTP routes absent | `npm test -- apps/api/src/server.test.ts`     | Legacy ordinary document routes return 404                                                           |
| Removed MCP surface absent | `npm run test:mcp`                            | No service stdio, persisted launcher session, legacy login tool, or server-visible file path remains |
| CLI package absent         | `rg "hub documents" . --glob '!node_modules'` | No active command/docs/tests reference the removed CLI flow                                          |
| Worker fallback absent     | `npm test -- apps/worker/src/worker.test.ts`  | No legacy text-extraction fallback path remains                                                      |

The removed route/tool names may appear only in negative tests, migration/removal notes, or historical cleanup records.

## Local Phase 3 Integration Smoke

`MYSQL_PORT=3307 npm run test:integration` should prove:

1. local MySQL and Qdrant start;
2. migrations and seed apply;
3. API starts on an available port;
4. `baoli.manager@example.com` can login;
5. structured `dishes` fixture imports and can be queried;
6. evidence markdown fixture uploads;
7. worker indexes evidence into Qdrant;
8. evidence status becomes ready;
9. evidence search returns the indexed chunk;
10. exact structured import replay preserves one object/document/batch/window/row set;
11. worker lease crash recovery prevents stale worker publication;
12. structured numeric ordering/aggregates use mathematical semantics;
13. evidence pagination returns a second page through a signed cursor.

Current hardening proof labels emitted by the integration smoke:

- `phase3_structured_concurrent_exact_replay`
- `phase3_structured_storage_and_apply_recovery`
- `phase3_worker_lease_crash_recovery`
- `phase3_structured_typed_query`
- `phase3_evidence_signed_pagination`

## Phase 3 Performance Gate Workloads

`npm run test:phase3:perf` must not use hard-coded measurement values. It currently executes and reports:

- 5,000 structured query compiler runs;
- one 70,000-row RFC 4180 CSV parse/validation through `@enterprise-hub/structured-ingestion`;
- 5,000 Qdrant payload builds from deterministic evidence-like chunks;
- the deterministic golden retrieval evaluation.

Worker lease correctness is intentionally not treated as a performance measurement; it is covered by unit tests and the MySQL-backed integration proof above.

Default local thresholds remain unscaled. GitHub's shared runner sets
`PHASE3_PERF_THRESHOLD_MULTIPLIER=1.25` to preserve a bounded regression gate
without treating normal shared-CPU variance as a product failure. The report
must include the active multiplier and scaled thresholds. Values below `1` or
above `2` fail configuration validation.

## Data And Secret Safety

- Tests use synthetic fixtures and fake model providers by default.
- `fixtures/structured/maijia_*_first1000.xlsx` are user-approved non-sensitive
  real-business sample workbooks truncated to the first 1000 worksheet rows for
  structured schema and parser coverage.
- Real customer exports, `.env`, API keys, bearer tokens, and service account keys must not be committed.
- External model provider tests require explicit env configuration and egress acknowledgement.
