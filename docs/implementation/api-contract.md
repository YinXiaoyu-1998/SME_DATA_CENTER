# 企业资料中枢 API Contract

This contract is intentionally skeletal for Phase 1 / Day 0. It records the planned P0 surface and initial response shapes without implementing business behavior.

## Cross-Cutting Rules

- All non-health endpoints require an authenticated employee context.
- The backend must enforce employee-account permissions and active-state filtering.
- Ordinary employee queries must not reveal inaccessible document existence, titles, filenames, counts, or summaries.
- API tokens, CLI clients, MCP servers, and web clients inherit employee permissions.

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
    "labels": ["all_staff", "person:admin"]
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
    "labels": ["all_staff", "person:admin"]
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
