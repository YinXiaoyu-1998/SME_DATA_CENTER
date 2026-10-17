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
