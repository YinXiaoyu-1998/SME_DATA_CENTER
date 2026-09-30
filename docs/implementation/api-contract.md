# 企业资料中枢 API / MCP Contract

Last updated: 2026-09-24

## Authorization model

Every non-health endpoint is authenticated by the backend. An authenticated account has two
independent, explicitly provisioned properties:

- `role`: exactly `admin` or `employee`; this controls File Upload Capability and explicitly
  declared privileged administrative operations (PAOs).
- `clearance`: an integer from `0` through `3`; it controls ordinary reading of documents and
  anything derived directly from them.

Every document has immutable `confidentialityLevel` from `0` through `3`. On an ordinary
read/query/download/status path the service requires the employee to be active, in the same
organization, and to have `clearance >= confidentialityLevel`. This applies uniformly to evidence,
source downloads, quarantine-certificate queries, structured rows, aggregates, coverage, metadata,
counts, source IDs, cursors, and errors.

`admin` does not imply a higher clearance and never bypasses an ordinary read. A disabled account
cannot call either ordinary or privileged operations. No label, store, personal, user, or role-based
document visibility exists.

## Confidentiality declaration

The three upload routes accept optional `confidentialityLevel` multipart/MCP input. It defaults to
`0` only when omitted. Valid values are integers `0`, `1`, `2`, and `3`.

An active admin may declare any level regardless of their own clearance. The service and its agents must
not infer a level from a filename, content, surrounding context, or an apparent source lineage. A
file newly uploaded after external editing is a new document with the level explicitly supplied for
that upload. The product has no endpoint to reclassify a document or edit an employee's clearance.

## Privileged administrative operations

A PAO is named in the product/API as `admin`-only. It may affect documents at any confidentiality
level without granting the caller ordinary read access. The current PAO is
`archive_quarantine_certificates`:

- an admin can archive quarantine certificates by `receiptId`, or by `sourceDocumentId`, without a
  confidentiality comparison;
- the original uploader can archive a single certificate by `sourceDocumentId` as a normal owner
  operation;
- a PAO response returns operational results only and does not make a document readable through
  search, query, status, or download.

File uploads separately require admin as specified below. `GET /audit` is removed; internal audit
logging remains an implementation concern.

## File Upload Capability

Only active `admin` accounts may upload; an `employee` is denied at every clearance, including 3.
Authentication precedes the role check, which precedes parsing, schema validation, local file access
in the launcher, hashing, storage, and upload side effects. Direct HTTP upload endpoints return
transport status `403`. MCP JSON-RPC transport remains HTTP `200`, with a tool result carrying
`isError: true`. Both use the canonical error code `UPLOAD_ADMIN_REQUIRED`, message
`File upload requires the admin role.`, and `retryable: false`. Re-login, retries, or higher
clearance cannot grant upload permission.

| Upload entry point                                      | MCP tool / transport                                                       | Denied audit `uploadSurface` |
| ------------------------------------------------------- | -------------------------------------------------------------------------- | ---------------------------- |
| `POST /v1/documents/evidence`                           | `upload_evidence_document`                                                 | `evidence_document`          |
| `POST /v1/structured/imports`                           | `upload_structured_dataset`, including Delivery Ledger (`delivery_ledger`) | `structured_dataset`         |
| `POST /v1/documents/quarantine-certificates`            | `upload_quarantine_certificate`                                            | `quarantine_certificate`     |
| `POST /v1/structured/partition-uploads`                 | `business`/`dishes` create                                                 | `structured_dataset`         |
| `GET /v1/structured/partition-uploads/:jobId/parts`     | partition part URLs                                                        | `structured_dataset`         |
| `POST /v1/structured/partition-uploads/:jobId/complete` | partition complete                                                         | `structured_dataset`         |

Partition owner abort (`DELETE /v1/structured/partition-uploads/:jobId`) remains allowed for an
employee owner. Status, manifest, read, search, query, and download are not made admin-only; their
existing organization, owner, and clearance checks still apply. Admin upload above the admin's
clearance does not make later ordinary reads succeed.

Upload tools remain statically visible and marked admin-only. Launcher 0.6.0 rejects a known
employee profile before reading/transforming a local file; unknown profiles are lazily resolved.
The cached profile is exactly `displayName`, `email`, `role`, `clearance`, `organizationName`;
`smedc_get_current_user` continues to read live server state. A local denial creates no backend
audit. Backend denials best-effort record `file_upload.denied`, with actor, organization, safe
request provenance, reason, and transport-level `uploadSurface` only; no upload metadata/content
is parsed for auditing, and audit failure cannot change the denial.

