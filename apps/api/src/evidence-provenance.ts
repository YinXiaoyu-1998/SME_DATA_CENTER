import type { EvidenceSourceLocation, EvidenceWarning } from "@smedc/domain";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function integer(value: unknown, min: number): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= min;
}

/** Only public location fields; never spread private chunk metadata or artifact paths. */
export function projectEvidenceSourceLocation(value: unknown): EvidenceSourceLocation | null {
  if (!isRecord(value)) return null;
  const location: EvidenceSourceLocation = {};
  for (const key of [
    "pageNumber",
    "startLine",
    "endLine",
    "blockOrdinal",
    "tableRow",
    "tableCell"
  ] as const) {
    if (integer(value[key], key === "pageNumber" ? 1 : 0)) location[key] = value[key];
  }
  if (value.method === "native" || value.method === "ocr") location.method = value.method;
  const bbox = value.bbox;
  if (isRecord(bbox)) {
    const { left, top, right, bottom } = bbox;
    if (
      [left, top, right, bottom].every(
        (v) => typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 1
      ) &&
      (left as number) <= (right as number) &&
      (top as number) <= (bottom as number)
    )
      location.bbox = {
        left: left as number,
        top: top as number,
        right: right as number,
        bottom: bottom as number
      };
  }
  return location;
}

export function projectEvidenceWarnings(value: unknown): EvidenceWarning[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    if (!isRecord(entry) || typeof entry.code !== "string" || typeof entry.message !== "string")
      return [];
    const sourceLocation = projectEvidenceSourceLocation(entry.sourceLocation);
    return [
      { code: entry.code, message: entry.message, ...(sourceLocation ? { sourceLocation } : {}) }
    ];
  });
}

export interface PdfParsingSummary {
  schemaVersion: 1;
  pageCount: number;
  pages: Array<{ pageNumber: number; outcome: "parsed" | "blank" | "image_only" | "failed" }>;
  complete: boolean;
  tableCount: number;
  pictureCount: number;
  warnings: EvidenceWarning[];
}
export function projectPdfParsingSummary(value: unknown): PdfParsingSummary | null {
  if (
    !isRecord(value) ||
    value.schemaVersion !== 1 ||
    !integer(value.pageCount, 1) ||
    !Array.isArray(value.pages) ||
    value.pages.length !== value.pageCount ||
    typeof value.complete !== "boolean" ||
    !integer(value.tableCount, 0) ||
    !integer(value.pictureCount, 0)
  )
    return null;
  const pages: PdfParsingSummary["pages"] = [];
  for (const [index, page] of value.pages.entries()) {
    if (
      !isRecord(page) ||
      page.pageNumber !== index + 1 ||
      !["parsed", "blank", "image_only", "failed"].includes(String(page.outcome))
    )
      return null;
    pages.push({
      pageNumber: index + 1,
      outcome: page.outcome as PdfParsingSummary["pages"][number]["outcome"]
    });
  }
  return {
    schemaVersion: 1,
    pageCount: value.pageCount,
    pages,
    complete: value.complete,
    tableCount: value.tableCount,
    pictureCount: value.pictureCount,
    warnings: projectEvidenceWarnings(value.warnings)
  };
}

export interface PdfTableProvenance {
  tableId: string;
  rowStart: number;
  rowEnd: number;
  rowIds: string[];
  cellOrigins: Array<{ row: number; column: number; rowSpan: number; columnSpan: number }>;
  continuation?: { rowId: string; partIndex: number; partCount: number };
}
/** The existing row-chunker shape, with an explicit public allowlist. */
export function projectPdfTableProvenance(value: unknown): PdfTableProvenance | null {
  if (
    !isRecord(value) ||
    typeof value.tableId !== "string" ||
    value.tableId.length === 0 ||
    !integer(value.rowStart, 0) ||
    !integer(value.rowEnd, 0) ||
    value.rowEnd < value.rowStart ||
    !Array.isArray(value.rowIds) ||
    !value.rowIds.every((id) => typeof id === "string" && id.length > 0) ||
    !Array.isArray(value.cellOrigins)
  )
    return null;
  const cellOrigins: PdfTableProvenance["cellOrigins"] = [];
  for (const cell of value.cellOrigins) {
    if (
      !isRecord(cell) ||
      !integer(cell.row, 0) ||
      !integer(cell.column, 0) ||
      !integer(cell.rowSpan, 1) ||
      !integer(cell.columnSpan, 1)
    )
      return null;
    cellOrigins.push({
      row: cell.row,
      column: cell.column,
      rowSpan: cell.rowSpan,
      columnSpan: cell.columnSpan
    });
  }
  const result: PdfTableProvenance = {
    tableId: value.tableId,
    rowStart: value.rowStart,
    rowEnd: value.rowEnd,
    rowIds: [...value.rowIds] as string[],
    cellOrigins
  };
  if (value.continuation !== undefined) {
    const part = value.continuation;
    if (
      !isRecord(part) ||
      typeof part.rowId !== "string" ||
      !result.rowIds.includes(part.rowId) ||
      !integer(part.partIndex, 0) ||
      !integer(part.partCount, 1) ||
      part.partIndex >= part.partCount
    )
      return null;
    result.continuation = {
      rowId: part.rowId,
      partIndex: part.partIndex,
      partCount: part.partCount
    };
  }
  return result;
}

/** Persisted exceptions are private; only exact known PDF codes have public messages. */
export function projectPdfProcessingError(code: unknown): { code: string; message: string } | null {
  const messages: Readonly<Record<string, string>> = {
    PDF_INVALID_OR_ENCRYPTED: "PDF is invalid or password protected.",
    PDF_INPUT_TOO_LARGE: "PDF input exceeds the limit.",
    PDF_OUTPUT_TOO_LARGE: "PDF output exceeds the limit.",
    PDF_PAGE_LIMIT: "PDF page count exceeds the limit.",
    PDF_PIXEL_LIMIT: "PDF rendering exceeds the limit.",
    PDF_INCOMPLETE_PARSE: "PDF conversion is incomplete.",
    PDF_TIMEOUT: "PDF conversion deadline exceeded.",
    PDF_UPLOAD_TIMEOUT: "PDF upload deadline exceeded.",
    PDF_BUSY: "Parser is busy. Retry later.",
    PDF_INVALID_RESULT: "Invalid PDF evidence result.",
    PDF_MODEL_MISSING: "Parser models unavailable.",
    PDF_MODEL_CHECKSUM_MISMATCH: "Parser models unavailable.",
    PDF_RUNTIME_VERSION_MISMATCH: "Parser runtime unavailable.",
    PDF_PARSE_FAILED: "PDF conversion failed."
  };
  return typeof code === "string" && Object.hasOwn(messages, code)
    ? { code, message: messages[code]! }
    : null;
}
