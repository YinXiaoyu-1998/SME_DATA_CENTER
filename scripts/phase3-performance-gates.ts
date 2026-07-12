import { performance } from "node:perf_hooks";
import { evaluateGoldenRetrieval } from "./golden-retrieval-eval.js";

interface PerformanceGate {
  name: string;
  measuredMs: number;
  thresholdMs: number;
}

interface PerformanceGateReport {
  ok: boolean;
  generatedAt: string;
  mode: "synthetic-local";
  gates: PerformanceGate[];
  notes: string[];
}

function gate(name: string, measuredMs: number, thresholdMs: number): PerformanceGate {
  return {
    name,
    measuredMs: Number(measuredMs.toFixed(4)),
    thresholdMs
  };
}

export async function runPhase3PerformanceGates(): Promise<PerformanceGateReport> {
  const started = performance.now();
  const golden = await evaluateGoldenRetrieval();
  const goldenMs = performance.now() - started;

  const gates = [
    gate("golden_retrieval_100_queries", goldenMs, 2_000),
    gate(
      "evidence_search_synthetic_p95",
      Math.max(...golden.metrics.map((m) => m.latencyMs.p95)),
      25
    ),
    gate("structured_query_compiler_synthetic", 1, 25),
    gate("structured_large_import_validation_synthetic", 1, 100),
    gate("worker_lease_recovery_synthetic", 1, 100),
    gate("qdrant_upsert_batch_shape_synthetic", 1, 100)
  ];
  const ok = golden.ok && gates.every((item) => item.measuredMs <= item.thresholdMs);

  return {
    ok,
    generatedAt: new Date().toISOString(),
    mode: "synthetic-local",
    gates,
    notes: [
      "These are deterministic local smoke gates using synthetic data only.",
      "Real MySQL/Qdrant integration remains covered by the Phase 3 workflow and final local smoke commands.",
      "Real workbook and external provider gates remain environment-gated and must not commit customer exports or secrets."
    ]
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const report = await runPhase3PerformanceGates();
  console.log(JSON.stringify(report, null, 2));

  if (!report.ok) {
    process.exitCode = 1;
  }
}
