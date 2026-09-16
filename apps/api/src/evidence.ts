import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { createDatabaseAdapter } from "@smedc/db";
import { DocumentIndexStatus, DocumentKind, DocumentStatus, PrismaClient } from "@prisma/client";
import {
  QDRANT_DENSE_VECTOR_NAME,
  QDRANT_SPARSE_VECTOR_NAME,
  PHASE3_ERROR_CODES,
  buildRetrievalConfigSeed,
  canEmployeeAccessDocument,
  loadActiveRetrievalConfig,
  toEvidenceSearchRetrievalMetadata,
  type AuthenticatedEmployee,
  type EvidenceSearchRetrievalMetadata,
  type RetrievalModelConfig
} from "@smedc/domain";
import { parseApiRetrievalRuntimeConfig } from "./config/retrieval-runtime.js";
import type { RequestAuditContext } from "./request-audit-context.js";

export interface EvidenceSearchFilters {
  fileTypes: string[];
  documentIds: string[];
}

export interface EvidenceSearchInput {
  orgId: string;
  employee: AuthenticatedEmployee;
  query: string;
  filters: EvidenceSearchFilters;
  limit: number;
  cursor: string | null;
  audit: RequestAuditContext;
  cursorSecret: string;
  now?: Date;
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

const EVIDENCE_CURSOR_VERSION = 1;
const EVIDENCE_CURSOR_TTL_SECONDS = 900;
const EVIDENCE_CURSOR_DOMAIN = "evidence-cursor:v1";
const EVIDENCE_CANDIDATE_WINDOW = 200;

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
      const now = searchInput.now ?? new Date();
      const cursorScope = evidenceCursorScope(searchInput, input.retrievalConfig.version);
      const offset = searchInput.cursor
        ? decodeEvidenceCursor({
            cursor: searchInput.cursor,
            expectedScopeHash: cursorScope.scopeHash,
            secret: searchInput.cursorSecret,
            now
          }).offset
        : 0;
      const candidates = await input.qdrantSearcher.hybridSearch({
        ...searchInput,
        limit: EVIDENCE_CANDIDATE_WINDOW,
        retrievalConfig: input.retrievalConfig
      });
      const revalidated = await input.revalidator.revalidate({
        orgId: searchInput.orgId,
        employee: searchInput.employee,
        candidates,
        filters: searchInput.filters
      });
      const rerankScores =
        input.rerankProvider && revalidated.length > 0
          ? await input.rerankProvider.rerank({
              query: searchInput.query,
              documents: revalidated.map((candidate) => ({
                id: candidate.chunkId,
                text: candidate.text
              }))
            })
          : null;
      const rerankScoreByChunkId = new Map<string, number>();

      for (const score of rerankScores?.scores ?? []) {
        const candidate = revalidated[score.index];
        if (candidate) {
          rerankScoreByChunkId.set(candidate.chunkId, score.score);
        }
      }

      const ordered = dedupeEvidenceCandidates(
        revalidated
          .map((candidate) => ({
            ...candidate,
            rerankScore: rerankScoreByChunkId.get(candidate.chunkId) ?? null
          }))
          .sort(compareEvidenceCandidates)
      );
      const page = ordered.slice(offset, offset + searchInput.limit + 1);
      const visible = page.slice(0, searchInput.limit);
      const hasMore = page.length > searchInput.limit;
      const nextCursor = hasMore
        ? createEvidenceCursor({
            offset: offset + searchInput.limit,
            scopeHash: cursorScope.scopeHash,
            scope: cursorScope.payload,
            secret: searchInput.cursorSecret,
            now
          })
        : null;
      const warnings =
        candidates.length >= EVIDENCE_CANDIDATE_WINDOW
          ? ["EVIDENCE_CANDIDATE_WINDOW_TRUNCATED"]
          : [];

      return {
        results: visible.map((candidate) => ({
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
          nextCursor,
          hasMore
        },
        retrieval: toEvidenceSearchRetrievalMetadata(input.retrievalConfig),
        warnings
      };
    }
  };
}

function dedupeEvidenceCandidates(
  candidates: Array<RevalidatedEvidenceCandidate & { rerankScore: number | null }>
) {
  const seen = new Set<string>();
  return candidates.filter((candidate) => {
    if (seen.has(candidate.chunkId)) {
      return false;
    }
    seen.add(candidate.chunkId);
    return true;
  });
}

export class EvidenceSearchCursorError extends Error {
  constructor(
    readonly code:
      typeof PHASE3_ERROR_CODES.invalidCursor | typeof PHASE3_ERROR_CODES.cursorExpired,
    message: string
  ) {
    super(message);
    this.name = "EvidenceSearchCursorError";
  }
}

interface EvidenceCursorScopePayload {
  orgId: string;
  employeeId: string;
  clearance: number;
  query: string;
  filters: EvidenceSearchFilters;
  limit: number;
  retrievalConfigVersion: string;
}

