# In-store orders: complete store-day snapshots and local CSV

## Release and tenant readiness

`in_store_orders` (店内订单明细) is the canonical category in source candidate `0.15.0`,
which is **not yet published**. It replaces the legacy public name `settled_orders` from released
launcher `0.14.0`; the approved installation pin remains `0.14.0` until a compatible release is
published, independently verified and approved. Confirm the matching service migration and
current tenant authorization before using the new name. Do not install an unpublished candidate
or assume the approved old launcher supports it. Until ready, report the prerequisite and retain
the operation. Static tools/list or successful login is not release or tenant readiness.

## Upload one complete source

After the core Skill's active-admin preflight, upload the unchanged original XLSX or UTF-8 CSV
using the absolute path transport. Declare the exact enterprise and inclusive business-date
window in `YYYYMMDD`; omit `snapshotDate`. The enterprise's configured fixed-category level is
authoritative; upload metadata cannot override it. File bytes and internal storage links stay
inside the launcher. The default source limit is 2 GiB. Do not split or repair the source locally.

The file must contain every order from the selected stores and complete business days in the
source platform's “店内订单明细” export, including all order statuses. Multiple stores and days are supported.
The uploader is responsible for completeness: validation checks structure, types and the declared
window, not whether source filters omitted orders. `订单状态` independently preserves
`待制作`, `未结账`, `已结账`, `已撤单` and `已退单`, including unpaid/cancelled/refunded rows.
Unknown source states and empty states also remain source text/empty; do not infer state from
payment, settlement or refund timestamps. An unpaid row may have empty/`--` settlement time
and payment, yielding an empty typed time and JSON null. Do not submit status-filtered subsets. `business`, `dishes` and `in_store_orders`
are independent uploads, without cross-dataset reconciliation.

`upload_structured_dataset` — synthetic complete two-day original:

```json
{
  "dataset": "in_store_orders",
  "enterpriseName": "合成企业",
  "startDate": "20261001",
  "endDate": "20261002",
  "idempotencyKey": "in-store-orders-synthetic-20261001-02-v1",
  "file": {
    "name": "in-store-orders.xlsx",
    "mediaType": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    "encoding": "path",
    "filePath": "/absolute/path/in-store-orders.xlsx"
  }
}
```

Keep the returned `partitionImportJobId`; this is not an `importBatchId`.

`get_partition_import_status` — replace the synthetic ID with the returned job ID:

```json
{ "partitionImportJobId": "pi_synthetic_example" }
```

Follow the core Skill's bounded partition polling schedule, including the large-file schedule.
Only `published` is success. `queued`/`processing` are pending; `rejected`, `failed`, `cancelled`
and `expired` are terminal non-success. Check MCP `isError` and report only safe returned errors
and source-row validation locations. A safe owner-progress response does not grant content reads.
Do not replace polling with another upload. Reuse an idempotency key only for the exact same
bytes and metadata; corrected sources need a new key. At the polling limit, report still processing.

The source publishes atomically after all candidates validate. Only store-days actually present
replace current partitions; omitted store-days remain unchanged. An empty source is rejected,
not a deletion request. Duplicate rows and repeated order IDs retain source order and multiplicity.
Exact-byte content reuse avoids duplicate append; row reordering can change the CSV checksum.
Failure preserves the prior current data. Partitions use the row's 营业日期 even across midnight;
机构编码 is a source field, not a merchant/store ID. This report uses the existing store-name
fallback identity. Never invent `storeIds` from organization codes.

## Read authorization and downloads

Call `get_my_permissions` for the current permission card. The independent store-level category
`in_store_orders` needs enabled business authorization, a configured category confidentiality level,
sufficient current clearance and a complete enterprise/store/category grant covering all required
dimensions. Existing business/dishes grants do not include it. New categories start with no level
and no grants; admins configure them through the existing
[business authorization flow](business-authorization.md). Admin upload/management does not bypass
ordinary reads. Legacy/preparing/suspended modes do not provide fallback content access.

`describe_structured_dataset_coverage` — currently readable enterprise/store coverage:

```json
{
  "dataset": "in_store_orders",
  "enterpriseName": "合成企业",
  "storeNameContains": ["合成门店"]
}
```

Coverage is authorized availability, not proof of complete source exports or hidden stores.
There is no server-side order query or aggregation through `query_structured_dataset`;
`DATASET_REQUIRES_PARTITION_EXTRACT` means download CSV and analyze locally.
Range download is the default, following the core Skill's range limits, integrity checks and recovery.

`download_structured_partitions` — authorized inclusive range:

```json
{
  "dataset": "in_store_orders",
  "enterpriseName": "合成企业",
  "startDate": "20261001",
  "endDate": "20261002",
  "storeNameContains": ["合成门店"]
}
```

`storeNameContains` uses 1–20 trimmed NFC literals, each 1–255 characters, case-sensitive OR;
it combines with enterprise, optional service-returned merchant IDs and current authorization by
AND. It is a selector, not an authorization grant. Preserve the same enterprise/store scope across
coverage and download. Check `isError`; failures never mean zero orders.

