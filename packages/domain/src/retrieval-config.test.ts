import { describe, expect, it } from "vitest";
import {
  buildRetrievalConfigSeed,
  loadActiveRetrievalConfig,
  toEvidenceSearchRetrievalMetadata,
  toIndexModelMetadata
} from "./retrieval-config.js";

describe("retrieval config seed and loader", () => {
  it("seeds active, candidate, and deprecated retrieval config versions", () => {
    const configs = buildRetrievalConfigSeed({
      retrievalConfigVersion: "phase3.retrieval.v1",
      qdrantCollection: "smedc_evidence_test",
      llmProvider: "fake",
      embeddingModel: "fake-embedding-v1",
      rerankModel: "fake-rerank-v1"
    });

    expect(configs.map((config) => config.status)).toEqual(["active", "candidate", "deprecated"]);
    expect(configs[0]).toMatchObject({
      version: "phase3.retrieval.v1",
      denseEmbedding: {
        provider: "fake",
        model: "fake-embedding-v1",
        dimension: 8
      },
      rerank: {
        enabled: true,
        provider: "fake",
        model: "fake-rerank-v1"
      },
      qdrant: {
        collection: "smedc_evidence_test"
      },
      relevance: {
        mode: "disabled"
      },
      lexical: {
        strategy: "legacy_hash_tf"
      }
    });
  });

  it("enables the versioned relevance floor and gap policy only for V2", () => {
    const active = loadActiveRetrievalConfig(
      buildRetrievalConfigSeed({
        retrievalConfigVersion: "phase3.retrieval.v2-bm25",
        qdrantCollection: "smedc_evidence_test_v2"
      }),
      "phase3.retrieval.v2-bm25"
    );

    expect(active.relevance).toEqual({
      version: "relevance.v1@phase3.retrieval.v2-bm25",
      mode: "rerank_floor_and_gap",
      rerankMinScore: 0.3,
      rerankMinGap: 0.3,
      rerankLowClusterMaxScore: 0.4
    });
    expect(active.lexical.strategy).toBe("qdrant_bm25");
  });

  it("selects native BM25 only for the explicit V2 retrieval family", () => {
    const active = loadActiveRetrievalConfig(
      buildRetrievalConfigSeed({ retrievalConfigVersion: "phase3.retrieval.v2-bm25" }),
      "phase3.retrieval.v2-bm25"
    );

    expect(active.lexical).toEqual({
      version: "lexical.bm25.v1@phase3.retrieval.v2-bm25",
      sparseModel: "qdrant/bm25",
      strategy: "qdrant_bm25"
    });
  });

  it.each([
    { rerankMinScore: Number.NaN },
    { rerankMinScore: -0.1 },
    { rerankLowClusterMaxScore: 1.1 },
    { rerankMinGap: 0 },
    { rerankMinGap: Number.POSITIVE_INFINITY }
  ])("rejects invalid relevance policy values: %o", (relevance) => {
    expect(() =>
      buildRetrievalConfigSeed({
        retrievalConfigVersion: "phase3.retrieval.v2-bm25",
        relevance
      })
    ).toThrow(/relevance/i);
  });

  it("loads the expected active config and rejects ambiguous active versions", () => {
    const configs = buildRetrievalConfigSeed({
      retrievalConfigVersion: "phase3.retrieval.v1",
      qdrantCollection: "smedc_evidence_test",
      llmProvider: "fake",
      embeddingModel: "fake-embedding-v1",
      rerankModel: "fake-rerank-v1"
    });

    const active = loadActiveRetrievalConfig(configs, "phase3.retrieval.v1");

    expect(active.version).toBe("phase3.retrieval.v1");
    expect(() =>
      loadActiveRetrievalConfig(
        [
          active,
          {
            ...active,
            version: "phase3.retrieval.v2"
          }
        ],
        undefined
      )
    ).toThrow(/exactly one active retrieval config/i);
  });

  it("derives index and evidence-response metadata without exposing credentials", () => {
    const active = loadActiveRetrievalConfig(
      buildRetrievalConfigSeed({
        retrievalConfigVersion: "phase3.retrieval.v1",
        qdrantCollection: "smedc_evidence_test",
        llmProvider: "openai-compatible",
        embeddingModel: "embedding-model",
        rerankModel: "rerank-model"
      }),
      "phase3.retrieval.v1"
    );

    expect(toIndexModelMetadata(active)).toEqual({
      embeddingProvider: "openai-compatible",
      embeddingModel: "embedding-model",
      embeddingVersion: "embedding-model@phase3.retrieval.v1",
      embeddingDimension: 1536,
      rerankProvider: "openai-compatible",
      rerankModel: "rerank-model",
      rerankVersion: "rerank-model@phase3.retrieval.v1"
    });
    expect(toEvidenceSearchRetrievalMetadata(active)).toEqual({
      retrievalConfigVersion: "phase3.retrieval.v1",
      embeddingVersion: "embedding-model@phase3.retrieval.v1",
      lexicalIndexVersion: "lexical.v1",
      rerankVersion: "rerank-model@phase3.retrieval.v1",
      rerankStatus: "enabled",
      relevance: {
        policyVersion: "relevance.disabled@phase3.retrieval.v1",
        cutoffReason: "disabled",
        droppedCount: 0
      }
    });
  });

  it("supports a configured real embedding dimension and independent DashScope rerank provider", () => {
    const active = loadActiveRetrievalConfig(
      buildRetrievalConfigSeed({
        retrievalConfigVersion: "phase3.retrieval.v1",
        qdrantCollection: "smedc_evidence_test",
        llmProvider: "openai-compatible",
        embeddingModel: "text-embedding-v4",
        embeddingDimension: 1024,
        rerankProvider: "dashscope",
        rerankModel: "qwen3-rerank"
      }),
      "phase3.retrieval.v1"
    );

    expect(active.denseEmbedding).toMatchObject({
      provider: "openai-compatible",
      model: "text-embedding-v4",
      dimension: 1024
    });
    expect(active.rerank).toMatchObject({
      enabled: true,
      provider: "dashscope",
      model: "qwen3-rerank"
    });
    expect(toIndexModelMetadata(active)).toMatchObject({
      embeddingProvider: "openai-compatible",
      embeddingDimension: 1024,
      rerankProvider: "dashscope",
      rerankModel: "qwen3-rerank"
    });
  });
});
