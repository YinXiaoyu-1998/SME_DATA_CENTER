# SMEDC Hard Cut And Companion Skills Design

Date: 2026-09-16
Status: approved by the product owner on 2026-09-16

## Problem

The product currently uses `SMEDC`, `Enterprise Hub`, and `enterprise_hub` for the same service.
The companion business-analysis Skill also embeds the seed customer name Maijia/麦家 in its Skill
name, configuration, report copy, scripts, tests, and fixtures. This creates avoidable ambiguity for
employees, QA, maintainers, and agents.

Delivery-ledger query results expose canonical English field names. Agents therefore improvise
Chinese translations, so their tables do not reliably match the statutory paper ledger headed
“食品经营单位进货台帐”. The current business-analysis Skill is also packaged separately even though
it and the proposed ledger workflow are optional SMEDC companions with the same installation and
release concerns.

There are no production users or production customer data. Only QA is using the system. The change
will therefore be a one-way hard cut with no compatibility period, alias, redirect instruction,
dual-name documentation, or data migration for old client state.

## Goals

1. Make `SMEDC` the only product name in maintained source, runtime metadata, documentation, Skills,
   package names, configuration, and deployment identifiers.
2. Use the canonical English expansion **Small and Medium Enterprises Data Center**.
3. Remove Maijia/麦家 tenant assumptions and make business reports use the authenticated user's
   organization name as the report company name.
4. Turn the existing business-analysis repository into one multi-Skill companion repository.
5. Add a minimal ledger Skill that renders the exact approved Chinese ledger columns, exports those
   rows to deterministic CSV, and guides quarantine-certificate photo operations by receipt ID.
6. Reinstall and verify the QA client under only the new names.

## Non-goals

- No compatibility shim for old npm package names, MCP entry names, tool names, environment
  variables, filesystem paths, Skills, or repositories.
- No migration of old launcher credentials or local QA configuration. QA signs in again.
- No new report types, dashboards, charts, OCR, quarantine-photo classification, PDF output, XLSX
  output, or general spreadsheet editor.
- No change to authorization, confidentiality, receipt normalization, structured-query semantics,
  or the service boundary between SMEDC and employee-owned agents.
- No retention of Maijia-specific store buckets or presentation rules under a generic filename.

## Canonical naming

The hard cut uses the following names:

| Concern                                  | Canonical value                                                                                   |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------- |
| Product                                  | `SMEDC`                                                                                           |
| Product expansion                        | `Small and Medium Enterprises Data Center`                                                        |
| Main GitHub repository                   | `YinXiaoyu-1998/SME_DATA_CENTER`                                                                  |
| Root package                             | `smedc`                                                                                           |
| Workspace package scope                  | `@smedc/*`                                                                                        |
| Core Skill                               | `smedc-mcp`                                                                                       |
| Core Skill repository                    | `YinXiaoyu-1998/smedc-mcp-skill`                                                                  |
| Launcher package and binary              | `smedc-mcp-launcher`                                                                              |
| MCP host entry                           | `smedc`                                                                                           |
| Branded MCP tools                        | `smedc_login`, `smedc_logout`, `smedc_auth_status`, `smedc_get_current_user`, `smedc_list_skills` |
| Public launcher base URL variable        | `SMEDC_BASE_URL`                                                                                  |
| Local application-support directory      | `SMEDC`                                                                                           |
| Docker, deployment, and storage prefixes | `smedc-*` / `smedc`                                                                               |
| Companion repository                     | `YinXiaoyu-1998/smedc-companion-skills`                                                           |
| Business-analysis Skill                  | `smedc-business-analysis`                                                                         |
| Ledger Skill                             | `smedc-delivery-ledger`                                                                           |

Unbranded business tools such as `query_structured_dataset`,
`upload_quarantine_certificate`, and `get_source_document_download_url` keep their names. Public
error codes, server metadata keys, TypeScript symbols, package imports, test identifiers, database
development defaults, Qdrant defaults, CI concurrency groups, Docker resources, and maintained
documentation that contain the old brand are renamed to SMEDC equivalents.

The current `https://api.smedatacenter.xyz` service URL already follows the canonical brand and does
not change. Previously published npm artifacts and Git history remain historical facts, but current
repositories, Skills, install instructions, and service metadata do not reference them.

