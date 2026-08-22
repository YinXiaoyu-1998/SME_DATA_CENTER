import { parse as parseCsv } from "csv-parse/sync";
import {
  getStructuredRegistry,
  resolveStructuredHeaders,
  type HeaderValidationError,
  type StructuredDatasetName,
  type StructuredFieldRegistryEntry
} from "@enterprise-hub/domain";
import { readXlsxRows } from "./xlsx-stream.js";
const MAX_HEADER_SCAN_ROWS = 10;
export const STRUCTURED_IMPORT_DEFAULT_SHEET_NAME = "Sheet1";
export const MAX_RETAINED_VALIDATION_ERRORS = 100;

export interface StructuredIngestionLimits {
  maxStructuredImportRows: number;
  maxXlsxSheets: number;
  maxStructuredCellChars: number;
  maxXlsxUncompressedBytes: number;
  maxXlsxZipEntries: number;
  maxXlsxCompressionRatio: number;
}

export interface StructuredImportRow {
  sourceSheetIndex: number;
  sourceSheetName: string;
  sourceRowNumber: number;
  payload: Record<string, unknown>;
}
export interface StructuredSheetSummary {
  sheetIndex: number;
  name: string;
  hidden: boolean;
  headerRowNumber: number;
  dataRowCount: number;
}
export interface IgnoredStructuredSheet {
  sheetIndex: number;
  name: string;
  reason: "SCHEMA_NOT_MATCHED";
}
export interface StructuredSheetProfile extends StructuredSheetSummary {
  columnCount: number;
  validationErrors: HeaderValidationError[];
}
export interface StructuredWorkbookProfile {
  dataset: StructuredDatasetName;
  registryVersion: string;
  fileName: string;
  sheets: StructuredSheetProfile[];
  ignoredEmptySheets: string[];
}
export interface ParseStructuredFileInput {
  dataset: StructuredDatasetName;
  fileName: string;
  fileType: "csv" | "xlsx";
  content: Buffer;
  startDate: string;
  endDate: string;
  limits: StructuredIngestionLimits;
  /**
   * The legacy synchronous importer throws after parsing; the worker-facing
   * contract collects deterministic validation issues for durable reporting.
   */
  validationMode?: "throw" | "collect";
}

export interface StructuredValidationIssue {
  code: string;
  message: string;
  sheetName: string | null;
  sheetIndex: number | null;
  rowNumber: number | null;
  column: string | null;
}

export interface StructuredParseResult {
  sheetSummary: StructuredSheetSummary[];
  ignoredSheets: IgnoredStructuredSheet[];
  rows: StructuredImportRow[];
  validationErrors: StructuredValidationIssue[];
  validationErrorCount: number;
  validationErrorsTruncated: boolean;
}

export interface StructuredFilePreflightInput {
  fileName: string;
  fileType: "csv" | "xlsx";
  content: Buffer;
}

/**
 * Transport-safe checks for the API acceptance path. Structured headers,
 * worksheet contents, row counts, ZIP extraction, and cell limits remain in
 * the worker-facing parse contract.
 */
export function preflightStructuredFile(input: StructuredFilePreflightInput): void {
  assertFileType(input);
  if (input.fileType === "csv") assertCsvUtf8Text(input.content);
}

