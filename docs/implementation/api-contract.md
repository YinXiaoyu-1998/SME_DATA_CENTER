# 企业资料中枢 API Contract

This contract records the planned P0 surface, seeded identity assumptions, catalog enum values, and implemented request/response examples through Phase 1 / Day 2.

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
