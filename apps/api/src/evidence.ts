import { createHash } from "node:crypto";
import { PrismaMariaDb } from "@prisma/adapter-mariadb";
import { DocumentIndexStatus, DocumentKind, DocumentStatus, PrismaClient } from "@prisma/client";
import {
  QDRANT_DENSE_VECTOR_NAME,
  QDRANT_SPARSE_VECTOR_NAME,
  buildRetrievalConfigSeed,
  canEmployeeAccessDocument,
  loadActiveRetrievalConfig,
  toEvidenceSearchRetrievalMetadata,
  type AuthenticatedEmployee,
  type EvidenceSearchRetrievalMetadata,
  type RetrievalModelConfig
} from "@enterprise-hub/domain";
import { parseApiRetrievalRuntimeConfig } from "./config/retrieval-runtime.js";

export interface EvidenceSearchFilters {
  fileTypes: string[];
  documentIds: string[];
  labelIds: string[];
}

export interface EvidenceSearchInput {
  orgId: string;
  employee: AuthenticatedEmployee;
  query: string;
  filters: EvidenceSearchFilters;
  limit: number;
  cursor: string | null;
  requestId: string;
  clientIp: string;
}

export interface EvidenceSearchResultItem {
  chunkId: string;
  documentId: string;
  documentTitle: string;
  text: string;
  source: {
    fileType: string | null;
    sectionHeadingPath: string[];
    blockType: string | null;
    pageNumber: number | null;
  };
  score: {
    hybrid: number;
    rerank: number | null;
  };
  matchedBy: string[];
}

export interface EvidenceSearchResult {
  results: EvidenceSearchResultItem[];
  page: {
    limit: number;
    nextCursor: string | null;
    hasMore: boolean;
  };
  retrieval: EvidenceSearchRetrievalMetadata;
  warnings: string[];
}

export interface EvidenceSearchRepository {
  searchEvidence(input: EvidenceSearchInput): Promise<EvidenceSearchResult>;
  disconnect?(): Promise<void>;
}

export interface QdrantEvidenceCandidate {
  chunkId: string;
  documentId: string;
  qdrantPointId: string;
  contentVersion: number;
  retrievalConfigVersion: string;
  text: string;
  hybridScore: number;
  matchedBy: string[];
}

export interface RevalidatedEvidenceCandidate extends QdrantEvidenceCandidate {
  documentTitle: string;
  fileType: string | null;
  sectionHeadingPath: string[];
  blockType: string | null;
  pageNumber: number | null;
  rerankScore?: number | null;
}

export interface QdrantEvidenceSearcher {
  hybridSearch(
    input: EvidenceSearchInput & { retrievalConfig: RetrievalModelConfig }
  ): Promise<QdrantEvidenceCandidate[]>;
}

export interface EvidenceRevalidator {
  revalidate(input: {
    orgId: string;
    employee: AuthenticatedEmployee;
    candidates: QdrantEvidenceCandidate[];
    filters: EvidenceSearchFilters;
  }): Promise<RevalidatedEvidenceCandidate[]>;
}

export interface EvidenceRerankProvider {
  metadata: {
    version: string;
    [key: string]: unknown;
  };
  rerank(input: { query: string; documents: Array<{ id: string; text: string }> }): Promise<{
    scores: Array<{ index: number; score: number }>;
  }>;
}

interface EmbeddingProvider {
  embedTexts(texts: readonly string[]): Promise<number[][]>;
}

interface QdrantQueryPoint {
  id?: unknown;
  score?: unknown;
  payload?: unknown;
}

