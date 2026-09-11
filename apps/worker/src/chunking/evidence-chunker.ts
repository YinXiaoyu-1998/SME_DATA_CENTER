import { createHash } from "node:crypto";
import {
  PHASE3_RUNTIME_LIMIT_DEFAULTS,
  type EvidenceBlockType,
  type EvidenceSourceLocation,
  type EvidenceWarning,
  type ParsedEvidenceBlock
} from "@enterprise-hub/domain";

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
  overlapChars?: number;
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

const DEFAULT_MAX_CHUNK_CHARS = PHASE3_RUNTIME_LIMIT_DEFAULTS.evidenceChunkMaxChars;
const DEFAULT_OVERLAP_CHARS = 0;
const HEADING_KEY_SEPARATOR = "\u001f";

export function createEvidenceChunks(input: CreateEvidenceChunksInput): EvidenceChunkingResult {
  const maxChunkChars = input.maxChunkChars ?? DEFAULT_MAX_CHUNK_CHARS;
  const overlapChars = normalizeOverlapChars(
    input.overlapChars ?? DEFAULT_OVERLAP_CHARS,
    maxChunkChars
  );
  const chunks: EvidenceChunk[] = [];
  const warnings: EvidenceWarning[] = [];
  let pendingBlocks: EvidenceChunkerBlock[] = [];
  let pendingHeadingKey: string | null = null;

  for (const block of input.blocks.filter((candidate) => candidate.text.trim().length > 0)) {
    if (block.text.length > maxChunkChars) {
      flushPending();
      splitPathologicalLongBlock(block, maxChunkChars, overlapChars).forEach(
        (piece, fallbackChunkIndex) => {
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
        }
      );
      warnings.push({
        code: "PATHOLOGICAL_LONG_BLOCK_SPLIT",
        message:
          "A single evidence block exceeded the chunk size and was split with marked fallback metadata.",
        sourceLocation: block.sourceLocation
      });
      continue;
    }

    const headingKey = block.headingPath.join(HEADING_KEY_SEPARATOR);
    if (pendingBlocks.length > 0 && headingKey !== pendingHeadingKey) {
      // Overlap never crosses a heading boundary, so a section change resets the carry.
      flushPending();
    }

    const candidateText = renderBlocks([...pendingBlocks, block]);
    if (pendingBlocks.length > 0 && candidateText.length > maxChunkChars) {
      const flushedBlocks = flushPending();
      pendingBlocks = trailingBlocksForOverlap(flushedBlocks, block, overlapChars, maxChunkChars);
    }

    pendingHeadingKey = headingKey;
    pendingBlocks.push(block);
  }

  flushPending();

  return { chunks, warnings };

  function flushPending(): EvidenceChunkerBlock[] {
    if (pendingBlocks.length === 0) {
      return [];
    }

    const flushedBlocks = pendingBlocks;
    const headingPath = flushedBlocks[flushedBlocks.length - 1]?.headingPath ?? [];
    const chunkOrdinal = chunks.length;
    chunks.push(
      toChunk({
        input,
        chunkOrdinal,
        text: renderBlocks(flushedBlocks),
        headingPath,
        blockTypes: uniqueBlockTypes(flushedBlocks),
        sourceLocations: flushedBlocks.map((block) => block.sourceLocation),
        fallbackStrategy: null
      })
    );
    pendingBlocks = [];
    pendingHeadingKey = null;

    return flushedBlocks;
  }
}

function normalizeOverlapChars(overlapChars: number, maxChunkChars: number) {
  if (!Number.isFinite(overlapChars) || overlapChars <= 0) {
    return 0;
  }

  return Math.min(Math.floor(overlapChars), Math.max(0, maxChunkChars - 1));
}

/**
 * Picks the trailing blocks of a flushed chunk that should be repeated at the start of the next
 * chunk in the same section. Blocks are carried whole so their `sourceLocation` stays accurate,
 * and the carry is trimmed when it would not leave room for the incoming block.
 */
function trailingBlocksForOverlap(
  flushedBlocks: EvidenceChunkerBlock[],
  upcoming: EvidenceChunkerBlock,
  overlapChars: number,
  maxChunkChars: number
): EvidenceChunkerBlock[] {
  if (overlapChars <= 0) {
    return [];
  }

  const carried: EvidenceChunkerBlock[] = [];

  for (let index = flushedBlocks.length - 1; index >= 0; index -= 1) {
    const candidate = flushedBlocks[index];

    if (!candidate) {
      continue;
    }

    const nextCarried = [candidate, ...carried];

    if (renderBlocks(nextCarried).length > overlapChars) {
      break;
    }

    carried.unshift(candidate);
  }

  while (carried.length > 0 && renderBlocks([...carried, upcoming]).length > maxChunkChars) {
    carried.shift();
  }

  return carried;
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

function splitPathologicalLongBlock(
  block: EvidenceChunkerBlock,
  maxChunkChars: number,
  overlapChars: number
) {
  const bodyLimit = Math.max(1, maxChunkChars - overlapChars);
  const bodies = splitIntoBodies(block.text, bodyLimit);

  if (overlapChars <= 0) {
    return bodies;
  }

  return bodies.map((body, index) => {
    const previousBody = bodies[index - 1];

    if (index === 0 || previousBody === undefined) {
      return body;
    }

    return `${previousBody.slice(Math.max(0, previousBody.length - overlapChars))}${body}`;
  });
}

function splitIntoBodies(text: string, bodyLimit: number) {
  const words = text.split(/(\s+)/);
  const chunks: string[] = [];
  let current = "";

  for (const word of words) {
    if (!word) {
      continue;
    }

    if (current.length > 0 && current.length + word.length > bodyLimit) {
      chunks.push(current.trim());
      current = "";
    }

    if (word.length > bodyLimit) {
      for (let index = 0; index < word.length; index += bodyLimit) {
        chunks.push(word.slice(index, index + bodyLimit));
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
