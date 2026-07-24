# Local MCP Endpoint Design Decisions

> **Current-implementation scope:** this document records the Phase 3 local/development endpoint and
> launcher behavior. Its development-email login and memory-only session are not the official user
> login design and must not constrain it. See
> [`official-user-install-and-login.md`](./official-user-install-and-login.md).

Last updated: 2026-07-24

## Purpose

Record the decisions made while designing a network-reachable Enterprise Hub MCP endpoint for local development. This document is the working decision record for the implementation plan; it is not a service-operations runbook.

For end-to-end user-facing request flows, including cold agent startup, login,
upload, status, and search paths, see
[mcp-user-flow.md](./mcp-user-flow.md) and
[mcp-user-flow.zh.md](./mcp-user-flow.zh.md).

## Confirmed Scope

- Add a network-reachable MCP endpoint to the locally running Enterprise Hub service.
- Keep the existing Phase 3 evidence and structured-data tool surface and backend authorization boundary.
- Do not start Phase 4 go-online, staging deployment, production SSO/OAuth, or service-operations work.
- The MCP endpoint must not start, stop, initialize, repair, seed, migrate, or otherwise operate API, worker, database, Qdrant, storage, or other background services.

## Current Baseline

- The user-side MCP launcher is a local stdio adapter in `apps/mcp-launcher`. It delegates business tool calls to the service's HTTP MCP endpoint and stores the development token only in process memory. This is pre-cutover current code, not the official remote launcher contract.
- Launcher runtime configuration accepts only `ENTERPRISE_HUB_BASE_URL`; the implemented service `POST /mcp` endpoint is hard-loopback only in Phase 3.
- The only available login mechanism is development login with a seeded employee email. Remote employee authentication and SSO/OAuth are not implemented.
- The HTTP API exposes authenticated, stateless Streamable HTTP at `POST /mcp`; the service has no stdio MCP adapter.

## Decision Status

- The local Phase 3 endpoint, launcher, and shared tool contract are implemented. This document records the decisions and constraints that govern that implementation.
- ADR: [0020-local-streamable-http-mcp-endpoint.md](../adr/0020-local-streamable-http-mcp-endpoint.md) records the significant transport, authentication, and network-exposure choice.

## Decisions

### Endpoint Hosting

- Decision: Mount the HTTP MCP endpoint on the existing Fastify API listener at `/mcp`.
- Rationale: This keeps MCP and HTTP API calls in one locally operated service, shares backend authorization and request infrastructure, avoids a second process/port, and gives local development the same connection shape intended for a future remote deployment.
- Consequence: The API application owns MCP transport lifecycle and session handling. The skill/client connects to the endpoint; it does not start a separate MCP service.

### HTTP MCP Transport

- Decision: Expose only the MCP Streamable HTTP transport at `/mcp`; do not implement the legacy SSE transport.
- Rationale: The installed MCP SDK already supports Streamable HTTP. A single standard endpoint avoids the legacy SSE multi-route compatibility surface and keeps the local connection shape suitable for a later remote service.
- Consequence: The endpoint follows Streamable HTTP request, response, and stateless-session semantics. Client configuration starts the user-side stdio launcher, which appends `/mcp` to `ENTERPRISE_HUB_BASE_URL` internally.

### MCP Transport Session Mode

- Decision: Use stateless Streamable HTTP. Do not issue or require MCP transport session IDs.
- Rationale: The employee bearer token remains the sole authentication credential and backend authorization remains authoritative on every tool call. A local MCP session ID would add a second state handle without providing required continuity, and would introduce restart, stale-session, invalidation, leakage, and replay failure modes.
- Consequence: A valid bearer token is required on every MCP request. API restart does not require MCP session recovery; a client retries with its still-valid bearer token. Stateful/resumable transport behavior is deferred until a concrete product need exists.

## Working Decisions Pending Final Review

### Local HTTP MCP Authentication Bootstrap

