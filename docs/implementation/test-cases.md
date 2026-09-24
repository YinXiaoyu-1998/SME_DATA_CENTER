# 企业资料中枢 Test Cases

Last updated: 2026-09-14

This file records the active verification matrix. Historical Phase 1/2 ordinary document upload/search tests are no longer current because that public surface has been removed.

## Admin-only upload regression boundary

Launcher recommendation is exactly 0.5.2; minimum compatibility is 0.5.0. Run the HTTP upload
route tests, MCP HTTP/upload-handler tests, launcher preflight tests, and shared contract tests to
prove employee c0/c3 receive `403 UPLOAD_ADMIN_REQUIRED`, `File upload requires the admin role.`,
`retryable: false` before input/file/storage side effects. Tools remain statically visible.
Local denial creates no backend audit; backend denial best-effort records `file_upload.denied`
using `evidence_document`, `structured_dataset` (including Delivery Ledger), or
`quarantine_certificate`. Audit failure cannot change denial.

Positive uploads use admin c0 across evidence, row CSV, business/dishes partitions, unchanged
Delivery Ledger XLSX, and quarantine images. Explicit high-level admin uploads succeed without
granting ordinary read access; employee c3 can read eligible data but cannot upload. Partition
create/parts/complete require admin; owner abort and existing status/manifest/read/search/query/download
rules remain. Older compatible launchers are backend-denied. The manual manifest has 16 separate
natural-language tasks; the controller smoke requires admin c0. No historical-data migration,
OSS URL invalidation, mid-transfer downgrade handling, or future service-identity design is added.

## Required Repository Checks

| Check              | Command                                                                                                                                | Expected                                                                                                                                |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| Format             | `npm run format:check`                                                                                                                 | No Prettier diffs                                                                                                                       |
| Lint               | `npm run lint`                                                                                                                         | No ESLint failures                                                                                                                      |
| Typecheck          | `npm run typecheck`                                                                                                                    | TypeScript compiles with no emit                                                                                                        |
| Unit tests         | `npm test`                                                                                                                             | All Vitest suites pass                                                                                                                  |
| Local integration  | `MYSQL_PORT=3307 npm run test:integration`                                                                                             | Phase 3 API + worker path passes                                                                                                        |
| MCP smoke          | `npm run test:mcp`                                                                                                                     | HTTP `/mcp` and official launcher stdio-to-HTTP path pass                                                                               |
| Auth MySQL         | `RUN_AUTH_INTEGRATION=1 npm test -- apps/api/src/auth/prisma-auth-repository.integration.test.ts`                                      | Official credential lifecycle passes against MySQL                                                                                      |
| Launcher package   | `npm run build --workspace smedc-mcp-launcher && npm run test:package --workspace smedc-mcp-launcher`                                  | Publishable tarball is isolated, allowlisted, and protocol-probed                                                                       |
| Desktop acceptance | Follow `official-manual-acceptance.md` plus `official-user-install-and-login.md` on clean desktop users                                | Published launcher, browser login, Codex/OpenClaw upload/query, restart, logout, reset, repair, and uninstall pass                      |
| Golden retrieval   | `npm run test:phase3:golden`                                                                                                           | Deterministic synthetic retrieval thresholds pass                                                                                       |
| Perf smoke         | `npm run test:phase3:perf`                                                                                                             | Real local workloads pass and report workload size, elapsed time, Node version, and threshold                                           |
| Production audit   | `npm run audit:production`                                                                                                             | Direct command enforces the risk policy; Phase 3 quality CI reports findings without blocking PR/main runs                              |
| Runtime images     | CI-equivalent `docker buildx build --pull --platform linux/amd64 --target {api,worker,release-ops} --load .` plus Trivy policy reports | All three lean targets build; vulnerability findings are informational in Phase 3 quality CI                                            |
| Local release path | Disposable MySQL/Qdrant runtime with compiled API/worker/release-ops commands                                                          | Health/readiness, non-root users, worker termination, Qdrant init, forward migration, and fixture-only upload/index/search/cleanup pass |

## Audit Provenance Verification

