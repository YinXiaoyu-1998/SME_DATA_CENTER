---
name: enterprise-hub-mcp
description: Use when connecting an employee-owned agent to 企业资料中枢 through MCP, testing the local-development MCP profile, authenticating seeded local employees, uploading/searching/archiving documents, checking permission isolation, or preparing future staging/production MCP profile usage without inventing infrastructure details.
---

# Enterprise Hub MCP

## Purpose

Use 企业资料中枢 as an MCP-backed service for employee-owned agents. The MCP server is only an adapter over the HTTP API: it must not direct-read MySQL or storage, implement client-side permission filtering, execute Skill Directory entries, or behave like an employee-facing AI agent.

## Profiles

| Profile             | Status      | Connection                                            | Auth                                                  |
| ------------------- | ----------- | ----------------------------------------------------- | ----------------------------------------------------- |
| `local-development` | Implemented | Local stdio command backed by a local API URL         | `enterprise_hub_login_dev` with seeded employee email |
| `staging-remote`    | Placeholder | Future remote MCP endpoint or deployed command config | Future employee-bound staging auth/token flow         |
| `production`        | Placeholder | Future production MCP endpoint                        | Future production employee auth/token policy          |

For `staging-remote` and `production`, do not invent URLs, credentials, token flows, domains, TLS settings, or service accounts. Stop and ask for approved configuration.

## Local Setup Checks

Before using MCP tools in `local-development`:

1. Confirm the local API is running and reachable at the configured `ENTERPRISE_HUB_API_URL`.
2. Confirm the MCP client launches `npm run mcp:dev` with `ENTERPRISE_HUB_API_URL` and optional `ENTERPRISE_HUB_MCP_SESSION_FILE`.
3. Confirm local seed data exists before logging in as seeded employees.
4. Confirm the selected employee session by calling `enterprise_hub_login_dev`, then `enterprise_hub_list_labels`.

Use the repository docs for setup commands:

- `AGENTS.md` for local commands.
- `docs/implementation/local-agent-test.md` for the full human-test loop.

## Operating Flow

1. **Login/select session**
   - Local only: call `enterprise_hub_login_dev` with a seeded email such as `baoli.manager@example.com` and a `sessionName`.
   - Do not print raw tokens or inspect the session file contents.

2. **List labels**
   - Call `enterprise_hub_list_labels` before upload.
   - Use label keys from the API response; do not invent labels.

3. **Upload**
   - Call `enterprise_hub_upload_document` with a local `filePath`, `title`, `documentType`, optional source metadata, and existing `labelKeys`.
   - In local human tests, prefer synthetic fixtures such as `fixtures/baoli-june-meituan.csv`.
   - Do not request real company documents unless the human explicitly authorizes that data for testing.

4. **Process/status**
   - Call `enterprise_hub_get_document_status` after upload.
   - If status is not `active`, report the exact status and do not claim the document is searchable.
   - For local testing, the human or harness may run `npm run worker:once`; the MCP tools do not run the worker directly.

5. **Search/detail/download**
   - Call `enterprise_hub_search_documents` for visible active documents.
   - Fetch details with `enterprise_hub_get_document` only for visible/known document ids.
   - Fetch download URLs with `enterprise_hub_get_document_download_url`.
   - Treat API not-found/inaccessible results as not visible. Do not state that a hidden document exists.

6. **Archive**
   - When requested by an uploader/admin, call `enterprise_hub_archive_document`.
   - Verify ordinary search no longer returns the archived document.

7. **Skill Directory**
   - Call `enterprise_hub_list_skills` only to read approved metadata and instructions.
   - Do not execute skills, generate reports, or analyze document content as part of this skill.

## Permission Isolation Test

For local validation:

1. Login as Baoli with session `baoli`.
2. Upload and activate a Baoli-labeled fixture.
3. Verify Baoli search can find it.
4. Login as Suzhou with session `suzhou`.
5. Search the same query as Suzhou.
6. Try detail access for the Baoli document id as Suzhou.

Expected result: Suzhou sees no matching Baoli document, and detail returns the API not-found/inaccessible shape without leaking title, filename, count, summary, or existence.

## Safety Rules

- All non-health data access must go through MCP tools and the HTTP API.
- Never bypass API authorization with direct DB/storage reads.
- Never expose raw bearer tokens, session files, production credentials, service account material, or secrets.
- Never ask for production passwords in `local-development`.
- Never claim inaccessible documents exist.
- Never convert 企业资料中枢 into a report generator, dashboard service, skill execution platform, or employee-facing AI agent.
- Never upload real customer exports, downloaded third-party data, or real company documents unless the human explicitly authorizes that exact test data.

## Failure Handling

| Symptom                                              | Action                                                                       |
| ---------------------------------------------------- | ---------------------------------------------------------------------------- |
| MCP startup says `ENTERPRISE_HUB_API_URL` is missing | Ask the human to configure the local MCP command with the API URL.           |
| Tool calls cannot connect                            | Check whether the local API is running on the same URL.                      |
| Login returns `EMPLOYEE_NOT_FOUND`                   | Ask the human to seed the local DB or verify the configured DB/port.         |
| Tool returns `MCP_SESSION_REQUIRED`                  | Run `enterprise_hub_login_dev` for the intended `sessionName`.               |
| Upload works but search is empty                     | Check status; run/request one local worker pass; search only after `active`. |
| Suzhou cannot see Baoli data                         | Treat as expected isolation unless hidden titles/counts leak.                |
