import { describe, expect, it } from "vitest";
import { buildRetrievalConfigSeed, loadActiveRetrievalConfig } from "@enterprise-hub/domain";
import { validateModelProviderReadiness } from "./readiness.js";

describe("model provider readiness", () => {
  it("fails production-like readiness when real rerank config is missing", () => {
    const config = {
      ...loadActiveRetrievalConfig(
        buildRetrievalConfigSeed({
          retrievalConfigVersion: "phase3.retrieval.v1",
          qdrantCollection: "enterprise_hub_evidence_test",
          llmProvider: "openai-compatible",
          embeddingModel: "embedding-model",
          rerankModel: ""
        }),
        "phase3.retrieval.v1"
      ),
      rerank: {
        enabled: true as const,
        provider: "openai-compatible" as const,
        model: "",
        version: ""
      }
    };

    const readiness = validateModelProviderReadiness({
      runtimeProfile: "production",
      env: {
        LLM_PROVIDER: "openai-compatible",
        LLM_EMBEDDING_MODEL: "embedding-model",
        LLM_MODEL: "",
        OPENAI_COMPATIBLE_API_KEY: "sk-test-secret",
        OPENAI_COMPATIBLE_BASE_URL: "https://provider.example/v1",
        EXTERNAL_MODEL_EGRESS_ACKNOWLEDGED: "true"
      },
      retrievalConfig: config
    });

    expect(readiness.ok).toBe(false);
    expect(readiness.errors).toContain(
      "Production-like retrieval requires a configured real rerank model via LLM_MODEL."
    );
    expect(readiness.errors.join("\n")).not.toContain("sk-test-secret");
  });

  it("requires egress acknowledgement before real provider readiness can pass", () => {
    const config = loadActiveRetrievalConfig(
      buildRetrievalConfigSeed({
        retrievalConfigVersion: "phase3.retrieval.v1",
        qdrantCollection: "enterprise_hub_evidence_test",
        llmProvider: "openai-compatible",
        embeddingModel: "embedding-model",
        rerankModel: "rerank-model"
      }),
      "phase3.retrieval.v1"
    );

    const readiness = validateModelProviderReadiness({
      runtimeProfile: "staging",
      env: {
        LLM_PROVIDER: "openai-compatible",
        LLM_EMBEDDING_MODEL: "embedding-model",
        LLM_MODEL: "rerank-model",
        OPENAI_COMPATIBLE_API_KEY: "sk-test-secret",
        OPENAI_COMPATIBLE_BASE_URL: "https://provider.example/v1",
        EXTERNAL_MODEL_EGRESS_ACKNOWLEDGED: "false"
      },
      retrievalConfig: config
    });

    expect(readiness.ok).toBe(false);
    expect(readiness.errors).toContain(
      "EXTERNAL_MODEL_EGRESS_ACKNOWLEDGED must be true before real embedding or rerank calls are enabled."
    );
  });
});
