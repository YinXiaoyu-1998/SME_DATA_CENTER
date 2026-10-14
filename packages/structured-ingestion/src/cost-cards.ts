import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { parse as parseCsv } from "csv-parse";
import {
  COST_CARD_UPLOAD_SCHEMA,
  COST_CARD_CSV_SCHEMA_VERSION,
  COST_CARD_CANONICALIZATION_VERSION,
  PHASE3_RUNTIME_LIMIT_DEFAULTS,
  costCardFromRows,
  costCardScopedValues,
  costCardStores,
  hashCostCard,
  normalizeCostCardValue,
  resolveStructuredHeaders,
  type CanonicalCostCard,
  type CostCardFields,
  type CostCardIdentity,
  type CostCardSourceLocation
} from "@smedc/domain";
import type {
  ParseStructuredFileInput,
  StructuredImportRow,
  StructuredParseResult,
  StructuredValidationIssue
} from "./index.js";
import { readXlsxRows } from "./xlsx-stream.js";
import { BoundedFileWriterPool, csvCell } from "./partition-export.js";

const SOURCE_COLUMNS = ["source_sheet_index", "source_sheet_name", "source_row_number"] as const;
const CSV_HEADERS = [...COST_CARD_UPLOAD_SCHEMA.map((f) => f.sourceColumn), ...SOURCE_COLUMNS];
const MAX_ISSUES = 100;
const INPUT_ROW_LIMIT = PHASE3_RUNTIME_LIMIT_DEFAULTS.maxStructuredImportRows;

export type CostCardFileInput = Omit<ParseStructuredFileInput, "dataset"> & {
  dataset: "cost_cards";
};
export interface CostCardParseResult {
  cards: CanonicalCostCard[];
  inputCardCount: number;
  inputItemRowCount: number;
  validationErrors: StructuredValidationIssue[];
  validationErrorCount: number;
  validationErrorsTruncated: boolean;
}
export interface CostCardCsvExportEntry {
  identity: CostCardIdentity;
  card: CostCardFields;
  localFilePath: string;
  checksumSha256: string;
  contentHash: string;
  byteSize: number;
  itemRowCount: number;
  recipeCount: number;
  schemaVersion: number;
  canonicalizationVersion: number;
  sourceLocations: CostCardSourceLocation[];
}
export interface CostCardCsvExport {
  cards: CostCardCsvExportEntry[];
  inputCardCount: number;
  inputItemRowCount: number;
}

