/* eslint-disable no-console */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { performance } from "node:perf_hooks";
import ExcelJS from "exceljs";
import { parseStructuredFile } from "@enterprise-hub/structured-ingestion";
import {
  readXlsxRows,
  type XlsxReadLimits
} from "../packages/structured-ingestion/src/xlsx-stream.js";
import { buildSyntheticDishesXlsx } from "./synthetic-xlsx.js";

const ROW_COUNT = Number(process.argv[2] ?? 50_000);
const DATA_DIR = path.resolve(".data/benchmark-xlsx-parse");
const XLSX_PATH = path.join(DATA_DIR, "synthetic-dishes.xlsx");

const LIMITS = {
  maxStructuredImportRows: 100_000,
  maxXlsxSheets: 20,
  maxXlsxUncompressedBytes: 209_715_200,
  maxXlsxZipEntries: 10_000,
  maxXlsxCompressionRatio: 100,
  maxStructuredCellChars: 32_767
};

interface RunResult {
  ms: number;
  peakRssMb: number;
}

async function runChild(mode: "old" | "new" | "pipeline"): Promise<RunResult> {
  const script = fileURLToPath(import.meta.url);
  const result = spawnSync("npx", ["tsx", script, String(ROW_COUNT), mode], {
    encoding: "utf8",
    timeout: 300_000,
    maxBuffer: 10_000_000
  });
  if (result.status !== 0) {
    throw new Error(`benchmark child ${mode} failed:\n${result.stderr || result.stdout}`);
  }
  const lines = result.stdout.trim().split("\n");
  return JSON.parse(lines[lines.length - 1] ?? "{}") as RunResult;
}

async function runWorkload(mode: "old" | "new" | "pipeline"): Promise<RunResult> {
  const content = readFileSync(XLSX_PATH);
  let peakRss = 0;
  const sampler = setInterval(() => {
    peakRss = Math.max(peakRss, process.memoryUsage().rss);
  }, 25);
  const started = performance.now();
  if (mode === "old") {
    const workbook = new ExcelJS.Workbook();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- ExcelJS load types are narrower than Node's Buffer.
    await workbook.xlsx.load(content as any);
    const sheet = workbook.worksheets[0]!;
    for (let rowNumber = 1; rowNumber <= sheet.rowCount; rowNumber++) {
      const row = sheet.getRow(rowNumber);
      for (let columnNumber = 1; columnNumber <= row.cellCount; columnNumber++) {
        String(row.getCell(columnNumber).value ?? "").trim();
      }
    }
  } else if (mode === "new") {
    const sheets = await readXlsxRows(content, LIMITS);
    if (sheets[0]?.rows.length !== ROW_COUNT + 1)
      throw new Error(`unexpected row count ${sheets[0]?.rows.length}`);
  } else {
    const result = await parseStructuredFile({
      dataset: "dishes",
      fileName: "benchmark-dishes.xlsx",
      fileType: "xlsx",
      content,
      startDate: "20260701",
      endDate: "20260701",
      limits: LIMITS
    });
    if (result.rows.length !== ROW_COUNT)
      throw new Error(`unexpected imported row count ${result.rows.length}`);
  }
  const ms = performance.now() - started;
  clearInterval(sampler);
  return { ms, peakRssMb: Number((peakRss / 1_048_576).toFixed(1)) };
}

async function main(): Promise<void> {
  const mode = process.argv[3] as "old" | "new" | "pipeline" | undefined;
  if (mode === "old" || mode === "new" || mode === "pipeline") {
    console.log(JSON.stringify(await runWorkload(mode)));
    return;
  }

  mkdirSync(DATA_DIR, { recursive: true });
  console.log(`generating ${ROW_COUNT}-row synthetic dishes xlsx...`);
  writeFileSync(XLSX_PATH, await buildSyntheticDishesXlsx(ROW_COUNT));
  const bytes = readFileSync(XLSX_PATH).byteLength;
  console.log(`file: ${(bytes / 1_048_576).toFixed(1)} MiB`);

  const old = await runChild("old");
  const fresh = await runChild("new");
  const pipeline = await runChild("pipeline");

  console.log("\nresult (rows = " + ROW_COUNT + ", cells = " + ROW_COUNT * 51 + "):");
  console.log(
    [
      ["path", "time_ms", "peak_rss_mib"],
      ["exceljs extraction", old.ms.toFixed(0), old.peakRssMb],
      ["streaming extraction", fresh.ms.toFixed(0), fresh.peakRssMb],
      ["streaming full pipeline", pipeline.ms.toFixed(0), pipeline.peakRssMb]
    ]
      .map((row) => row.join("\t"))
      .join("\n")
  );
  console.log(
    `speedup: ${(old.ms / Math.max(fresh.ms, 0.001)).toFixed(1)}x, ` +
      `rss reduction: ${(old.peakRssMb / Math.max(fresh.peakRssMb, 0.001)).toFixed(1)}x`
  );
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
