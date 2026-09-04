# General Structured Query Enhancements Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extend Enterprise Hub's controlled structured-query API with reusable multi-dimensional aggregation, weighted averages, aggregate-result sorting, larger bounded result sets, and authorization-safe dataset coverage discovery.

**Architecture:** Keep all query semantics in `@enterprise-hub/domain`, schema parity in `@enterprise-hub/mcp-contract`, and database execution in the API repository. Coverage discovery is a first-class read model compiled with the same organization/document-label visibility rules as row queries. Dataset registries describe field meaning and capability; no query behavior may branch on Maijia, restaurant, report, weekly, monthly, stall, or dish use cases.

**Tech Stack:** TypeScript, Zod, Fastify, Prisma/MySQL, Vitest, MCP, npm workspaces

**Spec:** `docs/superpowers/specs/2026-09-04-maijia-smedc-reporting-design.md`

## Global Constraints

- Every controlled-query enhancement is dataset-agnostic and reusable by every registered structured dataset.
- Do not add report templates, computed business KPIs, completeness judgments, joins, arbitrary SQL, or dataset-specific query modes to the service.
- Retain backend organization, role, label, document-status, import-status, and archive authorization for every returned row and coverage record.
- Replace the `business` and `dishes` registries directly with explicit v2 contracts; no compatibility aliases for old generated canonical names and no dual registry versions.
- Persist a required registry version on every import batch and exclude mismatched historical payloads from query and coverage results.
- Set `maxGroupByFields` to `4`, `maxAggregates` to `12`, and `maxAggregateGroups` to `200`; retain cursor signing and the existing `maxRows` of `200`.
- Define `weightedAvg(field, weightField)` as `SUM(field * weightField) / NULLIF(SUM(weightField), 0)` and return SQL `NULL` when the denominator is zero.
- Aggregate sorting may reference a group field or a unique aggregate alias only.
- Coverage describes readable applied imports; it does not decide whether a report has enough data.
- Launcher contract changes require version `0.2.6`, package/alignment tests, publication verification, and only then recommended-version/pin synchronization.
- Tests must be proportional: focused domain/route/MCP/launcher coverage plus one final repository-wide gate.

---

### Task 1: Explicit v2 field registries for `business` and `dishes`

**Files:**
- Modify: `packages/domain/src/structured-registry.ts`
- Modify: `packages/domain/src/structured-registry.test.ts`
- Modify: `packages/structured-ingestion/src/index.test.ts`
- Modify: `packages/db/prisma/schema.prisma`
- Create: `packages/db/prisma/migrations/20260904130000_import_batch_registry_version/migration.sql`
- Modify: `apps/api/src/structured-imports.ts`
- Modify: `apps/api/src/structured-imports.test.ts`
- Modify: `apps/api/src/routes/structured-import/routes.ts`
- Modify: `apps/api/src/routes/structured-import/structured-import.test.ts`

**Interfaces:**
- Produces: `business.2026-09-04.v2` and `dishes.2026-09-04.v2` registries whose report-relevant source columns have stable canonical names and explicit numeric/date types.
- Produces: required `ImportBatch.registryVersion` provenance carried from file profile/reservation into MySQL and API records.
- Consumes: existing `StructuredFieldRegistryEntry`, header alias resolution, and JSON-payload storage.

- [ ] **Step 1: Add failing registry assertions**

Add table-driven assertions that at minimum map these source columns and types:

```ts
const expected = [
  ["business", "桌台数量", "table_count", "integer"],
  ["business", "桌台使用次数", "table_use_count", "integer"],
  ["business", "桌台数x营业天数", "table_days", "integer"],
  ["business", "消费桌数", "served_table_count", "integer"],
  ["business", "消费次数", "consumption_count", "integer"],
  ["business", "店内营业收入", "dine_in_revenue", "decimal"],
  ["business", "外卖营业收入", "delivery_revenue", "decimal"],
  ["dishes", "菜品销售额", "dish_sales_amount", "decimal"],
  ["dishes", "菜品收入", "dish_revenue", "decimal"],
  ["dishes", "菜品总销售额", "dish_total_sales_amount", "decimal"],
  ["dishes", "菜品总收入", "dish_total_revenue", "decimal"]
] as const;
```

