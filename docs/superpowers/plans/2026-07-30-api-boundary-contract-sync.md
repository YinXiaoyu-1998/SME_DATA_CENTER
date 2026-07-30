# API Boundary And Contract Sync Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a non-leaking API error boundary, enforce one shared public-input contract across HTTP/MCP/nginx/database-compatible fields, and reconcile current documentation with the implemented API.

**Architecture:** Add immutable public-boundary constants to the domain package and consume them from domain structured-query validation, MCP Zod schemas, and API route validation. Keep existing route-specific and MCP/OAuth errors intact, but add a final Fastify handler for sanitized malformed/oversized/internal errors. Update current-facing docs and both copies of the dual-homed MCP skill without rewriting historical release evidence.

**Tech Stack:** TypeScript, Fastify 5, `@fastify/multipart`, Zod, Vitest, Prisma schema, nginx, Markdown, GitHub CLI.

## Global Constraints

- Preserve all successful endpoint response bodies, OAuth behavior, MCP transport errors, tool names, authentication, and authorization behavior.
- Keep decoded uploads at 52,428,800 bytes (50 MiB); nginx must allow `72m` encoded request bodies.
- Enforce filename 255; evidence title 512; source system, enterprise name, and idempotency key 255; label key 128 and at most 50 labels.
- Enforce evidence query 4,000; evidence filter ID 64 and at most 100 IDs per group; cursor 4,096; structured-query string scalar 32,767.
- Enforce multipart limits of 1 file, 60 fields, and 61 total parts.
- Return stable sanitized `400 INVALID_REQUEST`, `413 PAYLOAD_TOO_LARGE`, and fallback `500 INTERNAL_ERROR`; never serialize unknown exception messages or stacks.
- Keep exact release tags only in dated readiness/verification records; do not rewrite historical milestone evidence.
- Keep `skills/enterprise-hub-mcp/` and standalone `YinXiaoyu-1998/enterprise-hub-mcp-skill` guidance byte-equivalent and deliver them in linked PRs.
- Do not change the database schema, retrieval behavior, worker behavior, deployment topology, or employee-client product scope.

---

### Task 1: Shared public boundaries and structured scalar validation

**Files:**

- Create: `packages/domain/src/input-boundaries.ts`
- Create: `packages/domain/src/input-boundaries.test.ts`
- Modify: `packages/domain/src/index.ts`
- Modify: `packages/domain/src/structured-query.ts`
- Modify: `packages/domain/src/structured-query.test.ts`

**Interfaces:**

- Produces: `PUBLIC_INPUT_LIMITS`, an immutable object exported from `@enterprise-hub/domain`.
- Produces: structured-query validation that throws `StructuredQueryValidationError` with `PHASE3_ERROR_CODES.limitExceeded` for a string scalar longer than `PUBLIC_INPUT_LIMITS.structuredQueryStringScalarChars`.
- Consumes: existing `StructuredQueryValidationError`, `PHASE3_ERROR_CODES`, and `compileStructuredQuery`.

- [ ] **Step 1: Write failing constant and structured-query tests**

Add a table assertion in `input-boundaries.test.ts`:

```ts
expect(PUBLIC_INPUT_LIMITS).toEqual({
  uploadFilenameChars: 255,
  uploadMediaTypeChars: 255,
  evidenceTitleChars: 512,
  sourceSystemChars: 255,
  enterpriseNameChars: 255,
  idempotencyKeyChars: 255,
  labelKeyChars: 128,
  labelsPerRequest: 50,
  evidenceQueryChars: 4_000,
  evidenceFilterIdChars: 64,
  evidenceFilterIdsPerGroup: 100,
  cursorChars: 4_096,
  structuredQueryStringScalarChars: 32_767,
  multipartFiles: 1,
  multipartFields: 60,
  multipartParts: 61
});
```

Add structured-query cases that compile an allowed `contains` value of 32,767 characters and reject 32,768 characters with `LIMIT_EXCEEDED` before repository execution is possible.

- [ ] **Step 2: Run the focused tests and verify RED**

