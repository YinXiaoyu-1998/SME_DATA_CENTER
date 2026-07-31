# Audit Provenance And Authentication Event Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Record the real nginx-observed client source in business audits and propagate request ID, source IP, client source, and observable launcher version through direct HTTP, MCP delegation, and request-driven authentication security events.

**Architecture:** Fastify trusts only loopback nginx peers and owns bounded request-ID generation. A small immutable `RequestAuditContext` is constructed at route adapters and passed explicitly through business/auth core and repository inputs. MCP nested HTTP injection uses a per-process opaque proof to preserve outer provenance without trusting public source headers. AuditLog gains two nullable descriptive columns; AuthSecurityEvent reuses its existing request metadata columns.

**Tech Stack:** TypeScript, Fastify 5, Vitest, Prisma/MySQL, in-process Fastify injection, nginx, Markdown.

## Global Constraints

- Trust forwarding metadata only from `127.0.0.1`, `::1`, and the IPv4-mapped loopback form already recognized by the service.
- nginx must overwrite `X-Forwarded-For` with `$remote_addr`; do not append public caller input.
- Keep `RequestAuditContext` immutable and explicit; do not add AsyncLocalStorage or global mutable request state.
- `clientSource` is one of `http_api`, `browser_auth`, `oauth_launcher`, or `mcp_launcher` and is derived by the server adapter.
- `launcherVersion` is a bounded, syntax-validated client declaration, not attestation. Record it only for OAuth launcher and MCP requests where the server actually receives it; browser, direct HTTP, operator, and system events remain null.
- Preserve all OAuth grants, minimum launcher version, tokens, cookies, MCP tools, response/error contracts, authorization decisions, and client workflows.
- Never store credentials, cookies, bodies, authorization codes, verifiers, setup secrets, tokens, token hashes, or passwords in audit context.
- Add only nullable `AuditLog` columns. Do not backfill historical rows and do not change authorization based on provenance.
- The admin audit response change is additive. No MCP contract or standalone employee skill update is required.
- Do not deploy staging from this implementation branch.

---

### Task 1: Bounded request context and restricted Fastify proxy trust

**Files:**

- Create: `apps/api/src/request-audit-context.ts`
- Create: `apps/api/src/request-audit-context.test.ts`
- Modify: `apps/api/src/mcp/guards.ts`
- Modify: `apps/api/src/mcp/guards.test.ts`
- Modify: `apps/api/src/server.ts`
- Modify: `apps/api/src/server.test.ts`

**Interfaces:**

- Produces:

```ts
export type ClientSource = "http_api" | "browser_auth" | "oauth_launcher" | "mcp_launcher";

export type RequestAuditContext = Readonly<{
  requestId: string;
  sourceIp: string;
  clientSource: ClientSource;
  launcherVersion: string | null;
}>;
```

- Produces: `normalizeRequestId`, `normalizeLauncherVersion`, `createRequestAuditContext`, `isTrustedLoopbackProxy`, and opaque-delegation-proof verification.
- Preserves: `isSafeMcpRequestId` as a re-export/adapter to the shared request-ID validator so existing MCP imports do not break.

- [ ] **Step 1: Write failing normalization and proxy tests**

Cover:

```ts
expect(normalizeRequestId("req_valid-123")).toBe("req_valid-123");
expect(normalizeRequestId("x".repeat(129))).toBeNull();
expect(normalizeRequestId("contains space")).toBeNull();
expect(normalizeLauncherVersion("0.1.0")).toBe("0.1.0");
expect(normalizeLauncherVersion("0.1.0\nforged")).toBeNull();
expect(normalizeLauncherVersion("1".repeat(65))).toBeNull();
expect(isTrustedLoopbackProxy("127.0.0.1")).toBe(true);
expect(isTrustedLoopbackProxy("::1")).toBe(true);
expect(isTrustedLoopbackProxy("198.51.100.8")).toBe(false);
```

In `server.test.ts`, inject:

