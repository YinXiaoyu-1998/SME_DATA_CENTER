# Delivery Ledger And Supplier Catalog Design

## Context

Enterprise Hub already accepts CSV and XLSX structured datasets through one authenticated upload,
background-processing, status, discovery, and controlled-query surface. Delivery sheets and supplier
catalogs belong on that surface, but they do not fit the existing date-window or menu-snapshot
semantics:

- one delivery-sheet file represents one receipt and contains document metadata plus item rows;
- each item row must become one electronic purchase-ledger row;
- a supplier catalog is a complete master-data snapshot whose latest successful import supplies
  current contact details;
- supplier phone and unit address must be resolved when a ledger is queried, not copied into the
  historical ledger rows.

The two supplied XLSX files and the supplier catalog are local acceptance inputs. They may contain
real business information, so they must not be committed. Committed automated tests use synthetic
CSV/XLSX fixtures with the same logical layout.

## Goals

- Add `delivery_ledger` and `supplier_catalog` to the existing structured dataset surface.
- Accept both CSV and XLSX for each new dataset.
- Convert one delivery item into one ledger row while retaining source-document lineage.
- Deduplicate delivery uploads by organization and receipt number, independently of the caller's
  retry key.
- Preserve every controlled supplier-catalog column and value in structured storage.
- Make the latest successfully applied supplier catalog the only current enrichment source.
- Return supplier phone and unit address dynamically and without weakening backend authorization.
- Keep source files in the configured object store and expose only safe import/query metadata.
- Update the repo-local and standalone Enterprise Hub MCP skills when the public dataset guidance
  changes.

## Non-Goals

- No fuzzy supplier-name matching, manual reconciliation UI, or data-cleaning service.
- No report, dashboard, analysis, or natural-language-to-SQL behavior.
- No mutation endpoint for ledger rows or supplier rows.
- No automatic use of delivery-sheet production date, batch, shelf-life, or supplier-address
  fields.
- No phone/address filtering, sorting, grouping, or aggregation in this release.
- No public archive/correction workflow beyond the existing authorized maintenance boundary.

## Public Surface

The change extends the four existing tools and their HTTP delegates; it does not add parallel
receipt-specific tools:

- `upload_structured_dataset`
- `get_import_status`
- `list_structured_datasets`
- `query_structured_dataset`

`upload_structured_dataset` accepts `dataset: "delivery_ledger"` or
`dataset: "supplier_catalog"`. Both require `file`, `enterpriseName`, `idempotencyKey`, and
`labelKeys`. Neither accepts `startDate`, `endDate`, nor `snapshotDate`:

- a delivery receipt date is derived from the file's `收货日期` field;
- a supplier catalog is an undated complete current snapshot.

Existing datasets retain their current metadata rules without compatibility changes.

## Dataset Contracts

### Delivery ledger

A file must contain exactly one recognized delivery sheet. CSV represents that one logical sheet.
XLSX may contain empty sheets, but more than one non-empty recognized or unrecognized sheet is
rejected so that one file cannot silently represent multiple receipts.

The parser locates the document metadata and the detail header instead of assuming row 1 is the
header. The required document fields are:

- `单据号`
- `订货机构`
- `送货机构`
- `收货日期`

The required item columns are:

- `序号`
- `物品名称`
- `规格型号`
- `收货数量`
- `收货金额`

All numeric source-sequence rows after the detail header and before the summary/footer become
ledger rows, including non-food categories. `合计` and footer/signature rows are never imported.
Every ledger row contains:

| Canonical field | Source or rule |
| --- | --- |
| `entry_id` | Generated RFC 4122 UUID for this ledger row |
| `purchase_date` | `收货日期`, normalized to `YYYY-MM-DD` |
| `store_name` | `订货机构` |
| `receipt_number` | `单据号` |
| `supplier_name` | `送货机构`, never `供货机构` |
| `item_name` | `物品名称` |
| `specification` | `规格型号` |
| `purchase_quantity` | `收货数量` as a decimal |
| `purchase_amount` | `收货金额` as a decimal |
| `production_date_or_batch` | Always `null` |
| `shelf_life` | Always `null` |
| `supplier_contact_phone` | Dynamic virtual field |
| `supplier_unit_address` | Dynamic virtual field |

