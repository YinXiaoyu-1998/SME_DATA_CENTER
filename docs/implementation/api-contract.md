# 企业资料中枢 API / MCP Contract

Last updated: 2026-10-11

## Authorization model

Every non-health business endpoint authenticates and authorizes on the backend. Identity/OAuth
bootstrap routes keep their separate public authentication contract. The authoritative design is
[business-related-authorization-design.md](business-related-authorization-design.md).

Accounts retain active/disabled state, `admin`/`employee` role and one 0–3 clearance. Ordinary
content reads additionally require current same-organization business grants covering the category
and every actual enterprise/ownership/store/dimension scope item. Different grants cannot combine
partial category and dimension conditions. Store names match exactly within an enterprise; member
opening/stored-value store fields do not restrict the group-level `vip` category. Admin role and
uploader identity do not grant ordinary content access.

Fixed categories use the current enterprise category level for both old and new resources.
Evidence uses one explicit category, explicit complete scope items and an explicit per-file level.
All applicable resources of a retained original must be readable; unparsed sheets add no invented
requirements. Raw delivery-ledger rows, aggregates, coverage and original links remain unavailable.
PDF access uses the independently configured finished-PDF category and exact single store.

`legacy`/`preparing` remain preparation modes until an admin explicitly activates a fully ready
organization transactionally. Enabled reads never fall back to the old model. `suspended` denies
affected reads without restoring legacy access. See [cutover operations](business-authorization-cutover.md).

## Confidentiality and business attributes

`upload_evidence_document` requires `confidentialityLevel` (integer 0–3), `categoryId`
and nonempty `scopes`. Each scope is `{ enterpriseKey, ownership, storeName?, dimensions }`;
`dimensions` maps dimension IDs to one exact value ID. Store ownership requires one exact
`storeName`; group ownership forbids it. Several complete items preserve actual combinations.
Do not infer a category, level, store or missing dimension from file content or names.

Structured and photo uploads retain optional legacy `confidentialityLevel` for compatibility;
when business authorization is enabled, it cannot override a fixed category's configured level.
Photos always require one explicit `enterpriseName` (at most 128 characters) and exact `storeName`
(at most 255). All three upload tools accept optional `historicalSupplementReason` (nonblank,
at most 2048 characters), recorded with the actual administrator and original input fingerprint.
Versioned admin operations may explicitly edit account clearance and evidence attributes.

## Privileged administrative operations

A PAO is named in the product/API as `admin`-only. It may affect documents at any confidentiality
level without granting the caller ordinary read access. Permission management is also admin-only and returns configuration or safe operational metadata,
without granting content reads. `archive_quarantine_certificates` remains a named PAO:

- an admin can archive quarantine certificates by `receiptId`, or by `sourceDocumentId`, without a
  confidentiality comparison;
- published certificates require a current admin to archive; historical employee uploaders have
  no published-resource archive capability (owner abort remains limited to unfinished uploads);
- a PAO response returns operational results only and does not make a document readable through
  search, query, status, or download.

File uploads separately require admin as specified below. `GET /audit` is removed; internal audit
logging remains an implementation concern.

## File Upload Capability

Only active `admin` accounts may upload; an `employee` is denied at every clearance, including 3.
Authentication precedes the role check, which precedes parsing, schema validation, local file access
in the launcher, hashing, storage, and upload side effects. Direct HTTP upload endpoints return
transport status `403`. MCP JSON-RPC transport remains HTTP `200`, with a tool result carrying
`isError: true`. Both use the canonical error code `UPLOAD_ADMIN_REQUIRED`, message
`File upload requires the admin role.`, and `retryable: false`. Re-login, retries, or higher
clearance cannot grant upload permission.

| Upload entry point                                      | MCP tool / transport                                                       | Denied audit `uploadSurface` |
| ------------------------------------------------------- | -------------------------------------------------------------------------- | ---------------------------- |
| `POST /v1/documents/evidence`                           | `upload_evidence_document`                                                 | `evidence_document`          |
| `POST /v1/structured/imports`                           | `upload_structured_dataset`, including Delivery Ledger (`delivery_ledger`) | `structured_dataset`         |
| `POST /v1/documents/quarantine-certificates`            | `upload_quarantine_certificate`                                            | `quarantine_certificate`     |
| `POST /v1/structured/partition-uploads`                 | `business`/`dishes` create                                                 | `structured_dataset`         |
| `GET /v1/structured/partition-uploads/:jobId/parts`     | partition part URLs                                                        | `structured_dataset`         |
| `POST /v1/structured/partition-uploads/:jobId/complete` | partition complete                                                         | `structured_dataset`         |