Optional ZIP requires independently confirmed matching service support. Follow the core Skill's
bundle limits and error recovery; prepare fixes an authorized manifest, while final link issuance
rechecks current access and source revisions. Safe progress alone is not permission to download.

`prepare_structured_partition_download` — same scope, stable preparation key:

```json
{
  "dataset": "in_store_orders",
  "enterpriseName": "合成企业",
  "startDate": "20261001",
  "endDate": "20261002",
  "storeNameContains": ["合成门店"],
  "idempotencyKey": "in-store-orders-synthetic-zip-v1"
}
```

`get_structured_partition_download_status` — wait the returned `retryAfterSeconds` between checks:

```json
{ "requestId": "pd_synthetic_example" }
```

While `queued`/`running`, poll the returned request ID; `failed`/`expired` stop the flow.
Only after `succeeded` use the final request-ID form, with no dataset/date/store selectors.

`download_structured_partitions` — succeeded prepared request only:

```json
{ "requestId": "pd_synthetic_example" }
```

Both download forms return `localDirectory`, `dataset`, `partitionCount`, `totalRowCount` and
CSV `files[]`. The launcher verifies scope, bytes/SHA-256 and ZIP paths when applicable; signed
URLs and file bytes are not model output. A successful zero-partition result is a valid empty
local extract. Consume the local manifest and CSV mechanically rather than pasting their bodies
into context. Use a `finally` block to remove only this workflow's returned scratch directory after
local work, including failure/cancellation; shared extracts remain until their last consumer releases
them. Service data cleanup is operator-only, including for admins.

## CSV and payment semantics

The current CSV has all 30 source columns in registered order, followed by `结账方式JSON` (31 columns).
All 30 input columns are required; reordered columns are allowed. Missing, duplicate and unknown
columns reject the whole source. The derived JSON column is output only, not an extra upload column.
The source columns are:

```text
门店、机构编码、营业日期、订单号、经营模式、订单来源、用餐方式、下单时间、结账时间、退单时间、
取餐号、桌牌号、全渠道流水号、桌台区域、用餐人数、订单金额（元）、顾客应付（元）、支付合计（元）、
订单优惠（元）、订单收入（元）、结账方式、订单状态、退单标识、菜品收入（元）、服务费（元）、
服务费优惠（元）、服务费收入（元）、预定用餐时间、会员、整单备注
```

Only 门店 and 营业日期 must be nonempty and valid. Other cells may be empty; nonempty values
must match their declared type. `--` becomes empty only in nullable dates/times/numbers;
ordinary text and IDs retain it. Read CSV with a standard RFC 4180 parser, preserving leading
zeroes in codes/IDs. Empty values remain null, not zero. Dates are `YYYY-MM-DD`, datetimes are
`YYYY-MM-DD HH:mm:ss` in the source clock, without timezone shifts. Amounts retain sign and
exact decimal value. CSV is UTF-8 without BOM, quoted as needed, LF with a final newline.

`结账方式` retains the original text. `结账方式JSON` is an ordered array of
`{method, amount, marker}`: full method name, signed JSON number, and `null` or the original
`退款`/`找零`/`撤销找零` marker, accepting halfwidth or fullwidth parentheses.
For example, source `员工 卡 10.00，现金 -2.30(退款)，现金 -2.30(退款)，现金 -0.1（找零），现金 0.1(撤销找零)`
produces:

```json
[
  { "method": "员工 卡", "amount": 10, "marker": null },
  { "method": "现金", "amount": -2.3, "marker": "退款" },
  { "method": "现金", "amount": -2.3, "marker": "退款" },
  { "method": "现金", "amount": -0.1, "marker": "找零" },
  { "method": "现金", "amount": 0.1, "marker": "撤销找零" }
]
```

Preserve repeated methods and identical entries; do not sum them into a method-to-amount object,
net refunds against sales, infer transaction links or treat array order as event chronology.
`撤销找零` support and the new category name require matching service support; installing a client alone does not add server parsing support.
Use exact decimal parsing for CSV and JSON amounts (for example Python JSON `parse_float=Decimal`,
`parse_int=Decimal`) rather than binary floating point. An empty/`--` payment cell emits JSON `null`
while retaining its raw text; nonempty unparseable content or unsupported markers reject the entire
source with the source row, 1-based payment item index and failure reason. Report the service error
and retain the original file for resubmission after the service update; do not remove markers or skip
orders to bypass validation. The service does not validate payment totals against order totals or infer missing amounts.
Current CSVs are authoritative; temporary source workbooks are cleaned after terminal processing.
There is no retained original Excel, historical partition or MySQL order-row download path.

## Existing data and retry transition

The service migration renames the dataset/category while preserving category ID, current grants,
levels, partition IDs, source fields, current CSV bytes and storage references. It does not fill
missing statuses or prove an earlier export complete. A broader snapshot requires a separately
authorized complete original upload. New uploads/download preparations use `in_store_orders`.
Existing completed or pending ZIP requests for the old name expire; check their safe status and
prepare a fresh download after upgrading. Earlier download links remain governed by their original
TTL. Request fingerprints are preserved for history, so a new-name operation needs a new
idempotency key; an old key conflict is not permission to alter the stored original request.