function evidenceCursorScope(input: EvidenceSearchInput, retrievalConfigVersion: string) {
  const payload: EvidenceCursorScopePayload = {
    orgId: input.orgId,
    employeeId: input.employee.id,
    clearance: input.employee.clearance,
    query: input.query,
    filters: {
      fileTypes: [...input.filters.fileTypes].sort(),
      documentIds: [...input.filters.documentIds].sort()
    },
    limit: input.limit,
    retrievalConfigVersion
  };
  return {
    payload,
    scopeHash: sha256(stableJson(payload))
  };
}

function createEvidenceCursor(input: {
  offset: number;
  scopeHash: string;
  scope: EvidenceCursorScopePayload;
  secret: string;
  now: Date;
}) {
  const issuedAt = Math.floor(input.now.getTime() / 1_000);
  const payload = {
    version: EVIDENCE_CURSOR_VERSION,
    domain: EVIDENCE_CURSOR_DOMAIN,
    orgId: input.scope.orgId,
    employeeId: input.scope.employeeId,
    clearance: input.scope.clearance,
    query: input.scope.query,
    filters: input.scope.filters,
    limit: input.scope.limit,
    retrievalConfigVersion: input.scope.retrievalConfigVersion,
    scopeHash: input.scopeHash,
    offset: input.offset,
    issuedAt,
    expiresAt: issuedAt + EVIDENCE_CURSOR_TTL_SECONDS
  };
  const encodedPayload = Buffer.from(stableJson(payload), "utf8").toString("base64url");
  const signature = signEvidenceCursor(encodedPayload, input.secret);
  return `${encodedPayload}.${signature}`;
}

function decodeEvidenceCursor(input: {
  cursor: string;
  expectedScopeHash: string;
  secret: string;
  now: Date;
}) {
  const [encodedPayload, signature, extra] = input.cursor.split(".");
  if (!encodedPayload || !signature || extra !== undefined) {
    throw new EvidenceSearchCursorError(PHASE3_ERROR_CODES.invalidCursor, "Invalid cursor.");
  }
  if (!safeEqual(signature, signEvidenceCursor(encodedPayload, input.secret))) {
    throw new EvidenceSearchCursorError(PHASE3_ERROR_CODES.invalidCursor, "Invalid cursor.");
  }

  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(Buffer.from(encodedPayload, "base64url").toString("utf8")) as Record<
      string,
      unknown
    >;
  } catch {
    throw new EvidenceSearchCursorError(PHASE3_ERROR_CODES.invalidCursor, "Invalid cursor.");
  }

  if (
    payload["version"] !== EVIDENCE_CURSOR_VERSION ||
    payload["domain"] !== EVIDENCE_CURSOR_DOMAIN ||
    payload["scopeHash"] !== input.expectedScopeHash ||
    !Number.isInteger(payload["offset"]) ||
    !Number.isInteger(payload["expiresAt"])
  ) {
    throw new EvidenceSearchCursorError(PHASE3_ERROR_CODES.invalidCursor, "Invalid cursor.");
  }

  if ((payload["expiresAt"] as number) < Math.floor(input.now.getTime() / 1_000)) {
    throw new EvidenceSearchCursorError(PHASE3_ERROR_CODES.cursorExpired, "Cursor expired.");
  }

  return { offset: payload["offset"] as number };
}

function signEvidenceCursor(encodedPayload: string, secret: string) {
  return createHmac("sha256", secret)
    .update(EVIDENCE_CURSOR_DOMAIN)
    .update(".")
    .update(encodedPayload)
    .digest("base64url");
}

