import { performance } from "node:perf_hooks";
import { compileStructuredQuery, getStructuredRegistry } from "@enterprise-hub/domain";
import { parseStructuredFile } from "@enterprise-hub/structured-ingestion";
import { evaluateGoldenRetrieval } from "./golden-retrieval-eval.js";
import { buildSyntheticDishesXlsx } from "./synthetic-xlsx.js";

interface PerformanceGate {
  name: string;
  measuredMs: number;
  thresholdMs: number;
  workload: string;
}

interface PerformanceGateReport {
  ok: boolean;
  generatedAt: string;
  mode: "real-local";
  nodeVersion: string;
  thresholdMultiplier: number;
  gates: PerformanceGate[];
  notes: string[];
}

export interface Phase3PerformanceWorkloads {
  compileStructuredQueries?: () => Promise<void> | void;
  parseStructuredCsv?: () => Promise<void> | void;
  parseStructuredXlsx?: (content: Buffer) => Promise<void> | void;
  buildQdrantPayloads?: () => Promise<void> | void;
}

export interface Phase3PerformanceGateOptions {
  workloads?: Phase3PerformanceWorkloads;
  thresholds?: Partial<Record<string, number>>;
  thresholdMultiplier?: number;
}

const DEFAULT_THRESHOLDS = {
  golden_retrieval_100_queries: 2_000,
  evidence_search_synthetic_p95: 25,
  structured_query_compiler_5000: 500,
  structured_large_import_validation_70000_rows: 6_000,
  structured_large_xlsx_import_validation_50000_rows: 12_000,
  qdrant_upsert_payload_5000_chunks: 500
} as const;

const DEFAULT_LIMITS = {
  maxStructuredImportRows: 100_000,
  maxXlsxSheets: 20,
  maxStructuredCellChars: 32_767,
  maxXlsxUncompressedBytes: 209_715_200,
  maxXlsxZipEntries: 10_000,
  maxXlsxCompressionRatio: 100
};

function gate(input: {
  name: keyof typeof DEFAULT_THRESHOLDS;
  measuredMs: number;
  workload: string;
  thresholds?: Phase3PerformanceGateOptions["thresholds"];
  thresholdMultiplier: number;
}): PerformanceGate {
  const baseThresholdMs = input.thresholds?.[input.name] ?? DEFAULT_THRESHOLDS[input.name];
  return {
    name: input.name,
    measuredMs: Number(input.measuredMs.toFixed(4)),
    thresholdMs: Number((baseThresholdMs * input.thresholdMultiplier).toFixed(4)),
    workload: input.workload
  };
}

export function parsePhase3PerformanceThresholdMultiplier(value: string | undefined): number {
  if (value === undefined || value === "") {
    return 1;
  }
  const multiplier = Number(value);
  if (!Number.isFinite(multiplier) || multiplier < 1 || multiplier > 2) {
    throw new Error("PHASE3_PERF_THRESHOLD_MULTIPLIER must be a number from 1 through 2.");
  }
  return multiplier;
}

async function measure(workload: () => Promise<void> | void): Promise<number> {
  const started = performance.now();
  await workload();
  return performance.now() - started;
}

