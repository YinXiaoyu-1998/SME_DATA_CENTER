# API Boundary And Contract Sync Design

Date: 2026-07-30
Status: approved by the product owner in the preceding review

## Problem

The API currently has three related hardening gaps:

1. Unhandled route and repository exceptions fall through Fastify's default error serialization, which can expose internal exception messages to authenticated clients.
2. Current-state documentation and the evidence API examples have drifted from deployed behavior and the actual response/storage contracts.
3. Equivalent inputs are bounded differently, or not bounded at all, across direct HTTP routes, MCP schemas, database columns, multipart parsing, structured-query compilation, and nginx.

The goal is to close these gaps without changing normal client workflows, successful response bodies, authentication behavior, or the employee-client service boundary.

## Chosen approach

Define one public input-boundary contract in the domain package, consume it from both HTTP and MCP validation, configure transport limits with enough encoding overhead, and install a final API error boundary.

This is preferred over independent per-layer patches because a shared contract makes future drift testable. It is intentionally smaller than introducing OpenAPI generation or replacing the existing route-validation style.

## Public input boundaries

The shared contract will use these limits:

| Input | Limit | Basis |
| --- | ---: | --- |
| Upload filename | 255 characters | Preserves the existing MCP boundary and common basename compatibility. |
| Evidence title | 512 characters | Matches `Document.title VARCHAR(512)`. |
| Evidence source system | 255 characters | Matches `Document.sourceSystem VARCHAR(255)`. |
| Structured enterprise name | 255 characters | Leaves safe room when it contributes to generated titles and filenames. |
| Idempotency key | 255 characters | Matches `ImportBatch.idempotencyKey VARCHAR(255)`. |
| Label key | 128 characters | Matches `Label.key VARCHAR(128)`. |
| Labels per request | 50 | Bounds authorization/catalog work while remaining well above normal usage. |
| Evidence query | 4,000 characters | Supports long natural-language questions while bounding retrieval/provider work. |
| Evidence filter identifier | 64 characters | Covers current IDs with headroom while bounding filter payloads. |
| Evidence filter identifiers per group | 100 | Bounds filter construction and authorization revalidation. |
| Cursor | 4,096 characters | Provides ample room for signed cursors while bounding decoding and verification. |
| Structured-query string scalar | 32,767 characters | Matches the maximum accepted structured cell value, so imported values remain queryable. |
| Multipart files | 1 | Both upload endpoints accept exactly one source file. |
| Multipart fields | 60 | Covers 50 labels, fixed metadata fields, and a small compatibility margin. |
| Multipart parts | 61 | One file plus the maximum field count. |

The existing decoded file-size limit remains 52,428,800 bytes (50 MiB). The existing MCP media-type limit remains 255 characters.

The structured-query scalar limit applies to user-provided string values such as filter values. Registry-controlled field, dataset, operator, sort, aggregate, and grouping rules retain their existing semantic validation and collection limits.

All relevant arrays must reject excess items rather than silently truncate them. String limits are measured with JavaScript/Zod string length consistently at the API and MCP boundaries; the database remains a final integrity boundary, not the primary validator.

## Transport sizing

nginx will set `client_max_body_size 72m`.

This preserves the 50 MiB decoded upload contract for both multipart HTTP uploads and MCP Base64/JSON uploads. Base64 expands 50 MiB to roughly 66.7 MiB before the JSON-RPC envelope; 72 MiB leaves bounded protocol overhead without materially increasing the accepted decoded file size.

Fastify multipart parsing will enforce one file, at most 60 fields, at most 61 total parts, and the existing 50 MiB file size. A second file or an exceeded multipart count is rejected, not ignored.

## Error contract

Install a final Fastify error handler after the existing route-specific handling:

- Existing explicit authentication, authorization, OAuth, MCP transport, cursor, structured-query, and business-validation responses remain unchanged.
- Malformed request syntax and schema/input violations return a sanitized `400` response with a stable public code.
- Request bodies or multipart uploads that exceed a size/count boundary return a sanitized `413` response with a stable public code.
- An unexpected exception is logged server-side with the exception object, request method, URL, and request ID, then returned as `500` without the original exception message or stack.

