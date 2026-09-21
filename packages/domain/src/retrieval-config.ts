export const RETRIEVAL_CONFIG_STATUSES = ["active", "candidate", "deprecated"] as const;

export type RetrievalConfigStatusName = (typeof RETRIEVAL_CONFIG_STATUSES)[number];

export const MODEL_PROVIDER_NAMES = ["fake", "openai-compatible"] as const;

export type ModelProviderName = (typeof MODEL_PROVIDER_NAMES)[number];

export const RERANK_PROVIDER_NAMES = ["fake", "openai-compatible", "dashscope"] as const;

export type RerankProviderName = (typeof RERANK_PROVIDER_NAMES)[number];

export interface RetrievalConfigSeedInput {
  retrievalConfigVersion?: string | undefined;
  qdrantCollection?: string | undefined;
  llmProvider?: ModelProviderName | string | undefined;
  embeddingModel?: string | undefined;
  embeddingDimension?: number | undefined;
  rerankProvider?: RerankProviderName | string | undefined;
  rerankModel?: string | undefined;
  rerankEnabled?: boolean | undefined;
  relevance?:
    | Partial<
        Pick<
          EvidenceRelevancePolicy,
          "rerankMinScore" | "rerankMinGap" | "rerankLowClusterMaxScore"
        >
      >
    | undefined;
}

export interface EvidenceRelevancePolicy {
  version: string;
  mode: "disabled" | "rerank_floor_and_gap";
  rerankMinScore: number;
  rerankMinGap: number;
  rerankLowClusterMaxScore: number;
}

export type EvidenceRelevanceCutoffReason = "disabled" | "below_floor" | "score_gap" | "none";

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
  relevance: EvidenceRelevancePolicy;
  qdrant: {
    collection: string;
  };
}

export type ExplicitRerankConfig =
  | {
      enabled: true;
      provider: RerankProviderName;
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
  rerankProvider: RerankProviderName | null;
  rerankModel: string | null;
  rerankVersion: string | null;
}

export interface EvidenceSearchRetrievalMetadata {
  retrievalConfigVersion: string;
  embeddingVersion: string;
  lexicalIndexVersion: string;
  rerankVersion: string | null;
  rerankStatus: "enabled" | "rerank_disabled";
  relevance: {
    policyVersion: string;
    cutoffReason: EvidenceRelevanceCutoffReason;
    droppedCount: number;
  };
}

