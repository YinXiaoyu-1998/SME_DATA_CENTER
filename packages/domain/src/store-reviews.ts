import { PUBLIC_INPUT_LIMITS } from "./input-boundaries.js";
import { normalizeEnterpriseIdentity } from "./structured-partitions.js";
export const STORE_REVIEW_SOURCES = ["美团评价", "点评评价"] as const;
export const STORE_REVIEW_LIMITS = Object.freeze({
  maxBatchRows: 1000,
  enterpriseNameChars: PUBLIC_INPUT_LIMITS.enterpriseNameChars,
  enterpriseKeyChars: 128,
  identityChars: 255,
  textChars: 16384,
  scoresBytes: 65536,
  batchBytes: 16777216,
  defaultLimit: 50,
  maxRows: 200,
  maxStoreNames: 100,
  cursorChars: PUBLIC_INPUT_LIMITS.cursorChars,
  cursorTtlSeconds: 900
});
export type StoreReviewSource = (typeof STORE_REVIEW_SOURCES)[number];
export type StoreReviewScores = Record<string, number> | null;
export type StoreReviewInput = {
  enterpriseName: string;
  source: StoreReviewSource;
  storeName: string;
  reviewedAt: string;
  reviewerName: string;
  content?: string | null;
  scores?: StoreReviewScores;
  merchantReply?: string | null;
};
export type UpsertStoreReviewsInput = { reviews: StoreReviewInput[] };
export type StoreReviewQuery = {
  enterpriseName: string;
  storeNames?: string[];
  sources?: StoreReviewSource[];
  reviewedAtFrom?: string;
  reviewedAtTo?: string;
  reviewerName?: string;
  hasReply?: boolean;
  limit?: number;
  cursor?: string;
};
export type StoreReviewRow = Omit<Required<StoreReviewInput>, "reviewedAt"> & {
  id: string;
  reviewedAt: string;
  createdAt: string;
  updatedAt: string;
};
export type StoreReviewWriteResult = {
  received: number;
  inserted: number;
  updated: number;
  unchanged: number;
};
export type StoreReviewQueryResult = {
  rows: StoreReviewRow[];
  page: { nextCursor: string | null };
};
export type StoreReviewActor = { id: string; orgId: string };
export type StoreReviewEnterpriseOptions = {
  complete: true;
  write: Array<{ enterpriseKey: string; enterpriseName: string }>;
  read: Array<{ enterpriseKey: string; enterpriseName: string }>;
};
export class StoreReviewValidationError extends Error {
  readonly code = "STORE_REVIEW_INVALID_INPUT";
  constructor(
    message: string,
    readonly details: { field?: string; index?: number; duplicateIndex?: number } = {}
  ) {
    super(message);
    this.name = "StoreReviewValidationError";
  }
}
export function requireStoreReviewObject(
  value: unknown,
  keys: readonly string[]
): Record<string, unknown> {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value))
  )
    throw new StoreReviewValidationError("Expected an object.");
  const object = value as Record<string, unknown>;
  for (const field of Object.keys(object))
    if (!keys.includes(field)) throw new StoreReviewValidationError("Unknown field.", { field });
  return object;
}
export function requireStoreReviewString(value: unknown, field: string, max: number): string {
  if (typeof value !== "string" || !value.trim() || value.length > max)
    throw new StoreReviewValidationError("Invalid string field.", { field });
  return value;
}
export function parseStoreReviewEnterprise(value: unknown): string {
  const name = requireStoreReviewString(
    value,
    "enterpriseName",
    STORE_REVIEW_LIMITS.enterpriseNameChars
  );
  const normalized = normalizeEnterpriseIdentity(name);
  if (normalized.enterpriseKey.length > STORE_REVIEW_LIMITS.enterpriseKeyChars)
    throw new StoreReviewValidationError("Enterprise identity exceeds directory limit.", {
      field: "enterpriseName"
    });
  return normalized.enterpriseName;
}
export function normalizeStoreReviewTime(value: string): string {
  const match =
    /^(\d{4})-(\d{2})-(\d{2})(?: (\d{2})(?::(\d{2})(?::(\d{2}))?)?|T(\d{2})(?::(\d{2})(?::(\d{2}))?)?\+08:00)$/.exec(
      value
    );
  if (!match) throw new StoreReviewValidationError("Time requires a Beijing date and hour.");
  const [, year, month, day, spaceHour, spaceMinute, spaceSecond, isoHour, isoMinute, isoSecond] =
    match;
  const hour = spaceHour ?? isoHour!,
    minute = spaceMinute ?? isoMinute ?? "00",
    second = spaceSecond ?? isoSecond ?? "00";
  const canonical = `${year}-${month}-${day}T${hour}:${minute}:${second}+08:00`;
  const date = new Date(canonical);
  if (
    Number(year) < 1000 ||
    Number(hour) > 23 ||
    Number(minute) > 59 ||
    Number(second) > 59 ||
    !Number.isFinite(date.getTime()) ||
    new Date(date.getTime() + 28800000).toISOString().slice(0, 19) !== canonical.slice(0, 19)
  )
    throw new StoreReviewValidationError("Invalid calendar time.");
  return canonical;
}
export function assertStoreReviewBatchBytes(value: unknown): void {
  if (Buffer.byteLength(JSON.stringify(value), "utf8") > STORE_REVIEW_LIMITS.batchBytes)
    throw new StoreReviewValidationError("Batch exceeds UTF-8 byte limit.");
}
export function parseStoreReviewBatch(value: unknown): UpsertStoreReviewsInput {
  const object = requireStoreReviewObject(value, ["reviews"]);
  const raw = object["reviews"];
  if (!Array.isArray(raw) || raw.length < 1 || raw.length > STORE_REVIEW_LIMITS.maxBatchRows)
    throw new StoreReviewValidationError("Batch must contain 1–1000 reviews.", {
      field: "reviews"
    });
  const seen = new Map<string, number>();
  const reviews = raw.map((value, index): StoreReviewInput => {
    try {
      const r = requireStoreReviewObject(value, [
        "enterpriseName",
        "source",
        "storeName",
        "reviewedAt",
        "reviewerName",
        "content",
        "scores",
        "merchantReply"
      ]);
      const enterpriseName = parseStoreReviewEnterprise(r["enterpriseName"]);
      if (!STORE_REVIEW_SOURCES.includes(r["source"] as StoreReviewSource))
        throw new StoreReviewValidationError("Invalid review source.", { field: "source" });
      const row: StoreReviewInput = {
        enterpriseName,
        source: r["source"] as StoreReviewSource,
        storeName: requireStoreReviewString(
          r["storeName"],
          "storeName",
          STORE_REVIEW_LIMITS.identityChars
        ),
        reviewerName: requireStoreReviewString(
          r["reviewerName"],
          "reviewerName",
          STORE_REVIEW_LIMITS.identityChars
        ),
        reviewedAt: normalizeStoreReviewTime(
          requireStoreReviewString(r["reviewedAt"], "reviewedAt", 32)
        )
      };
      for (const field of ["content", "merchantReply"] as const)
        if (Object.hasOwn(r, field)) {
          const text = r[field];
          if (
            text !== null &&
            (typeof text !== "string" || text.length > STORE_REVIEW_LIMITS.textChars)
          )
            throw new StoreReviewValidationError("Invalid nullable text.", { field });
          row[field] = text as string | null;
        }
      if (Object.hasOwn(r, "scores")) {
        if (r["scores"] === null) row.scores = null;
        else {
          const scores = r["scores"];
          if (
            scores === null ||
            typeof scores !== "object" ||
            Array.isArray(scores) ||
            Object.values(scores).some((v) => typeof v !== "number" || !Number.isFinite(v)) ||
            Buffer.byteLength(JSON.stringify(scores), "utf8") > STORE_REVIEW_LIMITS.scoresBytes
          )
            throw new StoreReviewValidationError(
              "Scores must be a bounded object of finite numbers.",
              { field: "scores" }
            );
          row.scores = Object.fromEntries(Object.entries(scores));
        }
      }
      const key = JSON.stringify([
        normalizeEnterpriseIdentity(enterpriseName).enterpriseKey,
        row.source,
        row.storeName,
        new Date(row.reviewedAt).toISOString(),
        row.reviewerName
      ]);
      const duplicateIndex = seen.get(key);
      if (duplicateIndex !== undefined)
        throw new StoreReviewValidationError("Duplicate review identity in batch.", {
          duplicateIndex
        });
      seen.set(key, index);
      return row;
    } catch (error) {
      if (error instanceof StoreReviewValidationError)
        throw new StoreReviewValidationError(error.message, { ...error.details, index });
      throw error;
    }
  });
  assertStoreReviewBatchBytes({ reviews });
  return { reviews };
}
