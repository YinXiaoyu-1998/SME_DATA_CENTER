# Phase 2 Day 4 Local MCP Human Test

This guide is for local human testing of the Phase 2 MCP adapter with Codex or another local MCP-capable employee-owned agent. It proves the local agent interaction path without turning 企业资料中枢 into a direct employee-facing AI agent.

## Scope

Use only the local-development profile:

- Local MySQL from Docker Compose.
- Local API backed by seeded development data.
- Local filesystem storage under ignored `.data/`.
- Local MCP stdio server pointed at the local API.
- Synthetic fixture files from `fixtures/`.

Do not require or request Aliyun OSS, online MySQL, production credentials, staging credentials, real company documents, downloaded third-party data, or customer exports for this test.

The MCP server is only an adapter over the HTTP API. It must not direct-read MySQL or storage, must not filter permissions client-side, and must not claim that inaccessible documents exist. When Suzhou cannot access a Baoli document, the correct result is "not found/no visible results", not "the document exists but you cannot see it."

## Local Setup

From the repository root:

```sh
npm install
MYSQL_PORT=3307 docker compose up -d mysql
DATABASE_URL='mysql://enterprise_hub:enterprise_hub_local_password@localhost:3307/enterprise_hub' npm run db:generate
DATABASE_URL='mysql://enterprise_hub:enterprise_hub_local_password@localhost:3307/enterprise_hub' npm run db:seed
```

Start the API in one terminal:

```sh
DATABASE_URL='mysql://enterprise_hub:enterprise_hub_local_password@localhost:3307/enterprise_hub' \
STORAGE_DRIVER=local \
LOCAL_STORAGE_ROOT=.data/storage \
JWT_SECRET=replace-with-local-development-secret \
PORT=3000 \
npm run api:dev
```

Configure the MCP client to launch the local server with:

```sh
ENTERPRISE_HUB_API_URL=http://127.0.0.1:3000 \
ENTERPRISE_HUB_MCP_PROFILE=local-development \
ENTERPRISE_HUB_MCP_SESSION_FILE=.data/enterprise-hub-mcp/session.json \
npm run mcp:dev
```

If the Day 4 MCP smoke script is available, run it after setup:

```sh
MYSQL_PORT=3307 npm run test:mcp
```

Expected smoke result: the script logs in through MCP, uploads the Baoli fixture, runs the worker path, proves Baoli can find/download/archive the active document, and proves Suzhou cannot find the Baoli document.

## Copy-Paste Codex Prompts

Use these prompts in a Codex thread where the local `enterprise-hub-mcp` server is configured.

If the repository skill is available, start a fresh thread with:

```text
Use $enterprise-hub-mcp with the local-development profile to run the local 企业资料中枢 MCP human-test flow. Do not print raw tokens, do not ask for production credentials, and do not claim inaccessible documents exist.
```

### 1. Connection And Label Catalog

```text
Use the local enterprise-hub MCP server. Log in with enterprise_hub_login_dev as baoli.manager@example.com using sessionName "baoli". Then call enterprise_hub_list_labels with sessionName "baoli". Do not print any bearer token or session file contents.
```

Expected result:

- Login returns employee `baoli.manager@example.com` with labels including `store:baoli` and `person:baoli.manager`.
- Label listing includes `store:baoli`, `store:suzhou`, personal labels, and `all_staff` with `key`, `name`, and `type`.
- No raw API token is shown.

### 2. Upload A Synthetic Baoli Fixture

```text
Using sessionName "baoli", upload ./fixtures/baoli-june-meituan.csv with enterprise_hub_upload_document. Use title "Phase 2 Day 4 Baoli MCP Human Test", documentType "raw_material", sourceSystem "meituan", sourceTime "2026-06-30T00:00:00.000Z", and labelKeys ["store:baoli"]. Return the new document id and current status only.
```

Expected result:

- Upload returns a new document id.
- Status is `pending_processing`.
- Labels include `store:baoli` and `person:baoli.manager`.
- The agent uses the fixture file only; it does not ask for real documents.

### 3. Run Worker And Confirm Active Status

Run this command in the repository root:

```sh
DATABASE_URL='mysql://enterprise_hub:enterprise_hub_local_password@localhost:3307/enterprise_hub' \
STORAGE_DRIVER=local \
LOCAL_STORAGE_ROOT=.data/storage \
npm run worker:once
```

Then ask Codex:

```text
Using sessionName "baoli", call enterprise_hub_get_document_status for document id "<DOC_ID_FROM_UPLOAD>". Tell me whether the document is active. If it is not active yet, report only the exact status and processingRunStatus; do not invent availability.
```

Expected result:

- After a successful worker pass, status becomes `active`.
- Before the worker pass, status may still be `pending_processing` or `processing`; that means the document is not yet available for ordinary search.
- If processing fails, the agent reports the exact failure state and does not claim the document is searchable.

### 4. Baoli Search, Detail, And Download URL

```text
Using sessionName "baoli", search documents with enterprise_hub_search_documents using q "Baoli MCP Human Test" and labelKey "store:baoli". If the uploaded document is visible, fetch its metadata with enterprise_hub_get_document and its download URL with enterprise_hub_get_document_download_url. Return the visible document title, status, labels, and download URL.
```