| Case                               | Test / command                                                                                                                                                                                                                                              | Expected                                                                                                                                                                          |
| ---------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Request context and proxy boundary | `npm test -- apps/api/src/request-audit-context.test.ts apps/api/src/proxy-boundary.test.ts`                                                                                                                                                                | Safe request IDs; direct callers cannot forge forwarding metadata; one trusted nginx hop preserves the public IP.                                                                 |
| Business audit provenance          | `npm test -- apps/api/src/documents.test.ts apps/api/src/evidence.test.ts apps/api/src/structured-imports.test.ts apps/api/src/routes/evidence.test.ts apps/api/src/routes/structured-import/structured-import.test.ts apps/api/src/routes/catalog.test.ts` | Direct HTTP audit stores true peer IP, `http_api`, and null version; admin output preserves nullable historical/operator/system fields.                                           |
| MCP provenance delegation          | `npm test -- apps/api/src/mcp/http.test.ts apps/api/src/mcp/api-delegation.test.ts apps/api/src/mcp/tool-handlers.test.ts apps/api/src/mcp/upload-tools.test.ts apps/api/src/server.test.ts apps/api/src/routes/structured-query.test.ts`                   | MCP audit retains outer request ID/IP, `mcp_launcher`, and valid bounded launcher-version metadata; a forged internal proof falls back to `http_api` with null version.           |
| Authentication-event provenance    | `RUN_AUTH_INTEGRATION=1 npm test -- apps/api/src/auth/auth-core.test.ts apps/api/src/auth/routes.test.ts apps/api/src/auth/prisma-auth-repository.integration.test.ts apps/api/src/auth/operator-cli.test.ts apps/api/src/server.test.ts`                   | Browser events have request ID/IP and null version; OAuth device/token/refresh/revoke events retain valid supplied launcher-version metadata; operator/system events remain null. |
| End-to-end local cleanup           | `set -a; source .env; set +a; MYSQL_PORT=3307 npm run test:integration && MYSQL_PORT=3307 npm run test:mcp`                                                                                                                                                 | Synthetic test data is created and run-scoped DB, storage, and Qdrant residue is removed.                                                                                         |

## Active Phase 3 API / Worker Cases

