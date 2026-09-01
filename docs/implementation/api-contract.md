# 企业资料中枢 API / MCP Contract

Last updated: 2026-08-29

This contract describes the current public surface after the legacy ordinary document upload/search flow was removed.

## Product Boundary

Enterprise Hub is a retrieval and data foundation for employee-owned agents and MCP/API clients.

It returns:

- evidence chunks and source metadata for unstructured documents;
- imported structured rows or explicitly requested mechanical read-only aggregates for supported tabular datasets;
- status, schema, label, skill-directory, audit, health, and readiness metadata.

It does not:

- generate final natural-language answers;
- infer the original employee question;
- add business analysis not requested in a structured query;
- expose raw SQL;
- expose generic document detail/download/search/archive endpoints.

## Authentication And Authorization

Every non-health data endpoint requires backend authorization. Client-side filtering is never trusted.

Official authentication:

- public launcher client `enterprise-hub-desktop-launcher` uses Authorization Code + S256 PKCE;
- browser passwords never enter agent input or launcher configuration;
- 10-minute opaque access tokens authenticate every business/MCP request;
- rotating durable credentials remain only in macOS Keychain or Windows Credential Manager;
- `/auth/dev-login`, JWT signing, and JWT verification do not exist in any environment.

Authorization rules:

- organization scope always comes from the authenticated employee record; callers must not provide org headers, query fields, or body fields;
- disabled employees are denied on every business data path;
- same-org admins can use supported management/status paths for same-org documents;
- active same-org non-admin employees can access a document when it has `all_staff` or when their current label set intersects the document labels;
- evidence and structured data are filtered by org and labels in the API using that same document visibility policy;
- evidence status is visible only to the uploader or an admin;
- structured import status and query results must not leak inaccessible source document names, row counts, sheet summaries, validation errors, dataset, window, or existence;
- not-found and inaccessible resources should use the same non-leaking error shape where practical.

## Active Public HTTP Surface

| Method | Path                                            | Purpose                                      |
| ------ | ----------------------------------------------- | -------------------------------------------- |
| `GET`  | `/healthz`                                      | Liveness                                     |
| `GET`  | `/.well-known/oauth-authorization-server`       | OAuth discovery and launcher version policy  |
| `GET`  | `/oauth/authorize`                              | Browser authorization transaction            |
| `POST` | `/oauth/authorize/login`                        | Browser password verification                |
| `POST` | `/oauth/token`                                  | Code exchange or durable credential rotation |
| `POST` | `/oauth/revoke`                                 | Revoke a durable session family              |
| `GET`  | `/auth/password/setup`                          | Fragment-safe setup bootstrap                |
| `POST` | `/auth/password/setup/session`                  | Exchange a one-time setup grant              |
| `GET`  | `/auth/password/setup/form`                     | Render the protected password form           |
| `POST` | `/auth/password/setup/complete`                 | Set/reset password and revoke old sessions   |
| `POST` | `/mcp`                                          | Authenticated stateless Streamable HTTP MCP  |
| `GET`  | `/me`                                           | Current employee/session metadata            |
| `GET`  | `/labels`                                       | Label catalog                                |
| `GET`  | `/skills`                                       | Approved Skill Directory metadata            |
| `GET`  | `/audit`                                        | Admin audit query                            |
| `POST` | `/v1/documents/evidence`                        | Upload MD/TXT/DOCX evidence document         |
| `GET`  | `/v1/documents/evidence/:documentId/status`     | Evidence document + index status             |
| `POST` | `/v1/evidence/search`                           | Search visible evidence chunks               |
| `POST` | `/v1/documents/quarantine-certificates`         | Upload one JPG/PNG quarantine certificate    |
| `POST` | `/v1/quarantine-certificates/query`             | Query certificates by receipt IDs            |
| `POST` | `/v1/quarantine-certificates/archive`           | Archive certificate(s)                       |
| `POST` | `/v1/source-documents/:documentId/download-url` | Issue a temporary source-file download URL   |
| `POST` | `/v1/structured/imports`                        | Import supported CSV/XLSX structured dataset |
| `GET`  | `/v1/structured/imports/:importBatchId`         | Structured import status                     |
| `GET`  | `/v1/structured/datasets`                       | Structured dataset schema discovery          |
| `POST` | `/v1/structured/query`                          | Controlled read-only structured query        |

