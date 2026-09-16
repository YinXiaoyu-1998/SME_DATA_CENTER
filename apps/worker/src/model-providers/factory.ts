import {
  buildRetrievalConfigSeed,
  loadActiveRetrievalConfig,
  type RetrievalModelConfig
} from "@smedc/domain";
import {
  createFakeEmbeddingProvider,
  createOpenAICompatibleEmbeddingProvider,
  type EmbeddingProvider
} from "./embedding.js";
import {
  createFakeRerankProvider,
  createDashScopeRerankProvider,
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
      embeddingDimension: parsePositiveInteger(env["LLM_EMBEDDING_DIMENSION"]),
      rerankProvider: env["RERANK_PROVIDER"],
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
      rerankProvider: createRerankProvider({
        retrievalConfig,
        env,
        fetch: input.fetch
      })
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
    rerankProvider: createRerankProvider({
      retrievalConfig,
      env,
      fetch: input.fetch
    })
  };
}

function createRerankProvider(input: {
  retrievalConfig: RetrievalModelConfig;
  env: NodeJS.ProcessEnv;
  fetch?: FetchLike | undefined;
}): RerankProvider | null {
  const { retrievalConfig, env } = input;

  if (!retrievalConfig.rerank.enabled) {
    return null;
  }

  const externalModelEgressAcknowledged = env["EXTERNAL_MODEL_EGRESS_ACKNOWLEDGED"] === "true";

  if (retrievalConfig.rerank.provider === "fake") {
    return createFakeRerankProvider({
      model: retrievalConfig.rerank.model,
      version: retrievalConfig.rerank.version
    });
  }

  if (retrievalConfig.rerank.provider === "dashscope") {
    return createDashScopeRerankProvider({
      apiKey: optionalString(env["DASHSCOPE_API_KEY"]) ?? env["OPENAI_COMPATIBLE_API_KEY"] ?? "",
      baseUrl:
        optionalString(env["DASHSCOPE_API_BASE_URL"]) ?? "https://dashscope.aliyuncs.com/api/v1",
      model: retrievalConfig.rerank.model,
      version: retrievalConfig.rerank.version,
      externalModelEgressAcknowledged,
      fetch: input.fetch
    });
  }

  return createOpenAICompatibleRerankProvider({
    apiKey: env["OPENAI_COMPATIBLE_API_KEY"] ?? "",
    baseUrl: env["OPENAI_COMPATIBLE_BASE_URL"] ?? "",
    model: retrievalConfig.rerank.model,
    version: retrievalConfig.rerank.version,
    externalModelEgressAcknowledged,
    fetch: input.fetch
  });
}

function parsePositiveInteger(value: string | undefined): number | undefined {
  if (!value) {
    return undefined;
  }

  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

function optionalString(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}