Partition owner abort (`DELETE /v1/structured/partition-uploads/:jobId`) remains allowed for an
employee owner. Status, manifest, read, search, query, and download are not made admin-only; their
current server business authorization and safe owner-progress rules apply. Admin upload above the admin's
clearance does not make later ordinary reads succeed.

Upload tools remain statically visible and marked admin-only. Launcher 0.6.0 rejects a known
employee profile before reading/transforming a local file; unknown profiles are lazily resolved.
The cached profile is exactly `displayName`, `email`, `role`, `clearance`, `organizationName`;
`smedc_get_current_user` continues to read live server state. A local denial creates no backend
audit. Backend denials best-effort record `file_upload.denied`, with actor, organization, safe
request provenance, reason, and transport-level `uploadSurface` only; no upload metadata/content
is parsed for auditing, and audit failure cannot change the denial.

The published approved Skill pin and server recommendation remain 0.8.2; minimum compatibility
remains 0.6.0. Candidate 0.9.0 bundles this authorization contract but is not published or deployed. Older
launchers are rejected with `LAUNCHER_UPGRADE_REQUIRED` before OAuth issuance. This change adds no historical
migration, OSS URL invalidation, or mid-transfer downgrade handling. Existing attribution and
read access remain intact. Future scheduled/connector/service identities need a separate design,
not impersonation of an admin Employee Account; workers and operator utilities are outside this
employee-callable upload boundary.

## Public HTTP surface

| Method         | Path                                                | Purpose                                                                           |
| -------------- | --------------------------------------------------- | --------------------------------------------------------------------------------- |
| `GET`          | `/healthz`                                          | Liveness                                                                          |
| `GET`          | `/.well-known/oauth-authorization-server`           | OAuth discovery and launcher compatibility metadata                               |
| `GET` / `POST` | `/oauth/*`                                          | Browser authorization, token, and revoke flows                                    |
| `GET` / `POST` | `/auth/password/setup/*`                            | Password setup/reset bootstrap and form                                           |
| `POST`         | `/mcp`                                              | Authenticated Streamable HTTP MCP                                                 |
| `GET`          | `/me`                                               | Current user: display name, email, role, clearance                                |
| `GET`          | `/skills`                                           | Approved skill-directory metadata                                                 |
| `POST`         | `/v1/documents/evidence`                            | Upload MD/TXT/DOCX evidence                                                       |
| `GET`          | `/v1/documents/evidence/:documentId/status`         | Uploader-visible evidence processing status                                       |
| `POST`         | `/v1/evidence/search`                               | Search readable evidence chunks                                                   |
| `POST`         | `/v1/documents/quarantine-certificates`             | Upload one JPG/JPEG/PNG certificate                                               |
| `POST`         | `/v1/quarantine-certificates/query`                 | Query readable certificates by receipt IDs                                        |
| `POST`         | `/v1/quarantine-certificates/archive`               | Owner archive by source ID or admin-only PAO archive                              |
| `POST`         | `/v1/source-documents/:documentId/download-url`     | Issue a readable source-file download URL                                         |
| `POST`         | `/v1/structured/imports`                            | Upload row-query datasets (`vip`, catalogs, ledgers); rejects `business`/`dishes` |
| `GET`          | `/v1/structured/imports/:importBatchId`             | Safe uploader progress or authorized complete import metadata                     |
| `POST`         | `/v1/structured/partition-uploads`                  | Create a multipart `business`/`dishes` upload session                             |
| `GET`          | `/v1/structured/partition-uploads/:jobId/parts`     | Get a bounded page of multipart part URLs                                         |
| `POST`         | `/v1/structured/partition-uploads/:jobId/complete`  | Verify and queue a completed source upload                                        |
| `DELETE`       | `/v1/structured/partition-uploads/:jobId`           | Abort an unfinished source upload                                                 |
| `GET`          | `/v1/structured/partition-imports/:jobId`           | Read partition import status                                                      |
| `POST`         | `/v1/structured/partition-manifests`                | Resolve an authorized date/store manifest                                         |
| `POST`         | `/v1/structured/partition-downloads`                | Prepare an authorized bounded partition ZIP                                       |
| `GET`          | `/v1/structured/partition-downloads/:requestId`     | Read authorized packaging status                                                  |
| `POST`         | `/v1/structured/partition-downloads/:requestId/url` | Sign a succeeded nonempty ZIP; empty success has no URL                           |
| `GET`          | `/v1/structured/datasets`                           | Dataset schema discovery                                                          |
| `POST`         | `/v1/structured/query`                              | Controlled, readable structured query                                             |
| `GET`          | `/v1/structured/datasets/:dataset/coverage`         | Readable source coverage                                                          |

