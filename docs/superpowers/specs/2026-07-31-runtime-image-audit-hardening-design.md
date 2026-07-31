# Runtime Image and Audit Provenance Hardening Design

**Status:** Approved for implementation planning  
**Date:** 2026-07-31  
**Branch:** `codex/runtime-image-audit-hardening-20260731`

## Purpose

Close the two remaining Major findings from the 2026-07-30 local `main` review:

1. the long-running API and worker images contain the complete development dependency tree and the
   production dependency graph has unresolved security advisories; and
2. business audit records do not reliably preserve the originating client address behind nginx,
   while request-driven authentication security events do not receive the request ID, source IP,
   and observable launcher version already defined by the accepted authentication design.

The work remains an Enterprise Hub service hardening change. It does not add employee-facing agent
behavior, reporting, dashboards, skill execution, or new business capabilities.

## Approved Decisions

- Long-running API and worker images will execute compiled JavaScript with `node`, not TypeScript
  through `tsx`.
- Complete development dependencies will remain in build/test stages only.
- Compatible Fastify, Prisma, and other dependency updates will be applied where they remove
  non-ExcelJS production findings without changing public behavior.
- ExcelJS remains the structured XLSX reader for this change. Its exact transitive advisory chain is
  a temporary, documented exception rather than a global high-severity waiver.
- The ExcelJS exception expires on **2027-01-31**. CI must fail after that date unless the dependency
  is fixed/replaced or the risk is explicitly reviewed and renewed.
- `launcherVersion` means a bounded, format-validated, client-declared version actually received by
  the service. It is not cryptographic attestation of the installed launcher.
- Browser, operator, and system events may have a null launcher version. The service must not infer
  a version from User-Agent or invent a default.
- OAuth token/refresh/revoke requests and MCP requests record launcher version when a valid version
  declaration is present.
- Client source and request metadata are propagated explicitly. Async-local global state is not used
  for the authentication core or repository boundary.
- The implementation is delivered in one main-repository PR. No standalone MCP skill change is
  required because MCP tools, inputs, outputs, installation, and employee usage do not change.

## Current Findings

### Runtime packaging

The current Dockerfile installs `npm ci --include=dev` in a shared base stage and uses:

- `npm run api:dev`, which invokes `tsx apps/api/src/index.ts`; and
- `npm run worker:dev`, which invokes `tsx apps/worker/src/dev-loop.ts`.

The resulting long-running images contain linting, formatting, test, compiler, and development CLI
packages as well as source, scripts, and fixtures that are not needed by the service process.

The 2026-07-31 locked dependency audit reported:

- full repository graph: 14 high, 5 moderate, and 1 low findings; and
- production graph: 10 high and 5 moderate findings.

The production high findings consist of the Fastify router advisory plus the ExcelJS transitive
chain. The compatible Fastify and Prisma lines have available updates. ExcelJS 4.4.0 remains the
latest npm release and pulls old `archiver`, `unzipper`, `glob`, `minimatch`, `brace-expansion`, and
`uuid` lines. Most of the apparent ExcelJS high count is propagation of one lower-level
brace-expansion denial-of-service advisory through several ancestors, not separate ExcelJS parsing
defects.

The application only reads XLSX files and already applies bounded ZIP preflight checks before
ExcelJS. Those facts reduce reachability, but they do not justify a permanent or global audit
suppression.

### Audit provenance

Staging nginx connects to the API over loopback and sets `X-Real-IP` and `X-Forwarded-For`.
Fastify currently uses its default `trustProxy: false`, so `request.ip` resolves to the immediate
loopback peer. Business audit records consequently lose the public client address.

`AuthSecurityEvent` already has nullable columns for `requestId`, `sourceIp`, and
`launcherVersion`. The accepted authentication design also names these fields. Official auth
routes currently call `AuthCore` without a request context, and transaction-owned security events
are created inside Prisma repositories, so the existing columns are normally null.

`AuditLog` already has `requestId` and `clientIp`, but it does not have first-class client-source or
launcher-version fields.

## Scope

### Included

