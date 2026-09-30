import {
  EVIDENCE_BLOCK_TYPES,
  EvidenceParseError,
  type EvidenceSourceLocation,
  type EvidenceWarning,
  type ParsedEvidenceBlock,
  type ParsedEvidenceDocument
} from "./evidence.js";

export type PdfSourceLocation = EvidenceSourceLocation & {
  /** Physical page number, starting at one. */
  pageNumber: number;
  /** Normalized 0..1 coordinates with a top-left origin. */
  bbox?: { left: number; top: number; right: number; bottom: number };
  method: "native" | "ocr";
};

export interface PdfTableCell {
  /** Zero-based row and column indices. */
  row: number;
  column: number;
  rowSpan: number;
  columnSpan: number;
  text: string;
}

export interface PdfTable {
  id: string;
  cells: PdfTableCell[];
  headerRows: number[];
  rowCount: number;
  columnCount: number;
}

export interface PdfPictureRef {
  id: string;
  pageNumber: number;
  bbox: NonNullable<PdfSourceLocation["bbox"]>;
  caption: string | null;
  ocrBlockIds: string[];
}

export interface PdfEvidenceResult extends ParsedEvidenceDocument {
  blocks: Array<ParsedEvidenceBlock & { sourceLocation: PdfSourceLocation }>;
  warnings: Array<EvidenceWarning & { sourceLocation?: PdfSourceLocation }>;
  schemaVersion: 1;
  sourceChecksumSha256: string;
  parserFingerprint: string;
  pageCount: number;
  pages: Array<{ pageNumber: number; outcome: "parsed" | "blank" | "image_only" | "failed" }>;
  tables: PdfTable[];
  pictures: PdfPictureRef[];
}

export interface PictureAnnotation {
  pictureId: string;
  text: string;
  modelVersion: string;
  sourceType: "generated_description";
}

/** Optional post-parse extension. The initial PDF pipeline registers no implementation. */
export interface PictureEnricher {
  enrich(
    input: { sourceChecksumSha256: string; pictures: PdfPictureRef[] },
    signal?: AbortSignal
  ): Promise<PictureAnnotation[]>;
}

/** Validate the internal, untrusted parser response, without leaking its body in errors. */
export function parsePdfEvidenceResult(value: unknown): PdfEvidenceResult {
  const result = object(value);
  keys(result, [
    "schemaVersion",
    "sourceChecksumSha256",
    "parserFingerprint",
    "pageCount",
    "pages",
    "blocks",
    "tables",
    "pictures",
    "warnings"
  ]);
  check(result.schemaVersion === 1);
  check(
    typeof result.sourceChecksumSha256 === "string" &&
      /^[a-f0-9]{64}$/.test(result.sourceChecksumSha256)
  );
  nonempty(result.parserFingerprint);
  const pageCount = integer(result.pageCount, 1);
  const pages = array(result.pages);
  check(pages.length === pageCount);
  const pageNumbers = new Set<number>();
  for (const entry of pages) {
    const page = object(entry);
    keys(page, ["pageNumber", "outcome"]);
    const number = integer(page.pageNumber, 1, pageCount);
    check(!pageNumbers.has(number));
    pageNumbers.add(number);
    check(
      typeof page.outcome === "string" &&
        ["parsed", "blank", "image_only", "failed"].includes(page.outcome)
    );
  }

  const tables = array(result.tables).map(parseTable);
  const tableMap = uniqueMap(tables, (table) => table.id);
  const blocks = array(result.blocks);
  const blockMap = new Map<string, Record<string, unknown>>();
  const referencedTables = new Set<string>();
  for (const entry of blocks) {
    const block = object(entry);
    keys(block, ["blockId", "blockType", "text", "headingPath", "sourceLocation", "metadata"]);
    const id = nonempty(block.blockId);
    check(!blockMap.has(id));
    blockMap.set(id, block);
    check(EVIDENCE_BLOCK_TYPES.some((type) => type === block.blockType));
    nonempty(block.text);
    array(block.headingPath).forEach(nonempty);
    location(block.sourceLocation, pageCount);
    const metadata = object(block.metadata);
    check(metadata.sourceType !== "generated_description");
    if (block.blockType === "table") {
      const tableId = nonempty(metadata.tableId);
      const table = tableMap.get(tableId);
      check(table !== undefined);
      const start = integer(metadata.rowStart, 0, table.rowCount - 1);
      integer(metadata.rowEnd, start, table.rowCount - 1);
      referencedTables.add(tableId);
    } else {
      check(metadata.tableId === undefined);
    }
  }
  check(referencedTables.size === tables.length);

  const pictures = array(result.pictures);
  const pictureIds = new Set<string>();
  for (const entry of pictures) {
    const picture = object(entry);
    keys(picture, ["id", "pageNumber", "bbox", "caption", "ocrBlockIds"]);
    const id = nonempty(picture.id);
    check(!pictureIds.has(id));
    pictureIds.add(id);
    integer(picture.pageNumber, 1, pageCount);
    bbox(picture.bbox);
    check(picture.caption === null || typeof picture.caption === "string");
    const linked = new Set<string>();
    for (const reference of array(picture.ocrBlockIds)) {
      const blockId = nonempty(reference);
      check(!linked.has(blockId));
      linked.add(blockId);
      const block = blockMap.get(blockId);
      check(block !== undefined);
      const source = object(block.sourceLocation);
      check(source.pageNumber === picture.pageNumber && source.method === "ocr");
    }
  }
  for (const entry of pages) {
    const page = object(entry);
    const hasText = blocks.some(
      (block) => object(object(block).sourceLocation).pageNumber === page.pageNumber
    );
    const hasPicture = pictures.some((picture) => object(picture).pageNumber === page.pageNumber);
    if (page.outcome === "parsed") check(hasText);
    if (page.outcome === "blank") check(!hasText && !hasPicture);
    if (page.outcome === "image_only") check(!hasText && hasPicture);
  }
  for (const entry of array(result.warnings)) {
    const warning = object(entry);
    keys(warning, ["code", "message", "sourceLocation"]);
    nonempty(warning.code);
    nonempty(warning.message);
    if (warning.sourceLocation !== undefined) location(warning.sourceLocation, pageCount);
  }
  // All required fields and nested relationships have been checked above.
  return value as PdfEvidenceResult;
}

