---
name: enterprise-hub-mcp
description: Use when connecting Codex or another MCP client to 企业资料中枢, initializing the enterprise-hub MCP configuration, authenticating seeded local employees, uploading Phase 3 evidence documents or structured datasets, searching evidence chunks, querying structured datasets, checking import/index status, or preparing staging/production profiles without inventing infrastructure details.
---

# 企业资料中枢 MCP

## Product Boundary

企业资料中枢 is a retrieval and data foundation for employee-owned agents. The MCP server is only an adapter over the HTTP API.

It must not:

- answer employee questions directly;
- generate reports, dashboards, business conclusions, or charts;
- execute Skill Directory entries;
- bypass API authorization by reading MySQL, Qdrant, or storage directly;
- expose raw SQL or mutation operations through structured query.

The service surface is Phase 3-only:

- unstructured evidence: `upload_evidence_document` → indexing → `get_evidence_document_status` / `search_document_evidence`;
- structured data: `upload_structured_dataset` → MySQL import → `get_import_status` / `list_structured_datasets` / `query_structured_dataset`.

There is no generic document upload/search/detail/download/archive flow.

## Profiles

| Profile             | Status      | Connection                                                  | Auth                                                 |
| ------------------- | ----------- | ----------------------------------------------------------- | ---------------------------------------------------- |
| `local-development` | implemented | local stdio MCP adapter connected to an already-running API | seeded employee email via `enterprise_hub_login_dev` |
| `staging-remote`    | placeholder | future deployed MCP/API endpoint                            | future employee-bound auth/token flow                |
| `production`        | placeholder | future production MCP/API endpoint                          | future production employee auth/token policy         |

For `staging-remote` and `production`, do not invent URLs, credentials, token flows, domains, TLS settings, or service accounts. Ask the user for approved configuration when it is missing.

## Connection Rules

Normal upload, search, status, and query work must only use exposed MCP tools.

Do not start, stop, initialize, repair, seed, migrate, or otherwise operate the API, worker, Docker, MySQL, Qdrant, storage, or any background service. The skill may configure and start only the MCP stdio adapter process needed by the MCP client.

Do not fall back to service-management scripts, curl, direct API calls, database reads, or storage reads when MCP tools fail. Report that the 企业资料中枢 service is unavailable or not connected, and direct service operators to the main service repository documentation.

## Initialize A Local MCP Client

Only do this when the user explicitly asks to connect or initialize Enterprise Hub MCP.

1. Obtain an approved `ENTERPRISE_HUB_API_URL` for an already-running Enterprise Hub API. The API, worker, database, storage, and Qdrant must be provisioned and operated outside this skill.
2. Locate the Enterprise Hub repository root containing the MCP adapter. The local default is `/Users/xiaoyuyin/Desktop/YXY_DEV/SME_DATA_CENTER`.
3. For Codex Desktop, update `~/.codex/config.toml`:

   ```toml
   [mcp_servers.enterprise-hub]
   command = "bash"
   args = ["-lc", "cd /path/to/SME_DATA_CENTER && npm run --silent mcp:dev"]
   startup_timeout_sec = 120

   [mcp_servers.enterprise-hub.env]
   ENTERPRISE_HUB_API_URL = "https://approved-enterprise-hub-api.example"
   ENTERPRISE_HUB_MCP_PROFILE = "local-development"
   ENTERPRISE_HUB_MCP_SESSION_FILE = "/path/to/SME_DATA_CENTER/.data/enterprise-hub-mcp/session.json"
   ```

4. `mcp:dev` starts only the MCP stdio adapter. It requires the configured API to already be reachable and must not be replaced with a command that starts service components.
5. Preserve other MCP servers, plugin config, project trust settings, and user preferences.
6. Never write production credentials, API keys, passwords, or bearer tokens into config.
7. Tell the user to restart Codex or open a fresh thread after config changes so MCP tools and this skill reload.

Generic MCP clients use the same command shape:

```json
{
  "command": "npm",
  "args": ["run", "--silent", "mcp:dev"],
  "cwd": "/path/to/SME_DATA_CENTER",
  "env": {
    "ENTERPRISE_HUB_API_URL": "https://approved-enterprise-hub-api.example",
    "ENTERPRISE_HUB_MCP_PROFILE": "local-development",
    "ENTERPRISE_HUB_MCP_SESSION_FILE": ".data/enterprise-hub-mcp/session.json"
  }
}
```

## Standard Workflow

1. **Login / session**
   - For local development, call `enterprise_hub_login_dev` with a seeded employee email such as `baoli.manager@example.com` and a stable `sessionName`.
   - Do not print raw tokens or inspect the session file.

