# SMEDC MCP Launcher

Official stdio MCP launcher for authenticated uploads, authorized queries and verified local downloads. Source candidate `0.17.0` replaces 13 permission and enterprise workflow tools with six and advertises 50 tools in total. Use the official `smedc-mcp` Skill for the approved installation pin and consult `docs/implementation/staging-readiness.md` for verified package and service rollout status.

## Installation and identity

Use the dual-homed `smedc-mcp` Skill for exact current-user installation, host configuration, login, recovery and removal. Supported OS platforms are macOS, Windows and Linux with Node.js 22+. Never install an implicit npm `latest` or make the launcher self-update.

The only service configuration is `SMEDC_BASE_URL`, a canonical HTTPS origin. Commands are `serve`, `self-check`, `logout` and `--version`. Credentials are never accepted through arguments, environment variables or MCP input.

Login uses OAuth Device Authorization. The employee authenticates and confirms the agent instance on the first-party page; protocol credentials remain inside the launcher. An available OS secure store protects the durable credential. A headless host without one uses memory-only custody and requires login after process restart; a denied/broken desktop store is not a reason to write secrets to ordinary files.

## Current tool behavior

- Permission cards and admin configuration use current server state. Grants are not cached. Writes carry the current expected version; conflicts require rereading state.
- Active admins upload. Cached profiles provide an early denial before local file access; the service remains authoritative. The cache holds display name, email, role, clearance and organization name only. Current-user lookup reads live state.
- Evidence uploads require explicit category, complete scopes and file level. Photos require one enterprise and exact store. Fixed-category uploads cannot override enabled server category levels with a legacy level field.
- Business/dishes/in_store_orders/takeaway_orders local file uploads use launcher-owned multipart transport. Status is polled by job ID; accepted uploads are not completed processing. Each category requires compatible published client/service support and its current independent grants.
- In-store orders require complete store-day snapshots for the declared source scope: `settled_only` or `all_statuses`. The launcher preserves original rows/statuses without filtering, and the 31-column CSV retains all 30 source fields plus ordered payment JSON, including duplicate items, refunds and change. Only present store-days replace current content. Replacing a different or unknown scope requires the service's exact version-bound transition preview and confirmation. Historical unknown scope remains `legacy_unknown`; existing clients retain documented omission compatibility until explicit enterprise cutover. See the core Skill `references/in-store-orders.md` for upload, permissions and local cleanup.
- Takeaway orders require complete store-day snapshots covering all platforms and source valid orders. The canonical CSV has exactly 33 source fields, preserving statuses, signed amounts, text IDs and duplicate rows. See `references/takeaway-orders.md` in the core Skill for release prerequisites and workflow.
- Range partition download is the default. Optional prepared ZIP download uses prepare, status and then a succeeded requestId, with no selectors mixed into that final call. Confirm matching service support; tools/list alone is insufficient. Verify scope, ZIP/CSV integrity and safe paths before returning local extracts. Internal signed partition URLs never reach the agent.
- Ledger tools expose coverage, preparation, request status and URL issuance. They do not generate PDFs; changed/missing outputs wait for the configured daily service job. PDF delivery is independently enabled on the target service.
- Atomic structured `upsert_store_reviews` and authorized `query_store_reviews` require matching service support. They use JSON MCP calls, with no file transfer or worker. The stdio input budget accepts a full review batch; query pages bound escaped response bytes for default MCP clients. Enterprise candidates come from current permission cards; only verified published platform replies are recorded.
- Store reviews preserve verified platform `replyStatus` facts and support `replyStatuses` filtering. Legacy writes preserve valid status or downgrade contradictions to `needs_verification`; explicit contradictory states fail atomically. Drafts and approvals remain outside service records. Confirm the matching service rollout and tenant configuration before use.
- Optional exact platform `feedbackId` participates in review identity and query filters, returning the original ID or null for legacy rows. Same-minute reviews with different IDs remain separate. Legacy/ID identity conflicts require explicit reconciliation; the service never auto-binds old rows. The matching service migration and release are required.
- Enterprise workflow tools manage versioned configuration previews, designated installations, leased runs and durable action intents/receipts. Actual schedules, browser sessions, mail connections and business execution belong to the user's local workflow host; configuration save does not activate execution. Capability/version checks, readiness and explicit handoff remain required.
- No tool accepts arbitrary API paths or SQL. Account/tenant authorization, safe status views and content access remain distinct server contracts.

Business MCP calls have a 45-second deadline; connection/profile calls have 30 seconds. Downloads enforce request/stall limits, a 240-second invocation budget and bounded whole-file retries; cancellation removes incomplete output. Multipart progress counts transport-consumed bytes, with a 30-second stall deadline while progressing transfers may continue.

## Diagnostics and logout

`self-check` returns safe version/origin/platform/store/server/MCP status and never logs in or reveals a credential. `smedc_get_current_user` returns only the current user's display identity and role/clearance/organization name; `smedc_auth_status` does not expose cached identity.

`logout` attempts remote family revocation and local credential deletion, reporting `remoteRevocationConfirmed` and `localCredentialRemoved`. Removing one host's MCP entry is distinct from logout or complete uninstall.

Package releases use npm Trusted Publisher; verify the particular release and provenance in the repository readiness record. Source, API schemas and full usage guidance remain in the product repository and official Skill; this README does not authorize publishing, deployment or tenant activation.