/** Upload remains 35 columns. The public raw parser defers enterprise grouping to the worker. */
export async function parseCostCardFile(input: CostCardFileInput): Promise<StructuredParseResult> {
  const result: StructuredParseResult = {
    sheetSummary: [],
    ignoredSheets: [],
    rows: [],
    validationErrors: [],
    validationErrorCount: 0,
    validationErrorsTruncated: false
  };
  const report = (issue: StructuredValidationIssue) => {
    result.validationErrorCount++;
    if (result.validationErrors.length < MAX_ISSUES) result.validationErrors.push(issue);
    result.validationErrorsTruncated = result.validationErrorCount > MAX_ISSUES;
  };
  try {
    if (input.fileName.split(".").pop()?.toLowerCase() !== input.fileType)
      throw new Error("File name and file type disagree.");
    if (input.content.length > PHASE3_RUNTIME_LIMIT_DEFAULTS.maxUploadBytes)
      throw new Error("Cost card source exceeds 50 MiB.");
    if (input.startDate !== undefined || input.endDate !== undefined)
      throw new Error("Cost card uploads do not accept a date window.");
    const rowLimit = Math.min(input.limits.maxStructuredImportRows, INPUT_ROW_LIMIT);
    const sheets: Array<{
      name: string;
      hidden: boolean;
      rows: string[][];
      sourceRowNumbers?: number[];
    }> =
      input.fileType === "xlsx"
        ? await readXlsxRows(input.content, input.limits, {
            preserveNumericText: true,
            maxRows: rowLimit + 10
          })
        : [
            {
              name: "Sheet1",
              hidden: false,
              ...(await csvRows(input.content, rowLimit + 1, input.limits.maxStructuredCellChars))
            }
          ];
    let itemRowCount = 0;
    for (const [sheetIndex, sheet] of sheets.entries()) {
      if (sheet.rows.every((row) => row.every((cell) => !cell.trim()))) continue;
      const candidate =
        input.fileType === "csv" ? 0 : sheet.rows.slice(0, 10).findIndex(isCandidateHeader);
      if (candidate < 0) {
        result.ignoredSheets.push({ sheetIndex, name: sheet.name, reason: "SCHEMA_NOT_MATCHED" });
        continue;
      }
      const location = { sheetIndex, sheetName: sheet.name, rowNumber: candidate + 1 };
      if (sheet.hidden) {
        report({
          ...location,
          code: "HIDDEN_SHEET",
          message: "Hidden cost-card candidate sheet is not allowed.",
          column: null
        });
        continue;
      }
      const resolution = resolveStructuredHeaders("cost_cards", sheet.rows[candidate]!);
      if (!resolution.ok) {
        for (const error of resolution.errors)
          report({
            ...location,
            code: error.code,
            message: `${error.code}: ${error.column}`,
            column: error.column
          });
        continue;
      }
      let dataRowCount = 0;
      for (let index = candidate + 1; index < sheet.rows.length; index++) {
        const cells = sheet.rows[index]!;
        if (!cells.some((v) => v.trim())) continue;
        dataRowCount++;
        itemRowCount++;
        if (itemRowCount > rowLimit) throw new Error("Cost card item row limit exceeded.");
        const sourceRowNumber = sheet.sourceRowNumbers?.[index] ?? index + 1;
        const source = {
          sourceSheetIndex: sheetIndex,
          sourceSheetName: sheet.name,
          sourceRowNumber
        };
        if (cells.length > 35 && cells.slice(35).some((v) => v.trim())) {
          report({
            ...location,
            rowNumber: sourceRowNumber,
            code: "EXTRA_DATA_COLUMN",
            message: "Row exceeds the 35-column upload header.",
            column: null
          });
          continue;
        }
        const payload: Record<string, unknown> = {};
        for (const field of COST_CARD_UPLOAD_SCHEMA) {
          const mapping = resolution.fields.find((f) => f.canonicalName === field.canonicalName)!;
          try {
            payload[field.canonicalName] = normalizeCostCardValue(
              field,
              cells[mapping.sourceColumnIndex] ?? ""
            );
          } catch (error) {
            report({
              ...location,
              rowNumber: sourceRowNumber,
              code: "INVALID_FIELD_VALUE",
              message: `${cells[resolution.fields.find((f) => f.canonicalName === "spu_id")!.sourceColumnIndex]}/${cells[resolution.fields.find((f) => f.canonicalName === "sku_id")!.sourceColumnIndex]} ${field.canonicalName}: ${message(error)}`,
              column: field.canonicalName
            });
          }
        }
        result.rows.push({ ...source, payload });
      }
      result.sheetSummary.push({
        sheetIndex,
        name: sheet.name,
        hidden: false,
        headerRowNumber: candidate + 1,
        columnCount: 35,
        dataRowCount
      });
    }
    if (!result.sheetSummary.length || !result.rows.length)
      report({
        code: "EMPTY_COST_CARDS",
        message: "Workbook has no valid cost-card item rows.",
        sheetIndex: null,
        sheetName: null,
        rowNumber: null,
        column: null
      });
    if (!result.validationErrorCount) {
      // Group validation needs no business scope; enterprise identity does not change within-file consistency.
      const grouped = groupCostCardRows(result.rows, { enterpriseKey: "validation" });
      for (const issue of grouped.validationErrors) report(issue);
      result.validationErrorCount += grouped.validationErrorCount - grouped.validationErrors.length;
      result.validationErrorsTruncated = result.validationErrorCount > MAX_ISSUES;
    }
  } catch (error) {
    report({
      code: "INVALID_FILE",
      message: message(error),
      sheetIndex: null,
      sheetName: null,
      rowNumber: null,
      column: null
    });
  }
  if (result.validationErrorCount) {
    result.rows = [];
    if (input.validationMode !== "collect")
      throw new Error(result.validationErrors[0]?.message ?? "Invalid cost card input.");
  }
  return result;
}
function isCandidateHeader(cells: string[]): boolean {
  const names = new Set(cells.map((v) => v.trim()));
  if (names.has("菜品SPU编码") || names.has("菜品SKU编码")) return true;
  return (
    COST_CARD_UPLOAD_SCHEMA.filter((f) =>
      [f.sourceColumn, ...f.aliases].some((name) => names.has(name))
    ).length >= 2
  );
}
async function csvRows(
  content: Buffer,
  maximumRows: number,
  maximumCellChars: number
): Promise<{ rows: string[][]; sourceRowNumbers: number[] }> {
  if (content.includes(0)) throw new Error("CSV content must be UTF-8 text.");
  const decoded = new TextDecoder("utf-8", { fatal: true }).decode(content);
  const parser = parseCsv(decoded, {
    bom: true,
    relax_column_count: true,
    skip_empty_lines: false,
    max_record_size: maximumCellChars * 38
  });
  const rows: string[][] = [];
  const sourceRowNumbers: number[] = [];
  let sourceRowNumber = 0;
  for await (const record of parser) {
    sourceRowNumber++;
    const row = record as string[];
    if (sourceRowNumber > 1 && row.every((v) => !v.trim())) continue;
    if (rows.length >= maximumRows) throw new Error("Cost card source row limit exceeded.");
    if (row.some((v) => v.length > maximumCellChars))
      throw new Error("Structured cell length limit exceeded.");
    rows.push(row);
    sourceRowNumbers.push(sourceRowNumber);
  }
  return { rows, sourceRowNumbers };
}

