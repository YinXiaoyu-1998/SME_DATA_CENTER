import { createHash } from "node:crypto";
import { extname } from "node:path";
import {
  QDRANT_DENSE_VECTOR_NAME,
  QDRANT_SPARSE_VECTOR_NAME,
  type Phase3FileType,
  type RetrievalModelConfig
} from "@enterprise-hub/domain";
import { createEvidenceChunks } from "./chunking/evidence-chunker.js";
import { type EmbeddingProvider } from "./model-providers/embedding.js";
import { type RerankProvider } from "./model-providers/rerank.js";
import { parseEvidenceDocument } from "./parsers/evidence-parser.js";
import { parseWorkerRetrievalRuntimeConfig } from "./config/retrieval-runtime.js";
import { loadWorkerRuntimeLimits } from "./config/runtime-limits.js";
import { createModelProvidersFromEnv } from "./model-providers/factory.js";
import type {
  ClaimedProcessingRun,
  EvidenceDocumentChunkWrite,
  EvidenceIndexer
} from "./worker.js";

export interface SparseVector {
  indices: number[];
  values: number[];
}

export interface QdrantEvidencePoint {
  id: string;
  denseVector: number[];
  sparseVector: SparseVector;
  payload: Record<string, unknown>;
}

export interface QdrantEvidenceWriter {
  upsertEvidencePoints(input: { collection: string; points: QdrantEvidencePoint[] }): Promise<void>;
}

interface EvidenceDocumentChunkWithDenseVector extends EvidenceDocumentChunkWrite {
  denseVector: number[];
}

export interface CreateEvidenceIndexerInput {
  retrievalConfig: RetrievalModelConfig;
  embeddingProvider: EmbeddingProvider;
  rerankProvider: RerankProvider | null;
  qdrantWriter: QdrantEvidenceWriter;
  maxDocumentChars?: number;
  maxChunksPerDocument?: number;
}

export function createEvidenceIndexer(input: CreateEvidenceIndexerInput): EvidenceIndexer {
  return {
    async indexDocument({ run, content }) {
      const document = requireEvidenceDocument(run);
      const fileType = evidenceFileType(run);
      const parsed = await parseEvidenceDocument({
        fileType,
        originalFilename: document.originalFileName ?? undefined,
        content
      });
      const documentChars = parsed.blocks.reduce((sum, block) => sum + block.text.length, 0);
      if (input.maxDocumentChars !== undefined && documentChars > input.maxDocumentChars) {
        throw new EvidenceIndexingLimitError(
          "DOCUMENT_TOO_LARGE",
          `Evidence document contains ${documentChars} parsed characters, exceeding the ${input.maxDocumentChars} character limit.`
        );
      }
      const chunking = createEvidenceChunks({
        documentId: run.documentId,
        contentVersion: document.contentVersion ?? 1,
        retrievalConfigVersion: input.retrievalConfig.version,
        blocks: parsed.blocks
      });
      if (
        input.maxChunksPerDocument !== undefined &&
        chunking.chunks.length > input.maxChunksPerDocument
      ) {
        throw new EvidenceIndexingLimitError(
          "TOO_MANY_CHUNKS",
          `Evidence document produced ${chunking.chunks.length} chunks, exceeding the ${input.maxChunksPerDocument} chunk limit.`
        );
      }
      const embeddingResult = await input.embeddingProvider.embedTexts(
        chunking.chunks.map((chunk) => chunk.text)
      );
      const chunks: EvidenceDocumentChunkWithDenseVector[] = chunking.chunks.map((chunk, index) => {
        const qdrantPointId = stableUuid(chunk.pointId);
        const denseVector = embeddingResult.embeddings[index];

        if (!denseVector) {
          throw new Error(`Embedding provider did not return vector for chunk ${index}.`);
        }

        return {
          documentId: run.documentId,
          chunkIndex: chunk.chunkOrdinal,
          chunkText: chunk.text,
          chunkHash: sha256(chunk.text),
          indexType: "evidence",
          chunkId: chunk.chunkId,
          qdrantPointId,
          contentVersion: document.contentVersion ?? 1,
          retrievalConfigVersion: input.retrievalConfig.version,
          modelName: embeddingResult.metadata.model,
          modelVersion: embeddingResult.metadata.version,
          sourceLocation: {
            sectionHeadingPath: chunk.headingPath,
            blockTypes: chunk.blockTypes,
            sourceLocations: chunk.sourceLocations,
            metadata: chunk.metadata
          },
          denseVector
        };
      });

      await input.qdrantWriter.upsertEvidencePoints({
        collection: input.retrievalConfig.qdrant.collection,
        points: chunks.map((chunk) => ({
          id: chunk.qdrantPointId,
          denseVector: chunk.denseVector,
          sparseVector: toSparseVector(chunk.chunkText),
          payload: {
            orgId: run.orgId,
            documentId: run.documentId,
            confidentialityLevel: document.confidentialityLevel,
            chunkId: chunk.chunkId,
            documentIndexId: null,
            contentVersion: chunk.contentVersion,
            retrievalConfigVersion: input.retrievalConfig.version,
            text: chunk.chunkText,
            sourceLocation: chunk.sourceLocation
          }
        }))
      });

      return {
        retrievalConfigVersion: input.retrievalConfig.version,
        qdrantCollection: input.retrievalConfig.qdrant.collection,
        embeddingProvider: input.retrievalConfig.denseEmbedding.provider,
        embeddingModel: embeddingResult.metadata.model,
        embeddingVersion: embeddingResult.metadata.version,
        embeddingDimension: embeddingResult.metadata.dimension,
        lexicalIndexVersion: input.retrievalConfig.lexical.version,
        rerankProvider: input.retrievalConfig.rerank.enabled
          ? input.retrievalConfig.rerank.provider
          : null,
        rerankModel: input.retrievalConfig.rerank.enabled
          ? input.retrievalConfig.rerank.model
          : null,
        rerankVersion: input.rerankProvider?.metadata.version ?? null,
        chunks: chunks.map(withoutDenseVector)
      };
    }
  };
}