## Private HTTP Surface

`GET /readyz` is implemented but accepts only loopback requests. Public requests return `404`.

## Public Request Boundaries

HTTP and MCP use the same semantic input limits:

| Input                                           |                             Limit |
| ----------------------------------------------- | --------------------------------: |
| Upload filename                                 |                    255 characters |
| Evidence title                                  |                    512 characters |
| Evidence `sourceSystem`                         |                    255 characters |
| Structured `enterpriseName` / `enterprise_name` |                    255 characters |
| Structured `idempotencyKey`                     |                    255 characters |
| Receipt ID / quarantine idempotency key         |                    255 characters |
| Label key / labels per request                  |        128 characters / 50 labels |
| Evidence query                                  |                  4,000 characters |
| Evidence filter ID / IDs per group              |           64 characters / 100 IDs |
| Opaque cursor                                   |                  4,096 characters |
| Structured-query string scalar                  |                 32,767 characters |
| Multipart upload                                | 1 file, 60 fields, 61 total parts |

Decoded upload content remains limited to 52,428,800 bytes (50 MiB). nginx accepts up to `72m`
per encoded request so a valid 50 MiB MCP Base64/JSON upload and a direct multipart upload can
reach the API; the API still enforces the decoded limit.

Malformed requests that do not have a more specific route error return `400` /
`INVALID_REQUEST`. Body, file, or multipart-count excess returns `413` /
`PAYLOAD_TOO_LARGE`. Unexpected server exceptions are logged with the request ID and return only:

```json
{
  "error": {
    "code": "INTERNAL_ERROR",
    "message": "Internal server error.",
    "requestId": "request-id"
  }
}
```

Internal exception messages and stacks are never part of that fallback response. Existing
route-specific authentication, authorization, OAuth, MCP transport, cursor, and structured-query
error contracts remain authoritative.

## Audit Provenance

Admin `GET /audit` records are additive. Each record includes the existing `requestId` and
`clientIp` fields plus nullable `clientSource` and `launcherVersion` fields:

```json
{
  "requestId": "req_...",
  "clientIp": "203.0.113.9",
  "clientSource": "mcp_launcher",
  "launcherVersion": "0.1.0"
}
```

`clientSource` is server-derived and is one of `http_api`, `browser_auth`, `oauth_launcher`, or
`mcp_launcher`. `launcherVersion` is client-declared observational metadata, bounded and
syntax-validated when received; it is not version attestation, and provenance storage adds no new
client requirement. The existing OAuth token endpoint minimum-launcher-version compatibility gate
still applies. The version is recorded only for observable OAuth-launcher and MCP-launcher
requests. Historical, operator, and system audit rows may have both new properties set to `null`.

| Origin / route boundary                             | Persisted record                 | Request ID and source IP                            | `clientSource`                | `launcherVersion`                        |
| --------------------------------------------------- | -------------------------------- | --------------------------------------------------- | ----------------------------- | ---------------------------------------- |
| Direct business HTTP                                | `AuditLog`                       | Normalized request ID and actual peer IP            | `http_api`                    | `null`                                   |
| nginx one-hop business HTTP                         | `AuditLog`                       | Normalized request ID and nginx-forwarded public IP | `http_api`                    | `null`                                   |
| MCP outer request with verified internal delegation | `AuditLog`                       | Outer normalized request ID and source IP           | `mcp_launcher`                | Normalized declared version when present |
| Browser authorization, password login, or setup     | authentication security event    | Normalized request ID and source IP                 | Not stored on security events | `null`                                   |
| OAuth token, refresh, or revoke                     | authentication security event    | Normalized request ID and source IP                 | Not stored on security events | Normalized declared version when present |
| Operator/pruning/system path or historical row      | applicable audit/security record | `null` when no HTTP request exists                  | `null` when applicable        | `null`                                   |

The in-process MCP delegation marker is verified with a per-server opaque proof; a public forged,
missing, or invalid marker cannot select `mcp_launcher` and falls back to ordinary `http_api`
provenance. Audit context excludes credentials, cookies, request bodies, authorization codes, PKCE
material, setup secrets, tokens, token hashes, and passwords.

