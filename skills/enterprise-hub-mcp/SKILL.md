---
name: enterprise-hub-mcp
description: >-
  上传和查询企业数据中枢（Enterprise Hub）中的文件与资料：当员工要求把文件/文档/表格上传到
  企业数据中枢、企业资料中枢、企业知识库或企业数据库，或想基于已上传的企业资料提问业务问题时使用。
  用户要求更新 enterprise-hub-mcp 或 enterprise-hub-mcp-skill 这个 skill 时也使用本技能。
  Also covers updating this skill from its official GitHub source and installing, configuring,
  and authenticating the official Enterprise Hub remote MCP
  launcher (api.smedatacenter.xyz); accesses Enterprise Hub through the launcher only and never exposes employee
  credentials or service infrastructure.
metadata:
  source-repository: https://github.com/YinXiaoyu-1998/enterprise-hub-mcp-skill
  source-path: skills/enterprise-hub-mcp
---

# Enterprise Hub MCP

Use Enterprise Hub only through its official remote MCP launcher. This skill is the
current-user installation and recovery runbook for an employee-owned agent; it is not a
service-operations runbook.

The approved service origin is `https://api.smedatacenter.xyz`. The approved launcher is
the exact npm package `enterprise-hub-mcp-launcher@0.2.7`. Do not substitute another
origin, package, tag, or version. In particular, never install npm `latest` and never let
the launcher update itself. This pin governs launcher installation, not fetching a newer official
copy of this skill; after a skill refresh, read the newly verified copy for its current pin.

## Update This Skill

The canonical skill name is `enterprise-hub-mcp`; `enterprise-hub-mcp-skill` is its repository
name and a recognized user-facing alias. “帮我更新 enterprise-hub-mcp-skill 这个 skill” means
refresh this skill's files from its official source. The request authorizes that local update;
do not ask which kind of update the employee means when they explicitly name the skill.

Official source: [YinXiaoyu-1998/enterprise-hub-mcp-skill](https://github.com/YinXiaoyu-1998/enterprise-hub-mcp-skill),
directory `skills/enterprise-hub-mcp/`, latest commit on the repository's default branch
(currently `main`). A marketplace listing, Enterprise Hub login, MCP connection, and an approved
new launcher pin in the old installed skill are not prerequisites for refreshing the skill.
Use ordinary Git/HTTPS and local file tools for this maintenance task.

Follow [the skill update procedure](references/update-skill.md) for source retrieval, backup,
complete-directory replacement, verification, and host reload. A skill-only update does not
authorize a launcher upgrade. For an authorized launcher update, first refresh this skill if its
pin is older than the server recommendation, then follow Official Install Or Update using the
newly verified exact pin. Never derive a new approved pin from server metadata alone.

## Hard Boundaries

- The employee enters an account password only in the Enterprise Hub browser page. Never ask
  for, accept, read, store, paste, or transmit an email/password, access token, durable
  credential, authorization code, raw `Authorization` header, or credential-store record.
- For Enterprise Hub service access, use only launcher configuration and tools. Do not call
  Enterprise Hub API endpoints directly and do not operate its API, database, Qdrant, storage,
  Docker, worker, cloud resources, or deployment.
- Do not create reports, dashboards, or final business conclusions. Return only tool-visible
  records, statuses, and evidence within the employee's backend-authorized scope.
- Do not provide an organization ID. The service derives organization and label visibility from
  the authenticated Employee Account; never infer hidden data from a forbidden/not-found result.
- The launcher stores its durable credential only in the operating-system secure store. Never
  put credentials in configuration, environment variables, arguments, ordinary files, logs, or
  chat.

## Tool Discovery

The launcher is a standard stdio MCP server. When the invoking host is configured correctly,
its Enterprise Hub tools appear in the host's native MCP tool list; the agent does not need to
discover them by hand.

- Never hand-craft JSON-RPC (`initialize`, `ping`, `tools/list`, `tools/call`) against the
  launcher process. Use the host's MCP integration and its tool list.
- The launcher registers a small stable set of `enterprise_hub_*` tools locally and proxies the
  service's business tools (upload, query, import status, evidence, and more) dynamically. The
  proxied set can change with the service; discover exact tool names from the connected host
  instead of assuming a fixed inventory.
- Call `list_structured_datasets` before using any structured dataset; use `dish_catalog`,
  `delivery_ledger`, or `supplier_catalog` only when discovery advertises it and its fields.
- In structured dataset discovery, `canonicalName` is the queryable field name. `sourceColumn` and
  `aliases` are not accepted directly by `query_structured_dataset`; use them to map the user's
  wording or source-table headers to `canonicalName`, and to choose friendly table headers when
  presenting results.
- Discovery also advertises each field's operators and capabilities. A field can be present
  without supporting every structured-query role; use only fields whose registry capabilities allow
  the intended filtering, sorting, grouping, or aggregation.
- Use `describe_structured_dataset_coverage` when the employee needs to know which uploaded
  structured sources are currently readable for a dataset before deciding whether a query is scoped
  enough. Treat coverage as source facts only, not a service-side completeness judgment.
- Discovery metadata is not an upload template. Do not rewrite, reshape, normalize, rename
  headers, duplicate receipt metadata into item rows, or generate a replacement CSV/XLSX to make a
  file match registry fields unless the employee explicitly asks for a separate local conversion
  task.
- If Enterprise Hub tools are not visible: run the pinned launcher's credential-free self-check
  (see Official Install Or Update), verify the invoking agent's MCP entry (`codex mcp list` /
  `codex mcp get enterprise-hub` or the host equivalent), reload or restart the host, then
  recheck its tool list. Only if the entry is missing or the self-check fails, follow the focused
  recovery below. Do not debug the launcher protocol or service internals.
