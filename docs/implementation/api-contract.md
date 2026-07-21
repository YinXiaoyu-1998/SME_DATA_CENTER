# 企业资料中枢 API / MCP Contract

Last updated: 2026-07-20

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

Local development auth:

- `POST /auth/dev-login` with a seeded employee email returns a bearer token.
- The local MCP launcher stores its development token only in process memory and requires login again after restart.

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

| Method | Path                                        | Purpose                                      |
| ------ | ------------------------------------------- | -------------------------------------------- |
| `GET`  | `/healthz`                                  | Liveness                                     |
| `POST` | `/auth/dev-login`                           | Local seeded employee login                  |
| `GET`  | `/me`                                       | Current employee/session metadata            |
| `GET`  | `/labels`                                   | Label catalog                                |
| `GET`  | `/skills`                                   | Approved Skill Directory metadata            |
| `GET`  | `/audit`                                    | Admin audit query                            |
| `POST` | `/v1/documents/evidence`                    | Upload MD/TXT/DOCX evidence document         |
| `GET`  | `/v1/documents/evidence/:documentId/status` | Evidence document + index status             |
| `POST` | `/v1/evidence/search`                       | Search visible evidence chunks               |
| `POST` | `/v1/structured/imports`                    | Import supported CSV/XLSX structured dataset |
| `GET`  | `/v1/structured/imports/:importBatchId`     | Structured import status                     |
| `GET`  | `/v1/structured/datasets`                   | Structured dataset schema discovery          |
| `POST` | `/v1/structured/query`                      | Controlled read-only structured query        |

## Deferred HTTP Surface

`GET /readyz` is not an active public HTTP endpoint in Phase 3. Runtime readiness is checked by the local script `npm run readyz:local`; an HTTP readiness endpoint is a Phase 4 staging/runtime capability and should not be documented as callable until it is implemented and route-tested.

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
    "title": "差评处理 SOP",
    "fileType": "md",
    "status": "pending_processing",
    "labels": [{ "key": "store:baoli", "name": "Baoli" }],
    "processingRunStatus": "queued",
    "documentIndexStatus": "pending"
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
    "title": "差评处理 SOP",
    "fileType": "md",
    "status": "active",
    "labels": [{ "key": "store:baoli", "name": "Baoli" }]
  },
  "processingRun": {
    "status": "succeeded",
    "jobType": "evidence_document_index"
  },
  "documentIndex": {
    "status": "ready",
    "indexType": "qdrant_hybrid",
    "chunkCount": 12,
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

## Structured Import

### `POST /v1/structured/imports`

Multipart form fields:

| Field             | Required | Notes                                   |
| ----------------- | -------- | --------------------------------------- |
| `file`            | yes      | CSV/XLSX                                |
| `dataset`         | yes      | `dishes` or `business`                  |
| `enterprise_name` | yes      | Metadata supplied by caller             |
| `startDate`       | yes      | Business-day start, `YYYYMMDD`          |
| `endDate`         | yes      | Business-day end, `YYYYMMDD`            |
| `idempotencyKey`  | yes      | Prevents duplicate imports              |
| `labelKeys[]`     | yes      | One or more existing allowed label keys |

Behavior:

- validates every sheet/table atomically;
- supports controlled header aliases mapping into canonical fields;
- rejects the whole file if structure, date window, labels, or active-window rules fail;
- reserves `Document`, `ImportBatch`, window claim, deterministic object key, and started audit in MySQL before writing storage;
- stores the original file with canonical metadata;
- writes each row into the dataset-specific MySQL table and applies the batch in one transaction;
- exact replay of the same `idempotencyKey` and request fingerprint returns the originally persisted `documentId`, `importBatchId`, storage key, and status without writing duplicate storage objects, rows, claims, or audits;
- same idempotency key with a different fingerprint returns a conflict before durable side effects;
- does not use the evidence worker path.

Response shape:

```json
{
  "document": {
    "documentId": "doc_...",
    "status": "active",
    "storageObjectKey": "orgs/org_.../documents/doc_.../source.csv"
  },
  "importBatch": {
    "importBatchId": "batch_...",
    "dataset": "dishes",
    "status": "applied",
    "appliedRowCount": 128
  }
}
```

## Structured Import Status

### `GET /v1/structured/imports/:importBatchId`

Returns import status and validation/application metadata for visible import batches only.

Missing, cross-org, disabled, or same-org-but-label-inaccessible batches all return the same non-enumerating `404`/`IMPORT_BATCH_NOT_FOUND` shape. The response must not include dataset, date window, row counts, sheet summaries, error IDs, or validation details unless the caller is currently authorized for the source document under the shared document visibility policy.

## Structured Dataset Discovery

### `GET /v1/structured/datasets`

Returns supported datasets, canonical fields, aliases, operators, aggregate support, sorting, grouping, pagination limits, and query safety limits.

Supported datasets:

- `dishes`
- `business`

## Structured Query

### `POST /v1/structured/query`

This is a controlled read-only JSON API. It is semantically similar to a constrained SQL `SELECT`, but clients never send SQL.

Structured query evaluates document visibility with the same policy used by evidence and import status: same org first, disabled denied, same-org admin access, then `all_staff` or current label intersection for non-admins. Numeric, date, and boolean fields use typed SQL expressions for filters, sorting, `min`, `max`, `sum`, and `avg`; string fields keep text semantics. The public response scalar representation remains compatible with the current schema.

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

- `enterprise_hub_login_local`
- `enterprise_hub_logout_local`

Service MCP tools:

- `enterprise_hub_list_labels`
- `enterprise_hub_list_skills`
- `upload_evidence_document`
- `get_evidence_document_status`
- `search_document_evidence`
- `upload_structured_dataset`
- `get_import_status`
- `list_structured_datasets`
- `query_structured_dataset`

The service exposes authenticated stateless Streamable HTTP only at `POST /mcp`; every initialize, discovery, and tool request requires bearer auth. The launcher adds its memory-only token to every request. Upload tools receive inline Base64 bytes and never dereference a client file path. All business tools preserve backend authorization and must not direct-read backend storage, MySQL, or Qdrant.

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
