# Maijia SMEDC Reporting Skill Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a public, installable `maijia-business-analyses-smedc` skill that queries Enterprise Hub through MCP and deterministically generates operating diagnoses plus weekly and monthly meeting reports, including honest partial reports when source coverage is incomplete.

**Architecture:** The agent uses Enterprise Hub MCP tools to discover registries/coverage and execute a generated manifest of controlled queries. Python scripts never authenticate or call HTTP; they validate saved MCP response envelopes, assemble a versioned query bundle, derive fact tables, and render self-contained HTML. The original local-file skill supplies reporting definitions and visual generators, but all local XLSX/download logic and the monthly-profit workflow are removed.

**Tech Stack:** Python 3.11+, standard library, HTML/CSS/JavaScript, unittest, Codex skill metadata

**Spec:** `docs/superpowers/specs/2026-09-04-maijia-smedc-reporting-design.md`

## Global Constraints

- Repository name is exactly `maijia-business-analyses-smedc`; GitHub visibility is public; license is MIT.
- Use only Enterprise Hub MCP tools for remote data access. Scripts must not accept passwords/tokens or implement direct HTTP/OAuth.
- Supported report types are operating diagnosis, weekly meeting, and monthly meeting. Do not include profit scripts, profit docs, profit flags, or profit tests.
- Data insufficiency is normal. Missing coverage/modules produce explicit notices and partial reports; they are not service errors.
- Preserve the original skill's KPI definitions, dual denominator product-sales-per-10K panels, stall mapping, daypart attribution, and self-contained HTML style where the queried data supports them.
- Raw MCP envelopes, manifests, derived CSV/JSON, and reports are run artifacts and must be gitignored.
- Query requests must use registry versions returned by `list_structured_datasets`; never hard-code a stale version into generated jobs.
- Pin the official launcher to `enterprise-hub-mcp-launcher@0.2.6` only after that version is published and independently installable.
- Keep tests compact: manifest/query validation, bundle assembly, one weekly fixture, one monthly fixture, and HTML smoke assertions.

---

### Task 1: Initialize the standalone skill repository and contract fixtures

**Files:**

- Create: `README.md`
- Create: `README.zh.md`
- Create: `LICENSE`
- Create: `.gitignore`
- Create: `agents/openai.yaml`
- Create: `config/maijia.json`
- Create: `tests/fixtures/registry_response.json`
- Create: `tests/fixtures/coverage_business.json`
- Create: `tests/fixtures/coverage_dishes.json`
- Create: `tests/fixtures/coverage_dish_catalog.json`

**Interfaces:**

- Produces: one public-ready skill repo with config schema version `1`.
- Produces: config sections `datasets`, `fields`, `dimensions`, `measures`, `reportModules`, and `queryLimits`.

- [ ] **Step 1: Initialize an isolated local Git repository**

Create the repository outside SME_DATA_CENTER, initialize `main`, create branch `codex/initial-smedc-skill`, and do not publish it before launcher `0.2.6` exists. The README must state this is an Enterprise Hub-backed derivative of the original skill and link its upstream license/source.

- [ ] **Step 2: Write the MIT license and artifact ignore rules**

Ignore `output/`, `runs/`, `*.html`, generated `*.csv`, generated summaries, `__pycache__/`, and `.DS_Store`; do not ignore committed test fixtures.

- [ ] **Step 3: Define the reporting config and fixtures**

Use canonical dataset names `business`, `dishes`, `dish_catalog`. Define semantic field names for dates, stores, channel/order source, meal period, time slot, revenues, gross sales, discounts, order counts, diners, dish identity, dish quantity/revenue, and catalog category/stall mapping. Fixture responses must match the approved service response envelopes and use synthetic stores only. Window coverage sources use `startDate`/`endDate`; snapshot coverage sources use `snapshotDate` and omit window fields.

- [ ] **Step 4: Commit**

```bash
git add README.md README.zh.md LICENSE .gitignore agents config tests/fixtures
git commit -m "chore: initialize SMEDC reporting skill"
```

### Task 2: Generate a registry-bound query manifest

**Files:**

- Create: `scripts/build_query_plan.py`
- Create: `tests/test_build_query_plan.py`

**Interfaces:**

- Produces CLI: `python3 scripts/build_query_plan.py --report-type diagnosis|weekly|monthly --current-start YYYY-MM-DD --current-end YYYY-MM-DD --previous-start YYYY-MM-DD --previous-end YYYY-MM-DD --yoy-start YYYY-MM-DD --yoy-end YYYY-MM-DD --registry-response PATH --coverage-dir PATH --output PATH`.
- Produces JSON: `{ schemaVersion, report, coverage, notices, jobs[] }`, where every job has `id`, `tool`, `input`, `outputFile`, `module`.

- [ ] **Step 1: Write failing manifest tests**

Assert diagnosis jobs include business KPI, store, channel/platform, membership, payment, and operating-efficiency facts. Assert weekly jobs include current/previous/YoY store totals, 16-week trend, channel, daypart, and optional dish/catalog modules. Assert monthly jobs include current/previous/YoY, six natural-month current/prior-year trends, channel, daypart, and optional dish/catalog modules. A missing readable dataset/window disables only dependent modules and adds a machine-readable notice.