- loopback peer plus `x-forwarded-for: 203.0.113.9` and expect request-derived audit IP `203.0.113.9`;
- public peer plus forged `x-forwarded-for: 203.0.113.9` and expect `198.51.100.8`;
- oversized/invalid request ID and expect a server-generated bounded `x-request-id`;
- valid request ID and expect it echoed unchanged.

- [ ] **Step 2: Run the focused tests and verify RED**

Run:

```bash
npx vitest run apps/api/src/request-audit-context.test.ts apps/api/src/mcp/guards.test.ts apps/api/src/server.test.ts
```

Expected: context helpers do not exist, Fastify ignores the trusted loopback header, and invalid general API request IDs are not normalized consistently.

- [ ] **Step 3: Implement total normalization**

Use a maximum of 128 UTF-8 bytes for request IDs and the existing structured pattern. Generate rejected/missing IDs as `req_${randomUUID()}`. Accept launcher versions only when they are at most 64 characters and match a strict semantic-version form:

```ts
const LAUNCHER_VERSION_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?$/;
```

`createRequestAuditContext` must force `launcherVersion: null` for `browser_auth` and ordinary `http_api`; it may normalize the approved header only for `oauth_launcher` and `mcp_launcher`. Bound `sourceIp` to the existing 128-character storage width.

- [ ] **Step 4: Configure Fastify-owned request IDs and proxy trust**

Construct Fastify with:

```ts
Fastify({
  logger: options.logger ?? true,
  requestIdHeader: false,
  genReqId(rawRequest) {
    return normalizeRequestId(rawRequest.headers["x-request-id"]) ?? `req_${randomUUID()}`;
  },
  trustProxy(address) {
    return isTrustedLoopbackProxy(address);
  }
});
```

Keep the response `x-request-id` hook. MCP must still reject an explicitly invalid public request ID with its existing `MCP_INVALID_REQUEST_ID` response by inspecting the raw header, even though the general Fastify ID is safe.

- [ ] **Step 5: Verify GREEN and commit**

Run:

```bash
npx vitest run apps/api/src/request-audit-context.test.ts apps/api/src/mcp/guards.test.ts apps/api/src/server.test.ts apps/api/src/mcp/http.test.ts
npm run typecheck
```

Then:

```bash
git add apps/api/src/request-audit-context.ts apps/api/src/request-audit-context.test.ts apps/api/src/mcp/guards.ts apps/api/src/mcp/guards.test.ts apps/api/src/server.ts apps/api/src/server.test.ts
git commit -m "feat(api): establish trusted request audit context"
```

### Task 2: nginx forwarding boundary and readiness behavior

**Files:**

- Modify: `deploy/staging/nginx-enterprise-hub.conf`
- Create: `apps/api/src/proxy-boundary.test.ts`
- Modify: `docs/implementation/server-runtime-prerequisites.md`

**Interfaces:**

- Produces: one-hop overwrite semantics for `X-Forwarded-For`.
- Preserves: public nginx `/readyz` concealment and direct host-loopback readiness.

- [ ] **Step 1: Write failing configuration and readiness tests**

Assert:

```ts
expect(nginx).toContain("proxy_set_header X-Forwarded-For $remote_addr;");
expect(nginx).not.toContain("$proxy_add_x_forwarded_for");
```

Use Fastify injection to prove:

- `remoteAddress: "127.0.0.1"` without public forwarding can reach `/readyz`;
- loopback plus forwarded public IP is treated as public and receives 404 from API readiness protection;
- a non-loopback peer cannot make itself loopback with forwarding headers.

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```bash
npx vitest run apps/api/src/proxy-boundary.test.ts
```

Expected: nginx currently appends caller-supplied forwarding values.

- [ ] **Step 3: Harden nginx and document the topology**

Change exactly:

```nginx
proxy_set_header X-Forwarded-For $remote_addr;
```

Keep `X-Real-IP`, `X-Forwarded-Proto`, `Host`, body limits, and the explicit nginx `/readyz` 404. Document that adding a CDN/load balancer requires a new explicit trusted-proxy list; `trustProxy: true` is not approved.

- [ ] **Step 4: Verify GREEN and commit**