Run:

```bash
npx vitest run packages/domain/src/input-boundaries.test.ts packages/domain/src/structured-query.test.ts
```

Expected: failure because `PUBLIC_INPUT_LIMITS` does not exist and the oversized string currently compiles.

- [ ] **Step 3: Add the shared constants and domain validation**

Create:

```ts
export const PUBLIC_INPUT_LIMITS = Object.freeze({
  uploadFilenameChars: 255,
  uploadMediaTypeChars: 255,
  evidenceTitleChars: 512,
  sourceSystemChars: 255,
  enterpriseNameChars: 255,
  idempotencyKeyChars: 255,
  labelKeyChars: 128,
  labelsPerRequest: 50,
  evidenceQueryChars: 4_000,
  evidenceFilterIdChars: 64,
  evidenceFilterIdsPerGroup: 100,
  cursorChars: 4_096,
  structuredQueryStringScalarChars: 32_767,
  multipartFiles: 1,
  multipartFields: 60,
  multipartParts: 61
} as const);
```

Export it from `packages/domain/src/index.ts`. In `validateScalarType`, reject string values whose `.length` exceeds `structuredQueryStringScalarChars` by throwing a `StructuredQueryValidationError` with the limit-exceeded code and a non-sensitive message.

- [ ] **Step 4: Run the focused tests and verify GREEN**

Run the Task 1 test command again. Expected: all selected tests pass.

- [ ] **Step 5: Commit**

```bash
git add packages/domain/src/input-boundaries.ts packages/domain/src/input-boundaries.test.ts packages/domain/src/index.ts packages/domain/src/structured-query.ts packages/domain/src/structured-query.test.ts
git commit -m "feat(domain): define public input boundaries"
```

### Task 2: MCP contract consumes every applicable shared boundary

**Files:**

- Modify: `packages/mcp-contract/src/index.ts`
- Modify: `packages/mcp-contract/src/index.test.ts`

**Interfaces:**

- Consumes: `PUBLIC_INPUT_LIMITS` and `STRUCTURED_QUERY_LIMITS` from `@enterprise-hub/domain`.
- Preserves: `MCP_UPLOAD_FILENAME_MAX_LENGTH`, `MCP_UPLOAD_MEDIA_TYPE_MAX_LENGTH`, and all existing tool names/result contracts.
- Produces: Zod rejection for oversized metadata, evidence search input, filter groups, cursors, and structured string scalar values.

- [ ] **Step 1: Write table-driven MCP boundary tests**

For each bounded value, assert success exactly at the limit and failure one unit above it. Cover:

```ts
[
  ["upload evidence title", 512],
  ["upload source system", 255],
  ["structured enterprise name", 255],
  ["structured idempotency key", 255],
  ["label key", 128],
  ["label count", 50],
  ["evidence query", 4_000],
  ["filter id", 64],
  ["filter id count", 100],
  ["evidence cursor", 4_096],
  ["structured cursor", 4_096],
  ["structured filter string scalar", 32_767]
]
```

Also assert the existing filename/media exported constants equal their matching `PUBLIC_INPUT_LIMITS` fields.

- [ ] **Step 2: Run the MCP contract tests and verify RED**

Run:

```bash
npx vitest run packages/mcp-contract/src/index.test.ts
```

Expected: the newly added over-limit cases are accepted.

- [ ] **Step 3: Apply shared limits to Zod schemas**

Use `.max(...)` on evidence query/cursor, metadata strings, label arrays/keys, evidence filter arrays/items, and structured page cursor. Replace the structured scalar string arm with:

```ts
z.string().max(PUBLIC_INPUT_LIMITS.structuredQueryStringScalarChars)
```

Keep all existing `.strict()`, MIME, canonical Base64, recursive filter-depth, and cardinality checks.

- [ ] **Step 4: Run the MCP contract tests and verify GREEN**

Run the Task 2 test command again. Expected: all MCP contract tests pass.

- [ ] **Step 5: Commit**

