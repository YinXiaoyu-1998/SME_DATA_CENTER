# Admin-only File Upload Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make every employee-callable file-upload path admin-only while preserving clearance semantics, keeping upload tools statically discoverable, preventing known employees from reading local upload files in the launcher, and returning one canonical audited backend denial.

**Architecture:** Ship this through two main-repository release slices. First publish and independently verify launcher `0.5.2`, which adds a versioned five-field cached self-profile, static admin-only upload descriptions, and local upload preflight without changing server recommendation metadata. Then merge the backend enforcement/synchronization slice: a shared authorization-and-audit service gates HTTP and MCP before upload-specific parsing, every upload transport uses the same typed denial, active docs and both Skills pin the already-published launcher, and staging receives the immediate hard cut.

**Tech Stack:** TypeScript, Fastify, Prisma/MySQL, Vitest, MCP SDK, Zod, `@napi-rs/keyring`, npm workspaces, GitHub Actions staged npm publishing, OSS multipart uploads.

**Spec:** [`docs/implementation/admin-only-file-upload-design.md`](../../implementation/admin-only-file-upload-design.md), [`CONTEXT.md`](../../../CONTEXT.md), and [`docs/adr/0025-document-confidentiality-and-admin-operations.md`](../../adr/0025-document-confidentiality-and-admin-operations.md).

## Global Constraints

- Lead/base branch is the repository's current `main` at the start of each release slice; use `codex/admin-only-upload-launcher-0-5-2` for the launcher slice and `codex/admin-only-upload-enforcement` for the enforcement/synchronization slice.
- Create isolated implementation worktrees with `superpowers:using-git-worktrees`; do not implement on the design-planning branch.
- Only an active `admin` Employee Account may create or advance an employee-facing file upload. An `employee` is denied regardless of clearance.
- Upload authorization is independent of clearance. An admin may upload level `0`–`3`, including above their own clearance, but gains no ordinary-read bypass.
- The canonical denial is HTTP/MCP `403`, code `UPLOAD_ADMIN_REQUIRED`, message `File upload requires the admin role.`, and `retryable: false`.
- Authentication order remains unauthenticated `401`, disabled-account denial, then the admin upload gate.
- The role gate precedes multipart parsing, upload-field validation, hashing, base64 decoding, storage calls, idempotency lookup, reservation, URL issuance, and state transition. The MCP HTTP layer may parse only the containing JSON-RPC envelope before identifying the tool.
- Upload tools remain statically discoverable for every role; do not add dynamic registration, `tools/list_changed`, or role-filtered discovery.
- Launcher cache fields are exactly `displayName`, `email`, `role`, `clearance`, and `organizationName`. Do not persist IDs, disabled state, secrets, or arbitrary `/me` fields.
- `smedc_get_current_user` always returns a live server result. `smedc_auth_status` stays boolean-only.
- Denied backend attempts append best-effort `file_upload.denied` audit rows with `uploadSurface` equal to `evidence_document`, `structured_dataset`, or `quarantine_certificate`; never inspect `dataset` merely for denial logging.
- `structured_dataset` explicitly covers `delivery_ledger`, `supplier_catalog`, `dish_catalog`, `vip`, `business`, and `dishes`. Delivery Ledger must be named separately in product-facing scope and acceptance even though it shares the structured upload surface.
- Existing documents, upload ownership, read/status semantics, and already issued OSS URLs are unchanged. No database/data migration or presigned-URL revocation is added.
- Assume an account is not downgraded during an active multipart transfer; do not add role-change session enumeration, URL invalidation, or periodic profile synchronization.
- Partition create, part-URL issuance, and complete require admin. Owner-scoped abort, status, manifest, query, search, metadata, and download do not gain an admin gate.
- Workers, reindex, migrations, deploy tooling, cleanup, and test-fixture utilities retain their operator/runtime boundaries. Future schedulers, connectors, and service accounts require a separate identity design.
- Launcher `0.5.2` must be publicly published and independently verified before server recommended-version metadata or either Skill pin changes from `0.5.1`.
- Launcher minimum-compatible version remains `0.5.0`; tool names and input schemas remain unchanged.
- Update repo-local `skills/smedc-mcp/` and standalone `YinXiaoyu-1998/smedc-mcp-skill` together. Create a separate standalone branch and PR; do not assume a machine-specific checkout path.
- Do not rewrite historical plans, handoffs, benchmarks, progress entries, or completed acceptance reports that truthfully record employee uploads in an earlier release.
- Run focused tests during development and repository-wide gates once on each final PR tree. Remove run-owned `.data`, Docker resources, and clean inactive worktrees before handoff.

## Review Focus

- An authenticated employee sending syntactically deliverable but invalid upload input must still receive `UPLOAD_ADMIN_REQUIRED` before multipart/file validation, storage, hashing, repository lookup, or reservation; Task 5 adds route tests for this ordering. Transport-level rejection of an unreadable HTTP envelope remains outside route authorization.
- An employee invoking `upload_structured_dataset` with an invalid or missing `dataset` must be denied as `structured_dataset` without inspecting that field, must create one safe audit row, and must not delegate to HTTP; Task 6 pins this behavior.
- Partition owner cleanup and reads must not be accidentally narrowed: employee abort remains allowed, status/manifest retain existing rules, while create/parts/complete deny; Task 5 tests the complete matrix.
- A legacy v1 credential record must authenticate and lazily upgrade, a missing/corrupt profile must fail upload closed, and a locally forged admin profile must still be stopped by backend authorization; Tasks 1, 2, and 6 cover these cases.
- A clearance-0 admin must successfully upload a level-2 document yet fail ordinary level-2 status/search/download, while a clearance-3 employee can read eligible material but cannot upload; Task 7 covers both automated and manual acceptance.

---

## File and Interface Map

### Launcher release slice