export function groupCostCardRows(
  rows: readonly StructuredImportRow[],
  scope: { enterpriseKey: string }
): CostCardParseResult {
  const cards = new Map<string, CanonicalCostCard>();
  const cardSources = new Map<string, StructuredImportRow>();
  const recipeSources = new Map<string, StructuredImportRow>();
  const issues: StructuredValidationIssue[] = [];
  let issueCount = 0;
  const report = (row: StructuredImportRow, column: string | null, text: string) => {
    issueCount++;
    if (issues.length < MAX_ISSUES)
      issues.push({
        code: "INVALID_COST_CARD",
        message: text,
        sheetIndex: row.sourceSheetIndex,
        sheetName: row.sourceSheetName,
        rowNumber: row.sourceRowNumber,
        column
      });
  };
  if (!scope.enterpriseKey || scope.enterpriseKey.length > 191)
    throw new Error("Valid enterpriseKey is required.");
  if (rows.length > INPUT_ROW_LIMIT) throw new Error("Cost card item row limit exceeded.");
  for (const row of rows) {
    const normalized: Record<string, unknown> = {};
    const identityLabel = `${String(row.payload.spu_id ?? "")}/${String(row.payload.sku_id ?? "")} ${String(row.payload.recipe_type ?? "")}/${String(row.payload.recipe_name ?? "")}`;
    let invalid = false;
    for (const field of COST_CARD_UPLOAD_SCHEMA) {
      try {
        normalized[field.canonicalName] = normalizeCostCardValue(
          field,
          row.payload[field.canonicalName]
        );
      } catch (error) {
        invalid = true;
        report(
          row,
          field.canonicalName,
          `${identityLabel} ${field.canonicalName} at ${sourceLabel(row)}: ${message(error)}`
        );
      }
    }
    if (invalid) continue;
    const identity: CostCardIdentity = {
      enterpriseKey: scope.enterpriseKey,
      sourceNamespace: "meituan",
      spuId: normalized.spu_id as string,
      skuId: normalized.sku_id as string
    };
    const single = costCardFromRows([normalized], identity);
    const candidateRecipe = single.recipes[0]!;
    const standard = ["全局（标准配方）", "标准配方"].includes(candidateRecipe.recipe_type);
    const exception = ["特定（例外配方）", "例外配方"].includes(candidateRecipe.recipe_type);
    if (
      (standard && candidateRecipe.stores.length) ||
      (exception && !candidateRecipe.stores.length)
    ) {
      report(
        row,
        "source_stores_text",
        `${identityLabel} at ${sourceLabel(row)}: standard stores must be empty; exception stores must be explicit.`
      );
    }
    const key = JSON.stringify(identity);
    let card = cards.get(key);
    if (!card) {
      card = { ...single, recipes: [] };
      cards.set(key, card);
      cardSources.set(key, row);
    }
    compareCommon(
      card.card,
      single.card,
      "card",
      cardSources.get(key)!,
      row,
      identityLabel,
      report
    );
    const recipeKey = JSON.stringify([
      key,
      candidateRecipe.recipe_type,
      candidateRecipe.recipe_name
    ]);
    let recipe = card.recipes.find(
      (r) =>
        r.recipe_type === candidateRecipe.recipe_type &&
        r.recipe_name === candidateRecipe.recipe_name
    );
    if (!recipe) {
      recipe = { ...candidateRecipe, items: [] };
      card.recipes.push(recipe);
      recipeSources.set(recipeKey, row);
    }
    compareCommon(
      recipe,
      candidateRecipe,
      "recipe",
      recipeSources.get(recipeKey)!,
      row,
      identityLabel,
      report
    );
    recipe.items.push({
      ...candidateRecipe.items[0]!,
      source: sourceFor(row),
      sourceStoresText: candidateRecipe.source_stores_text
    });
  }
  if (!rows.length)
    report(
      { sourceSheetIndex: 0, sourceSheetName: "Sheet1", sourceRowNumber: 1, payload: {} },
      null,
      "Cost card requires at least one item row."
    );
  return {
    cards: issueCount
      ? []
      : [...cards.values()].sort((a, b) =>
          compareText(JSON.stringify(a.identity), JSON.stringify(b.identity))
        ),
    inputCardCount: cards.size,
    inputItemRowCount: rows.length,
    validationErrors: issues,
    validationErrorCount: issueCount,
    validationErrorsTruncated: issueCount > MAX_ISSUES
  };
}
function compareCommon(
  first: object,
  next: object,
  scope: "card" | "recipe",
  firstSource: StructuredImportRow,
  nextSource: StructuredImportRow,
  identityLabel: string,
  report: (row: StructuredImportRow, column: string, text: string) => void
) {
  const firstValues = costCardScopedValues({ ...first }, scope),
    nextValues = costCardScopedValues({ ...next }, scope);
  for (const field of COST_CARD_UPLOAD_SCHEMA.filter((f) => f.scope === scope)) {
    const a = firstValues[field.canonicalName],
      b = nextValues[field.canonicalName];
    const equal =
      field.canonicalName === "source_stores_text"
        ? JSON.stringify(costCardStores(a as string | null)) ===
          JSON.stringify(costCardStores(b as string | null))
        : a === b;
    if (!equal)
      report(
        nextSource,
        field.canonicalName,
        `${identityLabel} ${field.canonicalName} conflicts between ${sourceLabel(firstSource)} and ${sourceLabel(nextSource)}.`
      );
  }
}