- compiled API, worker, and staging-smoke entrypoints;
- production-only dependency installation for long-running images;
- the minimum operational files needed for Prisma migration, generated Prisma runtime, health
  checks, and staging smoke;
- compatible dependency upgrades;
- lockfile and built-image vulnerability gates;
- an expiring ExcelJS risk record and exact exception;
- restricted proxy trust and nginx forwarding-header hardening;
- bounded request ID, source IP, launcher-version, and route-derived client-source normalization;
- explicit audit context propagation through HTTP, MCP delegation, auth core, and Prisma
  repositories;
- additive `AuditLog` provenance columns and API response fields;
- tests, migration, contracts, runbooks, and progress evidence.

### Excluded

- replacing ExcelJS;
- changing XLSX validation or import semantics;
- changing OAuth grants, launcher installation, minimum launcher version, token/session lifetimes,
  or login screens;
- logging every successful access-token authentication or routine ten-minute renewal;
- IP-based throttling, CAPTCHA, a security dashboard, alerting, or employee audit history;
- trusting arbitrary proxy chains, CDNs, or public forwarding headers;
- changing MCP tools or dual-homed employee skill guidance;
- staging deployment before the PR is reviewed, merged, and reaches the normal `main` release
  workflow.

## Design 1: Runtime Image Boundary

### Build stages

The Dockerfile will separate four concerns:

1. **development dependency stage**  
   Installs the locked full workspace graph for compilation, Prisma generation, tests outside the
   image build, and release artifact creation.

2. **build stage**  
   Runs Prisma client generation and produces bundled Node.js entrypoints for:
   - API;
   - continuous worker loop; and
   - staging smoke.

   The project will use the existing tsup/esbuild approach already used by the launcher. Internal
   workspace TypeScript is bundled; third-party runtime packages and native modules remain external
   so the dependency inventory is visible to npm and container scanners.

3. **API runtime dependency stage**  
   Installs the locked production dependency graph only. Prisma CLI is retained in the API image as
   an explicit operational dependency because the accepted release boundary runs
   `compose run api ... migrate deploy` before rollout. This narrow operational dependency is not
   permission to retain the root development graph. The compatible current Prisma line must be
   used. The worker image does not receive Prisma CLI unless a verified runtime import requires it.

4. **API and worker runtime stages**  
   Copy only the applicable compiled entrypoint, production dependencies, generated Prisma runtime
   and engines, schema/migrations where operationally required, and minimal runtime OS packages.

The API command becomes a direct `node` command for the compiled API entrypoint. The worker command
becomes a direct `node` command for the compiled worker-loop entrypoint. `tsx`, TypeScript, Vitest,
ESLint, Prettier, test sources, and unrelated fixtures must not be present in either long-running
image.

The staging smoke remains callable through the release script, but executes its compiled entrypoint.
Only its synthetic fixture inputs are copied into the API release artifact. This preserves the
canonical deploy command without retaining the whole source and development toolchain.

### Operational compatibility

- The existing API host, port, health check, non-root user, environment variables, and Compose
  service names remain unchanged.
- Prisma migration remains a pre-rollout operation through the canonical deploy script.
- The worker still performs the same continuous loop and signal handling.
- Rollback continues to select the previous immutable image and never reverses a Prisma migration.
- The production artifact must be built for `linux/amd64` exactly as staging does today.

## Design 2: Dependency and Image Security Policy

### Dependency updates

Implementation will update compatible package lines that remove current non-ExcelJS findings, then
run the complete static, unit, MySQL/Qdrant, MCP, retrieval, and image checks. A major dependency
downgrade suggested mechanically by `npm audit fix` is not acceptable.

ExcelJS remains pinned at the currently approved line. No unsupported major transitive override is
introduced merely to make the scanner green.

### Exact risk register

A repository risk register will contain one ExcelJS exception entry with:

- package and dependency paths;
- advisory identifiers and severities;
- affected functionality;
- reachability analysis for the Enterprise Hub read-only path;
- existing upload authentication, size, ZIP-entry, expansion, path, duplicate-entry, row, sheet,
  and cell controls;