## Removed Legacy Public Surface

These endpoints and MCP tools are intentionally not registered. Tests should assert they are absent; docs and skills must not recommend them.

Removed HTTP endpoints:

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

The internal documents catalog, source file storage, labels, processing runs, indexes, and audit logs remain part of backend infrastructure.

## Evidence Upload

### `POST /v1/documents/evidence`

Multipart form fields:

| Field          | Required | Notes                                    |
| -------------- | -------- | ---------------------------------------- |
| `file`         | yes      | MD/TXT/DOCX only                         |
| `title`        | yes      | Human-readable source title              |
| `sourceSystem` | no       | Caller-provided source system identifier |
| `labelKeys[]`  | yes      | One or more existing allowed label keys  |

Behavior:

- stores the original source file in configured storage;
- creates a source document record with `documentKind=evidence`;
- records labels and audit events;
- creates an `evidence_document_index` processing run;
- indexes through the worker into Qdrant;
- does not expose a generic download/detail/search contract.

Response shape:

```json
{
  "document": {
    "documentId": "doc_...",
    "documentKind": "evidence",
    "fileType": "md",
    "status": "pending_processing"
  },
  "processing": {
    "processingRunId": null,
    "status": "queued"
  },
  "documentIndex": {
    "status": "pending",
    "retrievalConfigVersion": "phase3.retrieval.v1"
  }
}
```

## Evidence Status

### `GET /v1/documents/evidence/:documentId/status`

Visible only to the uploader or an admin.

Response shape:

```json
{
  "document": {
    "documentId": "doc_...",
    "documentKind": "evidence",
    "fileType": "md",
    "title": "差评处理 SOP",
    "status": "active",
    "labels": ["store:baoli"],
    "originalFileName": "customer-feedback-sop.md",
    "sourceSystem": "manual"
  },
  "processing": {
    "processingRunId": null,
    "status": "succeeded"
  },
  "documentIndex": {
    "status": "ready",
    "retrievalConfigVersion": "phase3.retrieval.v1"
  }
}
```

## Evidence Search

### `POST /v1/evidence/search`

Request shape:

```json
{
  "query": "差评处理 SOP",
  "filters": {
    "labelIds": ["lbl_..."],
    "documentIds": ["doc_..."],
    "fileTypes": ["md", "txt", "docx"]
  },
  "limit": 10,
  "cursor": "optional_opaque_cursor_from_previous_page"
}
```

Response shape:

```json
{
  "results": [
    {
      "documentId": "doc_...",
      "chunkId": "chunk_...",
      "documentTitle": "差评处理 SOP",
      "text": "差评处理需要在 15 分钟内联系顾客...",
      "score": {
        "hybrid": 0.87,
        "rerank": null
      },
      "source": {
        "fileType": "md",
        "sectionHeadingPath": ["客户反馈", "差评处理"],
        "blockType": "paragraph",
        "pageNumber": null
      },
      "matchedBy": ["dense", "sparse"]
    }
  ],
  "retrieval": {
    "retrievalConfigVersion": "phase3.retrieval.v1",
    "embeddingVersion": "fake-embedding-v1@phase3.retrieval.v1",
    "lexicalIndexVersion": "lexical.v1",
    "rerankVersion": null,
    "rerankStatus": "rerank_disabled"
  },
  "warnings": [],
  "page": {
    "limit": 10,
    "nextCursor": "opaque_next_page_cursor_or_null",
    "hasMore": true
  }
}
```

The API searches only visible active evidence documents with ready indexes. It returns evidence, not final answers.

Evidence pagination uses a signed opaque offset cursor with a 900-second TTL. The cursor is scoped to the authenticated org, employee, role, current label digest, normalized query/filters, requested limit, retrieval config version, and next offset. Each page reruns retrieval and backend authorization before slicing results; the cursor is not a cached result set and cannot be reused after document visibility changes.

Cursor failures:

| Code             | HTTP | Meaning                                                                 |
| ---------------- | ---: | ----------------------------------------------------------------------- |
| `INVALID_CURSOR` |  400 | Malformed, tampered, or scope/query/filter/limit/config mismatch cursor |
| `CURSOR_EXPIRED` |  400 | Cursor signature is valid but the 900-second TTL has expired            |