- If a self-check reports `recommendedUpdateAvailable: true` (the server recommends a launcher
  version newer than the installed one), tell the employee a newer launcher is recommended and
  offer to update. If that update is already requested, proceed without asking again. Refresh
  stale skill guidance through Update This Skill before choosing the approved exact launcher
  version. Follow Official Install Or Update; never update silently in the background.

## Request Limits

Keep tool input within the public service contract:

- upload content is at most 50 MiB after Base64 decoding; a basename-only filename is at most 255
  characters;
- an evidence title is at most 512 characters and `sourceSystem` is at most 255 characters;
- structured `enterpriseName` and `idempotencyKey` are each at most 255 characters;
- receipt IDs and quarantine-certificate `idempotencyKey` values are each at most 255 characters;
- each label key is at most 128 characters, with at most 50 labels per upload;
- an evidence question is at most 4,000 characters; each evidence filter ID is at most 64
  characters, with at most 100 IDs in each filter group;
- an opaque cursor is at most 4,096 characters, and each structured-query string filter value is
  at most 32,767 characters.
- a structured query returns at most 200 rows or aggregate groups per page, with up to 50 selected
  fields, 2 sort fields, 4 group-by fields, 12 explicit aggregates, 20 filter conditions, 100 `in`
  values, and boolean nesting depth 3.

If a tool rejects an input at one of these boundaries, report the validation error and ask the
employee to shorten the text, reduce filters/labels, or split the source file only when that is
semantically allowed for a business-window dataset. Never split `dish_catalog`: keep one complete
snapshot and ask the employee to remove unrelated sheets/columns outside the catalog schema, use a
service-supported larger limit, or seek operator help. Never silently truncate a title, key,
query, cursor, filter value, or file.

The 50 MiB contract is the service-side ceiling. Prefer `file.encoding:"path"` uploads with the
file's absolute local path so the launcher reads the file locally and the model never emits
payload bytes; inline `file.encoding:"base64"` uploads remain subject to host tool-argument caps
(OpenAI Codex in practice caps a single model-emitted argument at about 1 MiB) — see Large
Structured Uploads.

## Upload Completion And Status Polling

Treat every text/evidence or structured-table upload response with HTTP `202` as accepted for
background processing, not as a completed upload. Keep the returned `documentId`; for a structured
upload also keep `importBatchId`. Poll `get_evidence_document_status` or `get_import_status` after
**2 seconds, then 5 seconds, then 10 seconds, then every 15 seconds**, for at most **10 minutes**.

- Tell the employee an upload succeeded only after its terminal success state: evidence is
  `active/ready`; a structured import is `importBatch.status=applied` (with the returned document
  and processing views complete). Never call a queued/pending response successful.
- On terminal `rejected` or `failed`, summarize only safe tool-returned errors and give correction
  advice, usually by asking the employee for a corrected source file or metadata. Do not silently
  rewrite and re-upload the file yourself. Never expose internal exceptions, stacks, credentials,
  or infrastructure details.
- At 10 minutes with no terminal state, report **still processing**, include the Document and
  ImportBatch IDs when present, and say the employee can check later with the corresponding status
  tool. This is not a failure.
- Do not re-upload instead of polling. Upload retries must follow idempotency rules: reuse a
  structured idempotency key only for the exact same file bytes and metadata; use a new key only
  after the employee intentionally corrects or changes the upload.

## Large Structured Uploads

When an employee asks to upload a large XLSX/CSV structured table, prefer small business-safe
chunks over one very large upload. This chunking guidance applies to business-window datasets;
never split one `dish_catalog` snapshot into multiple uploads, because every catalog upload must
be complete. Two limits apply, and the stricter one wins:

