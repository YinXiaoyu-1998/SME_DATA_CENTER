# Admin-only file upload design

Status: accepted design; implementation pending  
Base branch: `main`  
Design branch: `codex/admin-only-file-upload-design`

## Goal

Only an active Employee Account whose Functional Role is `admin` may introduce a new file into
SMEDC. An `employee` account must not be able to upload evidence, structured datasets, quarantine
certificates, or any future file kind, regardless of whether the transport is an HTTP multipart
request, an MCP tool, or a direct-to-object-storage multipart session.

This changes upload authorization only. It does not change confidentiality clearance, document
classification, ordinary-read authorization, organization boundaries, or the disabled-account
rule.

## Current upload surface

| File family                                         | Public tool / client path                                    | Backend path                                                              |
| --------------------------------------------------- | ------------------------------------------------------------ | ------------------------------------------------------------------------- |
| Evidence (`md`, `txt`, `docx`)                      | `upload_evidence_document`                                   | `POST /v1/documents/evidence`                                             |
| Delivery ledger (`delivery_ledger`, `csv`/`xlsx`)   | `upload_structured_dataset`                                  | `POST /v1/structured/imports`                                             |
| Other row-query structured datasets (`csv`, `xlsx`) | `upload_structured_dataset`                                  | `POST /v1/structured/imports`                                             |
| Current partition datasets (`business`, `dishes`)   | `upload_structured_dataset`; launcher streams the local file | create/list-parts/complete/abort under `/v1/structured/partition-uploads` |
| Quarantine certificates (`jpg`, `png`)              | `upload_quarantine_certificate`                              | `POST /v1/documents/quarantine-certificates`                              |

The HTTP API is the security boundary. MCP tool availability and Skill guidance may improve the
user experience but cannot replace backend authorization.

## Resolved decisions

### Upload authorization is independent of confidentiality clearance

The admin-only rule does not alter the accepted separation between Functional Role and
Confidentiality Clearance. An active admin may classify a new upload at any supported level 0–3,
including a level above the admin's own clearance. That upload does not grant the admin ordinary
read access to the resulting document, status, rows, partitions, search results, metadata, or
download. Existing Organization Boundary and Confidentiality Clearance checks continue to govern
those reads.

### No special revocation for an in-flight partition transfer

The design assumes an account will not lose the admin role in the middle of a multipart partition
upload. Already issued OSS presigned part URLs remain usable until their normal expiry; the role
change path does not enumerate or revoke upload sessions, abort OSS multipart uploads, or add a
new coordination mechanism. Normal authenticated upload endpoints still enforce the caller's
current role when invoked.

### Upload tools remain discoverable for every role

The launcher continues to publish the three upload tools for every authentication state and role.
Their titles/descriptions and the dual-homed base Skill identify upload as admin-only, while every
backend upload entry point independently enforces the role. The launcher does not add dynamic tool
enable/disable behavior or `tools/list_changed` coordination. Its cached-role preflight prevents a
known employee account from invoking the remote upload path, while unknown state is resolved from
the service and backend authorization remains authoritative.

### Authenticated employee-role upload attempts use one typed denial

Every upload entry point returns HTTP `403` with code `UPLOAD_ADMIN_REQUIRED`, message
`File upload requires the admin role.`, and `retryable: false` for an active authenticated
employee-role caller. MCP preserves that API error code and retryability. The authorization order
is unauthenticated `401`, disabled-account denial, then the admin-role requirement. The role gate
runs before multipart parsing, file validation, hashing, object-storage mutation, import/session
reservation, or any other upload side effect.

### Historical uploads keep their existing read and audit semantics

The policy is prospective and requires no compatibility-state or ownership migration. Documents,
import batches, partitions, processing records, and uploader attribution created before rollout
remain unchanged. Employee-role accounts may continue to use status, search, structured query,
manifest, metadata, and download capabilities exactly where the existing Organization Boundary
and Confidentiality Clearance rules permit. Replaying an old upload request or idempotency key is
still an upload attempt and is denied before idempotency lookup.

### Publish launcher 0.5.2 for admin-only tool descriptions

All three upload-tool descriptions explicitly state that the operation requires the `admin` role.
Because the official launcher bundles these descriptions, publish and independently verify
`smedc-mcp-launcher@0.5.2` before updating server recommended-version metadata and the repo-local
and standalone Skill pins. Tool names and input schemas do not change. Older compatible launchers
remain safe because backend authorization is authoritative, so the minimum compatible launcher
version does not increase.

### Persist denied employee-role upload attempts without parsing the upload

An authenticated employee-role denial appends a best-effort `audit_logs` row with action
`file_upload.denied`, result `denied`, actor, organization, upload family, reason
`admin_role_required`, request provenance, client source, and launcher version. It does not parse
or store filenames, titles, business dates, receipt IDs, multipart fields, file bytes, or other
upload metadata. Audit persistence failure is logged but cannot change the authorization result or
allow upload processing to continue.

Only requests that reach a backend upload entry point create this audit row. A request prevented
by Skill guidance or the launcher's local role gate is a client-side prevention, not a server-side
authorization denial, and does not generate a database audit record.

