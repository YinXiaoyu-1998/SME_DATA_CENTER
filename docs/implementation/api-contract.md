# 企业资料中枢 API / MCP Contract

Last updated: 2026-07-13

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

- `POST /dev-login` with a seeded employee email returns a bearer token.
- MCP stores local development sessions in an ignored session file.

Authorization rules:

- evidence and structured data are filtered by org and labels in the API;
- evidence status is visible only to the uploader or an admin;
- structured import status and query results must not leak inaccessible source document names, row counts, or existence;
- not-found and inaccessible resources should use the same non-leaking error shape where practical.

## Active Public HTTP Surface

| Method | Path                                        | Purpose                                      |
| ------ | ------------------------------------------- | -------------------------------------------- |
| `GET`  | `/healthz`                                  | Liveness                                     |
| `GET`  | `/readyz`                                   | Runtime readiness                            |
| `POST` | `/dev-login`                                | Local seeded employee login                  |
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
    "labelKeys": ["store:baoli"],
    "fileTypes": ["md", "txt", "docx"]
  },
  "limit": 10
}
```

Response shape:

```json
{
  "results": [
    {
      "documentId": "doc_...",
      "chunkId": "chunk_...",
      "text": "差评处理需要在 15 分钟内联系顾客...",
      "score": 0.87,
      "metadata": {
        "title": "差评处理 SOP",
        "fileType": "md",
        "sourceSystem": "manual_upload",
        "labels": ["store:baoli"]
      }
    }
  ],
  "retrieval": {
    "configVersion": "phase3.retrieval.v1",
    "provider": "fake"
  },
  "warnings": []
}
```

The API searches only visible active evidence documents with ready indexes. It returns evidence, not final answers.

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
- stores the original file with canonical metadata;
- writes each row into the dataset-specific MySQL table;
- does not use the evidence worker path.

Response shape:

```json
{
  "document": {
    "documentId": "doc_...",
    "status": "active"
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

## Structured Dataset Discovery

### `GET /v1/structured/datasets`

Returns supported datasets, canonical fields, aliases, operators, aggregate support, sorting, grouping, pagination limits, and query safety limits.

Supported datasets:

- `dishes`
- `business`

## Structured Query

### `POST /v1/structured/query`

This is a controlled read-only JSON API. It is semantically similar to a constrained SQL `SELECT`, but clients never send SQL.

Example detail-row request:

```json
{
  "dataset": "dishes",
  "filters": {
    "and": [
      { "field": "business_date", "op": "between", "value": ["2026-07-01", "2026-07-05"] },
      { "field": "product_name", "op": "like", "value": "%肉夹馍%" }
    ]
  },
  "select": ["business_date", "product_name", "dish_sales_quantity"],
  "sort": [{ "field": "business_date", "direction": "asc" }],
  "limit": 100
}
```

Example explicit mechanical aggregate:

```json
{
  "dataset": "dishes",
  "filters": {
    "and": [
      { "field": "business_date", "op": "eq", "value": "2026-07-05" },
      { "field": "product_name", "op": "like", "value": "%肉夹馍%" }
    ]
  },
  "aggregates": [{ "field": "dish_sales_quantity", "op": "sum", "as": "quantity_sum" }],
  "groupBy": ["product_name"],
  "limit": 100
}
```

Unsupported:

- raw SQL;
- mutation operations;
- joins across arbitrary tables;
- formulas/window functions;
- natural-language query generation;
- service-side business conclusions.

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