The source sequence remains available through `sourceRowNumber` lineage, but it is not the
electronic ledger's public row identifier. The original document remains addressable through the
receipt number and the source-document/storage lineage already retained by Enterprise Hub.

### Supplier catalog

A file must contain exactly one recognized supplier table. The parser searches prefatory rows for
the controlled header and supports the 33 source columns represented by the supplied catalog,
including `供应商编码`, `供应商名称`, `联系人电话`, and `单位地址`. Every controlled source column
is persisted under a stable canonical field. Empty cells remain `null`; non-empty cells retain
their source value and type within the existing parser's normalization rules.

The catalog is strict: unknown, duplicate, or missing controlled headers reject the import rather
than silently dropping data. Empty and summary rows are skipped; all supplier data rows are kept.
`供应商名称` is the exact dynamic-match key. Catalog rows remain directly queryable through the
standard structured-query API.

Each successful catalog import atomically becomes the organization's current supplier catalog.
Older applied catalog documents, import batches, and rows remain stored for history but are not
consulted for ledger enrichment. A rejected, failed, or in-progress upload never replaces the
current catalog.

## CSV And XLSX Parsing

Both formats are converted into the same in-memory logical-sheet representation before
dataset-specific validation and transformation:

- CSV uses the existing bounded CSV parser and accepts its existing UTF-8/BOM behavior.
- XLSX uses the existing streaming workbook reader and hidden-sheet/resource protections.
- Prefatory metadata/instruction rows are retained for header discovery.
- Formula results and typed cells follow the existing safe XLSX normalization rules.
- Existing upload-byte, row, column, cell, and validation-error limits remain authoritative.

The parsers return safe profile metadata needed before reservation. For a delivery sheet this
includes the normalized receipt number and receipt date; raw item values never enter logs or
audit metadata.

## Persistence Model

The Prisma schema gains:

- `ImportDataset.delivery_ledger` and `ImportDataset.supplier_catalog`;
- `DeliveryLedgerRow`, using the existing row lineage/payload pattern;
- `SupplierCatalogRow`, using the same row lineage/payload pattern;
- an optional `ImportBatch.naturalKey` for receipt-number identity;
- `ImportNaturalKeyClaim`, unique by `(orgId, dataset, naturalKey)`;
- `SupplierCatalogHead`, one row per organization pointing to the current applied supplier-catalog
  import batch.

Date-window datasets continue to use `ImportWindowClaim`. Delivery receipts use
`ImportNaturalKeyClaim`. Supplier catalogs use neither claim type; the supplied idempotency key
handles retries, while each distinct successful upload advances `SupplierCatalogHead`.

`ImportBatch.startDate` and `endDate` become nullable for supplier catalogs. Delivery imports store
the derived receipt date in both fields for status/reporting compatibility but do not reserve a
date window, allowing any number of receipts on the same day.

Worker publication remains atomic:

- transformed rows, import status, document status, and any claim/head transition commit together;
- retry or failure leaves no partially queryable rows;
- a supplier-catalog head changes only in the successful apply transaction.

## Delivery Idempotency

Before creating a reservation, profiling derives the receipt number and date. The natural key is
the exact normalized receipt number within the authenticated organization.

- An existing natural-key claim with the same request fingerprint returns the original document
  and import batch even if the caller supplied a different idempotency key.
- The same receipt number with different file content or semantic upload metadata returns a safe
  `RECEIPT_NUMBER_CONFLICT` and creates no new document, storage object, or rows.
- Existing idempotency-key replay and conflict rules remain in force for all datasets.
- Other receipts on the same date import independently.

This makes accidental duplicate delivery uploads idempotent without silently overwriting a
different receipt correction.