- Decision: Before connecting to `/mcp`, the launcher calls the existing development-login API through its launcher-local login tool and sends the resulting bearer token in the `Authorization` header on every `/mcp` request.
- Decision: Remove `enterprise_hub_login_dev` with the service stdio adapter. HTTP `/mcp` exposes no login tool; launcher-local login performs bootstrap.
- Security boundary: Bearer tokens must not be returned by MCP tools, included in MCP errors or logs, or made model-visible. Token possession only authenticates the transport request; backend authorization remains authoritative for every tool action.

### Local Credential Storage and Header Injection

- Decision: Store the local development bearer token only in the launcher process memory. Logout and launcher exit clear it. No Keychain, file, MCP configuration, environment variable, or command-line persistence is used.
- Decision: The launcher injects the in-memory token into every remote MCP initialize, notification, and tool request. Never place the raw token in skill files, normal MCP configuration, logs, tool arguments, tool results, environment exports, or command-line arguments.
- Failure behavior: Missing, expired, revoked, mismatched, or inaccessible credentials fail closed as unauthenticated; they never cause anonymous MCP access.
- Compatibility requirement: Client MCP configuration contains only the endpoint URL and the launcher/adapter reference. Verify each supported client integration against its actual version; the endpoint contract must not depend on an unverified Codex-specific mechanism.

### Local Development Login Entry Point

- Decision: Provide launcher-local `enterprise_hub_login_local(email)` and `enterprise_hub_logout_local()` tools. Login accepts a seeded employee email, calls development login internally, and retains the returned token only in launcher memory.
- Boundary: Direct development-login API calls are an internal bootstrap implementation detail, not the normal agent or user workflow. Normal Enterprise Hub use remains MCP-only after bootstrap.
- Security constraint: The helper must never print, return, log, or place the raw token in ordinary configuration or model-visible context.
- Launcher contract: The companion launcher reads its in-memory token at tool-call time and adds it to every `/mcp` request. It must not ask an agent or user to paste a token.

### Unauthenticated Recovery Contract

- Decision: Missing, expired, revoked, or locally inaccessible credentials return a model-safe `EMPLOYEE_AUTH_REQUIRED` response with `retryable: false`, a request ID, and a remediation action of `RUN_LOCAL_LOGIN_HELPER`.
- Model-visible remediation: Instruct the user to run the Enterprise Hub local login helper and authenticate with a seeded employee email. Explicitly instruct the agent and user not to paste a bearer token into chat or MCP configuration.
- Login-helper output: On success, return only authentication status, authenticated employee email, API URL, and credential-stored status. On failure, return a stable safe code such as `LOCAL_LOGIN_FAILED` and retryability. The helper never prints, echoes, requests, or returns a raw token, token fragment, credential-store path, or employee labels.
- Compatibility: If backend token validation yields a more specific safe existing unauthenticated code, preserve it; do not disclose credential diagnostics beyond the contract.

### Service-Unreachable Recovery Contract

- Decision: Connection refusal, DNS/host failure, response-before-timeout failure, and service-unavailable responses are classified as `ENTERPRISE_HUB_UNREACHABLE`, not as authentication failures.
- Model-visible remediation: State that Enterprise Hub is not reachable at the configured URL and instruct the user to start or check the Enterprise Hub service outside the MCP client.
- Boundary: The MCP skill, HTTP adapter, endpoint, and local login helper must never start Docker, launch the API or worker, initialize/seed/migrate databases, repair Qdrant/storage, or otherwise operate Enterprise Hub services.
- Login-helper behavior: If development login cannot reach the API, return the same unreachable classification. Authentication-specific failures retain `EMPLOYEE_AUTH_REQUIRED` or a safe `LOCAL_LOGIN_FAILED` response.

### Client Configuration Contract

