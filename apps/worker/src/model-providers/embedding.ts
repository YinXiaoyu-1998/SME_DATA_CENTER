import { createHash } from "node:crypto";

export interface EmbeddingProviderMetadata {
  provider: "fake" | "openai-compatible";
  model: string;
  version: string;
  dimension: number;
}

export interface EmbeddingProviderResult {
  metadata: EmbeddingProviderMetadata;
  embeddings: number[][];
}

export interface EmbeddingProvider {
  readonly metadata: EmbeddingProviderMetadata;
  embedTexts(texts: readonly string[]): Promise<EmbeddingProviderResult>;
}

type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export function createFakeEmbeddingProvider(input: {
  model: string;
  version: string;
  dimension: number;
}): EmbeddingProvider {
  const metadata: EmbeddingProviderMetadata = {
    provider: "fake",
    model: input.model,
    version: input.version,
    dimension: input.dimension
  };

  return {
    metadata,
    async embedTexts(texts) {
      return {
        metadata,
        embeddings: texts.map((text) => createDeterministicVector(text, input.dimension))
      };
    }
  };
}

export function createOpenAICompatibleEmbeddingProvider(input: {
  apiKey: string;
  baseUrl: string;
  model: string;
  version: string;
  dimension: number;
  externalModelEgressAcknowledged: boolean;
  fetch?: FetchLike | undefined;
}): EmbeddingProvider {
  const metadata: EmbeddingProviderMetadata = {
    provider: "openai-compatible",
    model: input.model,
    version: input.version,
    dimension: input.dimension
  };
  const fetchImpl = input.fetch ?? globalThis.fetch;

  return {
    metadata,
    async embedTexts(texts) {
      assertExternalModelEgressAcknowledged(input.externalModelEgressAcknowledged);

      const embeddings: number[][] = [];

      // Provider-side input caps (DashScope rejects batches above 10) make one request per chunk
      // unsafe, so inputs are submitted in bounded batches and reassembled in order.
      for (
        let startIndex = 0;
        startIndex < texts.length;
        startIndex += EMBEDDING_REQUEST_BATCH_SIZE
      ) {
        const batch = texts.slice(startIndex, startIndex + EMBEDDING_REQUEST_BATCH_SIZE);
        const response = await fetchImpl(`${normalizeBaseUrl(input.baseUrl)}/embeddings`, {
          method: "POST",
          headers: {
            authorization: `Bearer ${input.apiKey}`,
            "content-type": "application/json"
          },
          body: JSON.stringify({
            model: input.model,
            input: [...batch],
            encoding_format: "float"
          })
        });

        if (!response.ok) {
          throw new Error(`Embedding provider request failed: HTTP ${response.status}`);
        }

        const payload = (await response.json()) as OpenAIEmbeddingResponse;

        for (const item of payload.data) {
          if (item.embedding.length !== input.dimension) {
            throw new Error(
              `Embedding provider returned dimension ${item.embedding.length}; expected ${input.dimension}.`
            );
          }

          embeddings.push(item.embedding);
        }
      }

      return {
        metadata,
        embeddings
      };
    }
  };
}

const EMBEDDING_REQUEST_BATCH_SIZE = 10;

export function assertExternalModelEgressAcknowledged(acknowledged: boolean): void {
  if (!acknowledged) {
    throw new Error(
      "EXTERNAL_MODEL_EGRESS_ACKNOWLEDGED=true is required before real embedding or rerank calls."
    );
  }
}

export function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, "");
}

interface OpenAIEmbeddingResponse {
  data: Array<{
    embedding: number[];
  }>;
}

function createDeterministicVector(text: string, dimension: number): number[] {
  const vector: number[] = [];
  let counter = 0;

  while (vector.length < dimension) {
    const digest = createHash("sha256").update(`${counter}:${text}`).digest();

    for (const byte of digest) {
      vector.push(Number((byte / 127.5 - 1 || 0).toFixed(6)));

      if (vector.length === dimension) {
        break;
      }
    }

    counter += 1;
  }

  return vector;
}