- `apps/mcp-launcher/src/user-profile.ts`: defines and validates the exact five-field profile without depending on session or transport code.
- `apps/mcp-launcher/src/session.ts`: owns the v1-to-v2 secure-record parser, credential rotation with profile preservation, memory-only profile state, and atomic clearing.
- `apps/mcp-launcher/src/launcher.ts`: exposes `LauncherAuthentication.profile()`, applies the local admin preflight before any upload work, and leaves tool discovery static.
- `packages/domain/src/file-upload.ts`: defines the canonical admin-required error and pure upload-capability predicate used by server code and bundled contracts.
- `packages/mcp-contract/src/index.ts`: re-exports the canonical denial and labels the three existing upload tools admin-only without changing names or schemas.
- `apps/mcp-launcher/package.json`, `apps/mcp-launcher/src/oauth-client.ts`, and `apps/mcp-launcher/src/server.ts`: align runtime/package/protocol versions at `0.5.2`.

### Backend enforcement and synchronization slice

- `apps/api/src/file-upload-authorization.ts`: shared best-effort denied-audit repository/service and HTTP error response; it performs no upload parsing.
- `apps/api/src/app-context.ts` and `apps/api/src/server.ts`: inject one lazy upload-authorization audit repository and the shared gate into HTTP and MCP boundaries.
- `apps/api/src/routes/evidence.ts`, `routes/quarantine-certificates.ts`, `routes/structured-import/routes.ts`, and `routes/structured-partitions/routes.ts`: apply the gate at each HTTP upload/advancement boundary.
- `apps/api/src/mcp/upload-tools.ts` and `mcp/tool-handlers.ts`: reject employee tool calls before upload-schema parsing, decoding, or internal delegation.
- `packages/domain/src/audit.ts`: declares `file_upload.denied` as a canonical audit action.
- `scripts/test-integration.ts`, official manual-acceptance scripts, and fixtures: switch positive uploads to admin while retaining employee reads and adding explicit employee denials.
- Active API/install/manual/flow docs and `skills/smedc-mcp/`: document admin-only upload and pin the already verified `0.5.2` launcher.
- Standalone `YinXiaoyu-1998/smedc-mcp-skill`: mirrors the repo-local Skill behavior and pin in an independent PR.

---

### Task 1: Add the versioned launcher self-profile record

**Release slice:** launcher `0.5.2` PR

**Files:**

- Create: `apps/mcp-launcher/src/user-profile.ts`
- Create: `apps/mcp-launcher/src/user-profile.test.ts`
- Modify: `apps/mcp-launcher/src/session.ts`
- Modify: `apps/mcp-launcher/src/session.test.ts`
- Modify: `apps/mcp-launcher/src/index.ts`

**Interfaces:**

- Produces `CachedUserProfile` with exactly five fields.
- Produces strict `cachedUserProfileSchema` for persisted values and `parseCurrentUserProfileResponse(value): CachedUserProfile` for the launcher's live `/me` resolver.
- Extends `LauncherSession` with `cachedProfile(): Promise<CachedUserProfile | null>` and `storeProfile(profile: CachedUserProfile): Promise<void>`.
- Secure-store schema v2 is `{ schemaVersion: 2, origin, durableCredential, profile }`; schema v1 remains readable and yields `profile: null`.

- [ ] **Step 1: write failing exact-profile parser tests**

  Add tests that accept only this server-derived public shape and strip the `/me` wrapper and internal fields:

  ```ts
  expect(
    parseCurrentUserProfileResponse({
      employee: {
        id: "emp_internal",
        orgId: "org_internal",
        disabled: false,
        displayName: "Admin",
        email: "admin@example.invalid",
        role: "admin",
        clearance: 0,
        organizationName: "Example Org"
      }
    })
  ).toEqual({
    displayName: "Admin",
    email: "admin@example.invalid",
    role: "admin",
    clearance: 0,
    organizationName: "Example Org"
  });
  ```

  Reject blank strings, unknown roles, non-integer/out-of-range clearance, absent fields, and malformed response bodies. Assert serialized output contains neither `id`, `orgId`, nor `disabled`.

- [ ] **Step 2: run the profile test and verify RED**

  Run `npm test -- apps/mcp-launcher/src/user-profile.test.ts`.

  Expected: FAIL because `cachedUserProfileSchema` and `parseCurrentUserProfileResponse` do not exist.

- [ ] **Step 3: implement the dependency-free five-field parser**

  Export this exact type:

  ```ts
  export interface CachedUserProfile {
    displayName: string;
    email: string;
    role: "admin" | "employee";
    clearance: number;
    organizationName: string;
  }
  ```

  Define `cachedUserProfileSchema` as a strict Zod object over exactly those fields. `parseCurrentUserProfileResponse` validates the `/me` envelope, selects only those five employee properties, then validates the selected object. Keep this module free of session and network imports so `session.ts` can import the profile type/schema without a circular dependency. The live `/me` fetch belongs in `launcher.ts` in Task 2.

- [ ] **Step 4: write failing session-record migration and lifecycle tests**

  Cover:

  ```ts
  await expect(session.cachedProfile()).resolves.toBeNull(); // schema v1
  await session.storeProfile(adminProfile);
  expect(JSON.parse((await secureStore.get())!)).toMatchObject({
    schemaVersion: 2,
    durableCredential: "legacy-refresh",
    profile: adminProfile
  });
  ```

  Also prove refresh-token rotation preserves the profile, logout/invalidate clears both, memory-only sessions retain both only in-process, a different `origin` is rejected, and a malformed v2 profile cannot produce an authorization-granting profile.

- [ ] **Step 5: run the session test and verify RED**

  Run `npm test -- apps/mcp-launcher/src/session.test.ts`.

  Expected: FAIL on missing profile APIs and schema-v2 behavior.

- [ ] **Step 6: implement schema-v2 storage with v1 lazy compatibility**

  Replace credential-only internal state with a record-shaped state. Parse v1 as a valid credential plus null profile, write only v2, preserve the current profile whenever the refresh credential rotates, and clear the whole record on logout, invalidation, definitive refresh failure, or account replacement. Never copy unknown JSON properties into a new record.