Run:

```bash
npx vitest run apps/api/src/proxy-boundary.test.ts
docker run --rm -v "$PWD/deploy/staging/nginx-enterprise-hub.conf:/etc/nginx/conf.d/default.conf:ro" nginx:1.28-alpine nginx -t
```

Then:

```bash
git add deploy/staging/nginx-enterprise-hub.conf apps/api/src/proxy-boundary.test.ts docs/implementation/server-runtime-prerequisites.md
git commit -m "fix(proxy): preserve one-hop client provenance"
```

### Task 3: Additive business-audit provenance persistence

**Files:**

- Modify: `packages/db/prisma/schema.prisma`
- Create: `packages/db/prisma/migrations/20260731120000_add_audit_provenance/migration.sql`
- Modify: `apps/api/src/documents.ts`
- Create: `apps/api/src/documents.test.ts`
- Modify: `apps/api/src/evidence.ts`
- Modify: `apps/api/src/evidence.test.ts`
- Modify: `apps/api/src/structured-imports.ts`
- Create: `apps/api/src/structured-imports.test.ts`
- Modify: `apps/api/src/server.ts`
- Modify: `apps/api/src/server.test.ts`

**Interfaces:**

- Adds nullable Prisma fields:

```prisma
clientSource    String? @map("client_source") @db.VarChar(32)
launcherVersion String? @map("launcher_version") @db.VarChar(64)
```

- Replaces paired route/repository `requestId` and `clientIp` inputs with `audit: RequestAuditContext`.
- Adds nullable `clientSource` and `launcherVersion` to `AuditLogRecord` and the admin audit response.

- [ ] **Step 1: Write failing repository and response tests**

For upload, archive, labels, structured import, and evidence search, assert the repository receives:

```ts
audit: {
  requestId: "req_http_1",
  sourceIp: "198.51.100.8",
  clientSource: "http_api",
  launcherVersion: null
}
```

Assert audit-list output includes:

```ts
{
  requestId: "req_http_1",
  clientIp: "198.51.100.8",
  clientSource: "http_api",
  launcherVersion: null
}
```

Historical rows with both new fields null must still serialize successfully.

- [ ] **Step 2: Run focused tests and verify RED**

Run:

```bash
npx vitest run apps/api/src/documents.test.ts apps/api/src/evidence.test.ts apps/api/src/structured-imports.test.ts apps/api/src/server.test.ts
```

Expected: typed inputs still carry separate request fields and the response omits the new fields.

- [ ] **Step 3: Add schema and migration**

Migration SQL:

```sql
ALTER TABLE `audit_logs`
  ADD COLUMN `client_source` VARCHAR(32) NULL,
  ADD COLUMN `launcher_version` VARCHAR(64) NULL;
```

Run:

```bash
npm run db:generate
npx prisma validate --config packages/db/prisma.config.ts
```

- [ ] **Step 4: Thread `RequestAuditContext` through business repositories**

Use one context field in each write/search input:

```ts
export interface AppendAuditLogInput {
  orgId: string;
  actorEmployeeId: string | null;
  action: string;
  targetType: string;
  targetId: string | null;
  result: string;
  metadata?: Record<string, unknown> | null;
  audit: RequestAuditContext;
}
```

Map `audit.sourceIp` to existing `clientIp`, plus `audit.clientSource` and `audit.launcherVersion`. Apply the same shape to transactional document, structured import, and evidence audit writes so provenance cannot be omitted by passing only one scalar.

- [ ] **Step 5: Update direct HTTP route adapters**

For ordinary endpoints, call:

```ts
const audit = auditContextForRequest(request, "http_api");
```

and pass the entire object. At this stage direct HTTP always records null launcher version. Add the two nullable response properties in `auditEventResponse`.

- [ ] **Step 6: Verify GREEN and commit**

Run:

```bash
npx vitest run apps/api/src/documents.test.ts apps/api/src/evidence.test.ts apps/api/src/structured-imports.test.ts apps/api/src/server.test.ts
DATABASE_URL='mysql://enterprise_hub:enterprise_hub_local_password@127.0.0.1:3307/enterprise_hub' npx prisma migrate deploy --config packages/db/prisma.config.ts
```