- **Service contract:** upload content is at most 50 MiB after decoding; keep structured files
  below this even when the tool schema would permit more.
- **Service performance:** treat structured files above about **5 MiB** as large even when the
  service contract permits more; for XLSX, treat anything above about **2–3 MiB** or
  **5,000 data rows** as large.

Prefer `file.encoding:"path"` uploads with the file's absolute local path: the launcher reads the
file directly, so the model never emits payload bytes and host tool-argument caps do not constrain
chunk size. Use `file.encoding:"base64"` only for small inline payloads; inline base64 remains
subject to host caps (OpenAI Codex roughly **700–750 KiB** of raw bytes per call).

- Split by a real business boundary first: date window, month/week, store, or another explicit
  non-overlapping partition that preserves row meaning. For sales/business tables, date-window
  chunks are preferred.
- Chunking is only for upload size and transport safety. Preserve business meaning and source
  headers; do not use chunking as an excuse to redesign a file into a dataset-specific template.
- Never split an XLSX by raw bytes. XLSX is a ZIP workbook; byte chunks are corrupt files. Read the
  workbook locally and write each chunk as **CSV (UTF-8, headers preserved)** whenever the target
  dataset accepts CSV: the service parses CSV chunks cheaply, while XLSX chunks go through a
  heavier workbook parse.
- If a chunk must remain XLSX, keep it small — no more than about 2–3 MiB or 5,000 data rows per
  file — and upload serially.
- Keep chunk windows non-overlapping and complete. Do not create overlapping `startDate`/`endDate`
  ranges, because structured queries aggregate all `applied` rows in visible matching windows.
- Upload chunks serially, not in parallel. After each structured upload, follow Upload Completion
  And Status Polling before starting the next chunk.
- Give every chunk its own stable idempotency key that names the original file and chunk window,
  for example `maijia-business-20240701-20240715-part01-v1`. Reuse that key only for the exact
  same chunk bytes and metadata.
- If one chunk fails or returns `service_unavailable`, stop the sequence, report the failed
  `importBatchId`/window if available, and ask whether to retry that chunk later. Do not continue
  uploading later chunks after a partial failure.
- In the final handoff, summarize the original file, each chunk filename/window, each
  `importBatchId`, and the final status so later tasks can query the intended uploaded data
  without guessing.

## Dish Catalog Snapshot Uploads

Use this path only when `list_structured_datasets` reports `dish_catalog` as available. It is a
complete, append-only menu snapshot rather than a sales/business date-window dataset.

- Call `upload_structured_dataset` with `dataset: "dish_catalog"`, `snapshotDate: "YYYYMMDD"`,
  `enterpriseName`, an existing `labelKeys` value, a stable `idempotencyKey`, and the CSV/XLSX
  file. Do not include `startDate` or `endDate`.
- Treat the uploaded file as the full directory for that date. Do not split it into CSV parts,
  upload only changed rows, use the service to merge it with another file, or describe a partial
  file as a complete catalog.
- The service validates catalog headers, sheets, and row values after upload. If validation rejects
  the upload, summarize the safe returned errors and ask for a corrected source file or explicit
  local-conversion instruction; do not pre-normalize or regenerate the catalog file from registry
  metadata.
- The organization can upload historical snapshots out of date order, but only one non-archived
  snapshot may occupy a date. For a same-date correction with different content, the existing
  snapshot must be archived through the authorized maintenance path before a new upload. Uploading
  a newer snapshot does not archive or replace older history.
- After `importBatch.status=applied`, query catalog rows through the discovery-reported
  `snapshot_date` field. Do not infer a current/latest menu, a diff, or added, removed,
  discontinued, or other cross-snapshot status.

## Delivery Ledgers And Supplier Catalogs

For `delivery_ledger` and `supplier_catalog`, call `upload_structured_dataset` with `file`,
`enterpriseName`, `idempotencyKey`, and existing `labelKeys`. Do not send `startDate`, `endDate`,
or `snapshotDate`.

- `delivery_ledger` accepts one complete CSV/XLSX delivery receipt per file. The receipt ID
  and date are extracted by the service, and each item row becomes one ledger row. Upload the
  original receipt file as provided, even when receipt-level fields appear in header rows rather
  than in the item table. Do not generate a normalized CSV with repeated receipt metadata. The
  normalized receipt ID is the organization-scoped natural idempotency key, so different content
  for the same receipt is a conflict rather than an overwrite.
- For delivery-ledger queries, use the `list_structured_datasets` registry's `canonicalName`,
  `sourceColumn`, and `aliases` instead of guessing English field names. Paper-ledger terms such as
  `进货数量`, `进货金额`, and `供货单位名称` are aliases for the matching fields; resolve them to
  `purchase_quantity`, `purchase_amount`, and `supplier_name` before querying.