- [ ] **Step 7: run focused launcher profile/session tests**

  Run:

  ```bash
  npm test -- apps/mcp-launcher/src/user-profile.test.ts apps/mcp-launcher/src/session.test.ts
  ```

  Expected: PASS.

- [ ] **Step 8: commit the profile record**

  ```bash
  git add apps/mcp-launcher/src/user-profile.ts apps/mcp-launcher/src/user-profile.test.ts apps/mcp-launcher/src/session.ts apps/mcp-launcher/src/session.test.ts apps/mcp-launcher/src/index.ts
  git commit -m "feat(launcher): cache the authenticated user profile"
  ```

---

### Task 2: Gate launcher uploads locally and keep tools visible

**Release slice:** launcher `0.5.2` PR

**Files:**

- Create: `packages/domain/src/file-upload.ts`
- Modify: `packages/domain/src/permissions.test.ts`
- Modify: `packages/domain/src/index.ts`
- Modify: `packages/mcp-contract/src/index.ts`
- Modify: `packages/mcp-contract/src/index.test.ts`
- Modify: `apps/mcp-launcher/src/launcher.ts`
- Modify: `apps/mcp-launcher/src/launcher.test.ts`
- Modify: `apps/mcp-launcher/src/oauth-client.ts`
- Modify: `apps/mcp-launcher/src/oauth-client.test.ts`
- Modify: `apps/mcp-launcher/src/server.ts`
- Modify: `apps/mcp-launcher/src/index.test.ts`
- Modify: `apps/mcp-launcher/src/packaging.verify.ts`
- Modify: `apps/mcp-launcher/package.json`
- Modify: `apps/mcp-launcher/README.md`
- Modify: `package-lock.json`

**Interfaces:**

- Produces `FILE_UPLOAD_ADMIN_REQUIRED_CODE`, `FILE_UPLOAD_ADMIN_REQUIRED_MESSAGE`, and `canEmployeeUploadFiles(subject)` from `@smedc/domain`.
- `@smedc/mcp-contract` bundles/re-exports the canonical code/message for launcher use.
- Extends `LauncherAuthentication` with `profile(): Promise<CachedUserProfile>`.
- Adds a private launcher-layer `fetchCurrentUserProfile(serviceUrl, accessToken, fetchImplementation): Promise<CachedUserProfile>` that uses the Task 1 parser.
- All three upload handlers call `profile()` before inspecting upload input or touching the filesystem.

- [ ] **Step 1: write failing domain and contract tests**

  Assert:

  ```ts
  expect(canEmployeeUploadFiles({ role: "admin", disabled: false })).toBe(true);
  expect(canEmployeeUploadFiles({ role: "employee", disabled: false })).toBe(false);
  expect(canEmployeeUploadFiles({ role: "admin", disabled: true })).toBe(false);
  ```

  Assert all three existing upload contracts retain their names and input schemas while each description includes `Requires the admin role.`. Assert the other tool descriptions are unchanged.

- [ ] **Step 2: implement the canonical capability constants and descriptions**

  Add:

  ```ts
  export const FILE_UPLOAD_ADMIN_REQUIRED_CODE = "UPLOAD_ADMIN_REQUIRED";
  export const FILE_UPLOAD_ADMIN_REQUIRED_MESSAGE = "File upload requires the admin role.";

  export function canEmployeeUploadFiles(subject: {
    role: "admin" | "employee";
    disabled: boolean;
  }): boolean {
    return !subject.disabled && subject.role === "admin";
  }
  ```

  Keep all upload tool schemas byte-for-byte equivalent apart from description text.

- [ ] **Step 3: write failing launcher preflight tests before implementation**

  Add one table-driven test for `upload_structured_dataset`, `upload_evidence_document`, and `upload_quarantine_certificate`. Use an employee profile and a deliberately nonexistent file path; each result must be:

  ```ts
  {
    error: {
      code: "UPLOAD_ADMIN_REQUIRED",
      message: "File upload requires the admin role.",
      retryable: false
    }
  }
  ```

  Assert no access token, remote fetch, partition session, file-read error, or filesystem access occurs. Add a base64-input case to prove the guard is tool-level rather than path-only. Assert `registerLauncherTools` still lists all three upload tools for an employee profile.

- [ ] **Step 4: run launcher tests and verify RED**

  Run `npm test -- packages/domain/src/permissions.test.ts packages/mcp-contract/src/index.test.ts apps/mcp-launcher/src/launcher.test.ts`.

  Expected: FAIL because the capability constants, `profile()`, descriptions, and preflight are absent.

- [ ] **Step 5: implement live profile resolution and the preflight wrapper**

  The launcher-layer `fetchCurrentUserProfile` sends authenticated `GET /me` with the launcher-version header, applies the existing timeout, uses `parseCurrentUserProfileResponse`, maps `401` to `AUTHENTICATION_REQUIRED`, and maps network/invalid responses to `SERVICE_UNAVAILABLE`. `LauncherAuthentication.profile()` returns the cached profile when present; otherwise it obtains an access token, fetches live `/me`, persists the five-field profile, and returns it. Wrap all names in `LOCAL_PATH_UPLOAD_TOOL_NAMES` before calling `proxyLocalPathUpload`:

  ```ts
  const profile = await dependencies.auth.profile();
  if (profile.role !== "admin") {
    return errorToolResult(
      FILE_UPLOAD_ADMIN_REQUIRED_CODE,
      FILE_UPLOAD_ADMIN_REQUIRED_MESSAGE,
      undefined,
      { retryable: false }
    );
  }
  return proxyLocalPathUpload(toolName, input, dependencies);
  ```

  Run this before `uploadFileFromInput`, Zod input parsing, `readLocalUploadFile`, hashing, base64 conversion, `accessToken()` for upload, or partition-transfer creation. Unknown profile state must fetch live; fetch failure returns the existing authentication/service typed error rather than guessing a role.