Also assert each numeric field has `aggregate: true`, each dimension used for grouping has `group: true`, and registry versions equal the v2 values.

- [ ] **Step 2: Run the focused tests and confirm RED**

Run: `npm test -- packages/domain/src/structured-registry.test.ts packages/structured-ingestion/src/index.test.ts`

Expected: failures showing missing canonical mappings, wrong string types, or old v1 versions.

- [ ] **Step 3: Make field contracts explicit**

Extend `DISH_CANONICAL_OVERRIDES` and `BUSINESS_CANONICAL_OVERRIDES` for all fields consumed by the original weekly/monthly meeting pipelines. Add an `explicitTypes?: Record<string, StructuredFieldType>` input to `createRegistry`, and resolve types with:

```ts
const type = input.explicitTypes?.[sourceColumn] ?? inferFieldType(input.dataset, sourceColumn);
```

Populate `DISH_EXPLICIT_TYPES` and `BUSINESS_EXPLICIT_TYPES` for every exported measure whose name-based inference is ambiguous. Bump only the two registry versions to the v2 identifiers above.

- [ ] **Step 4: Add failing import-provenance tests**

Assert `profileStructuredFile`'s registry version is passed into `reserveStructuredImport`, persisted on `ImportBatch`, returned by `StructuredImportBatchRecord`, included in source metadata/audit facts, and rejected if it does not equal the active registry at reservation time.

- [ ] **Step 5: Add the required database column and import wiring**

Add `registryVersion String @map("registry_version") @db.VarChar(128)` to `ImportBatch`. The migration must add the column nullable, backfill exact pre-release versions by dataset (`dishes.2026-07-11.v1`, `business.2026-07-11.v1`, `vip.2026-08-12.v1`, `dish_catalog.2026-08-22.v1`, `delivery_ledger.2026-08-29.v1`, `supplier_catalog.2026-08-29.v1`), then alter it to `NOT NULL`; do not assign v2 to historical payloads. Pass the profiled registry version through route workflow and `ReserveStructuredImportInput`, and validate it against `getStructuredRegistry(dataset).version` before creating documents/batches.

- [ ] **Step 6: Run focused tests and inspect the published registry**

Run: `npm run db:generate && npm test -- packages/domain/src/structured-registry.test.ts packages/structured-ingestion/src/index.test.ts apps/api/src/structured-imports.test.ts apps/api/src/routes/structured-import/structured-import.test.ts`

Expected: PASS. Manually inspect one registry snapshot through the existing dataset route test to verify canonical names and numeric capabilities are visible to clients.

- [ ] **Step 7: Commit**

```bash
git add packages/domain/src/structured-registry.ts packages/domain/src/structured-registry.test.ts packages/structured-ingestion/src/index.test.ts packages/db/prisma/schema.prisma packages/db/prisma/migrations/20260904130000_import_batch_registry_version/migration.sql apps/api/src/structured-imports.ts apps/api/src/structured-imports.test.ts apps/api/src/routes/structured-import/routes.ts apps/api/src/routes/structured-import/structured-import.test.ts
git commit -m "feat: publish explicit business dataset registries"
```

### Task 2: General aggregate query language

**Files:**
- Modify: `packages/domain/src/structured-query.ts`
- Modify: `packages/domain/src/structured-query.test.ts`
- Modify: `packages/mcp-contract/src/index.ts`
- Modify: `packages/mcp-contract/src/index.test.ts`

**Interfaces:**
- Produces: aggregate spec `{ op: "weightedAvg", field: string, weightField: string, as?: string }` in addition to existing operators.
- Produces: sort spec field resolution against group fields or aggregate aliases in aggregate mode.
- Produces: limits `{ maxGroupByFields: 4, maxAggregates: 12, maxAggregateGroups: 200 }` shared by domain and MCP validation.

- [ ] **Step 1: Add failing domain tests for every new generic semantic**

Add tests compiling a query shaped like:

```ts
{
  dataset: "business",
  registryVersion: "business.2026-09-04.v2",
  groupBy: ["store_name", "order_source", "meal_period"],
  aggregates: [
    { op: "sum", field: "order_revenue", as: "revenue" },
    {
      op: "weightedAvg",
      field: "discount_rate",
      weightField: "gross_sales_amount",
      as: "weighted_discount_rate"
    }
  ],
  sort: [{ field: "revenue", direction: "desc" }],
  page: { limit: 200 }
}
```

