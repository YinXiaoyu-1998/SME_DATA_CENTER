import { createHash } from "node:crypto";
import { assertExternalModelEgressAcknowledged, normalizeBaseUrl } from "./embedding.js";

export interface RerankDocument {
  id: string;
  text: string;
}

export interface RerankProviderMetadata {
  provider: "fake" | "openai-compatible" | "dashscope";
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

export function createDashScopeRerankProvider(input: {
  apiKey: string;
  baseUrl: string;
  model: string;
  version: string;
  externalModelEgressAcknowledged: boolean;
  fetch?: FetchLike | undefined;
}): RerankProvider {
  const metadata: RerankProviderMetadata = {
    provider: "dashscope",
    model: input.model,
    version: input.version
  };
  const fetchImpl = input.fetch ?? globalThis.fetch;

  return {
    metadata,
    async rerank({ query, documents }) {
      assertExternalModelEgressAcknowledged(input.externalModelEgressAcknowledged);
      const rerankDocuments = documents
        .map((document, index) => ({
          document,
          index,
          text: document.text.trim()
        }))
        .filter((document) => document.text.length > 0);

      if (rerankDocuments.length === 0) {
        return {
          metadata,
          scores: documents.map((document) => ({
            documentId: document.id,
            score: 0
          }))
        };
      }

      const response = await fetchImpl(
        `${normalizeBaseUrl(input.baseUrl)}/services/rerank/text-rerank/text-rerank`,
        {
          method: "POST",
          headers: {
            authorization: `Bearer ${input.apiKey}`,
            "content-type": "application/json"
          },
          body: JSON.stringify({
            model: input.model,
            input: {
              query,
              documents: rerankDocuments.map((document) => document.text)
            },
            parameters: {
              top_n: rerankDocuments.length,
              return_documents: false
            }
          })
        }
      );

      if (!response.ok) {
        throw new Error(`DashScope rerank provider request failed: HTTP ${response.status}`);
      }

      const payload = (await response.json()) as DashScopeRerankResponse;
      const scoresByIndex = new Map<number, number>();

      for (const result of dashScopeResults(payload)) {
        const originalIndex = rerankDocuments[result.index]?.index;

        if (originalIndex !== undefined) {
          scoresByIndex.set(originalIndex, result.relevance_score);
        }
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

interface DashScopeRerankResponse {
  results?: Array<{
    index: number;
    relevance_score: number;
  }>;
  output?: {
    results?: Array<{
      index: number;
      relevance_score: number;
    }>;
  };
}

function dashScopeResults(payload: DashScopeRerankResponse) {
  return payload.output?.results ?? payload.results ?? [];
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
