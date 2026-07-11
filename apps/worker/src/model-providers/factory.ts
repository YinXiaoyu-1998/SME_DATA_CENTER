import {
  buildRetrievalConfigSeed,
  loadActiveRetrievalConfig,
  type RetrievalModelConfig
} from "@enterprise-hub/domain";
import {
  createFakeEmbeddingProvider,
  createOpenAICompatibleEmbeddingProvider,
  type EmbeddingProvider
} from "./embedding.js";
import {
  createFakeRerankProvider,
  createOpenAICompatibleRerankProvider,
  type RerankProvider
} from "./rerank.js";

type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export interface ModelProviderFactoryInput {
  env?: NodeJS.ProcessEnv | undefined;
  fetch?: FetchLike | undefined;
}

export interface ModelProviderFactoryResult {
  retrievalConfig: RetrievalModelConfig;
  embeddingProvider: EmbeddingProvider;
  rerankProvider: RerankProvider | null;
}

export function createModelProvidersFromEnv(
  input: ModelProviderFactoryInput = {}
): ModelProviderFactoryResult {
  const env = input.env ?? process.env;
  const retrievalConfig = loadActiveRetrievalConfig(
    buildRetrievalConfigSeed({
      retrievalConfigVersion: env["RETRIEVAL_CONFIG_VERSION"],
      qdrantCollection: env["QDRANT_COLLECTION_EVIDENCE"],
      llmProvider: env["LLM_PROVIDER"],
      embeddingModel: env["LLM_EMBEDDING_MODEL"],
      rerankModel: env["LLM_MODEL"]
    }),
    env["RETRIEVAL_CONFIG_VERSION"]
  );

  if (retrievalConfig.denseEmbedding.provider === "fake") {
    return {
      retrievalConfig,
      embeddingProvider: createFakeEmbeddingProvider({
        model: retrievalConfig.denseEmbedding.model,
        version: retrievalConfig.denseEmbedding.version,
        dimension: retrievalConfig.denseEmbedding.dimension
      }),
      rerankProvider: retrievalConfig.rerank.enabled
        ? createFakeRerankProvider({
            model: retrievalConfig.rerank.model,
            version: retrievalConfig.rerank.version
          })
        : null
    };
  }

  return {
    retrievalConfig,
    embeddingProvider: createOpenAICompatibleEmbeddingProvider({
      apiKey: env["OPENAI_COMPATIBLE_API_KEY"] ?? "",
      baseUrl: env["OPENAI_COMPATIBLE_BASE_URL"] ?? "",
      model: retrievalConfig.denseEmbedding.model,
      version: retrievalConfig.denseEmbedding.version,
      dimension: retrievalConfig.denseEmbedding.dimension,
      externalModelEgressAcknowledged: env["EXTERNAL_MODEL_EGRESS_ACKNOWLEDGED"] === "true",
      fetch: input.fetch
    }),
    rerankProvider: retrievalConfig.rerank.enabled
      ? createOpenAICompatibleRerankProvider({
          apiKey: env["OPENAI_COMPATIBLE_API_KEY"] ?? "",
          baseUrl: env["OPENAI_COMPATIBLE_BASE_URL"] ?? "",
          model: retrievalConfig.rerank.model,
          version: retrievalConfig.rerank.version,
          externalModelEgressAcknowledged: env["EXTERNAL_MODEL_EGRESS_ACKNOWLEDGED"] === "true",
          fetch: input.fetch
        })
      : null
  };
}