### Cache the authenticated profile and gate locally before file access

Launcher 0.5.2 stores a server-derived authenticated employee self-profile alongside its durable
credential in the operating-system secure store (or the existing memory-only session on hosts
without one). The upload handlers check the cached role before reading, encoding, or hashing a
local file and return `UPLOAD_ADMIN_REQUIRED` locally for an employee profile. Unknown profile
state fails closed and must be resolved from the service; logout, credential invalidation, and
account replacement clear the profile. Existing launcher credential records without a profile are
accepted and upgraded lazily. Backend upload authorization remains mandatory and authoritative,
so editing or corrupting local state cannot grant File Upload Capability.

The cached self-profile is a versioned explicit object containing only `displayName`, `email`,
`role`, `clearance`, and `organizationName`. It excludes employee ID, organization ID, disabled
state, credentials, tokens, and unknown future `/me` fields. Adding a cached field requires an
explicit local-record schema change; the launcher never persists arbitrary response properties.

### Roll out as an immediate hard cut

Staging has no real users or real business data, so the release provides no employee-role upload
grace period, compatibility state, session migration, or data repair. From deployment onward an
employee-role caller cannot create or advance an upload. Previously issued partition presigned
URLs keep their ordinary expiry but cannot be completed or queued by an employee; unfinished
temporary state follows normal cancellation or expiry cleanup. Existing read/status behavior is
unchanged.

### Internal processing is not an Employee Account upload

The admin-only rule covers every employee-callable HTTP, MCP, and launcher upload path. Workers
continue to process already authorized queued work without impersonating an admin. Reindex,
migration, test-fixture, deployment, and cleanup operations keep their existing operator/runtime
boundaries and cannot be exposed as an employee upload bypass. Any future scheduled synchronization,
external connector, or service-account ingestion requires a separately designed service identity,
authorization boundary, and audit model; it neither inherits nor impersonates the admin Functional
Role.

### Cached profile does not replace the live current-user tool

`smedc_get_current_user` continues to call the authenticated service and return the live public
self-profile. It never answers from launcher cache. An unavailable service produces the existing
unavailable outcome rather than presenting cached data as current identity. The cached profile is
limited to launcher-side upload preflight and future uses that receive their own explicit design.

## Authorization matrix

The admin gate applies to operations that introduce bytes or advance an unfinished upload. It does
not turn read, status, download, or cleanup operations into admin functions.

| Surface                                                           | Admin role required | Reason                                                                           |
| ----------------------------------------------------------------- | ------------------- | -------------------------------------------------------------------------------- |
| `POST /v1/documents/evidence`                                     | Yes                 | Introduces a new evidence file.                                                  |
| `POST /v1/structured/imports`                                     | Yes                 | Introduces a new CSV/XLSX row-query source.                                      |
| `POST /v1/documents/quarantine-certificates`                      | Yes                 | Introduces a new certificate image.                                              |
| `POST /v1/structured/partition-uploads`                           | Yes                 | Creates an unfinished direct-to-OSS upload.                                      |
| `GET /v1/structured/partition-uploads/:jobId/parts`               | Yes                 | Issues URLs that advance the byte transfer.                                      |
| `POST /v1/structured/partition-uploads/:jobId/complete`           | Yes                 | Commits the bytes and queues processing.                                         |
| OSS `PUT` through an already issued presigned URL                 | No new check        | The URL remains valid until its normal expiry by explicit decision.              |
| `DELETE /v1/structured/partition-uploads/:jobId`                  | No new admin gate   | Owner-scoped abort is cleanup and must remain available.                         |
| Status, manifest, query, search, metadata, and download endpoints | No new admin gate   | Existing organization, ownership where applicable, and clearance rules continue. |

The three upload tools are one declared Privileged Administrative Operation family. This is not an
ordinary-read bypass: its defined privilege is creating and classifying a new upload, not reading
that upload afterward.

## Enforcement placement

The role check must be shared enough to prevent endpoint drift but remain visible at each public
boundary:

1. HTTP file routes authenticate the current account and enforce the admin gate before calling
   multipart readers or business-field validators.
2. Partition create, part-URL, and complete routes enforce it before job lookup, URL issuance,
   storage access, or state transition. Abort and status retain their current owner/read rules.
3. The HTTP MCP handler necessarily receives and parses the JSON-RPC envelope before it knows the
   tool name. Once an upload tool is identified, it enforces the role before upload-schema
   validation, encoded-size work, base64 decoding, multipart construction, or internal delegation.
4. The launcher runs its cached-profile guard before upload input validation, local file access,
   hashing, base64 conversion, partition-session creation, or remote upload calls.

All gates use the same error contract. They do not rely on tool descriptions, the Skill, cached
local state, or a caller-supplied role. A corrupted cache can cause an unnecessary local denial or
a backend call, but it cannot authorize an upload.

## Launcher profile lifecycle

