import type { RetrievalModelConfig } from "@enterprise-hub/domain";

export type RuntimeProfile = "local" | "ci" | "development" | "staging" | "production";

export interface ModelProviderReadinessInput {
  runtimeProfile: RuntimeProfile;
  env: NodeJS.ProcessEnv;
  retrievalConfig: RetrievalModelConfig;
}

export interface ModelProviderReadinessResult {
  ok: boolean;
  errors: string[];
}

export function validateModelProviderReadiness(
  input: ModelProviderReadinessInput
): ModelProviderReadinessResult {
  const errors: string[] = [];
  const provider =
    optionalString(input.env["LLM_PROVIDER"]) ?? input.retrievalConfig.denseEmbedding.provider;
  const rerankProvider =
    optionalString(input.env["RERANK_PROVIDER"]) ??
    (input.retrievalConfig.rerank.enabled ? input.retrievalConfig.rerank.provider : undefined);
  const productionLike = ["staging", "production"].includes(input.runtimeProfile);
  const realEmbeddingEnabled = provider === "openai-compatible";
  const realRerankEnabled =
    input.retrievalConfig.rerank.enabled &&
    (rerankProvider === "openai-compatible" || rerankProvider === "dashscope");

  if (realEmbeddingEnabled) {
    requireEnv(input.env, "OPENAI_COMPATIBLE_API_KEY", errors);
    requireEnv(input.env, "OPENAI_COMPATIBLE_BASE_URL", errors);
    requireEnv(input.env, "LLM_EMBEDDING_MODEL", errors);
  }

  if (realRerankEnabled && !input.env["LLM_MODEL"]?.trim()) {
    errors.push("LLM_MODEL is required for real rerank provider readiness.");
  }

  if (realEmbeddingEnabled || realRerankEnabled) {
    requireExternalModelEgressAcknowledged(input.env, errors);
  }

  if (input.retrievalConfig.rerank.enabled && rerankProvider === "dashscope") {
    if (
      !input.env["DASHSCOPE_API_KEY"]?.trim() &&
      !input.env["OPENAI_COMPATIBLE_API_KEY"]?.trim()
    ) {
      errors.push(
        "DASHSCOPE_API_KEY or OPENAI_COMPATIBLE_API_KEY is required for DashScope rerank."
      );
    }
  }

  if (input.retrievalConfig.rerank.enabled && rerankProvider === "openai-compatible") {
    requireEnv(input.env, "OPENAI_COMPATIBLE_API_KEY", errors);
    requireEnv(input.env, "OPENAI_COMPATIBLE_BASE_URL", errors);
  }

  if (productionLike) {
    if (!input.retrievalConfig.rerank.enabled) {
      errors.push("Production-like retrieval requires rerank to be enabled in retrieval config.");
    } else if (!input.retrievalConfig.rerank.model || !input.env["LLM_MODEL"]?.trim()) {
      errors.push(
        "Production-like retrieval requires a configured real rerank model via LLM_MODEL."
      );
    }

    if (
      input.retrievalConfig.rerank.enabled &&
      !["openai-compatible", "dashscope"].includes(input.retrievalConfig.rerank.provider)
    ) {
      errors.push("Production-like retrieval requires a real rerank provider.");
    }
  }

  return {
    ok: errors.length === 0,
    errors
  };
}

function requireEnv(env: NodeJS.ProcessEnv, key: string, errors: string[]): void {
  if (!env[key]?.trim()) {
    errors.push(`${key} is required for openai-compatible model provider readiness.`);
  }
}

function requireExternalModelEgressAcknowledged(env: NodeJS.ProcessEnv, errors: string[]): void {
  if (env["EXTERNAL_MODEL_EGRESS_ACKNOWLEDGED"] !== "true") {
    errors.push(
      "EXTERNAL_MODEL_EGRESS_ACKNOWLEDGED must be true before real embedding or rerank calls are enabled."
    );
  }
}

function optionalString(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}
