import { describe, expect, it, vi } from "vitest";
import { STORE_REVIEW_LIMITS } from "@smedc/domain";
import { ResourceAttributesError, StoreReviewRepositoryError } from "@smedc/db";
import { buildApiServer } from "../server.js";
import { createStoreReviewService } from "../store-reviews.js";

const row = {
  enterpriseName: "合成企业",
  source: "美团评价",
  storeName: "合成门店😀",
  reviewerName: "用户😀",
  reviewedAt: "2026-10-17 13"
};
function fixture() {
  const repository = {
    upsert: vi.fn(async () => ({ received: 1, inserted: 1, updated: 0, unchanged: 0 })),
    query: vi.fn(async () => ({ rows: [], page: { nextCursor: null } }))
  };
  const app = buildApiServer({
    logger: false,
    runtimeEnv: {},
    cursorSigningSecret: "test-secret",
    authenticateAccessToken: async () => ({
      id: "admin",
      orgId: "org",
      role: "admin",
      disabled: false,
      clearance: 3,
      displayName: "Admin",
      email: "admin@example.invalid",
      organizationName: "Synthetic"
    }),
    storeReviewService: createStoreReviewService({ repository })
  });
  return { app, repository };
}
const headers = { authorization: "Bearer synthetic", "content-type": "application/json" };
describe("authenticated store review routes", () => {
  it("requires authentication, rejects invalid/duplicate identities and caller orgId", async () => {
    const { app, repository } = fixture();
    try {
      expect(
        (
          await app.inject({
            method: "POST",
            url: "/v1/store-reviews/upsert",
            payload: { reviews: [row] }
          })
        ).statusCode
      ).toBe(401);
      expect(
        (
          await app.inject({
            method: "POST",
            url: "/v1/store-reviews/upsert",
            headers: { authorization: headers.authorization }
          })
        ).statusCode
      ).toBe(400);
      for (const payload of [
        { reviews: [{ ...row, reviewedAt: "2026-10-17" }] },
        { reviews: [row, { ...row, reviewedAt: "2026-10-17T13:00:00+08:00" }] },
        { reviews: [row], orgId: "foreign" }
      ]) {
        const response = await app.inject({
          method: "POST",
          url: "/v1/store-reviews/upsert",
          headers,
          payload
        });
        expect(response.statusCode).toBe(400);
        expect(response.json().error).toMatchObject({
          code: "STORE_REVIEW_INVALID_INPUT",
          requestId: expect.any(String)
        });
        expect(response.body).not.toContain("合成门店");
      }
      expect(repository.upsert).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });
  it("preserves arbitrary score dimensions, explicit null, and omitted update fields", async () => {
    const { app, repository } = fixture();
    try {
      const scores = JSON.parse('{"__proto__":8,"constructor":6,"服务":9}');
      const response = await app.inject({
        method: "POST",
        url: "/v1/store-reviews/upsert",
        headers,
        payload: JSON.stringify({ reviews: [{ ...row, scores, content: null }] })
      });
      expect(response.statusCode).toBe(200);
      expect(repository.upsert).toHaveBeenCalledWith(
        { id: "admin", orgId: "org" },
        { reviews: [{ ...row, reviewedAt: "2026-10-17T13:00:00+08:00", scores, content: null }] }
      );
      const actual = repository.upsert.mock.calls[0] as unknown as [
        unknown,
        { reviews: Array<Record<string, unknown>> }
      ];
      expect(actual[1].reviews[0]).not.toHaveProperty("merchantReply");
      expect(JSON.stringify(actual[1].reviews[0]!["scores"])).toBe(JSON.stringify(scores));
      expect(
        (
          await app.inject({
            method: "POST",
            url: "/v1/store-reviews/query",
            headers,
            payload: { enterpriseName: "合成企业" }
          })
        ).headers["cache-control"]
      ).toBe("no-store");
    } finally {
      await app.close();
    }
  });
  it("returns identifiable safe current-state errors and enforces transport and service byte limits", async () => {
    const { app, repository } = fixture();
    try {
      for (const [error, code, status] of [
        [new ResourceAttributesError("UPLOAD_ADMIN_REQUIRED"), "UPLOAD_ADMIN_REQUIRED", 403],
        [
          new StoreReviewRepositoryError("STORE_REVIEW_IDENTITY_NOT_AVAILABLE", { index: 0 }),
          "STORE_REVIEW_IDENTITY_NOT_AVAILABLE",
          409
        ],
        [
          new StoreReviewRepositoryError("AUTHORIZATION_NOT_ENABLED"),
          "AUTHORIZATION_NOT_ENABLED",
          409
        ]
      ] as const) {
        repository.upsert.mockRejectedValueOnce(error);
        const response = await app.inject({
          method: "POST",
          url: "/v1/store-reviews/upsert",
          headers,
          payload: { reviews: [row] }
        });
        expect(response.statusCode).toBe(status);
        expect(response.json().error.code).toBe(code);
      }
      const tooLarge = JSON.stringify({
        reviews: [row],
        padding: "中".repeat(Math.ceil(STORE_REVIEW_LIMITS.batchBytes / 3))
      });
      const response = await app.inject({
        method: "POST",
        url: "/v1/store-reviews/upsert",
        headers,
        payload: tooLarge
      });
      expect(response.statusCode).toBe(413);
      expect(response.json().error.code).toBe("PAYLOAD_TOO_LARGE");
      expect(() =>
        createStoreReviewService({ repository }).upsert({
          auth: { id: "admin", orgId: "org" },
          input: JSON.parse(tooLarge)
        })
      ).toThrow("Request payload is too large.");
    } finally {
      await app.close();
    }
  });
});
