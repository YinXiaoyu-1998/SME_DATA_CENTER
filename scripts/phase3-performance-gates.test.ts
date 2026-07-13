import { describe, expect, it } from "vitest";
import { runPhase3PerformanceGates } from "./phase3-performance-gates.js";

describe("phase 3 performance gates", () => {
  it("produces deterministic synthetic local gate report without secrets or real data", async () => {
    const report = await runPhase3PerformanceGates();

    expect(report.mode).toBe("synthetic-local");
    expect(report.gates.map((gate) => gate.name)).toEqual([
      "golden_retrieval_100_queries",
      "evidence_search_synthetic_p95",
      "structured_query_compiler_synthetic",
      "structured_large_import_validation_synthetic",
      "worker_lease_recovery_synthetic",
      "qdrant_upsert_batch_shape_synthetic"
    ]);
    expect(
      report.gates
        .filter((gate) => gate.name !== "golden_retrieval_100_queries")
        .every((gate) => gate.measuredMs <= gate.thresholdMs)
    ).toBe(true);
    expect(JSON.stringify(report)).not.toContain("OPENAI_COMPATIBLE_API_KEY");
  });
});
