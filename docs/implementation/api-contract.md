# 企业资料中枢 API Contract

This contract records the planned P0 surface, seeded identity assumptions, catalog enum values, and implemented request/response examples through Phase 1 / Day 4C.

## Cross-Cutting Rules

- All non-health endpoints require an authenticated employee context.
- The backend must enforce employee-account permissions and active-state filtering.
- Ordinary employee queries must not reveal inaccessible document existence, titles, filenames, counts, or summaries.
- API tokens, CLI clients, MCP servers, and web clients inherit employee permissions.

## Catalog Enum Values

### `DocumentStatus`

Exact values:

- `uploading`
- `pending_processing`
- `processing`
- `active`
- `processing_failed`
- `archived`

Only `active` documents may enter ordinary employee search/query results.

### `DocumentType`

Exact values:

- `raw_material`
- `structured_dataset`
- `analysis_artifact`
- `business_event`
- `management_knowledge`

## P0 API List

| Method | Path                      | Purpose                                               | Day Implemented |
| ------ | ------------------------- | ----------------------------------------------------- | --------------- |
| `POST` | `/auth/dev-login`         | Local-only development login for seeded employees.    | Day 1B          |
| `GET`  | `/me`                     | Return authenticated employee profile and label keys. | Day 1B          |
| `GET`  | `/labels`                 | List available labels for controlled assignment.      | Later P0        |
| `POST` | `/documents`              | Upload a document and create a catalog record.        | Day 2           |
| `GET`  | `/documents`              | Search/list accessible active documents.              | Day 4A          |
| `GET`  | `/documents/:id`          | Fetch accessible active document metadata.            | Day 4A          |
| `GET`  | `/documents/:id/download` | Download an accessible active document.               | Day 4A          |
| `POST` | `/documents/:id/archive`  | Archive a document without physical deletion.         | Day 4C          |
| `POST` | `/documents/:id/labels`   | Add existing labels to a document.                    | Day 4C          |
| `GET`  | `/documents/:id/status`   | Return upload/processing status to allowed actors.    | Day 2           |
| `GET`  | `/skills`                 | List approved business skill directory entries.       | Day 4B          |
| `GET`  | `/audit`                  | Admin-only audit log query.                           | Day 4C          |
| `GET`  | `/healthz`                | Liveness check.                                       | Day 1B          |

## Initial Examples

### `GET /healthz`

Response `200`:

```json
{
  "ok": true,
  "service": "enterprise-hub-api"
}
```

### `POST /auth/dev-login`

Request:

```json
{
  "email": "admin@example.com"
}
```

Response `200`:

```json
{
  "accessToken": "<jwt>",
  "employee": {
    "id": "emp_admin",
    "email": "admin@example.com",
    "role": "admin",
    "disabled": false,
    "labels": ["all_staff", "person:admin", "store:baoli", "store:suzhou"]
  }
}
```

Unknown employee response `404`:

```json
{
  "error": {
    "code": "EMPLOYEE_NOT_FOUND",
    "message": "Employee not found."
  }
}
```

Disabled employee response `403`:

```json
{
  "error": {
    "code": "EMPLOYEE_DISABLED",
    "message": "Employee account is disabled."
  }
}
```

### `POST /documents`

Request headers:

```http
Authorization: Bearer <jwt>
Content-Type: multipart/form-data
```

Multipart fields:

| Field          | Required | Example                            |
| -------------- | -------- | ---------------------------------- |
| `file`         | Yes      | `baoli-june-meituan.csv`           |
| `title`        | Yes      | `Baoli June Meituan Export`        |
| `documentType` | Yes      | `raw_material`                     |
| `sourceSystem` | No       | `meituan`                          |
| `sourceTime`   | No       | `2026-06-30T00:00:00.000Z`         |
| `labelKeys[]`  | No       | repeated field, e.g. `store:baoli` |

Response `201`:

```json
{
  "id": "doc_91e4dd567237bed3d3f00c67",
  "title": "Baoli June Meituan Export",
  "documentType": "raw_material",
  "status": "pending_processing",
  "labels": ["person:baoli.manager", "store:baoli"],
  "storageObjectKey": "org/default-org/documents/doc_91e4dd567237bed3d3f00c67/original/baoli-june-meituan.csv",
  "originalFileName": "baoli-june-meituan.csv",
  "sourceSystem": "meituan",
  "sourceTime": "2026-06-30T00:00:00.000Z",
  "processingRunStatus": "queued"
}
```

