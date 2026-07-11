import { describe, expect, it } from "vitest";
import { createFakeRerankProvider, createOpenAICompatibleRerankProvider } from "./rerank.js";

describe("rerank providers", () => {
  it("exercises the fake rerank adapter interface deterministically", async () => {
    const provider = createFakeRerankProvider({
      model: "fake-rerank-v1",
      version: "fake-rerank-v1@phase3.retrieval.v1"
    });

    const first = await provider.rerank({
      query: "差评 SOP",
      documents: [
        { id: "chunk_a", text: "差评处理 SOP 和升级规则" },
        { id: "chunk_b", text: "会员储值说明" }
      ]
    });
    const second = await provider.rerank({
      query: "差评 SOP",
      documents: [
        { id: "chunk_a", text: "差评处理 SOP 和升级规则" },
        { id: "chunk_b", text: "会员储值说明" }
      ]
    });

    expect(first.metadata).toEqual({
      provider: "fake",
      model: "fake-rerank-v1",
      version: "fake-rerank-v1@phase3.retrieval.v1"
    });
    expect(first.scores).toEqual(second.scores);
    const [firstScore, secondScore] = first.scores;
    expect(firstScore?.documentId).toBe("chunk_a");
    expect(firstScore?.score).toBeGreaterThan(secondScore?.score ?? 0);
  });

  it("blocks real rerank calls when external model egress is not acknowledged", async () => {
    let fetchCalls = 0;
    const provider = createOpenAICompatibleRerankProvider({
      apiKey: "sk-test-secret",
      baseUrl: "https://provider.example/v1",
      model: "rerank-model",
      version: "rerank-model@phase3.retrieval.v1",
      externalModelEgressAcknowledged: false,
      fetch: async () => {
        fetchCalls += 1;
        throw new Error("fetch should not be called");
      }
    });

    await expect(
      provider.rerank({
        query: "synthetic query",
        documents: [{ id: "chunk_a", text: "synthetic document" }]
      })
    ).rejects.toThrow(/EXTERNAL_MODEL_EGRESS_ACKNOWLEDGED=true/);
    expect(fetchCalls).toBe(0);
  });

  it("sends OpenAI-compatible rerank requests and maps returned scores", async () => {
    const requests: Array<{ url: string; init: RequestInit }> = [];
    const provider = createOpenAICompatibleRerankProvider({
      apiKey: "sk-test-secret",
      baseUrl: "https://provider.example/v1/",
      model: "rerank-model",
      version: "rerank-model@phase3.retrieval.v1",
      externalModelEgressAcknowledged: true,
      fetch: async (url, init) => {
        requests.push({ url: String(url), init: init ?? {} });

        return new Response(
          JSON.stringify({
            results: [
              { index: 1, relevance_score: 0.25 },
              { index: 0, relevance_score: 0.91 }
            ]
          }),
          { status: 200, headers: { "content-type": "application/json" } }
        );
      }
    });

    const result = await provider.rerank({
      query: "synthetic query",
      documents: [
        { id: "chunk_a", text: "synthetic document A" },
        { id: "chunk_b", text: "synthetic document B" }
      ]
    });

    expect(result.scores).toEqual([
      { documentId: "chunk_a", score: 0.91 },
      { documentId: "chunk_b", score: 0.25 }
    ]);
    expect(requests).toHaveLength(1);
    const [request] = requests;
    expect(request).toBeDefined();
    expect(request?.url).toBe("https://provider.example/v1/rerank");
    expect(request?.init.method).toBe("POST");
    expect(request?.init.headers).toMatchObject({
      authorization: "Bearer sk-test-secret",
      "content-type": "application/json"
    });
    expect(JSON.parse(String(request?.init.body))).toEqual({
      model: "rerank-model",
      query: "synthetic query",
      documents: [
        { id: "chunk_a", text: "synthetic document A" },
        { id: "chunk_b", text: "synthetic document B" }
      ]
    });
  });
});