Assert parameter order, `SUM(value * weight) / NULLIF(SUM(weight), 0)`, quoted alias ordering, three group fields, limit `201` at repository execution, duplicate alias rejection, unknown alias rejection, non-aggregatable value/weight rejection, missing `weightField` rejection, and cursor shape changes when any aggregate/sort shape changes.

Also assert the base query SQL contains `ib.registry_version = ?` bound to the requested registry version, so rows written under older JSON contracts cannot be read through the active registry.

- [ ] **Step 2: Add failing MCP schema parity tests**

Parse the same input through `queryStructuredDatasetInputSchema`, assert acceptance at the new maxima, and assert rejection of 5 group fields, 13 aggregates, a `weightedAvg` without `weightField`, and a non-weighted operator with `weightField`.

- [ ] **Step 3: Run focused tests and confirm RED**

Run: `npm test -- packages/domain/src/structured-query.test.ts packages/mcp-contract/src/index.test.ts`

Expected: schema/operator/alias-sort failures.

- [ ] **Step 4: Implement discriminated aggregate specs and alias-aware sorting**

Use a discriminated internal union:

```ts
type AggregateSpec =
  | { op: "count"; field?: string; as?: string }
  | { op: "countDistinct" | "sum" | "avg" | "min" | "max"; field: string; as?: string }
  | { op: "weightedAvg"; field: string; weightField: string; as?: string };
```

Normalize and reject unknown keys. Build a unique alias map before validating sort. In aggregate mode resolve `sort.field` first as a group field, then as an aggregate alias; emit `ORDER BY ` plus `quoteIdentifier(alias)` for aliases. Never interpolate unvalidated input. Generate the weighted expression with two typed JSON expressions and parameters in SQL placeholder order.

- [ ] **Step 5: Update the public Zod contract**

Replace the aggregate object with a discriminated union whose weighted branch requires `weightField` and whose other branches reject it. Export or retain the schema through the package's existing public tool-definition path; keep domain and MCP limit objects aligned.

- [ ] **Step 6: Run focused tests and commit**

Run: `npm test -- packages/domain/src/structured-query.test.ts packages/mcp-contract/src/index.test.ts`

Expected: PASS.

```bash
git add packages/domain/src/structured-query.ts packages/domain/src/structured-query.test.ts packages/mcp-contract/src/index.ts packages/mcp-contract/src/index.test.ts
git commit -m "feat: extend controlled aggregate queries"
```

### Task 3: Authorization-safe structured dataset coverage

**Files:**
- Create: `packages/domain/src/structured-coverage.ts`
- Create: `packages/domain/src/structured-coverage.test.ts`
- Modify: `packages/domain/src/index.ts`
- Create: `apps/api/src/structured-coverage.ts`
- Create: `apps/api/src/structured-coverage.test.ts`
- Modify: `apps/api/src/app-context.ts`
- Modify: `apps/api/src/server.ts`
- Modify: `apps/api/src/routes/structured-query.ts`
- Modify: `apps/api/src/routes/structured-query.test.ts`

**Interfaces:**
- Produces: `compileStructuredCoverageQuery(input: { orgId: string; employee: StructuredQueryEmployeeScope; dataset: StructuredDatasetName }): StructuredCompiledCoverageQuery`.
- Produces: `StructuredCoverageRepository.list(compiled): Promise<StructuredDatasetCoverage>`.
- Produces: authenticated `GET /v1/structured/datasets/:dataset/coverage`.

- [ ] **Step 1: Define the response and failing compiler tests**

Use this stable response shape:

```ts
interface StructuredDatasetCoverage {
  dataset: StructuredDatasetName;
  registryVersion: string;
  metadataPolicy: "window" | "snapshot" | "derived_receipt" | "none";
  sources: Array<{
    importBatchId: string;
    sourceDocumentId: string;
    sourceDocumentTitle: string;
    startDate: string | null;
    endDate: string | null;
    appliedAt: string;
    rowCount: number;
  }>;
}
```

