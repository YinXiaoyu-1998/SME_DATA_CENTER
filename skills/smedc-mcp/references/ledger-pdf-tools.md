# Ledger PDF MCP Contracts

This pending capability requires launcher **0.7.0 once published** and service archive delivery
enabled. Version 0.7.0 is not published by this change. The approved installation pin remains
`smedc-mcp-launcher@0.6.0`; do not install an unpublished version or change that pin from service
metadata. A connected 0.6.0 launcher does not expose these five tools. If absent, report the
capability as pending; if the service returns `LEDGER_PDF_NOT_ENABLED`, report it as unavailable.
A later coordinated release must publish and independently verify the launcher before changing
approved installation pins. Discover tools through the host MCP integration.

## Inputs

All inputs are flat, strict objects. Do not send `orgId`, feature/force/renderer flags, filesystem
paths, binaries, or base64. Authentication determines organization and authorization on the server.

| Tool                            | Required input                                 | Optional input         |
| ------------------------------- | ---------------------------------------------- | ---------------------- |
| `describe_ledger_pdf_coverage`  | date selection                                 | `storeNames`, `cursor` |
| `refresh_ledger_pdfs`           | `storeNames`, date selection, `idempotencyKey` | none                   |
| `get_ledger_pdf_request_status` | `requestId`                                    | `cursor`               |
| `prepare_ledger_pdf_download`   | `storeNames`, date selection, `idempotencyKey` | none                   |
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
new refresh/prepare after a terminal failure or stale bundle, use a new key. Do not reinterpret
idempotency conflicts as successful completion.

## Completion, Links And Authorization

`refresh_ledger_pdfs` is admin-only. `prepare_ledger_pdf_download` packages readable existing PDFs;
it does not render or repair missing/stale PDFs. An accepted HTTP **202** response containing
`requestId` and `status` is pending. Poll `get_ledger_pdf_request_status` while `queued` or
`running`; terminal request statuses are `succeeded`, `partial_failed`, and `failed`. Inspect all
returned partition pages before claiming complete success. A partition may be `empty` (no PDF),
`failed`, or `superseded`; superseded generation is not successful fulfillment. Follow a returned
latest request reference only when visible. Do not treat partial success as a complete archive.

Status never returns download URLs or PDF bytes. After successful preparation, call
`get_ledger_pdf_download_url` for a **fresh** `downloadUrl` and `expiresAt`. The signed URL expires
in **15 minutes**; the ZIP is retained for **24 hours**. Request a fresh URL if only the signature
expired; prepare again with a new key if the ZIP expired or became stale. Return the short link
to the user without fetching, proxying, caching, or emitting binary/base64 data.

The service checks current authorization to every ledger, supplier, and certificate source for
coverage, status, preparation, and every URL issuance. Prior access or a completed request grants
no continuing permission. `unavailable`, missing, or forbidden facts reveal no hidden source IDs,
storage keys, permissions, counts, or business detail; report only the safe returned status/error.
Do not remove photos or sources to bypass a denial. Source authorization applies to the entire
published partition PDF, not a client-side filtered subset.

## Errors And Query Cutover

- `LEDGER_PDF_NOT_ENABLED`: non-retryable availability boundary; report that rollout is pending.
- `LEDGER_DETAIL_DISABLED`: do not retry detail, old cursors, or original ledger signing. Use the
  advertised aggregates or archive tools within the available capability.
- `LEDGER_PDF_NOT_READY`: retryable after waiting for an authorized refresh; preparation/download
  does not generate PDFs. Report a refresh need if the employee cannot refresh.
- `LEDGER_PDF_BUNDLE_STALE`: non-retryable for that prepared bundle; submit a new prepare request
  with a new idempotency key after the required refresh completes.
- Preserve ordinary validation, authentication, authorization, and idempotency errors. A safe
  unavailable result is not proof that no ledger exists.

When archive delivery is enabled, `delivery_ledger` detail and original CSV/XLSX signing are
closed for every role. Supported aggregates are exactly `count` (no field),
`countDistinct` on `receipt_id`, and `sum` on `purchase_amount`, scoped/grouped by `store_name`
and `purchase_date`. Other datasets are unaffected. This reference defines MCP use only; the
optional `smedc-delivery-ledger` companion owns upload/photo/refresh/download coordination.
