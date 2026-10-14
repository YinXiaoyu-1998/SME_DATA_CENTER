import Fastify from "fastify";
import { describe, expect, it, vi } from "vitest";
import type { CostCardDirectoryRepository } from "@smedc/db";
import type { StorageAdapter } from "@smedc/storage";
import { createCostCardService } from "../cost-cards.js";
import { registerCostCardRoutes } from "./cost-cards.js";
import type { RequestAuth } from "../request-auth.js";

const card = {
  id: "card1",
  orgId: "org",
  enterpriseKey: "enterprise",
  enterpriseName: "Enterprise",
  sourceNamespace: "meituan",
  spuId: "spu",
  skuId: "sku",
  dishName: "滩羊肉锅",
  specificationName: "小份",
  revision: 1n,
  csvSchemaVersion: 1,
  itemRowCount: 2n,
  byteSize: 100n,
  checksumSha256: "a".repeat(64),
  objectKey: "cost-cards/current.csv",
  sourceDocumentId: "source1",
  importBatchId: "batch1"
};
function fixture(now?: () => Date) {
  const readSnapshot = vi.fn(async () => ({ authorizationVersion: "1", cards: [{ ...card }] }));
  const archive = vi.fn(async () => ({
    costCardId: "card1",
    archived: true as const,
    revision: "2"
  }));
  const repository = { readSnapshot, archive } as unknown as CostCardDirectoryRepository;
  const createDownloadUrl = vi.fn(async () => "https://storage.example.invalid/current.csv");
  const storage = { createDownloadUrl } as unknown as StorageAdapter;
  const service = createCostCardService({
    repository,
    storage,
    maxCards: 10,
    urlTtlSeconds: 5000,
    now
  });
  const app = Fastify();
  registerCostCardRoutes(app, {
    auth: {
      authenticate: async () => true,
      employee: () => ({ id: "employee", orgId: "org" })
    } as unknown as RequestAuth,
    costCards: () => service
  });
  return { app, readSnapshot, createDownloadUrl, archive };
}
describe("cost card manifest and archive routes", () => {
  it("fixes per-card sources and revisions, bounds TTL and strips internal keys", async () => {
    const { app, readSnapshot, createDownloadUrl } = fixture();
    try {
      const response = await app.inject({
        method: "POST",
        url: "/v1/cost-cards/manifest",
        payload: { costCardIds: ["card1"] }
      });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({
        cardCount: 1,
        totalItemRowCount: 2,
        cards: [
          {
            costCardId: "card1",
            revision: "1",
            sourceDocumentId: "source1",
            importBatchId: "batch1",
            schemaVersion: 1
          }
        ]
      });
      expect(response.json().cards[0]).not.toHaveProperty("objectKey");
      expect(createDownloadUrl).toHaveBeenCalledWith(
        card.objectKey,
        expect.objectContaining({ expiresInSeconds: 900, downloadFileName: "card1.csv" })
      );
      expect(readSnapshot).toHaveBeenCalledTimes(2);
      const archived = await app.inject({ method: "POST", url: "/v1/cost-cards/card1/archive" });
      expect(archived.json()).toEqual({ costCardId: "card1", archived: true, revision: "2" });
    } finally {
      await app.close();
    }
  });
  it("discards all signed URLs when a fresh read finds changed cards", async () => {
    const { app, readSnapshot } = fixture();
    readSnapshot.mockResolvedValueOnce({ authorizationVersion: "1", cards: [{ ...card }] });
    readSnapshot.mockResolvedValueOnce({
      authorizationVersion: "2",
      cards: [{ ...card, revision: 2n }]
    });
    try {
      const response = await app.inject({
        method: "POST",
        url: "/v1/cost-cards/manifest",
        payload: {}
      });
      expect(response.statusCode).toBe(409);
      expect(response.json().error).toMatchObject({ code: "COST_CARD_CHANGED", retryable: true });
      expect(JSON.stringify(response.json())).not.toContain("storage.example.invalid");
    } finally {
      await app.close();
    }
  });
  it("does not extend cached signature expiry and rejects a signing operation that exhausts TTL", async () => {
    let clock = new Date("2026-10-14T00:00:00Z");
    const { app, createDownloadUrl } = fixture(() => clock);
    try {
      createDownloadUrl.mockResolvedValue(
        "https://storage.example.invalid/current.csv?X-Amz-Date=20261014T000000Z&X-Amz-Expires=30"
      );
      const response = await app.inject({
        method: "POST",
        url: "/v1/cost-cards/manifest",
        payload: {}
      });
      expect(response.statusCode).toBe(200);
      expect(response.json().expiresAt).toBe("2026-10-14T00:00:30.000Z");
      clock = new Date("2026-10-14T00:00:31Z");
      expect(
        (await app.inject({ method: "POST", url: "/v1/cost-cards/manifest", payload: {} })).json()
          .error.code
      ).toBe("COST_CARD_CHANGED");
      clock = new Date("2026-10-14T00:00:00Z");
      createDownloadUrl.mockImplementation(async () => {
        clock = new Date("2026-10-14T00:16:00Z");
        return "https://storage.example.invalid/current.csv";
      });
      expect(
        (await app.inject({ method: "POST", url: "/v1/cost-cards/manifest", payload: {} })).json()
          .error.code
      ).toBe("COST_CARD_CHANGED");
    } finally {
      await app.close();
    }
  });
});