Compiler tests must assert organization scoping, applied/non-archived import filtering, active/non-archived structured document filtering, exact persisted registry-version filtering, `all_staff OR employee-label` filtering for non-admins, no label predicate for admins, deterministic `start_date, end_date, applied_at, id` ordering, and registry-version/metadata-policy projection.

- [ ] **Step 2: Run the compiler test and confirm RED**

Run: `npm test -- packages/domain/src/structured-coverage.test.ts`

Expected: module/function missing.

- [ ] **Step 3: Implement the compiler without completeness logic**

Build parameterized SQL over `import_batches ib JOIN documents d`; include `ib.total_row_count` or `applied_row_count` consistently as `row_count`, format dates in the repository, and reuse the existing label predicate semantics exactly. Do not merge windows, calculate gaps, infer current/latest sufficiency, or suppress overlapping readable sources.

- [ ] **Step 4: Add failing repository and route tests**

Repository tests cover bigint/date serialization. Route tests cover 401, invalid dataset 400, manager label filtering delegated into the compiled query, and a successful response. Use injected repositories; do not require a database for route unit tests.

- [ ] **Step 5: Implement repository, route, and lifecycle wiring**

Add `structuredCoverageRepository?: StructuredCoverageRepository` to `ApiServerOptions`, a lazy `structuredCoverage()` accessor to context, and disconnect it during close. Register the route beside the existing dataset-list/query routes and translate `StructuredQueryValidationError` through `phase3ErrorResponse`.

- [ ] **Step 6: Run focused tests and commit**

Run: `npm test -- packages/domain/src/structured-coverage.test.ts apps/api/src/structured-coverage.test.ts apps/api/src/routes/structured-query.test.ts`

Expected: PASS.

```bash
git add packages/domain/src/structured-coverage.ts packages/domain/src/structured-coverage.test.ts packages/domain/src/index.ts apps/api/src/structured-coverage.ts apps/api/src/structured-coverage.test.ts apps/api/src/app-context.ts apps/api/src/server.ts apps/api/src/routes/structured-query.ts apps/api/src/routes/structured-query.test.ts
git commit -m "feat: expose structured dataset coverage"
```

### Task 4: MCP read tool for coverage and enriched queries

**Files:**
- Modify: `packages/mcp-contract/src/index.ts`
- Modify: `packages/mcp-contract/src/index.test.ts`
- Modify: `apps/api/src/mcp/read-tools.ts`
- Modify: `apps/api/src/mcp/read-tools.test.ts`
- Modify: `apps/api/src/mcp/http.test.ts`
- Modify: `apps/api/src/structured-query-route.test.ts`

**Interfaces:**
- Produces: MCP tool `describe_structured_dataset_coverage` with input `{ dataset: StructuredDatasetName }` delegating to the coverage HTTP route.
- Preserves: `query_structured_dataset` name and response envelope while accepting Task 2's richer generic query body.

- [ ] **Step 1: Add failing contract and delegation tests**

Assert the tool appears exactly once, rejects unknown keys/datasets, forwards `GET /v1/structured/datasets/{dataset}/coverage`, propagates request/launcher audit headers through the existing delegator, and returns API error envelopes unchanged.

- [ ] **Step 2: Run tests and confirm RED**

Run: `npm test -- packages/mcp-contract/src/index.test.ts apps/api/src/mcp/read-tools.test.ts apps/api/src/mcp/http.test.ts apps/api/src/structured-query-route.test.ts`

Expected: missing tool/schema failures.

- [ ] **Step 3: Add the tool contract and handler**

Define a strict dataset-only input schema. Add a read-tool handler that URL-encodes the enum value even though the schema restricts it, delegates using the existing authenticated internal HTTP path, and does no data interpretation.

- [ ] **Step 4: Run tests and commit**

Run: `npm test -- packages/mcp-contract/src/index.test.ts apps/api/src/mcp/read-tools.test.ts apps/api/src/mcp/http.test.ts apps/api/src/structured-query-route.test.ts`

Expected: PASS.

```bash
git add packages/mcp-contract/src/index.ts packages/mcp-contract/src/index.test.ts apps/api/src/mcp/read-tools.ts apps/api/src/mcp/read-tools.test.ts apps/api/src/mcp/http.test.ts apps/api/src/structured-query-route.test.ts
git commit -m "feat: add structured coverage MCP tool"
```

