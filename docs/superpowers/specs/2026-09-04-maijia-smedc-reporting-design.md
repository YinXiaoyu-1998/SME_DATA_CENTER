# Maijia SME Data Center Reporting Design

Date: 2026-09-04

Status: approved for implementation

Base branch: `main` at `f47888cfceb0c0ffb97013f50732c22ce5bed94c`

Lead branch: `codex/maijia-smedc-reporting`

## Goal

Create a public `YinXiaoyu-1998/maijia-business-analyses-smedc` skill repository that lets an employee-owned agent generate Maijia operating diagnoses, weekly reports, and monthly reports from Enterprise Hub structured data. Extend Enterprise Hub only with authorization-safe, mechanical structured-data capabilities required by that skill. Enterprise Hub remains an information hub and does not become a report generator, analysis service, or skill runtime.

The new skill intentionally excludes the original repository's monthly profit and profit-rate workflow. No profit dataset or profit-report compatibility path will be added.

## Product Boundaries

- The employee agent uses the official Enterprise Hub MCP launcher and authenticated MCP tools. The reporting skill never reads the service database, storage, bearer tokens, secure-store records, or private service configuration.
- Enterprise Hub returns discoverable schemas, permission-scoped coverage facts, detail rows, and mechanical aggregates. It does not decide whether available data is sufficient for a report and does not produce business conclusions or report artifacts.
- The reporting skill owns period selection, source sufficiency assessment, partial-report behavior, metric derivation, Maijia-specific store bucketing, dish-to-catalog matching, management interpretation, fact tables, and HTML rendering.
- Missing current, comparison, trend, dish, or catalog data is a normal input condition. The skill produces every supportable module and explicitly marks omitted or partial modules. It must not turn missing optional data into a service failure.
- The current staging service is QA-only. Existing `business` and `dishes` structured imports may be hard-deleted and re-imported for the new registry contract. The implementation must not preserve obsolete payload keys, schemas, endpoints, or query behavior through compatibility aliases, dual reads, shadow tables, or intermediate versions.
- Backend authorization remains mandatory for every new endpoint and aggregate. Coverage, grouping, sorting, and pagination operate only after the same document/import/label visibility predicate used by existing structured queries.

## Considered Approaches

### 1. General mechanical query improvements (selected)

Upgrade the existing structured registry and controlled query language so the reporting skill can request compact, permission-scoped facts. The skill joins and interprets those facts locally. This preserves the service boundary, supports future non-reporting consumers, and avoids transferring large raw exports through the model.

### 2. Asynchronous report-fact export service

Enterprise Hub could accept a report-oriented request and return a generated fact bundle or signed file. This would reduce MCP calls but introduces job lifecycle, storage, report-specific schemas, and server-side knowledge of the Maijia workflow. It is rejected because it moves harness and analysis responsibilities into the information hub.

### 3. Detail-row pagination with all aggregation in the skill

The existing API could paginate every matching row and let the skill reproduce the XLSX profiler locally. This avoids a query-language change but is unsuitable for 16-week business windows and high-volume dish data: it creates excessive MCP round trips, large model-visible payloads, and fragile cursor timing. It is rejected as a production design, not retained as a fallback.

## Enterprise Hub Structured Registry

### Dataset scope

The implementation uses the existing datasets only:

- `business`
- `dishes`
- `dish_catalog`

`vip`, delivery-ledger, supplier-catalog, evidence, and quarantine-certificate behavior remains unchanged. No profit dataset is introduced.

### Registry replacement

Publish final v2 registries for `business` and `dishes`. All report-consumed fields receive explicit semantic canonical names instead of position-derived names. At minimum this includes:

- business identity and grouping fields: business date/week/month, store, city, merchant, order category/source, meal period, time slot, membership, and dining method;
- business measures: gross sales, order revenue, discount, valid/reverse/positive/settled orders, diner count, consumed tables, table count/use/day denominators, dine-in and delivery sales/revenue/discount/order/refund measures, delivery-platform revenue, and member revenue;
- dish identity and grouping fields: business date/week/month, store, product name, linked product name, order category, time slot, merchant, and organization code;
- dish measures used by the reports: quantity, sales, revenue, discount, total sales/revenue/discount, positive orders, returned quantity/amount, serving orders, and after-discount gross margin.

Counts and physical quantities use numeric registry types. Use `decimal` where an upstream grouped export can legally contain fractional values; use `integer` only for fields whose source contract is strictly integral. Import validation rejects malformed numeric values rather than relying on MySQL string coercion.

`dish_catalog` already has semantic names for dish name, base category, identifiers, aliases, price, and snapshot date, so its registry changes only if tests expose a genuine contract defect.

