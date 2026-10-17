import { createHash } from "node:crypto";
import {
  STORE_REVIEW_LIMITS,
  STORE_REVIEW_SOURCES,
  StoreReviewValidationError,
  normalizeStoreReviewTime,
  parseStoreReviewEnterprise,
  requireStoreReviewObject,
  requireStoreReviewString,
  type StoreReviewQuery,
  type StoreReviewSource
} from "./store-reviews.js";
export function parseStoreReviewQuery(value: unknown): StoreReviewQuery {
  const r = requireStoreReviewObject(value, [
    "enterpriseName",
    "storeNames",
    "sources",
    "reviewedAtFrom",
    "reviewedAtTo",
    "reviewerName",
    "hasReply",
    "limit",
    "cursor"
  ]);
  const query: StoreReviewQuery = {
    enterpriseName: parseStoreReviewEnterprise(r["enterpriseName"]),
    limit: STORE_REVIEW_LIMITS.defaultLimit
  };
  for (const field of ["storeNames", "sources"] as const)
    if (r[field] !== undefined) {
      const values = r[field];
      if (
        !Array.isArray(values) ||
        values.length < 1 ||
        values.length >
          (field === "storeNames" ? STORE_REVIEW_LIMITS.maxStoreNames : STORE_REVIEW_SOURCES.length)
      )
        throw new StoreReviewValidationError("Invalid filter list.", { field });
      const parsed = [
        ...new Set(
          values.map((v) => requireStoreReviewString(v, field, STORE_REVIEW_LIMITS.identityChars))
        )
      ].sort();
      if (field === "sources") {
        if (parsed.some((v) => !STORE_REVIEW_SOURCES.includes(v as StoreReviewSource)))
          throw new StoreReviewValidationError("Invalid source filter.", { field });
        query.sources = parsed as StoreReviewSource[];
      } else query.storeNames = parsed;
    }
  for (const field of ["reviewedAtFrom", "reviewedAtTo"] as const)
    if (r[field] !== undefined)
      query[field] = normalizeStoreReviewTime(requireStoreReviewString(r[field], field, 32));
  if (query.reviewedAtFrom && query.reviewedAtTo && query.reviewedAtFrom > query.reviewedAtTo)
    throw new StoreReviewValidationError("Time range must be ordered.");
  if (r["reviewerName"] !== undefined)
    query.reviewerName = requireStoreReviewString(
      r["reviewerName"],
      "reviewerName",
      STORE_REVIEW_LIMITS.identityChars
    );
  if (r["hasReply"] !== undefined) {
    if (typeof r["hasReply"] !== "boolean")
      throw new StoreReviewValidationError("hasReply must be boolean.");
    query.hasReply = r["hasReply"];
  }
  if (r["limit"] !== undefined) {
    const limit = r["limit"];
    if (
      !Number.isInteger(limit) ||
      Number(limit) < 1 ||
      Number(limit) > STORE_REVIEW_LIMITS.maxRows
    )
      throw new StoreReviewValidationError("Invalid page limit.");
    query.limit = limit as number;
  }
  if (r["cursor"] !== undefined)
    query.cursor = requireStoreReviewString(r["cursor"], "cursor", STORE_REVIEW_LIMITS.cursorChars);
  return query;
}
export function hashStoreReviewQueryScope(input: {
  orgId: string;
  employeeId: string;
  enterpriseKey: string;
  authorizationVersion: string;
  query: StoreReviewQuery;
}): string {
  const { query: raw, ...identity } = input;
  const { cursor: _cursor, ...query } = parseStoreReviewQuery(raw);
  return createHash("sha256")
    .update(
      JSON.stringify({
        operation: "query_store_reviews",
        ...identity,
        query,
        sort: ["reviewedAt DESC", "id DESC"]
      })
    )
    .digest("hex");
}