- Decision: Publish a client-neutral HTTP MCP connection contract: endpoint URL, `Authorization` header name, `Bearer <employee-token>` value shape, approved secure token-source requirement, and unauthenticated/forbidden error behavior.
- Decision: Do not commit or generate ordinary MCP configurations, examples, or skill content containing a raw token.
- Client guidance: Codex, Claude, OpenClaw, and other clients receive adapter recipes only. Each recipe must use that client's supported secret-injection mechanism to send the same bearer header.
- Support boundary: A client that cannot dynamically obtain a token from secure storage or a user-controlled secret provider is unsupported for HTTP `/mcp` in this phase unless an external, model-invisible wrapper/launcher performs the header injection.
- Verification requirement: Validate each claimed client recipe against the actual client version before documenting it as supported; do not infer support from the endpoint protocol alone.

### MCP Endpoint URL Contract

- Decision: The explicit client endpoint variable is `ENTERPRISE_HUB_MCP_URL`.
- Launcher behavior: normalize `ENTERPRISE_HUB_BASE_URL` and append `/mcp` internally (for example, `http://127.0.0.1:3000` becomes `http://127.0.0.1:3000/mcp`).
- Validation: In this local-only phase, an explicit MCP URL must be absolute `http://` with path exactly `/mcp` (normalizing only a terminal `/mcp/`). Do not silently rewrite other paths. Reject `https://` with stable `MCP_HTTPS_NOT_SUPPORTED_LOCAL_PHASE`; TLS, certificates, reverse proxies, and remote deployment are Phase 4 work.
- Mismatch: If both variables are set and the explicit value differs from the normalized derived value, fail fast with stable `MCP_URL_API_URL_MISMATCH`; do not guess an authority.

### HTTP MCP File Transfer

- Recommendation: HTTP MCP upload tools receive only client-selected file bytes plus filename, declared media type, and existing upload metadata. They must not accept or dereference a client `filePath`.
- Adapter boundary: `/mcp` converts the explicit bytes into the existing backend upload API request format. It does not validate file type, size, metadata, workbook structure, permissions, persistence, processing, or audit semantics itself.
- Security rationale: The HTTP endpoint never reads an arbitrary path from the server host or assumes it can access the client filesystem.

### Inline Upload Size Policy

- Working decision: The decoded file size must be no greater than `MAX_UPLOAD_BYTES` (currently 50 MiB by default).
- Enforcement: Set the `/mcp` Fastify body limit to at least `ceil(MAX_UPLOAD_BYTES * 4 / 3)` plus a bounded JSON-envelope allowance, and reject over-limit requests before MCP parsing with HTTP `413` and `MCP_REQUEST_TOO_LARGE`.
- Enforcement: Before and after base64 decoding, the MCP upload handler verifies that the payload cannot and does not exceed `MAX_UPLOAD_BYTES`. Violations return non-retryable `MCP_INLINE_FILE_TOO_LARGE` with the maximum decoded byte count.
- Final authority: The existing backend upload API continues to enforce `MAX_UPLOAD_BYTES`; equivalent backend size failures retain a stable MCP machine-readable error.

### Local Resource Protection

- Decision: Implement bounded in-process protections for this local phase, not a production rate-limiting platform.
- Request parsing: Enforce the `/mcp` body limit before JSON/MCP parsing and reject over-limit bodies with `413 MCP_REQUEST_TOO_LARGE`; reject malformed input early as non-retryable protocol failures.
- Concurrency: Cap active `/mcp` tool invocations with a small configurable in-process limit. On saturation, reject before invocation with retryable `503 MCP_BUSY`; never retain an unbounded in-memory queue.
- Upload memory: Preflight encoded Base64 length, decode only into bounded buffers after that check, verify decoded size, and release buffers after forwarding or failure.
- Downstream work: Use finite API timeouts, propagate request IDs, and map dependency timeout/failure according to the error-boundary rules.
- Disconnects: Bind an abort signal to request-scoped work; where practical cancel downstream work/upload forwarding and always release request-scoped state and buffers. `/mcp` does not independently write business audit records.

### Transport-Neutral Upload Tool Contract

