# 企业资料中枢 API Contract

This contract records the planned P0 surface, seeded identity assumptions, catalog enum values, and implemented request/response examples through Phase 1 / P0 label-catalog correction.

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
| `GET`  | `/labels`                 | List available labels for controlled assignment.      | P0 correction   |
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

## Local MCP Profile And Tool Contract

Phase 2 adds a local MCP adapter named `enterprise-hub-mcp`. The MCP server is an adapter over the HTTP API, not a second backend. It must not direct-read MySQL, direct-read storage, or implement independent authorization filtering. All non-health data access is delegated to the API with an authenticated employee context.

### Local Development Profile

| Setting      | Value                                                                                       |
| ------------ | ------------------------------------------------------------------------------------------- |
| Profile      | `local-development`                                                                         |
| Transport    | stdio                                                                                       |
| Command      | `ENTERPRISE_HUB_API_URL=http://127.0.0.1:3000 npm run mcp:dev`                              |
| Auth shape   | local dev login in Phase 2 Day 2, backed by `POST /auth/dev-login`                          |
| Session file | optional `ENTERPRISE_HUB_MCP_SESSION_FILE`, default `.data/enterprise-hub-mcp/session.json` |

Startup requirements:

- `ENTERPRISE_HUB_API_URL` is required and must be an `http` or `https` URL.
- `ENTERPRISE_HUB_MCP_PROFILE` defaults to `local-development`; other profiles are placeholders for later phases.
- The MCP server does not start API, worker, MySQL, or local storage services.
- The local MCP session file is written under `.data/` by default, is ignored by git, and may contain development-only API bearer tokens.
- Normal MCP tool output must not include raw access tokens.

### Phase 2 MCP Tools

| Tool                                       | Purpose                                                                        | Required Inputs                                    | High-Level Result Shape                            |
| ------------------------------------------ | ------------------------------------------------------------------------------ | -------------------------------------------------- | -------------------------------------------------- |
| `enterprise_hub_login_dev`                 | Log in as a seeded local employee through the existing API dev-login endpoint. | `email`                                            | `employee`, `sessionName`, `apiUrl`                |
| `enterprise_hub_list_labels`               | List catalog labels through authenticated `GET /labels`.                       | local session in Day 2                             | `labels[]` with `key`, `name`, `type`              |
| `enterprise_hub_upload_document`           | Upload a local file through authenticated multipart `POST /documents`.         | local session, `filePath`, `title`, `documentType` | document id, status, labels, processing run status |
| `enterprise_hub_get_document_status`       | Read upload/processing status through `GET /documents/:id/status`.             | local session, `documentId`                        | id, status, labels, processing run status          |
| `enterprise_hub_search_documents`          | Search visible active documents through `GET /documents`.                      | local session                                      | documents and `nextCursor`                         |
| `enterprise_hub_get_document`              | Read accessible active document metadata through `GET /documents/:id`.         | local session, `documentId`                        | document metadata or API not-found error           |
| `enterprise_hub_get_document_download_url` | Get an accessible download URL through `GET /documents/:id/download`.          | local session, `documentId`                        | id and `downloadUrl`                               |
| `enterprise_hub_archive_document`          | Archive a document through `POST /documents/:id/archive`.                      | local session, `documentId`                        | archived document metadata or API error            |
| `enterprise_hub_list_skills`               | List approved Skill Directory entries through `GET /skills`.                   | local session                                      | approved skill metadata and instructions only      |

Day 1 defines these deterministic tool names, descriptions, input schemas, and result shapes. Day 2 implements local-development login/session handling only. Document, label, archive, and skill tool bodies that call the API are implemented in later Phase 2 days.

### `enterprise_hub_login_dev`

Local-development only. Calls `POST /auth/dev-login` on `ENTERPRISE_HUB_API_URL` and stores the returned bearer token in the ignored MCP session file.

Request:

```json
{
  "email": "baoli.manager@example.com",
  "sessionName": "baoli"
}
```

Response:

