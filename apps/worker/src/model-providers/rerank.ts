import { createHash } from "node:crypto";
import { assertExternalModelEgressAcknowledged, normalizeBaseUrl } from "./embedding.js";

export interface RerankDocument {
  id: string;
  text: string;
}

export interface RerankProviderMetadata {
  provider: "fake" | "openai-compatible";
  model: string;
  version: string;
}

export interface RerankProviderResult {
  metadata: RerankProviderMetadata;
  scores: Array<{
    documentId: string;
    score: number;
  }>;
}

export interface RerankProvider {
  readonly metadata: RerankProviderMetadata;
  rerank(input: {
    query: string;
    documents: readonly RerankDocument[];
  }): Promise<RerankProviderResult>;
}

type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export function createFakeRerankProvider(input: {
  model: string;
  version: string;
}): RerankProvider {
  const metadata: RerankProviderMetadata = {
    provider: "fake",
    model: input.model,
    version: input.version
  };

  return {
    metadata,
    async rerank({ query, documents }) {
      return {
        metadata,
        scores: documents.map((document) => ({
          documentId: document.id,
          score: createDeterministicRerankScore(query, document.text)
        }))
      };
    }
  };
}

export function createOpenAICompatibleRerankProvider(input: {
  apiKey: string;
  baseUrl: string;
  model: string;
  version: string;
  externalModelEgressAcknowledged: boolean;
  fetch?: FetchLike | undefined;
}): RerankProvider {
  const metadata: RerankProviderMetadata = {
    provider: "openai-compatible",
    model: input.model,
    version: input.version
  };
  const fetchImpl = input.fetch ?? globalThis.fetch;

  return {
    metadata,
    async rerank({ query, documents }) {
      assertExternalModelEgressAcknowledged(input.externalModelEgressAcknowledged);

      const response = await fetchImpl(`${normalizeBaseUrl(input.baseUrl)}/rerank`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${input.apiKey}`,
          "content-type": "application/json"
        },
        body: JSON.stringify({
          model: input.model,
          query,
          documents: documents.map((document) => ({
            id: document.id,
            text: document.text
          }))
        })
      });

      if (!response.ok) {
        throw new Error(`Rerank provider request failed: HTTP ${response.status}`);
      }

      const payload = (await response.json()) as OpenAICompatibleRerankResponse;
      const scoresByIndex = new Map<number, number>();

      for (const result of payload.results) {
        scoresByIndex.set(result.index, result.relevance_score);
      }

      return {
        metadata,
        scores: documents.map((document, index) => ({
          documentId: document.id,
          score: scoresByIndex.get(index) ?? 0
        }))
      };
    }
  };
}

interface OpenAICompatibleRerankResponse {
  results: Array<{
    index: number;
    relevance_score: number;
  }>;
}

function createDeterministicRerankScore(query: string, text: string): number {
  const normalizedText = text.toLocaleLowerCase();
  const tokens = query
    .toLocaleLowerCase()
    .split(/\s+/)
    .map((token) => token.trim())
    .filter(Boolean);
  const tokenScore =
    tokens.filter((token) => normalizedText.includes(token)).length / Math.max(1, tokens.length);
  const tieBreaker = createHash("sha256").update(`${query}\n${text}`).digest()[0];

  return Number((tokenScore + (tieBreaker ?? 0) / 255_000).toFixed(6));
}