- `supplier_catalog` is the current supplier snapshot used for delivery-ledger enrichment. Upload
  the provided supplier catalog file as-is; do not rewrite it locally to match registry metadata.
  The service validates required and optional columns after upload. The latest successfully applied
  snapshot is current; older history is not a fallback, and an in-progress, failed, or rejected
  upload cannot replace it.
- Keep the returned `importBatchId` and poll `get_import_status` until
  `importBatch.status=applied` before querying. A queued or pending response is not success.
- In delivery detail queries, `supplier_contact_phone` and `supplier_unit_address` are selectable
  dynamic fields only; they cannot filter, sort, group, or aggregate. They may be `null` when no
  current catalog is available or visible, no exact match exists, the source value is blank, or the
  supplier name is ambiguous. Enrichment never changes the authorized ledger page or falls back to
  an older catalog.
- Select `source_document_id` on detail-row structured queries when the employee needs the
  original uploaded receipt file. This field is not returned by default and cannot filter, sort,
  group, or aggregate.

## Quarantine Certificates And Source Downloads

Use quarantine-certificate tools only for animal quarantine certificate images that should be
linked to delivery-ledger receipt IDs. The service does not inspect whether the photo actually
looks like a certificate.

- Upload with `upload_quarantine_certificate`: provide one JPG/JPEG/PNG file, one `receiptId`, one
  stable `idempotencyKey`, and one or more existing `labelKeys`. Use `file.encoding:"path"` when
  possible. If the employee gives several photos for the same receipt, call the tool once per
  photo.
- `receiptId` is the public business key for both delivery ledgers and certificates. The service
  trims and uppercases it. Do not call it `receiptNumber`, do not treat it as a count, and do not
  require the corresponding delivery ledger to already exist.
- Query with `query_quarantine_certificates` using explicit `receiptIds` only. It returns one group
  per requested receipt ID, each with zero or more certificates. An empty group means no visible
  matching certificate; do not infer whether a hidden one exists.
- Archive with `archive_quarantine_certificates`. Use `sourceDocumentId` for a single visible
  certificate. Only admins may archive by `receiptId`, which archives all visible certificates
  under that receipt ID.
- For downloading originals, call `get_source_document_download_url` with a visible
  `sourceDocumentId`. The result is a 24-hour attachment link; return the link to the employee
  rather than fetching or proxying the file bytes yourself.

## Official Install Or Update

An employee may ask in natural language to install, update, or repair Enterprise Hub. The
employee does not need to run these commands personally. Agents should also offer an update when
a self-check reports `recommendedUpdateAvailable: true` (see Tool Discovery). Work only for the
current OS user and only on the invoking agent's configuration.

1. Confirm the host is macOS or Windows and that the user authorizes this current-user install.
   Run `node --version` and `npm --version`. Require Node.js major version **22 or newer** and a
   working npm. If Node.js is missing or older than 22, install or upgrade Node.js/npm for the
   current user before continuing; do not use administrator privileges or alter unrelated tools.
2. Use the fixed platform directory:

   | Platform | Launcher directory                                                      |
   | -------- | ----------------------------------------------------------------------- |
   | macOS    | `~/Library/Application Support/Enterprise Hub/launcher/versions/0.2.7/` |
   | Windows  | `%LOCALAPPDATA%\\Enterprise Hub\\launcher\\versions\\0.2.7\\`           |

3. Install or repair the exact package idempotently. Substitute only the platform directory
   above; do not add credentials or a global install:

   ```sh
   npm install --prefix "<launcher-directory>" --save-exact enterprise-hub-mcp-launcher@0.2.7
   ```

4. Preserve the existing installation if the same pinned package is already present. For an
   approved update, install the newly approved exact version into its own versioned directory,
   update the one launcher path in the invoking agent's MCP entry, then run the self-check.
   Updating does not delete the secure-store session or unrelated MCP servers.