Unknown label response `400`:

```json
{
  "error": {
    "code": "UNKNOWN_LABEL",
    "message": "One or more labels do not exist."
  }
}
```

Forbidden label response `403`:

```json
{
  "error": {
    "code": "FORBIDDEN_LABEL",
    "message": "One or more labels cannot be assigned."
  }
}
```

Invalid upload response `400`:

```json
{
  "error": {
    "code": "INVALID_DOCUMENT_UPLOAD",
    "message": "File is required."
  }
}
```

Catalog write failure response `500`:

```json
{
  "error": {
    "code": "DOCUMENT_CATALOG_WRITE_FAILED",
    "message": "Document catalog write failed."
  }
}
```

Unauthenticated response `401`:

```json
{
  "error": {
    "code": "UNAUTHENTICATED",
    "message": "Authentication is required."
  }
}
```

### `GET /documents/:id/status`

Allowed actors: the uploader or an admin. Non-admin, non-uploader access returns `404` to avoid document existence leakage.

Request headers:

```http
Authorization: Bearer <jwt>
```

Response `200`:

```json
{
  "id": "doc_91e4dd567237bed3d3f00c67",
  "title": "Baoli June Meituan Export",
  "documentType": "raw_material",
  "status": "pending_processing",
  "labels": ["person:baoli.manager", "store:baoli"],
  "storageObjectKey": "org/default-org/documents/doc_91e4dd567237bed3d3f00c67/original/baoli-june-meituan.csv",
  "originalFileName": "baoli-june-meituan.csv",
  "sourceSystem": "meituan",
  "sourceTime": "2026-06-30T00:00:00.000Z",
  "processingRunStatus": "queued"
}
```

Not found or inaccessible response `404`:

```json
{
  "error": {
    "code": "DOCUMENT_NOT_FOUND",
    "message": "Document not found."
  }
}
```

Processing failed response `200` for uploader or admin:

```json
{
  "id": "doc_91e4dd567237bed3d3f00c67",
  "title": "Unsupported binary upload",
  "documentType": "raw_material",
  "status": "processing_failed",
  "labels": ["person:baoli.manager", "store:baoli"],
  "storageObjectKey": "org/default-org/documents/doc_91e4dd567237bed3d3f00c67/original/receipt.pdf",
  "originalFileName": "receipt.pdf",
  "sourceSystem": null,
  "sourceTime": null,
  "processingRunStatus": "failed"
}
```

### `GET /documents`

Search/list accessible active documents. The backend filters by authenticated employee permissions before returning results. Ordinary employees only see `active` documents whose labels match one of their employee labels or `all_staff`; admins can list all active documents. Inaccessible documents are not counted, named, or otherwise revealed.

Query params:

| Param          | Required | Example        | Notes                                               |
| -------------- | -------- | -------------- | --------------------------------------------------- |
| `q`            | No       | `Meituan`      | Keyword over title, source system, metadata, chunks |
| `documentType` | No       | `raw_material` | Must be one of the documented enum values           |
| `labelKey`     | No       | `store:baoli`  | Further narrows results by an existing label key    |
| `limit`        | No       | `20`           | 1-50, default 20                                    |
| `cursor`       | No       | `20`           | Opaque pagination offset returned as `nextCursor`   |

Response `200`:

```json
{
  "documents": [
    {
      "id": "doc_91e4dd567237bed3d3f00c67",
      "title": "Baoli June Meituan Export",
      "documentType": "raw_material",
      "status": "active",
      "labels": ["store:baoli"],
      "originalFileName": "baoli-june-meituan.csv",
      "sourceSystem": "meituan",
      "sourceTime": "2026-06-30T00:00:00.000Z",
      "createdAt": "2026-06-30T01:00:00.000Z"
    }
  ],
  "nextCursor": null
}
```

Invalid query response `400`:

```json
{
  "error": {
    "code": "INVALID_DOCUMENT_QUERY",
    "message": "Document type is invalid."
  }
}
```

### `GET /documents/:id`

