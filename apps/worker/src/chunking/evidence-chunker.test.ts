import { describe, expect, it } from "vitest";
import { createEvidenceChunks, type EvidenceChunkerBlock } from "./evidence-chunker.js";

describe("evidence chunker", () => {
  const blocks: EvidenceChunkerBlock[] = [
    {
      blockType: "heading",
      headingPath: ["Operations SOP"],
      text: "Operations SOP",
      sourceLocation: { startLine: 1, endLine: 1 }
    },
    {
      blockType: "paragraph",
      headingPath: ["Operations SOP"],
      text: "The operations portal stores the current checklist.",
      sourceLocation: { startLine: 3, endLine: 3 }
    },
    {
      blockType: "list",
      headingPath: ["Operations SOP", "Opening Checklist"],
      text: "Check fridge temperatures\nConfirm cash drawer",
      sourceLocation: { startLine: 7, endLine: 8 }
    },
    {
      blockType: "table",
      headingPath: ["Operations SOP", "Opening Checklist"],
      text: "Metric | Owner\nTemperature log | Shift lead",
      sourceLocation: { startLine: 10, endLine: 12 }
    }
  ];

  it("groups structural blocks by heading context and records source metadata", () => {
    const result = createEvidenceChunks({
      documentId: "doc_123",
      contentVersion: 1,
      retrievalConfigVersion: "phase3.retrieval.v1",
      blocks,
      maxChunkChars: 240
    });

    expect(result.warnings).toEqual([]);
    expect(result.chunks).toHaveLength(2);
    expect(result.chunks[0]).toEqual(
      expect.objectContaining({
        chunkOrdinal: 0,
        headingPath: ["Operations SOP"],
        text: expect.stringContaining("The operations portal"),
        metadata: expect.objectContaining({ fallbackStrategy: null })
      })
    );
    expect(result.chunks[1]).toEqual(
      expect.objectContaining({
        headingPath: ["Operations SOP", "Opening Checklist"],
        text: expect.stringContaining("Metric | Owner"),
        sourceLocations: [
          { startLine: 7, endLine: 8 },
          { startLine: 10, endLine: 12 }
        ]
      })
    );
  });

  it("generates stable chunk and point ids from document, content version, config version, and ordinal", () => {
    const first = createEvidenceChunks({
      documentId: "doc_123",
      contentVersion: 1,
      retrievalConfigVersion: "phase3.retrieval.v1",
      blocks
    });
    const repeated = createEvidenceChunks({
      documentId: "doc_123",
      contentVersion: 1,
      retrievalConfigVersion: "phase3.retrieval.v1",
      blocks
    });
    const newContentVersion = createEvidenceChunks({
      documentId: "doc_123",
      contentVersion: 2,
      retrievalConfigVersion: "phase3.retrieval.v1",
      blocks
    });
    const newRetrievalConfig = createEvidenceChunks({
      documentId: "doc_123",
      contentVersion: 1,
      retrievalConfigVersion: "phase3.retrieval.v2",
      blocks
    });

    expect(first.chunks.map((chunk) => chunk.chunkId)).toEqual(
      repeated.chunks.map((chunk) => chunk.chunkId)
    );
    expect(first.chunks.map((chunk) => chunk.pointId)).toEqual(
      repeated.chunks.map((chunk) => chunk.pointId)
    );
    expect(first.chunks[0]?.chunkId).toMatch(/^chk_[a-f0-9]{32}$/);
    expect(first.chunks[0]?.pointId).toMatch(/^pt_[a-f0-9]{32}$/);
    expect(newContentVersion.chunks[0]?.chunkId).not.toBe(first.chunks[0]?.chunkId);
    expect(newRetrievalConfig.chunks[0]?.pointId).not.toBe(first.chunks[0]?.pointId);
  });

  it("uses marked fallback chunks only for pathological long blocks", () => {
    const result = createEvidenceChunks({
      documentId: "doc_long",
      contentVersion: 1,
      retrievalConfigVersion: "phase3.retrieval.v1",
      maxChunkChars: 120,
      blocks: [
        {
          blockType: "paragraph",
          headingPath: ["Long Policy"],
          text: "policy ".repeat(80).trim(),
          sourceLocation: { startLine: 1, endLine: 1 }
        }
      ]
    });

    expect(result.chunks.length).toBeGreaterThan(1);
    expect(result.warnings).toEqual([
      expect.objectContaining({
        code: "PATHOLOGICAL_LONG_BLOCK_SPLIT"
      })
    ]);
    expect(
      result.chunks.every((chunk) => chunk.metadata.fallbackStrategy === "pathological_long_block")
    ).toBe(true);
    expect(result.chunks.every((chunk) => chunk.text.length <= 120)).toBe(true);
  });

  it("carries trailing blocks into the next chunk without exceeding the chunk size", () => {
    const sectionBlocks: EvidenceChunkerBlock[] = [1, 2, 3, 4].map((line) => ({
      blockType: "paragraph",
      headingPath: ["Sanitation"],
      text: String(line).repeat(80),
      sourceLocation: { startLine: line, endLine: line }
    }));

    const withoutOverlap = createEvidenceChunks({
      documentId: "doc_overlap",
      contentVersion: 1,
      retrievalConfigVersion: "phase3.retrieval.v2",
      blocks: sectionBlocks,
      maxChunkChars: 170
    });
    const withOverlap = createEvidenceChunks({
      documentId: "doc_overlap",
      contentVersion: 1,
      retrievalConfigVersion: "phase3.retrieval.v2",
      blocks: sectionBlocks,
      maxChunkChars: 170,
      overlapChars: 80
    });

    expect(withoutOverlap.chunks).toHaveLength(2);
    expect(withOverlap.chunks).toHaveLength(3);
    expect(withOverlap.chunks.every((chunk) => chunk.text.length <= 170)).toBe(true);
    expect(withOverlap.chunks[1]?.text.startsWith("2".repeat(80))).toBe(true);
    expect(withOverlap.chunks[1]?.text.endsWith("3".repeat(80))).toBe(true);
    expect(withOverlap.chunks[1]?.sourceLocations).toEqual([
      { startLine: 2, endLine: 2 },
      { startLine: 3, endLine: 3 }
    ]);
  });

  it("never carries overlap across a heading boundary", () => {
    const result = createEvidenceChunks({
      documentId: "doc_sections",
      contentVersion: 1,
      retrievalConfigVersion: "phase3.retrieval.v2",
      maxChunkChars: 190,
      overlapChars: 90,
      blocks: [
        {
          blockType: "paragraph",
          headingPath: ["First"],
          text: "a".repeat(90),
          sourceLocation: { startLine: 1, endLine: 1 }
        },
        {
          blockType: "paragraph",
          headingPath: ["First"],
          text: "b".repeat(90),
          sourceLocation: { startLine: 2, endLine: 2 }
        },
        {
          blockType: "paragraph",
          headingPath: ["Second"],
          text: "c".repeat(90),
          sourceLocation: { startLine: 3, endLine: 3 }
        },
        {
          blockType: "paragraph",
          headingPath: ["Second"],
          text: "d".repeat(90),
          sourceLocation: { startLine: 4, endLine: 4 }
        }
      ]
    });

    expect(result.chunks).toHaveLength(2);
    expect(result.chunks[0]?.headingPath).toEqual(["First"]);
    expect(result.chunks[0]?.text.includes("c")).toBe(false);
    expect(result.chunks[1]?.headingPath).toEqual(["Second"]);
    expect(result.chunks[1]?.text.includes("b")).toBe(false);
  });

  it("applies character-level overlap to pathological long block pieces within the chunk size", () => {
    const result = createEvidenceChunks({
      documentId: "doc_long_overlap",
      contentVersion: 1,
      retrievalConfigVersion: "phase3.retrieval.v2",
      maxChunkChars: 120,
      overlapChars: 40,
      blocks: [
        {
          blockType: "paragraph",
          headingPath: ["Long Policy"],
          text: "policy ".repeat(80).trim(),
          sourceLocation: { startLine: 1, endLine: 1 }
        }
      ]
    });

    expect(result.chunks.length).toBeGreaterThan(2);
    expect(result.chunks.every((chunk) => chunk.text.length <= 120)).toBe(true);
    expect(result.chunks[1]?.text.startsWith(result.chunks[0]?.text.slice(-40) ?? "")).toBe(true);
  });
});