5. Run the installed launcher's credential-free self-check before changing or declaring an MCP
   configuration healthy:

   ```sh
   ENTERPRISE_HUB_BASE_URL=https://api.smedatacenter.xyz \
     "$HOME/Library/Application Support/Enterprise Hub/launcher/versions/0.2.7/node_modules/.bin/enterprise-hub-mcp-launcher" self-check
   ```

   ```powershell
   $env:ENTERPRISE_HUB_BASE_URL = "https://api.smedatacenter.xyz"
   & "$env:LOCALAPPDATA\Enterprise Hub\launcher\versions\0.2.7\node_modules\.bin\enterprise-hub-mcp-launcher.cmd" self-check
   ```

   The stable self-check contract is safe machine-readable JSON with this shape:

   ```json
   {
     "ok": true,
     "launcherVersion": "0.2.7",
     "serviceOrigin": "https://api.smedatacenter.xyz",
     "platform": "<safe platform>",
     "secureStore": {
       "available": true,
       "durableCredentialPresent": false
     },
     "server": {
       "reachable": true,
       "metadataCompatible": true,
       "minimumLauncherVersion": "<safe version>",
       "recommendedLauncherVersion": "<safe version>",
       "recommendedUpdateAvailable": false
     },
     "mcp": {
       "handshake": "ok"
     }
   }
   ```

   `mcp.handshake` is `ok`, `not_authenticated`, or `unavailable`. Self-check never performs
   browser login and never returns credential contents. If it reports a typed failure, follow the
   focused recovery below; do not inspect secure storage or repair the remote service.

Use this exact stdio launch tuple after installation. `ENTERPRISE_HUB_BASE_URL` is the only
launcher environment variable; do not add another environment value or any credential.

| Platform | Command                                                                                                              | Arguments | Environment                                             |
| -------- | -------------------------------------------------------------------------------------------------------------------- | --------- | ------------------------------------------------------- |
| macOS    | `~/Library/Application Support/Enterprise Hub/launcher/versions/0.2.7/node_modules/.bin/enterprise-hub-mcp-launcher` | `serve`   | `ENTERPRISE_HUB_BASE_URL=https://api.smedatacenter.xyz` |
| Windows  | `%LOCALAPPDATA%\\Enterprise Hub\\launcher\\versions\\0.2.7\\node_modules\\.bin\\enterprise-hub-mcp-launcher.cmd`     | `serve`   | `ENTERPRISE_HUB_BASE_URL=https://api.smedatacenter.xyz` |

The command, its single `serve` argument, and the one URL-only environment value are the complete
stdio configuration. It must never contain a password, token, header, client secret, or OAuth
setting.

## Device-Code Login Flow

Starting with launcher 0.2.2, every login uses the OAuth Device Authorization Grant: the launcher
obtains a first-party Enterprise Hub verification link, opens it automatically when a system
browser is available (desktop agents), or returns it for the agent to surface through the employee
channel (phone-remote-controlled and headless agents). The employee confirms the agent instance
name shown on the page, enters email/password, and the launcher completes sign-in by polling.

- The employee's only credential input remains email/password on the Enterprise Hub page; never
  ask for, read, or relay verification codes or tokens.
- On macOS/Windows the launcher keeps the durable session in Keychain/Credential Manager exactly as
  before.
- On hosts without a secure store (headless Linux/VPS), the launcher keeps the session in memory
  only; after a launcher or host restart, run the login tool again so the employee can tap a fresh
  link.
- If a business tool reports `authentication_pending`, tell the employee to complete the sign-in
  link and retry the original request once; if it reports `authentication_required`, run
  `enterprise_hub_login` to obtain a new link.

This flow is available in launcher 0.2.2 and later; this document pins launcher 0.2.7.

## Configure The Invoking Agent

Always inspect the existing configuration first, create a timestamped backup before modifying it,
then make the smallest idempotent change: one `enterprise-hub` stdio MCP entry. Preserve every
unrelated server and setting. Do not configure a direct HTTP/OAuth Enterprise Hub server because
the local launcher owns browser login and credential storage.

### Codex

Use the verified Codex CLI MCP registry. On macOS, prefer `codex` from `PATH`; when it is absent,
use the bundled `/Applications/ChatGPT.app/Contents/Resources/codex` fallback. On Windows, resolve
`codex.exe` from `PATH`. Stop if neither verified binary exists.

Before the first mutation, inspect with `codex mcp list --json` and
`codex mcp get enterprise-hub --json`. Back up `~/.codex/config.toml` (Windows:
`%USERPROFILE%\.codex\config.toml`) to a timestamped sibling file when it exists. If the existing
entry already matches the exact command, `serve` argument, and sole BASE_URL environment value, do
nothing.

For macOS add/repair:

```sh
CODEX_BIN="$(command -v codex 2>/dev/null || true)"
if [ -z "$CODEX_BIN" ] && [ -x "/Applications/ChatGPT.app/Contents/Resources/codex" ]; then
  CODEX_BIN="/Applications/ChatGPT.app/Contents/Resources/codex"
fi
test -n "$CODEX_BIN"
CODEX_CONFIG="$HOME/.codex/config.toml"
if [ -f "$CODEX_CONFIG" ]; then
  cp -p "$CODEX_CONFIG" "$CODEX_CONFIG.enterprise-hub.bak.$(date +%Y%m%d%H%M%S)"
fi
"$CODEX_BIN" mcp list --json
"$CODEX_BIN" mcp get enterprise-hub --json
```