- [ ] **Step 6: add admin, legacy, and tamper-resistance launcher tests**

  Prove an admin profile follows the existing upload path; a v1 credential causes one `/me` lookup then upgrades to v2; a subsequent upload reuses the profile; logout forces a new resolution; and a locally supplied admin profile cannot turn a backend `UPLOAD_ADMIN_REQUIRED` response into success. `smedc_get_current_user` must still make a remote MCP call and `smedc_auth_status` must not include the cached profile.

- [ ] **Step 7: bump every launcher release boundary to 0.5.2**

  Change package, runtime, MCP server, OAuth header, version-alignment tests, packaging expectations, README examples, and `package-lock.json` to `0.5.2`. Do not change `apps/api/src/auth/http-contract.ts`, the repo-local Skill pin, the standalone Skill pin, or active installation docs in this PR.

- [ ] **Step 8: run focused launcher and package tests**

  Run:

  ```bash
  npm test -- packages/domain/src/permissions.test.ts packages/mcp-contract/src/index.test.ts apps/mcp-launcher/src/user-profile.test.ts apps/mcp-launcher/src/session.test.ts apps/mcp-launcher/src/launcher.test.ts apps/mcp-launcher/src/oauth-client.test.ts apps/mcp-launcher/src/index.test.ts
  npm --workspace smedc-mcp-launcher run build
  npm --workspace smedc-mcp-launcher run pack:check
  npm --workspace smedc-mcp-launcher run test:package
  ```

  Expected: PASS; the installed artifact reports `0.5.2`, lists all upload tools, and contains their admin-only descriptions.

- [ ] **Step 9: commit the launcher behavior and release bump**

  ```bash
  git add packages/domain packages/mcp-contract apps/mcp-launcher package-lock.json
  git commit -m "feat(launcher): restrict file uploads to admins"
  ```

---

### Task 3: Merge, publish, and independently verify launcher 0.5.2

**Release slice:** launcher `0.5.2` PR and npm release

**Files:**

- Modify: `docs/implementation/progress.md` with milestone-only entries
- Do not modify server recommendation or Skill pins in this task

**Interfaces:**

- Produces a public, independently verified `smedc-mcp-launcher@0.5.2` artifact required by Tasks 8–9.

- [ ] **Step 1: run final launcher-slice gates once**

  Run:

  ```bash
  npm run format:check
  npm run lint
  npm run typecheck
  npm test
  npm run build:release
  npm --workspace smedc-mcp-launcher run test:package
  ```

  Confirm `git diff --check` passes and no generated tarball or credential-store content is tracked.

- [ ] **Step 2: prepare the launcher PR handoff**

  Report scope, tests, environment changes, known limitations, and approximate inserted/deleted lines divided into production/config, runtime/CI/deploy, tests/harnesses, docs/plans/reports, and lockfile. Identify this implementation plan/design as user-requested process artifacts if they are included.

- [ ] **Step 3: merge the launcher slice into main**

  Use the repository's normal PR review and required checks. After merge, remove the clean launcher worktree and run `git worktree prune`.

- [ ] **Step 4: publish through the staged launcher release workflow**

  Trigger/observe `.github/workflows/launcher-release.yml` from the merged `main` SHA. Complete the existing human npm-stage approval when requested. Follow the repository waiting rule: after the first status check, wait at least three minutes before checking the same external blocker again.

- [ ] **Step 5: independently verify the public package**

  In a fresh temporary directory, install exact `smedc-mcp-launcher@0.5.2`, run `--version`, inspect `npm view` metadata/integrity, execute the installed-package stdio/list-tools check, and compare the registry package contents with the reviewed artifact. Confirm production dependency audit results and native release jobs.

- [ ] **Step 6: record the publication milestone without changing pins**

  Add one concise progress entry containing merge SHA, release run, registry integrity, independent verification result, and the explicit statement that server recommendation and both Skill pins remain `0.5.1` until the enforcement/synchronization slice.

---

### Task 4: Build the shared backend authorization and denied-audit service

**Release slice:** backend enforcement/synchronization PR, based on main after Task 3

**Files:**

- Create: `apps/api/src/file-upload-authorization.ts`
- Create: `apps/api/src/file-upload-authorization.test.ts`
- Modify: `packages/domain/src/audit.ts`
- Modify: `packages/domain/src/index.ts`
- Modify: `apps/api/src/app-context.ts`
- Modify: `apps/api/src/app-context.test.ts`
- Modify: `apps/api/src/server.ts`

**Interfaces:**

- Produces `FileUploadSurface = "evidence_document" | "structured_dataset" | "quarantine_certificate"`.
- Produces `UploadAuthorizationAuditRepository.appendDenied(input): Promise<void>` and `createPrismaUploadAuthorizationAuditRepository()`.
- Produces `authorizeFileUpload(input): Promise<boolean>` and `fileUploadAdminRequiredResponse(request)`.
- `ApiServerOptions` accepts an injectable audit repository; `ApiServerContext` lazily owns and closes it.

- [ ] **Step 1: write failing service tests**

  Cover admin allow without an audit write, employee denial with exactly one safe event, and audit-write failure that logs and still denies:

  ```ts
  expect(audit.appendDenied).toHaveBeenCalledWith({
    orgId: employee.orgId,
    actorEmployeeId: employee.id,
    uploadSurface: "structured_dataset",
    audit: requestAudit
  });
  expect(result).toBe(false);
  ```

  Assert event data is exactly `action: "file_upload.denied"`, `targetType: "file_upload"`, `targetId: null`, `result: "denied"`, and metadata `{ uploadSurface, reason: "admin_role_required" }`, plus existing request provenance columns. Assert the API offers no filename, title, dataset, receipt ID, business date, or idempotency-key parameter to this repository.

- [ ] **Step 2: run the service test and verify RED**

  Run `npm test -- apps/api/src/file-upload-authorization.test.ts`.

  Expected: FAIL because the service and audit action do not exist.

