import { read, utils } from "xlsx";
import {
  getStructuredRegistry,
  validateStructuredHeaders,
  type HeaderValidationError,
  type StructuredDatasetName
} from "@enterprise-hub/domain";

const MAX_HEADER_SCAN_ROWS = 10;

export interface ProfileStructuredWorkbookInput {
  dataset: StructuredDatasetName;
  fileName: string;
  content: Buffer;
}

export interface StructuredSheetProfile {
  name: string;
  hidden: boolean;
  headerRowNumber: number;
  columnCount: number;
  dataRowCount: number;
  validationErrors: HeaderValidationError[];
}

export interface StructuredWorkbookProfile {
  dataset: StructuredDatasetName;
  registryVersion: string;
  fileName: string;
  sheets: StructuredSheetProfile[];
  ignoredEmptySheets: string[];
}

export function profileStructuredWorkbook(
  input: ProfileStructuredWorkbookInput
): StructuredWorkbookProfile {
  const registry = getStructuredRegistry(input.dataset);
  const workbook = read(input.content, { type: "buffer", cellDates: false, raw: false });
  const ignoredEmptySheets: string[] = [];
  const sheets: StructuredSheetProfile[] = [];

  for (const sheetName of workbook.SheetNames) {
    const worksheet = workbook.Sheets[sheetName];
    if (!worksheet) {
      continue;
    }

    const rows = utils.sheet_to_json<string[]>(worksheet, {
      header: 1,
      blankrows: false,
      defval: ""
    });
    const normalizedRows = rows.map((row) => row.map((cell) => String(cell).trim()));

    if (isEmptySheet(normalizedRows)) {
      ignoredEmptySheets.push(sheetName);
      continue;
    }

    const candidate = findHeaderCandidate(input.dataset, normalizedRows);

    if (!candidate) {
      throw new Error(`VALIDATION_FAILED: ${sheetName} has no recognized ${input.dataset} header`);
    }

    if (!candidate.validation.ok) {
      throw new Error(
        `VALIDATION_FAILED: ${sheetName} ${candidate.validation.errors
          .map((error) => `${error.code}:${error.column}`)
          .join(",")}`
      );
    }

    sheets.push({
      name: sheetName,
      hidden: isSheetHidden(workbook, sheetName),
      headerRowNumber: candidate.headerRowNumber,
      columnCount: candidate.headers.length,
      dataRowCount: countDataRows(normalizedRows.slice(candidate.headerRowNumber)),
      validationErrors: []
    });
  }

  return {
    dataset: input.dataset,
    registryVersion: registry.version,
    fileName: input.fileName,
    sheets,
    ignoredEmptySheets
  };
}

function findHeaderCandidate(dataset: StructuredDatasetName, rows: string[][]) {
  const registry = getStructuredRegistry(dataset);
  const expectedColumns = registry.fields.length;
  let best: {
    headerRowNumber: number;
    headers: string[];
    validation: ReturnType<typeof validateStructuredHeaders>;
    matchedCount: number;
  } | null = null;

  for (const [index, row] of rows.slice(0, MAX_HEADER_SCAN_ROWS).entries()) {
    const headers = trimTrailingEmptyCells(row);
    const validation = validateStructuredHeaders(dataset, headers);
    const matchedCount =
      validation.ok && headers.length === expectedColumns
        ? expectedColumns
        : countExactHeaderMatches(dataset, headers);

    if (!best || matchedCount > best.matchedCount) {
      best = {
        headerRowNumber: index + 1,
        headers,
        validation,
        matchedCount
      };
    }

    if (validation.ok) {
      return best;
    }
  }

  return best && best.matchedCount > 0 ? best : null;
}

function countExactHeaderMatches(dataset: StructuredDatasetName, headers: string[]): number {
  const expected = new Set(
    getStructuredRegistry(dataset).fields.map((field) => field.sourceColumn)
  );

  return headers.filter((header) => expected.has(header)).length;
}

function countDataRows(rows: string[][]): number {
  return rows.filter((row) => row.some((cell) => cell.trim().length > 0)).length;
}

function isEmptySheet(rows: string[][]): boolean {
  return rows.every((row) => row.every((cell) => cell.trim().length === 0));
}

function trimTrailingEmptyCells(row: string[]): string[] {
  const next = [...row];

  while (next.length > 0 && next[next.length - 1]?.trim() === "") {
    next.pop();
  }

  return next;
}

function isSheetHidden(workbook: ReturnType<typeof read>, sheetName: string): boolean {
  const sheetIndex = workbook.SheetNames.indexOf(sheetName);
  const sheetMetadata = workbook.Workbook?.Sheets?.[sheetIndex];

  return (sheetMetadata?.Hidden ?? 0) > 0;
}