- reason replacement is deferred;
- owner;
- approval date;
- expiry date `2027-01-31`;
- replacement candidates, led by `read-excel-file` plus explicit OOXML policy checks; and
- instructions for early review if ExcelJS or a transitive dependency releases a fix.

The exception is machine-readable enough for the gate to match exact advisories/packages and is
also understandable to a human reviewer.

### CI and release gates

Two separate checks are required:

1. **Locked production dependency audit**
   - use the official npm registry audit endpoint explicitly;
   - fail on any critical finding;
   - fail on any high finding outside the unexpired ExcelJS exception;
   - reject unknown, broadened, or expired exception matches;
   - emit moderate findings with their risk-register status.

2. **Built-image scan**
   - scan both API and worker images for high and critical OS/library findings;
   - apply only exact, unexpired exceptions;
   - do not use a blanket `--ignore-unfixed` or global severity waiver;
   - prove the worker has no ExcelJS exception if ExcelJS is not part of its runtime dependency
     closure.

Moderate findings do not block automatically, but every retained moderate finding must record
impact, mitigation, owner, and review/expiry date. Newly introduced moderate findings without a
record fail the policy check.

## Design 3: Trusted Request Provenance

### Proxy trust boundary

Fastify will trust forwarding metadata only from the loopback nginx hop used by the accepted
staging topology:

- `127.0.0.1`;
- `::1`.

It will not use `trustProxy: true`, a hop-count-only rule, or a public-network allow-all.

nginx will overwrite, rather than append to, externally supplied client-address headers for the
current one-proxy topology. This prevents a public caller from injecting an arbitrary leftmost
`X-Forwarded-For` value. A future CDN or load balancer requires a separate explicit trusted-proxy
design and configuration change.

The public `/readyz` behavior remains correct: nginx-originated public requests resolve to the
external client IP and receive 404, while direct host-loopback readiness checks remain allowed.

### Request audit context

The API defines a small immutable context:

```ts
type RequestAuditContext = {
  requestId: string;
  sourceIp: string;
  clientSource: "http_api" | "browser_auth" | "oauth_launcher" | "mcp_launcher";
  launcherVersion: string | null;
};
```

Normalization rules:

- an inbound `x-request-id` is accepted only when it matches the bounded public correlation-ID
  syntax and storage length; otherwise the server generates a request ID;
- `sourceIp` comes from Fastify only after the restricted proxy policy is applied and is bounded for
  the existing 128-character database field;
- launcher version is accepted only as a bounded semantic-version string from the approved header;
- a missing or non-observable launcher version is null unless an existing endpoint contract already
  rejects it, such as an incompatible OAuth token client;
- client source is derived from the server route/adapter, not a public caller-supplied source name.

### MCP delegation

The outer `/mcp` request owns the authoritative IP, request ID, route-derived
`mcp_launcher` source, and observable launcher version.

The in-process HTTP delegation path must preserve that context without trusting public source
headers. If the canonical HTTP injection boundary requires headers, it will use a per-process opaque
internal marker that:

- is generated at server construction;
- is never returned, logged, stored, or configured as a secret;
- is checked before delegated provenance is accepted; and
- cannot be replaced by an external caller merely sending the same public metadata headers.

Invalid or absent internal delegation proof causes the nested request to be treated as an ordinary
HTTP API request.

## Design 4: Audit Persistence and Authentication Events

### Business audit

`AuditLog` receives additive nullable columns:

- `clientSource` (`VARCHAR(32)`); and
- `launcherVersion` (`VARCHAR(64)`).

All new business audit writes use the normalized context. Existing historical rows remain null and
are not backfilled. The admin audit response adds these two nullable fields; this is an additive
response change and does not require existing clients to send or change anything.

MCP-delegated business actions retain the outer MCP request provenance. Direct HTTP actions are
recorded as `http_api`. No authorization decision depends on these descriptive fields.

### Authentication security audit

`AuthSecurityEvent` keeps its existing schema. Official auth routes construct a
`RequestAuditContext` and pass the relevant fields explicitly into `AuthCore`. Repository methods
that create events transactionally receive the same context in their typed inputs.