- [ ] **Step 3: implement the shared service and Prisma repository**

  `authorizeFileUpload` first calls `canEmployeeUploadFiles`. On employee denial it awaits `appendDenied`; catch audit errors, invoke the supplied logger with request ID and surface only, and return false. Use `phase3ErrorResponse` semantics so HTTP output includes `retryable: false` and `requestId`.

- [ ] **Step 4: wire one lazy repository into application context**

  Add `uploadAuthorizationAuditRepository?: UploadAuthorizationAuditRepository` to `ApiServerOptions`, expose `uploadAuthorizationAudit()` on context, instantiate it only when needed, and call `disconnect?.()` during context close. Pass the repository and `createBusinessRequestAudit` to MCP and upload routes through `server.ts`.

- [ ] **Step 5: test context injection and cleanup**

  Assert an injected stub is returned unchanged and disconnected once; the default context remains lazy; closing an unused test server does not require `DATABASE_URL` beyond existing authentication requirements.

- [ ] **Step 6: run focused backend primitive tests and commit**

  Run:

  ```bash
  npm test -- packages/domain/src/permissions.test.ts apps/api/src/file-upload-authorization.test.ts apps/api/src/app-context.test.ts
  ```

  Commit:

  ```bash
  git add packages/domain/src/audit.ts packages/domain/src/index.ts apps/api/src/file-upload-authorization.ts apps/api/src/file-upload-authorization.test.ts apps/api/src/app-context.ts apps/api/src/app-context.test.ts apps/api/src/server.ts
  git commit -m "feat(api): add admin upload authorization service"
  ```

---

### Task 5: Enforce admin-only upload across every HTTP transport

**Release slice:** backend enforcement/synchronization PR

**Files:**

- Modify: `apps/api/src/routes/evidence.ts`
- Modify: `apps/api/src/routes/evidence.test.ts`
- Modify: `apps/api/src/routes/quarantine-certificates.ts`
- Modify: `apps/api/src/routes/quarantine-certificates.test.ts`
- Modify: `apps/api/src/routes/structured-import/routes.ts`
- Modify: `apps/api/src/routes/structured-import/structured-import.test.ts`
- Modify: `apps/api/src/routes/structured-partitions/routes.ts`
- Modify: `apps/api/src/routes/structured-partitions/routes.test.ts`
- Modify: `apps/api/src/test-support/auth-fixtures.ts`

**Interfaces:**

- Consumes `authorizeFileUpload`, `fileUploadAdminRequiredResponse`, and the injected audit repository from Task 4.
- Every denied structured route records `uploadSurface: "structured_dataset"`, including Delivery Ledger and partition uploads.

- [ ] **Step 1: write failing evidence/quarantine/row-import denial tests**

  For each route, authenticate an active employee and send syntactically deliverable input with missing or invalid upload fields. Assert canonical 403, one safe audit write, and zero calls to multipart parsers where injectable, storage, hashing-dependent repository methods, import reservation, idempotency lookup, or document creation. Add an audit-repository failure case that still returns the same 403.

- [ ] **Step 2: write the failing partition endpoint matrix**

  For an employee owner, assert:

  | Endpoint                                                | Expected                                                           |
  | ------------------------------------------------------- | ------------------------------------------------------------------ |
  | `POST /v1/structured/partition-uploads`                 | `403 UPLOAD_ADMIN_REQUIRED`                                        |
  | `GET /v1/structured/partition-uploads/:jobId/parts`     | `403 UPLOAD_ADMIN_REQUIRED` before job lookup/URL signing          |
  | `POST /v1/structured/partition-uploads/:jobId/complete` | `403 UPLOAD_ADMIN_REQUIRED` before job lookup/storage/state change |
  | `DELETE /v1/structured/partition-uploads/:jobId`        | existing owner-scoped `204` cleanup                                |
  | `GET /v1/structured/partition-imports/:jobId`           | existing status behavior                                           |
  | `POST /v1/structured/partition-manifests`               | existing clearance-filtered read behavior                          |

  Verify the three denials each use `structured_dataset` and do not inspect request body `dataset` for audit classification.

- [ ] **Step 3: run route tests and verify RED**

  Run:

  ```bash
  npm test -- apps/api/src/routes/evidence.test.ts apps/api/src/routes/quarantine-certificates.test.ts apps/api/src/routes/structured-import/structured-import.test.ts apps/api/src/routes/structured-partitions/routes.test.ts
  ```

  Expected: employee uploads still reach parsing/storage or succeed.

- [ ] **Step 4: add the gate immediately after authentication**

  Every protected upload handler follows this order:

  ```ts
  const authenticated = await dependencies.auth.authenticate(request, reply);
  if (!authenticated) return;
  const employee = dependencies.auth.employee(request);
  const allowed = await authorizeFileUpload({
    employee,
    uploadSurface: "evidence_document",
    audit: dependencies.createBusinessRequestAudit(request),
    repository: dependencies.uploadAuthorizationAudit(),
    onAuditFailure: (error) =>
      request.log.error({ err: error, requestId: request.id }, "upload denial audit failed")
  });
  if (!allowed) return reply.code(403).send(fileUploadAdminRequiredResponse(request));
  ```

  Use the corresponding surface for each route. Place partition checks before `findJobForStatus`, URL issuance, storage access, or request-body validation. Do not add the check to abort, status, manifest, search, query, metadata, or download routes.

- [ ] **Step 5: change only positive uploader fixtures to admin**

  Use `clearanceZeroAdminEmployee` for tests that prove above-clearance classification. Keep existing employees for read/status denial tests and add explicit upload-denial cases rather than globally changing employee fixtures to admin.

- [ ] **Step 6: run the HTTP upload route tests**

  Run the four focused test files from Step 3. Expected: PASS, including admin success/idempotency/validation behavior and employee no-side-effect denials.

