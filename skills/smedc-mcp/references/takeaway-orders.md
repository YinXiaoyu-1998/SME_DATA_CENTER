# Takeaway orders: complete store-day snapshots and local CSV

## Release prerequisite

`takeaway_orders` (平台外卖订单明细) is implemented in launcher source candidate `0.15.0`,
which is **not yet published**. The approved exact installation pin remains `0.14.0`.
Use this workflow only after a compatible launcher is published and independently verified,
the approved installation authority is updated, the matching service is deployed, and the tenant
has current independent category grants. A source change, static tools/list or successful login
is not release or tenant readiness. Until then, report the prerequisite and retain the requested
operation; do not install the unpublished candidate or relabel the source as another dataset.

## Upload and status

After the core Skill's active-admin preflight, upload the unchanged original XLSX or matching
UTF-8 CSV through the launcher path transport. Source must be “平台外卖订单明细—有效订单”,
including uncompleted and partially refunded records. Each submitted store-day must contain
**all platforms and all source valid orders**. Multiple stores/days are supported; today's source
may be a complete snapshot as of export time. Re-export the complete affected store-days for
later status/refund changes. The uploader guarantees completeness; source filters are not proof.

`upload_structured_dataset` — synthetic two-day complete source:

```json
{
  "dataset": "takeaway_orders",
  "enterpriseName": "合成企业",
  "startDate": "20261001",
  "endDate": "20261002",
  "idempotencyKey": "takeaway-orders-synthetic-20261001-02-v1",
  "file": {
    "name": "takeaway-orders.xlsx",
    "mediaType": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    "encoding": "path",
    "filePath": "/absolute/path/takeaway-orders.xlsx"
  }
}
```

Dates declare the inclusive source business-date window (`YYYYMMDD`); omit `snapshotDate`.
The configured category level is authoritative. File bytes, credentials and internal links remain
inside the launcher. Do not split by platform/hour/order, repair rows or fill missing values locally.

`get_partition_import_status` — use the returned job ID:

```json
{ "partitionImportJobId": "pi_synthetic_example" }
```

Follow the core Skill's bounded partition polling schedule. Only `published` is success;
`queued`/`processing` remain pending; `rejected`/`failed`/`cancelled`/`expired` stop the workflow.
Report safe error codes and source-row/field locations. Poll rather than uploading again.
Reuse an idempotency key only for identical bytes and metadata; corrected sources need a new key.

The entire source validates before atomic publication. Each appeared store-day fully replaces
its current partition; absent store-days stay unchanged. Empty sources cannot clear data.
The last successful publication wins, even for an older export. Duplicate rows and repeated
order IDs retain their original order and multiplicity. Source 营业日期 determines the partition,
including cross-midnight order/completion/refund times. 机构编码 is a source field, not merchant
identity; never invent `storeIds` from it. The existing store-name fallback is used.

## Current authorization and file delivery

Use `get_my_permissions`. This independent store-level category starts with no level or grants.
An admin configures it through the existing [authorization flow](business-authorization.md).
Reads require enabled authorization, current category level, sufficient clearance and a complete
enterprise/store/category grant with every applicable dimension. Grants for business, dishes or
settled_orders do not include takeaway_orders. Admin upload rights do not bypass read permissions.

`describe_structured_dataset_coverage` — authorized availability:

```json
{ "dataset": "takeaway_orders", "enterpriseName": "合成企业", "storeNameContains": ["合成门店"] }
```

Coverage is not proof of source completeness. `query_structured_dataset` returns
`DATASET_REQUIRES_PARTITION_EXTRACT`; analyze the downloaded files locally.

`download_structured_partitions` — default range delivery:

```json
{
  "dataset": "takeaway_orders",
  "enterpriseName": "合成企业",
  "startDate": "20261001",
  "endDate": "20261002",
  "storeNameContains": ["合成门店"]
}
```

Keep enterprise/store scope consistent. Store-name filters are case-sensitive literal OR selectors,
combined with current authorization by AND; they do not grant access. Follow the core Skill's
range limits and recovery. Check `isError`; failure does not mean zero orders.

Optional ZIP requires confirmed target service support and the core Skill's existing bundle limits.

`prepare_structured_partition_download` — prepare the same scope:

```json
{
  "dataset": "takeaway_orders",
  "enterpriseName": "合成企业",
  "startDate": "20261001",
  "endDate": "20261002",
  "storeNameContains": ["合成门店"],
  "idempotencyKey": "takeaway-orders-synthetic-zip-v1"
}
```

`get_structured_partition_download_status` — poll with returned retryAfterSeconds:

```json
{ "requestId": "pd_synthetic_example" }
```

Only after `succeeded` use the request-ID form; `failed`/`expired` stop. Link issuance rechecks
current complete authorization and source revisions; safe progress grants no content access.

`download_structured_partitions` — succeeded request, without range selectors:

```json
{ "requestId": "pd_synthetic_example" }
```

The launcher verifies scope, file count, bytes/checksums and safe ZIP paths before returning
`localDirectory`, `dataset`, `partitionCount`, `totalRowCount` and `files[]`. It cleans incomplete
outputs. Read local CSV/manifest mechanically and use `finally` to remove this workflow's returned
scratch directory after its last consumer finishes. Do not delete shared or service data.

## Exact source fields and local interpretation

All 33 columns are required, may be reordered on input, and are emitted in this fixed order:

```text
门店、机构编码、订单来源、外卖订单号、收银订单号、订单状态、订单形式、退单标识、取餐号、
全渠道流水号、营业日期、下单时间、接单时间、完成时间、取消时间、退单时间、配送方式、
菜品总价(元)、餐盒费(元)、配送费(元)、订单金额(元)、配送费(商家收入)(元)、外卖营业额(元)、
平台服务费(元)、商家活动支出(元)、其他支出(元)、本单预计收入(原)(元)、部分退款(元)、
营业优惠/支出(元)、营业收入(元)、顾客实付(元)、餐盒费优惠(元)、餐盒费收入(元)
```

Exactly these fields are delivered, without payment JSON or source-location columns. Missing,
unknown or duplicate columns and invalid nonempty typed values reject the entire source. Title,
filter-description and recognized summary rows are excluded; normal business text is retained.
Only 门店 and 营业日期 are nonempty required cells. Strings trim outer whitespace; identifiers
stay strings with leading zeros and long digits preserved. Precision already lost in the source
cannot be reconstructed. New platforms, statuses, order forms and delivery methods remain text.

Nullable dates/times/amounts convert `--` to empty; ordinary text and IDs retain `--`. Empty is
not zero. Dates use `YYYY-MM-DD`; datetimes use `YYYY-MM-DD HH:mm:ss` in the source clock.
Use a standard CSV parser and exact decimal arithmetic. Each source amount retains its sign and
value without totals reconciliation, net-income inference or refund-based rewriting.

The datasets are independent: business data may already include takeaway totals, so do not add
both income columns unconditionally or assume a cross-dataset order key. OSS current CSV is the
authoritative content; MySQL stores the directory and task metadata. Temporary source workbooks
are cleaned at terminal processing. There is no retained original Excel, history or rollback
query; the uploader keeps originals needed for long-term records.