| Case                                     | Test / Command                                                                                                                                                                                      | Expected                                                                                                                                                                                                                                        |
| ---------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Evidence upload accepts MD/TXT/DOCX only | `npm test -- apps/api/src/routes/evidence.test.ts`                                                                                                                                                  | Creates source document with immutable confidentiality level (default 0 only when omitted), storage object, audit, and `evidence_document_index` processing run                                                                                 |
| Evidence status authorization            | `npm test -- apps/api/src/routes/evidence.test.ts`                                                                                                                                                  | Only the uploader within the document's clearance can read `GET /v1/documents/evidence/:documentId/status`; every other caller, including an admin, receives non-leaking not-found                                                              |
| Evidence indexing worker                 | `npm test -- apps/worker/src/worker.test.ts`                                                                                                                                                        | Worker parses, chunks, embeds/indexes, records ready document index, and activates document                                                                                                                                                     |
| Unsupported worker job type              | `npm test -- apps/worker/src/worker.test.ts`                                                                                                                                                        | Unknown job type fails explicitly with `UNSUPPORTED_PROCESSING_JOB_TYPE`; no fallback text extraction                                                                                                                                           |
| Evidence search permission filtering     | `npm test -- apps/api/src/evidence.test.ts apps/api/src/routes/evidence.test.ts`                                                                                                                    | Search returns only visible active indexed chunks and does not leak inaccessible evidence                                                                                                                                                       |
| Evidence signed pagination               | `npm test -- apps/api/src/evidence.test.ts apps/api/src/mcp/http.test.ts` plus `MYSQL_PORT=3307 npm run test:integration`                                                                           | Tampered/expired/scope-mismatch cursors fail; stable pages have no duplicate/skip; integration proof `phase3_evidence_signed_pagination` passes                                                                                                 |
| Structured import validation             | `npm test -- apps/api/src/routes/structured-import/structured-import.test.ts`                                                                                                                       | CSV/XLSX imports require supported `dishes`/`business` structure and reject whole file on validation failure                                                                                                                                    |
| Delivery/supplier parser contracts       | `npm test -- packages/structured-ingestion/src/index.test.ts`                                                                                                                                       | Delivery CSV/XLSX files select one receipt sheet and produce one row per item; supplier files require the supplier name, preserve available controlled fields, and ignore unrelated/hidden sheets                                               |
| Supplied sample acceptance               | Production-parser acceptance against the three user-supplied XLSX files; temporary CSV conversions are removed after parsing                                                                        | Delivery counts are 13 and 1 for receipts `SH2608250117` / `SH2608260003`; supplier catalog count is 134; both sample supplier keys have unique current-catalog matches; no sample files enter git                                              |
| Structured import atomicity              | `npm test -- apps/api/src/routes/structured-import/structured-import.test.ts`                                                                                                                       | Invalid rows/sheets create no partial dataset rows                                                                                                                                                                                              |
| Structured import exact replay/recovery  | `npm test -- apps/api/src/routes/structured-import/structured-import.test.ts apps/api/src/mcp/http.test.ts` plus `MYSQL_PORT=3307 npm run test:integration`                                         | Same fingerprint replay reuses persisted IDs/storage key; conflicts happen before durable side effects; integration proofs `phase3_structured_concurrent_exact_replay` and `phase3_structured_storage_and_apply_recovery` pass                  |
| Structured import status authorization   | `npm test -- apps/api/src/routes/structured-import/structured-import.test.ts`                                                                                                                       | Only same-organization callers whose clearance reaches the source document can see import status; role is not a read bypass                                                                                                                     |
| Structured query compiler limits         | `npm test -- apps/api/src/structured-query*.test.ts apps/api/src/routes/structured-query.test.ts`                                                                                                   | Only controlled read-only fields/operators/aggregates/sort/pagination are accepted                                                                                                                                                              |
| Structured query typed semantics         | `npm test -- packages/domain/src/structured-query.test.ts apps/api/src/structured-query-route.test.ts apps/api/src/routes/structured-query.test.ts` plus `MYSQL_PORT=3307 npm run test:integration` | Numeric/date filters, sort, min/max/sum/avg use typed semantics; cursor scope includes organization, employee, clearance, and query shape; integration proof `phase3_structured_typed_query` passes                                             |
| Delivery dynamic enrichment              | `npm test -- apps/api/src/structured-query.test.ts apps/api/src/routes/structured-query.test.ts`                                                                                                    | Latest successful applied supplier catalog supplies exact-match phone/address only when its source document is visible; missing, blank, ambiguous, stale, or hidden sources return `null` without fallback                                      |
| Dynamic-field query restrictions         | `npm test -- packages/domain/src/structured-registry.test.ts packages/domain/src/structured-query.test.ts`                                                                                          | `supplier_contact_phone` and `supplier_unit_address` are selectable virtual fields only, never filterable, sortable, groupable, or aggregatable                                                                                                 |
| Quarantine certificate APIs              | `npm test -- apps/api/src/routes/quarantine-certificates.test.ts apps/api/src/routes/source-documents.test.ts`                                                                                      | One JPG/PNG certificate uploads synchronously with exact idempotent replay; ordinary query/download follows clearance; uploader source archive is an owner action; admin receipt archive is the named PAO and returns an operational count only |
| Archived source docs excluded            | `npm test -- apps/api/src/routes/structured-import/structured-import.test.ts`                                                                                                                       | Rows remain stored but inactive/archived source documents are not queryable                                                                                                                                                                     |
| Worker lease and crash recovery          | `npm test -- apps/worker/src/worker.test.ts apps/worker/src/evidence-index.test.ts` plus `MYSQL_PORT=3307 npm run test:integration`                                                                 | DB CAS lease, heartbeat, terminal/transient retry classification, and old-worker publish protection pass; integration proof `phase3_worker_lease_crash_recovery` passes                                                                         |

## Active MCP Cases