Existing staging `business` and `dishes` imports are removed before final acceptance and replaced with data imported under the v2 payload keys. No dual-key lookup or compatibility alias is added.

## Controlled Structured Query Language

### Grouping

Increase `maxGroupByFields` from 1 to 4. Every group field must retain registry `group=true`. The compiler emits a deterministic order over every group field when the caller does not specify an order, preserving stable cursor pagination.

The four-field ceiling supports the largest required mechanical shapes without arbitrary query expansion:

- store + business date/week/month;
- store + order category + order source;
- store + meal period + time slot;
- store + product name + linked product name + sales class.

### Aggregates

Increase `maxAggregates` from 5 to 12. Existing `count`, `countDistinct`, `sum`, `avg`, `min`, and `max` behavior remains controlled by field capabilities.

Add a single general-purpose aggregate:

```json
{
  "op": "weightedAvg",
  "field": "open_rate",
  "weightField": "table_day_count",
  "as": "weighted_open_rate"
}
```

Both fields must be numeric, aggregatable, stored fields from the same dataset. The SQL expression is equivalent to `SUM(value * weight) / NULLIF(SUM(weight), 0)`. Null or zero total weight produces `null`. No arbitrary expressions, formulas, field arithmetic, joins, or window functions are accepted.

### Aggregate ordering

Aggregate-mode sort fields may reference either a group-by canonical name or a unique aggregate alias declared in the same query. Alias sorting is compiled from the already validated aggregate expression; it never accepts raw SQL. Detail-mode sorting remains registry-field-only.

### Pagination and limits

Keep cursor scope, signing, expiry, authorization binding, and query-shape hashing. Set the aggregate page ceiling to 200 groups so common store/product requests remain bounded while avoiding unnecessary tool round trips. Performance gates must cover a four-field grouping, 12 aggregates, aggregate-alias ordering, and weighted averages on the maximum supported import size.

## Permission-Scoped Coverage API

Add:

- `GET /v1/structured/datasets/:dataset/coverage`
- MCP tool `describe_structured_dataset_coverage`

The endpoint accepts one supported dataset name and returns only currently visible, active, applied sources. It uses the same organization, employee state, label, document-kind/status/archive, and import-status/archive predicates as structured query.

For window datasets it returns ordered non-overlapping visible import-window records containing dataset, start date, end date, applied row count, source document ID, import batch ID, and applied timestamp. For snapshot datasets it returns ordered snapshot records with snapshot date and the same safe lineage/count fields. Datasets without window or snapshot metadata return an empty coverage collection with their metadata policy.

The API reports facts only. It does not label coverage complete/incomplete, select report periods, infer missing dates from business semantics, choose a current catalog, or recommend remediation. The reporting skill performs those decisions.

Cross-organization, disabled-account, inaccessible-label, archived, pending, failed, and rejected sources are excluded without enumeration. Tests cover admin, manager label intersection, all-staff visibility, disabled users, cross-organization isolation, and archived sources using the existing authorization fixtures rather than a new harness.

## MCP Contract And Launcher Release

The group/aggregate schema changes and new MCP tool alter the public launcher contract. Bump the launcher directly from `0.2.5` to `0.2.6` in the authoritative package, runtime constants, package verification, and alignment tests.

Release order is mandatory:

1. Merge the reviewed API/MCP contract and launcher `0.2.6` source while leaving server recommended-version metadata and both base-skill pins at `0.2.5`.
2. Let the trusted GitHub workflow publish the package after native macOS/Windows and package acceptance.
3. Independently verify the npm registry artifact, integrity, clean exact-version install, production audit, CLI version, self-check shape, and MCP discovery against staging.
4. Only after publication, update server recommended metadata and every official pin to `0.2.6`.
5. Synchronize the repo-local `skills/enterprise-hub-mcp` and public `YinXiaoyu-1998/enterprise-hub-mcp-skill` contents byte-for-byte where required.
6. Merge the synchronization PR and deploy the canonical `main` release to staging.

The service continues to accept the existing minimum-compatible launcher range unless implementation evidence proves the new query contract cannot be safely exposed to older launchers. The recommended version becomes `0.2.6` only after its artifact is available.

## Public Reporting Skill Repository

Create the public MIT-licensed repository:

`YinXiaoyu-1998/maijia-business-analyses-smedc`

The default branch is `main`. The repository is independently installable under the canonical user skill directory and contains no service secrets, customer exports, test credentials, or copied launcher source.

### Components