export function createEvidenceSearchService(input: {
  retrievalConfig: RetrievalModelConfig;
  qdrantSearcher: QdrantEvidenceSearcher;
  revalidator: EvidenceRevalidator;
  rerankProvider: EvidenceRerankProvider | null;
}): EvidenceSearchRepository {
  return {
    async searchEvidence(searchInput) {
      const candidates = await input.qdrantSearcher.hybridSearch({
        ...searchInput,
        retrievalConfig: input.retrievalConfig
      });
      const rerankScores = input.rerankProvider
        ? await input.rerankProvider.rerank({
            query: searchInput.query,
            documents: candidates.map((candidate) => ({
              id: candidate.chunkId,
              text: candidate.text
            }))
          })
        : null;
      const rerankScoreByChunkId = new Map<string, number>();

      for (const score of rerankScores?.scores ?? []) {
        const candidate = candidates[score.index];
        if (candidate) {
          rerankScoreByChunkId.set(candidate.chunkId, score.score);
        }
      }

      const revalidated = await input.revalidator.revalidate({
        orgId: searchInput.orgId,
        employee: searchInput.employee,
        candidates,
        filters: searchInput.filters
      });
      const ordered = revalidated
        .map((candidate) => ({
          ...candidate,
          rerankScore: rerankScoreByChunkId.get(candidate.chunkId) ?? null
        }))
        .sort(compareEvidenceCandidates)
        .slice(0, searchInput.limit);

      return {
        results: ordered.map((candidate) => ({
          chunkId: candidate.chunkId,
          documentId: candidate.documentId,
          documentTitle: candidate.documentTitle,
          text: candidate.text,
          source: {
            fileType: candidate.fileType,
            sectionHeadingPath: candidate.sectionHeadingPath,
            blockType: candidate.blockType,
            pageNumber: candidate.pageNumber
          },
          score: {
            hybrid: candidate.hybridScore,
            rerank: candidate.rerankScore
          },
          matchedBy: [...candidate.matchedBy, ...(candidate.rerankScore === null ? [] : ["rerank"])]
        })),
        page: {
          limit: searchInput.limit,
          nextCursor: null,
          hasMore: false
        },
        retrieval: toEvidenceSearchRetrievalMetadata(input.retrievalConfig),
        warnings: []
      };
    }
  };
}

export function createPrismaEvidenceSearchRepository(): EvidenceSearchRepository {
  const prisma = prismaClientFromEnv();
  const runtime = parseApiRetrievalRuntimeConfig();
  const retrievalConfig = loadActiveRetrievalConfig(
    buildRetrievalConfigSeed({
      retrievalConfigVersion: runtime.qdrant.retrievalConfigVersion,
      qdrantCollection: runtime.qdrant.collectionName,
      llmProvider: runtime.modelProvider.provider,
      embeddingModel: runtime.modelProvider.embeddingModel,
      rerankModel: runtime.modelProvider.rerankModel,
      rerankEnabled: Boolean(runtime.modelProvider.rerankModel)
    }),
    runtime.qdrant.retrievalConfigVersion
  );
  const embeddingProvider = createApiEmbeddingProvider({
    retrievalConfig,
    apiKey: process.env["OPENAI_COMPATIBLE_API_KEY"] ?? "",
    baseUrl: process.env["OPENAI_COMPATIBLE_BASE_URL"] ?? "",
    externalModelEgressAcknowledged: process.env["EXTERNAL_MODEL_EGRESS_ACKNOWLEDGED"] === "true"
  });
  const rerankProvider =
    retrievalConfig.rerank.enabled && retrievalConfig.rerank.model
      ? createApiRerankProvider({
          retrievalConfig,
          apiKey: process.env["OPENAI_COMPATIBLE_API_KEY"] ?? "",
          baseUrl: process.env["OPENAI_COMPATIBLE_BASE_URL"] ?? "",
          externalModelEgressAcknowledged:
            process.env["EXTERNAL_MODEL_EGRESS_ACKNOWLEDGED"] === "true"
        })
      : null;
  const service = createEvidenceSearchService({
    retrievalConfig,
    qdrantSearcher: new HttpQdrantEvidenceSearcher({
      url: runtime.qdrant.url,
      apiKey: runtime.qdrant.apiKey,
      timeoutMs: runtime.qdrant.timeoutMs,
      embeddingProvider
    }),
    revalidator: new PrismaEvidenceRevalidator(prisma),
    rerankProvider
  });

  return {
    async searchEvidence(input) {
      return service.searchEvidence(input);
    },
    async disconnect() {
      await prisma.$disconnect();
    }
  };
}

export class HttpQdrantEvidenceSearcher implements QdrantEvidenceSearcher {
  constructor(
    private readonly input: {
      url: string;
      apiKey: string | null;
      timeoutMs: number;
      embeddingProvider: EmbeddingProvider;
      fetch?: typeof fetch;
    }
  ) {}