| Case                     | Test / Command                                                                                                                                                        | Expected                                                                                                                                                                                 |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| HTTP endpoint guards     | `npm test -- apps/api/src/mcp/http.test.ts`                                                                                                                           | Official-host/loopback peer, opaque auth, stateless protocol, size/concurrency, and discovery are enforced                                                                               |
| Core MCP contract        | `npm test -- packages/mcp-contract/src/index.test.ts`                                                                                                                 | Strict tool inputs reject legacy session/path fields and invalid inline upload content                                                                                                   |
| API MCP tool delegation  | `npm test -- apps/api/src/mcp`                                                                                                                                        | Read/upload tools preserve existing API authorization and multipart validation                                                                                                           |
| Quarantine/download MCP  | `npm test -- apps/api/src/mcp/upload-tools.test.ts apps/api/src/mcp/read-tools.test.ts apps/api/src/mcp/action-tools.test.ts packages/mcp-contract/src/index.test.ts` | Quarantine upload/query/archive and source-document download URL tools keep the public MCP contract, receiptId naming, and backend authorization boundary                                |
| Launcher bootstrap/proxy | `npm test -- apps/mcp-launcher/src`                                                                                                                                   | Device Authorization, desktop auto-open/headless link delivery, secure-store or memory-only session custody, refresh serialization, logout, typed failures, and authenticated proxy pass |
| Local MCP smoke          | `MYSQL_PORT=3307 npm run test:mcp`                                                                                                                                    | Launcher entrypoint, authenticated HTTP `/mcp`, and launcher-to-HTTP proxy representatives pass                                                                                          |

## Deleted Phase 3 Local Manual Acceptance

The old local user-visible controller depended on the removed development email login and an HTTP
loopback launcher. Its document has been deleted to avoid ambiguity. Do not recreate it, use it as
post-cutover evidence, or revive it by weakening the HTTPS boundary. Current user-visible evidence
must come from the published launcher, official browser login, staging service, and either the
clean macOS/Windows desktop acceptance or the separately defined headless Linux support-class-C
flow. Automated Ubuntu package acceptance proves platform loading, not employee browser completion.

## Active Official Manual Acceptance

The active manual flow is defined in `docs/implementation/official-manual-acceptance.md`.

For the current macOS Codex slice, run:

```sh
npm run test:official-manual
```

This runner uses the installed `smedc-mcp-launcher@0.5.2`, a clearance-0 admin's
operating-system secure-store session, and the public staging service. It checks that upload inputs
which omit `confidentialityLevel` remain level 0, then covers evidence upload/status/search,
structured CSV import/query, invalid atomic import rejection, and run-scoped cleanup of evidence,
Qdrant points, OSS objects, structured rows, import batches, and documents. The stricter
user-visible flow also proves explicit high-level upload, cross-clearance ordinary reads, the
low-clearance admin read denial, and the named receipt-archive PAO, in addition to delivery-ledger
uploads/queries and the quarantine certificate/source-document download slice when in scope.
Password setup/reset remains browser-only and is proved separately through `auth:operator onboard`
/ `auth:operator reset-password` without recording full setup links.

The full manual acceptance gate is stricter than the runner: it creates a clearance-0 employee, a
clearance-3 employee, and a clearance-0 admin in the same organization, each with an explicit
role/clearance and a `manual-full-flow-*` or `manual-acceptance-*` `@example.invalid` email. It
sets/logs in through Chrome using an agent-generated throwaway password, exercises the flow as
multiple newly created user-visible Codex tasks/sessions with one normal low-technical request per
task, and then removes uploaded test data plus hard-deletes every synthetic account with
`auth:operator delete-test-account`.

A user-requested scoped QA run may instead reuse an authenticated employee only after controller
verification that its organization ID is `default-org`. It still requires new natural-language
Codex tasks, official launcher/MCP calls, a run-unique exact cleanup scope, complete test-data
cleanup, and preservation of the existing login. This narrower run does not satisfy the full
account lifecycle, confidentiality, admin-PAO, logout/reset, or account-deletion gate.

## Confidentiality And Privileged Admin Operation Cases