- Decision: Core upload tools accept only an explicit transport-neutral file-byte payload with filename, declared media type, and upload metadata.
- Decision: `filePath` is not part of any supported MCP tool contract. Every client supplies the explicit transport-neutral file-byte payload.
- Security boundary: Core business handlers never dereference filesystem paths. HTTP cannot read server-local files, and shared upload behavior has one validation path before delegation to the backend API.

### Inline File Input Shape

- Decision: The shared upload-tool input contains `file: { name, mediaType, encoding: "base64", contentBase64 }` and the existing business `metadata` fields.
- `name`: Required bounded basename only; reject empty names, `.`/`..`, and path separators.
- `mediaType`: Required declared MIME type and treated as metadata only; the backend remains authoritative for actual type/content validation.
- `encoding`: Required literal `base64`. `contentBase64` is required canonical base64 with no whitespace or data-URI prefix and optional padding only at the end. Reject invalid encoding before backend delegation with a stable non-retryable validation code.
- Decoded content must be non-empty and conform to the existing decoded-byte limit.
- Exclusions: No URI, remote URL, resource reference, multipart, chunking, or `filePath` alternative belongs in this phase's shared tool schema. The HTTP adapter may use multipart only internally to call the existing backend upload API.

### Error Boundary and Retry Semantics

- Decision: HTTP status represents whether the request was accepted as a valid MCP transport/protocol request. Business tool failures use normal MCP response framing after acceptance.
- Transport failures: malformed MCP JSON/envelope returns `400`; unsupported method or media type returns `405` or `415`; oversized body returns `413`; pre-invocation temporary overload returns `503`. Each response includes a stable machine-readable code and `retryable` flag.
- Business failures: Shared API-to-MCP mapping preserves stable validation, permission, not-found, conflict, upload, and query-limit codes. Validation, permission, not-found, and conflict are non-retryable; backend transient failures are retryable.
- Client rule: Retry only failures explicitly marked retryable. HTTP `200` alone never proves business-tool success.

### Endpoint Observability and Authoritative Audit

- Decision: `/mcp` adds structured transport-envelope observability; existing backend per-operation audit remains the authoritative record of data access, authorization decisions, uploads, and searches.
- Transport fields: Record request ID, transport name, endpoint, HTTP method/status, duration, request/response sizes, authentication outcome, safe loopback client metadata, MCP request ID, selected tool name, downstream stable error code, `retryable`, and returned backend operation identifiers where available.
- Redaction: Never log authorization headers, bearer tokens, credential-like token hashes, cookies, raw MCP bodies, tool arguments, query text, file bytes/base64, evidence snippets, structured rows, employee labels, permission scopes, hidden-resource identifiers, payload-bearing stack traces, or potentially sensitive filenames.
- Correlation: Accept `X-Request-Id` only when it is bounded and well-formed; otherwise generate one. Return it in every response, attach it to the request-scoped MCP invocation context, forward it to backend API calls, and persist the same value in authoritative backend audit records.

## Required Verification Gates

- Protocol: Integration coverage proves valid single and batch JSON-RPC requests; malformed JSON/envelopes fail at the transport boundary; no session ID is required or issued; and no server-initiated notification route is exposed.
- Authentication and authorization: Test missing/malformed/invalid token, correct employee mapping, disabled employees, and both forbidden and hidden-resource backend semantics without bypassing backend authorization.
- HTTP-only service contract: Assert that `/mcp` exposes the complete supported core tool list, schemas, and API-error-to-MCP-error mapping. Assert that no service-side stdio adapter, `enterprise_hub_login_dev` tool, session-file dependency, or `filePath` input remains in the supported product surface; launcher stdio remains the client-to-launcher transport.
- Upload: Assert HTTP never dereferences `filePath`, forwards valid bytes to the backend API, rejects oversized bodies with `413 MCP_REQUEST_TOO_LARGE`, rejects oversized decoded payloads with `MCP_INLINE_FILE_TOO_LARGE`, preserves backend size failures, and leaves type/metadata validation backend-authoritative.
- Exposure: Assert loopback binding by default; blocked `/mcp` on every non-loopback listener with no escape hatch; `405` plus `Allow: POST` for unsupported methods; and no permissive browser CORS response.
- Errors: Assert transport failures use non-2xx HTTP with stable `retryable`; accepted tool failures use MCP framing; validation, authorization, not-found, and conflict are non-retryable; and backend transients are retryable.
- Isolation: Execute concurrent requests for separate employees and verify no token, employee identity, label, request ID, bytes, or API-header leakage. Verify aborted or failed requests neither poison other requests nor retain request-bound state.
- Regression and redaction: Preserve backend API authorization/upload/query coverage, remove obsolete stdio coverage and commands, and assert endpoint logs never include bearer tokens, raw file bytes, raw tool arguments, or sensitive result payloads. Before merge run `npm run lint`, `npm run typecheck`, `npm test`, and the relevant MCP/API integration suites.

