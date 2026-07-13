# 企业资料中枢 Test Cases

Last updated: 2026-07-13

This file records the active verification matrix. Historical Phase 1/2 ordinary document upload/search tests are no longer current because that public surface has been removed.

## Required Repository Checks

| Check             | Command                                    | Expected                                          |
| ----------------- | ------------------------------------------ | ------------------------------------------------- |
| Format            | `npm run format:check`                     | No Prettier diffs                                 |
| Lint              | `npm run lint`                             | No ESLint failures                                |
| Typecheck         | `npm run typecheck`                        | TypeScript compiles with no emit                  |
| Unit tests        | `npm test`                                 | All Vitest suites pass                            |
| Local integration | `MYSQL_PORT=3307 npm run test:integration` | Phase 3 API + worker path passes                  |
| MCP smoke         | `MYSQL_PORT=3307 npm run test:mcp`         | Phase 3 MCP path passes                           |
| Golden retrieval  | `npm run test:phase3:golden`               | Deterministic synthetic retrieval thresholds pass |
| Perf smoke        | `npm run test:phase3:perf`                 | Deterministic local thresholds pass               |

## Active Phase 3 API / Worker Cases

| Case                                     | Test / Command                                                          | Expected                                                                                                               |
| ---------------------------------------- | ----------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| Evidence upload accepts MD/TXT/DOCX only | `npm test -- apps/api/src/server.test.ts`                               | Creates source document, labels, storage object, audit, and `evidence_document_index` processing run                   |
| Evidence status authorization            | `npm test -- apps/api/src/server.test.ts`                               | Uploader/admin can read `GET /v1/documents/evidence/:documentId/status`; other employees receive non-leaking not-found |
| Evidence indexing worker                 | `npm test -- apps/worker/src/worker.test.ts`                            | Worker parses, chunks, embeds/indexes, records ready document index, and activates document                            |
| Unsupported worker job type              | `npm test -- apps/worker/src/worker.test.ts`                            | Unknown job type fails explicitly with `UNSUPPORTED_PROCESSING_JOB_TYPE`; no fallback text extraction                  |
| Evidence search permission filtering     | `npm test -- apps/api/src/evidence.test.ts apps/api/src/server.test.ts` | Search returns only visible active indexed chunks and does not leak inaccessible evidence                              |
| Structured import validation             | `npm test -- apps/api/src/server.test.ts`                               | CSV/XLSX imports require supported `dishes`/`business` structure and reject whole file on validation failure           |
| Structured import atomicity              | `npm test -- apps/api/src/server.test.ts`                               | Invalid rows/sheets create no partial dataset rows                                                                     |
| Structured import status authorization   | `npm test -- apps/api/src/server.test.ts`                               | Only authorized employees can see import status                                                                        |
| Structured query compiler limits         | `npm test -- apps/api/src/structured-query*.test.ts`                    | Only controlled read-only fields/operators/aggregates/sort/pagination are accepted                                     |
| Archived source docs excluded            | `npm test -- apps/api/src/server.test.ts`                               | Rows remain stored but inactive/archived source documents are not queryable                                            |

## Active MCP Cases

| Case                          | Test / Command                                        | Expected                                                                                    |
| ----------------------------- | ----------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| Tool list is Phase 3-only     | `npm test -- apps/mcp-server/src/tools.test.ts`       | Current tools include evidence/structured tools and exclude removed ordinary document tools |
| Session required              | `npm test -- apps/mcp-server/src/auth.test.ts`        | Non-login tools require a stored MCP session                                                |
| Evidence status tool          | `npm test -- apps/mcp-server/src/tool-bodies.test.ts` | `get_evidence_document_status` calls the Phase 3 evidence status endpoint                   |
| Evidence search tool          | `npm test -- apps/mcp-server/src/tool-bodies.test.ts` | `search_document_evidence` sends only controlled evidence search payloads                   |
| Structured import/query tools | `npm test -- apps/mcp-server/src/tool-bodies.test.ts` | Structured tools call import/status/schema/query endpoints without SQL                      |
| Local MCP smoke               | `MYSQL_PORT=3307 npm run test:mcp`                    | Login, label list, structured import/status/query, evidence upload/status/search all pass   |

## Legacy Removal Negative Cases

| Case                       | Test / Command                                  | Expected                                                    |
| -------------------------- | ----------------------------------------------- | ----------------------------------------------------------- |
| Removed HTTP routes absent | `npm test -- apps/api/src/server.test.ts`       | Legacy ordinary document routes return 404                  |
| Removed MCP tools absent   | `npm test -- apps/mcp-server/src/tools.test.ts` | Removed ordinary document tool names are not exposed        |
| CLI package absent         | `rg "hub documents" . --glob '!node_modules'`   | No active command/docs/tests reference the removed CLI flow |
| Worker fallback absent     | `npm test -- apps/worker/src/worker.test.ts`    | No legacy text-extraction fallback path remains             |

The removed route/tool names may appear only in negative tests, migration/removal notes, or historical cleanup records.

## Local Phase 3 Integration Smoke

`MYSQL_PORT=3307 npm run test:integration` should prove:

1. local MySQL and Qdrant start;
2. migrations and seed apply;
3. API starts on an available port;
4. `baoli.manager@example.com` can login;
5. structured `dishes` fixture imports and can be queried;
6. evidence markdown fixture uploads;
7. worker indexes evidence into Qdrant;
8. evidence status becomes ready;
9. evidence search returns the indexed chunk.

## Data And Secret Safety

- Tests use synthetic fixtures and fake model providers by default.
- Real customer exports, `.env`, API keys, bearer tokens, and service account keys must not be committed.
- External model provider tests require explicit env configuration and egress acknowledgement.
