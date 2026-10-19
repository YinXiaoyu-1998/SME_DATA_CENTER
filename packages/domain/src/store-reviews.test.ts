import { describe, expect, it } from "vitest";
import {
  normalizeStoreReviewTime,
  parseStoreReviewBatch,
  resolveStoreReviewReplyState
} from "./store-reviews.js";
const row = {
  enterpriseName: "示例企业",
  source: "美团评价",
  storeName: "门店😀",
  reviewedAt: "2026-10-17 13",
  reviewerName: "用户"
};
describe("store review inputs", () => {
  it("accepts 1000 distinct rows and rejects 1001", () => {
    const reviews = Array.from({ length: 1000 }, (_, i) => ({ ...row, reviewerName: `用户${i}` }));
    expect(parseStoreReviewBatch({ reviews }).reviews).toHaveLength(1000);
    expect(() => parseStoreReviewBatch({ reviews: [...reviews, row] })).toThrow();
  });
  it("requires enterprise and rejects unknown fields and duplicate normalized keys", () => {
    expect(() =>
      parseStoreReviewBatch({ reviews: [{ ...row, enterpriseName: undefined }] })
    ).toThrow();
    expect(() => parseStoreReviewBatch({ reviews: [{ ...row, orgId: "other" }] })).toThrow();
    expect(() =>
      parseStoreReviewBatch({ reviews: [row, { ...row, reviewedAt: "2026-10-17T13:00:00+08:00" }] })
    ).toThrow(/duplicate/i);
  });
  it("preserves absent fields, explicit null and arbitrary finite score objects", () => {
    const parsed = parseStoreReviewBatch({ reviews: [row] }).reviews[0]!;
    expect(Object.hasOwn(parsed, "merchantReply")).toBe(false);
    for (const scores of [{}, null, { "口味😀": 8.5 }])
      expect(parseStoreReviewBatch({ reviews: [{ ...row, scores }] }).reviews[0]!.scores).toEqual(
        scores
      );
    for (const scores of [new Date(), [], "5", { x: "5" }, { x: Infinity }, { x: NaN }])
      expect(() => parseStoreReviewBatch({ reviews: [{ ...row, scores }] })).toThrow();
  });
  it("normalizes valid Beijing times idempotently and checks real calendars", () => {
    expect(normalizeStoreReviewTime(row.reviewedAt)).toBe("2026-10-17T13:00:00+08:00");
    for (const value of [
      "2026-10-17 13",
      "2026-10-17 13:02",
      "2026-10-17T13:02:03+08:00",
      "2024-02-29 00"
    ]) {
      const normalized = normalizeStoreReviewTime(value);
      expect(normalizeStoreReviewTime(normalized)).toBe(normalized);
    }
    for (const value of [
      "2026-02-30 13",
      "2026-10-17",
      "2026-10-17T13:00",
      "2026-10-17T13:00:00.1+08:00",
      "2026-10-17 24",
      "0000-01-01 00"
    ])
      expect(() => normalizeStoreReviewTime(value)).toThrow();
  });
  it("keeps exact store/reviewer identity and enforces byte budgets", () => {
    expect(
      parseStoreReviewBatch({ reviews: [row, { ...row, storeName: row.storeName + " " }] }).reviews
    ).toHaveLength(2);
    expect(() =>
      parseStoreReviewBatch({ reviews: [{ ...row, content: "x".repeat(16385) }] })
    ).toThrow();
    expect(() =>
      parseStoreReviewBatch({ reviews: [{ ...row, scores: { ["😀".repeat(16384)]: 1 } }] })
    ).toThrow();
  });
});

it("counts supplementary Unicode characters and rejects lossy malformed strings", () => {
  const content = "😀".repeat(16384);
  expect(
    parseStoreReviewBatch({ reviews: [{ ...row, reviewerName: "😀".repeat(255), content }] })
      .reviews[0]!.content
  ).toBe(content);
  expect(() => parseStoreReviewBatch({ reviews: [{ ...row, reviewerName: "\ud800" }] })).toThrow();
  expect(() =>
    parseStoreReviewBatch({
      reviews: Array.from({ length: 300 }, (_, i) => ({ ...row, reviewerName: String(i), content }))
    })
  ).toThrow(/byte limit/);
});