If `get` reports the entry absent, add it. If it is present and exact, stop without mutation. Only
when it is present and mismatched, remove that one entry immediately before running the same add
command:

```sh
# Mismatched entry only:
"$CODEX_BIN" mcp remove enterprise-hub
# Missing or just-removed entry:
"$CODEX_BIN" mcp add \
  --env ENTERPRISE_HUB_BASE_URL=https://api.smedatacenter.xyz \
  enterprise-hub -- \
  "$HOME/Library/Application Support/Enterprise Hub/launcher/versions/0.2.7/node_modules/.bin/enterprise-hub-mcp-launcher" serve
"$CODEX_BIN" mcp get enterprise-hub --json
```

For Windows PowerShell, use the same `list`/`get`/`remove`/`add` sequence:

```powershell
$CodexBin = (Get-Command codex.exe -ErrorAction Stop).Source
$CodexConfig = Join-Path $env:USERPROFILE ".codex\config.toml"
if (Test-Path $CodexConfig) {
  Copy-Item $CodexConfig "$CodexConfig.enterprise-hub.bak.$(Get-Date -Format yyyyMMddHHmmss)"
}
$LauncherBin = "$env:LOCALAPPDATA\Enterprise Hub\launcher\versions\0.2.7\node_modules\.bin\enterprise-hub-mcp-launcher.cmd"
& $CodexBin mcp list --json
& $CodexBin mcp get enterprise-hub --json
```

If `get` reports the entry absent, add it. If it is present and exact, stop without mutation. Only
for a present mismatched entry, run:

```powershell
# Mismatched entry only:
& $CodexBin mcp remove enterprise-hub
# Missing or just-removed entry:
& $CodexBin mcp add --env "ENTERPRISE_HUB_BASE_URL=https://api.smedatacenter.xyz" enterprise-hub -- $LauncherBin serve
& $CodexBin mcp get enterprise-hub --json
```

After add/repair, run the platform self-check above, restart/reload Codex, run
`codex mcp list --json` and `codex mcp get enterprise-hub --json`, and confirm the discovered tools.
If add fails after removal, restore the timestamped backup and report the focused failure. For
per-agent removal, back up first, run `codex mcp remove enterprise-hub`, then verify
`codex mcp list --json` no longer contains it and `codex mcp get enterprise-hub --json` reports it
absent.

### OpenClaw

Use OpenClaw's MCP CLI registry for a **stdio** launcher; do not use OpenClaw's direct remote
OAuth store, `openclaw mcp login`, or `openclaw mcp logout` for Enterprise Hub.

1. Inspect first: `openclaw mcp status --verbose` and, when present,
   `openclaw mcp show enterprise-hub --json`.
2. Back up the OpenClaw configuration using its supported current-user mechanism.
3. Add the entry with the platform-specific launcher path from the table, its single `serve`
   argument, and the sole URL-only environment value. On macOS, the verified OpenClaw CLI form is:

   ```sh
   openclaw mcp add enterprise-hub \
     --command "$HOME/Library/Application Support/Enterprise Hub/launcher/versions/0.2.7/node_modules/.bin/enterprise-hub-mcp-launcher" \
     --arg serve \
     --env ENTERPRISE_HUB_BASE_URL=https://api.smedatacenter.xyz
   ```

   If the entry already exists, use `openclaw mcp set enterprise-hub '<one stdio JSON object>'`
   with exactly `command`, `args: ["serve"]`, and the one `ENTERPRISE_HUB_BASE_URL` environment
   value. Do not add an HTTP URL or `auth: oauth` configuration.

4. Verify with `openclaw mcp doctor enterprise-hub --probe`. Reload or restart the owning
   OpenClaw runtime when required by its current setup.

`openclaw mcp add/set/doctor --probe` are the supported configuration/proof path. The launcher,
not OpenClaw's OAuth store, opens the browser and manages the Enterprise Hub secure session.

### Other Agents

Use guarded adaptive discovery. Inspect the installed client's help, current configuration, and
MCP capabilities to confirm that it can start a local stdio server. Back up its configuration,
add only the pinned Enterprise Hub launcher entry, validate its handshake, and preserve every
unrelated server. If its supported configuration mechanism is not clear, report the narrow blocker
instead of editing guessed files or configuring direct remote OAuth.

## Browser Login And Normal Use

Call `enterprise_hub_auth_status` before beginning work when the authentication state is unknown.
If it reports `authentication_required`, call `enterprise_hub_login`. The launcher opens the
system browser; ask the employee to finish login there and never request any credential in chat.
The launcher returns only a safe outcome.