export async function parseStructuredFile(
  input: ParseStructuredFileInput
): Promise<StructuredParseResult> {
  const sheetSummary: StructuredSheetSummary[] = [];
  const ignoredSheets: IgnoredStructuredSheet[] = [];
  const rows: StructuredImportRow[] = [];
  const issues = new ValidationIssueCollector();
  let window: ReturnType<typeof dateWindow>;
  let sheets: Array<{ name: string; hidden: boolean; rows: string[][]; sheetIndex: number }>;

  try {
    assertFileType(input);
    window = dateWindow(input.startDate, input.endDate);
    if (input.dataset === "dish_catalog" && window.start.getTime() !== window.end.getTime()) {
      throw validation("dish_catalog requires startDate and endDate to be the same snapshot date.");
    }
    const parsedSheets =
      input.fileType === "csv"
        ? [
            {
              name: STRUCTURED_IMPORT_DEFAULT_SHEET_NAME,
              hidden: false,
              rows: parseCsvRows(input.content, input.limits)
            }
          ]
        : await readXlsxRows(input.content, input.limits);
    sheets = parsedSheets.map((sheet, sheetIndex) => ({ ...sheet, sheetIndex }));
  } catch (error) {
    issues.add({
      code: "INVALID_FILE",
      message: "Structured file validation failed.",
      sheetName: null,
      sheetIndex: null,
      rowNumber: null,
      column: null,
      legacyMessage: errorMessage(error)
    });
    return finishParse(input, sheetSummary, ignoredSheets, rows, issues);
  }

  const registry = getStructuredRegistry(input.dataset);
  let rowLimitReported = false;
  let matchedSheetCount = 0;
  let matchingSheetFound = false;
  let matchingDataRowCount = 0;
  const catalogSkuRows = new Map<string, StructuredImportRow>();

  for (const sheet of sheets) {
    if (isEmpty(sheet.rows)) continue;
    const candidate = findHeader(input.dataset, sheet.rows);
    const isMatchingSheet = candidate?.resolution.ok === true;
    matchingSheetFound ||= isMatchingSheet;

    if (registry.sheetPolicy === "import_matching_visible") {
      if (sheet.hidden) {
        if (isMatchingSheet) {
          issues.add({
            code: "HIDDEN_SHEET",
            message: "Matching hidden worksheets are not allowed.",
            sheetName: sheet.name,
            sheetIndex: sheet.sheetIndex,
            rowNumber: null,
            column: null,
            legacyMessage: `Matching hidden sheet ${sheet.name} is not allowed.`
          });
        }
        continue;
      }
      if (!isMatchingSheet) {
        ignoredSheets.push({
          sheetIndex: sheet.sheetIndex,
          name: sheet.name,
          reason: "SCHEMA_NOT_MATCHED"
        });
        continue;
      }
    }
    if (sheet.hidden) {
      issues.add({
        code: "HIDDEN_SHEET",
        message: "Non-empty hidden worksheets are not allowed.",
        sheetName: sheet.name,
        sheetIndex: sheet.sheetIndex,
        rowNumber: null,
        column: null,
        legacyMessage: `Hidden non-empty sheet ${sheet.name} is not allowed.`
      });
      continue;
    }
    if (!candidate) {
      issues.add({
        code: "UNRECOGNIZED_HEADER",
        message: "Worksheet has no recognized dataset header.",
        sheetName: sheet.name,
        sheetIndex: sheet.sheetIndex,
        rowNumber: null,
        column: null,
        legacyMessage: `Sheet ${sheet.name} has no recognized ${input.dataset} header.`
      });
      continue;
    }
    if (!candidate.resolution.ok) {
      for (const error of candidate.resolution.errors) {
        issues.add({
          code: "INVALID_HEADER",
          message: "Worksheet header is invalid.",
          sheetName: sheet.name,
          sheetIndex: sheet.sheetIndex,
          rowNumber: candidate.index + 1,
          column: safeHeaderColumn(error),
          legacyMessage: `Sheet ${sheet.name} failed header validation: ${candidate.resolution.errors.map((headerError: HeaderValidationError) => `${headerError.code}:${headerError.column}`).join(",")}`
        });
      }
      continue;
    }
    matchedSheetCount += 1;
    const data = dataRowsFor(input.dataset, sheet, candidate);
    matchingDataRowCount += data.length;
    sheetSummary.push({
      sheetIndex: sheet.sheetIndex,
      name: sheet.name,
      hidden: sheet.hidden,
      headerRowNumber: candidate.index + 1,
      dataRowCount: data.length
    });
    for (const item of data) {
      if (
        item.row.length > candidate.width &&
        item.row.slice(candidate.width).some((value) => value.trim())
      ) {
        issues.add({
          code: "EXTRA_DATA_COLUMN",
          message: "Row has data outside the resolved header width.",
          sheetName: sheet.name,
          sheetIndex: sheet.sheetIndex,
          rowNumber: item.sourceRowNumber,
          column: null,
          legacyMessage: `Row ${item.sourceRowNumber} has data outside the resolved header width.`
        });
        continue;
      }
      const parsed = payloadFor(input.dataset, candidate.resolution.fields, item.row);
      if (parsed.errors.length) {
        for (const error of parsed.errors) {
          issues.add({
            code: "INVALID_FIELD_VALUE",
            message: "Field value is invalid.",
            sheetName: sheet.name,
            sheetIndex: sheet.sheetIndex,
            rowNumber: item.sourceRowNumber,
            column: error.column,
            legacyMessage: error.message
          });
        }
        continue;
      }
      const payload = parsed.payload;
      if (registry.datePolicy === "row_business_date") {
        const businessDate = parseDate(String(payload.business_date ?? ""), false);
        if (
          !businessDate ||
          businessDate.getTime() < window.start.getTime() ||
          businessDate.getTime() > window.end.getTime()
        ) {
          issues.add({
            code: "BUSINESS_DATE_OUTSIDE_WINDOW",
            message: "Business date is outside the import window.",
            sheetName: sheet.name,
            sheetIndex: sheet.sheetIndex,
            rowNumber: item.sourceRowNumber,
            column: "business_date",
            legacyMessage: `Row ${item.sourceRowNumber} business_date is outside import window.`
          });
          continue;
        }
      } else {
        payload.snapshot_date = dateString(window.start);
      }
      if (rows.length >= input.limits.maxStructuredImportRows) {
        if (!rowLimitReported) {
          issues.add({
            code: "ROW_LIMIT_EXCEEDED",
            message: "Structured import row limit exceeded.",
            sheetName: sheet.name,
            sheetIndex: sheet.sheetIndex,
            rowNumber: item.sourceRowNumber,
            column: null,
            legacyMessage: "Structured import row limit exceeded."
          });
          rowLimitReported = true;
        }
        continue;
      }
      const parsedRow = {
        sourceSheetIndex: sheet.sheetIndex,
        sourceSheetName: sheet.name,
        sourceRowNumber: item.sourceRowNumber,
        payload
      };
      if (registry.dataset === "dish_catalog") {
        const skuId = String(payload.sku_id);
        const existing = catalogSkuRows.get(skuId);
        if (existing) {
          issues.add({
            code: "DUPLICATE_KEY",
            message: "sku_id must be unique within a catalog snapshot.",
            sheetName: sheet.name,
            sheetIndex: sheet.sheetIndex,
            rowNumber: item.sourceRowNumber,
            column: "sku_id",
            legacyMessage: `Duplicate sku_id ${skuId} in catalog snapshot.`
          });
          continue;
        }
        catalogSkuRows.set(skuId, parsedRow);
      }
      rows.push(parsedRow);
    }
  }
  if (registry.sheetPolicy === "import_matching_visible" && !matchingSheetFound) {
    issues.add({
      code: "NO_MATCHING_SHEET",
      message: "Workbook has no matching visible import sheets.",
      sheetName: null,
      sheetIndex: null,
      rowNumber: null,
      column: null,
      legacyMessage: "Workbook has no matching visible import sheets."
    });
  } else if (
    registry.sheetPolicy === "import_matching_visible" &&
    matchedSheetCount > 0 &&
    matchingDataRowCount === 0
  ) {
    issues.add({
      code: "EMPTY_SNAPSHOT",
      message: "Catalog snapshot contains no rows.",
      sheetName: null,
      sheetIndex: null,
      rowNumber: null,
      column: null,
      legacyMessage: "Catalog snapshot contains no rows."
    });
  } else if (registry.sheetPolicy === "strict_all_nonempty" && !sheetSummary.length) {
    issues.add({
      code: "NO_IMPORT_SHEETS",
      message: "Workbook has no non-empty import sheets.",
      sheetName: null,
      sheetIndex: null,
      rowNumber: null,
      column: null,
      legacyMessage: "Workbook has no non-empty import sheets."
    });
  }
  return finishParse(input, sheetSummary, ignoredSheets, rows, issues);
}

