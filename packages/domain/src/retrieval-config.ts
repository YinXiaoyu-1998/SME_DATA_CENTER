export const RETRIEVAL_CONFIG_STATUSES = ["active", "candidate", "deprecated"] as const;

export type RetrievalConfigStatusName = (typeof RETRIEVAL_CONFIG_STATUSES)[number];

export const MODEL_PROVIDER_NAMES = ["fake", "openai-compatible"] as const;

export type ModelProviderName = (typeof MODEL_PROVIDER_NAMES)[number];

export interface RetrievalConfigSeedInput {
  retrievalConfigVersion?: string | undefined;
  qdrantCollection?: string | undefined;
  llmProvider?: ModelProviderName | string | undefined;
  embeddingModel?: string | undefined;
  rerankModel?: string | undefined;
  rerankEnabled?: boolean | undefined;
}

export interface RetrievalModelConfig {
  version: string;
  status: RetrievalConfigStatusName;
  chunker: {
    name: string;
    version: string;
  };
  denseEmbedding: {
    provider: ModelProviderName;
    model: string;
    version: string;
    dimension: number;
  };
  lexical: {
    version: string;
    sparseModel: string;
  };
  rerank: ExplicitRerankConfig;
  qdrant: {
    collection: string;
  };
}

export type ExplicitRerankConfig =
  | {
      enabled: true;
      provider: ModelProviderName;
      model: string;
      version: string;
    }
  | {
      enabled: false;
      disabledReason: string;
    };

export interface IndexModelMetadata {
  embeddingProvider: ModelProviderName;
  embeddingModel: string;
  embeddingVersion: string;
  embeddingDimension: number;
  rerankProvider: ModelProviderName | null;
  rerankModel: string | null;
  rerankVersion: string | null;
}

export interface EvidenceSearchRetrievalMetadata {
  retrievalConfigVersion: string;
  embeddingVersion: string;
  lexicalIndexVersion: string;
  rerankVersion: string | null;
  rerankStatus: "enabled" | "rerank_disabled";
}

const DEFAULT_RETRIEVAL_CONFIG_VERSION = "phase3.retrieval.v1";
const DEFAULT_QDRANT_COLLECTION = "enterprise_hub_evidence_local";
const DEFAULT_FAKE_EMBEDDING_MODEL = "fake-embedding-v1";
const DEFAULT_FAKE_RERANK_MODEL = "fake-rerank-v1";
const FAKE_EMBEDDING_DIMENSION = 8;
const OPENAI_COMPATIBLE_EMBEDDING_DIMENSION = 1536;
const LEXICAL_INDEX_VERSION = "lexical.v1";

export function buildRetrievalConfigSeed(
  input: RetrievalConfigSeedInput = {}
): RetrievalModelConfig[] {
  const activeVersion = input.retrievalConfigVersion?.trim() || DEFAULT_RETRIEVAL_CONFIG_VERSION;
  const provider = normalizeProviderName(input.llmProvider);
  const embeddingModel =
    input.embeddingModel?.trim() || (provider === "fake" ? DEFAULT_FAKE_EMBEDDING_MODEL : "");
  const rerankModel =
    input.rerankModel?.trim() || (provider === "fake" ? DEFAULT_FAKE_RERANK_MODEL : "");
  const qdrantCollection = input.qdrantCollection?.trim() || DEFAULT_QDRANT_COLLECTION;

  return [
    createRetrievalConfig({
      version: activeVersion,
      status: "active",
      provider,
      embeddingModel,
      rerankModel,
      rerankEnabled: input.rerankEnabled ?? true,
      qdrantCollection
    }),
    createRetrievalConfig({
      version: `${activeVersion}.candidate`,
      status: "candidate",
      provider,
      embeddingModel,
      rerankModel,
      rerankEnabled: input.rerankEnabled ?? true,
      qdrantCollection
    }),
    createRetrievalConfig({
      version: "phase3.retrieval.legacy-text",
      status: "deprecated",
      provider: "fake",
      embeddingModel: DEFAULT_FAKE_EMBEDDING_MODEL,
      rerankModel: DEFAULT_FAKE_RERANK_MODEL,
      rerankEnabled: false,
      qdrantCollection
    })
  ];
}

export function loadActiveRetrievalConfig(
  configs: readonly RetrievalModelConfig[],
  expectedVersion: string | undefined = undefined
): RetrievalModelConfig {
  const activeConfigs = configs.filter((config) => config.status === "active");

  if (activeConfigs.length !== 1) {
    throw new Error("Retrieval config loader expected exactly one active retrieval config.");
  }

  const activeConfig = activeConfigs[0];

  if (!activeConfig) {
    throw new Error("Retrieval config loader expected exactly one active retrieval config.");
  }

  if (expectedVersion && activeConfig.version !== expectedVersion) {
    throw new Error(
      `Active retrieval config version mismatch: expected ${expectedVersion}, found ${activeConfig.version}.`
    );
  }

  return activeConfig;
}

export function toIndexModelMetadata(config: RetrievalModelConfig): IndexModelMetadata {
  return {
    embeddingProvider: config.denseEmbedding.provider,
    embeddingModel: config.denseEmbedding.model,
    embeddingVersion: config.denseEmbedding.version,
    embeddingDimension: config.denseEmbedding.dimension,
    rerankProvider: config.rerank.enabled ? config.rerank.provider : null,
    rerankModel: config.rerank.enabled ? config.rerank.model : null,
    rerankVersion: config.rerank.enabled ? config.rerank.version : null
  };
}

export function toEvidenceSearchRetrievalMetadata(
  config: RetrievalModelConfig
): EvidenceSearchRetrievalMetadata {
  return {
    retrievalConfigVersion: config.version,
    embeddingVersion: config.denseEmbedding.version,
    lexicalIndexVersion: config.lexical.version,
    rerankVersion: config.rerank.enabled ? config.rerank.version : null,
    rerankStatus: config.rerank.enabled ? "enabled" : "rerank_disabled"
  };
}

function createRetrievalConfig(input: {
  version: string;
  status: RetrievalConfigStatusName;
  provider: ModelProviderName;
  embeddingModel: string;
  rerankModel: string;
  rerankEnabled: boolean;
  qdrantCollection: string;
}): RetrievalModelConfig {
  return {
    version: input.version,
    status: input.status,
    chunker: {
      name: "phase3.structure-aware",
      version: `chunker.v1@${input.version}`
    },
    denseEmbedding: {
      provider: input.provider,
      model: input.embeddingModel,
      version: `${input.embeddingModel}@${input.version}`,
      dimension:
        input.provider === "fake" ? FAKE_EMBEDDING_DIMENSION : OPENAI_COMPATIBLE_EMBEDDING_DIMENSION
    },
    lexical: {
      version: LEXICAL_INDEX_VERSION,
      sparseModel: "qdrant-native-sparse-v1"
    },
    rerank: input.rerankEnabled
      ? {
          enabled: true,
          provider: input.provider,
          model: input.rerankModel,
          version: `${input.rerankModel}@${input.version}`
        }
      : {
          enabled: false,
          disabledReason: "explicitly_disabled_by_retrieval_config"
        },
    qdrant: {
      collection: input.qdrantCollection
    }
  };
}

function normalizeProviderName(provider: string | undefined): ModelProviderName {
  if (provider === "openai-compatible") {
    return "openai-compatible";
  }

  return "fake";
}