function safeEqual(left: string, right: string) {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableJson).join(",")}]`;
  }
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, nextValue]) => `${JSON.stringify(key)}:${stableJson(nextValue)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

export function createPrismaEvidenceSearchRepository(): EvidenceSearchRepository {
  const prisma = prismaClientFromEnv();
  const runtime = parseApiRetrievalRuntimeConfig();
  const retrievalConfig = loadActiveRetrievalConfig(
    buildRetrievalConfigSeed({
      retrievalConfigVersion: runtime.qdrant.retrievalConfigVersion,
      qdrantCollection: runtime.qdrant.collectionName,
      llmProvider: runtime.modelProvider.provider,
      embeddingDimension: runtime.modelProvider.embeddingDimension,
      embeddingModel: runtime.modelProvider.embeddingModel,
      rerankProvider: runtime.modelProvider.rerankProvider,
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
          openAiCompatibleApiKey: process.env["OPENAI_COMPATIBLE_API_KEY"] ?? "",
          openAiCompatibleBaseUrl: process.env["OPENAI_COMPATIBLE_BASE_URL"] ?? "",
          dashscopeApiKey:
            optionalString(process.env["DASHSCOPE_API_KEY"]) ??
            process.env["OPENAI_COMPATIBLE_API_KEY"] ??
            "",
          dashscopeApiBaseUrl: runtime.modelProvider.dashscopeApiBaseUrl,
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
        document: true,
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

      if (
        !canEmployeeAccessDocument({
          employee: {
            disabled: input.employee.disabled,
            clearance: input.employee.clearance
          },
          document: {
            confidentialityLevel: chunk.document.confidentialityLevel
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

const RERANK_REQUEST_TOKEN_BUDGET = 100_000;
const RERANK_MAX_DOCUMENTS = 500;
const RERANK_MAX_TOKENS_PER_INPUT = 30_000;
const RERANK_ESTIMATED_TOKENS_PER_CHAR = 1;

/**
 * Keeps a rerank request inside the provider's document-count and request-token limits while
 * preserving the caller's ordering. DashScope counts the query once for every document, so the
 * request budget includes both query and document tokens. Candidates beyond the budget stay
 * unscored, so they keep their fused score when the service orders results.
 */
export function limitRerankDocuments<T extends { text: string }>(
  documents: readonly T[],
  query = ""
): T[] {
  const selected: T[] = [];
  const queryTokens = estimateRerankTokens(query);
  let documentTokens = 0;

  if (queryTokens > RERANK_MAX_TOKENS_PER_INPUT) {
    return selected;
  }

  for (const document of documents.slice(0, RERANK_MAX_DOCUMENTS)) {
    const estimatedDocumentTokens = estimateRerankTokens(document.text);

    if (estimatedDocumentTokens > RERANK_MAX_TOKENS_PER_INPUT) {
      continue;
    }

    const nextDocumentCount = selected.length + 1;
    const projectedRequestTokens =
      documentTokens + estimatedDocumentTokens + queryTokens * nextDocumentCount;

    if (projectedRequestTokens > RERANK_REQUEST_TOKEN_BUDGET) {
      break;
    }

    selected.push(document);
    documentTokens += estimatedDocumentTokens;
  }

  return selected;
}

function estimateRerankTokens(text: string): number {
  // This is intentionally conservative for Chinese evidence text, where one character can be one
  // model token. The 100k budget leaves room below DashScope's 120k request limit.
  return Math.ceil(text.length * RERANK_ESTIMATED_TOKENS_PER_CHAR);
}

export function createApiRerankProvider(input: {
  retrievalConfig: RetrievalModelConfig;
  openAiCompatibleApiKey: string;
  openAiCompatibleBaseUrl: string;
  dashscopeApiKey: string;
  dashscopeApiBaseUrl: string;
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

  if (input.retrievalConfig.rerank.provider === "dashscope") {
    return {
      metadata: {
        version: input.retrievalConfig.rerank.version
      },
      async rerank({ query, documents }) {
        assertExternalModelEgressAcknowledged(input.externalModelEgressAcknowledged);
        const rerankDocuments = documents
          .map((document, index) => ({
            index,
            text: document.text.trim()
          }))
          .filter((document) => document.text.length > 0);

        if (rerankDocuments.length === 0) {
          return {
            scores: documents.map((_, index) => ({
              index,
              score: 0
            }))
          };
        }

        // DashScope rerank models cap both the document count and the total request tokens, and the
        // candidate window can exceed the token budget once chunks are large. The list is trimmed
        // deterministically; unscored candidates keep their fused score for ordering.
        const rerankRequestDocuments = limitRerankDocuments(rerankDocuments, query);

        if (rerankRequestDocuments.length === 0) {
          return { scores: [] };
        }

        const response = await fetch(
          `${normalizeBaseUrl(input.dashscopeApiBaseUrl)}/services/rerank/text-rerank/text-rerank`,
          {
            method: "POST",
            headers: {
              authorization: `Bearer ${input.dashscopeApiKey}`,
              "content-type": "application/json"
            },
            body: JSON.stringify({
              model: input.retrievalConfig.rerank.enabled ? input.retrievalConfig.rerank.model : "",
              input: {
                query,
                documents: rerankRequestDocuments.map((document) => document.text)
              },
              parameters: {
                top_n: rerankRequestDocuments.length,
                return_documents: false
              }
            })
          }
        );

        if (!response.ok) {
          throw new Error(`DashScope rerank provider request failed: HTTP ${response.status}`);
        }

        const payload = (await response.json()) as {
          results?: Array<{ index?: number; relevance_score?: number }>;
          output?: {
            results?: Array<{ index?: number; relevance_score?: number }>;
          };
        };

        return {
          scores: (payload.output?.results ?? payload.results ?? []).flatMap((result) => {
            const originalIndex =
              result.index === undefined ? undefined : rerankRequestDocuments[result.index]?.index;

            return originalIndex === undefined
              ? []
              : [
                  {
                    index: originalIndex,
                    score: result.relevance_score ?? 0
                  }
                ];
          })
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
      const response = await fetch(`${normalizeBaseUrl(input.openAiCompatibleBaseUrl)}/rerank`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${input.openAiCompatibleApiKey}`,
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
    adapter: createDatabaseAdapter(databaseUrl)
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

  return {
    must,
    // Existing vectors predate the immutable payload field and correspond to
    // database documents migrated to level 0. They are admitted only as
    // candidates; PrismaEvidenceRevalidator remains the authority before
    // reranking and response construction.
    min_should: {
      conditions: [
        {
          key: "confidentialityLevel",
          range: { lte: input.employee.clearance }
        },
        { is_empty: { key: "confidentialityLevel" } }
      ],
      min_count: 1
    }
  };
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

function optionalString(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
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