- [ ] **Step 7: commit HTTP enforcement**

  ```bash
  git add apps/api/src/routes apps/api/src/test-support/auth-fixtures.ts
  git commit -m "feat(api): enforce admin-only file uploads"
  ```

---

### Task 6: Enforce the role before MCP upload parsing and delegation

**Release slice:** backend enforcement/synchronization PR

**Files:**

- Modify: `apps/api/src/mcp/upload-tools.ts`
- Modify: `apps/api/src/mcp/upload-tools.test.ts`
- Modify: `apps/api/src/mcp/tool-handlers.ts`
- Modify: `apps/api/src/mcp/tool-handlers.test.ts`
- Modify: `apps/api/src/mcp/http.ts`
- Modify: `apps/api/src/mcp/http.test.ts`

**Interfaces:**

- `UploadToolHandlerOptions` consumes `authorizeUpload(context, uploadSurface): Promise<boolean>`.
- Employee MCP denials are written once at the MCP boundary; no delegated HTTP request is created.
- Admin calls continue to delegate to HTTP, where the route independently enforces the same capability.

- [ ] **Step 1: write failing early-denial unit tests for all three tools**

  Use an employee `McpRequestContext` and invalid input such as `{}` or a noncanonical base64 payload. Assert the result is canonical `UPLOAD_ADMIN_REQUIRED`, `retryable: false`, and includes the request ID. Assert size preflight, Zod validation, base64 decode, multipart construction, and `delegate` are never called.

- [ ] **Step 2: pin structured audit classification without dataset inspection**

  Call `upload_structured_dataset` once with no dataset and once with a fake dataset. Both must call:

  ```ts
  authorizeUpload(context, "structured_dataset");
  ```

  exactly once. Neither result nor audit metadata may echo the fake dataset or any file field.

- [ ] **Step 3: add an MCP HTTP integration denial test**

  Send an authenticated employee JSON-RPC `tools/call` for an upload tool. Assert HTTP transport succeeds per MCP protocol, the tool result is an error with the canonical code, exactly one `file_upload.denied` row/stub call is made with `clientSource: "mcp_launcher"`, and the internal multipart route is not injected.

- [ ] **Step 4: run MCP tests and verify RED**

  Run:

  ```bash
  npm test -- apps/api/src/mcp/upload-tools.test.ts apps/api/src/mcp/tool-handlers.test.ts apps/api/src/mcp/http.test.ts
  ```

- [ ] **Step 5: implement authorization as the first upload-handler operation**

  For each exported handler, call `authorizeUpload` before abort handling and any input inspection. Return `errorToolResult(FILE_UPLOAD_ADMIN_REQUIRED_CODE, FILE_UPLOAD_ADMIN_REQUIRED_MESSAGE, undefined, { retryable: false, requestId })` when false. Map evidence and quarantine to their named surfaces and every structured tool call to `structured_dataset`.

- [ ] **Step 6: wire the shared backend service into handler creation**

  `registerMcpHttpRoute` receives the audit repository callback from `server.ts`. `createSmedcMcpToolHandlers` builds `authorizeUpload` from `context.employee`, `context.audit`, and the shared Task 4 service. Log an audit failure through the request logger without delegating or changing the denial.

- [ ] **Step 7: add admin success and old-launcher regressions**

  Confirm admin MCP calls retain existing validation/delegation behavior. Confirm an employee using an older compatible launcher still receives the backend denial. Assert the upload tools remain present in `tools/list` for both roles.

- [ ] **Step 8: run focused MCP tests and commit**

  Run the three files from Step 4, then commit:

  ```bash
  git add apps/api/src/mcp
  git commit -m "feat(mcp): reject non-admin upload calls"
  ```

---

### Task 7: Migrate integration and acceptance coverage to the three-account model

**Release slice:** backend enforcement/synchronization PR

**Files:**

- Modify: `scripts/test-integration.ts`
- Modify: `scripts/official-manual-acceptance.ts`
- Modify: `scripts/official-manual-acceptance-support.ts`
- Modify: `scripts/official-manual-acceptance-support.test.ts`
- Modify: `scripts/manual-test-fixtures.test.ts`
- Modify: `fixtures/manual-acceptance/scenarios.json`
- Modify as required by focused failures: existing positive upload tests under `apps/api/src/**`

**Interfaces:**

- Integration uses distinct `adminAuth` for uploads and `employeeAuth` for ordinary readable data.
- Full manual acceptance uses employee clearance 0 for local upload denial, employee clearance 3 for eligible high-level reads, and admin clearance 0 for every positive upload family and ordinary high-level read denial.

- [ ] **Step 1: write failing fixture-contract assertions for the new scenario order**

  Bump the scenario manifest version and assert separate natural-language tasks for:

  - employee clearance-0 upload denial;
  - admin default-level evidence upload;
  - admin explicit level-2 evidence upload;
  - admin Delivery Ledger XLSX upload;
  - admin ordinary row-query CSV upload;
  - admin `business` partition upload;
  - admin `dishes` partition upload;
  - admin quarantine-certificate upload;
  - clearance-3 employee high-level read;
  - clearance-0 admin high-level ordinary-read denial and certificate archive PAO.

  Keep exactly one ordinary request per user-visible task and preserve the synthetic-account credential rules.

- [ ] **Step 2: split integration authentication by responsibility**

  Create tokens for seeded `emp_admin` and `emp_baoli_employee`. Replace the single `auth` variable with `adminAuth` for upload creation/replay/completion and `employeeAuth` for level-0 query/search/download checks. Add an employee upload probe that expects canonical 403 and verifies no document/import/partition/storage residue plus one safe denial audit.

- [ ] **Step 3: preserve clearance orthogonality in automated integration**

  Add or retain a focused route/integration sequence where a clearance-0 admin uploads level 2, cannot read its ordinary status/search/download, and a clearance-3 employee can read the active material after worker/operator readiness. Do not use admin role as a read shortcut.