```bash
git add packages/mcp-contract/src/index.ts packages/mcp-contract/src/index.test.ts
git commit -m "feat(mcp): enforce shared input boundaries"
```

### Task 3: Sanitized final API error boundary

**Files:**

- Create: `apps/api/src/request-errors.ts`
- Create: `apps/api/src/request-errors.test.ts`
- Modify: `apps/api/src/server.ts`
- Modify: `apps/api/src/server.test.ts`

**Interfaces:**

- Produces: `PublicRequestError`, `isPayloadTooLargeError(error)`, and `registerApiErrorHandler(app)`.
- Produces: fallback `{ error: { code: "INTERNAL_ERROR", message: "Internal server error.", requestId } }`.
- Preserves: the nested `/mcp` error handler and all explicit route responses.

- [ ] **Step 1: Write failing non-leakage tests**

Add tests proving:

```ts
expect(response.statusCode).toBe(500);
expect(response.json()).toEqual({
  error: {
    code: "INTERNAL_ERROR",
    message: "Internal server error.",
    requestId: expect.any(String)
  }
});
expect(response.payload).not.toContain("private-host.internal:6333");
```

Use an authenticated evidence repository whose `searchEvidence()` throws `new Error("provider detail: private-host.internal:6333")`. Add a malformed JSON test expecting `400 INVALID_REQUEST` without Fastify parser internals. Keep existing OAuth and `/mcp` contract tests selected as regressions.

- [ ] **Step 2: Run focused API tests and verify RED**

Run:

```bash
npx vitest run apps/api/src/request-errors.test.ts apps/api/src/server.test.ts apps/api/src/auth/routes.test.ts apps/api/src/mcp/http.test.ts
```

Expected: unknown errors still expose their messages or use Fastify's default body.

- [ ] **Step 3: Implement and register the final handler**

`registerApiErrorHandler(app)` must:

```ts
app.setErrorHandler((error, request, reply) => {
  if (error instanceof PublicRequestError) {
    return reply.code(error.statusCode).send(publicErrorBody(error.code, error.message, request.id));
  }

  if (isPayloadTooLargeError(error)) {
    return reply
      .code(413)
      .send(publicErrorBody("PAYLOAD_TOO_LARGE", "Request payload is too large.", request.id));
  }

  if (isMalformedClientRequest(error)) {
    return reply
      .code(400)
      .send(publicErrorBody("INVALID_REQUEST", "Request is invalid.", request.id));
  }

  request.log.error({ err: error, method: request.method, url: request.url, requestId: request.id }, "request failed");
  return reply
    .code(500)
    .send(publicErrorBody("INTERNAL_ERROR", "Internal server error.", request.id));
});
```

Recognize Fastify content-parser and multipart limit codes by stable code/status fields, never by returning their messages. Register the handler on the root app before routes; the `/mcp` plugin's scoped handler continues to own MCP transport errors.

- [ ] **Step 4: Run focused API tests and verify GREEN**

