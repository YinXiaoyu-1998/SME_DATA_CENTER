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

export interface StructuredIngestionLimits {
  maxStructuredImportRows: number;
  maxXlsxSheets: number;
  maxStructuredCellChars: number;
  maxXlsxUncompressedBytes: number;
  maxXlsxZipEntries: number;
  maxXlsxCompressionRatio: number;
}

export interface StructuredImportRow {
  sourceRowNumber: number;
  payload: Record<string, unknown>;
}
export interface StructuredSheetSummary {
  name: string;
  hidden: boolean;
  headerRowNumber: number;
  dataRowCount: number;
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
}

export async function parseStructuredFile(input: ParseStructuredFileInput): Promise<{
  sheetSummary: StructuredSheetSummary[];
  rows: StructuredImportRow[];
}> {
  assertFileType(input);
  const sheets =
    input.fileType === "csv"
      ? [{ name: "Sheet1", hidden: false, rows: parseCsvRows(input.content, input.limits) }]
      : await readXlsxRows(input.content, input.limits);
  const sheetSummary: StructuredSheetSummary[] = [];
  const rows: StructuredImportRow[] = [];
  const window = dateWindow(input.startDate, input.endDate);

  for (const sheet of sheets) {
    if (isEmpty(sheet.rows)) continue;
    if (sheet.hidden) throw validation(`Hidden non-empty sheet ${sheet.name} is not allowed.`);
    const candidate = findHeader(input.dataset, sheet.rows);
    if (!candidate)
      throw validation(`Sheet ${sheet.name} has no recognized ${input.dataset} header.`);
    if (!candidate.resolution.ok)
      throw validation(
        `Sheet ${sheet.name} failed header validation: ${candidate.resolution.errors.map((error: HeaderValidationError) => `${error.code}:${error.column}`).join(",")}`
      );
    const data = dataRowsFor(sheet, candidate);
    sheetSummary.push({
      name: sheet.name,
      hidden: sheet.hidden,
      headerRowNumber: candidate.index + 1,
      dataRowCount: data.length
    });
    for (const item of data) {
      const payload = payloadFor(input.dataset, candidate.resolution.fields, item.row);
      const businessDate = parseDate(String(payload.business_date ?? ""), false);
      if (
        !businessDate ||
        businessDate.getTime() < window.start.getTime() ||
        businessDate.getTime() > window.end.getTime()
      )
        throw validation(`Row ${item.sourceRowNumber} business_date is outside import window.`);
      rows.push({ sourceRowNumber: item.sourceRowNumber, payload });
      if (rows.length > input.limits.maxStructuredImportRows)
        throw validation("Structured import row limit exceeded.");
    }
  }
  if (!sheetSummary.length) throw validation("Workbook has no non-empty import sheets.");
  return { sheetSummary, rows };
}

export async function profileStructuredFile(
  input: Omit<ParseStructuredFileInput, "startDate" | "endDate">
): Promise<StructuredWorkbookProfile> {
  assertFileType(input);
  const sheets =
    input.fileType === "csv"
      ? [{ name: "Sheet1", hidden: false, rows: parseCsvRows(input.content, input.limits) }]
      : await readXlsxRows(input.content, input.limits);
  const profile: StructuredSheetProfile[] = [];
  const ignoredEmptySheets: string[] = [];
  let dataRowCount = 0;
  for (const sheet of sheets) {
    if (isEmpty(sheet.rows)) {
      ignoredEmptySheets.push(sheet.name);
      continue;
    }
    if (sheet.hidden) throw validation(`Hidden non-empty sheet ${sheet.name} is not allowed.`);
    const candidate = findHeader(input.dataset, sheet.rows);
    if (!candidate || !candidate.resolution.ok)
      throw validation(
        `VALIDATION_FAILED: ${sheet.name} has no recognized ${input.dataset} header`
      );
    const data = dataRowsFor(sheet, candidate);
    dataRowCount += data.length;
    if (dataRowCount > input.limits.maxStructuredImportRows)
      throw validation("Structured import row limit exceeded.");
    profile.push({
      name: sheet.name,
      hidden: sheet.hidden,
      headerRowNumber: candidate.index + 1,
      columnCount: candidate.width,
      dataRowCount: data.length,
      validationErrors: []
    });
  }
  const registry = getStructuredRegistry(input.dataset);
  return {
    dataset: input.dataset,
    registryVersion: registry.version,
    fileName: input.fileName,
    sheets: profile,
    ignoredEmptySheets
  };
}

function dataRowsFor(sheet: { rows: string[][] }, candidate: { index: number; width: number }) {
  const data = sheet.rows
    .slice(candidate.index + 1)
    .map((row, index) => ({ row, sourceRowNumber: candidate.index + index + 2 }))
    .filter(({ row }) => row.some((cell) => cell.trim()))
    .filter(({ row }) => !isSummary(row));
  for (const item of data) {
    if (
      item.row.length > candidate.width &&
      item.row.slice(candidate.width).some((value) => value.trim())
    )
      throw validation(`Row ${item.sourceRowNumber} has data outside the resolved header width.`);
  }
  return data;
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
  if (content.includes(0)) throw validation("CSV content must be UTF-8 text.");
  const decoded = new TextDecoder("utf-8", { fatal: true }).decode(content);
  return parseCsv(decoded, { bom: true, relax_column_count: true, skip_empty_lines: false }).map(
    (row: unknown[]) => row.map((value) => checkedCellText(String(value), limits))
  );
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
  return Object.fromEntries(
    mappings.map((mapping) => [
      mapping.canonicalName,
      parseCell(fields.get(mapping.canonicalName)!, row[mapping.sourceColumnIndex] ?? "")
    ])
  );
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