export async function runPhase3PerformanceGates(
  options: Phase3PerformanceGateOptions = {}
): Promise<PerformanceGateReport> {
  const thresholdMultiplier = options.thresholdMultiplier ?? 1;
  parsePhase3PerformanceThresholdMultiplier(String(thresholdMultiplier));
  const goldenStarted = performance.now();
  const golden = await evaluateGoldenRetrieval();
  const goldenMs = performance.now() - goldenStarted;
  const structuredCompileMs = await measure(
    options.workloads?.compileStructuredQueries ?? compileStructuredQueries
  );
  const csvParseMs = await measure(options.workloads?.parseStructuredCsv ?? parseStructuredCsv);
  let xlsxParseMs: number;
  const injectedXlsxWorkload = options.workloads?.parseStructuredXlsx;
  if (injectedXlsxWorkload) {
    xlsxParseMs = await measure(() => injectedXlsxWorkload(Buffer.alloc(0)));
  } else {
    const xlsxContent = await buildSyntheticDishesXlsx(50_000);
    xlsxParseMs = await measure(() => parseStructuredXlsx(xlsxContent));
  }
  const qdrantPayloadMs = await measure(
    options.workloads?.buildQdrantPayloads ?? buildQdrantPayloads
  );

  const gates = [
    gate({
      name: "golden_retrieval_100_queries",
      measuredMs: goldenMs,
      workload: "100 deterministic golden retrieval queries",
      thresholds: options.thresholds,
      thresholdMultiplier
    }),
    gate({
      name: "evidence_search_synthetic_p95",
      measuredMs: Math.max(...golden.metrics.map((m) => m.latencyMs.p95)),
      workload: "maximum p95 from deterministic golden retrieval metrics",
      thresholds: options.thresholds,
      thresholdMultiplier
    }),
    gate({
      name: "structured_query_compiler_5000",
      measuredMs: structuredCompileMs,
      workload: "5,000 controlled structured query compilations",
      thresholds: options.thresholds,
      thresholdMultiplier
    }),
    gate({
      name: "structured_large_import_validation_70000_rows",
      measuredMs: csvParseMs,
      workload:
        "70,000-row RFC4180 CSV parsed and validated by @enterprise-hub/structured-ingestion",
      thresholds: options.thresholds,
      thresholdMultiplier
    }),
    gate({
      name: "structured_large_xlsx_import_validation_50000_rows",
      measuredMs: xlsxParseMs,
      workload:
        "50,000-row synthetic XLSX parsed and validated by @enterprise-hub/structured-ingestion",
      thresholds: options.thresholds,
      thresholdMultiplier
    }),
    gate({
      name: "qdrant_upsert_payload_5000_chunks",
      measuredMs: qdrantPayloadMs,
      workload: "5,000 evidence chunk payloads shaped for Qdrant upsert",
      thresholds: options.thresholds,
      thresholdMultiplier
    })
  ];
  const ok = golden.ok && gates.every((item) => item.measuredMs <= item.thresholdMs);

  return {
    ok,
    generatedAt: new Date().toISOString(),
    mode: "real-local",
    nodeVersion: process.version,
    thresholdMultiplier,
    gates,
    notes: [
      "These gates use local deterministic workloads and do not call external paid providers.",
      thresholdMultiplier === 1
        ? "The default local thresholds are strict and unscaled."
        : `Thresholds are scaled by ${thresholdMultiplier} for the declared shared-runner environment.`,
      "Worker lease recovery is a correctness integration gate, not a synthetic performance measurement.",
      "Real provider readiness still requires explicitly loading local .env and running provider-backed integration paths."
    ]
  };
}

async function compileStructuredQueries() {
  for (let index = 0; index < 5_000; index += 1) {
    compileStructuredQuery({
      orgId: "default-org",
      employee: {
        id: "emp_perf",
        clearance: 3
      },
      cursorSecret: "perf-cursor-secret",
      query: {
        dataset: "vip",
        select: ["business_date", "member_id", "recharge_consumption_amount_total"],
        filter: {
          and: [
            { field: "business_date", op: "between", value: ["2026-07-01", "2026-07-31"] },
            {
              field: "recharge_consumption_amount_total",
              op: "gte",
              value: 1
            }
          ]
        },
        sort: [
          { field: "business_date", direction: "asc" },
          {
            field: "recharge_consumption_amount_total",
            direction: "desc"
          }
        ],
        page: { limit: 50 }
      }
    });
  }
}

async function parseStructuredCsv() {
  await parseStructuredFile({
    dataset: "dishes",
    fileName: "phase3-performance-dishes.csv",
    fileType: "csv",
    content: Buffer.from(generateStructuredCsv(70_000), "utf8"),
    startDate: "20260701",
    endDate: "20260731",
    limits: DEFAULT_LIMITS
  });
}

