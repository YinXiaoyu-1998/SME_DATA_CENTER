# Store reviews

Launcher `0.11.0` is published, independently verified and approved for installation. Use the
core Skill's exact `smedc-mcp-launcher@0.11.0` installation procedure. Store-review tools require
the matching service release and explicit tenant category/grant configuration. Publication,
installation, a Skill refresh or tools/list alone does not establish service or tenant readiness;
verify current permission candidates and follow authoritative server denials.

## Choose an enterprise before calling

Call `get_my_permissions {}` freshly and read `storeReviewEnterprises`, whose `complete:true`
marks the full registered enterprise candidate list. Use `write` for upserts and `read` for queries;
admin role does not grant ordinary reads. An explicitly named enterprise must match that operation's
list exactly. If unnamed, use the only candidate and tell the employee which enterprise was selected;
ask first when there are multiple candidates, and report unavailable when there are none or the
complete list is missing. Never infer a default enterprise, orgId, or display name from a historical
key, browser brand, uploaded content or another operation's list. Server authorization is still
final on every call, including later pages and replies.

## Record collected reviews

`upsert_store_reviews` is a controlled JSON operation for current active admins, without original-file
upload, local file reads or worker processing. Each review needs `enterpriseName`, `source`
(`美团评价` or `点评评价`), exact `storeName`, `reviewedAt` and exact `reviewerName`. Names are
not fuzzy-matched or trimmed. The business identity also includes the canonical review instant;
same names across stores, sources or enterprises are separate. Ambiguous identities stay unsynced.

Beijing time must contain at least the hour: `YYYY-MM-DD HH`, `YYYY-MM-DD HH:mm`,
`YYYY-MM-DD HH:mm:ss`, or the same precision with `T` and explicit `+08:00`. Missing minutes and
seconds become zero. Date-only, invalid calendar times, fractional seconds and timezone-free `T`
are rejected. Returned timestamps include seconds and `+08:00`; never invent a missing hour.

Omitted `content`, `scores` or `merchantReply` leaves the stored value unchanged. Explicit `null`
clears that field; empty content/reply strings remain distinct from null. Scores replace the whole
object, including `{}`. Record only observed finite numbers, with original dimension names, no
fixed dimensions or maximum score and no zero filling. A pure rating is valid and must be collected
when review synchronization is requested, even though it does not need a drafted reply.

Only `merchantReply` that was actually published on the platform and then verified is stored.
Omit it when unread or unknown; do not use null for an unobserved reply or store a draft. After
successful verified publication, send only the identity and published reply so existing content and
scores remain intact. No delete operation exists.

Examples below are synthetic tool arguments. Use each named tool, without adding orgId or a tool
wrapper to its arguments.

`upsert_store_reviews` — observed content and scores:

```json
{
  "reviews": [
    {
      "enterpriseName": "合成餐饮企业",
      "source": "美团评价",
      "storeName": "合成门店",
      "reviewedAt": "2026-10-17 13:20",
      "reviewerName": "合成用户甲",
      "content": "环境舒适",
      "scores": { "总评": 4.5, "环境": 5 }
    }
  ]
}
```

`upsert_store_reviews` — pure rating; omit unobserved text and reply:

```json
{
  "reviews": [
    {
      "enterpriseName": "合成餐饮企业",
      "source": "点评评价",
      "storeName": "合成门店",
      "reviewedAt": "2026-10-17T14+08:00",
      "reviewerName": "合成用户乙",
      "scores": { "服务": 9, "__proto__": 8 }
    }
  ]
}
```

`upsert_store_reviews` — explicit intentional score clear:

```json
{
  "reviews": [
    {
      "enterpriseName": "合成餐饮企业",
      "source": "美团评价",
      "storeName": "合成门店",
      "reviewedAt": "2026-10-17 13:20:00",
      "reviewerName": "合成用户甲",
      "scores": null
    }
  ]
}
```

`upsert_store_reviews` — only a verified published reply:

```json
{
  "reviews": [
    {
      "enterpriseName": "合成餐饮企业",
      "source": "美团评价",
      "storeName": "合成门店",
      "reviewedAt": "2026-10-17 13:20",
      "reviewerName": "合成用户甲",
      "merchantReply": "感谢您的评价，期待再次光临。"
    }
  ]
}
```

## Batches, unknown outcomes and querying

Send 1–1000 rows per batch. Both the original UTF-8 JSON and its canonical JSON after time
normalization must fit 16 MiB, and the raw HTTP body has the same limit. Size batches using the
canonical second-precision `+08:00` times; short hour/minute inputs can expand during normalization.
A total batch overflow returns HTTP 413 `PAYLOAD_TOO_LARGE`; split the batch without truncation.
Per-field validation, including the independent 64 KiB score-object limit, remains an input error
rather than a total-batch overflow. Each scores object is at most 64 KiB;
content/reply each at most 16,384 characters; enterprise/store/reviewer names at most 255 characters
(and the normalized registered enterprise key must fit 128). Batch sizing must respect both count
and bytes; 1000 maximum-length records may require several batches. Never truncate. Duplicate
identities in one batch are rejected. Each batch commits or rolls back atomically; multiple batches
have no global rollback. Success returns `received`, `inserted`, `updated`, `unchanged` counts.
Repeated upserts do not add duplicate rows, but counts and cursor versions can change.

On timeout, check current authorized rows before deciding what happened. Report confirmed batches
separately from unconfirmed ones; unknown is not failure. Do not automatically replay stale content
that could overwrite a newer change. If read access cannot establish the result, keep it unconfirmed
and request the narrow missing confirmation rather than claiming success or failure.

`query_store_reviews` requires one explicitly chosen enterprise and returns complete currently
readable rows before pagination. Optional exact `storeNames` (at most 100), `sources`,
`reviewerName`, inclusive time bounds and `hasReply` filter; false matches null/empty reply, true
matches other reply text. Default limit 50, maximum 200. Ordering is fixed `reviewedAt DESC, id DESC`;
no arbitrary sort or aggregation. Large pages return fewer complete rows to fit the default MCP client
response buffer (10 MiB with 64 KiB reserved for its envelope), including JSON text escaping;
fields are never truncated. Continue with nextCursor even when the returned count is below limit. Admins require complete category/enterprise/store grants and
sufficient clearance just like other readers.

`query_store_reviews` — inclusive time range:

```json
{
  "enterpriseName": "合成餐饮企业",
  "storeNames": ["合成门店"],
  "sources": ["美团评价", "点评评价"],
  "reviewedAtFrom": "2026-10-01 00",
  "reviewedAtTo": "2026-10-17 23:59:59",
  "hasReply": false,
  "limit": 50
}
```

`query_store_reviews` — later page (replace the synthetic placeholder only with the returned cursor):

```json
{
  "enterpriseName": "合成餐饮企业",
  "storeNames": ["合成门店"],
  "sources": ["美团评价", "点评评价"],
  "reviewedAtFrom": "2026-10-01 00",
  "reviewedAtTo": "2026-10-17 23:59:59",
  "hasReply": false,
  "limit": 50,
  "cursor": "opaque-cursor-from-previous-page"
}
```

Keep all filters and limit unchanged when sending `page.nextCursor`. Cursors are opaque, at most
4096 characters, signed for this account/organization/query/permission version and expire after
15 minutes. Data or authorization changes invalidate continuation; reread the permission card and
restart instead of reusing an old access decision. An empty authorized page does not prove an
unsynced batch failed.