export async function exportCostCardCsv(
  parsed: CostCardParseResult,
  input: {
    workDirectory: string;
    limits?: { maxPartitions: number; maxCanonicalBytes: number; maxOpenFiles?: number };
    signal?: AbortSignal;
  }
): Promise<CostCardCsvExport> {
  if (parsed.validationErrorCount || !parsed.cards.length)
    throw new Error("Cannot export invalid cost cards.");
  const limits = input.limits ?? {
    maxPartitions: 10_000,
    maxCanonicalBytes: 8_589_934_592,
    maxOpenFiles: 32
  };
  for (const value of [limits.maxPartitions, limits.maxCanonicalBytes, limits.maxOpenFiles ?? 32])
    if (!Number.isSafeInteger(value) || value < 1)
      throw new Error("Cost card export limits must be positive safe integers.");
  if (parsed.cards.length > limits.maxPartitions)
    throw new Error("Cost card count limit exceeded.");
  input.signal?.throwIfAborted();
  await mkdir(input.workDirectory, { recursive: true });
  const outputDirectory = await mkdtemp(path.join(input.workDirectory, "cost-card-candidates-"));
  const writers = new BoundedFileWriterPool(limits.maxOpenFiles ?? 32, 256 * 1024);
  const entries: CostCardCsvExportEntry[] = [];
  let totalBytes = 0;
  try {
    for (const card of parsed.cards) {
      input.signal?.throwIfAborted();
      const filePath = path.join(
        outputDirectory,
        `${createHash("sha256").update(JSON.stringify(card.identity)).digest("hex")}.csv`
      );
      const digest = createHash("sha256");
      let byteSize = 0;
      const write = async (line: string) => {
        const bytes = Buffer.byteLength(line);
        totalBytes += bytes;
        byteSize += bytes;
        if (totalBytes > limits.maxCanonicalBytes)
          throw new Error("Cost card canonical bytes limit exceeded.");
        digest.update(line);
        await writers.write(filePath, line);
      };
      await write(`${CSV_HEADERS.map(csvCell).join(",")}\n`);
      const sourceLocations: CostCardSourceLocation[] = [];
      const records = card.recipes.flatMap((recipe) =>
        recipe.items.map((item) => ({
          payload: {
            ...card.card,
            ...recipe,
            ...item,
            source_stores_text:
              item.sourceStoresText === undefined
                ? recipe.source_stores_text
                : item.sourceStoresText
          } as Record<string, unknown>,
          source: item.source
        }))
      );
      records.sort(
        (a, b) =>
          compareText(
            JSON.stringify(COST_CARD_UPLOAD_SCHEMA.map((f) => a.payload[f.canonicalName])),
            JSON.stringify(COST_CARD_UPLOAD_SCHEMA.map((f) => b.payload[f.canonicalName]))
          ) || compareText(JSON.stringify(a.source), JSON.stringify(b.source))
      );
      for (const record of records) {
        input.signal?.throwIfAborted();
        if (!record.source) throw new Error("CSV export requires original source locations.");
        sourceLocations.push(record.source);
        const values = COST_CARD_UPLOAD_SCHEMA.map((f) =>
          normalizeCostCardValue(f, record.payload[f.canonicalName])
        );
        await write(
          `${[...values, record.source.sourceSheetIndex, record.source.sourceSheetName, record.source.sourceRowNumber].map((v) => csvCell(v === null ? "" : String(v))).join(",")}\n`
        );
      }
      entries.push({
        identity: card.identity,
        card: card.card,
        localFilePath: filePath,
        checksumSha256: digest.digest("hex"),
        contentHash: hashCostCard(card),
        byteSize,
        itemRowCount: records.length,
        recipeCount: card.recipes.length,
        schemaVersion: COST_CARD_CSV_SCHEMA_VERSION,
        canonicalizationVersion: COST_CARD_CANONICALIZATION_VERSION,
        sourceLocations
      });
    }
    await writers.closeAll();
    return {
      cards: entries,
      inputCardCount: parsed.inputCardCount,
      inputItemRowCount: parsed.inputItemRowCount
    };
  } catch (error) {
    await writers.abortAll();
    await rm(outputDirectory, { recursive: true, force: true });
    throw error;
  }
}

