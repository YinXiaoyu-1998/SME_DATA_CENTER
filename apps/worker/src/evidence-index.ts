import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import type { StorageAdapter } from "@smedc/storage";
import {
  pdfCandidateIdentity,
  reconcilePdfEvidenceAttempt,
  PdfArtifactRecoveryError,
  type PdfEvidenceAttemptRepository,
  type PdfEvidenceAttempt
} from "./evidence-artifacts.js";
import { HttpPdfParserClient, type PdfParserClient } from "./parsers/pdf-parser-client.js";
import { createPdfTableBlocks } from "./chunking/pdf-table-chunker.js";
import { extname } from "node:path";
import {
  parsePdfEvidenceResult,
  type PdfEvidenceResult,
  QDRANT_BM25_VECTOR_NAME,
  QDRANT_DENSE_VECTOR_NAME,
  QDRANT_SPARSE_VECTOR_NAME,
  buildQdrantBm25Document,
  type Phase3FileType,
  type QdrantBm25Document,
  type RetrievalModelConfig
} from "@smedc/domain";
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
  lexicalVectorName: typeof QDRANT_SPARSE_VECTOR_NAME | typeof QDRANT_BM25_VECTOR_NAME;
  lexicalVector: SparseVector | QdrantBm25Document;
  payload: Record<string, unknown>;
}

export interface QdrantEvidenceWriter {
  upsertEvidencePoints(input: {
    collection: string;
    points: QdrantEvidencePoint[];
    signal?: AbortSignal;
  }): Promise<void>;
  deleteEvidencePoints?(input: { collection: string; pointIds: string[] }): Promise<void>;
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
  pdfParserClient?: PdfParserClient;
  pdfArtifacts?: PdfEvidenceAttemptRepository;
  storage?: Pick<StorageAdapter, "putObjectAtKey" | "deleteObject">;
}