Expected values:

| Event origin                                                                  | request ID | source IP | launcher version         |
| ----------------------------------------------------------------------------- | ---------- | --------- | ------------------------ |
| Browser authorization/login/password setup request                            | recorded   | recorded  | null                     |
| OAuth code exchange, refresh, or revoke with valid launcher header            | recorded   | recorded  | recorded                 |
| MCP/API authentication that discovers expiry, replay, or another event        | recorded   | recorded  | recorded when observable |
| Operator onboarding/reset/delete                                              | null       | null      | null                     |
| Timer/pruning event or another event created without an active client request | null       | null      | null                     |

Routine access-token authentication and routine successful renewal remain outside the event stream,
as already approved. No credentials, cookies, request bodies, codes, verifiers, setup secrets,
tokens, token hashes, or passwords enter audit context or persistence.

### Failure behavior

- Provenance normalization must be total and bounded; malformed optional metadata becomes null or a
  server-generated request ID rather than causing a database overflow.
- Existing endpoint validation, authentication, and OAuth error contracts remain unchanged.
- Security events that are intentionally part of an authentication transaction remain
  transactional.
- A database failure is logged internally through the unified safe error boundary and never exposes
  credentials or internal exception text.

## Migration and Rollout

1. Apply an additive Prisma migration for the two nullable `AuditLog` columns.
2. Deploy the compiled, production-only images through the normal `main` workflow.
3. Run the unchanged migration-before-rollout sequence.
4. Verify private readiness, public readiness concealment, health, official session smoke, MCP
   smoke, structured import/query, evidence upload/index/search, and cleanup.
5. Generate one direct HTTP audit, one MCP audit, one browser auth event, and one OAuth token event
   using synthetic identities/data; verify normalized provenance without printing secrets.
6. Clean all run-scoped synthetic data.

The migration is backward-compatible with the previous application because new columns are
nullable. Application rollback remains possible without reversing the migration.

## Verification

### Runtime artifact

- API and worker containers start with direct `node` commands.
- `tsx`, TypeScript, Vitest, ESLint, and Prettier are absent from long-running images.
- API migration and compiled staging smoke still work.
- Prisma client/native engines, Argon2, OSS, MySQL, Qdrant, and model-provider paths start correctly.
- Images run as the existing non-root user.

### Security gates

- production dependency policy passes only with the exact unexpired ExcelJS exception;
- a synthetic new high finding fails the gate;
- an expired or broadened ExcelJS exception fails the gate;
- unregistered moderate findings fail the policy check;
- API and worker image scans cover high and critical findings.

### Provenance and auth

- direct spoofed forwarding headers are ignored;
- one trusted nginx hop produces the real client IP;
- multiple untrusted forwarding values cannot replace the nginx-observed peer;
- direct loopback readiness is 200/503 as appropriate and public proxied readiness remains 404;
- invalid/oversized request IDs cannot overflow audit storage;
- browser events store request ID/IP with null launcher version;
- OAuth token/refresh/revoke events store the observable launcher version;
- operator/system events retain null HTTP-only fields;
- MCP-delegated business audit stores the outer IP, request ID, `mcp_launcher`, and version;
- a public caller cannot forge the internal MCP delegation source marker;
- existing API and MCP success/error contracts remain unchanged.

### Repository gates

- `npm run format:check`;
- `npm run lint`;
- `npm run typecheck`;
- `npm test`;
- `npm run test:integration` with the real local provider configuration loaded from `.env`;
- `npm run test:mcp`;
- `npm run test:phase3:golden`;
- `npm run test:phase3:perf`;
- API and worker `linux/amd64` Docker builds and scans;
- `git diff --check`.

## Documentation

Implementation updates:

- the new dependency risk register;
- staging deployment and image-build runbooks;
- official authentication security-audit wording to say launcher version is recorded when
  observable;
- API contract for additive audit response fields;
- environment inventory only if a new policy input is unavoidable;
- progress and final verification evidence.

No employee skill or standalone skill repository update is expected.
