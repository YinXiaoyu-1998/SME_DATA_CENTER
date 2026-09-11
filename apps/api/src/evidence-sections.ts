import type { PrismaClient } from "@prisma/client";

const HEADING_KEY_SEPARATOR = "\u001f";

export interface EvidenceSectionCandidate {
  chunkId: string;
  documentIndexId: string | null;
  chunkIndex: number;
  sectionHeadingPath: string[];
  fallbackText: string;
}

export interface EvidenceSectionExpansion {
  sectionText: string;
  sectionTruncated: boolean;
}

export interface EvidenceSectionExpander {
  expand(
    candidates: readonly EvidenceSectionCandidate[]
  ): Promise<Map<string, EvidenceSectionExpansion>>;
}

interface SectionChunkRow {
  chunkIndex: number;
  chunkText: string;
  sourceLocation: unknown;
}

interface ChunkRange {
  from: number;
  to: number;
}

/**
 * Expands a matched chunk into the surrounding text of its own heading section, so callers receive
 * usable context instead of a fragment that may start and end mid-clause. Scoring is unaffected:
 * the matched chunk still carries the hybrid and rerank scores.
 */
export function createPrismaEvidenceSectionExpander(input: {
  prisma: PrismaClient;
  maxSectionChars: number;
  maxSectionChunks: number;
}): EvidenceSectionExpander {
  return {
    async expand(candidates) {
      const expansions = new Map<string, EvidenceSectionExpansion>();

      if (candidates.length === 0) {
        return expansions;
      }

      const grouped = new Map<string, EvidenceSectionCandidate[]>();

      for (const candidate of candidates) {
        if (!candidate.documentIndexId) {
          expansions.set(candidate.chunkId, fallbackExpansion(candidate));
          continue;
        }

        const group = grouped.get(candidate.documentIndexId) ?? [];
        group.push(candidate);
        grouped.set(candidate.documentIndexId, group);
      }

      for (const [documentIndexId, group] of grouped) {
        const ranges = mergeChunkRanges(
          group.map((candidate) => ({
            from: candidate.chunkIndex - input.maxSectionChunks,
            to: candidate.chunkIndex + input.maxSectionChunks
          }))
        );
        const rows = await input.prisma.documentChunk.findMany({
          where: {
            documentIndexId,
            OR: ranges.map((range) => ({
              chunkIndex: { gte: range.from, lte: range.to }
            }))
          },
          select: {
            chunkIndex: true,
            chunkText: true,
            sourceLocation: true
          }
        });
        const rowByChunkIndex = new Map<number, SectionChunkRow>(
          rows.map((row) => [row.chunkIndex, row])
        );

        for (const candidate of group) {
          expansions.set(
            candidate.chunkId,
            expandCandidate({
              candidate,
              rowByChunkIndex,
              maxSectionChars: input.maxSectionChars,
              maxSectionChunks: input.maxSectionChunks
            })
          );
        }
      }

      return expansions;
    }
  };
}

function expandCandidate(input: {
  candidate: EvidenceSectionCandidate;
  rowByChunkIndex: Map<number, SectionChunkRow>;
  maxSectionChars: number;
  maxSectionChunks: number;
}): EvidenceSectionExpansion {
  const matched = input.rowByChunkIndex.get(input.candidate.chunkIndex);

  if (!matched) {
    return fallbackExpansion(input.candidate);
  }

  const headingKey = sectionKeyFromHeadingPath(input.candidate.sectionHeadingPath);
  const run: number[] = [input.candidate.chunkIndex];

  if (headingKey.length > 0) {
    // Walk outwards while sibling chunks still belong to the same heading path.
    for (let index = input.candidate.chunkIndex - 1; index >= 0; index -= 1) {
      const row = input.rowByChunkIndex.get(index);

      if (!row || sectionKeyOfRow(row) !== headingKey) {
        break;
      }

      run.unshift(index);
    }

    for (let index = input.candidate.chunkIndex + 1; ; index += 1) {
      const row = input.rowByChunkIndex.get(index);

      if (!row || sectionKeyOfRow(row) !== headingKey) {
        break;
      }

      run.push(index);
    }
  } else {
    // Heading-less documents (plain text uploads) fall back to the immediate neighbours.
    const previous = input.rowByChunkIndex.get(input.candidate.chunkIndex - 1);
    const next = input.rowByChunkIndex.get(input.candidate.chunkIndex + 1);

    if (previous) {
      run.unshift(previous.chunkIndex);
    }

    if (next) {
      run.push(next.chunkIndex);
    }
  }

  const selected = limitRun(run, input.candidate.chunkIndex, input.maxSectionChunks);
  const capTruncated = selected.length < run.length;
  const rows = selected
    .map((index) => input.rowByChunkIndex.get(index))
    .filter((row): row is SectionChunkRow => row !== undefined);
  const joined = joinSectionText(rows, input.maxSectionChars);

  return {
    sectionText: joined.text,
    sectionTruncated: capTruncated || joined.truncated
  };
}

function limitRun(run: number[], matchedChunkIndex: number, maxSectionChunks: number): number[] {
  if (run.length <= maxSectionChunks) {
    return run;
  }

  const matchedPosition = Math.max(0, run.indexOf(matchedChunkIndex));
  const leading = Math.floor((maxSectionChunks - 1) / 2);
  const start = Math.min(
    Math.max(0, matchedPosition - leading),
    Math.max(0, run.length - maxSectionChunks)
  );

  return run.slice(start, start + maxSectionChunks);
}

function joinSectionText(
  rows: SectionChunkRow[],
  maxSectionChars: number
): { text: string; truncated: boolean } {
  const included: string[] = [];
  let length = 0;

  for (const row of rows) {
    const text = row.chunkText.trim();

    if (text.length === 0) {
      continue;
    }

    const separatorLength = included.length === 0 ? 0 : 1;
    const nextLength = length + separatorLength + text.length;

    if (included.length > 0 && nextLength > maxSectionChars) {
      return { text: included.join("\n"), truncated: true };
    }

    included.push(text);
    length = nextLength;
  }

  return { text: included.join("\n"), truncated: false };
}

function fallbackExpansion(candidate: EvidenceSectionCandidate): EvidenceSectionExpansion {
  return {
    sectionText: candidate.fallbackText,
    sectionTruncated: false
  };
}

function mergeChunkRanges(ranges: ChunkRange[]): ChunkRange[] {
  const sorted = [...ranges].sort((first, second) => first.from - second.from);
  const merged: ChunkRange[] = [];

  for (const range of sorted) {
    const previous = merged[merged.length - 1];

    if (previous && range.from <= previous.to + 1) {
      previous.to = Math.max(previous.to, range.to);
      continue;
    }

    merged.push({ ...range });
  }

  return merged;
}

function sectionKeyOfRow(row: SectionChunkRow): string {
  return sectionKeyFromHeadingPath(sourceLocationFromJson(row.sourceLocation).sectionHeadingPath);
}

export function sectionKeyFromHeadingPath(headingPath: readonly string[]): string {
  return headingPath
    .filter((item) => item.length > 0)
    .join(HEADING_KEY_SEPARATOR)
    .trim();
}

export function sourceLocationFromJson(value: unknown): {
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