## Dynamic Supplier Enrichment

`supplier_contact_phone` and `supplier_unit_address` are virtual delivery-ledger fields. They are
default-return/selectable fields but advertise `filter=false`, `sort=false`, `group=false`, and
`aggregate=false`.

When a delivery-ledger detail query selects them, the query compiler projects permission-scoped
scalar lookups against the organization's `SupplierCatalogHead`:

1. select only the head's current successfully applied supplier-catalog batch;
2. require its source document to be active and visible to the authenticated employee under the
   same backend document policy used by normal structured queries;
3. match catalog `supplier_name` exactly to ledger `supplier_name`;
4. return `contact_phone` from `联系人电话` and `unit_address` from `单位地址` only when exactly one
   catalog row matches;
5. return `null` when no catalog exists, the current catalog is not visible, no row matches, the
   source field is blank, or the supplier name is ambiguous.

The query never falls back to an older visible catalog when the current catalog is missing or
inaccessible. This preserves the organization-wide definition of "current" and prevents hidden
supplier data from leaking through a visible ledger.

## Authorization And Safety

- Organization identity always comes from the authenticated employee, never upload/query input.
- Delivery and supplier source documents retain explicit labels.
- Base ledger rows must be visible under the existing structured-document authorization predicate.
- Dynamic phone/address values additionally require visibility of the current supplier-catalog
  document.
- Disabled employees remain denied; admins and non-admin label behavior remain unchanged.
- Import responses, audit events, worker errors, and logs contain identifiers, counts, safe error
  codes, and safe sheet summaries only—never raw supplier or item payloads.
- Raw files continue to use the configured object-storage adapter and deterministic object-key
  boundary.

## Error Behavior

- Missing delivery metadata/header/item columns: reject the whole import with bounded validation
  examples.
- Invalid receipt date, quantity, or amount: reject the whole import atomically.
- No delivery item rows: reject as an empty receipt.
- Receipt-number conflict: return `RECEIPT_NUMBER_CONFLICT` before storage publication.
- Supplier catalog missing/invalid headers: reject atomically; keep the previous head current.
- No supplier catalog or no exact unique match: successful ledger query with dynamic fields set to
  `null`, not an import/query failure.
- Unsupported file extension: retain the existing unsupported-file response.

## Verification Strategy

Implementation follows RED-GREEN-REFACTOR. Committed tests use synthetic data and cover:

- registry discovery and metadata rules for both datasets;
- equivalent CSV and XLSX delivery transformations, including a 13-item receipt;
- equivalent CSV and XLSX 33-column supplier-catalog imports;
- forced-null production/shelf-life fields;
- receipt-number replay, same-number conflict, and same-date different receipts;
- worker atomicity and current-catalog head transition only on successful apply;
- latest-catalog dynamic phone/address values;
- no catalog, no match, blank values, duplicate supplier names, and hidden catalog behavior;
- backend authorization for both base ledger rows and enrichment source;
- MCP schema/delegation for the new dataset names and no-date upload metadata;
- API/worker/MySQL integration plus local validation against the user-supplied uncommitted files;
- full format, lint, typecheck, unit, integration, MCP, golden-retrieval, and performance gates.

After every local test run, generated `.data` artifacts and repository-owned Docker resources are
removed and verified according to the repository cleanup policy.

## Documentation And Dual-Homed Skill

The API contract, implementation/test documentation, fixture guidance, and repo-local
`skills/enterprise-hub-mcp/SKILL.md` will describe:

- the two new dataset names;
- CSV/XLSX support;
- dataset-specific upload metadata;
- receipt-number idempotency;
- current-catalog semantics;
- dynamic nullable phone/address enrichment and status polling.

Because this changes public dataset/tool usage guidance, the standalone
`YinXiaoyu-1998/enterprise-hub-mcp-skill` repository must receive the matching skill change on its
own branch and PR. The two skill copies must be byte-synchronized before handoff.