## Component Ownership Boundaries

- API service: Owns `/mcp` hosting, request authentication/context, resource guards, existing backend API delegation endpoints, and authoritative authorization/audit. It does not trust client filtering, expose raw credentials, or operate service lifecycle through `/mcp`.
- Shared MCP business-tool layer: Owns core tool names, schemas, transport-neutral inputs, backend API delegation, and shared API-error mapping. It does not read filesystem paths, retain credentials, authorize independently, start services, or duplicate backend validation.
- No stdio adapter: Enterprise Hub exposes no stdio MCP server, local session store, `enterprise_hub_login_dev` tool, or `filePath` upload contract after this migration.
- Local login helper: Owns development credential bootstrap using a seeded email, approved secure storage, and safe status/remediation. It never prints tokens, writes ordinary MCP configuration or skill content, or starts/initializes/repairs/seeds/migrates services.
- Dual-homed Enterprise Hub skill: Owns client/user guidance for endpoint URL, supported authentication expectations, safe remediation, and secret-free tool-use examples. It does not contain credentials, solicit tokens in chat, perform lifecycle operations, or become a business/authorization layer.

### HTTP MCP Authentication Contract

- Decision: `/mcp` accepts `Authorization: Bearer <employee token>` as its sole cross-client authentication contract.
- Decision: Require that bearer authentication for every `/mcp` request, including MCP initialization, tool discovery, and every tool invocation. Do not expose an unauthenticated protocol-discovery subset.
- Rationale: This makes the endpoint transport-neutral across MCP clients while retaining the existing employee-account authorization model. MCP transport state, client identity, and tool inputs are not authorization sources.
- Error behavior: Missing, malformed, expired, or invalid token returns the existing unauthenticated response. A valid token without permission returns forbidden where appropriate; hidden resources retain the API's existing non-leaking not-found or empty-result behavior.

### Employee Token Reuse

- Decision: Reuse the existing employee bearer token for local `/mcp`; do not issue an MCP-specific token class.
- Rationale: The employee account is the sole permission subject. Reusing its token keeps token validation, disabled-employee checks, revocation behavior, audit semantics, and backend authorization centralized across HTTP API and MCP.
- Future compatibility: A future SSO/OIDC issuer may replace development token issuance without changing the `/mcp` bearer-token contract. The backend must validate that the token audience is acceptable for Enterprise Hub API/MCP access.

### HTTP-Only MCP Transport

- Implemented: The service-side stdio adapter and `enterprise_hub_login_dev` were removed; Enterprise Hub exposes service MCP only through the local Streamable HTTP `/mcp` endpoint.
- Rationale: The product has not launched this interface. A single HTTP transport gives agents, skills, tests, and operators one unambiguous connection model and prevents the temporary stdio bridge from becoming a second permanent product surface.
- Migration consequence: Existing service stdio configuration, `mcp:dev`, local-file `filePath` convenience, and local session-file handling are removed. They are replaced by `mcp:launcher`, launcher-local login, in-memory header injection, and inline-byte upload contract. Launcher stdio is only between its local MCP client and itself; no service fallback transport remains.
- Shared layer: A single `coreAuthenticatedToolRegistry` owns every business tool, schema, backend delegation, and API-error-to-MCP-error mapping for HTTP. No stdio-only registry or business behavior remains.