Expected result:

- Search returns the uploaded document only after it is `active`.
- Detail returns metadata for the same document id.
- Download returns a local `file://` URL.
- Results include only API-visible active documents.

### 5. Suzhou Permission Isolation

```text
Log in with enterprise_hub_login_dev as suzhou.manager@example.com using sessionName "suzhou". Then search documents with enterprise_hub_search_documents using sessionName "suzhou" and q "Baoli MCP Human Test". Also try enterprise_hub_get_document for the Baoli document id "<DOC_ID_FROM_UPLOAD>". Do not assert that the hidden document exists; report only what the API makes visible to Suzhou.
```

Expected result:

- Suzhou login returns `suzhou.manager@example.com` with `store:suzhou`.
- Search returns no Baoli document.
- Detail returns the API not-found/inaccessible shape, such as `DOCUMENT_NOT_FOUND`.
- The agent must not say "there is a Baoli document but Suzhou lacks permission." It may say "Suzhou has no visible matching document."

### 6. Archive And Verify Ordinary Search Hides It

```text
Using sessionName "baoli", archive document id "<DOC_ID_FROM_UPLOAD>" with enterprise_hub_archive_document. Then search again with enterprise_hub_search_documents using q "Baoli MCP Human Test" and labelKey "store:baoli". Report whether ordinary search still returns the archived document.
```

Expected result:

- Archive returns the document with status `archived`.
- Ordinary MCP search no longer returns the document.
- The local storage object is not physically deleted by this test.

### 7. Skill Directory Sanity Check

```text
Using sessionName "baoli", call enterprise_hub_list_skills. Summarize the approved skill keys and categories only. Do not execute any skill, generate a report, or analyze uploaded document contents.
```

Expected result:

- The response lists approved skill metadata and instructions only.
- The agent does not run a report generator or skill execution workflow.

## Failure Triage

| Symptom                                                                          | Likely Cause                                                                       | What To Check                                                           | Expected Fix                                                                                                  |
| -------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- | ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| MCP startup fails with missing `ENTERPRISE_HUB_API_URL`.                         | MCP server was launched without the required local API URL.                        | MCP client command/config.                                              | Launch with `ENTERPRISE_HUB_API_URL=http://127.0.0.1:3000 npm run mcp:dev`.                                   |
| MCP tool calls fail with connection refused or fetch errors.                     | API is not running or is on a different port.                                      | `curl http://127.0.0.1:3000/healthz`; API terminal logs.                | Start `npm run api:dev` with the same port used by `ENTERPRISE_HUB_API_URL`.                                  |
| Login returns `EMPLOYEE_NOT_FOUND`.                                              | MySQL was not seeded or the wrong database/port is being used.                     | `MYSQL_PORT`, `DATABASE_URL`, and `npm run db:seed` output.             | Start local MySQL on the expected port and rerun `db:generate` and `db:seed`.                                 |
| Upload succeeds but search does not find the document.                           | Worker has not activated the uploaded document yet.                                | `enterprise_hub_get_document_status` for the uploaded id.               | Run `npm run worker:once`; search only after status is `active`.                                              |
| Tool returns `MCP_SESSION_REQUIRED`.                                             | The named local MCP session does not exist or the session file path changed.       | `sessionName`, `ENTERPRISE_HUB_MCP_SESSION_FILE`, and prior login step. | Run `enterprise_hub_login_dev` again for that `sessionName`. Do not inspect or print token contents.          |
| Suzhou cannot see Baoli upload.                                                  | Correct permission isolation, not a failure.                                       | Search result count and `DOCUMENT_NOT_FOUND` from detail.               | Record pass if no Baoli title, filename, summary, or count leaks to Suzhou.                                   |
| Baoli cannot archive the uploaded document.                                      | Wrong session, wrong document id, inactive/nonexistent document, or API rejection. | Confirm uploader session is `baoli`; check status/detail as Baoli.      | Retry with the uploaded id and Baoli session. Preserve API error codes if still rejected.                     |
| Agent says a hidden Baoli document exists for Suzhou.                            | Unsafe interpretation by the human-test agent.                                     | Prompt wording and tool output.                                         | Correct the agent: inaccessible documents must be treated as not visible, and existence must not be asserted. |
| Test flow asks for OSS, online MySQL, production credentials, or real documents. | Out-of-scope setup drift.                                                          | Prompt and local setup commands.                                        | Stop that path and use only local Docker MySQL, local API, local storage, dev login, and synthetic fixtures.  |

## Acceptance Checklist

- [ ] Baoli local MCP session logs in without exposing a raw token.
- [ ] MCP label listing returns controlled catalog labels.
- [ ] Baoli uploads `fixtures/baoli-june-meituan.csv` with `store:baoli`.
- [ ] Worker pass moves the uploaded document to `active`.
- [ ] Baoli MCP search, detail, and download URL can access the active document.
- [ ] Suzhou MCP search/detail cannot discover the Baoli document.
- [ ] Baoli archives the document.
- [ ] Ordinary MCP search no longer returns the archived document.
- [ ] The agent does not execute skills, generate reports, or analyze document contents beyond returning API/MCP results.
- [ ] The flow uses no OSS, online MySQL, production credentials, real documents, customer exports, or downloaded third-party data.
