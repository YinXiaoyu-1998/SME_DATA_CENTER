# Confidentiality and Admin Model Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace label-intersection authorization with one organization boundary plus 0–3 account clearance and document confidentiality; retain only `admin` and `employee` functional roles; make every admin-gated employee-facing operation an explicit Privileged Administrative Operation (PAO).

**Architecture:** A document owns one immutable confidentiality level. All ordinary employee-facing reads are authorized server-side by `same org && active employee && employee.clearance >= document.confidentialityLevel`; document-derived rows, chunks, indexes, metadata, and download URLs use their source document's level. `admin` is not an ordinary-read bypass. A PAO is instead an explicitly declared admin-only operation whose own defined scope bypasses document clearance, while a disabled account cannot use either ordinary functions or PAOs.

**Tech Stack:** TypeScript, Fastify, Prisma/MySQL, Vitest, Zod, MCP contract package, published MCP launcher, Qdrant-backed evidence retrieval.

**Spec:** [ADR 0025](../adr/0025-document-confidentiality-and-admin-operations.md), [project context](../../CONTEXT.md), [API contract](api-contract.md), and the decisions recorded in this plan. The database cutover maps `manager` to `admin`, all existing accounts to clearance 3, and all existing documents to confidentiality level 0; it deletes old label catalog and association data without a compatibility layer.

**Implementation status (2026-09-13):** Tasks 1–6 and the applicable guidance/fixture work in Task 7 are implemented and locally verified in PR #157. Task 8 remains deliberately pending: `enterprise-hub-mcp-launcher@0.3.0` must first be published and independently verified, then recommendation/skill pins, staging migration, and official staging acceptance can proceed. The unchecked release items below remain the source of truth for that follow-up.

## Global Constraints

- [ ] Preserve the organization boundary before every ordinary document read. A clearance-3 employee in another organization must not read a level-0 document.
- [ ] Permit only `admin` and `employee` roles. Role is functional authorization; it must never silently grant ordinary document-read clearance.
- [ ] Require an explicit `--role` and `--clearance` when a developer onboards an account. Do not introduce an in-product role or clearance editor. Level values are integers 0 through 3 only.
- [ ] Make document level immutable after successful upload. Each evidence, structured import, and quarantine-certificate upload accepts optional `confidentialityLevel`; omission means exactly 0. The API, MCP descriptions, and employee skill must say agents may not infer a higher level from a filename, content, sender, or business context.
- [ ] Remove labels completely: no `LabelType`, label catalog, employee/document label associations, `all_staff`, `store`, `personal`, `person:*`, `labelKeys`, label filters, `/labels`, or `enterprise_hub_list_labels`. Store/person business fields may remain only when they are business data, not authorization inputs.
- [ ] Treat every existing employee-facing `role === "admin"` guard as a named PAO. Do not leave an admin guard that is not declared as a PAO; do not create an implicit global admin bypass.
- [ ] Keep internal audit persistence and operator/security diagnostics, but remove the employee-facing `GET /audit` API and all client exposure of it.
- [ ] Do not create reclassification or clearance-edit APIs. DevOps/database remediation is outside this product workflow.
- [ ] Do not deploy or mutate staging data during the implementation PR. Release only through the repository's canonical staging process after migration, package publication, and review gates pass.

---

## Task 1 — Establish the schema and one-time data cutover

**Files:**

- Modify: `packages/db/prisma/schema.prisma`
- Create: `packages/db/prisma/migrations/20260912000000_confidentiality_admin_model/migration.sql`
- Modify: `packages/db/src/seed.ts`
- Modify: `packages/db/prisma/schema.prisma` generated-client consumers only after `npm run db:generate`
- Test: focused Prisma migration verification against a disposable local MySQL database; `packages/db/src/seed.ts` consumers through API fixtures

