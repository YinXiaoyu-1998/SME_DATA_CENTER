# Current business permissions and controlled management

The approved install pin is `smedc-mcp-launcher@0.9.0`, published and independently verified.
Use the capabilities below only after the matching service and approved launcher release are
available; tool discovery alone does not prove deployment or tenant activation. Do not change
installation pins from server metadata or install npm `latest`.

Call `get_my_permissions` with `{}` for a fresh server permission card. It reports current mode,
authorization version, clearance, explicit grants and their category rules. Never cache grants as
an authorization decision. A name or rule in the card is configuration metadata, not a content
link or proof that a particular file is readable. Service denials remain authoritative.

Ordinary content requires current same-organization category grants covering all actual enterprise,
ownership, exact-store and required-dimension items, plus sufficient clearance. Grant alternatives
cannot combine incomplete conditions. Group membership data does not require permissions for its
opening/stored-value stores. Exact store names are preserved, including meaningful whitespace;
never fuzzy-match, merge names or add guessed aliases. Admin role and uploader status do not grant
ordinary content access. Retained originals require all parsed resource scopes; unparsed sheets do
not create guessed scopes. Raw delivery-ledger data, aggregates and original links have no public
MCP read path. Finished PDFs use the independent PDF category and one exact store.

For enterprise onboarding or adding an account, the primary entry is the verified
[administrator UI workflow](tenant-onboarding.md), with Chinese by default and English switching.
The current service implements the UI; users may also explicitly choose these authorized MCP tools. JSON remains an
optional internal record, never a required user form.

## Upload inputs

These transport fields are bundled in approved launcher 0.9.0 and need the matching service
rollout. A Skill refresh does not upgrade an older installed launcher. If unavailable, follow the
approved launcher update procedure and report service rollout gaps; never bypass through direct HTTP.

- `upload_evidence_document`: `file`, `title`, explicit integer `confidentialityLevel` 0–3,
  `categoryId`, and nonempty `scopes`; optional `sourceSystem` and
  `historicalSupplementReason`.
- Each evidence scope is `{ "enterpriseKey": "…", "ownership": "group" | "store",
"storeName"?: "…", "dimensions": { "dimension-id": "value-id" } }`. Store ownership needs
  one exact store; group ownership has no store. List actual complete items for shared files.
- `upload_quarantine_certificate`: one image, `receiptId`, `idempotencyKey`, explicit
  `enterpriseName` (at most 128 characters) and one exact `storeName` (at most 255). Never send
  an array of stores or infer a store from the receipt. Optional legacy `confidentialityLevel`
  cannot change the enabled photo category's current level.
- `upload_structured_dataset`: keep the registry's existing metadata and original-file transport.
  Optional legacy `confidentialityLevel` cannot override the enabled fixed category level.
- All three accept optional nonblank `historicalSupplementReason` (at most 2048 characters).
  It records the actual admin's explicit historical supplementation, not inferred attributes.

Example evidence metadata (synthetic identifiers; obtain real directory values through the tools):

```json
{
  "title": "Procedure",
  "confidentialityLevel": 2,
  "categoryId": "operations-procedure",
  "scopes": [
    {
      "enterpriseKey": "enterprise",
      "ownership": "store",
      "storeName": "Store A",
      "dimensions": { "project": "X" }
    },
    {
      "enterpriseKey": "enterprise",
      "ownership": "store",
      "storeName": "Store B",
      "dimensions": { "project": "Y" }
    }
  ]
}
```

Add the original `file` using the core Skill's path transport. Do not flatten these items into
independent store/project lists. If a required declaration is missing, report the service error
and request that declaration; this Skill does not repair data or decide permissions.

## Admin tools

Only a current active same-organization admin can call these controlled operations:

| Purpose                                                           | Tools / required selectors                                                                                                                                                                     |
| ----------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| View accounts and full configuration, including self/other admins | `list_account_permissions {}`, `get_account_permissions { employeeId }`                                                                                                                        |
| Replace account configuration                                     | `update_account_permissions { employeeId, expectedVersion, clearance, grants }`                                                                                                                |
| Categories                                                        | `list_business_categories {}`, `create_evidence_category { id, name, expectedVersion, ownerships, requiredDimensionIds }`, `update_business_category { categoryId, name, expectedVersion, … }` |
| Dimensions                                                        | `list_business_dimensions {}`, `create_business_dimension { id, name, expectedVersion }`, `update_business_dimension { dimensionId, name, expectedVersion }`                                   |
| Dimension values                                                  | `create_business_dimension_value { dimensionId, id, name, expectedVersion }`, `update_business_dimension_value { dimensionId, valueId, name, expectedVersion }`                                |
| Exact store directory                                             | `list_business_stores {}`, `update_business_store { enterpriseKey, name, expectedVersion }`                                                                                                    |
| Evidence attributes                                               | `update_evidence_document_attributes { documentId, expectedVersion, categoryId, fileConfidentialityLevel, scopes, historicalSupplementReason? }`                                               |
| Safe evidence management status                                   | `get_evidence_document_management_status { documentId }`                                                                                                                                       |
| Read-only preparation                                             | `prepare_authorization_cutover {}`                                                                                                                                                             |
| Explicit activation / read suspension                             | `activate_authorization_cutover` / `suspend_authorization_reads { expectedVersion, confirm: true }`                                                                                            |