| Case                              | Test / command                                                                                                                                                                                                                             | Expected                                                                                                                                                                                |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Explicit account attributes       | `npm test -- apps/api/src/auth/operator-cli.test.ts apps/api/src/auth/http-contract.test.ts apps/api/src/mcp/read-tools.test.ts`                                                                                                           | Onboarding requires a role of `admin` or `employee` and 0–3 clearance; current-user returns role and clearance but no internal ID or credential.                                        |
| Default and explicit upload level | `npm test -- apps/api/src/routes/evidence.test.ts apps/api/src/routes/structured-import/structured-import.test.ts apps/api/src/routes/quarantine-certificates.test.ts`                                                                     | Omitted level is 0; only explicit 0–3 values are accepted; the service/agent never infers a level; an active admin may upload above their clearance.                                    |
| Ordinary read boundary            | `npm test -- apps/api/src/evidence.test.ts apps/api/src/routes/evidence.test.ts apps/api/src/routes/structured-import/structured-import.test.ts apps/api/src/routes/structured-query.test.ts apps/api/src/routes/source-documents.test.ts` | Active same-org employee needs `clearance >= confidentialityLevel`; admin role does not bypass ordinary status/search/query/download; denied responses do not enumerate protected data. |
| Admin archive PAO                 | `npm test -- apps/api/src/routes/quarantine-certificates.test.ts apps/api/src/mcp/action-tools.test.ts`                                                                                                                                    | Only active admin can archive by receipt ID above clearance; an employee cannot; the PAO returns `archivedCount` and does not grant normal read capability.                             |
| Removed legacy model              | `rg -n -e labelIds -e labelKeys -e employeeLabels -e documentLabels -e manager apps packages scripts skills docs --glob '!docs/implementation/progress.md'`                                                                                | No active tag/store/person/manager authorization surface remains; the former label and audit employee APIs are absent.                                                                  |

## Official Identity, OAuth, And Launcher Cases

| Area              | Required proof                                                                                                                                                                                                                                                             |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Password identity | Unicode NFC and 8–128 boundaries, common-password rejection, Argon2id parameters, dummy verification, non-enumerating failures, and 5/10/20/40/60-minute cooldown                                                                                                          |
| Setup/reset       | 24-hour single-use grant, 10-minute setup transaction, replacement and concurrent-consumption safety, fragment removal, CSRF/cookie/CSP/no-store headers, and session-family revocation                                                                                    |
| OAuth             | Metadata, fixed public client, Device Authorization issue/verify/poll lifecycle, 10-minute single-use pending codes, pairing metadata, pending/expiry/replay rejection, plus retained minimum-compatible 0.1.x Authorization Code + PKCE coverage                          |
| Sessions          | Hash-only opaque tokens, 10-minute access expiry, 30-day absolute session, atomic refresh rotation, replay-family revocation, logout/reset/disabled revocation, and fail-closed database errors                                                                            |
| Launcher          | Desktop browser auto-open and headless link delivery, bounded device polling, macOS Keychain/Windows Credential Manager or headless memory-only custody, cross-process refresh lock, restart recovery, model-safe failure classes, and no credential output                |
| Package           | `npm pack` allowlist and secret scan, no workspace dependency in the tarball, clean-directory install, stdio initialize/list-tools probe, native keyring load on macOS/Windows CI, headless installed-package/no-display acceptance on Ubuntu CI, and tag/version equality |

The removed `/auth/dev-login`, JWT verifier/issuer, email-taking launcher tool, and long-lived token
handoff must remain covered by negative tests and packaging scans.

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
4. the integration harness creates an official short-lived session without a test login endpoint;
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
- one 70,000-row RFC 4180 CSV parse/validation through `@smedc/structured-ingestion`;
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
- `fixtures/structured/synthetic_*_first1000.xlsx` are user-approved non-sensitive
  real-business sample workbooks truncated to the first 1000 worksheet rows for
  structured schema and parser coverage.
- Real customer exports, `.env`, API keys, bearer tokens, and service account keys must not be committed.
- External model provider tests require explicit env configuration and egress acknowledgement.