describe("platform reply state", () => {
  it("parses optional four-state facts while rejecting null, unknown and workflow fields", () => {
    for (const replyStatus of [
      "replied",
      "unreplied_no_content",
      "unreplied_with_content",
      "needs_verification"
    ])
      expect(
        parseStoreReviewBatch({ reviews: [{ ...row, replyStatus }] }).reviews[0]
      ).toMatchObject({ replyStatus });
    expect(
      Object.hasOwn(parseStoreReviewBatch({ reviews: [row] }).reviews[0]!, "replyStatus")
    ).toBe(false);
    for (const patch of [
      { replyStatus: null },
      { replyStatus: "draft" },
      { draftReply: "draft" },
      { aiSource: "AI" }
    ])
      expect(() => parseStoreReviewBatch({ reviews: [{ ...row, ...patch }] })).toThrow();
  });
  it.each([
    { content: null, merchantReply: " Published ", replyStatus: "replied" as const },
    { content: "", merchantReply: "Published", replyStatus: "replied" as const },
    { content: " \t", merchantReply: null, replyStatus: "unreplied_no_content" as const },
    { content: null, merchantReply: "", replyStatus: "unreplied_no_content" as const },
    { content: " Body ", merchantReply: "", replyStatus: "unreplied_with_content" as const },
    {
      content: "Recorded",
      merchantReply: "Old published",
      replyStatus: "needs_verification" as const
    }
  ])("preserves valid merged facts and original text: $replyStatus", (state) => {
    expect(resolveStoreReviewReplyState(null, state)).toEqual(state);
    expect(resolveStoreReviewReplyState(state, {})).toEqual(state);
    expect(resolveStoreReviewReplyState(state, { replyStatus: state.replyStatus })).toEqual(state);
  });
  it.each([
    { replyStatus: "replied" as const, content: "Body", merchantReply: null },
    { replyStatus: "replied" as const, content: null, merchantReply: " \t" },
    { replyStatus: "unreplied_no_content" as const, content: "Body", merchantReply: null },
    { replyStatus: "unreplied_no_content" as const, content: null, merchantReply: " " },
    { replyStatus: "unreplied_with_content" as const, content: " \t", merchantReply: "" },
    { replyStatus: "unreplied_with_content" as const, content: "Body", merchantReply: "Published" }
  ])("rejects explicit contradictory merged facts: $replyStatus", (state) => {
    expect(() => resolveStoreReviewReplyState(null, state)).toThrow();
  });
  it("validates a state-only patch against existing text and keeps scoring-only facts", () => {
    const existing = {
      content: null,
      merchantReply: "Published",
      replyStatus: "needs_verification" as const
    };
    expect(resolveStoreReviewReplyState(existing, { replyStatus: "replied" })).toEqual({
      ...existing,
      replyStatus: "replied"
    });
    expect(() =>
      resolveStoreReviewReplyState(existing, { replyStatus: "unreplied_no_content" })
    ).toThrow();
    expect(resolveStoreReviewReplyState({ ...existing, replyStatus: "replied" }, {})).toEqual({
      ...existing,
      replyStatus: "replied"
    });
  });
  it("defaults new rows to unknown and downgrades contradictory legacy patches without guessing", () => {
    expect(resolveStoreReviewReplyState(null, { content: "Body" })).toEqual({
      content: "Body",
      merchantReply: null,
      replyStatus: "needs_verification"
    });
    const existing = {
      content: "Body",
      merchantReply: null,
      replyStatus: "unreplied_with_content" as const
    };
    expect(resolveStoreReviewReplyState(existing, { merchantReply: " Published " })).toEqual({
      ...existing,
      merchantReply: " Published ",
      replyStatus: "needs_verification"
    });
    expect(resolveStoreReviewReplyState(existing, { content: null })).toEqual({
      ...existing,
      content: null,
      replyStatus: "needs_verification"
    });
    expect(resolveStoreReviewReplyState(existing, { content: "Other body" })).toEqual({
      ...existing,
      content: "Other body"
    });
    expect(
      resolveStoreReviewReplyState(
        { content: null, merchantReply: "Published", replyStatus: "replied" },
        { merchantReply: "" }
      )
    ).toEqual({ content: null, merchantReply: "", replyStatus: "needs_verification" });
  });
});
