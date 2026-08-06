import { describe, expect, it } from "vitest";
import {
  parsePhase3PerformanceThresholdMultiplier,
  runPhase3PerformanceGates
} from "./phase3-performance-gates.js";

describe("phase 3 performance gates", () => {
  it("produces real local gate report without secrets or real data", async () => {
    const report = await runPhase3PerformanceGates();

    expect(report.mode).toBe("real-local");
    expect(report.nodeVersion).toBe(process.version);
    expect(report.thresholdMultiplier).toBe(1);
    expect(report.gates.map((gate) => gate.name)).toEqual([
      "golden_retrieval_100_queries",
      "evidence_search_synthetic_p95",
      "structured_query_compiler_5000",
      "structured_large_import_validation_70000_rows",
      "structured_large_xlsx_import_validation_50000_rows",
      "qdrant_upsert_payload_5000_chunks"
    ]);
    expect(report.gates.every((gate) => gate.measuredMs >= 0 && gate.thresholdMs > 0)).toBe(true);
    expect(report.gates.map((gate) => gate.workload).join("\n")).toContain("70,000-row");
    expect(report.gates.map((gate) => gate.workload).join("\n")).toContain("50,000-row");
    expect(report.notes.join("\n")).toContain("Worker lease recovery is a correctness");
    expect(JSON.stringify(report)).not.toContain("OPENAI_COMPATIBLE_API_KEY");
  }, 60_000);

  it("fails when an injected real workload exceeds its threshold", async () => {
    const report = await runPhase3PerformanceGates({
      workloads: {
        compileStructuredQueries: async () => {
          await new Promise((resolve) => setTimeout(resolve, 5));
        },
        parseStructuredCsv: () => undefined,
        parseStructuredXlsx: () => undefined,
        buildQdrantPayloads: () => undefined
      },
      thresholds: {
        structured_query_compiler_5000: 1,
        structured_large_import_validation_70000_rows: 10_000,
        structured_large_xlsx_import_validation_50000_rows: 10_000,
        qdrant_upsert_payload_5000_chunks: 10_000
      }
    });

    expect(report.ok).toBe(false);
    expect(
      report.gates.find((gate) => gate.name === "structured_query_compiler_5000")?.measuredMs
    ).toBeGreaterThan(1);
  }, 30_000);

  it("accepts only an explicit bounded shared-runner threshold multiplier", () => {
    expect(parsePhase3PerformanceThresholdMultiplier(undefined)).toBe(1);
    expect(parsePhase3PerformanceThresholdMultiplier("1.25")).toBe(1.25);
    expect(() => parsePhase3PerformanceThresholdMultiplier("0.99")).toThrow(/1 through 2/);
    expect(() => parsePhase3PerformanceThresholdMultiplier("2.01")).toThrow(/1 through 2/);
    expect(() => parsePhase3PerformanceThresholdMultiplier("not-a-number")).toThrow(/1 through 2/);
  });
});