Then:

```bash
git add packages/db/prisma/schema.prisma packages/db/prisma/migrations/20260731120000_add_audit_provenance/migration.sql apps/api/src/documents.ts apps/api/src/documents.test.ts apps/api/src/evidence.ts apps/api/src/evidence.test.ts apps/api/src/structured-imports.ts apps/api/src/structured-imports.test.ts apps/api/src/server.ts apps/api/src/server.test.ts
git commit -m "feat(audit): persist request provenance"
```

### Task 4: Unforgeable MCP provenance delegation

**Files:**

- Modify: `apps/api/src/request-audit-context.ts`
- Modify: `apps/api/src/request-audit-context.test.ts`
- Modify: `apps/api/src/mcp/http.ts`
- Modify: `apps/api/src/mcp/http.test.ts`
- Modify: `apps/api/src/mcp/api-delegation.ts`
- Modify: `apps/api/src/mcp/api-delegation.test.ts`
- Modify: `apps/api/src/mcp/tool-handlers.ts`
- Modify: `apps/api/src/mcp/tool-handlers.test.ts`
- Modify: `apps/api/src/mcp/upload-tools.ts`
- Modify: `apps/api/src/mcp/upload-tools.test.ts`
- Modify: `apps/api/src/server.ts`
- Modify: `apps/api/src/server.test.ts`

**Interfaces:**

- Adds internal-only header: `x-enterprise-hub-internal-delegation`.
- Adds `delegationProof` generated as 32 random bytes in `buildApiServer`.
- Changes MCP/tool delegation inputs to carry `audit: RequestAuditContext`.
- Preserves public MCP JSON-RPC, tool schemas, tool results, and error bodies.

- [ ] **Step 1: Write failing outer/delegated provenance tests**

Assert an outer MCP request with:

```ts
{
  remoteAddress: "127.0.0.1",
  headers: {
    "x-forwarded-for": "203.0.113.9",
    "x-request-id": "mcp_request_1",
    "x-enterprise-hub-launcher-version": "0.1.0"
  }
}
```

causes the delegated business repository to receive `mcp_launcher`, `203.0.113.9`, the same request ID, and version `0.1.0`.

Also send the public marker header directly with an incorrect value and assert the action is recorded as `http_api`, with the direct peer IP and null launcher version.

- [ ] **Step 2: Run focused MCP tests and verify RED**

Run:

```bash
npx vitest run apps/api/src/mcp/http.test.ts apps/api/src/mcp/api-delegation.test.ts apps/api/src/mcp/tool-handlers.test.ts apps/api/src/mcp/upload-tools.test.ts apps/api/src/server.test.ts
```

- [ ] **Step 3: Add per-process proof verification**

Generate once per server:

```ts
const delegationProof = options.internalDelegationProof ?? randomBytes(32).toString("base64url");
```

The optional server-construction value exists only for deterministic tests and is not loaded from environment. Verify the presented proof using equal-length buffers and `timingSafeEqual`; reject absent, malformed, or unequal values without throwing. Never return, persist, or log the proof.

- [ ] **Step 4: Carry the outer context through MCP layers**

Replace scalar provenance with:

```ts
export interface ApiDelegationContext {
  bearerToken: string;
  audit: RequestAuditContext;
  delegationProof: string;
  abortSignal?: AbortSignal;
  inject(request: ApiDelegationInjectRequest): Promise<ApiDelegationInjectResponse>;
}
```

Nested injection sends:

```ts
headers: {
  authorization: `Bearer ${context.bearerToken}`,
  "content-type": "application/json",
  "x-request-id": context.audit.requestId,
  "x-enterprise-hub-internal-delegation": context.delegationProof,
  ...(context.audit.launcherVersion
    ? { "x-enterprise-hub-launcher-version": context.audit.launcherVersion }
    : {})
},
remoteAddress: context.audit.sourceIp
```