### Local Compatibility Policy

- Decision: Use a local-stable, additive-first contract while this remains pre-Phase-4 work.
- Protocol: Support the Streamable HTTP protocol version negotiated by the installed MCP SDK. Unsupported negotiation fails fast with a stable non-retryable protocol error; legacy SSE is not retained.
- Tools: Core HTTP business-tool names and schemas are stable. Prefer new optional fields; removing/renaming fields or changing their meaning requires an explicit local breaking-change note.
- Errors: Machine-readable `code`, `retryable`, and safe-detail shapes are part of the local contract. Add codes only when a client can take a different action, and do not change existing meanings without a breaking-change note.

### Request-Scoped HTTP Invocation Context

- Decision: Authenticate every `/mcp` HTTP request before dispatch, then create a short-lived invocation context containing the validated employee authentication context and token-bound API delegation client.
- Decision: Discard the invocation context when the HTTP request ends.
- Security constraint: Bearer tokens, employee identities, labels, and authenticated `McpServer` dependencies must not be module-global, singleton, or cached cross-request state. A globally shared MCP server is safe only for immutable tool definitions; authenticated execution state is request-scoped.

### Stateless Runtime Lifecycle

- Decision: Build and reuse only immutable registry definitions, schemas, static error mapping, logger/metrics handles, validators, and non-authenticated infrastructure at process start.
- Decision: For every accepted `/mcp` request, construct a request ID, validated employee context, token-bound API delegation client, cancellation signal, and any `McpServer` or Streamable HTTP transport state required by the SDK.
- Cleanup: Dispose request-bound transport/server state after the response completes or aborts, cancel downstream calls on client disconnect where practical, and do not retain tokens, employee labels, tool arguments, file bytes, or MCP messages after completion.
- Concurrency: Requests are independent and may run concurrently. Shared outbound connection pools are permitted only for non-authenticated state and receive authorization headers per request.

### Local Network Exposure

- Decision: The shared API and `/mcp` listener binds to `127.0.0.1` by default in this local-only phase.
- Rationale: This keeps all local Enterprise Hub API and MCP traffic on the developer machine by default, preventing accidental LAN exposure of employee-authenticated upload, retrieval, and tool endpoints.
- Consequence: `/mcp` is available only from the local machine. Another device or container host cannot use this endpoint in this phase.

### Non-Loopback MCP Rejection

- Implemented: `/mcp` is hard-limited to loopback hosts and peers; there is no non-loopback escape hatch in this phase.
- Failure behavior: API startup rejects an explicit non-loopback listener host. The endpoint rejects a non-loopback Host header or peer address with `MCP_LOOPBACK_REQUIRED` and does not process the MCP request.
- Rationale: Backend authorization does not remove the risk of bearer tokens and MCP requests crossing a LAN in cleartext HTTP. TLS, network trust controls, and intentional network exposure belong to Phase 4.

### HTTP Method Policy

- Decision: Support `POST /mcp` only for the local stateless Streamable HTTP endpoint.
- Rationale: All MCP interactions are client-initiated request/response exchanges in this phase; there are no session-resumption or server-initiated notification requirements.
- Error behavior: `GET`, `DELETE`, and every other method return `405 Method Not Allowed` before MCP handling, with `Allow: POST` and a small machine-readable error body.

### Browser-Origin Policy

- Decision: Do not enable CORS for `/mcp` by default and do not emit `Access-Control-Allow-Origin`.
- Rationale: Native MCP clients can access the loopback endpoint without browser CORS. Preventing cross-origin browser access keeps arbitrary webpages from scripting calls to a local employee-authenticated MCP endpoint.
- Consequence: Browser use is only possible when same-origin with the local API or through an explicitly designed future browser integration; neither is part of this change.