After successful login, retry the employee's original business tool call exactly once. Do not
retry repeatedly after browser cancellation or an unsuccessful login. Use
`enterprise_hub_logout` only when the employee asks to sign out. It clears the shared local
session for Enterprise Hub under the current OS user, so all locally configured agents on that
OS user are signed out.

## Enterprise Hub Data Questions

When the employee asks about资料、SOP、上传过的文件、公司数据、Enterprise Hub 里的表格, or what was
“刚上传/刚传进去/这份表”, answer through Enterprise Hub MCP tools. Do not answer those questions by
reading a local attachment, local CSV/XLSX, previous chat text, cache, or filesystem copy unless
the employee explicitly asks you to inspect a local file outside Enterprise Hub.

Local files are upload inputs only. After uploading a file, keep the returned service metadata
needed for follow-up questions: document id, import batch id, dataset id, labels, declared business
date window or `snapshotDate`, enterprise/store name, and status. In a later task, rediscover
available labels and datasets through MCP; if the intended uploaded table/document cannot be
identified safely, ask one short natural clarification instead of querying all visible history.

For structured-table questions:

- Call `list_structured_datasets` before constructing a structured query unless you already have a
  fresh compatible registry from the same MCP session.
- Resolve field wording through the registry before every structured query: match user-facing terms
  against `sourceColumn`/`aliases`, then send only `canonicalName` values in `select`, filters,
  sorts, groups, and aggregates. Use `sourceColumn` or the matched alias as the displayed table
  header when that is clearer for the employee.
- Respect registry capabilities for every field. Detail `select` entries must be registered
  canonical fields; filter, sort, group, and aggregate only with fields whose advertised
  capabilities permit that use. Dynamic enrichment fields are selectable detail fields only unless
  discovery says otherwise.
- Use explicit mechanical aggregates only: `count`, `countDistinct`, `sum`, `avg`, `min`, `max`,
  and `weightedAvg`. Group by at most four canonical fields and request at most twelve aggregate
  outputs. Aggregate sort fields must be either a group-by field or a unique aggregate alias from
  the same request.
- For `weightedAvg`, both `field` and `weightField` must be numeric aggregatable canonical fields
  in the same dataset. It represents `SUM(field * weightField) / SUM(weightField)` with a `null`
  result when total weight is zero or missing; do not describe it as a service-generated business
  conclusion.
- Select `source_document_id` on detail-row queries when the employee needs the original uploaded
  file behind a structured row, then pass it to `get_source_document_download_url`. This field is
  not returned by default and is not for filters, sorting, grouping, or aggregates.
- Call `describe_structured_dataset_coverage` before answering whether Enterprise Hub has enough
  readable applied data for a dataset, time window, snapshot, or source-file scope. Coverage shares
  structured-query authorization and returns readable source windows or snapshots; decide and state
  any sufficiency assumptions yourself.
- Scope follow-up questions about a recent upload to that upload's returned import metadata,
  declared business-date window, enterprise/store name, or other explicit service-returned
  metadata. Avoid broad unbounded queries for phrases like “这份表”, “刚才那张表”, or “我刚传的”.
- For `dish_catalog`, scope queries with the discovery-reported `snapshot_date` field. Do not
  infer latest/current catalog state, diffs, or row status across snapshots.
- If the employee asks about a local spreadsheet before it has been uploaded, offer to upload it
  first. Do not compute final Enterprise Hub answers directly from the local spreadsheet unless the
  employee explicitly says they want a local-file-only inspection.
- If a query result contains historical rows outside the intended upload/window, narrow the query
  or ask for clarification before presenting totals as “这份表”的 totals.

For authorized service tools:

- List labels before uploading; use only returned label keys.
- Prefer `file.encoding:"path"` uploads with the file's absolute local path; the launcher reads
  exact bytes mechanically. Use `file.encoding:"base64"` only for small inline payloads. Do not
  alter business content, schema, headers, or row meaning unless the employee explicitly asks for a
  local file-conversion task before upload.
- Follow Upload Completion And Status Polling after every `202` upload; never start a worker.
- Quarantine-certificate uploads are synchronous `201` operations, not background imports. Call
  `upload_quarantine_certificate` once per JPG/PNG image with exactly one `receiptId`, one
  idempotency key, and existing label keys. A receipt ID may have zero, one, or multiple
  certificates; one certificate upload request contains only one image.
- Reuse a structured-import idempotency key only for the exact same file and metadata. Treat an
  import-status 404 as "not visible or missing" and do not infer hidden metadata.
- Reuse a quarantine-certificate idempotency key only for the exact same image bytes, receipt ID,
  and label keys. Use `query_quarantine_certificates` with explicit `receiptIds`; never try to
  query all quarantine certificates. Use `get_source_document_download_url` with a returned
  `sourceDocumentId` when the employee asks to download or view the original source file.