`GET /labels` and `GET /audit` are not registered. `GET /readyz` accepts loopback only.

Structured import status loads the current valid same-organization account snapshot. An uploader
without ordinary metadata access receives only document/import/processing IDs and statuses plus
`importBatch.hasValidationErrors`; this safe progress is independent of content grants/clearance
and remains available while reads are suspended. It includes no storage key, original filename,
sheet/validation details, date/receipt metadata, row counts or links. Disabled accounts are denied.
In `enabled` mode ordinary full metadata requires every retained source requirement, including
current lifecycle, complete scopes and category clearance; raw delivery-receipt metadata remains
unavailable. `legacy`/`preparing` explicitly retain the existing upload-clearance metadata rule;
`suspended` never uses that rule. There is no implicit admin content bypass or new management API.
`get_import_status` delegates to this same server boundary with unchanged input parameters.

## Upload fields and limits

All uploads retain existing file/type/size validation. The common request fields are:

| Route                            | Required business fields                                                   | Confidentiality field                                                       |
| -------------------------------- | -------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| Evidence                         | `file`, `title`, `categoryId`, complete `scopes`; optional `sourceSystem`  | required explicit `confidentialityLevel` 0–3                                |
| Quarantine certificate           | `file`, `receiptId`, `idempotencyKey`, `enterpriseName`, exact `storeName` | optional legacy level; current fixed category is authoritative when enabled |
| Row-query structured import      | `file`, `dataset`, `enterpriseName`, `idempotencyKey` and dataset metadata | optional legacy level; current fixed category is authoritative when enabled |
| Business/dishes partition source | multipart session metadata, then ordered upload-part ETags                 | optional legacy level; current fixed category is authoritative when enabled |

The decoded inline file limit is 50 MiB. The official launcher streams local `business`/`dishes`
paths through multipart storage, with a 2 GiB default source limit. Filenames, titles, idempotency keys, receipt IDs, structured
metadata, evidence filters, cursors, and structured-query limits retain their existing public
limits. Label keys and label arrays are not accepted.

## MCP surface

MCP contracts mirror the HTTP boundary. `smedc_get_current_user` returns exactly `displayName`,
`email`, `role`, `clearance`, and `organizationName`. The former `smedc_list_labels` tool is absent. Evidence requires explicit level and business attributes; fixed-category uploads cannot override
current category levels. Callers must not fabricate attributes from content. The
`archive_quarantine_certificates` MCP tool is the declared admin-only PAO.

`business`/`dishes` upload, partition-import status, and local partition download require official
launcher `0.4.0` or newer. Older or missing launcher versions receive
`LAUNCHER_UPGRADE_REQUIRED`; in particular, the service never returns partition presigned URLs
through an older launcher's generic MCP proxy.

MCP and launcher clients must never expose credentials, tokens, or raw service
infrastructure. Cursor continuation is bound to the current organization, employee, clearance,
authorization mode/version, query shape, filters, limit, and retrieval configuration.

### Current permission and management tools (candidate 0.9.0)

All calls use the existing authenticated HTTP delegation. Every write requires the current
`expectedVersion`; conflicts return `AUTHORIZATION_VERSION_CONFLICT` without partial changes.
The service derives the actor's organization; a grant's required `orgId` must match it. There is
no arbitrary HTTP/SQL proxy. `get_my_permissions` reads live state on every call. Admins can
inspect complete configuration for themselves and any same-organization account even without
content grants. Management/status outputs have no signed content links.