function parseTable(value: unknown): PdfTable {
  const table = object(value);
  keys(table, ["id", "cells", "headerRows", "rowCount", "columnCount"]);
  nonempty(table.id);
  const rowCount = integer(table.rowCount, 1);
  const columnCount = integer(table.columnCount, 1);
  const headers = array(table.headerRows).map((row) => integer(row, 0, rowCount - 1));
  check(new Set(headers).size === headers.length);
  const cells = array(table.cells).map((entry) => {
    const cell = object(entry);
    keys(cell, ["row", "column", "rowSpan", "columnSpan", "text"]);
    const row = integer(cell.row, 0, rowCount - 1);
    const column = integer(cell.column, 0, columnCount - 1);
    integer(cell.rowSpan, 1, rowCount - row);
    integer(cell.columnSpan, 1, columnCount - column);
    check(typeof cell.text === "string");
    return cell as unknown as PdfTableCell;
  });
  check(cells.length > 0);
  for (let index = 0; index < cells.length; index++) {
    const cell = cells[index]!;
    for (let prior = 0; prior < index; prior++) {
      const other = cells[prior]!;
      const overlaps =
        cell.row < other.row + other.rowSpan &&
        other.row < cell.row + cell.rowSpan &&
        cell.column < other.column + other.columnSpan &&
        other.column < cell.column + cell.columnSpan;
      check(!overlaps);
    }
  }
  return value as PdfTable;
}

function location(value: unknown, pageCount: number) {
  const source = object(value);
  keys(source, [
    "pageNumber",
    "bbox",
    "method",
    "startLine",
    "endLine",
    "blockOrdinal",
    "tableRow",
    "tableCell"
  ]);
  integer(source.pageNumber, 1, pageCount);
  check(source.method === "native" || source.method === "ocr");
  if (source.bbox !== undefined) bbox(source.bbox);
  for (const field of ["startLine", "endLine", "blockOrdinal", "tableRow", "tableCell"]) {
    if (source[field] !== undefined) integer(source[field], 0);
  }
  if (source.startLine !== undefined && source.endLine !== undefined) {
    check(Number(source.endLine) >= Number(source.startLine));
  }
}

function bbox(value: unknown) {
  const box = object(value);
  keys(box, ["left", "top", "right", "bottom"]);
  for (const key of ["left", "top", "right", "bottom"]) {
    const coordinate = box[key];
    check(
      typeof coordinate === "number" &&
        Number.isFinite(coordinate) &&
        coordinate >= 0 &&
        coordinate <= 1
    );
  }
  check(Number(box.left) <= Number(box.right) && Number(box.top) <= Number(box.bottom));
}

function check(condition: unknown): asserts condition {
  if (!condition)
    throw new EvidenceParseError("PDF_INVALID_RESULT", "Invalid PDF evidence result.");
}
function object(value: unknown): Record<string, unknown> {
  check(value !== null && typeof value === "object" && !Array.isArray(value));
  return value as Record<string, unknown>;
}
function array(value: unknown): unknown[] {
  check(Array.isArray(value));
  return value;
}
function nonempty(value: unknown): string {
  check(typeof value === "string" && value.trim().length > 0);
  return value;
}
function integer(value: unknown, minimum: number, maximum = Number.MAX_SAFE_INTEGER): number {
  check(
    typeof value === "number" && Number.isSafeInteger(value) && value >= minimum && value <= maximum
  );
  return value;
}
function keys(value: Record<string, unknown>, allowed: string[]) {
  check(Object.keys(value).every((key) => allowed.includes(key)));
}
function uniqueMap<T>(items: T[], identifier: (item: T) => string): Map<string, T> {
  const result = new Map<string, T>();
  for (const item of items) {
    const id = identifier(item);
    check(!result.has(id));
    result.set(id, item);
  }
  return result;
}