- Treat evidence cursors as opaque, short-lived continuations. Return `page.nextCursor` unchanged
  with the same query, filters, and limit. Restart without it on `INVALID_CURSOR`; on
  `CURSOR_EXPIRED`, explain the expiry and restart only if the employee still wants more results.
- `enterprise_hub_list_skills` exposes approved directory metadata only; do not execute an entry.

## Local File Read Errors

When a path-mode upload fails because the launcher cannot read the file, report the typed error
and ask the employee, in the employee's language, to provide an accessible file. Do not fabricate
content, do not paste file contents into chat, and do not silently retry with an inline copy.

- `MCP_LOCAL_FILE_NOT_FOUND`: the file does not exist at the given path.
- `MCP_LOCAL_FILE_PERMISSION_DENIED`: the launcher cannot read the file (file permissions, macOS
  privacy protection, sandbox, or another OS access boundary).
- `MCP_LOCAL_FILE_INVALID`: the path is relative, a directory, or not a regular file.
- `MCP_LOCAL_FILE_TOO_LARGE`: the file exceeds the 50 MiB upload contract.
- `MCP_LOCAL_FILE_READ_FAILED`: another read error.

Example employee-facing reply (Chinese):

> 您刚才提供的文件企业数据中枢没有足够权限读取，请把文件放到桌面/下载等可访问位置后重新提供，
> 或重新拖入文件。

For `MCP_LOCAL_FILE_NOT_FOUND` / `MCP_LOCAL_FILE_INVALID`, ask the employee to re-check the file
location or re-attach the file. For `MCP_LOCAL_FILE_TOO_LARGE`, split a business-window dataset by
a business boundary and upload chunks serially. For `dish_catalog`, never split the snapshot; ask
the employee to remove unrelated sheets/columns outside the catalog schema, use a
service-supported larger limit, or seek operator help.

## Typed Recovery

| Condition                                     | Required response                                                                                                                            |
| --------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `authentication_required`                     | Call `enterprise_hub_login`, wait for browser completion, then retry the original business operation once.                                   |
| Browser cancelled, timed out, or login failed | Report the safe outcome. Do not reopen the browser automatically or retry the business operation.                                            |
| `service_unavailable`                         | Report that the official service cannot be reached. Do not start, repair, or diagnose service infrastructure.                                |
| `forbidden` or not-found                      | Treat the resource as unavailable to this employee; do not infer hidden data.                                                                |
| `launcher_upgrade_required`                   | Install the skill-approved exact launcher version, re-run self-check, then retry the original operation once if installation succeeds.       |
| Local configuration/self-check failure        | Restore the backup only when the agent can do so safely; otherwise report the focused configuration failure. Never delete unrelated entries. |

## Removal And Complete Uninstall

For **per-agent removal**, back up that agent's configuration and delete only its
`enterprise-hub` MCP entry. Leave the launcher package, secure-store session, and other agent
configurations intact.

For **shared logout**, use `enterprise_hub_logout` while the MCP connection is available, or invoke
the pinned launcher directly:

```sh
ENTERPRISE_HUB_BASE_URL=https://api.smedatacenter.xyz \
  "$HOME/Library/Application Support/Enterprise Hub/launcher/versions/0.2.7/node_modules/.bin/enterprise-hub-mcp-launcher" logout
```

```powershell
$env:ENTERPRISE_HUB_BASE_URL = "https://api.smedatacenter.xyz"
& "$env:LOCALAPPDATA\Enterprise Hub\launcher\versions\0.2.7\node_modules\.bin\enterprise-hub-mcp-launcher.cmd" logout
```

The stable logout contract returns only
`{"remoteRevocationConfirmed":<boolean>,"localCredentialRemoved":<boolean>}`. It attempts remote
family revocation when reachable and always attempts local credential deletion;
`localCredentialRemoved` must be `true` before reporting local logout success. It never returns
credential contents. If the service is unreachable, report that remote revocation was not
confirmed.

For **complete uninstall**, with explicit employee authorization: perform shared logout; remove
Enterprise Hub entries only from safely discoverable local agents; remove the current-user pinned
launcher directory and its non-secret Enterprise Hub state; retain backups until the employee
confirms success. Never remove Node.js/npm, the Employee Account, server-side business data, or
unrelated MCP entries.

## Live Service Status

The official identity, pinned launcher package, and public HTTPS MCP service are deployed together
in staging. This skill intentionally contains no repository development-only authentication
behavior. A successful installation or self-check proves only that the configured client can reach
the live service; it does not replace employee browser-login or authorization acceptance.