## Hard-cut release boundary

The launcher rename changes the published package, executable, secure-store namespace, MCP entry,
branded tool contracts, and server discovery metadata. It is therefore a new launcher contract.
The new package will continue the existing version sequence as `smedc-mcp-launcher@0.5.0` rather
than restarting at `0.1.0`.

The release is ordered as follows:

1. Prepare and review the main-repository implementation branch while staging continues to run the
   old release.
2. Freeze staging, retain the main GitHub repository name `SME_DATA_CENTER`, and rename the two
   Skill repositories to their SMEDC names.
3. Merge the reviewed release commit and complete native launcher acceptance. Because npm requires
   a package to exist before Trusted Publisher or staged publishing can be configured, perform the
   one-time first publish of `smedc-mcp-launcher@0.5.0` from that exact reviewed `main` artifact
   with interactive 2FA and explicit human confirmation.
4. Immediately configure npm Trusted Publisher for `YinXiaoyu-1998/SME_DATA_CENTER` and verify the
   public package contents, executable, self-check, production dependency audit, and clean
   installation.
5. Immediately update SMEDC server recommendation metadata and both copies of the core Skill to the
   verified package, merge the coordinated hard-cut changes, and deploy the staging release.
6. Delete old QA MCP entries, installed Skills, launcher credentials, and local application-support
   data; install only the new names and authenticate again.

No service response recommends the new launcher until the package exists publicly. After the
cutover, the service does not advertise or accept the old branded tool contract as an intentional
compatibility surface.

## Authenticated organization name

The organization record is the authority for company naming in business reports.

`GET /me` will include the authenticated employee's organization without exposing it as a caller
input. The SMEDC MCP projection will return:

```json
{
  "user": {
    "displayName": "张三",
    "email": "zhangsan@example.com",
    "role": "employee",
    "clearance": 0,
    "organizationName": "示例餐饮管理有限公司"
  }
}
```

`smedc-business-analysis` calls `smedc_get_current_user` before generating a report and uses
`user.organizationName` verbatim as the company name in report titles and narrative. It does not
infer the company from uploaded filenames, enterprise partitions, store names, email domains, or
the employee's display name. A missing or blank organization name is a contract error: the Skill
stops and reports that the SMEDC account organization must be corrected instead of substituting a
seed customer or generic company.

Enterprise names used to select structured business partitions remain data selectors and are not
silently replaced with the organization name. The organization name controls report presentation;
the user or available coverage still controls which enterprise dataset is analyzed.

## Core SMEDC Skill

The repo-local and standalone core Skills remain byte-equivalent after the rename. The core Skill
continues to own installation, browser login, MCP parameters, status handling, authorization-safe
errors, upload transport, and general structured-query semantics.

It does not duplicate ledger-specific Chinese column ordering, CSV conversion, business-report
logic, or tenant-specific transformations. It advertises the two optional companion Skills and
requires explicit user authorization before installing either one. Each companion detects a
missing `smedc-mcp` prerequisite and offers the official installation path rather than silently
installing it.

The repo-local operational Skills are renamed consistently, including `smedc-manual-test` and
`smedc-business-data-cleanup`. Maintained instructions and commands refer only to their new names.

## Companion repository

The existing business-analysis repository is renamed and reorganized as:

```text
smedc-companion-skills/
├── README.md
├── README.zh.md
├── LICENSE
├── .github/workflows/test.yml
├── scripts/validate_all_skills.py
└── skills/
    ├── smedc-business-analysis/
    │   ├── SKILL.md
    │   ├── agents/openai.yaml
    │   ├── config/business-analysis.json
    │   ├── scripts/
    │   ├── tests/
    │   └── requirements-dev.txt
    └── smedc-delivery-ledger/
        ├── SKILL.md
        ├── agents/openai.yaml
        ├── config/food-purchase-ledger-cn-v1.json
        ├── scripts/export_ledger_csv.py
        └── tests/
```

Each Skill is independently installable by copying only its own directory to the canonical user
Skill directory. Neither Skill imports files from its sibling or repository root at runtime. The
repository root owns only packaging, installation documentation, and validation across Skills.

Skill metadata records the repository and subdirectory source. Installation documentation provides
commands for one Skill or both Skills, always targeting `~/.agents/skills` for this environment.

