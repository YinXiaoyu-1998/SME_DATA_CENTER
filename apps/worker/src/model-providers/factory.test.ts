import { describe, expect, it } from "vitest";
import { createModelProvidersFromEnv } from "./factory.js";

describe("model provider factory", () => {
  it("creates local fake providers from the documented env names", async () => {
    const providers = createModelProvidersFromEnv({
      env: {
        LLM_PROVIDER: "fake",
        LLM_EMBEDDING_MODEL: "fake-embedding-v1",
        LLM_MODEL: "fake-rerank-v1",
        RETRIEVAL_CONFIG_VERSION: "phase3.retrieval.v1",
        QDRANT_COLLECTION_EVIDENCE: "enterprise_hub_evidence_test"
      }
    });

    expect(providers.retrievalConfig.version).toBe("phase3.retrieval.v1");
    expect(providers.embeddingProvider.metadata).toEqual({
      provider: "fake",
      model: "fake-embedding-v1",
      version: "fake-embedding-v1@phase3.retrieval.v1",
      dimension: 8
    });
    expect(providers.rerankProvider?.metadata).toEqual({
      provider: "fake",
      model: "fake-rerank-v1",
      version: "fake-rerank-v1@phase3.retrieval.v1"
    });
  });

  it("creates OpenAI-compatible providers from existing external model env names", async () => {
    const providers = createModelProvidersFromEnv({
      env: {
        LLM_PROVIDER: "openai-compatible",
        LLM_EMBEDDING_MODEL: "embedding-model",
        LLM_MODEL: "rerank-model",
        OPENAI_COMPATIBLE_API_KEY: "sk-test-secret",
        OPENAI_COMPATIBLE_BASE_URL: "https://provider.example/v1",
        EXTERNAL_MODEL_EGRESS_ACKNOWLEDGED: "true",
        RETRIEVAL_CONFIG_VERSION: "phase3.retrieval.v1",
        QDRANT_COLLECTION_EVIDENCE: "enterprise_hub_evidence_test"
      },
      fetch: async () => new Response(JSON.stringify({ data: [] }))
    });

    expect(providers.embeddingProvider.metadata).toMatchObject({
      provider: "openai-compatible",
      model: "embedding-model",
      version: "embedding-model@phase3.retrieval.v1",
      dimension: 1536
    });
    expect(providers.rerankProvider?.metadata).toMatchObject({
      provider: "openai-compatible",
      model: "rerank-model",
      version: "rerank-model@phase3.retrieval.v1"
    });
  });

  it("keeps embeddings OpenAI-compatible while using DashScope rerank and configured dimensions", async () => {
    const providers = createModelProvidersFromEnv({
      env: {
        LLM_PROVIDER: "openai-compatible",
        LLM_EMBEDDING_MODEL: "text-embedding-v4",
        LLM_EMBEDDING_DIMENSION: "1024",
        RERANK_PROVIDER: "dashscope",
        LLM_MODEL: "qwen3-rerank",
        OPENAI_COMPATIBLE_API_KEY: "sk-test-secret",
        OPENAI_COMPATIBLE_BASE_URL: "https://dashscope.aliyuncs.com/compatible-mode/v1",
        DASHSCOPE_API_BASE_URL: "https://dashscope.aliyuncs.com/api/v1",
        EXTERNAL_MODEL_EGRESS_ACKNOWLEDGED: "true",
        RETRIEVAL_CONFIG_VERSION: "phase3.retrieval.v1",
        QDRANT_COLLECTION_EVIDENCE: "enterprise_hub_evidence_test"
      },
      fetch: async () => new Response(JSON.stringify({ data: [] }))
    });

    expect(providers.embeddingProvider.metadata).toMatchObject({
      provider: "openai-compatible",
      model: "text-embedding-v4",
      version: "text-embedding-v4@phase3.retrieval.v1",
      dimension: 1024
    });
    expect(providers.rerankProvider?.metadata).toMatchObject({
      provider: "dashscope",
      model: "qwen3-rerank",
      version: "qwen3-rerank@phase3.retrieval.v1"
    });
    expect(providers.retrievalConfig.rerank).toMatchObject({
      enabled: true,
      provider: "dashscope",
      model: "qwen3-rerank"
    });
  });

  it("selects DashScope rerank independently from fake local embeddings", async () => {
    const providers = createModelProvidersFromEnv({
      env: {
        LLM_PROVIDER: "fake",
        LLM_EMBEDDING_MODEL: "fake-embedding-v1",
        RERANK_PROVIDER: "dashscope",
        LLM_MODEL: "qwen3-rerank",
        OPENAI_COMPATIBLE_API_KEY: "sk-test-secret",
        EXTERNAL_MODEL_EGRESS_ACKNOWLEDGED: "true",
        RETRIEVAL_CONFIG_VERSION: "phase3.retrieval.v1",
        QDRANT_COLLECTION_EVIDENCE: "enterprise_hub_evidence_test"
      },
      fetch: async () =>
        new Response(JSON.stringify({ output: { results: [{ index: 0, relevance_score: 0.5 }] } }))
    });

    expect(providers.embeddingProvider.metadata.provider).toBe("fake");
    expect(providers.retrievalConfig.rerank).toMatchObject({
      enabled: true,
      provider: "dashscope",
      model: "qwen3-rerank"
    });
    expect(providers.rerankProvider?.metadata).toMatchObject({
      provider: "dashscope",
      model: "qwen3-rerank"
    });
  });

  it("falls back to the DashScope default base URL when env is blank", async () => {
    let requestedUrl = "";
    const providers = createModelProvidersFromEnv({
      env: {
        LLM_PROVIDER: "fake",
        RERANK_PROVIDER: "dashscope",
        LLM_MODEL: "qwen3-rerank",
        DASHSCOPE_API_BASE_URL: "",
        OPENAI_COMPATIBLE_API_KEY: "sk-test-secret",
        EXTERNAL_MODEL_EGRESS_ACKNOWLEDGED: "true"
      },
      fetch: async (url) => {
        requestedUrl = String(url);
        return new Response(
          JSON.stringify({ output: { results: [{ index: 0, relevance_score: 0.5 }] } })
        );
      }
    });

    await providers.rerankProvider?.rerank({
      query: "policy",
      documents: [{ id: "chunk_1", text: "policy text" }]
    });

    expect(requestedUrl).toBe(
      "https://dashscope.aliyuncs.com/api/v1/services/rerank/text-rerank/text-rerank"
    );
  });
});