The recommended launcher is exactly 0.6.0 and minimum compatibility is 0.6.0. Older
launchers are rejected with `LAUNCHER_UPGRADE_REQUIRED` before OAuth issuance. This change adds no historical
migration, OSS URL invalidation, or mid-transfer downgrade handling. Existing attribution and
read access remain intact. Future scheduled/connector/service identities need a separate design,
not impersonation of an admin Employee Account; workers and operator utilities are outside this
employee-callable upload boundary.

## Public HTTP surface

| Method         | Path                                               | Purpose                                                                           |
| -------------- | -------------------------------------------------- | --------------------------------------------------------------------------------- |
| `GET`          | `/healthz`                                         | Liveness                                                                          |
| `GET`          | `/.well-known/oauth-authorization-server`          | OAuth discovery and launcher compatibility metadata                               |
| `GET` / `POST` | `/oauth/*`                                         | Browser authorization, token, and revoke flows                                    |
| `GET` / `POST` | `/auth/password/setup/*`                           | Password setup/reset bootstrap and form                                           |
| `POST`         | `/mcp`                                             | Authenticated Streamable HTTP MCP                                                 |
| `GET`          | `/me`                                              | Current user: display name, email, role, clearance                                |
| `GET`          | `/skills`                                          | Approved skill-directory metadata                                                 |
| `POST`         | `/v1/documents/evidence`                           | Upload MD/TXT/DOCX evidence                                                       |
| `GET`          | `/v1/documents/evidence/:documentId/status`        | Uploader-visible evidence processing status                                       |
| `POST`         | `/v1/evidence/search`                              | Search readable evidence chunks                                                   |
| `POST`         | `/v1/documents/quarantine-certificates`            | Upload one JPG/JPEG/PNG certificate                                               |
| `POST`         | `/v1/quarantine-certificates/query`                | Query readable certificates by receipt IDs                                        |
| `POST`         | `/v1/quarantine-certificates/archive`              | Owner archive by source ID or admin-only PAO archive                              |
| `POST`         | `/v1/source-documents/:documentId/download-url`    | Issue a readable source-file download URL                                         |
| `POST`         | `/v1/structured/imports`                           | Upload row-query datasets (`vip`, catalogs, ledgers); rejects `business`/`dishes` |
| `GET`          | `/v1/structured/imports/:importBatchId`            | Readable structured-import status                                                 |
| `POST`         | `/v1/structured/partition-uploads`                 | Create a multipart `business`/`dishes` upload session                             |
| `GET`          | `/v1/structured/partition-uploads/:jobId/parts`    | Get a bounded page of multipart part URLs                                         |
| `POST`         | `/v1/structured/partition-uploads/:jobId/complete` | Verify and queue a completed source upload                                        |
| `DELETE`       | `/v1/structured/partition-uploads/:jobId`          | Abort an unfinished source upload                                                 |
| `GET`          | `/v1/structured/partition-imports/:jobId`          | Read partition import status                                                      |
| `POST`         | `/v1/structured/partition-manifests`               | Resolve an authorized date/store manifest                                         |
| `GET`          | `/v1/structured/datasets`                          | Dataset schema discovery                                                          |
| `POST`         | `/v1/structured/query`                             | Controlled, readable structured query                                             |
| `GET`          | `/v1/structured/datasets/:dataset/coverage`        | Readable source coverage                                                          |

`GET /labels` and `GET /audit` are not registered. `GET /readyz` accepts loopback only.

## Upload fields and limits

All uploads retain existing file/type/size validation. The common request fields are:

| Route                            | Required business fields                                                   | Confidentiality field                            |
| -------------------------------- | -------------------------------------------------------------------------- | ------------------------------------------------ |
| Evidence                         | `file`, `title`; optional `sourceSystem`                                   | optional `confidentialityLevel`, defaults to `0` |
| Quarantine certificate           | `file`, `receiptId`, `idempotencyKey`                                      | optional `confidentialityLevel`, defaults to `0` |
| Row-query structured import      | `file`, `dataset`, `enterpriseName`, `idempotencyKey` and dataset metadata | optional `confidentialityLevel`, defaults to `0` |
| Business/dishes partition source | multipart session metadata, then ordered upload-part ETags                 | optional `confidentialityLevel`, defaults to `0` |