Run the Task 3 test command again. Expected: all selected tests pass and the injected private host is absent.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/request-errors.ts apps/api/src/request-errors.test.ts apps/api/src/server.ts apps/api/src/server.test.ts
git commit -m "fix(api): sanitize unhandled request errors"
```

### Task 4: Multipart and upload metadata boundaries

**Files:**

- Modify: `apps/api/src/server.ts`
- Modify: `apps/api/src/server.test.ts`

**Interfaces:**

- Consumes: `PUBLIC_INPUT_LIMITS` and `PublicRequestError`.
- Configures: Fastify multipart `files`, `fields`, `parts`, and existing runtime `fileSize`.
- Preserves: one evidence/structured file, accepted file types, label authorization, storage cleanup, and success responses.

- [ ] **Step 1: Write failing multipart and metadata tests**

For evidence and structured imports, exercise acceptance exactly at each applicable metadata/string/list limit and rejection one unit above it. Add small-runtime tests for:

```ts
limits: {
  fileSize: 8,
  files: 1,
  fields: 60,
  parts: 61
}
```

Send a 9-byte file, two file parts, 61 field parts, and 62 total parts; each must return `413 PAYLOAD_TOO_LARGE` and must not call storage or repositories. Send a 256-character filename, 513-character evidence title, 256-character source/enterprise/idempotency values, 129-character label key, and 51 distinct labels; each must return `400` before persistence.

- [ ] **Step 2: Run focused upload tests and verify RED**

Run:

```bash
npx vitest run apps/api/src/server.test.ts -t "upload|multipart|boundary|limit"
```

Expected: at least the new over-limit metadata/count cases reach repositories or return inconsistent `400` responses.

- [ ] **Step 3: Implement upload validation and multipart limits**

Configure:

```ts
limits: {
  fileSize: runtimeLimits.maxUploadBytes,
  files: PUBLIC_INPUT_LIMITS.multipartFiles,
  fields: PUBLIC_INPUT_LIMITS.multipartFields,
  parts: PUBLIC_INPUT_LIMITS.multipartParts
}
```

Validate filenames, title, source system, enterprise name, idempotency key, label key length, and unique label count before label lookup or storage. Re-throw recognized multipart limit errors as `PublicRequestError(413, "PAYLOAD_TOO_LARGE", "Request payload is too large.")`; keep malformed multipart as the existing route-specific invalid-upload `400`.

- [ ] **Step 4: Run focused upload tests and verify GREEN**

Run the Task 4 test command again. Expected: selected tests pass with no persistence on rejected requests.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/server.ts apps/api/src/server.test.ts
git commit -m "fix(api): bound multipart upload inputs"
```

### Task 5: Evidence search, cursor, and structured-query HTTP boundaries

**Files:**

- Modify: `apps/api/src/server.ts`
- Modify: `apps/api/src/server.test.ts`
- Modify: `apps/api/src/structured-query-route.test.ts`

**Interfaces:**

- Consumes: `PUBLIC_INPUT_LIMITS` and domain structured-query validation.
- Preserves: default evidence limit 10, maximum result limit 50, signed cursor behavior, and structured-query error envelope.
- Produces: stable pre-repository rejection for null/wrong-shape bodies and over-limit queries, filter IDs/groups, cursors, and structured string values.

- [ ] **Step 1: Write failing route boundary tests**

Add authenticated requests for:

```ts
{ payload: null } // 400 INVALID_QUERY, never an exception
{ query: "q".repeat(4_001) }
{ query: "q", cursor: "c".repeat(4_097) }
{ query: "q", filters: { documentIds: ["d".repeat(65)] } }
{ query: "q", filters: { labelIds: Array.from({ length: 101 }, (_, i) => `label_${i}`) } }
```

Assert `400`, a stable existing Phase 3 validation code, and zero evidence repository calls. Add structured-query route coverage proving a 32,768-character string returns `400 LIMIT_EXCEEDED`, includes the request ID, and never executes the repository.

- [ ] **Step 2: Run focused route tests and verify RED**

Run:

```bash
npx vitest run apps/api/src/server.test.ts apps/api/src/structured-query-route.test.ts
```

Expected: null currently produces `500`, and one or more oversized cases reach repositories.

- [ ] **Step 3: Implement strict evidence input normalization**

Replace permissive filtering with explicit record/array/string validation. Trim accepted query/cursor values, but reject wrong types, over-limit strings, over-limit arrays, and over-limit/non-string filter IDs. Use existing `PHASE3_ERROR_CODES.invalidQuery`, `limitExceeded`, and `invalidCursor` codes where they describe the condition.

Apply the cursor limit before decoding audit/evidence/structured cursors. The structured scalar limit is enforced by Task 1's domain compiler and surfaced through the existing `StructuredQueryValidationError` response.

- [ ] **Step 4: Run focused route tests and verify GREEN**