function withoutDenseVector(
  chunk: EvidenceDocumentChunkWithDenseVector
): EvidenceDocumentChunkWrite {
  return {
    documentId: chunk.documentId,
    chunkIndex: chunk.chunkIndex,
    chunkText: chunk.chunkText,
    chunkHash: chunk.chunkHash,
    indexType: chunk.indexType,
    chunkId: chunk.chunkId,
    qdrantPointId: chunk.qdrantPointId,
    contentVersion: chunk.contentVersion,
    retrievalConfigVersion: chunk.retrievalConfigVersion,
    modelName: chunk.modelName,
    modelVersion: chunk.modelVersion,
    sourceLocation: chunk.sourceLocation
  };
}

export class HttpQdrantEvidenceWriter implements QdrantEvidenceWriter {
  constructor(
    private readonly input: {
      url: string;
      apiKey: string | null;
      timeoutMs: number;
      fetch?: typeof fetch;
    }
  ) {}

  async upsertEvidencePoints(input: {
    collection: string;
    points: QdrantEvidencePoint[];
  }): Promise<void> {
    const fetchImpl = this.input.fetch ?? fetch;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.input.timeoutMs);

    try {
      const response = await fetchImpl(
        `${this.input.url}/collections/${encodeURIComponent(input.collection)}/points?wait=true`,
        {
          method: "PUT",
          headers: {
            "content-type": "application/json",
            ...(this.input.apiKey ? { "api-key": this.input.apiKey } : {})
          },
          body: JSON.stringify({
            points: input.points.map((point) => ({
              id: point.id,
              vector: {
                [QDRANT_DENSE_VECTOR_NAME]: point.denseVector,
                [QDRANT_SPARSE_VECTOR_NAME]: point.sparseVector
              },
              payload: point.payload
            }))
          }),
          signal: controller.signal
        }
      );

      if (!response.ok) {
        throw new Error(`Qdrant evidence upsert failed: HTTP ${response.status}`);
      }
    } finally {
      clearTimeout(timeout);
    }
  }
}

export function createEvidenceIndexerFromEnv(
  input: {
    env?: NodeJS.ProcessEnv;
    fetch?: typeof fetch;
  } = {}
): EvidenceIndexer {
  const env = input.env ?? process.env;
  const runtime = parseWorkerRetrievalRuntimeConfig(env);
  const workerRuntime = loadWorkerRuntimeLimits(env);
  const providers = createModelProvidersFromEnv({
    env,
    fetch: input.fetch
  });

  return createEvidenceIndexer({
    retrievalConfig: providers.retrievalConfig,
    embeddingProvider: providers.embeddingProvider,
    rerankProvider: providers.rerankProvider,
    maxDocumentChars: workerRuntime.maxDocumentChars,
    maxChunksPerDocument: workerRuntime.maxChunksPerDocument,
    qdrantWriter: new HttpQdrantEvidenceWriter({
      url: runtime.qdrant.url,
      apiKey: runtime.qdrant.apiKey,
      timeoutMs: runtime.qdrant.timeoutMs,
      fetch: input.fetch
    })
  });
}

export class EvidenceIndexingLimitError extends Error {
  readonly retryable = false;

  constructor(
    readonly code: string,
    message: string
  ) {
    super(message);
    this.name = "EvidenceIndexingLimitError";
  }
}

function evidenceFileType(
  run: ClaimedProcessingRun
): Extract<Phase3FileType, "md" | "txt" | "docx"> {
  const document = requireEvidenceDocument(run);
  const fileType = document.fileType ?? extname(document.originalFileName ?? "").slice(1);

  if (fileType === "md" || fileType === "txt" || fileType === "docx") {
    return fileType;
  }

  throw new Error(`Unsupported evidence file type: ${fileType || "unknown"}`);
}

function requireEvidenceDocument(
  run: ClaimedProcessingRun
): NonNullable<ClaimedProcessingRun["document"]> {
  if (!run.document) throw new Error("Evidence processing document is missing.");
  return run.document;
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

function stableUuid(value: string): string {
  const hex = sha256(value);
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    `4${hex.slice(13, 16)}`,
    `${((Number.parseInt(hex.slice(16, 18), 16) & 0x3f) | 0x80).toString(16)}${hex.slice(18, 20)}`,
    hex.slice(20, 32)
  ].join("-");
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}