export async function profileStructuredFile(
  input: Omit<ParseStructuredFileInput, "startDate" | "endDate">
): Promise<StructuredWorkbookProfile> {
  assertFileType(input);
  const sheets =
    input.fileType === "csv"
      ? [
          {
            name: STRUCTURED_IMPORT_DEFAULT_SHEET_NAME,
            hidden: false,
            rows: parseCsvRows(input.content, input.limits)
          }
        ]
      : await readXlsxRows(input.content, input.limits);
  const profile: StructuredSheetProfile[] = [];
  const ignoredEmptySheets: string[] = [];
  const registry = getStructuredRegistry(input.dataset);
  let dataRowCount = 0;
  let matchedSheetCount = 0;
  for (const sheet of sheets) {
    if (isEmpty(sheet.rows)) {
      ignoredEmptySheets.push(sheet.name);
      continue;
    }
    const candidate = findHeader(input.dataset, sheet.rows);
    const isMatchingSheet = candidate?.resolution.ok === true;
    if (registry.sheetPolicy === "import_matching_visible") {
      if (sheet.hidden) {
        if (isMatchingSheet)
          throw validation(`Matching hidden sheet ${sheet.name} is not allowed.`);
        continue;
      }
      if (!isMatchingSheet) continue;
    }
    if (sheet.hidden) throw validation(`Hidden non-empty sheet ${sheet.name} is not allowed.`);
    if (!candidate || !candidate.resolution.ok)
      throw validation(
        `VALIDATION_FAILED: ${sheet.name} has no recognized ${input.dataset} header`
      );
    const data = dataRowsFor(input.dataset, sheet, candidate);
    matchedSheetCount += 1;
    assertWithinHeaderWidth(data, candidate);
    dataRowCount += data.length;
    if (dataRowCount > input.limits.maxStructuredImportRows)
      throw validation("Structured import row limit exceeded.");
    profile.push({
      sheetIndex: sheets.indexOf(sheet),
      name: sheet.name,
      hidden: sheet.hidden,
      headerRowNumber: candidate.index + 1,
      columnCount: candidate.width,
      dataRowCount: data.length,
      validationErrors: []
    });
  }
  if (registry.sheetPolicy === "import_matching_visible" && matchedSheetCount === 0)
    throw validation("Workbook has no matching visible import sheets.");
  if (registry.sheetPolicy === "import_matching_visible" && dataRowCount === 0)
    throw validation("Catalog snapshot contains no rows.");
  return {
    dataset: input.dataset,
    registryVersion: registry.version,
    fileName: input.fileName,
    sheets: profile,
    ignoredEmptySheets
  };
}