- [ ] Remove `manager` from `EmployeeRole`, delete `LabelType`, and remove `Organization.labels`, `Employee.employeeLabels`, `Document.documentLabels`, plus the `Label`, `EmployeeLabel`, and `DocumentLabel` Prisma models.
- [ ] Add required `Employee.clearance` and required `Document.confidentialityLevel` fields. Represent both as non-negative integer database columns with an enforced 0–3 range; give only the document column a database default of 0. Do not give `Employee.role` or `Employee.clearance` a Prisma/database default.
- [ ] Add the read-path index `documents(org_id, status, confidentiality_level)` and retain the existing document/source indexes required by current query paths.
- [ ] Write the migration as an intentional, ordered MySQL cutover: update existing `employees.role = 'admin'` where it is `manager`; add and backfill `employees.clearance = 3`; add and backfill `documents.confidentiality_level = 0`; alter the role enum to exactly `admin, employee`; enforce the 0–3 checks; then delete association rows and drop `document_labels`, `employee_labels`, and `labels` plus their foreign keys and indexes. The migration must not delete documents, employees, organizations, audit logs, imports, or derived data.
- [ ] Make migration SQL safe for the actual current schema (foreign keys are removed before tables) and verify Prisma introspection/generation recognizes the final schema. Do not edit historical migrations.
- [ ] Rewrite local seed identities to use only the two roles and explicit clearances; do not seed label records or `person:*` labels. Use representative low and high clearances in test-focused fixtures, while the legacy migration—not seeds—defines existing-account clearance 3.

**Verification:** Apply from a clone of the current schema/data fixture and assert manager-to-admin, existing employees at 3, existing documents at 0, no label tables/rows, rejected out-of-range inserts, and successful `npm run db:generate`.

**Commit:** `feat(db): replace labels with confidentiality levels`

## Task 2 — Make clearance the only ordinary-read domain authorization

**Files:**

- Modify: `packages/domain/src/auth.ts`, `packages/domain/src/index.ts`
- Modify: `packages/domain/src/permissions.ts`, `packages/domain/src/permissions.test.ts`
- Modify: `packages/domain/src/structured-query.ts`, `packages/domain/src/structured-query.test.ts`
- Modify: `packages/domain/src/structured-coverage.ts`, `packages/domain/src/structured-coverage.test.ts`
- Modify: `apps/api/src/structured-query.ts`, `apps/api/src/structured-query-route.test.ts`, `apps/api/src/structured-query.prisma.integration.test.ts`

- [ ] Change `EmployeeRoleName` to the exact union `"admin" | "employee"`; add `clearance` to `AuthenticatedEmployee`; remove all `labels`/`labelKeys` identity fields and exports.
- [ ] Replace `canEmployeeAccessDocument` with a pure permission rule accepting `{ disabled, clearance }` and `{ confidentialityLevel }`. It must return false for disabled employees and otherwise only when clearance is at least the document level. Organization equality stays mandatory in each repository/query caller because an ID-only helper cannot prove it.
- [ ] Change structured-query cursor shape hashing and authorization scopes from role/labels to employee id, clearance, and organization. This invalidates old cursors rather than accepting an obsolete authorization shape.
- [ ] Replace every structured-query and structured-coverage `document_labels`/`labels` predicate with `d.confidentiality_level <= ?`, parameterized by the caller's clearance, while retaining existing `org_id`, active/archived, dataset, and import-status predicates. Apply the same rule in the supplier-catalog dynamic lookup path in `apps/api/src/structured-query.ts`.
- [ ] Extend unit and Prisma integration cases to prove: level 0–3 visibility is inclusive; level 2 does not appear to clearance 1; admin at clearance 1 is still denied ordinary level-2 structured data; disabled users receive no ordinary results; cross-organization data never appears; coverage lists and aggregates obey the same predicate.