export async function readCostCardCsv(input: {
  stream: NodeJS.ReadableStream;
  schemaVersion: number;
  identity: CostCardIdentity;
}): Promise<CanonicalCostCard> {
  if (input.schemaVersion !== COST_CARD_CSV_SCHEMA_VERSION)
    throw new Error("Unsupported cost card CSV schema version.");
  const parser = parseCsv({
    bom: false,
    relax_column_count: false,
    skip_empty_lines: false,
    max_record_size: PHASE3_RUNTIME_LIMIT_DEFAULTS.maxStructuredCellChars * 38
  });
  const sourceError = (error: Error) => parser.destroy(error);
  input.stream.on("error", sourceError);
  input.stream.pipe(parser);
  const rows: StructuredImportRow[] = [];
  let header = true;
  try {
    for await (const record of parser) {
      const cells = record as string[];
      if (header) {
        header = false;
        if (JSON.stringify(cells) !== JSON.stringify(CSV_HEADERS))
          throw new Error("Invalid 38-column cost card CSV header.");
        continue;
      }
      if (rows.length >= INPUT_ROW_LIMIT) throw new Error("Cost card item row limit exceeded.");
      if (cells.some((c) => c.length > PHASE3_RUNTIME_LIMIT_DEFAULTS.maxStructuredCellChars))
        throw new Error("Structured cell length limit exceeded.");
      const payload = Object.fromEntries(
        COST_CARD_UPLOAD_SCHEMA.map((f, index) => [
          f.canonicalName,
          normalizeCostCardValue(f, cells[index])
        ])
      );
      if (
        payload.spu_id !== input.identity.spuId ||
        payload.sku_id !== input.identity.skuId ||
        input.identity.sourceNamespace !== "meituan"
      )
        throw new Error("Cost card CSV identity mismatch.");
      if (!/^\d+$/.test(cells[35] ?? "") || !/^[1-9]\d*$/.test(cells[37] ?? ""))
        throw new Error("Invalid cost card source location.");
      const sheetIndex = Number(cells[35]),
        rowNumber = Number(cells[37]);
      if (!Number.isSafeInteger(sheetIndex) || !Number.isSafeInteger(rowNumber) || !cells[36])
        throw new Error("Invalid cost card source location.");
      rows.push({
        sourceSheetIndex: sheetIndex,
        sourceSheetName: cells[36]!,
        sourceRowNumber: rowNumber,
        payload
      });
    }
  } finally {
    input.stream.unpipe(parser);
    input.stream.removeListener("error", sourceError);
    parser.destroy();
    if (input.stream instanceof Readable) input.stream.destroy();
  }
  const parsed = groupCostCardRows(rows, { enterpriseKey: input.identity.enterpriseKey });
  if (parsed.validationErrorCount || parsed.cards.length !== 1)
    throw new Error(
      parsed.validationErrors[0]?.message ?? "CSV must contain exactly one complete cost card."
    );
  return parsed.cards[0]!;
}
function sourceFor(row: StructuredImportRow): CostCardSourceLocation {
  return {
    sourceSheetIndex: row.sourceSheetIndex,
    sourceSheetName: row.sourceSheetName,
    sourceRowNumber: row.sourceRowNumber
  };
}
function sourceLabel(row: StructuredImportRow): string {
  return `${row.sourceSheetName}[${row.sourceSheetIndex}]:${row.sourceRowNumber}`;
}
function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
function message(error: unknown): string {
  return error instanceof Error ? error.message : "Invalid cost card source.";
}
