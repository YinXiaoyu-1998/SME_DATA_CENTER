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
});