The decoded inline file limit is 50 MiB. The official launcher streams local `business`/`dishes`
paths through multipart storage, with a 2 GiB default source limit. Filenames, titles, idempotency keys, receipt IDs, structured
metadata, evidence filters, cursors, and structured-query limits retain their existing public
limits. Label keys and label arrays are not accepted.

## MCP surface

MCP contracts mirror the HTTP boundary. `smedc_get_current_user` returns exactly `displayName`,
`email`, `role`, `clearance`, and `organizationName`. The former `smedc_list_labels` tool is absent. The three upload tools accept
optional numeric `confidentialityLevel`; callers must not fabricate it based on content. The
`archive_quarantine_certificates` MCP tool is the declared admin-only PAO.

`business`/`dishes` upload, partition-import status, and local partition download require official
launcher `0.4.0` or newer. Older or missing launcher versions receive
`LAUNCHER_UPGRADE_REQUIRED`; in particular, the service never returns partition presigned URLs
through an older launcher's generic MCP proxy.

MCP and launcher clients must never expose credentials, tokens, organization IDs, or raw service
infrastructure. Cursor continuation is bound to the current organization, employee, clearance,
query shape, filters, limit, and retrieval configuration.

### Evidence search response

`POST /v1/evidence/search` and `search_document_evidence` return authorized chunks in `results[]`
and one `sources[]` entry per distinct document represented on that page, in first-result order.
Each source entry includes `sourceDocumentId`, title/file metadata, `downloadStatus`, `downloadUrl`,
and `expiresAt`. Available attachment links expire after 24 hours. An issuance, storage, or audit
failure is represented as `downloadStatus: "unavailable"`, null link fields, and the warning
`SOURCE_DOWNLOAD_URL_UNAVAILABLE`; one failed source does not suppress other links or results.

The `retrieval` object includes retrieval, embedding, lexical, and rerank versions/status plus
`relevance.{policyVersion,cutoffReason,droppedCount}`. Pagination remains under `page`, and the
service never generates the final answer. Evidence search exposes its source links without an
extra download-tool call. The explicit source-download endpoint/tool remains available to refresh
an expired URL and for structured rows or quarantine certificates whose source was not returned by
evidence search.

## Migration and retrieval payloads

The one-way migration maps legacy `manager` accounts to `admin`, assigns existing accounts
clearance `3`, assigns existing documents level `0`, and deletes legacy label tables/data. Existing
Qdrant vectors without a confidentiality payload are treated as level-0 candidates only; the
database revalidator checks the authoritative document level before reranking or response output.

## PDF Evidence Extension

A compatible deployed PDF service admits original `.pdf`/`application/pdf` evidence through the
existing admin-only upload contract. It also requires enabled PDF admission, authenticated parser
readiness and verified compatible rollback state. Disabled/unready admission returns safe typed
503 (`PDF_UPLOAD_DISABLED`, `PDF_SERVICE_UNAVAILABLE`, `PDF_ROLLBACK_FLOOR_UNVERIFIED`) without
creating an object or queued job. Format/header disagreement is rejected. Existing non-PDF flows
and authorized original downloads retain their contracts.

PDF status adds nullable `parsing: {schemaVersion:1,pageCount,pages,complete,tableCount,pictureCount,
warnings}` from the persisted index. Physical page outcomes are parsed/blank/image_only/failed.
Only complete successful parsing is activated. Status remains uploader-only and clearance checked.
Evidence search accepts `filters.fileTypes:["pdf"]`; each visible source may expose `pageNumbers`,
full `sourceLocations` (1-based physical pages, normalized bbox, native/OCR and block/table fields),
warning objects and `pdfTable` (tableId,rowStart,rowEnd,rowIds,cellOrigins, optional long-row
continuation). The legacy single `pageNumber` is populated only for a single represented page.
Internal paths/parsed object keys are never public. Existing `sources[]` links download the original
PDF with the same organization/clearance checks and 24-hour attachment policy. Image references
preserve regions and recognized text; the first release generates no picture-semantic descriptions.

Launcher 0.7.0 implements the compatible bundled contract and named `SMEDC_CREDENTIAL_PROFILE`
namespace; it is currently unpublished. Approved Skill pins and server recommendation stay 0.6.0
until publication and independent verification. A named profile is local credential/lock isolation,
never an organization or authorization selector. Self-check adds safe `credentialProfile`; the
isolated PDF manual profile refuses default credentials and uses exact controller cleanup.