Do not forward `X-Forwarded-For` or `X-Real-IP` inside the process. A verified proof changes nested route-derived source to `mcp_launcher`; invalid proof falls back to ordinary `http_api`.

- [ ] **Step 5: Verify GREEN and commit**

Run the Task 4 focused command again, then:

```bash
git add apps/api/src/request-audit-context.ts apps/api/src/request-audit-context.test.ts apps/api/src/mcp/http.ts apps/api/src/mcp/http.test.ts apps/api/src/mcp/api-delegation.ts apps/api/src/mcp/api-delegation.test.ts apps/api/src/mcp/tool-handlers.ts apps/api/src/mcp/tool-handlers.test.ts apps/api/src/mcp/upload-tools.ts apps/api/src/mcp/upload-tools.test.ts apps/api/src/server.ts apps/api/src/server.test.ts
git commit -m "feat(mcp): preserve outer audit provenance"
```

### Task 5: Request-driven authentication event context

**Files:**

- Modify: `apps/api/src/auth/auth-core.ts`
- Modify: `apps/api/src/auth/auth-core.test.ts`
- Modify: `apps/api/src/auth/routes.ts`
- Modify: `apps/api/src/auth/routes.test.ts`
- Modify: `apps/api/src/auth/prisma-auth-repository.ts`
- Modify: `apps/api/src/auth/prisma-auth-repository.integration.test.ts`
- Modify: `apps/api/src/auth/operator-cli.test.ts`
- Modify: `apps/api/src/server.ts`
- Modify: `apps/api/src/server.test.ts`

**Interfaces:**

- Produces:

```ts
export type AuthRequestAudit = Pick<
  RequestAuditContext,
  "requestId" | "sourceIp" | "launcherVersion"
>;
```

- Adds optional `audit?: AuthRequestAudit` only where an operation may also be invoked by an operator/system path.
- Preserves: null request metadata for operator/pruning calls.

- [ ] **Step 1: Write failing route/core tests**

Cover:

- browser login success/failure/cooldown stores request ID/IP and null version;
- password setup consumption stores request ID/IP and null version;
- authorization-code exchange/session creation stores OAuth request ID/IP/version;
- refresh invalid/replay/rotation events store OAuth request ID/IP/version;
- revoke/logout stores OAuth request ID/IP/version;
- access-token expiry/replay discovered during MCP authentication stores MCP request ID/IP/version;
- operator onboarding/reset/delete and pruning-created events keep all three fields null.

Use a fixed context:

```ts
const oauthAudit = {
  requestId: "oauth_request_1",
  sourceIp: "203.0.113.9",
  launcherVersion: "0.1.0"
};
```

- [ ] **Step 2: Run focused auth tests and verify RED**

Run:

```bash
npx vitest run apps/api/src/auth/auth-core.test.ts apps/api/src/auth/routes.test.ts apps/api/src/auth/prisma-auth-repository.integration.test.ts apps/api/src/server.test.ts
```

Expected: events are created with null request metadata.

- [ ] **Step 3: Add context to core method boundaries**

Pass `AuthRequestAudit` into request-driven methods, including login verification, password setup exchange/consumption, authorization completion/redemption, session creation, credential rotation, logout, and access-token authentication. Keep context optional only for the same operations invoked from operator/system code.

Use one helper:

```ts
function eventAudit(audit: AuthRequestAudit | undefined) {
  return audit
    ? {
        requestId: audit.requestId,
        sourceIp: audit.sourceIp,
        launcherVersion: audit.launcherVersion ?? undefined
      }
    : {};
}
```

Spread it into every event created by the affected operation, including events created transactionally inside `createSessionBundle`, `rotateDurableCredential`, token expiry/replay, and session revocation.

- [ ] **Step 4: Construct route-specific contexts**

In browser authorization/login/password routes:

```ts
const audit = authAudit(createRequestAuditContext(request, "browser_auth"));
```

In token and revoke routes:

```ts
const context = createRequestAuditContext(request, "oauth_launcher");
const audit = authAudit(context);
```