### Task 5: Launcher 0.2.6 release boundary

**Files:**
- Modify: `apps/mcp-launcher/package.json`
- Modify: `package-lock.json`
- Modify: `apps/mcp-launcher/src/index.test.ts`
- Modify: `apps/mcp-launcher/src/oauth-client.test.ts`
- Modify: `apps/mcp-launcher/src/packaging.verify.ts`
- Modify: `apps/mcp-launcher/src/server.ts`
- Modify: relevant durable API/OpenAPI documentation identified by `rg "query_structured_dataset|structured/datasets" docs apps`

**Interfaces:**
- Produces: package `enterprise-hub-mcp-launcher@0.2.6` containing the new MCP contract.
- Documents: the generic HTTP/MCP contract while leaving recommended-version metadata and both base-skill pins at `0.2.5` until npm publication is independently verified.

- [ ] **Step 1: Update launcher alignment tests first**

Change every source/package/alignment expectation to `0.2.6`, and add a packaging assertion that the bundled tool list contains `describe_structured_dataset_coverage` and that `query_structured_dataset` accepts the weighted aggregate shape.

- [ ] **Step 2: Run launcher tests and confirm RED**

Run: `npm test -- apps/mcp-launcher/src/index.test.ts apps/mcp-launcher/src/oauth-client.test.ts && npm run --workspace @enterprise-hub/mcp-launcher verify:package`

Expected: version or bundled-contract mismatch.

- [ ] **Step 3: Bump launcher runtime/package metadata**

Set package/runtime version constants to `0.2.6`, run `npm install --package-lock-only` if necessary to update only the lockfile version entries, and make no unrelated dependency updates.

- [ ] **Step 4: Update durable API contract documentation**

Document exact HTTP/MCP request and response shapes for multi-field grouping, weighted average, alias sorting, and coverage discovery. State that coverage reports readable applied sources only and that clients interpret sufficiency. Do not change `apps/api/src/auth/http-contract.ts`, repo-local skill pins, standalone skill pins, or recommended-version tests in this pre-publication PR.

- [ ] **Step 5: Run focused release-boundary tests and commit**

Run: `npm test -- apps/mcp-launcher/src/index.test.ts apps/mcp-launcher/src/oauth-client.test.ts packages/mcp-contract/src/index.test.ts && npm run --workspace @enterprise-hub/mcp-launcher verify:package`

Expected: PASS.

```bash
git add apps/mcp-launcher packages/mcp-contract docs package-lock.json
git commit -m "chore: prepare enterprise hub launcher 0.2.6"
```

### Task 6: Service integration proof and final gates

**Files:**
- Modify: `apps/api/src/structured-query.prisma.integration.test.ts`
- Modify: `docs/implementation/progress.md`

**Interfaces:**
- Verifies: real MySQL execution for multi-group weighted aggregation, alias sort, coverage authorization, and pagination.

- [ ] **Step 1: Add one focused Prisma integration scenario**

Seed two labels, documents, applied imports, and rows across at least two groups. Assert a manager sees only label-readable sources/rows, the weighted result matches hand calculation, ordering follows the aggregate alias, and coverage returns the same readable source boundary.

- [ ] **Step 2: Run the focused integration test with local MySQL**

Run the repository's existing integration setup command and the focused test. Expected: PASS with real MySQL, not a mocked SQL executor.

- [ ] **Step 3: Run final repository gates once**

Run:

```bash
npm run lint
npm run typecheck
npm test
npm run format:check
```

Expected: all PASS. Run `npm run test:integration` only once on the final tree because the public structured path changed.

- [ ] **Step 4: Clean local test artifacts**

Remove run-created `.data` files, stop/remove repo-created containers, volumes, and networks, and verify with `docker ps -a`, `docker volume ls`, `docker network ls`, and `git worktree list`.

- [ ] **Step 5: Record the milestone and commit**

Add one concise progress entry with focused/full gate evidence; do not add a transcript.

```bash
git add apps/api/src/structured-query.prisma.integration.test.ts docs/implementation/progress.md
git commit -m "test: verify enriched structured queries"
```