When the fixed 200-candidate retrieval window is reached, responses include `EVIDENCE_CANDIDATE_WINDOW_TRUNCATED` in `warnings`; clients should treat that as a bounded-window warning, not proof that every possible match was traversed.

## Quarantine Certificates

Quarantine certificates are source documents linked to delivery ledgers by `receiptId`. They are
stored as original files and are not parsed, OCRed, embedded, indexed into Qdrant, or converted
into structured rows.

### `POST /v1/documents/quarantine-certificates`

Multipart form fields:

| Field            | Required | Notes                                                |
| ---------------- | -------- | ---------------------------------------------------- |
| `file`           | yes      | Exactly one JPG/JPEG/PNG image, up to 50 MiB decoded |
| `receiptId`      | yes      | Delivery receipt ID, trimmed and uppercased          |
| `idempotencyKey` | yes      | Retry/idempotency key                                |
| `labelKeys[]`    | yes      | One or more existing allowed label keys              |

Behavior:

- preserves the original image bytes in configured storage;
- validates filename extension, declared MIME type, and image magic bytes consistently;
- creates a source document record with `documentKind=quarantine_certificate`;
- creates one `QuarantineCertificate` record linked to that source document and normalized
  `receiptId`;
- permits linking to a `receiptId` whose delivery ledger has not been uploaded yet;
- exact replay of the same organization, idempotency key, file bytes, receipt ID, and label set
  returns the same source document metadata; reusing the idempotency key for changed input returns
  `409` / `IDEMPOTENCY_KEY_CONFLICT`;
- does not deduplicate different idempotency keys by image content, so multiple real certificates
  may be attached to the same receipt ID.

Response shape:

```json
{
  "sourceDocumentId": "doc_...",
  "receiptId": "SH2608250117",
  "originalFileName": "quarantine.png",
  "contentType": "image/png",
  "byteSize": 12345,
  "uploadedAt": "2026-08-31T08:00:00.000Z"
}
```

### `POST /v1/quarantine-certificates/query`

Request shape:

```json
{
  "receiptIds": ["SH2608250117", "SH2608260003"]
}
```

The request must contain 1-100 receipt IDs. The API trims, uppercases, and deduplicates them while
preserving first-seen order. There is intentionally no "query all certificates" mode and no
pagination in this endpoint.

Response shape:

```json
{
  "results": [
    {
      "receiptId": "SH2608250117",
      "certificates": [
        {
          "sourceDocumentId": "doc_...",
          "receiptId": "SH2608250117",
          "originalFileName": "quarantine.png",
          "contentType": "image/png",
          "byteSize": 12345,
          "uploadedAt": "2026-08-31T08:00:00.000Z"
        }
      ]
    },
    {
      "receiptId": "SH2608260003",
      "certificates": []
    }
  ]
}
```

Missing receipts, certificates hidden by labels, cross-org data, archived source documents, and
disabled employees all resolve to empty certificate arrays rather than leaking existence.

### `POST /v1/quarantine-certificates/archive`

Request shape, exactly one selector:

```json
{ "sourceDocumentId": "doc_..." }
```

or:

```json
{ "receiptId": "SH2608250117" }
```

Archiving by `sourceDocumentId` is allowed for the uploader or an admin. Archiving by `receiptId`
is admin-only and archives all visible quarantine certificates under that receipt ID for the
organization.

Response shape:

```json
{
  "archivedCount": 1
}
```

## Source Document Download Links

### `POST /v1/source-documents/:documentId/download-url`

Request body is empty. The caller must be authorized for the source document through the same
organization, employee status, and label policy used by evidence/structured data. The endpoint is
generic: it can issue a link for any visible source document kind, including quarantine
certificates, structured uploads, and evidence uploads.

Response shape:

```json
{
  "sourceDocumentId": "doc_...",
  "downloadUrl": "https://...",
  "expiresAt": "2026-09-01T08:00:00.000Z",
  "originalFileName": "quarantine.png",
  "contentType": "image/png",
  "byteSize": 12345
}
```

The link is valid for 24 hours and uses attachment disposition so clicking it downloads the
original file. The API returns a link only; it does not proxy file bytes. Missing objects,
archived/deleted source documents, cross-org documents, and label-inaccessible documents all return
the same non-enumerating `404`.