Read current directories/configuration before writing. The service initializes all eight fixed
categories through deployment migration for existing tenants and account onboarding for new tenants.
Initialization preserves existing IDs, levels and retirement choices; new levels remain unset and no
grants or activation are inferred. Use IDs returned by `list_business_categories`, never invent
`fixed:…` IDs or create an evidence category to replace a missing fixed category. If the service
still reports a missing fixed category, report incomplete service initialization to its operator.
Only the seven readable fixed categories need administrator-declared levels. `delivery_ledger`
retains its internal category identity and complete enterprise/store/source associations, without
an administrator level or ordinary read grant. `ledger_pdf` keeps its own level and grants;
existing stored internal levels are preserved and never open raw-ledger reads.
This separation requires the matching service rollout. If preparation still requests a
`delivery_ledger` level, report the service-version mismatch to the operator; do not fill 0/3,
delete the internal category, or bypass the gate. `INTERNAL_CATEGORY_REQUIRED` means service
initialization is incomplete, not that the administrator must choose a ledger level.

Listing and preparation are read-only. A fixed-category edit accepts only its
`confidentialityLevel` model; evidence edits accept `ownerships` and `requiredDimensionIds` instead.
Directory mutations optionally accept `retired`; they do not automatically grant access. A grant
contains `id`, same-organization `orgId`, `enterpriseKey`, `categoryIds`, `ownership`, `dimensions`,
and `stores` only for store ownership. Selection objects are exactly `{ "kind": "all" }` or
`{ "kind": "fixed", "values": ["exact-value"] }`; every applicable dimension must be supplied.
Use the server-returned organization only inside a grant; never supply a tenant override selector.
There is no arbitrary API-path or SQL tool. Account roles, password setup and credentials remain
outside these permission tools. Viewing/modifying configuration does not grant immediate content
access beyond the saved rules. Never manufacture grants or decide the user's policy for them.

Preparation lists missing configuration and attributes. Activation requires the admin's explicit
confirmation after the report is ready, then rechecks the current version atomically. This guide
does not itself authorize changing a real tenant or suspending its reads. A suspended tenant does
not restore legacy access; report the result and refer recovery to its administrator.

## Errors, status and downloads

- `AUTHORIZATION_VERSION_CONFLICT`: reload the current configuration/preparation report. Preserve
  the user's intent; do not blindly replay a stale write or invent a replacement version.
- `AUTHORIZATION_ADMIN_REQUIRED` / ordinary permission denial: explain the current named reason.
  Permission names may be stated plainly. Do not retry login as a permission bypass.
- `RESOURCE_ATTRIBUTES_NOT_READY`, `RESOURCE_SINGLE_STORE_REQUIRED`, or preparation missing items:
  report the explicit missing declaration; do not infer, reclassify or repair it locally.
- `AUTHORIZATION_CUTOVER_NOT_READY` / `AUTHORIZATION_SUSPENDED`: report that activation/reads are
  unavailable and the current preparation or pause status; do not fall back to the old model.
- `PARTITION_DOWNLOAD_REBUILD_REQUIRED` / `LEDGER_DOWNLOAD_REBUILD_REQUIRED`: the service cannot
  prove the old manifest's full scope. Prepare a new request with the explicitly intended scope.
- A permission change during packaging alone does not fail construction. The owner may see safe
  progress; a succeeded job can still be denied a fresh link by current permissions. Status and
  management responses contain no content links. Do not report status success as download access.
- `get_import_status` gives an active uploader safe document/import/processing IDs and statuses plus
  `hasValidationErrors`, even without content grants/clearance or during read suspension. It omits
  original filenames, storage keys, sheet/validation details, business dates, receipt IDs and row
  counts. Ordinary full metadata requires all current retained-source scopes and category clearance
  in enabled mode; raw receipt metadata has no ordinary enabled read. Disabled accounts cannot
  self-check progress. A validation flag alone is not a detailed error or authority to read a source.
- Link issuance checks all captured current scopes and source lifecycle. Photo replacement/archive
  makes old PDFs stale for new links until service regeneration; existing links retain their TTL.
  The employee agent cannot trigger rendering or repair stale manifests.

The launcher does not monitor permissions continuously during transfers. Refresh/retry uses a new
server check; it does not create an old-client bypass. Keep ordinary polling, exact idempotency and
original-file semantics from the core Skill.
