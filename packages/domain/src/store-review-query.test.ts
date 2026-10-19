import { expect, it } from "vitest";
import { hashStoreReviewQueryScope, parseStoreReviewQuery } from "./store-review-query.js";
it("validates strict bounded filters and ordered inclusive time ranges", () => {
  expect(parseStoreReviewQuery({ enterpriseName: "企业", hasReply: false })).toMatchObject({
    hasReply: false,
    limit: 50
  });
  for (const input of [
    {},
    { enterpriseName: "企业", orgId: "x" },
    { enterpriseName: "企业", limit: 201 },
    { enterpriseName: "企业", sources: ["other"] },
    { enterpriseName: "企业", reviewedAtFrom: "2026-10-18 12", reviewedAtTo: "2026-10-17 12" },
    { enterpriseName: "企业", cursor: "x".repeat(4097) }
  ])
    expect(() => parseStoreReviewQuery(input)).toThrow();
});
it("hash binds all identity, version and normalized filters while excluding cursor", () => {
  const input = {
    orgId: "org",
    employeeId: "employee",
    enterpriseKey: "enterprise",
    authorizationVersion: "1",
    query: parseStoreReviewQuery({
      enterpriseName: "企业",
      storeNames: ["B", "A"],
      reviewedAtFrom: "2026-10-17 13"
    })
  };
  const hash = hashStoreReviewQueryScope(input);
  expect(
    hashStoreReviewQueryScope({
      ...input,
      query: { ...input.query, cursor: "unused", storeNames: ["A", "B"] }
    })
  ).toBe(hash);
  for (const patch of [
    { orgId: "other" },
    { employeeId: "other" },
    { enterpriseKey: "other" },
    { authorizationVersion: "2" },
    { query: { ...input.query, hasReply: false } }
  ])
    expect(hashStoreReviewQueryScope({ ...input, ...patch })).not.toBe(hash);
});

it("normalizes bounded platform status lists and binds them into cursor scope", () => {
  const query = parseStoreReviewQuery({
    enterpriseName: "企业",
    replyStatuses: ["replied", "needs_verification", "replied"]
  });
  expect(query.replyStatuses).toEqual(["needs_verification", "replied"]);
  expect(
    parseStoreReviewQuery({
      enterpriseName: "企业",
      replyStatuses: [
        "replied",
        "needs_verification",
        "unreplied_no_content",
        "unreplied_with_content"
      ]
    }).replyStatuses
  ).toHaveLength(4);
  for (const replyStatuses of [[], ["bad"], [null], null, Array(5).fill("replied")])
    expect(() => parseStoreReviewQuery({ enterpriseName: "企业", replyStatuses })).toThrow();
  const scope = {
    orgId: "org",
    employeeId: "employee",
    enterpriseKey: "enterprise",
    authorizationVersion: "1",
    query
  };
  expect(hashStoreReviewQueryScope(scope)).toBe(
    hashStoreReviewQueryScope({
      ...scope,
      query: { ...query, replyStatuses: ["replied", "needs_verification"] }
    })
  );
  expect(hashStoreReviewQueryScope(scope)).not.toBe(
    hashStoreReviewQueryScope({ ...scope, query: { ...query, replyStatuses: ["replied"] } })
  );
});

it("validates exact feedback filters and binds them to cursor scope", () => {
  const query = parseStoreReviewQuery({ enterpriseName: "企业", feedbackId: " feedback-A " });
  expect(query.feedbackId).toBe(" feedback-A ");
  for (const feedbackId of [null, 1, "", " ", "x".repeat(256), "\ud800"])
    expect(() => parseStoreReviewQuery({ enterpriseName: "企业", feedbackId })).toThrow();
  const scope = {
    orgId: "org",
    employeeId: "employee",
    enterpriseKey: "enterprise",
    authorizationVersion: "1",
    query
  };
  expect(hashStoreReviewQueryScope(scope)).not.toBe(
    hashStoreReviewQueryScope({ ...scope, query: { ...query, feedbackId: "feedback-A" } })
  );
});