## Structured Import

### `POST /v1/structured/imports`

Multipart form fields:

| Field             | Required    | Notes                                                                                 |
| ----------------- | ----------- | ------------------------------------------------------------------------------------- |
| `file`            | yes         | CSV/XLSX                                                                              |
| `dataset`         | yes         | `dishes`, `business`, `vip`, `dish_catalog`, `delivery_ledger`, or `supplier_catalog` |
| `enterprise_name` | yes         | Metadata supplied by caller                                                           |
| `startDate`       | conditional | Required only for `dishes`, `business`, and `vip`; `YYYYMMDD` window                  |
| `endDate`         | conditional | Required only for `dishes`, `business`, and `vip`; `YYYYMMDD` window                  |
| `snapshotDate`    | conditional | Required only for `dish_catalog`; `YYYYMMDD` complete snapshot date                   |
| `idempotencyKey`  | yes         | Prevents duplicate imports                                                            |
| `labelKeys[]`     | yes         | One or more existing allowed label keys                                               |

`dish_catalog` rejects `startDate` and `endDate`; its public date is the one required `snapshotDate`.
`delivery_ledger` and `supplier_catalog` reject all date fields: delivery receipt date is derived
from the file's `收货日期`, while a supplier catalog is an undated complete snapshot. Internally,
the `dish_catalog` import batch normalizes `snapshotDate` to identical start/end dates; delivery
stores its derived receipt date for status/reporting compatibility without reserving a date window.
The other datasets retain their ordinary business-date-window rules.

Client upload behavior:

- Clients should upload the user's original CSV/XLSX bytes and let the service perform
  dataset-specific parsing, validation, conversion, and safe error reporting.
- Dataset registry metadata is not a recipe for clients to reconstruct files. Clients must not
  rewrite headers, duplicate receipt-level metadata into detail rows, or generate replacement files
  unless the user explicitly asks for a separate local file-conversion task.
- General transport handling is still allowed: clients may prefer path-based upload, avoid inline
  payload limits, or split legitimately large business-window uploads by stable non-overlapping
  business boundaries when that preserves row meaning.

Behavior:

- preflights request metadata, validates authorized labels/date-window eligibility, reserves its
  durable identifiers, stores and verifies the original object, then queues a `structured_import`
  worker run;
- returns `202 Accepted` with `document.status=pending_processing`,
  `processing.status=queued`, and `importBatch.status=pending`; header/sheet/row validation and
  all row writes happen in the worker, so invalid headers are rejected later through status rather
  than as an immediate upload response;
- only `importBatch.status=applied` is a terminal structured-upload success; `rejected` and
  `failed` are terminal non-success outcomes;
- reserves `Document`, `ImportBatch`, deterministic object key, and started audit in MySQL before
  writing storage; window and snapshot datasets also reserve date claims, `delivery_ledger` uses
  an organization+dataset+receipt natural key instead, and `supplier_catalog` uses neither a date
  claim nor a natural key;
- stores the original file with canonical metadata;
- the worker writes each row into the dataset-specific MySQL table and applies the batch in one transaction;
- exact replay of the same `idempotencyKey` and request fingerprint returns the originally persisted `documentId`, `importBatchId`, storage key, and status without writing duplicate storage objects, rows, claims, or audits;
- same idempotency key with a different fingerprint returns a conflict before durable side effects;
- delivery uploads also use the exact normalized receipt ID as an organization-scoped natural
  key: an exact replay returns the original import even with a different idempotency key, while
  different content or metadata for that receipt returns `RECEIPT_ID_CONFLICT` before storage;
- supplier catalog uploads use the caller idempotency key for retry identity and never replace the
  current catalog until a worker applies the complete snapshot successfully;
- queues the structured-import worker path rather than applying rows on the HTTP request path.

### `dish_catalog` snapshot contract

Each upload is one complete, append-only catalog snapshot for the authenticated organization. The
service keeps one date-ordered catalog timeline per organization: it permits out-of-order historical
uploads, but permits only one non-archived snapshot for a given `snapshotDate`. To correct a same-date
snapshot with different content, archive the existing snapshot first and then upload the replacement;
an exact idempotent replay remains a replay of the existing batch. A new snapshot never auto-archives
an older one.