Returns metadata for an accessible active document. Missing, inactive, archived, or inaccessible documents all return the same `404`.

Response `200`:

```json
{
  "id": "doc_91e4dd567237bed3d3f00c67",
  "title": "Baoli June Meituan Export",
  "documentType": "raw_material",
  "status": "active",
  "labels": ["store:baoli"],
  "originalFileName": "baoli-june-meituan.csv",
  "sourceSystem": "meituan",
  "sourceTime": "2026-06-30T00:00:00.000Z",
  "createdAt": "2026-06-30T01:00:00.000Z",
  "storageObjectKey": "org/default-org/documents/doc_91e4dd567237bed3d3f00c67/original/baoli-june-meituan.csv",
  "contentType": "text/csv",
  "byteSize": 128,
  "checksumSha256": "..."
}
```

Not found or inaccessible response `404`:

```json
{
  "error": {
    "code": "DOCUMENT_NOT_FOUND",
    "message": "Document not found."
  }
}
```

### `GET /documents/:id/download`

Returns a usable local download URL for an accessible active document and records a download audit event. Missing, inactive, archived, or inaccessible documents all return the same `404`.

Response `200`:

```json
{
  "id": "doc_91e4dd567237bed3d3f00c67",
  "downloadUrl": "file:///absolute/local/storage/path/baoli-june-meituan.csv"
}
```

Not found or inaccessible response `404`:

```json
{
  "error": {
    "code": "DOCUMENT_NOT_FOUND",
    "message": "Document not found."
  }
}
```

Audit events appended by Day 4A:

- `document.queried` with query filters and returned result count, without inaccessible document titles.
- `document.downloaded` for successful accessible active document downloads.

### `GET /skills`

Lists approved business skill directory entries for authenticated employees and employee-owned agents. This endpoint only returns skill metadata, installation guidance, input requirements, and example prompts. It does not execute skills, generate reports, call models, or return analysis results.

Query params:

| Param      | Required | Example         | Notes                                                     |
| ---------- | -------- | --------------- | --------------------------------------------------------- |
| `q`        | No       | `菜单`          | Keyword over name, description, category, inputs, prompts |
| `category` | No       | `menu-analysis` | Filters approved skills by exact category                 |

Response `200`:

```json
{
  "skills": [
    {
      "id": "skill_menu_gross_margin_analysis",
      "name": "menu-gross-margin-analysis",
      "description": "菜单毛利分析 skill，帮助员工智能体分析菜品毛利和菜单结构。",
      "version": "1.0.0",
      "category": "menu-analysis",
      "inputRequirements": ["已授权的菜单数据", "菜品成本数据", "销售明细"],
      "installInstructions": "Install the approved menu-gross-margin-analysis skill in the employee agent.",
      "examplePrompts": ["分析最近三个月菜单毛利，找出需要调整的菜品"],
      "status": "approved"
    }
  ]
}
```

Seeded approved entries:

- `weekly-store-report`
- `menu-gross-margin-analysis`

Disabled or unapproved skills are not returned by `GET /skills`.

### `POST /documents/:id/archive`

Archives an active document by metadata state change only. The original storage object is not deleted. Allowed actors are the uploader or an admin. Non-uploader employees who can otherwise see the document receive `403`; inaccessible documents still return `404`.

Response `200`:

```json
{
  "id": "doc_91e4dd567237bed3d3f00c67",
  "title": "Baoli June Meituan Export",
  "documentType": "raw_material",
  "status": "archived",
  "labels": ["person:baoli.manager", "store:baoli"],
  "originalFileName": "baoli-june-meituan.csv",
  "sourceSystem": "meituan",
  "sourceTime": "2026-06-30T00:00:00.000Z",
  "createdAt": "2026-06-30T01:00:00.000Z",
  "storageObjectKey": "org/default-org/documents/doc_91e4dd567237bed3d3f00c67/original/baoli-june-meituan.csv",
  "contentType": "text/csv",
  "byteSize": 128,
  "checksumSha256": "..."
}
```

Forbidden mutation response `403`:

```json
{
  "error": {
    "code": "DOCUMENT_UPDATE_FORBIDDEN",
    "message": "Document cannot be changed."
  }
}
```

Audit event appended:

- `document.archived` with previous status metadata.

### `POST /documents/:id/labels`