**Verification:** `npm test -- --run packages/domain/src/permissions.test.ts packages/domain/src/structured-query.test.ts packages/domain/src/structured-coverage.test.ts apps/api/src/structured-query-route.test.ts apps/api/src/structured-query.prisma.integration.test.ts` (or the repository's equivalent focused Vitest invocation), followed by `npm run typecheck`.

**Commit:** `feat(auth): enforce ordinary reads by confidentiality clearance`

## Task 3 — Refactor authentication, onboarding, and account responses

**Files:**

- Modify: `apps/api/src/auth/auth-core.ts`, `apps/api/src/auth/prisma-auth-repository.ts`, `apps/api/src/request-auth.ts`
- Modify: `apps/api/src/auth/operator-cli.ts`, `apps/api/src/auth/prisma-auth-operator-repository.ts`
- Modify: `apps/api/src/routes/system.ts`
- Modify: `apps/api/src/auth/operator-cli.test.ts`, `apps/api/src/auth/prisma-auth-repository.integration.test.ts`, `apps/api/src/request-auth.test.ts`, `apps/api/src/routes/system.test.ts`, `apps/api/src/test-support/auth-fixtures.ts`

- [ ] Remove employee-label joins and personal-label creation from authentication and operator repositories. Load role, disabled state, and clearance with the employee record and preserve session-disabled enforcement.
- [ ] Change `npm run auth:operator -- onboard` parsing to require exactly `--org-id`, `--email`, `--display-name`, `--role`, and `--clearance`. Accept only `admin|employee` and integer 0–3; reject omitted, duplicated, malformed, and out-of-range values. Remove repeated `--label` entirely.
- [ ] Persist explicit role and clearance in the onboarding transaction, while retaining identity, password-setup grant, and internal auth-security-event creation. Remove `personalLabelDeleted` from test-account-delete results and cleanup code.
- [ ] Return `role`, `clearance`, and `disabled` (but no labels) from authenticated HTTP `GET /me`. Extend the self-scoped MCP `enterprise_hub_get_current_user` mapping to return the employee's role and clearance; it remains selector-free and must not expose internal IDs or credentials.
- [ ] Add test coverage for explicit onboarding requirements, legacy `manager` rejection, disabled-account rejection across authenticated routes, and self-only `/me`/MCP current-user output with clearance.

**Verification:** Focused auth, request-auth, system-route, and MCP read-tool tests; manually invoke the parser with one valid and one omitted-clearance command.

**Commit:** `feat(auth): require explicit role and clearance at onboarding`

## Task 4 — Convert document creation and ordinary read surfaces

**Files:**

- Modify: `apps/api/src/documents.ts`, `apps/api/src/evidence.ts`, `apps/api/src/source-documents.ts`, `apps/api/src/structured-imports.ts`, `apps/api/src/quarantine-certificates.ts`
- Modify: `apps/api/src/routes/evidence.ts`, `apps/api/src/routes/source-documents.ts`, `apps/api/src/routes/structured-import/routes.ts`, `apps/api/src/routes/structured-import/workflow.ts`, `apps/api/src/routes/quarantine-certificates.ts`
- Modify: `apps/api/src/routes/evidence.test.ts`, `apps/api/src/evidence.test.ts`, `apps/api/src/routes/source-documents.test.ts`, `apps/api/src/routes/structured-import/structured-import.test.ts`, `apps/api/src/routes/structured-import/workflow.test.ts`, `apps/api/src/routes/quarantine-certificates.test.ts`, `apps/api/src/test-support/document-fixtures.ts`, `apps/api/src/test-support/structured-import-fixtures.ts`

- [ ] Replace repository input/output `labelIds` and `labels` with a single `confidentialityLevel`. Persist it once on the source document and include it only on internal records or explicitly documented public responses; do not create a general reclassification method.
- [ ] In all three multipart parsers, accept at most one optional `confidentialityLevel` field, parse a strict integer 0–3, and default to 0 only when absent. Reject duplicate, fractional, signed/out-of-range, or non-numeric values. Remove label lookup, label-assignment authorization, automatic personal labels, and label audit metadata.
- [ ] Keep idempotency deterministic by including the selected confidentiality level in each upload request fingerprint. A retry that changes the level must conflict rather than overwrite the original immutable choice.
- [ ] Apply ordinary `same org + active + clearance` access before returning document title, metadata, evidence hits, source download URLs, structured-import status, evidence-index status, quarantine query records, derived rows, aggregates, source IDs, counts, or errors. Ensure the evidence search revalidator checks the source document level after candidate retrieval, and make Qdrant payload/query filtering carry the same immutable level so inaccessible hits never enter reranking/output.
- [ ] Treat chunks, document indexes, import batches/rows, coverage, certificate metadata, and download capabilities as direct source-document derivatives; do not add an independent classification field to those tables or vectors.
- [ ] Preserve external composition behavior: a separately uploaded file is a new document whose level is only its explicitly supplied value or 0; no filename/content/lineage inference is permitted in code or agent guidance.
- [ ] Preserve processing-status visibility only through the ordinary-read rule. Remove the current admin override for another employee's evidence status; a user who uploads above their own clearance cannot read its status until DevOps changes that account outside the product.

**Verification:** Add route and service tests for all levels, default-0 uploads, explicit 0–3 uploads, invalid levels, no inference from a sensitive-looking filename, idempotent-level conflicts, cross-organization denial, disabled denial, evidence/vector revalidation, source download denial, structured row/aggregate/coverage denial, and derived certificate visibility.

**Commit:** `feat(documents): classify uploads and filter ordinary reads`

## Task 5 — Declare and enforce Privileged Administrative Operations

**Files:**

- Modify: `apps/api/src/routes/quarantine-certificates.ts`, `apps/api/src/quarantine-certificates.ts`
- Modify: `apps/api/src/routes/catalog.ts`
- Modify: `apps/api/src/routes/quarantine-certificates.test.ts`, `apps/api/src/routes/catalog.test.ts`, `apps/api/src/server.test.ts`
- Modify: `docs/implementation/api-contract.md`

- [ ] Delete the authenticated `GET /labels` route and `GET /audit` route, their response helpers, catalog/audit repository exposure, and their route tests. Do not delete the internal `AuditLog` model or non-user-facing operator/security diagnostics.
- [ ] Add one local PAO declaration/helper used by route code, with a name such as `archiveQuarantineCertificates`, which documents that the operation requires an active admin and bypasses source-document confidentiality only within this archive operation. Keep it separate from the ordinary document permission helper.
- [ ] Register both `POST /v1/quarantine-certificates/archive { sourceDocumentId }` and `{ receiptId }` as the same named PAO for admins. The PAO must work for target documents above the admin's clearance and may return the defined operational `archivedCount`; it must not confer ordinary search, metadata, status, or download access. Preserve the existing non-admin uploader-owned single-source archive behavior as a normal owner lifecycle action, scoped to the same organization, if and only if it does not introduce an admin guard.
- [ ] Add a source-level comment and API-contract section that lists each PAO by operation name, required role, target scope, and explicit clearance-bypass behavior. At this release the only PAO is quarantine-certificate archive; future admin-only functions must be added to the registry and contract before an admin check is introduced.
- [ ] Test that an active admin at clearance 0 can archive a level-3 certificate using either PAO input shape, that employee callers cannot use receipt bulk archive, that normal admin reads remain level-bound, and that disabled admins cannot perform PAOs.

**Verification:** Focused quarantine/catalog/server tests plus a static repository scan showing every employee-facing `role === "admin"` branch belongs to the declared PAO.

**Commit:** `feat(admin): declare clearance-independent certificate archive PAO`

## Task 6 — Ship the MCP contract and launcher as one breaking release

**Files:**

- Modify: `packages/mcp-contract/src/index.ts`, `packages/mcp-contract/src/index.test.ts`
- Modify: `apps/api/src/mcp/read-tools.ts`, `apps/api/src/mcp/upload-tools.ts`, `apps/api/src/mcp/action-tools.ts` where tool mapping is shared
- Modify: `apps/api/src/mcp/read-tools.test.ts`, `apps/api/src/mcp/upload-tools.test.ts`, `apps/api/src/mcp/action-tools.test.ts`, `apps/api/src/mcp/api-delegation.test.ts`, `apps/api/src/mcp/http.test.ts`, `apps/api/src/mcp/tool-handlers.test.ts`
- Modify: `apps/mcp-launcher/package.json`, launcher contract-alignment tests, packaging tests, and generated package contents as required by the existing build
- Modify after publication: server recommended-version metadata and both maintained skill pins

- [ ] Remove `enterprise_hub_list_labels` from shared tool names, read-tool routing, schemas, tests, launcher package contract, and user-visible descriptions.
- [ ] Remove `labelIds` evidence-search filtering and every required `labelKeys` upload input. Add optional integer `confidentialityLevel` (0–3) to evidence, structured-dataset, and quarantine-certificate MCP upload schemas and multipart mapping. Its description must say omission is level 0 and it is an explicit user-provided classification, never an inferred one.
- [ ] Update current-user MCP result shape to include `clearance`, update archive wording to call it an admin-only PAO, and make no MCP ordinary-read tool claim an admin clearance bypass.
- [ ] Bump `enterprise-hub-mcp-launcher` from its current `0.2.8` to the next semver minor version because tool names and input schemas are removed/changed. Update launcher alignment and `npm pack` tests in the same implementation PR.
- [ ] After the service PR merges, publish the exact bumped launcher, independently install/check the public tarball, then update server recommended-version metadata and both the repo-local and standalone `enterprise-hub-mcp` skill pins immediately. Do not advertise an unpublished version.

**Verification:** Run shared contract tests, API MCP delegation/HTTP tests, launcher build, launcher package tests, and `npm --workspace enterprise-hub-mcp-launcher run pack:check`; verify the published package separately before pin changes.

**Commit:** `feat(mcp): replace label inputs with confidentiality levels`

## Task 7 — Update guidance, operational contracts, fixtures, and release checks

**Files:**

- Modify: `skills/enterprise-hub-mcp/SKILL.md` and the matching standalone `YinXiaoyu-1998/enterprise-hub-mcp-skill` checkout on its own branch
- Modify: `README.md`, `README.zh.md`, `docs/implementation/api-contract.md`, `docs/implementation/implementation-plan.md`, `docs/implementation/official-user-install-and-login.md`, `docs/implementation/beta-user-onboarding-runbook.md`, `docs/implementation/phase-3-retrieval-docs.md`, `docs/implementation/staging-deploy-runbook.md`, `docs/implementation/staging-readiness.md`
- Modify: `scripts/test-integration.ts`, `scripts/golden-retrieval-eval.ts`, `scripts/phase3-performance-gates.ts`, `scripts/official-manual-acceptance.ts`, `scripts/manual-test-fixtures.test.ts`, and related staging smoke/cleanup tests that construct label-bearing requests
- Modify: `apps/api/src/app-context.test.ts`, `apps/api/src/server.test.ts`, and any fixtures found by the final label/manager scan
- Modify: `docs/implementation/progress.md`

- [ ] Replace all user-facing label selection/lookup guidance with the explicit optional upload-level field and the strict default-0/no-inference rule. State that an employee may upload any level 0–3 regardless of their own clearance, and that neither employee nor admin can reclassify it later in product.
- [ ] Update the operator onboarding runbook and examples to require role and clearance. Explain that `admin` enables only explicitly declared PAOs, not normal high-level data reads.
- [ ] Update official/manual/integration fixtures so each created account passes an explicit role and clearance, all upload requests omit level where level 0 is expected, and dedicated fixtures cover explicit high-level documents. Remove all label setup and list-label acceptance steps.
- [ ] Update the base MCP skill and matching standalone-skill PR together. It must instruct agents to ask for a level only when the user explicitly supplies one, otherwise submit/allow level 0; it must forbid agent-side classification from names or content. Do not put dataset-specific transformation rules in the base skill.
- [ ] Replace all obsolete `/labels`, `/audit`, manager, and tag authorization references in maintained docs. Keep historical ADR/progress records as historical evidence, but clearly mark old label descriptions as superseded where retained.
- [ ] Add a final CI/static scan that fails implementation review if runtime code or public MCP/API contract still contains label authorization constructs, `manager`, or undocumented employee-facing admin guards. Update `docs/implementation/progress.md` once for the completed workstream and PR/release status, not as a narrative log.

**Verification:** Run `rg` scans for removed public concepts, all focused tests named above, then final `npm run format:check`, `npm run lint`, `npm run typecheck`, and `npm test`. Run the local integration path with real `.env` provider configuration only if its existing safety prerequisites are met; clean all generated `.data` and repository-owned Docker resources afterward.

**Commit:** `docs: document confidentiality and privileged admin operations`

## Task 8 — Migrate and validate staging without a compatibility window

**Files:**

- Modify only if release findings require it: `docs/implementation/staging-readiness.md`, `docs/implementation/progress.md`
- Run: `npm run db:migrate:deploy`, canonical `npm run deploy:staging`, `npm run staging:smoke`, and the official manual-acceptance workflow

- [ ] Before deployment, read `docs/implementation/server-runtime-prerequisites.md` and `docs/implementation/staging-readiness.md`; record a non-secret pre-migration row/count snapshot for employees, documents, label tables, and the launcher recommendation. Back up according to the existing staging runbook before the destructive label-table drop.
- [ ] Apply the reviewed migration once through the canonical deployment path. Verify managers are gone, all pre-existing accounts have clearance 3, all pre-existing documents have level 0, and no label tables/association rows remain. Current staging business data is QA data, but do not delete unrelated accounts or documents merely to simplify validation.
- [ ] With fresh synthetic accounts in one organization, validate level 0–3 ordinary reads, same-organization isolation, an admin with lower clearance failing normal reads, upload default 0, explicit high-level upload by a lower-clearance employee, disabled-account denial, and the high-level certificate archive PAO. Validate removed `/labels` and `/audit` return no routable employee-facing capability.
- [ ] Run the official browser-auth/MCP acceptance using the newly published launcher and synthetic accounts. Confirm MCP offers no label tool/inputs, current-user returns clearance, and no skill or server recommendation points to a package version unavailable from npm.
- [ ] Clean all run-scoped synthetic accounts, uploads, storage objects, vectors, database rows, local generated files, and local containers as required by the official workflow. Record only non-secret results and rollback limitations: application rollback never reverses the applied Prisma migration, so restoration requires the approved database backup procedure.

**Verification:** Deployment/readiness output, focused staging smoke, official acceptance evidence, post-cleanup residue checks, and final `git diff --check`.

**Commit:** No code commit is expected for successful release validation; record a concise progress milestone only when state materially changes.

## Completion Criteria

- [ ] The schema, API, worker/retrieval paths, and MCP launcher contain no label/manager authorization model or compatibility behavior.
- [ ] Every ordinary document-derived response is constrained by organization, disabled state, and clearance, independently of role.
- [ ] Every admin check in employee-facing code is an API/product-declared PAO with explicit scope; the certificate archive PAO works above the caller's clearance without expanding ordinary reads.
- [ ] New accounts require explicit role and clearance; uploads default to 0 only when no level is explicitly given; neither value is editable in product.
- [ ] The released launcher and both maintained MCP skills are synchronized and independently verified, and the repository quality gates pass.