The service accepts CSV or XLSX. The exact controlled headers below are required, but their column
order may vary. `二级分类编码`, `规格名称`, and `菜品别名` may be blank; all other file fields are
required. `售卖价` is a decimal and `0` is valid.

| Source header       | Query field             | Requirement                                   |
| ------------------- | ----------------------- | --------------------------------------------- |
| `菜品编码（SPUID）` | `spu_id`                | required; may repeat for multiple SKUs        |
| `菜品编码（SKUID）` | `sku_id`                | required; unique across the complete snapshot |
| `菜品名称`          | `dish_name`             | required                                      |
| `品牌`              | `brand_name`            | required                                      |
| `基础分类`          | `base_category_name`    | required                                      |
| `一级分类编码`      | `level_1_category_code` | required                                      |
| `二级分类编码`      | `level_2_category_code` | nullable                                      |
| `规格名称`          | `specification_name`    | nullable                                      |
| `售卖价`            | `sale_price`            | required decimal; zero is allowed             |
| `菜品别名`          | `dish_alias`            | nullable                                      |

`snapshot_date` is added to every imported row from `snapshotDate` and is available through
discovery and controlled structured queries. In XLSX, every visible worksheet whose header exactly
matches this schema contributes rows to the same snapshot; worksheet names do not matter. A
nonmatching worksheet (for example, a headquarters-combo sheet) is ignored and represented only by
a safe `SCHEMA_NOT_MATCHED` status summary. A matching hidden worksheet rejects the whole import;
hidden nonmatching worksheets are ignored. A snapshot requires at least one valid SKU row.

The API deliberately does not choose a current/latest catalog, compute a snapshot diff, infer
added/removed/discontinued status, or otherwise infer state across snapshots. Callers must explicitly
filter or compare `snapshot_date` values.

### `delivery_ledger` receipt contract

Each CSV/XLSX file represents exactly one delivery receipt. A workbook may also contain empty,
hidden, or visible instruction sheets; the importer selects exactly one visible worksheet with the
receipt item header and rejects multiple matching receipt worksheets. The receipt worksheet must contain the document fields
`单据号`, `订货机构`, `送货机构`, and `收货日期`, plus item columns `序号`, `物品名称`, `规格型号`,
`收货数量`, and `收货金额`. The receipt ID and normalized `purchase_date` are derived from
the file; callers must not send date metadata. Every numeric item row before the footer becomes one
ledger row, including non-food items. `supplier_name` comes from `送货机构`, and production/batch
and shelf-life fields are always `null`.

| Query field                                       | Source or rule                                      | Aliases                            |
| ------------------------------------------------- | --------------------------------------------------- | ---------------------------------- |
| `source_document_id`                              | source document ID for the uploaded receipt file    |                                    |
| `entry_id`                                        | generated UUID per imported item                    | `序号`                             |
| `purchase_date`                                   | derived from `收货日期`, normalized to `YYYY-MM-DD` | `进货日期`                         |
| `store_name`                                      | `订货机构`                                          |                                    |
| `receipt_id`                                      | `单据号`                                            |                                    |
| `supplier_name`                                   | `送货机构`                                          | `供货单位名称`                     |
| `item_name`                                       | `物品名称`                                          | `食品名称`                         |
| `specification`                                   | `规格型号`                                          | `规格`                             |
| `purchase_quantity`                               | `收货数量` as decimal                               | `进货数量`                         |
| `purchase_amount`                                 | `收货金额` as decimal                               | `进货金额`                         |
| `production_date_or_batch`                        | always `null`                                       | `生产日期或生产批号`               |
| `shelf_life`                                      | always `null`                                       | `保质期`                           |
| `supplier_contact_phone`, `supplier_unit_address` | dynamic current-catalog lookup                      | `供货单位联系方式`, `供货单位地址` |

### `supplier_catalog` snapshot contract

Each CSV/XLSX file is one supplier master-data snapshot using the controlled supplier columns.
`供应商名称` is required and is the exact enrichment key; the other controlled columns, including
`联系人电话` and `单位地址`, are optional and preserve present values while absent or empty values
remain null. Unknown or unnamed columns are rejected rather than silently discarded. A workbook
must contain exactly one visible matching supplier worksheet; unrelated visible and all hidden
worksheets are ignored. The latest successful `applied` catalog for
the organization is the only current source for delivery enrichment. Older applied snapshots remain
queryable history but are not used as a fallback, and a failed/rejected/in-progress snapshot never
becomes current.

