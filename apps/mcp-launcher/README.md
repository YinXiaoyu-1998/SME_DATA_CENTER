# SMEDC MCP Launcher

Official stdio MCP launcher for SMEDC. It reads only `SMEDC_BASE_URL`, which must
be a canonical HTTPS origin. Browser sign-in uses OAuth Device Authorization; credentials are
never accepted through command arguments, environment variables, or MCP tool inputs.

Commands: `serve`, `self-check`, `logout`, and `--version`.

Release target: `smedc-mcp-launcher@0.8.2` (`smedc-mcp-launcher --version` reports `0.8.2`).

Business tool calls wait up to 45 seconds for the remote result. Connection handshakes
and profile lookups keep their existing 30-second deadlines.
Version 0.8.2 fixes multipart uploads on new HTTPS connections by counting progress only
when the transport consumes file bytes. Progressing uploads keep their existing unbounded
duration and 30-second stall deadline.

Version 0.8.1 adds prepared partition downloads. Use `prepare_structured_partition_download`,
then `get_structured_partition_download_status`, then `download_structured_partitions`
with only the succeeded `requestId`. The launcher verifies the ZIP and each CSV against
authenticated scope metadata and returns a local extract directory and safe file summary.
Legacy date-range extracts remain supported. API requests and stalled transfers stop after
30 seconds; an invocation has a 240-second budget. Transient network/5xx failures retry
at most three whole-file attempts with 250/500 ms backoff. MCP cancellation stops transfer
and removes incomplete local output. Completed extracts retain the Python manifest layout.

All three file-upload tools remain discoverable and require the admin role. The launcher
rejects cached employee-role uploads before reading a local file or processing upload input.
For a newly established session without a cached profile, it first queries authenticated `/me` and securely caches
only display name, email, role, clearance, and organization name with the credential. Profile
lookup failures stop the upload. Logout clears the cached profile. The service remains the
authority for upload authorization, including when a local cache has been modified.

The `serve` command exposes the authenticated `smedc_get_current_user` tool so an
employee can confirm the current SMEDC display name, email, and role without exposing
credentials or accepting a selector for another account.
This tool always reads the live service profile; `smedc_auth_status` does not reveal the cache.

`self-check` writes one safe JSON object with `ok`, `launcherVersion`, `serviceOrigin`, `platform`,
`secureStore`, `server`, and `mcp` fields. `logout` always attempts local cleanup and writes
`remoteRevocationConfirmed` and `localCredentialRemoved` booleans. Neither command writes
credential contents.

This public package has no npm provenance because the source repository is private.

Ledger PDF tools in 0.7.0:

- `describe_ledger_pdf_coverage`: select real `YYYY-MM-DD` dates or an inclusive
  `startDate`/`endDate` range, with optional exact `storeNames` and opaque `cursor`.
  Pages contain at most 200 facts.
- `prepare_ledger_pdf_download`: submit explicit stores/dates and `idempotencyKey`
  to bundle existing authorized PDFs. Missing or stale PDFs await the service's daily
  03:00 Asia/Shanghai generation; employee agents cannot trigger generation.
- `get_ledger_pdf_request_status`: poll the returned `requestId` to terminal status;
  optional `cursor` reads the next page. A queued 202 response is not completion.
- `get_ledger_pdf_download_url`: after ZIP readiness, exchange `requestId` for a
  service-signed short-lived ZIP URL. The service reauthorizes each issuance.

Public scopes accept at most 50 exact stores, 366 dates, and 5,000 actual partitions
counted by the service. They reject organization selectors and render/download flags.
The launcher returns service JSON and signed links; it does not generate ledger files
or return base64 PDF contents. Coverage, status, and link issuance have read-only
annotations; ZIP preparation advertises idempotent side effects. Uploads and photo
changes record changed dates for scheduled generation; they do not generate PDFs immediately.

This version requires a coordinated service rollout for the ledger PDF endpoints.
An older service may reject the new tools or return `LEDGER_PDF_NOT_ENABLED` (503).
`LEDGER_DETAIL_DISABLED` directs clients to the PDF workflow. For
`LEDGER_PDF_NOT_READY`, wait for scheduled service generation, then recheck coverage;
`LEDGER_PDF_BUNDLE_STALE` requires a new preparation request. Existing validation,
permission, and idempotency errors retain their service semantics. The release target
above does not indicate that 0.8.2 has been published.