- [ ] **Step 4: update the official controller assertions and cleanup ownership**

  Replace `isLowClearanceAcceptanceEmployee` where positive uploads are expected with explicit role/clearance predicates for each account. Pin the controller's installed launcher constant to the already published `0.5.2`. Track uploader IDs for all three synthetic accounts so cleanup removes every run-owned document/import/partition/object/vector while preserving unrelated data. Controller DB/storage access remains verification/cleanup only.

- [ ] **Step 5: make Delivery Ledger coverage explicit**

  Use the approved XLSX delivery-ledger fixture through `upload_structured_dataset` as the admin, poll its row-import status, and query it as the clearance-3 employee when its level permits. Keep the original XLSX; do not add dataset-specific rewrite instructions to the base Skill.

- [ ] **Step 6: run focused acceptance-harness tests**

  Run:

  ```bash
  npm test -- scripts/manual-test-fixtures.test.ts scripts/official-manual-acceptance-support.test.ts scripts/official-user-install-and-login.test.ts
  ```

  Expected: PASS for the changed scenario/controller contracts. Active installation documentation and both base Skill pins remain `0.5.1` until Task 8.

- [ ] **Step 7: run local integration with real local provider configuration**

  Start disposable MySQL/Qdrant, load the ignored `.env` as required by project policy, and run:

  ```bash
  set -a
  source .env
  set +a
  MYSQL_PORT=3307 npm run test:integration
  MYSQL_PORT=3307 npm run test:mcp
  ```

  Confirm both admin successes and employee denials. Run repository cleanup commands afterward and verify no run-owned `.data`, containers, volumes, or networks remain.

- [ ] **Step 8: commit test and acceptance migration**

  ```bash
  git add scripts fixtures/manual-acceptance apps/api/src
  git commit -m "test(upload): cover the admin-only acceptance matrix"
  ```

---

### Task 8: Synchronize active contracts, guidance, server recommendation, and both Skills

**Release slice:** backend enforcement/synchronization PR, only after Task 3 publication evidence exists

**Files:**

- Modify: `apps/api/src/auth/http-contract.ts`
- Modify: `apps/api/src/auth/http-contract.test.ts`
- Modify: `apps/api/src/auth/routes.test.ts`
- Modify: `docs/implementation/api-contract.md`
- Modify: `docs/implementation/official-manual-acceptance.md`
- Modify: `docs/implementation/official-user-install-and-login.md`
- Modify: `docs/implementation/mcp-user-flow.md`
- Modify: `docs/implementation/mcp-user-flow.zh.md`
- Modify: `docs/implementation/test-cases.md`
- Modify: `docs/implementation/beta-access-readiness.md`
- Modify: `docs/implementation/beta-user-onboarding-runbook.md`
- Modify: `docs/implementation/staging-readiness.md` only for current readiness/version facts
- Modify: `docs/context/CONTEXT.md`
- Modify: `README.md`
- Modify: `skills/smedc-mcp/SKILL.md`
- Modify: `skills/smedc-mcp/agents/openai.yaml` if its description needs the admin-only boundary
- Modify: `skills/smedc-mcp/references/update-skill.md`
- Modify: `skills/smedc-manual-test/SKILL.md`
- Modify: repo-local Skill references/tests selected by `rg "0\.5\.1|upload" skills/smedc-mcp scripts docs README.md`
- Modify in standalone repository: `skills/smedc-mcp/SKILL.md`, `skills/smedc-mcp/agents/openai.yaml`, `skills/smedc-mcp/references/update-skill.md`, `README.md`, `README.zh.md`, and `tests/test_smedc_skill_contract.py`

**Interfaces:**

- Server recommends `0.5.2` and keeps minimum `0.5.0`.
- Both base Skills pin exact `smedc-mcp-launcher@0.5.2` and carry equivalent admin-only upload guidance.

- [ ] **Step 1: verify the release prerequisite before changing any pin**

  Check the public npm registry from a clean environment and record the independently verified `0.5.2` integrity from Task 3. If the exact version is unavailable or verification is incomplete, stop this task without changing metadata or Skills.

- [ ] **Step 2: write failing version and guidance assertions**

  Update tests to expect recommended `0.5.2`, minimum `0.5.0`, all upload descriptions admin-only, and active docs/Skills containing `UPLOAD_ADMIN_REQUIRED`. Add negative assertions that no active guide says employee can upload, no Skill suggests changing clearance, and no Skill hides/removes tools dynamically.

- [ ] **Step 3: update the API contract and active product documentation**

  Document the endpoint matrix, exact error, launcher local-preflight/no-local-audit behavior, backend audit behavior, Delivery Ledger inclusion, clearance orthogonality, partition abort exception, legacy launcher safety, and service-identity non-goal. Preserve historical factual records unchanged.

- [ ] **Step 4: update repo-local Skill behavior and exact launcher pin**

  The Skill must say:

  - upload tools are admin-only but remain visible;
  - when live current-user role is known to be employee, do not read/transform a local file for upload and explain the admin requirement;
  - `UPLOAD_ADMIN_REQUIRED` is non-retryable and must not trigger re-login or repeated upload attempts;
  - clearance is not an upload permission and admins may explicitly classify above their own clearance;
  - original-file and dataset-specific transformation boundaries remain unchanged.

  Replace every active installation path/command pin from `0.5.1` to exact `0.5.2`; never use `latest`.

- [ ] **Step 5: update the standalone Skill repository on its own branch**

  Locate or clone `YinXiaoyu-1998/smedc-mcp-skill`, verify its default branch and cleanliness, create `codex/admin-only-upload-0-5-2`, apply the matching Skill/README/test changes, and run its contract test. Compare shared Skill bytes with the repo-local copy where exact identity is intended.