The source document must also be visible to the employee for dynamic enrichment. Delivery queries
may select `supplier_contact_phone` and `supplier_unit_address`; these virtual fields are selection
only (`filter=false`, `sort=false`, `group=false`, `aggregate=false`). They are `null` when there is
no current catalog, the current catalog is not visible, no exact match exists, the source value is
blank, or the exact supplier name is ambiguous. Enrichment is limited to supplier names on the
authorized ledger result page and does not alter filtering, sorting, pagination, or aggregation.

Response shape:

```json
{
  "document": {
    "documentId": "doc_...",
    "documentKind": "structured",
    "fileType": "csv",
    "status": "pending_processing",
    "storageObjectKey": "org/org_.../documents/doc_.../original/enterprise_dishes_20260701_20260731.csv",
    "originalFileName": "source.csv"
  },
  "processing": {
    "processingRunId": "run_...",
    "status": "queued"
  },
  "importBatch": {
    "importBatchId": "imp_...",
    "sourceDocumentId": "doc_...",
    "dataset": "dishes",
    "status": "pending",
    "startDate": "20260701",
    "endDate": "20260731",
    "sourceSheetSummary": [],
    "validationErrors": [],
    "totalRowCount": 0,
    "appliedRowCount": 0,
    "queryableRowCount": 0
  }
}
```

For `dish_catalog`, the upload response and later import-status response use `snapshotDate` and
omit public `startDate` and `endDate`:

```json
{
  "importBatch": {
    "importBatchId": "imp_...",
    "sourceDocumentId": "doc_...",
    "dataset": "dish_catalog",
    "status": "pending",
    "snapshotDate": "20260819",
    "sourceSheetSummary": [],
    "validationErrors": [],
    "totalRowCount": 0,
    "appliedRowCount": 0,
    "queryableRowCount": 0
  }
}
```

## Structured Import Status

### `GET /v1/structured/imports/:importBatchId`

Returns the additive `document`, `processing`, and `importBatch` status views for visible import
batches only. Clients poll this endpoint after a `202` structured upload: after 2 seconds, then 5
seconds, then 10 seconds, then every 15 seconds, for a default maximum of 10 minutes. A
non-terminal result at 10 minutes is still processing, not failure; retain the returned Document and
ImportBatch IDs and check later. Do not re-upload instead of polling; exact replays alone reuse the
same idempotency key.

For terminal `rejected` or `failed`, clients may present safe returned validation/error summaries
and correction advice, but must not expose internal exceptions. Only `applied` is a successful
structured import.

Missing, cross-org, disabled, or same-org-but-label-inaccessible batches all return the same non-enumerating `404`/`IMPORT_BATCH_NOT_FOUND` shape. The response must not include dataset, date window, row counts, sheet summaries, error IDs, or validation details unless the caller is currently authorized for the source document under the shared document visibility policy.

## Structured Dataset Discovery

### `GET /v1/structured/datasets`

Returns supported datasets, canonical fields, aliases, operators, aggregate support, sorting, grouping, pagination limits, and query safety limits.

Field name semantics:

- `canonicalName` is the stable public API field name. It is the only field identifier accepted by structured query inputs such as `select`, `filter.field`, `sort.field`, `groupBy`, and aggregate `field`.
- `sourceColumn` is the original or canonical source-table label. `aliases` are controlled alternative labels, including user-facing paper/table terms and accepted upload header variants.
- `sourceColumn` and `aliases` cannot be used directly as structured query field names. Employee agents should first map a user phrase such as `进货数量` to its field's `canonicalName` such as `purchase_quantity`, then send the canonical name in `POST /v1/structured/query`.
- When presenting query results to a user, agents may use `sourceColumn` or the matched alias as the table header instead of exposing the English `canonicalName`.

Supported datasets:

