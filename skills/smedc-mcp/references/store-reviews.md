# Store reviews

Launcher `0.15.0` is published, independently verified and approved for installation. Use the
core Skill's exact `smedc-mcp-launcher@0.15.0` installation procedure. Store-review tools require
the matching service release and explicit tenant category/grant configuration. Publication,
installation, a Skill refresh or tools/list alone does not establish service or tenant readiness;
verify current permission candidates and follow authoritative server denials.

Published, independently verified launcher `0.12.0` introduced the `replyStatus` / `replyStatuses`
extension. Confirm its matching service release, migration and tenant configuration before use;
package verification does not prove those rollout gates. Do not send the new fields through an
older installed contract or infer readiness from this reference alone.

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
successful verified publication, send only the identity, published reply and `replyStatus: "replied"`
so existing content and scores remain intact. No delete operation exists.

<a id="record-platform-reply-facts-candidate-0120"></a>

## Record platform reply facts (0.12.0)

`replyStatus` is optional on input and always present on returned rows. It describes the platform
facts verified when the record was written, not permission to publish a later reply. The client
confirms the platform's replied/unreplied state and treats system prompts such as “此用户没有填写评价”
as no customer content. The service only checks non-whitespace text; it does not interpret language
or rewrite the original text.

| `replyStatus`            | Required merged platform fields                                                                   |
| ------------------------ | ------------------------------------------------------------------------------------------------- |
| `replied`                | `merchantReply` is verified published, non-whitespace text; customer content may be absent.       |
| `unreplied_no_content`   | Platform explicitly unreplied; reply is null or empty string; content has no non-whitespace text. |
| `unreplied_with_content` | Platform explicitly unreplied; reply is null or empty string; content has non-whitespace text.    |
| `needs_verification`     | State or relevant content is incompletely verified; retain previously recorded text and replies.  |

An existing row's omitted status stays unchanged while the merged fields remain valid. A new row
without status and historical rows added before this column default to `needs_verification`;
null/empty replies never prove historical unreplied facts. A legacy patch that omits status and
contradicts the old status saves the changed fields and downgrades to `needs_verification`, without
guessing another platform state. For example, adding a published reply without status preserves the
reply but downgrades an old unreplied state. Modern clients send `replied` with that reply.
Explicit status validates against existing fields merged with the patch; contradictory combinations
return `STORE_REVIEW_INVALID_INPUT` (HTTP 400 with safe row index/field) and roll back the entire
batch. A status-only change counts as updated; rating-only patches preserve valid reply facts.
Null status, unknown status and extra draft/AI/approval fields are rejected.

Local “新生成待审核” / “AI 新稿待审核” and approved-but-unsent drafts remain
`unreplied_with_content` when those platform facts were verified. Even an approved draft may enter
`merchantReply` with `replied` only after actual platform publication and verification. AI draft
generation failure alone does not change complete platform facts to `needs_verification`. Do not
upload the review workbook's draft column wholesale or replace its five local workflow labels with
these four service values. The core Skill does not couple SMEDC synchronization into the review
replying workflow or authorize publication.

If the platform shows replied but the complete reply cannot be read, use `needs_verification` and
omit unread fields so recorded values survive. A login/authorization failure, timeout or whole-page
access failure provides no writable review facts: do not downgrade otherwise normal records or clear
replies in bulk. Missing business identity is still rejected. The authorized client must reobserve
and update after platform facts change; SMEDC never logs into the platform to verify them.

Examples below are synthetic tool arguments. Use each named tool, without adding orgId or a tool
wrapper to its arguments.

