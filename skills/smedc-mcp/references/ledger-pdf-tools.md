# Ledger PDF MCP Contracts

Launcher **0.20.0 is published and independently verified**. The approved installation pin is
`smedc-mcp-launcher@0.20.0`; use the core Skill's approved installation flow. For local bundle
delivery, verify matching service deployment and discover the tool in the host's local `smedc`
integration. Verify that
service archive delivery is enabled. On `LEDGER_PDF_NOT_ENABLED`, report that archive delivery is
unavailable. Do not generate PDFs locally or change service flags.

## Inputs

All inputs are flat, strict objects. Do not send `orgId`, feature/force/renderer flags, filesystem
paths, binaries, or base64. Authentication determines organization and authorization on the server.

| Tool                            | Required input                                 | Optional input         |
| ------------------------------- | ---------------------------------------------- | ---------------------- |
| `describe_ledger_pdf_coverage`  | date selection                                 | `storeNames`, `cursor` |
| `get_ledger_pdf_request_status` | `requestId`                                    | `cursor`               |
| `prepare_ledger_pdf_download`   | `storeNames`, date selection, `idempotencyKey` | none                   |
| `download_ledger_pdf_bundle`    | `requestId`                                    | none                   |
| `get_ledger_pdf_download_url`   | `requestId`                                    | none                   |

Date selection is exactly one of `dates: ["YYYY-MM-DD", ...]` or both `startDate` and `endDate`.
Use real calendar dates, years 1000–9999. Ranges are ordered and include both endpoints.
An explicit array has 1–366 entries; a range spans at most 366 dates. `storeNames` has 1–50 entries,
each nonblank and 1–512 characters; preserve each exact name, including surrounding whitespace.
Only coverage may omit stores. The server caps each scope at **5,000 actual partitions**; do not
infer that limit from the Cartesian product alone. Coverage pages contain at most **200** facts;
return `nextCursor` unchanged with the same scope. Status also exposes `partitions` and
`nextCursor`; follow continuations for the same request. Cursor length is 1–4,096 characters,
request ID length 1–128, and idempotency key length 1–255.

Reuse an idempotency key only for the exact same operation and scope. For a changed scope or a
new preparation after a terminal failure or stale bundle, use a new key. Do not reinterpret
idempotency conflicts as successful completion.

## Completion, Links And Authorization

`prepare_ledger_pdf_download` packages readable existing PDFs; it does not render or repair
missing/stale PDFs. The service automatically updates affected daily PDFs after applied ledger
imports or successful photo changes. Employee agents cannot trigger generation, including admins.
After uploads reach `applied`, confirm data ingestion and explain that the PDF will be available
once its automatic update completes; use coverage to establish actual readiness. Keep internal
scheduling details out of user-facing replies. Do not promise an immediate PDF, infer a fixed run
time or a completion window such as “within 24 hours”, or repeatedly submit downloads to trigger it.
Only quote a completion window when explicitly provided by the service. Internal operator CLI
backfill/recovery is outside this employee MCP workflow. An accepted HTTP **202** response containing
`requestId` and `status` is pending. Poll `get_ledger_pdf_request_status` while `queued` or
`running`; terminal request statuses are `succeeded`, `partial_failed`, and `failed`. Inspect all
returned partition pages before claiming complete success. A partition may be `empty` (no PDF),
`failed`, or `superseded`; superseded generation is not successful fulfillment. Follow a returned
latest request reference only when visible. Do not treat partial success as a complete archive.

Status never returns download URLs or PDF bytes. When local delivery is available, call
`download_ledger_pdf_bundle` for local files: the launcher resolves the signed link itself, verifies the archive,
extracts the daily PDFs, and returns `localDirectory`. The extracted PDFs are ordinary
deliverables — open them, quote them, forward them, or process them further as the employee asks.

If local delivery is unavailable or the employee wants a clickable download, call
`get_ledger_pdf_download_url` and give the employee the fresh
`downloadUrl` and its `expiresAt`. The employee opens the link. Do not fetch, proxy, cache, or
extract the ZIP from the link, or emit archive bytes as base64. The link lasts up to **15 minutes**;
the ZIP is retained **24 hours**. Request a fresh link if only the signature expired; prepare again
with a new key if the ZIP expired or became stale.

The service checks the employee's current finished-PDF authorization on coverage, status,
preparation, and every URL issuance. Prior access or a completed request grants no continuing
permission. Report only the safe returned status or error.
Do not remove photos or sources to bypass a denial. Finished-PDF authorization applies to each
whole published PDF.

## Local Bundle Download

`download_ledger_pdf_bundle` takes only `requestId`. The launcher consumes the signed link
internally and never returns it. It verifies the archive against the response `byteSize` and
`checksumSha256`, extracts
`<store>/<YYYY-MM-DD>/食品经营单位进货台帐_<store>_<YYYY-MM-DD>.pdf` entries, and returns
`localDirectory`, `requestId`, `fileCount`, and relative `files[]`, with `manifest.json`
beside them.

- Budget one call at **10 minutes**, at most **1 GiB** of PDF content plus ZIP overhead, and at most **5,000**
  PDFs. For larger scopes or timeouts, suggest splitting by store or date.
- The whole bundle is rejected before extraction when an entry is not a statutory PDF, duplicates
  or traverses a path, violates the STORE layout, or fails the size/checksum check. No partial
  output is returned.
- Once extracted, the PDFs are normal files. Forwarding them, embedding them in a report, or
  re-uploading them elsewhere is the employee's decision; this skill places no restriction on that.
- Launcher errors: `LEDGER_PDF_BUNDLE_URL_INVALID` (link missing, expired, or mismatched),
  `LEDGER_PDF_BUNDLE_VERIFY_FAILED` (archive failed validation),
  `LEDGER_PDF_BUNDLE_DOWNLOAD_TIMEOUT` (timeout), and
  `LEDGER_PDF_BUNDLE_LIMIT_EXCEEDED` (split by store/date). Service codes such as
  `LEDGER_PDF_BUNDLE_STALE` or `LEDGER_PDF_NOT_READY` keep their usual meaning.

## Errors And Query Cutover

- `LEDGER_PDF_NOT_ENABLED`: non-retryable availability boundary; report that rollout is pending.
- `LEDGER_DETAIL_DISABLED`: do not retry detail, old cursors, or original ledger signing. Use the
  advertised aggregates or archive tools within the available capability.
- `LEDGER_PDF_NOT_READY`: report a pending automatic update and retry after readiness is established;
  preparation/download does not generate PDFs. Do not request an admin refresh or use another API
  to trigger rendering.
- `LEDGER_PDF_BUNDLE_STALE`: non-retryable for that prepared bundle; submit a new prepare request
  with a new idempotency key once coverage is ready after the automatic update.
- Preserve ordinary validation, authentication, authorization, and idempotency errors. A safe
  unavailable result is not proof that no ledger exists.

Raw `delivery_ledger` details, aggregates, source coverage and original CSV/XLSX signing are
closed for every role. The readable dataset catalog omits it; this does not disable admin uploads.
Use the connected `upload_structured_dataset` contract for original receipt uploads,
`get_import_status` for application status, and `describe_ledger_pdf_coverage` for authorized PDF
readiness. Other datasets are unaffected. This reference defines MCP use only; the
optional `smedc-delivery-ledger` companion owns upload/photo/scheduled-readiness/download coordination.
