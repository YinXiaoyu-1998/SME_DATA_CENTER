import { describe, expect, it } from "vitest";
import {
  createFakeEmbeddingProvider,
  createOpenAICompatibleEmbeddingProvider
} from "./embedding.js";

describe("embedding providers", () => {
  it("batches large embedding requests and keeps the original order", async () => {
    const batchSizes: number[] = [];
    const provider = createOpenAICompatibleEmbeddingProvider({
      apiKey: "sk-test-secret",
      baseUrl: "https://provider.example/v1",
      model: "embedding-model",
      version: "embedding-model@phase3.retrieval.v2",
      dimension: 3,
      externalModelEgressAcknowledged: true,
      fetch: async (_url, init) => {
        const body = JSON.parse(String(init?.body)) as { input: string[] };
        batchSizes.push(body.input.length);

        return new Response(
          JSON.stringify({
            data: body.input.map((text) => ({ embedding: [text.length, 0, 0] }))
          }),
          { status: 200, headers: { "content-type": "application/json" } }
        );
      }
    });
    const texts = Array.from({ length: 23 }, (_, index) => "文".repeat(index + 1));

    const result = await provider.embedTexts(texts);

    expect(batchSizes).toEqual([10, 10, 3]);
    expect(result.embeddings).toHaveLength(23);
    expect(result.embeddings.map((embedding) => embedding[0])).toEqual(
      texts.map((text) => text.length)
    );
  });

  it("produces deterministic fake embeddings with the configured dimension", async () => {
    const provider = createFakeEmbeddingProvider({
      model: "fake-embedding-v1",
      version: "fake-embedding-v1@phase3.retrieval.v1",
      dimension: 8
    });

    const first = await provider.embedTexts(["差评处理 SOP", "会员复购"]);
    const second = await provider.embedTexts(["差评处理 SOP", "会员复购"]);

    expect(first.metadata).toEqual({
      provider: "fake",
      model: "fake-embedding-v1",
      version: "fake-embedding-v1@phase3.retrieval.v1",
      dimension: 8
    });
    expect(first.embeddings).toEqual(second.embeddings);
    expect(first.embeddings).toHaveLength(2);
    expect(first.embeddings[0]).toHaveLength(8);
    expect(first.embeddings[0]).not.toEqual(first.embeddings[1]);
  });

  it("blocks real embedding calls when external model egress is not acknowledged", async () => {
    let fetchCalls = 0;
    const provider = createOpenAICompatibleEmbeddingProvider({
      apiKey: "sk-test-secret",
      baseUrl: "https://provider.example/v1",
      model: "embedding-model",
      version: "embedding-model@phase3.retrieval.v1",
      dimension: 3,
      externalModelEgressAcknowledged: false,
      fetch: async () => {
        fetchCalls += 1;
        throw new Error("fetch should not be called");
      }
    });

    await expect(provider.embedTexts(["synthetic text only"])).rejects.toThrow(
      /EXTERNAL_MODEL_EGRESS_ACKNOWLEDGED=true/
    );
    expect(fetchCalls).toBe(0);
  });

  it("sends OpenAI-compatible embedding requests without exposing secrets in errors", async () => {
    const requests: Array<{ url: string; init: RequestInit }> = [];
    const provider = createOpenAICompatibleEmbeddingProvider({
      apiKey: "sk-test-secret",
      baseUrl: "https://provider.example/v1/",
      model: "embedding-model",
      version: "embedding-model@phase3.retrieval.v1",
      dimension: 3,
      externalModelEgressAcknowledged: true,
      fetch: async (url, init) => {
        requests.push({ url: String(url), init: init ?? {} });

        return new Response(
          JSON.stringify({
            data: [
              {
                embedding: [0.1, 0.2, 0.3]
              }
            ]
          }),
          { status: 200, headers: { "content-type": "application/json" } }
        );
      }
    });

    const result = await provider.embedTexts(["synthetic text only"]);

    expect(result.embeddings).toEqual([[0.1, 0.2, 0.3]]);
    expect(requests).toHaveLength(1);
    const [request] = requests;
    expect(request).toBeDefined();
    expect(request?.url).toBe("https://provider.example/v1/embeddings");
    expect(request?.init.method).toBe("POST");
    expect(request?.init.headers).toMatchObject({
      authorization: "Bearer sk-test-secret",
      "content-type": "application/json"
    });
    expect(JSON.parse(String(request?.init.body))).toEqual({
      model: "embedding-model",
      input: ["synthetic text only"],
      encoding_format: "float"
    });

    const failingProvider = createOpenAICompatibleEmbeddingProvider({
      apiKey: "sk-test-secret",
      baseUrl: "https://provider.example/v1",
      model: "embedding-model",
      version: "embedding-model@phase3.retrieval.v1",
      dimension: 3,
      externalModelEgressAcknowledged: true,
      fetch: async () => new Response("provider exploded", { status: 500 })
    });

    await expect(failingProvider.embedTexts(["synthetic text only"])).rejects.toThrow(
      /Embedding provider request failed: HTTP 500/
    );
    await expect(failingProvider.embedTexts(["synthetic text only"])).rejects.not.toThrow(
      /sk-test-secret|provider exploded/
    );
  });
});