Run the Task 5 test command again. Expected: all route tests pass and repositories are untouched for invalid input.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/server.ts apps/api/src/server.test.ts apps/api/src/structured-query-route.test.ts
git commit -m "fix(api): align search and query limits"
```

### Task 6: nginx and current API/documentation consistency

**Files:**

- Create: `scripts/nginx-config.test.ts`
- Modify: `deploy/staging/nginx-enterprise-hub.conf`
- Modify: `docs/implementation/api-contract.md`
- Modify: `README.md`
- Modify: `README.zh.md`
- Modify: `docs/implementation/implementation-plan.md`
- Modify: `docs/implementation/progress.md`

**Interfaces:**

- Produces: nginx `client_max_body_size 72m`.
- Documents: actual evidence upload/status response bodies, actual object key, public limits, and current acceptance state.
- Preserves: dated historical readiness and deployment records.

- [ ] **Step 1: Write a failing nginx configuration test**

Read `deploy/staging/nginx-enterprise-hub.conf` and assert:

```ts
expect(config).toMatch(/client_max_body_size\s+72m;/);
expect(config.match(/client_max_body_size/g)).toHaveLength(1);
```

- [ ] **Step 2: Run the nginx test and verify RED**

Run:

```bash
npx vitest run scripts/nginx-config.test.ts
```

Expected: failure because the directive is absent.

- [ ] **Step 3: Update nginx and documentation**

Add `client_max_body_size 72m;` inside the API server block. Correct `api-contract.md` examples to the exact `evidenceUploadResponse` and `evidenceStatusResponse` shapes, and change the storage example to:

```text
org/<orgId>/documents/<documentId>/original/<safe-filename>
```

Add the approved public-boundary table and sanitized error envelope. Update README/current implementation status so macOS acceptance is complete and Windows/OpenClaw remain gates. Remove stale current branch/tag claims from general planning/current sections while leaving dated verification records unchanged.

- [ ] **Step 4: Run focused docs/config checks and verify GREEN**

Run:

```bash
npx vitest run scripts/nginx-config.test.ts
npx prettier --check README.md README.zh.md docs/implementation/api-contract.md docs/implementation/implementation-plan.md docs/implementation/progress.md scripts/nginx-config.test.ts
```

Expected: nginx test and formatting checks pass.

- [ ] **Step 5: Commit**

```bash
git add deploy/staging/nginx-enterprise-hub.conf scripts/nginx-config.test.ts README.md README.zh.md docs/implementation/api-contract.md docs/implementation/implementation-plan.md docs/implementation/progress.md
git commit -m "docs: reconcile API and staging boundaries"
```

### Task 7: Synchronize the dual-homed MCP skill

**Files:**

- Modify: `skills/enterprise-hub-mcp/SKILL.md`
- Modify in standalone repository: `SKILL.md`

**Interfaces:**

- Documents: employee-relevant upload/search limits without exposing service-operation guidance.
- Preserves: official origin, launcher pin, authentication boundaries, and all existing workflow instructions.
- Produces: byte-identical repo-local and standalone `SKILL.md` content.

- [ ] **Step 1: Add concise public-limit guidance to both skill copies**

Add one “Request limits” subsection that tells clients:

- file content is at most 50 MiB decoded and filenames are at most 255 characters;
- evidence titles are at most 512 characters and evidence questions at most 4,000 characters;
- label keys are at most 128 characters with at most 50 labels;
- cursors are opaque and at most 4,096 characters;
- the agent must report a tool validation error and ask the user to shorten/split input rather than truncate it silently.

Create a standalone branch named `codex/input-boundary-sync-20260730` before editing its `SKILL.md`.

- [ ] **Step 2: Verify byte equivalence and skill boundaries**

Run:

```bash
cmp skills/enterprise-hub-mcp/SKILL.md /Users/xiaoyuyin/Desktop/YXY_DEV/enterprise-hub-mcp-skill/SKILL.md
grep -n "50 MiB\\|4,000\\|4,096" skills/enterprise-hub-mcp/SKILL.md
git -C /Users/xiaoyuyin/Desktop/YXY_DEV/enterprise-hub-mcp-skill diff --check
```

Expected: `cmp` exits 0 and the new limits are present without credential or service-operation instructions.

- [ ] **Step 3: Commit both repositories independently**

Main repository:

```bash
git add skills/enterprise-hub-mcp/SKILL.md
git commit -m "docs(skill): describe public request limits"
```

Standalone repository:

```bash
git -C /Users/xiaoyuyin/Desktop/YXY_DEV/enterprise-hub-mcp-skill add SKILL.md
git -C /Users/xiaoyuyin/Desktop/YXY_DEV/enterprise-hub-mcp-skill commit -m "docs: describe public request limits"
```

### Task 8: Full verification, progress handoff, and linked draft PRs

**Files:**

- Modify: `docs/implementation/progress.md`
- No new product files.

**Interfaces:**

- Produces: fresh verification evidence, a clean main-repository branch, a clean standalone-skill branch, and two linked draft PRs.
- Requires: no environment-variable additions and no database migration.

- [ ] **Step 1: Format changed files and run static gates**

Run:

```bash
npx prettier --write packages/domain/src/input-boundaries.ts packages/domain/src/input-boundaries.test.ts packages/domain/src/index.ts packages/domain/src/structured-query.ts packages/domain/src/structured-query.test.ts packages/mcp-contract/src/index.ts packages/mcp-contract/src/index.test.ts apps/api/src/request-errors.ts apps/api/src/request-errors.test.ts apps/api/src/server.ts apps/api/src/server.test.ts apps/api/src/structured-query-route.test.ts scripts/nginx-config.test.ts README.md README.zh.md docs/implementation/api-contract.md docs/implementation/implementation-plan.md docs/implementation/progress.md docs/superpowers/plans/2026-07-30-api-boundary-contract-sync.md docs/superpowers/specs/2026-07-30-api-boundary-contract-sync-design.md skills/enterprise-hub-mcp/SKILL.md
npm run format:check
npm run lint
npm run typecheck
```

Expected: all commands exit 0.

- [ ] **Step 2: Run all automated tests**

Run:

```bash
npm test
```

If Vitest exhibits the previously observed parallel-only flake, retain the failure evidence and rerun:

```bash
npm test -- --no-file-parallelism
```

Expected: the full suite passes.

- [ ] **Step 3: Run local integration and MCP smoke**

Load the real ignored local provider configuration as required for end-to-end claims:

```bash
set -a
source .env
set +a
MYSQL_PORT=3307 npm run test:integration
MYSQL_PORT=3307 npm run test:mcp
```

Expected: integration and MCP smoke pass; local test data may be reset by the documented workflow.

- [ ] **Step 4: Record final progress and verify diffs**

Update the current workstream status in `docs/implementation/progress.md` with the exact checks run, no environment/schema changes, the main branch name, and both pending PRs. Then run:

```bash
git diff --check
git status --short
git -C /Users/xiaoyuyin/Desktop/YXY_DEV/enterprise-hub-mcp-skill diff --check
git -C /Users/xiaoyuyin/Desktop/YXY_DEV/enterprise-hub-mcp-skill status --short
```

Expected: only the final progress edit is uncommitted in main; standalone is clean after its skill commit.

- [ ] **Step 5: Commit final evidence**

```bash
git add docs/implementation/progress.md
git commit -m "docs: record API boundary verification"
```

- [ ] **Step 6: Push and create linked draft PRs**

Verify GitHub access:

```bash
gh --version
gh auth status
```

Push both branches and create the standalone draft PR first. Create the main draft PR second and link the standalone PR in its body. Both bodies must include scope, tests, environment changes (`none`), human inputs used (approved limits/design), and known limitations (Windows/OpenClaw acceptance remains outside this change).

- [ ] **Step 7: Final verification of remote state**

Run:

```bash
gh pr view --json url,isDraft,headRefName,baseRefName,statusCheckRollup
git status --short --branch
git -C /Users/xiaoyuyin/Desktop/YXY_DEV/enterprise-hub-mcp-skill status --short --branch
```

Expected: both PR URLs resolve, both are draft PRs against `main`, and both local worktrees are clean.