- `dishes`
- `business`
- `vip`
- `dish_catalog` — complete catalog snapshots, including the metadata-derived `snapshot_date`
- `delivery_ledger` — one receipt per CSV/XLSX file, with receipt date derived from `收货日期`
- `supplier_catalog` — CSV/XLSX supplier snapshots using controlled columns for current enrichment

## Structured Query

### `POST /v1/structured/query`

This is a controlled read-only JSON API. It is semantically similar to a constrained SQL `SELECT`, but clients never send SQL.

Structured query evaluates document visibility with the same policy used by evidence and import status: same org first, disabled denied, same-org admin access, then `all_staff` or current label intersection for non-admins. Numeric, date, and boolean fields use typed SQL expressions for filters, sorting, `min`, `max`, `sum`, and `avg`; string fields keep text semantics. The public response scalar representation remains compatible with the current schema.

Every structured dataset exposes `source_document_id` for detail-row selection so an employee
agent can retrieve the original source file through the download-link endpoint. It is not returned
by default and cannot be used for filters, sorting, grouping, or aggregates.

Example detail-row request:

```json
{
  "dataset": "dishes",
  "filter": {
    "and": [
      { "field": "business_date", "op": "between", "value": ["2026-07-01", "2026-07-05"] },
      { "field": "product_name", "op": "contains", "value": "肉夹馍" }
    ]
  },
  "select": ["business_date", "product_name", "dish_sales_quantity"],
  "sort": [{ "field": "business_date", "direction": "asc" }],
  "page": { "limit": 100 }
}
```

Example explicit mechanical aggregate:

```json
{
  "dataset": "dishes",
  "filter": {
    "and": [
      { "field": "business_date", "op": "eq", "value": "2026-07-05" },
      { "field": "product_name", "op": "contains", "value": "肉夹馍" }
    ]
  },
  "aggregates": [{ "field": "dish_sales_quantity", "op": "sum", "as": "quantity_sum" }],
  "groupBy": ["product_name"],
  "page": { "limit": 100 }
}
```

Example catalog snapshot query:

```json
{
  "dataset": "dish_catalog",
  "filter": { "field": "snapshot_date", "op": "eq", "value": "2026-08-19" },
  "select": ["snapshot_date", "sku_id", "dish_name", "sale_price"],
  "sort": [{ "field": "sku_id", "direction": "asc" }],
  "page": { "limit": 100 }
}
```

Unsupported:

- raw SQL;
- mutation operations;
- joins across arbitrary tables;
- formulas/window functions;
- natural-language query generation;
- service-side business conclusions.

Structured query cursors are opaque, signed, and scoped to org, employee, role, sorted current labels, registry/query shape, filter, sort, and limit. Changing employee, organization, role, label set, or query shape invalidates the cursor rather than silently reusing an old authorization scope.

## MCP Tools

Launcher-local bootstrap tools:

- `enterprise_hub_login`
- `enterprise_hub_logout`
- `enterprise_hub_auth_status`

Service MCP tools:

- `enterprise_hub_list_labels`
- `enterprise_hub_list_skills`
- `upload_evidence_document`
- `get_evidence_document_status`
- `search_document_evidence`
- `upload_structured_dataset`
- `upload_quarantine_certificate`
- `get_import_status`
- `list_structured_datasets`
- `query_structured_dataset`
- `query_quarantine_certificates`
- `archive_quarantine_certificates`
- `get_source_document_download_url`

The service exposes authenticated stateless Streamable HTTP only at `POST /mcp`; every initialize,
discovery, and tool request requires an official opaque bearer access token. The launcher silently
refreshes and adds the memory-only access token. Upload tools receive inline Base64 bytes and never
dereference a client file path. All business tools preserve backend authorization and must not
direct-read backend storage, MySQL, or Qdrant.

## Environment Notes

Required environment variables are tracked in `docs/implementation/env-inventory.md`.

Phase 3 local defaults use:

- local MySQL;
- local Qdrant;
- local filesystem storage;
- fake embedding/rerank providers unless a real external provider is explicitly configured and acknowledged.

## Verification

Required checks for this contract:

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

Current Phase 3 hardening integration proofs include:

- `phase3_structured_concurrent_exact_replay`
- `phase3_structured_storage_and_apply_recovery`
- `phase3_worker_lease_crash_recovery`
- `phase3_structured_typed_query`
- `phase3_evidence_signed_pagination`
