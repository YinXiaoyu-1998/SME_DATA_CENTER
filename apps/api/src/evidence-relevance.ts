import type { EvidenceRelevancePolicy } from "@smedc/domain";

export function pruneEvidenceCandidates<
  T extends {
    chunkId: string;
    rerankScore: number | null;
  }
>(
  candidates: readonly T[],
  policy: EvidenceRelevancePolicy
): {
  kept: T[];
  droppedCount: number;
  warnings: string[];
  cutoffReason: "disabled" | "below_floor" | "score_gap" | "none";
} {
  if (policy.mode === "disabled") {
    return {
      kept: [...candidates],
      droppedCount: 0,
      warnings: [],
      cutoffReason: "disabled"
    };
  }

  const scored = candidates
    .filter((candidate): candidate is T & { rerankScore: number } =>
      Number.isFinite(candidate.rerankScore)
    )
    .sort(
      (left, right) =>
        right.rerankScore - left.rerankScore || left.chunkId.localeCompare(right.chunkId)
    );
  const missingScoreCount = candidates.length - scored.length;
  const aboveFloor = scored.filter((candidate) => candidate.rerankScore >= policy.rerankMinScore);
  const floorDroppedCount = scored.length - aboveFloor.length;

  if (aboveFloor.length === 0) {
    return {
      kept: [],
      droppedCount: candidates.length,
      warnings: missingScoreCount > 0 ? ["RERANK_INCOMPLETE"] : [],
      cutoffReason: floorDroppedCount > 0 ? "below_floor" : "none"
    };
  }

  let largestGap = Number.NEGATIVE_INFINITY;
  let largestGapIndex = -1;
  for (let index = 0; index < aboveFloor.length - 1; index += 1) {
    const current = aboveFloor[index];
    const next = aboveFloor[index + 1];
    if (!current || !next) continue;
    const gap = current.rerankScore - next.rerankScore;
    if (gap > largestGap) {
      largestGap = gap;
      largestGapIndex = index;
    }
  }

  const lowerClusterFirst = largestGapIndex >= 0 ? aboveFloor[largestGapIndex + 1] : undefined;
  const shouldCutAtGap =
    largestGapIndex >= 0 &&
    largestGap >= policy.rerankMinGap &&
    Boolean(lowerClusterFirst && lowerClusterFirst.rerankScore <= policy.rerankLowClusterMaxScore);
  const kept = shouldCutAtGap ? aboveFloor.slice(0, largestGapIndex + 1) : aboveFloor;

  return {
    kept,
    droppedCount: candidates.length - kept.length,
    warnings: missingScoreCount > 0 ? ["RERANK_INCOMPLETE"] : [],
    cutoffReason: shouldCutAtGap ? "score_gap" : floorDroppedCount > 0 ? "below_floor" : "none"
  };
}