  async hybridSearch(
    input: EvidenceSearchInput & { retrievalConfig: RetrievalModelConfig }
  ): Promise<QdrantEvidenceCandidate[]> {
    const [denseVector] = await this.input.embeddingProvider.embedTexts([input.query]);

    if (!denseVector) {
      return [];
    }

    const sparseVector = toSparseVector(input.query);
    const response = await this.queryQdrant(input, denseVector, sparseVector);

    return response.map((point) => qdrantPointToCandidate(point, input.retrievalConfig.version));
  }

  private async queryQdrant(
    input: EvidenceSearchInput & { retrievalConfig: RetrievalModelConfig },
    denseVector: number[],
    sparseVector: SparseVector
  ): Promise<QdrantQueryPoint[]> {
    const fetchImpl = this.input.fetch ?? fetch;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.input.timeoutMs);
    const searchLimit = Math.min(Math.max(input.limit * 5, 20), 200);

    try {
      const response = await fetchImpl(
        `${normalizeBaseUrl(this.input.url)}/collections/${encodeURIComponent(
          input.retrievalConfig.qdrant.collection
        )}/points/query`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            ...(this.input.apiKey ? { "api-key": this.input.apiKey } : {})
          },
          body: JSON.stringify({
            prefetch: [
              {
                query: denseVector,
                using: QDRANT_DENSE_VECTOR_NAME,
                filter: qdrantPayloadFilter(input),
                limit: searchLimit
              },
              {
                query: sparseVector,
                using: QDRANT_SPARSE_VECTOR_NAME,
                filter: qdrantPayloadFilter(input),
                limit: searchLimit
              }
            ],
            query: {
              fusion: "rrf"
            },
            with_payload: true,
            limit: searchLimit
          }),
          signal: controller.signal
        }
      );

      if (!response.ok) {
        throw new Error(`Qdrant evidence search failed: HTTP ${response.status}`);
      }

      const payload = (await response.json()) as { result?: { points?: QdrantQueryPoint[] } };
      return payload.result?.points ?? [];
    } finally {
      clearTimeout(timeout);
    }
  }
}

export class PrismaEvidenceRevalidator implements EvidenceRevalidator {
  constructor(private readonly prisma: PrismaClient) {}

  async revalidate(input: {
    orgId: string;
    employee: AuthenticatedEmployee;
    candidates: QdrantEvidenceCandidate[];
    filters: EvidenceSearchFilters;
  }): Promise<RevalidatedEvidenceCandidate[]> {
    if (input.employee.disabled || input.candidates.length === 0) {
      return [];
    }

    const candidateByPointId = new Map(
      input.candidates.map((candidate) => [candidate.qdrantPointId, candidate])
    );
    const chunks = await this.prisma.documentChunk.findMany({
      where: {
        qdrantPointId: {
          in: [...candidateByPointId.keys()]
        },
        indexType: "evidence",
        document: {
          orgId: input.orgId,
          status: DocumentStatus.active,
          documentKind: DocumentKind.evidence
        },
        documentIndex: {
          status: DocumentIndexStatus.ready
        }
      },
      include: {
        document: {
          include: {
            documentLabels: {
              include: {
                label: true
              }
            }
          }
        },
        documentIndex: true
      }
    });

    const revalidated: RevalidatedEvidenceCandidate[] = [];

    for (const chunk of chunks) {
      const candidate = chunk.qdrantPointId ? candidateByPointId.get(chunk.qdrantPointId) : null;

      if (!candidate || !chunk.documentIndex) {
        continue;
      }

      if (
        chunk.documentId !== candidate.documentId ||
        chunk.chunkId !== candidate.chunkId ||
        chunk.contentVersion !== candidate.contentVersion ||
        chunk.retrievalConfigVersion !== candidate.retrievalConfigVersion ||
        chunk.documentIndex.contentVersion !== candidate.contentVersion
      ) {
        continue;
      }

      const labelKeys = chunk.document.documentLabels.map(
        (documentLabel) => documentLabel.label.key
      );

      if (
        !canEmployeeAccessDocument({
          employee: {
            disabled: input.employee.disabled,
            labelKeys: input.employee.labels
          },
          document: {
            labelKeys
          }
        })
      ) {
        continue;
      }

      if (
        input.filters.documentIds.length > 0 &&
        !input.filters.documentIds.includes(chunk.documentId)
      ) {
        continue;
      }

      if (
        input.filters.fileTypes.length > 0 &&
        (!chunk.document.fileType || !input.filters.fileTypes.includes(chunk.document.fileType))
      ) {
        continue;
      }

      if (
        input.filters.labelIds.length > 0 &&
        !chunk.document.documentLabels.some((documentLabel) =>
          input.filters.labelIds.includes(documentLabel.labelId)
        )
      ) {
        continue;
      }

      const sourceLocation = sourceLocationFromJson(chunk.sourceLocation);
      revalidated.push({
        ...candidate,
        text: chunk.chunkText,
        documentTitle: chunk.document.title,
        fileType: chunk.document.fileType,
        sectionHeadingPath: sourceLocation.sectionHeadingPath,
        blockType: sourceLocation.blockType,
        pageNumber: sourceLocation.pageNumber
      });
    }

    return revalidated;
  }
}

