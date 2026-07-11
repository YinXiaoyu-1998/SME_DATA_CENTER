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
      qdrantCollection: "enterprise_hub_evidence_test",
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
        collection: "enterprise_hub_evidence_test"
      }
    });
  });

  it("loads the expected active config and rejects ambiguous active versions", () => {
    const configs = buildRetrievalConfigSeed({
      retrievalConfigVersion: "phase3.retrieval.v1",
      qdrantCollection: "enterprise_hub_evidence_test",
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
        qdrantCollection: "enterprise_hub_evidence_test",
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
      rerankStatus: "enabled"
    });
  });
});