async function parseStructuredXlsx(content: Buffer) {
  await parseStructuredFile({
    dataset: "dishes",
    fileName: "phase3-performance-dishes.xlsx",
    fileType: "xlsx",
    content,
    startDate: "20260701",
    endDate: "20260701",
    limits: DEFAULT_LIMITS
  });
}

function buildQdrantPayloads() {
  const payloads = Array.from({ length: 5_000 }, (_, index) => {
    const text = `差评处理 SOP chunk ${index} requires order id, contact action, and compensation record.`;
    return {
      id: `00000000-0000-4000-8000-${index.toString().padStart(12, "0")}`,
      vector: {
        dense: deterministicVector(text, 8),
        sparse: sparseVector(text)
      },
      payload: {
        orgId: "default-org",
        documentId: `doc_perf_${Math.floor(index / 10)}`,
        chunkId: `chk_perf_${index}`,
        documentIndexId: null,
        contentVersion: 1,
        retrievalConfigVersion: "phase3.retrieval.v1",
        text,
        sourceLocation: {
          sectionHeadingPath: ["差评处理"],
          blockTypes: ["paragraph"],
          sourceLocations: [{ startLine: index + 1, endLine: index + 1 }]
        }
      }
    };
  });

  JSON.stringify({ points: payloads });
}

function generateStructuredCsv(rowCount: number) {
  const registry = getStructuredRegistry("dishes");
  const fileFields = registry.fields.filter((field) => field.inputSource === "file");
  const header = fileFields.map((field) => csvCell(field.sourceColumn)).join(",");
  const rows = Array.from({ length: rowCount }, (_, index) =>
    fileFields
      .map((field) =>
        csvCell(
          field.canonicalName === "business_date"
            ? `2026-07-${String((index % 31) + 1).padStart(2, "0")}`
            : valueForField(field.type, index)
        )
      )
      .join(",")
  );
  return `${header}\n${rows.join("\n")}\n`;
}

function valueForField(type: string, index: number) {
  switch (type) {
    case "date":
      return `2026-07-${String((index % 31) + 1).padStart(2, "0")}`;
    case "date_time":
      return `2026-07-${String((index % 31) + 1).padStart(2, "0")} 12:00:00`;
    case "integer":
      return String((index % 97) + 1);
    case "decimal":
    case "percent":
      return `${(index % 97) + 1}.25`;
    default:
      return `性能门禁-${index % 13}`;
  }
}

function csvCell(value: string) {
  return `"${value.replaceAll('"', '""')}"`;
}

function deterministicVector(text: string, dimension: number) {
  const digest = Buffer.from(text);
  return Array.from(
    { length: dimension },
    (_, index) => ((digest[index % digest.length] ?? 0) % 17) / 17
  );
}

function sparseVector(text: string) {
  const counts = new Map<number, number>();
  for (const token of text.toLowerCase().match(/[\p{L}\p{N}_]+/gu) ?? []) {
    const index = Number.parseInt(hash(token).slice(0, 7), 16);
    counts.set(index, (counts.get(index) ?? 0) + 1);
  }
  const entries = [...counts.entries()].sort((first, second) => first[0] - second[0]);
  return {
    indices: entries.map(([index]) => index),
    values: entries.map(([, value]) => value)
  };
}

function hash(value: string) {
  let current = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    current ^= value.charCodeAt(index);
    current = Math.imul(current, 0x01000193);
  }
  return (current >>> 0).toString(16).padStart(8, "0");
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const report = await runPhase3PerformanceGates({
    thresholdMultiplier: parsePhase3PerformanceThresholdMultiplier(
      process.env["PHASE3_PERF_THRESHOLD_MULTIPLIER"]
    )
  });
  console.log(JSON.stringify(report, null, 2));

  if (!report.ok) {
    process.exitCode = 1;
  }
}