The fallback internal-error response is:

```json
{
  "error": {
    "code": "INTERNAL_ERROR",
    "message": "Internal server error.",
    "requestId": "<request-id>"
  }
}
```

The public request-validation codes introduced at the final boundary are:

- `INVALID_REQUEST` for malformed request syntax or an otherwise unclassified client-input failure;
- `PAYLOAD_TOO_LARGE` for body, file, field-count, file-count, or part-count limits.

Route-level validation should continue returning its more specific existing codes where available. Logging the original exception is required for diagnosis; serializing it to the client is forbidden.

## Validation placement

- The domain package owns exported immutable constants and low-level reusable schemas/helpers.
- The HTTP API applies the constants while parsing evidence upload, structured upload, evidence search, and structured-query input.
- The MCP contract applies the same constants in Zod schemas so clients fail locally before delegation when possible.
- nginx owns only encoded transport size. It must not redefine semantic string or collection limits.
- Prisma column sizes remain unchanged because the selected persistent-field limits already fit the schema.

Validation must occur before storage, repository, retrieval-provider, or structured-query execution. The change must not silently alter accepted values, coerce overlong values, or truncate labels/filters.

## Documentation synchronization

Update the public/current documentation to match code:

- Correct evidence upload and status response examples in `docs/implementation/api-contract.md`.
- Correct the documented original-object storage key to `org/<orgId>/documents/<documentId>/original/<safe-filename>`.
- Document the public input and upload boundaries in the API contract and repo-local MCP skill.
- Reconcile English and Chinese README current-state claims with the completed macOS official acceptance and the remaining Windows/OpenClaw gates.
- Reconcile the current section of `docs/implementation/progress.md` and remove stale branch/tag claims from planning documents.
- Keep exact immutable deployment tags in dated verification/readiness records rather than repeating a supposedly current tag across general documents.

Historical milestone records will not be rewritten.

## Dual-repository delivery

The main repository will contain the service, shared contract, tests, nginx, API documentation, and repo-local skill changes in one PR.

Because MCP behavior and its public contract change, the standalone `YinXiaoyu-1998/enterprise-hub-mcp-skill` repository will receive the byte-equivalent skill guidance update in a separate small PR. The two PRs will link to each other. This is required by the repository's dual-homed skill rule and was explicitly approved by the product owner.

## Test strategy

Implementation will follow red-green-refactor:

1. Add failing API tests proving a null/malformed request becomes a stable `400` rather than an internal exception.
2. Add a failing API test proving an injected provider/repository exception becomes generic `500` and its sensitive message is absent.
3. Add regression tests proving explicit authentication, OAuth/MCP transport, cursor, and structured-query errors retain their current contracts.
4. Add failing HTTP and MCP contract tests for every shared string/count boundary, including acceptance at the limit and rejection immediately above it.
5. Add multipart tests for file size, file count, field count, and part count with stable `413` responses.
6. Add a deployment-config test for nginx's 72 MiB body limit.
7. Add focused documentation/contract consistency checks where they can validate machine-readable facts without snapshotting prose.

After focused tests pass, run formatting, lint, typecheck, the full unit suite, integration tests, MCP smoke, and any existing repository contract checks required by the changed files.

## Compatibility and non-goals

Normal clients remain compatible: endpoints, authentication, MCP tool names, successful response shapes, the 50 MiB decoded upload allowance, and ordinary input values do not change.

Observable changes are limited to previously unbounded or invalid requests:

- over-limit inputs fail earlier and consistently;
- unexpected server failures no longer reveal internal messages;
- oversized encoded requests are admitted by nginx only when their decoded content remains within the API limit.

This work does not change database schema, retrieval ranking, worker behavior, authorization policy, deployment topology, employee-facing features, or historical release evidence.