2. **Labels**
   - Call `enterprise_hub_list_labels` before uploads.
   - Use only label keys returned by the service. Do not invent labels.

3. **Evidence upload**
   - For MD/TXT/DOCX, call `upload_evidence_document`.
   - Required: `filePath`, `title`, non-empty `labelKeys`.
   - Optional: `sourceSystem`.
   - Upload success only means the service accepted the file and queued/ran indexing. Use `get_evidence_document_status` before claiming evidence is searchable.

4. **Evidence status**
   - Call `get_evidence_document_status` with `documentId`.
   - Treat evidence as searchable only when the document is active and the index status is ready.
   - If status is pending/processing/failed, report the exact service status. Do not run local worker commands during normal MCP usage.

5. **Evidence search**
   - Call `search_document_evidence` with the query already chosen by the calling agent.
   - Return chunks, source metadata, retrieval config/version, and warnings as service evidence.
   - Do not synthesize the final answer; final reasoning belongs to the calling agent.
   - If the result is empty or inaccessible, say there is no visible evidence. Do not imply hidden documents exist.

6. **Structured upload**
   - For XLSX/CSV, call `upload_structured_dataset`.
   - Supported `dataset` values: `dishes`, `business`.
   - Required: `dataset`, `enterpriseName`, `startDate`, `endDate`, `idempotencyKey`, non-empty `labelKeys`.
   - Dates are business-day windows in `YYYYMMDD`.
   - The service performs strict structure validation, date-window validation, atomic import, idempotency checks, active-window conflict checks, storage, and authorization.
   - The MCP client must not parse spreadsheets, rewrite headers, or bypass import rules.

7. **Structured import status**
   - Call `get_import_status` with `importBatchId`.
   - Treat not-found/inaccessible as not visible. Do not reveal hidden source filenames, row counts, or batch existence.

8. **Structured query**
   - Call `list_structured_datasets` before constructing a query.
   - Call `query_structured_dataset` with the controlled JSON query schema exposed by the service.
   - Never send SQL, raw expressions, natural-language-to-query instructions, joins, window functions, formulas, deletes, updates, inserts, or DDL.
   - Return data rows and explicitly requested mechanical aggregates only. Do not add business logic or analysis not present in the query.

9. **Skill Directory**
   - Call `enterprise_hub_list_skills` only to read approved skill metadata and instructions.
   - Do not execute skills as part of this skill.

## Current MCP Tools

- `enterprise_hub_login_dev`
- `enterprise_hub_list_labels`
- `enterprise_hub_list_skills`
- `upload_evidence_document`
- `get_evidence_document_status`
- `search_document_evidence`
- `upload_structured_dataset`
- `get_import_status`
- `list_structured_datasets`
- `query_structured_dataset`

## Permission Isolation Check

For local validation:

1. Login as `baoli.manager@example.com` with session `baoli`.
2. Upload evidence or structured data with `store:baoli`.
3. Verify Baoli can retrieve/query it through the Phase 3 tools.
4. Login as `suzhou.manager@example.com` with session `suzhou`.
5. Search/query the same content.

Expected: Suzhou receives no visible evidence/data and no hidden title, filename, row count, source metadata, or existence leak.

## Safety Rules

- All non-health data access must go through MCP tools and backend HTTP API authorization.
- Do not bypass the API with direct DB/storage/Qdrant reads.
- Do not expose raw bearer tokens, session files, production credentials, service account material, or secrets.
- Do not ask for production passwords in local development.
- Do not upload real customer exports, third-party downloaded data, or company confidential files unless the user explicitly authorizes that exact file.
- Do not claim inaccessible resources exist.
- Do not turn Enterprise Hub into a direct employee-facing agent, report generator, dashboard service, or skill execution platform.

## Failure Handling

| Symptom                                      | Response                                                                         |
| -------------------------------------------- | -------------------------------------------------------------------------------- |
| MCP tools are not exposed                    | Report that Enterprise Hub MCP is not connected; do not fall back to CLI/API.    |
| Tool call connection fails                   | Report that the service is unavailable; do not start or repair services.         |
| `EMPLOYEE_NOT_FOUND`                         | Report that the current service has no such employee identity.                   |
| `MCP_SESSION_REQUIRED`                       | Call `enterprise_hub_login_dev` for the intended `sessionName`.                  |
| Evidence upload succeeds but search is empty | Check `get_evidence_document_status`; report exact status if index is not ready. |
| Import upload fails validation               | Return the validation errors from the service; do not rewrite the file locally.  |
| Cross-store data is invisible                | Treat as expected permission isolation unless the API leaks hidden metadata.     |