- `SKILL.md`: routing, Enterprise Hub dependency, date-window rules, partial-data policy, MCP query workflow, report semantics, and safety boundaries.
- `config/maijia.json`: company name, store display normalization, and large/small store buckets. Maijia-specific configuration is centralized instead of branching throughout analysis code.
- `scripts/build_query_plan.py`: validates requested current/previous/YoY/trend windows and emits deterministic abstract query jobs using source-column semantics.
- `scripts/assemble_query_bundle.py`: validates MCP response envelopes saved by the invoking agent, follows cursor lineage, and produces a versioned local fact-input bundle. It never invokes HTTP, reads credentials, or starts the launcher itself.
- `scripts/profile_weekly_data.py` and `scripts/profile_monthly_data.py`: derive the same report fact tables from compact grouped query results.
- HTML generators: adapted from the original repository while removing file-acquisition, workbook streaming, and profit-report assumptions.
- focused tests and small synthetic fixtures for query planning, metric derivation, catalog matching, partial modules, and final HTML smoke.

The agent, not a hidden local daemon, executes the query jobs with `list_structured_datasets`, `describe_structured_dataset_coverage`, and paginated `query_structured_dataset`. Tool responses are stored verbatim in the run directory and validated before profiling. Every result file records dataset, effective registry version, query job ID, page order, and query-shape metadata so stale or mixed responses fail closed.

### Report scope

Included:

- general operating diagnosis;
- weekly and monthly KPI comparisons;
- 16-week and 6-month trends when present;
- store-size-bucketed portfolio comparison;
- dine-in/delivery/platform mix;
- member revenue;
- hourly and meal-period attribution;
- stall/category attribution using `dishes` plus `dish_catalog`;
- stall sales mix;
- both product-sales-per-10K panels;
- deterministic fact tables and self-contained HTML.

Excluded:

- Meituan browser export/download instructions;
- direct local XLSX/CSV source ingestion for business, dishes, or catalog data;
- monthly profit/profit-rate scripts, inputs, outputs, documentation, and tests;
- service-side report generation or business conclusions.

### Partial-data behavior

The report includes a source-coverage section listing requested and observed windows. Core business sections render from any supported current-period data. Comparison metrics render only for available baselines. Trend charts render available complete buckets and label missing buckets. Dish/catalog modules disable independently when either input is absent or has no usable overlap. Every omission is a concise data-boundary notice, not an exception, fabricated zero, or service-health diagnosis.

## Testing And Acceptance

### Enterprise Hub

Use focused red-green tests for registry typing/names, four-field grouping, weighted average, aggregate-alias sorting, coverage authorization, MCP delegation, and launcher contract alignment. Run repository-wide format, lint, typecheck, unit tests, release build, launcher packaging tests, local integration, MCP smoke, and relevant structured-query performance gates once on the final tree.

Run one manual local API/MCP acceptance with synthetic `business`, `dishes`, and `dish_catalog` inputs. Verify grouped facts and coverage responses against independently calculated expected values. Remove every local database/container/file artifact afterward.

### Reporting skill

Use compact synthetic fixtures rather than exhaustive matrices. Verify weekly, monthly, and partial-data outputs; compare key totals and ratios to hand-calculated expectations; open the HTML and visually inspect the main report sections and missing-data notices.

### Staging and employee-agent acceptance

After deployment, create a fresh synthetic account and run-scoped data. Upload only synthetic structured inputs through the official launcher. Open multiple new user-visible Codex tasks, each with one ordinary employee request:

1. generate an operating diagnosis;
2. generate a weekly report;
3. generate a monthly report;
4. generate a report from intentionally partial data.

The tasks must use the installed public reporting skill and staging Enterprise Hub tools. Verify the resulting artifacts and transcripts, then remove the synthetic account, imports, documents, object-storage data, and any local acceptance output. Do not use the human owner's account or expose credentials to the model.

## Repository And PR Structure

Use separate branches and PRs for independently releasable boundaries:

1. SME Data Center query/coverage contract plus launcher `0.2.6` source.
2. Post-publication recommended-version and dual-homed base-skill synchronization.
3. Standalone `enterprise-hub-mcp-skill` synchronization PR.
4. New public `maijia-business-analyses-smedc` repository and its initial release.

Every SME Data Center PR reports inserted/deleted line composition by production code/config, runtime/CI/deploy, tests, documentation, and lockfile. Execution plans, SDD reports, scratch ledgers, and handoff logs are excluded from PRs. Durable architecture, API, ADR, user-flow, and skill documentation remains eligible.

Subagents use `gpt-5.5` with high reasoning effort, own isolated branches/worktrees, remain inside their assigned workstream, run focused verification, and append a concise handoff before stopping.