| MCP tool                                                              | HTTP operation                                                                    |
| --------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| `get_my_permissions`                                                  | `GET /v1/permissions/me`                                                          |
| `list_account_permissions` / `get_account_permissions`                | `GET /v1/admin/permissions/accounts[/:employeeId]`                                |
| `update_account_permissions`                                          | `PATCH /v1/admin/permissions/accounts/:employeeId`                                |
| `list_business_categories` / `create_evidence_category`               | `GET` / `POST /v1/admin/permissions/categories`                                   |
| `update_business_category`                                            | `PATCH /v1/admin/permissions/categories/:categoryId`                              |
| `list_business_dimensions` / `create_business_dimension`              | `GET` / `POST /v1/admin/permissions/dimensions`                                   |
| `update_business_dimension`                                           | `PATCH /v1/admin/permissions/dimensions/:dimensionId`                             |
| `create_business_dimension_value` / `update_business_dimension_value` | `POST /v1/admin/permissions/dimensions/:dimensionId/values`, `PATCH .../:valueId` |
| `list_business_stores` / `update_business_store`                      | `GET` / `POST /v1/admin/permissions/stores`                                       |
| `update_evidence_document_attributes`                                 | `PATCH /v1/admin/permissions/documents/:documentId`                               |
| `get_evidence_document_management_status`                             | `GET /v1/admin/documents/evidence/:documentId/status`                             |
| `prepare_authorization_cutover`                                       | `GET /v1/admin/permissions/cutover`                                               |
| `activate_authorization_cutover` / `suspend_authorization_reads`      | `POST /v1/admin/permissions/cutover/activate` / `suspend`                         |

Fixed category edits accept `confidentialityLevel`; evidence category edits accept `ownerships`
and `requiredDimensionIds`, never both models. Grants use explicit `all` or nonempty `fixed`
selections; required business dimensions are checked by the server. Activation and suspension
also require `confirm: true`. Preparation is read-only and lists missing configuration/attributes;
no missing grant, level or historical attribute is inferred. Versioned preparation is recomputed
inside activation. Real-tenant configuration and activation require separate human authorization.

### Filtered partition extracts and asynchronous bundles

Filtered ranges require published, independently verified Launcher `0.8.0` or newer and
matching filtered-range service deployment. Optional bundles require verified published
Launcher `0.8.1` or newer and known matching ZIP service deployment. Range is the default;
tools/list alone cannot establish server availability. After ZIP rollback regenerate saved
plans in range mode; do not bypass authentication, integrity or source-scope failures. The approved installation pin remains `0.8.2`; candidate `0.9.0` needs separate publication and
verification before recommendation/pin changes. This contract is not evidence of live availability.

For `business`/`dishes`, manifests and bundle preparation accept `dataset`, `enterpriseName`,
inclusive ISO `startDate`/`endDate`, optional `storeIds` and `storeNameContains`. Coverage accepts
`dataset` plus optional `enterpriseName` and `storeNameContains`. The latter is 1–20 NFC/trim
literals of 1–255 characters: case-sensitive substring OR, AND with IDs, scope and backend
authorization. Invalid empty arrays/blank items fail. Filters on other datasets are rejected.
Coverage counts/store/date bounds and manifest totals describe only readable matching partitions.

Prepare additionally requires `idempotencyKey` (1–128 characters, no surrounding whitespace);
optional prepare `storeIds` contains 1–2000 IDs. Exact replay returns the same request;
changed scope with the same key returns `IDEMPOTENCY_CONFLICT` (409). Status reports `requestId`,
`status` (`queued`, `running`, `succeeded`, `failed`, `expired`), `partitionCount`,
`completedPartitionCount`, `totalRowCount`, `totalByteSize`, `retryAfterSeconds`, `errorCode`,
`expiresAt`. Row/byte totals are decimal strings. Wait `retryAfterSeconds` before polling pending
states. Defaults: 500 partitions, 256 MiB raw bytes, 24-hour retention, 16 active requests per
organization and 4 per requester; URL TTL is at most 15 minutes. Every endpoint rechecks requester,
organization and current complete business scope; source revisions invalidate stale ZIPs. Permission
changes during packaging alone do not fail construction. Owners may see safe progress; signing
rechecks current access without changing a succeeded task into failure. Unknown old manifests
return a rebuild-required result; status contains no content URL.