- [ ] **Step 2: Run tests and confirm RED**

Run: `python3 -m unittest tests.test_build_query_plan -v`

Expected: module missing.

- [ ] **Step 3: Implement strict registry and coverage validation**

Read `list_structured_datasets` and coverage envelopes, resolve the current registry versions, verify every configured field exists with the required capability, and generate only `query_structured_dataset` jobs. Use multi-field groupings, aggregate aliases, and `weightedAvg` when the metric definition requires weighting. Treat coverage as source facts: intersect requested windows, but do not claim that an import's row contents are complete.

- [ ] **Step 4: Make manifest ordering deterministic**

Sort jobs by module then stable job id; sort notices by code/dataset/window. Reject an unknown report type, invalid/overlapping date arguments that violate the comparison contract, malformed service envelopes, duplicate job ids, or any job exceeding advertised query limits.

- [ ] **Step 5: Run tests and commit**

Run: `python3 -m unittest tests.test_build_query_plan -v`

Expected: PASS.

```bash
git add scripts/build_query_plan.py tests/test_build_query_plan.py
git commit -m "feat: build Enterprise Hub report query plans"
```

### Task 3: Assemble and validate MCP query bundles

**Files:**

- Create: `scripts/assemble_query_bundle.py`
- Create: `tests/test_assemble_query_bundle.py`

**Interfaces:**

- Consumes: Task 2 manifest plus one saved JSON response per `jobs[].outputFile`.
- Produces: `bundle.json` with schema version, report windows, registry versions, coverage sources, notices, and `resultsByJobId`.

- [ ] **Step 1: Write failing assembly tests**

Cover successful assembly, multiple cursor pages concatenated in order, missing response -> module notice, API/MCP error envelope -> module notice, dataset/registry/mode mismatch -> hard validation error, and duplicate group rows across pages -> hard validation error.

- [ ] **Step 2: Run tests and confirm RED**

Run: `python3 -m unittest tests.test_assemble_query_bundle -v`

Expected: module missing.

- [ ] **Step 3: Implement envelope validation and pagination assembly**

Accept either a single response object or an array of page responses. Require each page's `dataset`, `registryVersion`, and `mode` to match the job. Require a null final cursor and a non-null cursor on every non-final page. Preserve row values exactly; do not recompute aggregates locally from incomplete detail samples.

- [ ] **Step 4: Run tests and commit**

Run: `python3 -m unittest tests.test_assemble_query_bundle -v`

Expected: PASS.

```bash
git add scripts/assemble_query_bundle.py tests/test_assemble_query_bundle.py
git commit -m "feat: assemble validated query bundles"
```

### Task 4: Derive weekly and monthly report facts

**Files:**

- Create: `scripts/report_common.py`
- Create: `scripts/profile_business_data.py`
- Create: `scripts/profile_weekly_data.py`
- Create: `scripts/profile_monthly_data.py`
- Create: `tests/fixtures/diagnosis_bundle.json`
- Create: `tests/fixtures/weekly_bundle.json`
- Create: `tests/fixtures/monthly_bundle.json`
- Create: `tests/test_profile_business_data.py`
- Create: `tests/test_profile_weekly_data.py`
- Create: `tests/test_profile_monthly_data.py`

**Interfaces:**

- Produces CLI: `profile_business_data.py --bundle PATH --output-dir PATH`.
- Produces CLI: `profile_weekly_data.py --bundle PATH --output-dir PATH`.
- Produces CLI: `profile_monthly_data.py --bundle PATH --output-dir PATH`.
- Produces the weekly/monthly CSV and summary filenames consumed by the original HTML generators, excluding monthly-profit artifacts.

- [ ] **Step 1: Write one synthetic diagnosis, weekly, and monthly golden test**

Use two stores, two channels, two dayparts, two stalls, and a deliberate missing optional module. Assert diagnosis KPI/channel/platform/member/payment/efficiency facts, store totals, comparison deltas, weighted rates, trend bucket labels, store-size classification, channel/daypart driver selection, stall attribution, both product-sales-per-10K denominators, and the missing-module notice.

- [ ] **Step 2: Run tests and confirm RED**

Run: `python3 -m unittest tests.test_profile_business_data tests.test_profile_weekly_data tests.test_profile_monthly_data -v`

Expected: modules missing.

- [ ] **Step 3: Port deterministic transformations from the original skill**

Reimplement business definitions from `profile_business_data.py`, `profile_weekly_meeting_data.py`, and `profile_monthly_meeting_data.py`, replacing XLSX scanning with named aggregate job rows from `bundle.json`. Centralize decimal parsing, safe division, percent formatting inputs, comparison deltas, notice propagation, and CSV writing in `report_common.py`.

- [ ] **Step 4: Preserve attribution and denominator semantics**