const DEFAULT_RETRIEVAL_CONFIG_VERSION = "phase3.retrieval.v1";
const DEFAULT_QDRANT_COLLECTION = "smedc_evidence_local";
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
  const rerankProvider = normalizeRerankProviderName(input.rerankProvider, provider);
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
      embeddingDimension: input.embeddingDimension,
      rerankProvider,
      embeddingModel,
      rerankModel,
      rerankEnabled: input.rerankEnabled ?? true,
      relevance: input.relevance,
      qdrantCollection
    }),
    createRetrievalConfig({
      version: `${activeVersion}.candidate`,
      status: "candidate",
      provider,
      embeddingDimension: input.embeddingDimension,
      rerankProvider,
      embeddingModel,
      rerankModel,
      rerankEnabled: input.rerankEnabled ?? true,
      relevance: input.relevance,
      qdrantCollection
    }),
    createRetrievalConfig({
      version: "phase3.retrieval.legacy-text",
      status: "deprecated",
      provider: "fake",
      embeddingDimension: FAKE_EMBEDDING_DIMENSION,
      rerankProvider: "fake",
      embeddingModel: DEFAULT_FAKE_EMBEDDING_MODEL,
      rerankModel: DEFAULT_FAKE_RERANK_MODEL,
      rerankEnabled: false,
      relevance: undefined,
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
  config: RetrievalModelConfig,
  relevance: {
    cutoffReason: EvidenceRelevanceCutoffReason;
    droppedCount: number;
  } = {
    cutoffReason: config.relevance.mode === "disabled" ? "disabled" : "none",
    droppedCount: 0
  }
): EvidenceSearchRetrievalMetadata {
  return {
    retrievalConfigVersion: config.version,
    embeddingVersion: config.denseEmbedding.version,
    lexicalIndexVersion: config.lexical.version,
    rerankVersion: config.rerank.enabled ? config.rerank.version : null,
    rerankStatus: config.rerank.enabled ? "enabled" : "rerank_disabled",
    relevance: {
      policyVersion: config.relevance.version,
      cutoffReason: relevance.cutoffReason,
      droppedCount: relevance.droppedCount
    }
  };
}

function createRetrievalConfig(input: {
  version: string;
  status: RetrievalConfigStatusName;
  provider: ModelProviderName;
  embeddingDimension: number | undefined;
  rerankProvider: RerankProviderName;
  embeddingModel: string;
  rerankModel: string;
  rerankEnabled: boolean;
  relevance:
    | Partial<
        Pick<
          EvidenceRelevancePolicy,
          "rerankMinScore" | "rerankMinGap" | "rerankLowClusterMaxScore"
        >
      >
    | undefined;
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
        input.provider === "fake"
          ? (input.embeddingDimension ?? FAKE_EMBEDDING_DIMENSION)
          : (input.embeddingDimension ?? OPENAI_COMPATIBLE_EMBEDDING_DIMENSION)
    },
    lexical: {
      version: LEXICAL_INDEX_VERSION,
      sparseModel: "qdrant-native-sparse-v1"
    },
    rerank: input.rerankEnabled
      ? {
          enabled: true,
          provider: input.rerankProvider,
          model: input.rerankModel,
          version: `${input.rerankModel}@${input.version}`
        }
      : {
          enabled: false,
          disabledReason: "explicitly_disabled_by_retrieval_config"
        },
    relevance: createEvidenceRelevancePolicy(input.version, input.relevance),
    qdrant: {
      collection: input.qdrantCollection
    }
  };
}

function createEvidenceRelevancePolicy(
  retrievalConfigVersion: string,
  overrides:
    | Partial<
        Pick<
          EvidenceRelevancePolicy,
          "rerankMinScore" | "rerankMinGap" | "rerankLowClusterMaxScore"
        >
      >
    | undefined
): EvidenceRelevancePolicy {
  const v2 =
    retrievalConfigVersion === "phase3.retrieval.v2-bm25" ||
    retrievalConfigVersion.startsWith("phase3.retrieval.v2-bm25.");
  const policy: EvidenceRelevancePolicy = {
    version: v2
      ? `relevance.v1@${retrievalConfigVersion}`
      : `relevance.disabled@${retrievalConfigVersion}`,
    mode: v2 ? "rerank_floor_and_gap" : "disabled",
    rerankMinScore: overrides?.rerankMinScore ?? 0.3,
    rerankMinGap: overrides?.rerankMinGap ?? 0.3,
    rerankLowClusterMaxScore: overrides?.rerankLowClusterMaxScore ?? 0.4
  };

  for (const [name, value] of Object.entries({
    rerankMinScore: policy.rerankMinScore,
    rerankMinGap: policy.rerankMinGap,
    rerankLowClusterMaxScore: policy.rerankLowClusterMaxScore
  })) {
    if (!Number.isFinite(value) || value < 0 || value > 1) {
      throw new Error(`Evidence relevance ${name} must be finite and within [0, 1].`);
    }
  }
  if (policy.rerankMinGap <= 0) {
    throw new Error("Evidence relevance rerankMinGap must be greater than zero.");
  }

  return policy;
}

function normalizeProviderName(provider: string | undefined): ModelProviderName {
  if (provider === "openai-compatible") {
    return "openai-compatible";
  }

  return "fake";
}

function normalizeRerankProviderName(
  provider: string | undefined,
  defaultProvider: ModelProviderName
): RerankProviderName {
  if (provider === "dashscope") {
    return "dashscope";
  }

  if (provider === "openai-compatible") {
    return "openai-compatible";
  }

  if (provider === "fake") {
    return "fake";
  }

  return defaultProvider;
}
