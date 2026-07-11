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
});