function dataRowsFor(
  dataset: StructuredDatasetName,
  sheet: { rows: string[][] },
  candidate: { index: number; width: number }
) {
  return sheet.rows
    .slice(candidate.index + 1)
    .map((row, index) => ({ row, sourceRowNumber: candidate.index + index + 2 }))
    .filter(({ row }) => row.some((cell) => cell.trim()))
    .filter(({ row }) => dataset === "dish_catalog" || !isSummary(row));
}

function assertWithinHeaderWidth(
  data: Array<{ row: string[]; sourceRowNumber: number }>,
  candidate: { width: number }
) {
  for (const item of data) {
    if (
      item.row.length > candidate.width &&
      item.row.slice(candidate.width).some((value) => value.trim())
    )
      throw validation(`Row ${item.sourceRowNumber} has data outside the resolved header width.`);
  }
}

function assertFileType(input: { fileName: string; fileType: "csv" | "xlsx"; content: Buffer }) {
  const extension = input.fileName.split(".").pop()?.toLowerCase();
  if (extension !== input.fileType) throw validation("File name and file type disagree.");
  if (
    input.fileType === "xlsx" &&
    !input.content.subarray(0, 4).equals(Buffer.from([0x50, 0x4b, 0x03, 0x04]))
  )
    throw validation("XLSX file does not have a ZIP signature.");
}
function parseCsvRows(content: Buffer, limits: StructuredIngestionLimits): string[][] {
  const decoded = assertCsvUtf8Text(content);
  return parseCsv(decoded, { bom: true, relax_column_count: true, skip_empty_lines: false }).map(
    (row: unknown[]) => row.map((value) => checkedCellText(String(value), limits))
  );
}
function assertCsvUtf8Text(content: Buffer): string {
  if (content.includes(0)) throw validation("CSV content must be UTF-8 text.");
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(content);
  } catch {
    throw validation("CSV content must be UTF-8 text.");
  }
}
function checkedCellText(text: string, limits: StructuredIngestionLimits): string {
  if (text.length > limits.maxStructuredCellChars)
    throw validation("Structured cell length limit exceeded.");
  return text.trim();
}
function findHeader(dataset: StructuredDatasetName, rows: string[][]) {
  let fallback:
    | { index: number; width: number; resolution: ReturnType<typeof resolveStructuredHeaders> }
    | undefined;
  for (let index = 0; index < Math.min(MAX_HEADER_SCAN_ROWS, rows.length); index++) {
    const headers = trimTail(rows[index] ?? []);
    const resolution = resolveStructuredHeaders(dataset, headers);
    if (resolution.ok) return { index, width: headers.length, resolution };
    if (!fallback && headers.some((value) => value))
      fallback = { index, width: headers.length, resolution };
  }
  return fallback;
}
function payloadFor(
  dataset: StructuredDatasetName,
  mappings: Array<{ canonicalName: string; sourceColumnIndex: number }>,
  row: string[]
) {
  const fields = new Map(
    getStructuredRegistry(dataset).fields.map((field) => [field.canonicalName, field])
  );
  const payload: Record<string, unknown> = {};
  const errors: Array<{ column: string; message: string }> = [];
  for (const mapping of mappings) {
    try {
      payload[mapping.canonicalName] = parseCell(
        fields.get(mapping.canonicalName)!,
        row[mapping.sourceColumnIndex] ?? ""
      );
    } catch (error) {
      errors.push({ column: mapping.canonicalName, message: errorMessage(error) });
    }
  }
  return { payload, errors };
}
function parseCell(field: StructuredFieldRegistryEntry, value: string): unknown {
  const text = value.trim();
  if (!text) {
    if (!field.nullable) throw validation(`${field.canonicalName} is required.`);
    return null;
  }
  if (field.type === "integer") {
    if (!/^[+-]?\d+$/.test(text)) throw validation(`${field.canonicalName} must be an integer.`);
    const number = Number(text);
    if (!Number.isSafeInteger(number))
      throw validation(`${field.canonicalName} must be a safe integer.`);
    return number;
  }
  if (field.type === "decimal" || field.type === "percent") {
    const expression =
      field.type === "percent"
        ? /^[+-]?(?:\d+(?:\.\d+)?|\.\d+)%?$/
        : /^[+-]?(?:\d+(?:\.\d+)?|\.\d+)$/;
    if (!expression.test(text)) throw validation(`${field.canonicalName} must be numeric.`);
    const number = Number(
      field.type === "percent" && text.endsWith("%") ? text.slice(0, -1) : text
    );
    if (!Number.isFinite(number)) throw validation(`${field.canonicalName} must be numeric.`);
    return number;
  }
  if (field.type === "date" || field.type === "date_time") {
    const date = parseDate(text, field.type === "date_time");
    if (!date) throw validation(`${field.canonicalName} must be a date.`);
    return field.type === "date_time" ? dateTimeString(date) : dateString(date);
  }
  return text;
}
function parseDate(text: string, dateTime: boolean): Date | null {
  const date = "(\\d{4})(?:(\\d{2})(\\d{2})|-(\\d{2})-(\\d{2})|/(\\d{2})/(\\d{2}))";
  const time = "(?:[T ](\\d{2}):(\\d{2})(?::(\\d{2}))?)";
  const match = new RegExp(`^${date}${dateTime ? time : ""}$`).exec(text);
  if (!match) return null;
  const month = Number(match[2] ?? match[4] ?? match[6]);
  const day = Number(match[3] ?? match[5] ?? match[7]);
  const hour = Number(match[8] ?? 0);
  const minute = Number(match[9] ?? 0);
  const second = Number(match[10] ?? 0);
  const value = new Date(Date.UTC(Number(match[1]), month - 1, day, hour, minute, second));
  return value.getUTCFullYear() === Number(match[1]) &&
    value.getUTCMonth() === month - 1 &&
    value.getUTCDate() === day &&
    value.getUTCHours() === hour &&
    value.getUTCMinutes() === minute &&
    value.getUTCSeconds() === second
    ? value
    : null;
}
function dateWindow(start: string, end: string) {
  const startDate = parseDate(start, false),
    endDate = parseDate(end, false);
  if (!startDate || !endDate || startDate > endDate)
    throw validation("startDate and endDate must be valid YYYYMMDD dates.");
  return { start: startDate, end: endDate };
}
function dateString(date: Date) {
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}-${String(date.getUTCDate()).padStart(2, "0")}`;
}
function dateTimeString(date: Date) {
  return `${dateString(date)}T${String(date.getUTCHours()).padStart(2, "0")}:${String(
    date.getUTCMinutes()
  ).padStart(2, "0")}:${String(date.getUTCSeconds()).padStart(2, "0")}`;
}
function trimTail(row: string[]) {
  const next = [...row];
  while (next.length && !next[next.length - 1]?.trim()) next.pop();
  return next;
}
function isEmpty(rows: string[][]) {
  return rows.every((row) => row.every((cell) => !cell.trim()));
}
function isSummary(row: string[]) {
  return ["合计", "总计"].includes(row[0]?.trim() ?? "");
}
function validation(message: string) {
  return new Error(message);
}

interface ValidationIssueInput extends StructuredValidationIssue {
  legacyMessage: string;
}

class ValidationIssueCollector {
  readonly issues: StructuredValidationIssue[] = [];
  count = 0;
  firstLegacyMessage: string | null = null;

  add(issue: ValidationIssueInput) {
    this.count += 1;
    this.firstLegacyMessage ??= issue.legacyMessage;
    if (this.issues.length < MAX_RETAINED_VALIDATION_ERRORS) {
      this.issues.push({
        code: issue.code,
        message: issue.message,
        sheetName: issue.sheetName,
        sheetIndex: issue.sheetIndex,
        rowNumber: issue.rowNumber,
        column: issue.column
      });
    }
  }
}

function finishParse(
  input: ParseStructuredFileInput,
  sheetSummary: StructuredSheetSummary[],
  ignoredSheets: IgnoredStructuredSheet[],
  rows: StructuredImportRow[],
  issues: ValidationIssueCollector
): StructuredParseResult {
  const result: StructuredParseResult = {
    sheetSummary,
    ignoredSheets,
    rows,
    validationErrors: issues.issues,
    validationErrorCount: issues.count,
    validationErrorsTruncated: issues.count > MAX_RETAINED_VALIDATION_ERRORS
  };
  if (issues.count > 0 && input.validationMode !== "collect") {
    throw validation(issues.firstLegacyMessage ?? "Structured import validation failed.");
  }
  return result;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Structured import validation failed.";
}

function safeHeaderColumn(error: HeaderValidationError): string | null {
  return error.code === "MISSING_REQUIRED_COLUMN" ? error.column : null;
}