Map `dishes.matched_product_name`/`product_name` to `dish_catalog` category/stall fields using normalized text. Keep unresolved rows as `未匹配`. Compute dish quantity per ¥10K against both all-channel `order_revenue` and `gross_sales_amount`; never substitute dish revenue as the denominator.

- [ ] **Step 5: Run tests and commit**

Run: `python3 -m unittest tests.test_profile_business_data tests.test_profile_weekly_data tests.test_profile_monthly_data -v`

Expected: PASS.

```bash
git add scripts/report_common.py scripts/profile_business_data.py scripts/profile_weekly_data.py scripts/profile_monthly_data.py tests/fixtures/diagnosis_bundle.json tests/fixtures/weekly_bundle.json tests/fixtures/monthly_bundle.json tests/test_profile_business_data.py tests/test_profile_weekly_data.py tests/test_profile_monthly_data.py
git commit -m "feat: derive diagnosis and meeting report facts"
```

### Task 5: Render self-contained weekly and monthly HTML

**Files:**

- Create: `scripts/generate_business_report_html.py`
- Create: `scripts/generate_weekly_report_html.py`
- Create: `scripts/generate_monthly_report_html.py`
- Create: `scripts/run_business_report.py`
- Create: `scripts/run_weekly_report.py`
- Create: `scripts/run_monthly_report.py`
- Create: `tests/test_report_html.py`
- Create: `references/report_style.zh.md`

**Interfaces:**

- Consumes: Task 4 output directories.
- Produces: standalone HTML files with embedded CSS/data/scripts and no network dependencies.

- [ ] **Step 1: Write failing renderer smoke tests**

Assert the diagnosis HTML includes source provenance, KPI/channel/platform/member/payment/efficiency facts, store comparisons, and notices. Assert weekly/monthly HTML includes title/window/source provenance, current-vs-previous-vs-YoY summary, trend, store quadrant/ranking, channel, hourly/daypart, stall mix and product panels when available, visible partial-data notices when unavailable, accessible table fallbacks, and no external `<script src>` or stylesheet URL.

- [ ] **Step 2: Run tests and confirm RED**

Run: `python3 -m unittest tests.test_report_html -v`

Expected: renderer modules missing.

- [ ] **Step 3: Adapt the original generators**

Independently reimplement the approved self-contained visual layout and interactions using the original reports as behavioral reference; do not copy upstream source verbatim because the upstream repository currently exposes no license metadata. Rename entry points and inputs for bundle-derived facts. Remove every monthly-profit reference and every instruction that asks for local Meituan workbook paths.

- [ ] **Step 4: Implement runners**

Runners call only the corresponding profiler and renderer. Diagnosis, weekly, and monthly runners accept `--bundle`, `--output-dir`, and `--report`; they print a final JSON object naming created artifacts and propagated notices.

- [ ] **Step 5: Run tests and commit**

Run: `python3 -m unittest tests.test_report_html -v`

Expected: PASS.

```bash
git add scripts/generate_business_report_html.py scripts/generate_weekly_report_html.py scripts/generate_monthly_report_html.py scripts/run_business_report.py scripts/run_weekly_report.py scripts/run_monthly_report.py tests/test_report_html.py references/report_style.zh.md
git commit -m "feat: render SMEDC operating reports"
```

### Task 6: Author the skill workflow and validate the repository

**Files:**

- Create: `SKILL.md`
- Modify: `README.md`
- Modify: `README.zh.md`
- Modify: `agents/openai.yaml`
- Create: `tests/test_skill_contract.py`

**Interfaces:**

- Produces: an agent workflow that installs/logs in through `enterprise-hub-mcp`, obtains registries and coverage, executes manifest jobs including cursors, saves responses, assembles the bundle, and runs the requested report renderer.

- [ ] **Step 1: Read the `skill-creator` and `superpowers:writing-skills` instructions in full**

Validate frontmatter, naming, progressive disclosure, test conventions, and packaged assets before writing `SKILL.md`.

- [ ] **Step 2: Write failing contract tests**

Assert `SKILL.md` names all three required MCP tools, launcher `0.2.6`, all three supported report types, pagination, partial-report behavior, and cleanup/provenance. Assert it contains no `monthly_profit`, profit-workbook, signed-download, direct HTTP, password, or token-handling workflow.

- [ ] **Step 3: Write the complete agent workflow**

Use ordinary user intent as the trigger. Give exact commands for plan generation, expected MCP calls, response filenames, bundle assembly, profiling/rendering, artifact opening, and partial-result explanation. Keep long metric definitions in references/config and the core skill concise.

- [ ] **Step 4: Run all skill tests and CLI help smokes**

Run:

```bash
python3 -m unittest discover -s tests -v
python3 scripts/build_query_plan.py --help
python3 scripts/assemble_query_bundle.py --help
python3 scripts/run_business_report.py --help
python3 scripts/run_weekly_report.py --help
python3 scripts/run_monthly_report.py --help
```

Expected: all PASS/exit 0.

- [ ] **Step 5: Commit**

```bash
git add SKILL.md README.md README.zh.md agents/openai.yaml tests/test_skill_contract.py
git commit -m "docs: publish the SMEDC reporting workflow"
```