Adds existing label-catalog entries to an active document. The MVP allows only the uploader or an admin to change document labels. Non-admin uploaders may share to existing personal or store labels, but cannot add `all_staff`.

Request:

```json
{
  "labelKeys": ["person:lijie"]
}
```

Response `200`:

```json
{
  "id": "doc_91e4dd567237bed3d3f00c67",
  "title": "Baoli Menu Analysis Report",
  "documentType": "analysis_artifact",
  "status": "active",
  "labels": ["person:baoli.manager", "person:lijie"],
  "originalFileName": "baoli-menu-analysis.md",
  "sourceSystem": null,
  "sourceTime": null,
  "createdAt": "2026-06-30T01:00:00.000Z",
  "storageObjectKey": "org/default-org/documents/doc_91e4dd567237bed3d3f00c67/original/baoli-menu-analysis.md",
  "contentType": "text/markdown",
  "byteSize": 256,
  "checksumSha256": "..."
}
```

Unknown label response `400`:

```json
{
  "error": {
    "code": "UNKNOWN_LABEL",
    "message": "One or more labels do not exist."
  }
}
```

Audit event appended:

- `document.labels_added` with added label keys.

Seeded Day 4C sharing employee:

- `lijie@example.com` / `emp_lijie` with labels `all_staff` and `person:lijie`.

### `GET /audit`

Admin-only audit query. Non-admin employees receive `403`.

Query params:

| Param    | Required | Example | Notes                                             |
| -------- | -------- | ------- | ------------------------------------------------- |
| `limit`  | No       | `20`    | 1-50, default 20                                  |
| `cursor` | No       | `20`    | Opaque pagination offset returned as `nextCursor` |

Response `200`:

```json
{
  "auditEvents": [
    {
      "id": "audit_01",
      "actorEmployeeId": "emp_admin",
      "action": "document.archived",
      "targetType": "document",
      "targetId": "doc_91e4dd567237bed3d3f00c67",
      "result": "succeeded",
      "metadata": {
        "previousStatus": "active"
      },
      "requestId": "req-123",
      "clientIp": "127.0.0.1",
      "createdAt": "2026-06-30T02:00:00.000Z"
    }
  ],
  "nextCursor": null
}
```

Forbidden response `403`:

```json
{
  "error": {
    "code": "FORBIDDEN",
    "message": "Admin access is required."
  }
}
```

## Processing Worker

Command:

```bash
npm run worker:once
```

Behavior:

- Claims the oldest `queued` or `retry_scheduled` processing run and marks its document `processing`.
- Reads the original object from local storage and extracts UTF-8 text for `.txt`, `.md`, `.csv`, and `.json`.
- Rejects unsupported extensions with `UNSUPPORTED_FILE_TYPE`.
- Writes deterministic text chunks to `document_chunks` using `indexType: "text"` and unique `(document_id, chunk_hash, index_type)`.
- Marks the document `active` and run `succeeded` on success.
- Retries failed processing up to three failures, then marks the run `failed` and document `processing_failed`.

Worker result examples:

```json
{ "processed": true, "documentId": "doc_91e4dd567237bed3d3f00c67", "status": "active" }
```

```json
{
  "processed": true,
  "documentId": "doc_91e4dd567237bed3d3f00c67",
  "status": "processing_failed"
}
```

```json
{ "processed": false }
```

Audit events appended by the worker:

- `document.processing_started`
- `document.activated`
- `document.processing_failed`

### `GET /me`

Request headers:

```http
Authorization: Bearer <jwt>
```

Response `200`:

```json
{
  "employee": {
    "id": "emp_admin",
    "email": "admin@example.com",
    "role": "admin",
    "disabled": false,
    "labels": ["all_staff", "person:admin", "store:baoli", "store:suzhou"]
  }
}
```

Unauthenticated response `401`:

```json
{
  "error": {
    "code": "UNAUTHENTICATED",
    "message": "Authentication is required."
  }
}
```

Invalid token response `401`:

```json
{
  "error": {
    "code": "UNAUTHENTICATED",
    "message": "Authentication is required."
  }
}
```

Disabled employee response `403`:

```json
{
  "error": {
    "code": "EMPLOYEE_DISABLED",
    "message": "Employee account is disabled."
  }
}
```