- [ ] **Step 6: run documentation, contract, and Skill tests**

  Run:

  ```bash
  npm test -- apps/api/src/auth/http-contract.test.ts apps/api/src/auth/routes.test.ts scripts/manual-test-fixtures.test.ts scripts/official-user-install-and-login.test.ts packages/mcp-contract/src/index.test.ts
  npm run format:check
  ```

  In the standalone repository run `python -m unittest tests/test_smedc_skill_contract.py` (or its documented equivalent if the repository declares a different command).

- [ ] **Step 7: commit main-repository synchronization**

  ```bash
  git add apps/api/src/auth docs README.md skills/smedc-mcp skills/smedc-manual-test scripts fixtures CONTEXT.md
  git commit -m "docs(upload): publish admin-only upload guidance"
  ```

- [ ] **Step 8: commit and open the standalone Skill PR**

  Commit `docs(skill): require admin for SMEDC uploads`, push its branch, open a PR describing the exact launcher pin and error behavior, and keep it unmerged until the main enforcement PR is ready for coordinated release.

---

### Task 9: Final verification, coordinated merge, staging hard cut, and acceptance

**Release slice:** backend enforcement/synchronization PR and post-merge staging acceptance

**Files:**

- Modify: `docs/implementation/progress.md` for milestone/final evidence only
- Modify after deployment evidence: `docs/implementation/staging-readiness.md`
- No schema migration file is expected

**Interfaces:**

- Produces the deployed admin-only upload boundary and synchronized standalone Skill release.

- [ ] **Step 1: run the focused authorization regression set**

  Run:

  ```bash
  npm test -- packages/domain/src/permissions.test.ts packages/mcp-contract/src/index.test.ts apps/api/src/file-upload-authorization.test.ts apps/api/src/routes/evidence.test.ts apps/api/src/routes/quarantine-certificates.test.ts apps/api/src/routes/structured-import/structured-import.test.ts apps/api/src/routes/structured-partitions/routes.test.ts apps/api/src/mcp/upload-tools.test.ts apps/api/src/mcp/http.test.ts apps/mcp-launcher/src/session.test.ts apps/mcp-launcher/src/launcher.test.ts
  ```

- [ ] **Step 2: run repository-wide gates once on the final tree**

  Run:

  ```bash
  npm run format:check
  npm run lint
  npm run typecheck
  npm test
  npm run test:integration
  npm run test:mcp
  npm run build:release
  npm --workspace smedc-mcp-launcher run test:package
  ```

  Do not add a Prisma migration; fail review if one appears without a separately explained schema need.

- [ ] **Step 3: clean and audit the final diff**

  Remove run-owned `.data`, containers, volumes, networks, and clean inactive test worktrees; run `git worktree prune`. Verify `git diff --check`, no secrets or `.env`, no synthetic credentials, no generated uploads, and no historical-report rewrites.

- [ ] **Step 4: prepare the enforcement PR handoff with composition report**

  Report scope, exact launcher publication evidence, tests, no database migration, no environment-variable change, hard-cut behavior, audit limitation, and known exclusions. Include approximate inserted/deleted lines by production/config, runtime/CI/deploy, tests/harnesses, docs/plans/reports, and lockfile. Flag the design and implementation plan as user-requested process artifacts.

- [ ] **Step 5: merge in release-safe order**

  Merge the main enforcement/synchronization PR only while `0.5.2` is public and verified. Merge the standalone Skill PR as part of the same synchronization window. Confirm main quality gates invoke the canonical staging deployment; do not run an ad-hoc deployment unless explicitly authorized for recovery.

- [ ] **Step 6: verify the staging hard cut**

  After deployment, confirm public metadata recommends `0.5.2` and accepts minimum `0.5.0`. Use one direct/backend employee probe for each upload surface to verify canonical 403, one safe audit event, and no DB/storage/partition residue. Verify an older compatible launcher cannot bypass the backend.

- [ ] **Step 7: run the focused official manual acceptance**

  Follow `skills/smedc-manual-test/SKILL.md` and `docs/implementation/official-manual-acceptance.md`. Use fresh synthetic employee-clearance-0, employee-clearance-3, and admin-clearance-0 accounts. The human alone completes password setup links. Use separate natural-language Codex tasks, prove local employee denial before file access, exercise every admin positive family including Delivery Ledger XLSX, prove high-level employee read and low-clearance admin ordinary-read denial, then run official cleanup.

- [ ] **Step 8: verify zero staging residue and record evidence**

  Confirm run-scoped DB rows, OSS objects, Qdrant points, multipart sessions, local extracts, and all three synthetic accounts are removed. Record deployed SHA, launcher version, audit evidence summary, acceptance result, and cleanup counts in `staging-readiness.md` and one concise progress milestone.

- [ ] **Step 9: remove merged worktrees**

  After both repositories are merged and clean, remove their inactive worktrees and run `git worktree prune`. Never force-remove a dirty or active worktree.

---

## Completion Criteria

- All three upload tools remain visible and state `admin` is required; tool names/input schemas are unchanged.
- Launcher `0.5.2` caches only the five approved fields, upgrades v1 records lazily, clears profile with the credential, and rejects employees before local file work or upload network calls.
- Every direct HTTP upload or upload-advancement endpoint independently denies employees before upload-specific parsing or side effects.
- MCP denies employees before upload validation/decoding/delegation and writes exactly one safe backend audit event.
- Denied audit rows contain only actor/org, `uploadSurface`, `admin_role_required`, and existing provenance; Delivery Ledger is covered by `structured_dataset` without pre-auth dataset parsing.
- Partition abort/status/manifest and all ordinary reads retain their existing owner/organization/clearance semantics.
- A clearance-0 admin can upload level 2 but cannot ordinarily read it; a clearance-3 employee can read eligible level-2 data but cannot upload.
- Historical data and issued OSS URLs are untouched; there is no schema/data migration or dynamic tool discovery.
- Launcher `0.5.2` is published before server recommendation and both Skill pins move to it; minimum remains `0.5.0`.
- Focused, full, integration, MCP, package, and staging acceptance gates pass, and all run-owned local/staging test residue is removed.
