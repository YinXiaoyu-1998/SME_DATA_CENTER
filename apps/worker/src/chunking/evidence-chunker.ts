import { createHash } from "node:crypto";
import type {
  EvidenceBlockType,
  EvidenceSourceLocation,
  EvidenceWarning,
  ParsedEvidenceBlock
} from "@smedc/domain";

export type EvidenceChunkerBlock = Pick<
  ParsedEvidenceBlock,
  "blockType" | "headingPath" | "text" | "sourceLocation"
> & {
  blockId?: string;
  metadata?: Record<string, unknown>;
};

export interface CreateEvidenceChunksInput {
  documentId: string;
  contentVersion: number;
  retrievalConfigVersion: string;
  blocks: EvidenceChunkerBlock[];
  maxChunkChars?: number;
}

export interface EvidenceChunk {
  chunkOrdinal: number;
  chunkId: string;
  pointId: string;
  text: string;
  headingPath: string[];
  blockTypes: EvidenceBlockType[];
  sourceLocations: EvidenceSourceLocation[];
  metadata: {
    fallbackStrategy: "pathological_long_block" | null;
    fallbackChunkIndex?: number;
  };
}

export interface EvidenceChunkingResult {
  chunks: EvidenceChunk[];
  warnings: EvidenceWarning[];
}

const DEFAULT_MAX_CHUNK_CHARS = 1_600;

export function createEvidenceChunks(input: CreateEvidenceChunksInput): EvidenceChunkingResult {
  const maxChunkChars = input.maxChunkChars ?? DEFAULT_MAX_CHUNK_CHARS;
  const chunks: EvidenceChunk[] = [];
  const warnings: EvidenceWarning[] = [];
  let pendingBlocks: EvidenceChunkerBlock[] = [];
  let pendingHeadingKey: string | null = null;

  for (const block of input.blocks.filter((candidate) => candidate.text.trim().length > 0)) {
    if (block.text.length > maxChunkChars) {
      flushPending();
      splitPathologicalLongBlock(block, maxChunkChars).forEach((piece, fallbackChunkIndex) => {
        const chunkOrdinal = chunks.length;
        chunks.push(
          toChunk({
            input,
            chunkOrdinal,
            text: piece,
            headingPath: block.headingPath,
            blockTypes: [block.blockType],
            sourceLocations: [block.sourceLocation],
            fallbackStrategy: "pathological_long_block",
            fallbackChunkIndex
          })
        );
      });
      warnings.push({
        code: "PATHOLOGICAL_LONG_BLOCK_SPLIT",
        message:
          "A single evidence block exceeded the chunk size and was split with marked fallback metadata.",
        sourceLocation: block.sourceLocation
      });
      continue;
    }

    const headingKey = block.headingPath.join("\u001f");
    if (pendingBlocks.length > 0 && headingKey !== pendingHeadingKey) {
      flushPending();
    }

    const candidateText = renderBlocks([...pendingBlocks, block]);
    if (pendingBlocks.length > 0 && candidateText.length > maxChunkChars) {
      flushPending();
    }

    pendingHeadingKey = headingKey;
    pendingBlocks.push(block);
  }

  flushPending();

  return { chunks, warnings };

  function flushPending() {
    if (pendingBlocks.length === 0) {
      return;
    }

    const headingPath = pendingBlocks[pendingBlocks.length - 1]?.headingPath ?? [];
    const chunkOrdinal = chunks.length;
    chunks.push(
      toChunk({
        input,
        chunkOrdinal,
        text: renderBlocks(pendingBlocks),
        headingPath,
        blockTypes: uniqueBlockTypes(pendingBlocks),
        sourceLocations: pendingBlocks.map((block) => block.sourceLocation),
        fallbackStrategy: null
      })
    );
    pendingBlocks = [];
    pendingHeadingKey = null;
  }
}

function toChunk(input: {
  input: CreateEvidenceChunksInput;
  chunkOrdinal: number;
  text: string;
  headingPath: string[];
  blockTypes: EvidenceBlockType[];
  sourceLocations: EvidenceSourceLocation[];
  fallbackStrategy: "pathological_long_block" | null;
  fallbackChunkIndex?: number;
}): EvidenceChunk {
  return {
    chunkOrdinal: input.chunkOrdinal,
    chunkId: deterministicEvidenceId("chk", input.input, input.chunkOrdinal),
    pointId: deterministicEvidenceId("pt", input.input, input.chunkOrdinal),
    text: input.text,
    headingPath: [...input.headingPath],
    blockTypes: input.blockTypes,
    sourceLocations: input.sourceLocations,
    metadata: {
      fallbackStrategy: input.fallbackStrategy,
      ...(input.fallbackChunkIndex === undefined
        ? {}
        : { fallbackChunkIndex: input.fallbackChunkIndex })
    }
  };
}

function deterministicEvidenceId(
  prefix: "chk" | "pt",
  input: CreateEvidenceChunksInput,
  chunkOrdinal: number
) {
  const digest = createHash("sha256")
    .update(
      `${prefix}:${input.documentId}:${input.contentVersion}:${input.retrievalConfigVersion}:${chunkOrdinal}`,
      "utf8"
    )
    .digest("hex")
    .slice(0, 32);

  return `${prefix}_${digest}`;
}

function renderBlocks(blocks: EvidenceChunkerBlock[]) {
  return blocks
    .map((block) => block.text.trim())
    .filter((text) => text.length > 0)
    .join("\n\n");
}

function uniqueBlockTypes(blocks: EvidenceChunkerBlock[]) {
  return [...new Set(blocks.map((block) => block.blockType))];
}

function splitPathologicalLongBlock(block: EvidenceChunkerBlock, maxChunkChars: number) {
  const words = block.text.split(/(\s+)/);
  const chunks: string[] = [];
  let current = "";

  for (const word of words) {
    if (!word) {
      continue;
    }

    if (current.length > 0 && current.length + word.length > maxChunkChars) {
      chunks.push(current.trim());
      current = "";
    }

    if (word.length > maxChunkChars) {
      for (let index = 0; index < word.length; index += maxChunkChars) {
        chunks.push(word.slice(index, index + maxChunkChars));
      }
      continue;
    }

    current += word;
  }

  if (current.trim()) {
    chunks.push(current.trim());
  }

  return chunks;
}
