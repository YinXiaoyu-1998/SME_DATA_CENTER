export const DEFAULT_QDRANT_URL = "http://127.0.0.1:6333";
export const DEFAULT_QDRANT_COLLECTION_EVIDENCE = "enterprise_hub_evidence_local";
export const DEFAULT_QDRANT_TIMEOUT_MS = 5_000;
export const DEFAULT_RETRIEVAL_CONFIG_VERSION = "phase3.retrieval.v2";
export const DEFAULT_LLM_PROVIDER = "fake";
export const DEFAULT_LLM_MODEL = "fake-rerank";
export const DEFAULT_LLM_EMBEDDING_MODEL = "fake-embedding";
export const DEFAULT_DASHSCOPE_API_BASE_URL = "https://dashscope.aliyuncs.com/api/v1";

export const QDRANT_DENSE_VECTOR_NAME = "dense";
export const QDRANT_SPARSE_VECTOR_NAME = "sparse";
export const QDRANT_DENSE_VECTOR_SIZE = 8;
export const OPENAI_COMPATIBLE_DENSE_VECTOR_SIZE = 1536;
export const QDRANT_DENSE_DISTANCE = "Cosine";

export interface RuntimeEnv {
  [key: string]: string | undefined;
}

export interface QdrantRuntimeConfig {
  url: string;
  apiKey: string | null;
  collectionName: string;
  timeoutMs: number;
  retrievalConfigVersion: string;
  denseVectorSize: number;
}

export interface ModelProviderRuntimeConfig {
  provider: string;
  rerankProvider: string;
  rerankModel: string;
  rerankModelConfigured: boolean;
  embeddingModel: string;
  embeddingModelConfigured: boolean;
  embeddingDimension: number;
  openAiCompatibleApiKey: string | null;
  openAiCompatibleBaseUrl: string | null;
  dashscopeApiKey: string | null;
  dashscopeApiBaseUrl: string;
  egressAcknowledged: boolean;
}

export interface RuntimeReadinessConfig {
  qdrant: QdrantRuntimeConfig;
  modelProvider: ModelProviderRuntimeConfig;
}

export interface QdrantEvidenceCollectionSchema {
  vectors: {
    [QDRANT_DENSE_VECTOR_NAME]: {
      size: number;
      distance: typeof QDRANT_DENSE_DISTANCE;
    };
  };
  sparse_vectors: {
    [QDRANT_SPARSE_VECTOR_NAME]: {
      index: {
        on_disk: boolean;
      };
    };
  };
}

export function parseRuntimeReadinessConfig(env: RuntimeEnv = process.env): RuntimeReadinessConfig {
  return {
    qdrant: {
      url: stripTrailingSlash(env["QDRANT_URL"] ?? DEFAULT_QDRANT_URL),
      apiKey: optionalString(env["QDRANT_API_KEY"]),
      collectionName: env["QDRANT_COLLECTION_EVIDENCE"] ?? DEFAULT_QDRANT_COLLECTION_EVIDENCE,
      timeoutMs: parsePositiveInteger(env["QDRANT_TIMEOUT_MS"], DEFAULT_QDRANT_TIMEOUT_MS),
      retrievalConfigVersion: env["RETRIEVAL_CONFIG_VERSION"] ?? DEFAULT_RETRIEVAL_CONFIG_VERSION,
      denseVectorSize: parseEmbeddingDimension(env)
    },
    modelProvider: {
      provider: optionalString(env["LLM_PROVIDER"]) ?? DEFAULT_LLM_PROVIDER,
      rerankProvider:
        optionalString(env["RERANK_PROVIDER"]) ??
        optionalString(env["LLM_PROVIDER"]) ??
        DEFAULT_LLM_PROVIDER,
      rerankModel: env["LLM_MODEL"] ?? DEFAULT_LLM_MODEL,
      rerankModelConfigured: Boolean(optionalString(env["LLM_MODEL"])),
      embeddingModel: env["LLM_EMBEDDING_MODEL"] ?? DEFAULT_LLM_EMBEDDING_MODEL,
      embeddingModelConfigured: Boolean(optionalString(env["LLM_EMBEDDING_MODEL"])),
      embeddingDimension: parseEmbeddingDimension(env),
      openAiCompatibleApiKey: optionalString(env["OPENAI_COMPATIBLE_API_KEY"]),
      openAiCompatibleBaseUrl: optionalString(env["OPENAI_COMPATIBLE_BASE_URL"]),
      dashscopeApiKey: optionalString(env["DASHSCOPE_API_KEY"]),
      dashscopeApiBaseUrl: stripTrailingSlash(
        optionalString(env["DASHSCOPE_API_BASE_URL"]) ?? DEFAULT_DASHSCOPE_API_BASE_URL
      ),
      egressAcknowledged: env["EXTERNAL_MODEL_EGRESS_ACKNOWLEDGED"] === "true"
    }
  };
}

export function qdrantEvidenceCollectionSchema(
  denseVectorSize = QDRANT_DENSE_VECTOR_SIZE
): QdrantEvidenceCollectionSchema {
  return {
    vectors: {
      [QDRANT_DENSE_VECTOR_NAME]: {
        size: denseVectorSize,
        distance: QDRANT_DENSE_DISTANCE
      }
    },
    sparse_vectors: {
      [QDRANT_SPARSE_VECTOR_NAME]: {
        index: {
          on_disk: false
        }
      }
    }
  };
}

export function qdrantCollectionMatchesExpectedSchema(
  collection: unknown,
  denseVectorSize = QDRANT_DENSE_VECTOR_SIZE
): boolean {
  const params = collectionParams(collection);
  const dense = params?.vectors?.[QDRANT_DENSE_VECTOR_NAME];
  const sparse = params?.sparse_vectors?.[QDRANT_SPARSE_VECTOR_NAME];

  return (
    dense?.size === denseVectorSize &&
    dense?.distance === QDRANT_DENSE_DISTANCE &&
    typeof sparse === "object" &&
    sparse !== null
  );
}

function collectionParams(collection: unknown):
  | {
      vectors?: Record<string, { size?: unknown; distance?: unknown }>;
      sparse_vectors?: Record<string, unknown>;
    }
  | undefined {
  if (!isRecord(collection)) {
    return undefined;
  }

  const result = collection["result"];

  if (!isRecord(result)) {
    return undefined;
  }

  const config = result["config"];

  if (!isRecord(config)) {
    return undefined;
  }

  const params = config["params"];

  if (!isRecord(params)) {
    return undefined;
  }

  return params as {
    vectors?: Record<string, { size?: unknown; distance?: unknown }>;
    sparse_vectors?: Record<string, unknown>;
  };
}

function optionalString(value: string | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function parsePositiveInteger(value: string | undefined, fallback: number): number {
  if (!value) {
    return fallback;
  }

  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function parseEmbeddingDimension(env: RuntimeEnv): number {
  const provider = env["LLM_PROVIDER"] ?? DEFAULT_LLM_PROVIDER;
  const fallback =
    provider === "openai-compatible"
      ? OPENAI_COMPATIBLE_DENSE_VECTOR_SIZE
      : QDRANT_DENSE_VECTOR_SIZE;

  return parsePositiveInteger(env["LLM_EMBEDDING_DIMENSION"], fallback);
}

function stripTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