## Generic business-analysis Skill

The existing report-generation behavior is retained, but all seed-customer coupling is removed:

- Rename the Skill and UI metadata to `smedc-business-analysis`.
- Rename `config/maijia.json` to `config/business-analysis.json`.
- Remove default company names, Maijia/麦家 title text, Maijia-specific store buckets, and
  Maijia-specific text normalization.
- Obtain the report company name only from `smedc_get_current_user.user.organizationName`.
- Use neutral synthetic organizations, enterprises, stores, and fixtures in tests.
- Keep report-period, dataset-coverage, partition-download, aggregation, chart, rendering, cleanup,
  and partial/empty-report behavior that is not tenant-specific.

If a report module currently depends on a hard-coded Maijia large-store/small-store grouping, that
grouping is removed from the default report rather than renamed. It may return later only as an
explicit organization-owned configuration feature with its own design.

## Ledger presentation contract

The service owns a versioned presentation profile for `delivery_ledger`:

```json
{
  "id": "food-purchase-ledger-cn-v1",
  "title": "食品经营单位进货台帐",
  "columns": [
    { "canonicalName": "item_name", "displayName": "食品名称" },
    { "canonicalName": "specification", "displayName": "规格" },
    { "canonicalName": "purchase_quantity", "displayName": "进货数量" },
    { "canonicalName": "purchase_amount", "displayName": "进货金额" },
    { "canonicalName": "production_date_or_batch", "displayName": "生产日期或生产批号" },
    { "canonicalName": "shelf_life", "displayName": "保质期" },
    { "canonicalName": "supplier_name", "displayName": "供货单位名称" },
    { "canonicalName": "supplier_unit_address", "displayName": "供货单位地址" },
    { "canonicalName": "supplier_contact_phone", "displayName": "供货单位联系方式" },
    { "canonicalName": "purchase_date", "displayName": "进货日期" }
  ]
}
```

“序号” is intentionally absent. The exact character `帐` in the title is intentional. Agents must
render the supplied display names verbatim and must not translate, shorten, modernize, or reorder
them.

`list_structured_datasets` exposes the profile as discovery metadata. A successful detail-mode
`delivery_ledger` query also returns the same profile alongside canonical-keyed rows, so clients do
not have to join against remembered documentation. Aggregate/grouped queries are not represented
as the statutory ledger and do not receive this fixed detail-table profile.

The service registry remains the authority. The ledger Skill includes a matching local profile so
its deterministic exporter can validate downloaded MCP results. A mismatch in profile ID, title,
column names, or order fails closed and tells the user that the Skill or launcher must be updated.

## Ledger Skill workflow

`smedc-delivery-ledger` activates for employee requests concerning food purchase ledgers, delivery
ledgers, receipt-linked quarantine certificates, or exporting the standard ledger CSV.

For a ledger query it:

1. Confirms `delivery_ledger` and `food-purchase-ledger-cn-v1` through dataset discovery.
2. Converts user wording to canonical query fields without exposing organization IDs.
3. Selects the ten profile fields in profile order and paginates until the requested scope is
   complete or the user-specified limit is reached.
4. Presents the title and Chinese column labels exactly as returned by the profile.
5. Does not display `entry_id`, `receipt_id`, `store_name`, or `source_document_id` in the standard
   table unless the user separately asks for operational provenance.

The Skill remains narrow: it performs no business analysis and produces no dashboard or narrative
report.

## Deterministic CSV export

`scripts/export_ledger_csv.py` accepts a UTF-8 JSON file containing either one exact
`query_structured_dataset` result object or an array of paginated result objects, plus an output
path. Every input page must be a detail-mode `delivery_ledger` response with the exact
`food-purchase-ledger-cn-v1` presentation profile. The script concatenates pages in input order and
writes only the ten standard columns.

CSV behavior is fixed:

- UTF-8 with BOM;
- exact Chinese headers and order from the profile;
- empty cell for JSON `null` or absent nullable value;
- decimal and telephone strings preserved without numeric coercion;
- dates serialized as `YYYY-MM-DD`;
- RFC-compatible quoting;
- cells beginning with `=`, `+`, `-`, or `@` escaped to prevent spreadsheet formula execution;
- atomic output replacement, leaving no partial output on failure.