MCP selectors use compact `YYYYMMDD`. `prepare_structured_partition_download` mirrors prepare;
`get_structured_partition_download_status` takes only `requestId`. After success,
`download_structured_partitions` takes only `requestId`, mutually exclusive with every selector,
and does not wait for packaging. Its alternate range form takes dataset/enterprise/dates and
optional store filters (legacy range `storeIds` maximum 10,000). The launcher verifies ZIP/manifest
and CSV checksums/counts, consumes signed links internally and returns local files. Zero-partition
success has no ZIP URL and creates a valid empty local extract. Check MCP `isError` and terminal
status; failures never become empty results. Not-ready (409) resumes polling; active-limit (429)
waits; size-limit (413) narrows the scope; stale (409)/expired (410) requires fresh preparation.
Cleanup of service data remains operator-only, outside employee MCP, including admin accounts.

### Evidence search response

`POST /v1/evidence/search` and `search_document_evidence` return authorized chunks in `results[]`
and one `sources[]` entry per distinct document represented on that page, in first-result order.
Each source entry includes `sourceDocumentId`, title/file metadata, `downloadStatus`, `downloadUrl`,
and `expiresAt`. Available attachment links expire after 24 hours. An issuance, storage, or audit
failure is represented as `downloadStatus: "unavailable"`, null link fields, and the warning
`SOURCE_DOWNLOAD_URL_UNAVAILABLE`; one failed source does not suppress other links or results.

The `retrieval` object includes retrieval, embedding, lexical, and rerank versions/status plus
`relevance.{policyVersion,cutoffReason,droppedCount}`. Pagination remains under `page`, and the
service never generates the final answer. Evidence search exposes its source links without an
extra download-tool call. The explicit source-download endpoint/tool remains available to refresh
an expired URL and for structured rows or quarantine certificates whose source was not returned by
evidence search.

## Migration and retrieval payloads

Historical ADR 0025 migration (partly superseded by the business authorization design) mapped legacy `manager` accounts to `admin`, assigns existing accounts
clearance `3`, assigns existing documents level `0`, and deletes legacy label tables/data. Existing
Qdrant vectors without a confidentiality payload are treated as level-0 candidates only; the
database revalidator checks the authoritative document level before reranking or response output.

## Archived Delivery Ledger PDFs

`LEDGER_PDF_DELIVERY_ENABLED` defaults to false. All four endpoints authenticate the
current employee and enforce tenant, employee state and current finished-PDF category/store
authorization on the backend. Upstream source permissions do not grant or block finished-PDF access. Disabled endpoints return `LEDGER_PDF_NOT_ENABLED`;
request IDs and cursors cannot grant access across organizations.

| Method | Route                                              | Behavior                                                                   |
| ------ | -------------------------------------------------- | -------------------------------------------------------------------------- |
| POST   | `/v1/ledger-pdfs/coverage`                         | Read authorized store/day PDF states, at most 200 per page                 |
| POST   | `/v1/ledger-pdfs/downloads`                        | Queue an authorized ZIP; requires idempotencyKey                           |
| GET    | `/v1/ledger-pdfs/requests/:requestId`              | Read authorized status with optional cursor                                |
| POST   | `/v1/ledger-pdfs/requests/:requestId/download-url` | Recheck permission and current PDF pointers before issuing a 15-minute URL |

Coverage/download bodies use `storeNames` and either `dates` or inclusive
`startDate`/`endDate`, with real `YYYY-MM-DD` calendar dates. Public limits are 50
exact store names, 366 dates and 5000 actual partitions. The coverage body may
include `cursor`; action bodies include `idempotencyKey`. Caller-supplied orgId
and unknown fields are rejected. ZIP limits are 5000 PDFs/1 GiB/10 minutes with
24-hour retention. Status and URL issuance do not accept arbitrary scope changes.

Raw Delivery Ledger detail, aggregate, coverage and original-file URL issuance are closed
regardless of the old feature flag or client version. Finished archived PDFs are the public
read path. Other datasets keep their registered read behavior. Read operations never render on demand.

Employee-facing MCP and HTTP have no PDF generation endpoint, including for admins.
Applied imports and photo changes only update partition revisions. Daily 03:00
Asia/Shanghai reconciliation generates changed/missing partitions and skips healthy
PDFs. Before that run completes, current coverage may be pending/stale/missing and
ZIP preparation returns `LEDGER_PDF_NOT_READY`; report the scheduled wait. Internal
operator CLI refresh/backfill remains available outside the employee API.
See [ledger-pdf-operations.md](./ledger-pdf-operations.md) for backfill and recovery.
