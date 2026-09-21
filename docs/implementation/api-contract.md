# 企业资料中枢 API / MCP Contract

Last updated: 2026-09-21

## Authorization model

Every non-health endpoint is authenticated by the backend. An authenticated account has two
independent, explicitly provisioned properties:

- `role`: exactly `admin` or `employee`; this controls only product operations explicitly
  declared as privileged administrative operations (PAOs).
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

The caller may declare any level regardless of their own clearance. The service and its agents must
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

There are no other admin-gated employee-facing endpoints. `GET /audit` is removed; internal audit
logging remains an implementation concern.

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

MCP contracts mirror the HTTP boundary. `smedc_get_current_user` returns role and
clearance. The former `smedc_list_labels` tool is absent. The three upload tools accept
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