The script rejects the wrong dataset, grouped/aggregate mode, missing required fields, unexpected
profile metadata, malformed dates, non-scalar cells, duplicate page payloads when detectable, and
an existing output path unless the caller explicitly passes `--overwrite`.

## Quarantine-certificate photo workflow

The ledger Skill treats the user's phrases “对账单编号”, “单据号”, and “收货单号” as the public
`receiptId` business key. It does not rename the API field or require a matching ledger receipt to
exist.

- Upload: call `upload_quarantine_certificate` once per JPG/JPEG/PNG image with one `receiptId`, one
  stable idempotency key, and only a user-specified confidentiality level. Multiple photos require
  multiple calls.
- Query: call `query_quarantine_certificates` with 1–100 explicit receipt IDs. Empty visible results
  do not reveal whether higher-confidentiality photos exist.
- Download: call `get_source_document_download_url` with a returned visible `sourceDocumentId` and
  return the time-limited link instead of proxying bytes.
- Archive one photo: call `archive_quarantine_certificates` with `sourceDocumentId`.
- Archive all photos for a receipt: use `receiptId` only when the authenticated user is an admin and
  has explicitly asked for the bulk archive.

Quarantine-photo metadata and URLs are never added to the statutory ten-column CSV. The Skill does
not inspect, OCR, classify, modify, or assert the authenticity of an uploaded image.

## Validation and testing

### Main repository

- Contract tests for the full branded-tool rename and the absence of old branded tools.
- `/me` and MCP tests proving `organizationName` comes from the authenticated organization and
  malformed/missing organization data fails closed.
- Registry, discovery, and query tests for the exact profile ID, title, canonical fields, labels,
  order, detail-mode inclusion, and aggregate-mode exclusion.
- Launcher packaging/alignment tests for package name, executable, secure-store identity, MCP entry,
  tool list, environment variables, and version `0.5.0`.
- Naming scans across maintained code, documentation, Skills, tests, fixtures, CI, and deployment
  files. The scan excludes Git metadata and its own pattern definition only.
- Existing authorization, structured-query, upload, quarantine-certificate, integration, MCP,
  package, deployment, and official manual-acceptance gates.

### Core Skill repository

- Skill validation and bilingual install-document checks.
- Byte equality with the repo-local `smedc-mcp` Skill.
- Contract checks for the 0.5.0 package, `smedc` MCP entry, branded tools, and companion links.
- Old-name and seed-customer scans.

### Companion repository

- Skill validation for each independently copied Skill directory.
- Existing business-analysis behavior tests updated to neutral organizations.
- Tests proving report headings use the MCP-returned organization name and reject a blank name.
- Ledger exporter tests for exact headers/order, pagination, nulls, decimal/telephone preservation,
  dates, quoting, formula protection, mismatch rejection, and atomic overwrite behavior.
- Static checks that neither Skill imports its sibling at runtime.
- Old-name and seed-customer scans.

### QA acceptance

Use only fresh hard-cut configuration:

1. Install `smedc-mcp-launcher@0.5.0` and configure the `smedc` MCP entry.
2. Install `smedc-mcp`, `smedc-business-analysis`, and `smedc-delivery-ledger` under their new
   directories.
3. Authenticate a fresh synthetic QA account whose organization has a distinctive name.
4. Verify the business report uses that organization name.
5. Query ledger rows and verify the exact ten-column Chinese presentation.
6. Export and inspect CSV encoding, headers, rows, and spreadsheet safety.
7. Upload, query, download, singly archive, and admin bulk-archive receipt-linked quarantine photos.
8. Remove all run-scoped DB, object-storage, Qdrant, account, credential, local Skill, and temporary
   file residue required by the official acceptance procedure.

## Documentation and historical records

Maintained current-state documentation, examples, screenshots, commands, and source comments are
rewritten to SMEDC. Current test fixtures use neutral synthetic companies. Detailed historical
progress prose is not treated as current product documentation, but any current instructions inside
historical planning files are corrected where they could still be followed operationally.

The final release handoff reports separate pull requests and approximate inserted/deleted line
counts for production code/config, runtime/CI/deploy, tests, documentation, and lockfiles. Execution
plans, scratch ledgers, temporary migration reports, and handoff logs are not included in product PRs
unless explicitly requested.