function compareEvidenceCandidates(
  first: RevalidatedEvidenceCandidate & { rerankScore: number | null },
  second: RevalidatedEvidenceCandidate & { rerankScore: number | null }
) {
  const firstScore = first.rerankScore ?? first.hybridScore;
  const secondScore = second.rerankScore ?? second.hybridScore;

  if (firstScore !== secondScore) {
    return secondScore - firstScore;
  }

  return first.chunkId.localeCompare(second.chunkId);
}

interface SparseVector {
  indices: number[];
  values: number[];
}

function createApiEmbeddingProvider(input: {
  retrievalConfig: RetrievalModelConfig;
  apiKey: string;
  baseUrl: string;
  externalModelEgressAcknowledged: boolean;
}): EmbeddingProvider {
  if (input.retrievalConfig.denseEmbedding.provider === "fake") {
    return {
      async embedTexts(texts) {
        return texts.map((text) =>
          createDeterministicVector(text, input.retrievalConfig.denseEmbedding.dimension)
        );
      }
    };
  }

  return {
    async embedTexts(texts) {
      assertExternalModelEgressAcknowledged(input.externalModelEgressAcknowledged);
      const response = await fetch(`${normalizeBaseUrl(input.baseUrl)}/embeddings`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${input.apiKey}`,
          "content-type": "application/json"
        },
        body: JSON.stringify({
          model: input.retrievalConfig.denseEmbedding.model,
          input: [...texts],
          encoding_format: "float"
        })
      });

      if (!response.ok) {
        throw new Error(`Embedding provider request failed: HTTP ${response.status}`);
      }

      const payload = (await response.json()) as { data?: Array<{ embedding?: number[] }> };
      const embeddings = payload.data?.map((item) => item.embedding ?? []) ?? [];

      for (const embedding of embeddings) {
        if (embedding.length !== input.retrievalConfig.denseEmbedding.dimension) {
          throw new Error(
            `Embedding provider returned dimension ${embedding.length}; expected ${input.retrievalConfig.denseEmbedding.dimension}.`
          );
        }
      }

      return embeddings;
    }
  };
}

function createApiRerankProvider(input: {
  retrievalConfig: RetrievalModelConfig;
  apiKey: string;
  baseUrl: string;
  externalModelEgressAcknowledged: boolean;
}): EvidenceRerankProvider | null {
  if (!input.retrievalConfig.rerank.enabled) {
    return null;
  }

  if (input.retrievalConfig.rerank.provider === "fake") {
    return {
      metadata: {
        version: input.retrievalConfig.rerank.version
      },
      async rerank({ query, documents }) {
        return {
          scores: documents.map((document, index) => ({
            index,
            score: createDeterministicRerankScore(query, document.text)
          }))
        };
      }
    };
  }

  return {
    metadata: {
      version: input.retrievalConfig.rerank.version
    },
    async rerank({ query, documents }) {
      assertExternalModelEgressAcknowledged(input.externalModelEgressAcknowledged);
      const response = await fetch(`${normalizeBaseUrl(input.baseUrl)}/rerank`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${input.apiKey}`,
          "content-type": "application/json"
        },
        body: JSON.stringify({
          model: input.retrievalConfig.rerank.enabled ? input.retrievalConfig.rerank.model : "",
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

      const payload = (await response.json()) as {
        results?: Array<{ index?: number; relevance_score?: number }>;
      };

      return {
        scores: (payload.results ?? []).map((result) => ({
          index: result.index ?? 0,
          score: result.relevance_score ?? 0
        }))
      };
    }
  };
}

function prismaClientFromEnv() {
  const databaseUrl = process.env["DATABASE_URL"];

  if (!databaseUrl) {
    throw new Error("DATABASE_URL is required for evidence search.");
  }

  return new PrismaClient({
    adapter: new PrismaMariaDb(databaseUrl)
  });
}

function qdrantPayloadFilter(
  input: EvidenceSearchInput & { retrievalConfig: RetrievalModelConfig }
) {
  const must: unknown[] = [
    {
      key: "orgId",
      match: {
        value: input.orgId
      }
    },
    {
      key: "retrievalConfigVersion",
      match: {
        value: input.retrievalConfig.version
      }
    }
  ];

  if (input.filters.documentIds.length > 0) {
    must.push({
      key: "documentId",
      match: {
        any: input.filters.documentIds
      }
    });
  }

  return { must };
}

function qdrantPointToCandidate(
  point: QdrantQueryPoint,
  expectedRetrievalConfigVersion: string
): QdrantEvidenceCandidate {
  const payload = isRecord(point.payload) ? point.payload : {};
  const qdrantPointId = typeof point.id === "string" ? point.id : String(point.id ?? "");
  const chunkId = stringPayload(payload, "chunkId");
  const documentId = stringPayload(payload, "documentId");

  return {
    chunkId,
    documentId,
    qdrantPointId,
    contentVersion: numberPayload(payload, "contentVersion") ?? 0,
    retrievalConfigVersion:
      stringPayload(payload, "retrievalConfigVersion") || expectedRetrievalConfigVersion,
    text: stringPayload(payload, "text"),
    hybridScore: typeof point.score === "number" ? point.score : 0,
    matchedBy: ["dense", "lexical"]
  };
}

function sourceLocationFromJson(value: unknown): {
  sectionHeadingPath: string[];
  blockType: string | null;
  pageNumber: number | null;
} {
  if (!isRecord(value)) {
    return {
      sectionHeadingPath: [],
      blockType: null,
      pageNumber: null
    };
  }

  const headingPath = Array.isArray(value["sectionHeadingPath"])
    ? value["sectionHeadingPath"].filter((item): item is string => typeof item === "string")
    : [];
  const blockTypes = Array.isArray(value["blockTypes"])
    ? value["blockTypes"].filter((item): item is string => typeof item === "string")
    : [];

  return {
    sectionHeadingPath: headingPath,
    blockType: blockTypes[0] ?? null,
    pageNumber: typeof value["pageNumber"] === "number" ? value["pageNumber"] : null
  };
}

function toSparseVector(text: string): SparseVector {
  const counts = new Map<number, number>();

  for (const token of text.toLowerCase().match(/[\p{L}\p{N}_]+/gu) ?? []) {
    const index = Number.parseInt(sha256(token).slice(0, 7), 16);
    counts.set(index, (counts.get(index) ?? 0) + 1);
  }

  const entries = [...counts.entries()].sort((first, second) => first[0] - second[0]);
  return {
    indices: entries.map(([index]) => index),
    values: entries.map(([, count]) => count)
  };
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

function assertExternalModelEgressAcknowledged(acknowledged: boolean): void {
  if (!acknowledged) {
    throw new Error(
      "EXTERNAL_MODEL_EGRESS_ACKNOWLEDGED=true is required before real embedding or rerank calls."
    );
  }
}

function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, "");
}

function stringPayload(payload: Record<string, unknown>, key: string): string {
  const value = payload[key];
  return typeof value === "string" ? value : "";
}

function numberPayload(payload: Record<string, unknown>, key: string): number | null {
  const value = payload[key];
  return typeof value === "number" ? value : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}