Keep the existing `426 LAUNCHER_UPGRADE_REQUIRED` behavior. The same normalized version that passes the endpoint compatibility check is the version persisted. Invalid/missing versions do not reach token business logic.

For API/MCP bearer authentication, pass the route-derived audit context to `authenticateAccessToken` so only actual authentication security events receive it; do not add routine success events.

- [ ] **Step 5: Preserve operator/system null semantics**

Do not synthesize request IDs for:

- `pruneSecurityEvents`;
- operator onboarding;
- setup/reset issuance initiated from the operator CLI;
- operator delete/session reset without an HTTP request.

Add assertions to `prisma-auth-operator-repository` tests or existing CLI tests showing stored output remains null.

- [ ] **Step 6: Verify GREEN and commit**

Run:

```bash
npx vitest run apps/api/src/auth/auth-core.test.ts apps/api/src/auth/routes.test.ts apps/api/src/auth/prisma-auth-repository.integration.test.ts apps/api/src/auth/operator-cli.test.ts apps/api/src/server.test.ts
npm run typecheck
```

Then:

```bash
git add apps/api/src/auth/auth-core.ts apps/api/src/auth/auth-core.test.ts apps/api/src/auth/routes.ts apps/api/src/auth/routes.test.ts apps/api/src/auth/prisma-auth-repository.ts apps/api/src/auth/prisma-auth-repository.integration.test.ts apps/api/src/auth/operator-cli.test.ts apps/api/src/server.ts apps/api/src/server.test.ts
git commit -m "feat(auth): record request metadata on security events"
```

### Task 6: Contract documentation and end-to-end provenance verification

**Files:**

- Modify: `docs/implementation/api-contract.md`
- Modify: `docs/implementation/official-user-install-and-login.md`
- Modify: `docs/implementation/staging-deploy-runbook.md`
- Modify: `docs/implementation/test-cases.md`
- Modify: `docs/implementation/progress.md`

**Interfaces:**

- Documents: additive audit response fields, observable-version semantics, trusted proxy topology, event-origin matrix, and synthetic verification.
- Preserves: MCP employee guidance and dual-homed skill bytes.

- [ ] **Step 1: Reconcile current contracts**

Document the admin audit response:

```json
{
  "requestId": "req_...",
  "clientIp": "203.0.113.9",
  "clientSource": "mcp_launcher",
  "launcherVersion": "0.1.0"
}
```

State that both new properties are nullable for historical/operator/system events and that `launcherVersion` is client-declared observational metadata. Add the event-origin matrix from the approved design. Do not imply version attestation or add a client requirement.

- [ ] **Step 2: Run complete static and unit gates**

Run:

```bash
npm run format:check
npm run lint
npm run typecheck
npm test
git diff --check
```

- [ ] **Step 3: Run real local integration and MCP gates**

Load the ignored real provider configuration without printing it:

```bash
set -a; source .env; set +a; MYSQL_PORT=3307 npm run test:integration
MYSQL_PORT=3307 npm run test:mcp
npm run test:phase3:golden
npm run test:phase3:perf
```

The integration/MCP assertions must create synthetic data and verify:

- direct HTTP audit has the true peer, `http_api`, and null version;
- trusted one-hop request has the forwarded public IP;
- MCP audit has outer request ID/IP, `mcp_launcher`, and `0.1.0`;
- forged internal proof cannot produce `mcp_launcher`;
- browser auth event has ID/IP and null version;
- OAuth token/refresh/revoke event has ID/IP and `0.1.0`;
- operator/system event fields are null;
- cleanup leaves no run-scoped DB/storage/Qdrant residue.

- [ ] **Step 4: Record final evidence and commit**

Update `progress.md` once with completed schema, proxy, MCP, auth, and verification evidence; explicitly state that staging was not changed and no standalone skill update was required.

```bash
git add docs/implementation/api-contract.md docs/implementation/official-user-install-and-login.md docs/implementation/staging-deploy-runbook.md docs/implementation/test-cases.md docs/implementation/progress.md
git commit -m "docs: record audit provenance verification"
```