The secure-store record advances from the current credential-only schema to a new explicit version
that holds the durable credential and the five-field cached profile. Successful interactive login
must resolve the live profile before upload is enabled. A legacy record with only a credential is
valid for authentication but has unknown profile state; the first upload attempt resolves `/me`,
persists the upgraded record when secure storage exists, and then applies the local role check.

Memory-only sessions retain the same profile only for the process lifetime. Logout, credential
invalidation, a detected refresh-token failure, and replacement by a newly authenticated account
clear or replace both credential and profile together. A failed profile refresh fails the upload
closed with the existing authentication/service failure as appropriate; it must not guess a role.
The ordinary `smedc_auth_status` result stays a boolean authentication status and does not expose
the cached profile. A successful live `smedc_get_current_user` response may refresh the same
five-field cache, but its returned result always comes from that live call. There is no periodic
profile-sync loop in this change.

## Audit contract

`file_upload.denied` is a single cross-family authorization event, not one action per file type.
Its safe structured metadata is limited to:

- `uploadSurface`: `evidence_document`, `structured_dataset`, or `quarantine_certificate`;
  `structured_dataset` explicitly includes `delivery_ledger`, `supplier_catalog`, `dish_catalog`,
  `vip`, `business`, and `dishes`, and deliberately avoids reading `dataset` before authorization;
- `reason`: `admin_role_required`;
- existing request provenance, client source, and launcher version fields.

The row uses the authenticated employee and organization as actor/scope. It has no document or
upload target: `targetType` is `file_upload` and `targetId` is null. It stores no
request-body-derived values. Multiple attempts are recorded independently; the existing audit
retention model is unchanged. For MCP upload denials the MCP boundary writes the event because no
delegated HTTP upload request is made. Direct HTTP denials write it at the route gate. Best-effort
audit failure is operationally logged with the request ID and never changes the 403 response.

## Delivery impact

Implementation is one coordinated release, with these workstreams:

- **Domain/API:** add the canonical error/action constants, declare the file-upload PAO family,
  add a reusable role gate plus best-effort denied-audit writer, and apply it to every matrix entry.
- **MCP contract/API adapter:** mark all upload descriptions admin-only, preserve names and input
  schemas, and reject employee upload tools before upload-specific parsing or delegation.
- **Launcher 0.5.2:** add the versioned five-field profile record and lifecycle, gate all three
  upload handlers before local work, and preserve static tool discovery.
- **Skill/docs:** update the repo-local and standalone `smedc-mcp` Skills together; update the API
  contract, official install/login guide, manual acceptance, use cases, and current domain context.
- **Tests:** move positive uploader fixtures to admin, add focused employee denials and side-effect
  assertions at HTTP/MCP/launcher boundaries, and keep ordinary-read/clearance regressions.
- **Release:** merge and publish the launcher, independently verify the published package, then
  update server recommended-version metadata and both Skill pins before deploying the backend hard
  cut and running the focused staging acceptance.

Historical plans, handoff logs, benchmarks, and completed acceptance reports keep their original
facts. They may say that an employee uploaded a file in an earlier release and must not be rewritten
as if the historical run used an admin.

## Risks and deliberately excluded work

- Old compatible launchers do not have the local guard, but backend enforcement still denies them.
- A known employee is normally stopped locally, so the persistent audit is evidence of backend
  attempts, not a complete count of user intent.
- MCP HTTP must parse the containing JSON request before tool authorization; the guarantee is that
  it performs no upload-specific validation, decoding, or side effect before the role gate.
- Already issued presigned URLs remain bearer capabilities until expiry; this is accepted and no
  role-change revocation mechanism is added.
- No database migration, historical ownership rewrite, compatibility state, grace period, dynamic
  discovery, new UI, profile refresh scheduler, service account, connector, or unattended import is
  part of this change.

## Acceptance matrix

Full manual acceptance keeps three fresh synthetic accounts but changes upload ownership:

| Account                 | Upload expectation                                                                                                                                                                         | Read/administrative expectation                                               |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------- |
| `employee`, clearance 0 | One ordinary upload request is rejected locally with `UPLOAD_ADMIN_REQUIRED` before file access.                                                                                           | Existing low-clearance reads remain available.                                |
| `employee`, clearance 3 | Does not perform positive uploads.                                                                                                                                                         | Can ordinarily read eligible level-2 material uploaded by the admin.          |
| `admin`, clearance 0    | Positively exercises evidence, row-import CSV/XLSX, partition `business`/`dishes`, and quarantine-certificate uploads; proves default level 0 and explicit level 2 above caller clearance. | Cannot ordinarily read level-2 material; retains the named admin archive PAO. |

Automated coverage proves every backend upload family returns the typed employee denial before
storage, hashing, reservation, or queue side effects; reached-backend denials create safe audit
rows; launcher-local denials do not read the file or create a server audit; admin success,
idempotency, validation, and failure behavior remain intact; and legacy credential records without
a cached profile upgrade safely. Existing tests and integration flows that currently use an
employee as their successful uploader move to an admin fixture while retaining focused negative
employee cases.

## Design status

The product decisions are aligned. Remaining work is implementation and release execution; no open
product-design question blocks the change.
