# Fixtures

Test fixtures for the Enterprise Hub upload and processing paths. Files under
`structured/` exercise the structured import pipeline (`csv`/`xlsx`); files
under `evidence/` exercise the evidence document pipeline (`md`/`txt`/`docx`).

## Typical (accepted) files

- `structured/maijia_dishes_20260706_20260712_first1000.xlsx` — first 1,000
  rows of a real Maijia 菜品 export (title rows + header + data).
- `structured/maijia_business_20260706_20260712_first1000.xlsx` — first 1,000
  rows of a real Maijia 营业 export.
- `structured/maijia_vip_20260809_20260809_first1000.xlsx` — first 1,000 rows
  of a real Maijia 会员主题 export (rows 1–2 title/config, row 3 header, 997
  data rows). Parses as dataset `vip` with 0 validation errors.
- `structured/maijia_dish_catalog_20260819.xlsx` — real Maijia 菜品目录 snapshot
  fixture. Import as `dish_catalog` with `snapshotDate=20260819`: the visible
  `总部菜品` sheet imports 1,123 rows, while the nonmatching `总部套餐` sheet is
  ignored with the safe `SCHEMA_NOT_MATCHED` summary. This fixture verifies that
  catalog sheets are selected by the exact ten-column schema rather than by name.
- `structured/dishes-valid.csv`, `structured/xlsx/typed-cells.xlsx` — small
  deterministic valid cases used by unit tests.

`dish_catalog` fixtures represent a complete snapshot, not a partial delta. The
catalog import requires `snapshotDate` and no business date-window metadata; it
adds `snapshot_date` to each imported row. Its exact controlled headers are
`菜品编码（SPUID）`, `菜品编码（SKUID）`, `菜品名称`, `品牌`, `基础分类`, `一级分类编码`,
`二级分类编码`, `规格名称`, `售卖价`, and `菜品别名` (column order may vary). SKUID is
unique within the snapshot; SPUID may repeat; the nullable fields are
`二级分类编码`, `规格名称`, and `菜品别名`; a sale price of `0` is valid.

## External local acceptance inputs

The Task 8 sample workbooks are intentionally untracked files in the primary
checkout, not fixture files in this repository. Use the production parser for
local-only validation and do not copy, export, or commit them:

- `delivery_sheet_SH2608250117.xlsx` — 13 ledger rows, receipt `SH2608250117`.
- `delivery_sheet_SH2608260003.xlsx` — 1 ledger row, receipt `SH2608260003`.
- `supplier_catalog.xlsx` — 134 supplier snapshot rows.

The two delivery samples' supplier keys each have one matching row in the
sample catalog. Temporary CSV conversions may be used for parser parity checks,
but must be created under `mktemp` and removed after parsing. Record only counts,
receipt IDs, and pass/fail evidence; never commit or disclose raw contacts or
other customer rows.

## Rejected (failure) fixtures

Each file below is expected to be rejected by the service for the stated
reason. The `vip-*` files use the 66-column 会员主题 header; the
`structured-invalid-*` files are dataset-agnostic. Regenerate all of them with
`npm run generate:rejected-fixtures` (OOXML/CSV writers in
`scripts/generate-structured-rejected-upload-fixtures.ts`); the real-export
slices above are committed as-is.

| Fixture                                                  | Rejection reason                                                         | Expected error code                                           |
| -------------------------------------------------------- | ------------------------------------------------------------------------ | ------------------------------------------------------------- |
| `structured/vip-invalid-missing-column.csv`              | Header lacks the required `日期` column                                  | `INVALID_HEADER` (missing-column detail `日期`)               |
| `structured/vip-invalid-unknown-column.csv`              | Header contains an unrecognized column                                   | `INVALID_HEADER`                                              |
| `structured/vip-invalid-cell-type.csv`                   | `充值笔数` cell is non-numeric                                           | `INVALID_FIELD_VALUE`                                         |
| `structured/structured-invalid-not-utf8.csv`             | CSV bytes are not valid UTF-8                                            | preflight throws (`CSV content must be UTF-8 text.`)          |
| `structured/structured-invalid-empty.csv`                | No header or data rows                                                   | `NO_IMPORT_SHEETS`                                            |
| `structured/xlsx/structured-invalid-not-xlsx.xlsx`       | `.xlsx` name but no ZIP signature                                        | preflight throws (`XLSX file does not have a ZIP signature.`) |
| `structured/xlsx/vip-invalid-header-not-in-first10.xlsx` | Header appears only after 11 junk rows (header scan covers the first 10) | `INVALID_HEADER`                                              |
| `structured/xlsx/vip-invalid-hidden-sheet.xlsx`          | Non-empty worksheet is hidden                                            | `HIDDEN_SHEET`                                                |
| `evidence/invalid-format.pdf`                            | Evidence uploads accept only `.md`, `.txt`, `.docx`                      | `INVALID_DOCUMENT_KIND_FILE_TYPE` (HTTP 400)                  |

Existing xlsx parser-matrix fixtures under `structured/xlsx/` (for example
`hidden-sheet.xlsx`, `cross-sheet.xlsx`, `error-cell.xlsx`) are generated by
`npm run generate:xlsx-fixtures` and cover additional low-level OOXML edge
cases; they are not part of the upload-rejection set above.

Note: header-level registry validation distinguishes missing/unknown/ambiguous
columns internally, but the worker-facing validation pipeline reports them all
as `INVALID_HEADER` (with the missing column surfaced in the issue `column`
field), which is why the table above lists that code.
