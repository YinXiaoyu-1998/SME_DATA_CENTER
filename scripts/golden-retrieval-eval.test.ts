import { describe, expect, it } from "vitest";
import { buildGoldenJudgedQueries, evaluateGoldenRetrieval } from "./golden-retrieval-eval.js";

describe("phase 3 golden retrieval evaluation", () => {
  it("defines at least 100 judged queries across the synthetic corpus", () => {
    const queries = buildGoldenJudgedQueries();

    expect(queries).toHaveLength(100);
    expect(new Set(queries.map((query) => query.type)).size).toBeGreaterThanOrEqual(8);
    expect(queries.some((query) => query.callerId === "disabled_employee")).toBe(true);
    expect(queries.some((query) => query.unacceptableChunkIds.length > 0)).toBe(true);
  });

  it("passes deterministic golden gates with zero leak metrics", async () => {
    const report = await evaluateGoldenRetrieval({
      now: new Date("2026-07-12T00:00:00.000Z")
    });
    const hybridRerank = report.metrics.find((metric) => metric.mode === "hybrid+rerank");

    expect(report.ok).toBe(true);
    expect(report.corpus.documentCount).toBe(20);
    expect(report.corpus.fileTypes).toEqual({ md: 8, txt: 6, docx: 6 });
    expect(hybridRerank).toMatchObject({
      permissionLeakCount: 0,
      archivedLeakCount: 0,
      stalePayloadLeakCount: 0,
      disabledEmployeeLeakCount: 0
    });
    expect(hybridRerank?.hitRateAt5).toBeGreaterThanOrEqual(report.gates.hitRateAt5Min);
    expect(hybridRerank?.recallAt10).toBeGreaterThanOrEqual(report.gates.recallAt10Min);
    expect(hybridRerank?.mrrAt10).toBeGreaterThanOrEqual(report.gates.mrrAt10Min);
  });
});