`upsert_store_reviews` — explicitly unreplied with observed content and scores:

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
      "merchantReply": null,
      "replyStatus": "unreplied_with_content",
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
      "merchantReply": "感谢您的评价，期待再次光临。",
      "replyStatus": "replied"
    }
  ]
}
```

`upsert_store_reviews` — explicitly unreplied without customer content:

```json
{
  "reviews": [
    {
      "enterpriseName": "合成餐饮企业",
      "source": "美团评价",
      "storeName": "合成门店",
      "reviewedAt": "2026-10-17 15",
      "reviewerName": "合成用户丙",
      "content": null,
      "merchantReply": "",
      "replyStatus": "unreplied_no_content"
    }
  ]
}
```

`upsert_store_reviews` — verified published reply to a review without customer content:

```json
{
  "reviews": [
    {
      "enterpriseName": "合成餐饮企业",
      "source": "点评评价",
      "storeName": "合成门店",
      "reviewedAt": "2026-10-17 16",
      "reviewerName": "合成用户丁",
      "content": null,
      "merchantReply": "感谢您的支持。",
      "replyStatus": "replied"
    }
  ]
}
```

`upsert_store_reviews` — replied indicator observed but unread text omitted for verification:

```json
{
  "reviews": [
    {
      "enterpriseName": "合成餐饮企业",
      "source": "美团评价",
      "storeName": "合成门店",
      "reviewedAt": "2026-10-17 13:20",
      "reviewerName": "合成用户甲",
      "replyStatus": "needs_verification"
    }
  ]
}
```

## Platform feedback identity (published 0.13.0)

Published, independently verified launcher `0.13.0` includes optional `feedbackId` input and
exact query filtering and is the approved installation pin. Before use, verify its matching
service deployment and `20261019010000_store_review_feedback_id` migration; package publication,
a Skill refresh or tools/list alone does not establish those gates or tenant authorization.
Do not send this field through an older installed contract.

When the platform exposes an ID, provide `reviews[].feedbackId` exactly as observed. It is an
optional identity string of 1–255 valid Unicode characters, not all whitespace. Preserve case,
leading/trailing spaces, the `feedback-` prefix and Unicode spelling: never trim, convert to a
number, normalize or impose a page-specific ID pattern. Null, numbers, empty/whitespace-only,
malformed UTF-16 and overlong values are rejected. It cannot be cleared or rebound as a patch.

The complete identity is server-authenticated organization + registered enterprise key + source +
exact store + canonical review instant + exact reviewer name + exact `feedbackId`. IDs are not
assumed globally unique across enterprises, stores or sources. Different IDs on the same old
identity save separate rows, including pure ratings; repeating the full identity updates or counts
as unchanged. Duplicate full identities in one batch fail with `STORE_REVIEW_INVALID_INPUT`
(HTTP 400, safe row indices). Mixing omitted and present IDs on the same old identity in one batch
also fails with HTTP 400 and safe `feedbackId` field/index details, regardless of row order.

Omission uses the legacy no-ID identity, never an arbitrary matching ID row. A present-ID write
against an existing no-ID row, an omitted-ID write against an existing ID row, or stored mixed
identity rows fails the entire batch with `STORE_REVIEW_IDENTITY_RECONCILIATION_REQUIRED`
(HTTP 409; safe input index only). Do not retry by dropping the ID or changing another identity
field. Existing no-ID records remain unchanged; adding IDs requires a separately authorized,
verifiable mapping from original platform records to stable internal row IDs. Nickname and minute
time alone cannot establish that mapping, and resubmitting old rows with IDs does not upgrade them.

`query_store_reviews.feedbackId` uses the same validation and exact comparison, combines with all
other filters using AND inside authorization scope before pagination, and is bound into the cursor.
Omission queries all authorized rows. Every returned row includes `feedbackId: string | null`;
legacy rows return null. Internal digest keys never appear in MCP results. Writes still return only
the four aggregate counts. Keep the ID filter unchanged on later pages. Once multiple IDs share
an old identity, the old service cannot safely process writes or serve as a direct rollback target.

`upsert_store_reviews` — same-minute pure ratings with distinct platform IDs:

```json
{
  "reviews": [
    {
      "enterpriseName": "合成餐饮企业",
      "source": "美团评价",
      "storeName": "合成门店",
      "reviewedAt": "2026-10-17 17:20",
      "reviewerName": "合成同名用户",
      "feedbackId": "feedback-test-a",
      "scores": { "总评": 4 }
    },
    {
      "enterpriseName": "合成餐饮企业",
      "source": "美团评价",
      "storeName": "合成门店",
      "reviewedAt": "2026-10-17 17:20",
      "reviewerName": "合成同名用户",
      "feedbackId": "feedback-test-b",
      "scores": { "总评": 5 }
    }
  ]
}
```

`query_store_reviews` — exact platform ID filter:

```json
{
  "enterpriseName": "合成餐饮企业",
  "feedbackId": "feedback-test-a",
  "limit": 50
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
matches other reply text (including retained old text on `needs_verification`). Optional
`replyStatuses` accepts a raw list of 1–4 of the four platform states, deduplicated and sorted.
It combines with `hasReply` using AND and filters within authorized scope before pagination.
Neither filter treats drafts as replies. Default limit 50, maximum 200. Ordering is fixed `reviewedAt DESC, id DESC`;
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
  "replyStatuses": ["unreplied_no_content", "unreplied_with_content"],
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
  "replyStatuses": ["unreplied_no_content", "unreplied_with_content"],
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