```json
{
  "employee": {
    "id": "emp_baoli_manager",
    "email": "baoli.manager@example.com",
    "role": "manager",
    "disabled": false,
    "labels": ["all_staff", "person:baoli.manager", "store:baoli"]
  },
  "sessionName": "baoli",
  "apiUrl": "http://127.0.0.1:3000",
  "profile": "local-development"
}
```

Unknown or disabled employees return the API error body as an MCP error result, for example:

```json
{
  "error": {
    "code": "EMPLOYEE_NOT_FOUND",
    "message": "Employee not found."
  }
}
```

Session-required MCP error before Day 3 tool bodies run:

```json
{
  "error": {
    "code": "MCP_SESSION_REQUIRED",
    "message": "Run enterprise_hub_login_dev first or pass sessionName for an existing local MCP session."
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

## Local CLI Smoke Interface

The local CLI is a thin smoke client over the HTTP API. It does not implement its own permission filtering, does not execute skills, and does not become an employee-facing AI agent. All document visibility still comes from the authenticated API responses.

Run commands through npm:

```bash
npm run hub -- login --email baoli.manager@example.com
npm run hub -- documents upload ./fixtures/baoli-june-meituan.csv --label store:baoli
npm run hub -- documents search "保利店 美团"
```

Optional environment variables:

| Variable               | Default                      | Notes                                                               |
| ---------------------- | ---------------------------- | ------------------------------------------------------------------- |
| `HUB_API_URL`          | `http://127.0.0.1:3000`      | API base URL used by CLI commands.                                  |
| `HUB_CLI_SESSION_FILE` | `.data/hub-cli/session.json` | Local ignored token session file. The CLI does not print the token. |

### `hub login`

Stores a development token in the local ignored session file. The token is not printed to stdout.

Example output:

```json
{
  "ok": true,
  "apiUrl": "http://127.0.0.1:3000",
  "employee": {
    "id": "emp_baoli_manager",
    "email": "baoli.manager@example.com",
    "role": "manager",
    "labels": ["all_staff", "person:baoli.manager", "store:baoli"]
  },
  "sessionFile": ".data/hub-cli/session.json"
}
```

### `hub documents upload`

Uploads a file through `POST /documents`. `--title` defaults to the file name and `--type` defaults to `raw_material`.

```bash
npm run hub -- documents upload ./fixtures/baoli-june-meituan.csv --label store:baoli
```

### `hub documents search`

Searches active accessible documents through `GET /documents`.

```bash
npm run hub -- documents search "保利店 美团"
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

## Local MVP Integration Demo

Run the full local MVP loop with:

```bash
MYSQL_PORT=3307 npm run test:integration
```

The script starts local MySQL, resets and seeds the local development database, starts the API on a local port, uses the CLI to log in and upload `fixtures/baoli-june-meituan.csv`, runs one worker pass, verifies Baoli manager search can see the active document, verifies Suzhou manager search cannot see it, downloads it as Baoli manager, archives it, and verifies ordinary search no longer returns it.

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

### `GET /labels`

Lists the existing label catalog for authenticated employees, CLIs, MCP clients, APIs, and employee-owned agents that need controlled label selection. This endpoint is read-only and does not grant assignment rights. Upload and document-label mutation endpoints still enforce backend authorization before labels can be applied.

Request headers:

```http
Authorization: Bearer <jwt>
```

Response `200`:

```json
{
  "labels": [
    {
      "key": "all_staff",
      "name": "All Staff",
      "type": "all_staff"
    },
    {
      "key": "person:baoli.manager",
      "name": "Baoli Manager Personal",
      "type": "personal"
    },
    {
      "key": "store:baoli",
      "name": "Baoli Store",
      "type": "store"
    }
  ]
}
```

The response intentionally omits internal label ids. Labels are ordered by `type` then `key`.

Unauthenticated response `401`:

```json
{
  "error": {
    "code": "UNAUTHENTICATED",
    "message": "Authentication is required."
  }
}
```
