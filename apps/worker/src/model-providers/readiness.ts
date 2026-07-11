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
  const provider = input.env["LLM_PROVIDER"] || input.retrievalConfig.denseEmbedding.provider;
  const productionLike = ["staging", "production"].includes(input.runtimeProfile);
  const realProviderEnabled = provider === "openai-compatible";

  if (realProviderEnabled) {
    requireEnv(input.env, "OPENAI_COMPATIBLE_API_KEY", errors);
    requireEnv(input.env, "OPENAI_COMPATIBLE_BASE_URL", errors);
    requireEnv(input.env, "LLM_EMBEDDING_MODEL", errors);

    if (input.env["EXTERNAL_MODEL_EGRESS_ACKNOWLEDGED"] !== "true") {
      errors.push(
        "EXTERNAL_MODEL_EGRESS_ACKNOWLEDGED must be true before real embedding or rerank calls are enabled."
      );
    }
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
      input.retrievalConfig.rerank.provider !== "openai-compatible"
    ) {
      errors.push("Production-like retrieval requires the real openai-compatible rerank provider.");
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