export function createEvidenceIndexer(input: CreateEvidenceIndexerInput): EvidenceIndexer {
  const candidates = new Map<string, PdfEvidenceAttempt>();
  const attemptWorkerIds = new Map<string, string>();
  const reconcile = async (attempt: PdfEvidenceAttempt, settledWorkerId?: string) => {
    if (!input.pdfArtifacts || !input.storage) throw new PdfArtifactRecoveryError();
    try {
      return await reconcilePdfEvidenceAttempt({
        attempt,
        repository: input.pdfArtifacts,
        storage: input.storage,
        qdrantWriter: input.qdrantWriter,
        settledWorkerId
      });
    } catch {
      throw new PdfArtifactRecoveryError();
    }
  };
  return {
    releaseCandidate(result) {
      if (result.pdfAttemptId) {
        candidates.delete(result.pdfAttemptId);
        attemptWorkerIds.delete(result.pdfAttemptId);
      }
    },
    async recoverArtifacts() {
      if (!input.pdfArtifacts || !input.storage) return;
      const attempts = await input.pdfArtifacts.listRecoverable({ now: new Date(), limit: 10 });
      let pending = false;
      for (const attempt of attempts) {
        try {
          await reconcile(attempt);
        } catch {
          pending = true;
        }
      }
      if (pending) throw new PdfArtifactRecoveryError();
    },
    async resolveCandidate(result) {
      const attempt = result.pdfAttemptId ? candidates.get(result.pdfAttemptId) : undefined;
      if (!attempt) throw new PdfArtifactRecoveryError();
      try {
        const outcome = await reconcile(attempt, attemptWorkerIds.get(attempt.id));
        if (outcome === "live") throw new PdfArtifactRecoveryError();
        return outcome;
      } finally {
        candidates.delete(attempt.id);
        attemptWorkerIds.delete(attempt.id);
      }
    },
    async indexDocument({ run, content, signal = new AbortController().signal }) {
      const document = requireEvidenceDocument(run);
      const fileType = evidenceFileType(run);
      signal.throwIfAborted();
      let pdf: PdfEvidenceResult | undefined;
      let attempt: PdfEvidenceAttempt | undefined;
      let parsed;
      if (fileType === "pdf") {
        const checksum = createHash("sha256").update(content).digest("hex");
        if (document.checksumSha256 && checksum !== document.checksumSha256)
          throw new EvidenceIndexingLimitError(
            "PDF_SOURCE_MISMATCH",
            "PDF source checksum does not match the document."
          );
        if (
          !input.pdfParserClient ||
          !input.pdfArtifacts ||
          !input.storage?.putObjectAtKey ||
          !input.qdrantWriter.deleteEvidencePoints
        )
          throw new EvidenceIndexingLimitError(
            "PDF_NOT_CONFIGURED",
            "PDF indexing is not configured."
          );
        pdf = parsePdfEvidenceResult(await input.pdfParserClient.parse(content, { signal }));
        if (pdf.sourceChecksumSha256 !== checksum)
          throw new EvidenceIndexingLimitError(
            "PDF_SOURCE_MISMATCH",
            "PDF source checksum does not match the document."
          );
        if (pdf.parserFingerprint.length > 256)
          throw new EvidenceIndexingLimitError(
            "PDF_INVALID_RESULT",
            "Invalid PDF parser fingerprint."
          );
        if (pdf.pages.some((page) => page.outcome === "failed"))
          throw new EvidenceIndexingLimitError("PDF_INCOMPLETE", "PDF contains failed pages.");
        // Persist only the agreed metadata; no parser-provided storage URLs or keys.
        pdf = {
          ...pdf,
          blocks: pdf.blocks.map((block) => ({
            ...block,
            metadata:
              block.blockType === "table"
                ? {
                    tableId: block.metadata.tableId,
                    rowStart: block.metadata.rowStart,
                    rowEnd: block.metadata.rowEnd
                  }
                : {}
          }))
        };
        const tableById = new Map(pdf.tables.map((table) => [table.id, table]));
        const emittedTables = new Set<string>();
        parsed = {
          ...pdf,
          blocks: pdf.blocks.flatMap((block) => {
            if (block.blockType !== "table") return [block];
            const tableId = String(block.metadata.tableId);
            if (emittedTables.has(tableId)) return [];
            emittedTables.add(tableId);
            return createPdfTableBlocks(tableById.get(tableId)!, {
              headingPath: block.headingPath,
              sourceLocation: block.sourceLocation,
              maxChunkChars: 1600
            });
          })
        };
        if (!parsed.blocks.some((block) => block.text.trim()))
          throw new EvidenceIndexingLimitError(
            "PDF_NO_SEARCHABLE_TEXT",
            "PDF contains no searchable text."
          );
        const identity = pdfCandidateIdentity(
          run,
          checksum,
          pdf.parserFingerprint,
          input.retrievalConfig.version
        );
        attempt = {
          ...identity,
          orgId: run.orgId,
          documentId: run.documentId,
          runId: run.id,
          attemptNumber: run.attemptNumber,
          contentVersion: document.contentVersion ?? 1,
          retrievalConfigVersion: input.retrievalConfig.version,
          parserFingerprint: pdf.parserFingerprint,
          collection: input.retrievalConfig.qdrant.collection,
          pointIds: [],
          state: "staged"
        };
      } else {
        parsed = await parseEvidenceDocument({
          fileType,
          originalFilename: document.originalFileName ?? undefined,
          content
        });
      }
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
      if (pdf && chunking.chunks.length > 5000)
        throw new EvidenceIndexingLimitError("TOO_MANY_CHUNKS", "PDF produced too many chunks.");
      signal.throwIfAborted();
      const embeddingResult = await input.embeddingProvider.embedTexts(
        chunking.chunks.map((chunk) => chunk.text)
      );
      const chunks: EvidenceDocumentChunkWithDenseVector[] = chunking.chunks.map((chunk, index) => {
        const qdrantPointId = stableUuid(
          attempt ? `${chunk.pointId}:${attempt.generation}` : chunk.pointId
        );
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
          chunkId: attempt
            ? `chk_${sha256(`${chunk.chunkId}:${attempt.generation}`).slice(0, 32)}`
            : chunk.chunkId,
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

      signal.throwIfAborted();
      if (attempt && pdf) {
        attempt.pointIds = chunks.map((chunk) => chunk.qdrantPointId);
        await input.pdfArtifacts!.stage({ attempt, workerId: run.lockedBy!, now: new Date() });
        candidates.set(attempt.id, attempt);
        attemptWorkerIds.set(attempt.id, run.lockedBy!);
      }
      try {
        if (attempt && pdf) {
          signal.throwIfAborted();
          const body = Buffer.from(JSON.stringify(pdf));
          await input.storage!.putObjectAtKey!({
            key: attempt.parsedObjectKey,
            body: Readable.from(body),
            contentLength: body.length,
            checksumSha256: createHash("sha256").update(body).digest("hex"),
            contentType: "application/json"
          });
        }
        signal.throwIfAborted();
        await input.qdrantWriter.upsertEvidencePoints({
          collection: input.retrievalConfig.qdrant.collection,
          signal,
          points: chunks.map((chunk) => ({
            id: chunk.qdrantPointId,
            denseVector: chunk.denseVector,
            lexicalVectorName:
              input.retrievalConfig.lexical.strategy === "qdrant_bm25"
                ? QDRANT_BM25_VECTOR_NAME
                : QDRANT_SPARSE_VECTOR_NAME,
            lexicalVector:
              input.retrievalConfig.lexical.strategy === "qdrant_bm25"
                ? buildQdrantBm25Document(chunk.chunkText)
                : toSparseVector(chunk.chunkText),
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

        signal.throwIfAborted();
      } catch (error) {
        if (attempt) {
          try {
            await reconcile(attempt, run.lockedBy ?? undefined);
          } finally {
            candidates.delete(attempt.id);
            attemptWorkerIds.delete(attempt.id);
          }
        }
        throw error;
      }
      return {
        ...(pdf && attempt
          ? {
              pdfAttemptId: attempt.id,
              parserFingerprint: pdf.parserFingerprint,
              parsedObjectKey: attempt.parsedObjectKey,
              parseSummary: {
                schemaVersion: 1,
                pageCount: pdf.pageCount,
                pages: pdf.pages,
                complete: true,
                tableCount: pdf.tables.length,
                pictureCount: pdf.pictures.length,
                warnings: [...pdf.warnings, ...chunking.warnings]
              }
            }
          : {}),
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
    signal?: AbortSignal;
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
                [point.lexicalVectorName]: point.lexicalVector
              },
              payload: point.payload
            }))
          }),
          signal: input.signal
            ? AbortSignal.any([input.signal, controller.signal])
            : controller.signal
        }
      );

      if (!response.ok) {
        throw new Error(`Qdrant evidence upsert failed: HTTP ${response.status}`);
      }
    } finally {
      clearTimeout(timeout);
    }
  }
  async deleteEvidencePoints({
    collection,
    pointIds
  }: {
    collection: string;
    pointIds: string[];
  }): Promise<void> {
    if (pointIds.length > 5000) throw new Error("PDF point cleanup exceeds its bound.");
    for (let offset = 0; offset < pointIds.length; offset += 256) {
      const response = await (this.input.fetch ?? fetch)(
        `${this.input.url}/collections/${encodeURIComponent(collection)}/points/delete?wait=true`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            ...(this.input.apiKey ? { "api-key": this.input.apiKey } : {})
          },
          body: JSON.stringify({ points: pointIds.slice(offset, offset + 256) }),
          signal: AbortSignal.timeout(this.input.timeoutMs)
        }
      );
      if (!response.ok) throw new Error(`Qdrant evidence cleanup failed: HTTP ${response.status}`);
    }
  }
}

export function createEvidenceIndexerFromEnv(
  input: {
    env?: NodeJS.ProcessEnv;
    fetch?: typeof fetch;
    storage?: StorageAdapter;
    pdfArtifacts?: PdfEvidenceAttemptRepository;
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
    pdfParserClient:
      workerRuntime.workerJobScope === "pdf"
        ? new HttpPdfParserClient({
            url: env["SMEDC_PDF_SERVICE_URL"] ?? "",
            token: env["SMEDC_PDF_SERVICE_TOKEN"] ?? "",
            fetch: input.fetch
          })
        : undefined,
    storage: input.storage,
    pdfArtifacts: workerRuntime.workerJobScope === "pdf" ? input.pdfArtifacts : undefined,
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
): Extract<Phase3FileType, "md" | "txt" | "docx" | "pdf"> {
  const document = requireEvidenceDocument(run);
  const fileType = document.fileType ?? extname(document.originalFileName ?? "").slice(1);

  if (fileType === "md" || fileType === "txt" || fileType === "docx" || fileType === "pdf") {
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
