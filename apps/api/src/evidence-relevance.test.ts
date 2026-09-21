import { describe, expect, it } from "vitest";
import type { EvidenceRelevancePolicy } from "@smedc/domain";
import { pruneEvidenceCandidates } from "./evidence-relevance.js";

const policy: EvidenceRelevancePolicy = {
  version: "relevance.v1@phase3.retrieval.v2-bm25",
  mode: "rerank_floor_and_gap",
  rerankMinScore: 0.3,
  rerankMinGap: 0.3,
  rerankLowClusterMaxScore: 0.4
};

describe("evidence relevance pruning", () => {
  it("removes the low cluster from 0.67, 0.62, 0.20, 0.20", () => {
    const result = pruneEvidenceCandidates(candidates([0.67, 0.62, 0.2, 0.2]), policy);

    expect(result.kept.map((candidate) => candidate.rerankScore)).toEqual([0.67, 0.62]);
    expect(result).toMatchObject({ droppedCount: 2, cutoffReason: "below_floor", warnings: [] });
  });

  it("returns no candidates when the top score is below the absolute floor", () => {
    const result = pruneEvidenceCandidates(candidates([0.28, 0.26, 0.24]), policy);

    expect(result.kept).toEqual([]);
    expect(result).toMatchObject({ droppedCount: 3, cutoffReason: "below_floor" });
  });

  it("keeps a lower cluster above the low-cluster ceiling despite a large gap", () => {
    const result = pruneEvidenceCandidates(candidates([0.8, 0.48, 0.47]), policy);

    expect(result.kept.map((candidate) => candidate.rerankScore)).toEqual([0.8, 0.48, 0.47]);
    expect(result).toMatchObject({ droppedCount: 0, cutoffReason: "none" });
  });

  it("cuts at an eligible adjacent score gap", () => {
    const result = pruneEvidenceCandidates(candidates([0.72, 0.61, 0.31]), policy);

    expect(result.kept.map((candidate) => candidate.rerankScore)).toEqual([0.72, 0.61]);
    expect(result).toMatchObject({ droppedCount: 1, cutoffReason: "score_gap" });
  });

  it("uses chunkId as a stable tie-break for equal rerank scores", () => {
    const result = pruneEvidenceCandidates(
      [
        { chunkId: "chunk-b", rerankScore: 0.7 },
        { chunkId: "chunk-a", rerankScore: 0.7 }
      ],
      policy
    );

    expect(result.kept.map((candidate) => candidate.chunkId)).toEqual(["chunk-a", "chunk-b"]);
  });

  it("excludes missing rerank scores and reports an incomplete rerank", () => {
    const result = pruneEvidenceCandidates(
      [
        { chunkId: "scored", rerankScore: 0.7 },
        { chunkId: "missing", rerankScore: null }
      ],
      policy
    );

    expect(result.kept.map((candidate) => candidate.chunkId)).toEqual(["scored"]);
    expect(result).toMatchObject({
      droppedCount: 1,
      cutoffReason: "none",
      warnings: ["RERANK_INCOMPLETE"]
    });
  });

  it("preserves input order and emits no threshold warnings when disabled", () => {
    const input = [
      { chunkId: "first", rerankScore: null },
      { chunkId: "second", rerankScore: 0.1 }
    ];
    const result = pruneEvidenceCandidates(input, { ...policy, mode: "disabled" });

    expect(result.kept).toEqual(input);
    expect(result).toEqual({
      kept: input,
      droppedCount: 0,
      warnings: [],
      cutoffReason: "disabled"
    });
  });
});

function candidates(scores: Array<number | null>) {
  return scores.map((rerankScore, index) => ({ chunkId: `chunk-${index}`, rerankScore }));
}
