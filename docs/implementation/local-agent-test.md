# Local Agent Test: Phase 3 MCP Flow

Last updated: 2026-07-13

This human test verifies that a generic agent using `$enterprise-hub-mcp` can interact with Enterprise Hub through the current Phase 3 MCP tools. It does not use removed ordinary document upload/search/detail/download/archive flows.

## Preconditions

From the repository root:

```sh
npm install
MYSQL_PORT=3307 npm run runtime:compose:up
DATABASE_URL='mysql://enterprise_hub:enterprise_hub_local_password@localhost:3307/enterprise_hub' npm run db:generate
DATABASE_URL='mysql://enterprise_hub:enterprise_hub_local_password@localhost:3307/enterprise_hub' npm run db:migrate
DATABASE_URL='mysql://enterprise_hub:enterprise_hub_local_password@localhost:3307/enterprise_hub' npm run db:seed
npm run qdrant:init
```

Configure the MCP client to run:

```json
{
  "command": "npm",
  "args": ["run", "--silent", "mcp:launcher"],
  "cwd": "/Users/xiaoyuyin/Desktop/YXY_DEV/SME_DATA_CENTER",
  "env": {
    "ENTERPRISE_HUB_BASE_URL": "http://127.0.0.1:3000"
  }
}
```

Restart the MCP client or open a fresh agent thread after config changes.

## Agent Prompt: Evidence Flow

Use this prompt in a fresh generic agent thread:

```text
Use $enterprise-hub-mcp with the local-development profile.

Log in as baoli.manager@example.com using enterprise_hub_login_local.
List labels and use store:baoli.
Create or use a small local MD/TXT/DOCX evidence file about "差评处理 SOP".
Upload it with upload_evidence_document.
Poll get_evidence_document_status until the document is active and the index is ready, or report the exact status after a short wait.
Search evidence for "差评处理 SOP".
Return only the document id, index status, and the evidence chunks returned by the service. Do not generate a final business answer.
```

Expected:

- login succeeds;
- labels come from the service;
- evidence upload returns a document id;
- status eventually shows active/ready when the worker has indexed the document;
- search returns at least one visible evidence chunk for Baoli;
- the agent does not answer the employee question itself.

## Agent Prompt: Structured Flow

Use this prompt in a fresh generic agent thread:

```text
Use $enterprise-hub-mcp with the local-development profile.

Log in as baoli.manager@example.com using enterprise_hub_login_local.
List labels and use store:baoli.
Upload fixtures/structured/dishes-valid.csv as dataset "dishes" with enterpriseName "Baoli Local MCP", startDate "20260701", endDate "20260705", and a fresh idempotencyKey.
Check get_import_status.
Call list_structured_datasets.
Query dataset "dishes" for a row count using query_structured_dataset.
Return only the import batch id, status, schema summary needed for the query, and query rows. Do not generate sales analysis.
```

Expected:

- import applies atomically;
- import status is visible to Baoli;
- dataset schema discovery returns controlled fields/operators;
- structured query returns rows or explicitly requested mechanical aggregates;
- no SQL is sent by the agent.

## Agent Prompt: Permission Isolation

Use this after a Baoli evidence/structured upload exists:

```text
Use $enterprise-hub-mcp with the local-development profile.

Log in as suzhou.manager@example.com using enterprise_hub_login_local.
Search document evidence for the same Baoli query.
Run an equivalent structured query for the same Baoli dataset content if schema discovery allows it.
Report only what the service returns. Do not claim hidden Baoli documents or rows exist.
```

Expected:

- Suzhou sees no Baoli evidence or structured rows;
- hidden title, source filename, row count, source metadata, and existence are not leaked.

## Automated Equivalent

```sh
npm run test:mcp
```

The automated smoke verifies the launcher entrypoint, authenticated HTTP `/mcp`, and launcher-to-HTTP proxy behavior. Database/worker coverage remains in `npm run test:integration`.

## Failure Handling

| Symptom                               | Action                                                                                                        |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| MCP tools are missing                 | Re-check MCP client config and restart the client. Do not fall back to direct API/curl during the human test. |
| Login fails with `EMPLOYEE_NOT_FOUND` | Re-run seed against the same `DATABASE_URL` used by the API.                                                  |
| Evidence status stays pending         | Report the status. Service operators may run worker troubleshooting outside the skill/agent workflow.         |
| Structured import fails validation    | Return the service validation errors; do not edit the spreadsheet in the agent.                               |
| Cross-store data appears              | Treat as a security bug and stop the test.                                                                    |
