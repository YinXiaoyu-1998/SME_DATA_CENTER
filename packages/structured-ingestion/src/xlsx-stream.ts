/* eslint-disable @typescript-eslint/no-explicit-any -- yauzl has no bundled types. */
import sax from "sax";
import { createRequire } from "node:module";
import { performance } from "node:perf_hooks";
import { PassThrough } from "node:stream";

const require = createRequire(import.meta.url);
const yauzl: any = require("yauzl");

export interface XlsxReadLimits {
  maxXlsxSheets: number;
  maxXlsxUncompressedBytes: number;
  maxXlsxZipEntries: number;
  maxXlsxCompressionRatio: number;
  maxStructuredCellChars: number;
}

export interface XlsxSheetRows {
  name: string;
  hidden: boolean;
  rows: string[][];
}

const DEFAULT_NUM_FORMATS: Record<number, string> = {
  0: "General",
  1: "0",
  2: "0.00",
  3: "#,##0",
  4: "#,##0.00",
  9: "0%",
  10: "0.00%",
  11: "0.00E+00",
  12: "# ?/?",
  13: "# ??/??",
  14: "mm-dd-yy",
  15: "d-mmm-yy",
  16: "d-mmm",
  17: "mmm-yy",
  18: "h:mm AM/PM",
  19: "h:mm:ss AM/PM",
  20: "h:mm",
  21: "h:mm:ss",
  22: 'm/d/yy "h":mm',
  37: "#,##0 ;(#,##0)",
  38: "#,##0 ;[Red](#,##0)",
  39: "#,##0.00 ;(#,##0.00)",
  40: "#,##0.00 ;[Red](#,##0.00)",
  45: "mm:ss",
  46: "[h]:mm:ss",
  47: "mmss.0",
  48: "##0.0E+0",
  49: "@"
};

function validation(message: string): Error {
  return new Error(message);
}

function checkedCellText(text: string, limits: XlsxReadLimits): string {
  if (text.length > limits.maxStructuredCellChars)
    throw validation("Structured cell length limit exceeded.");
  return text.trim();
}

/** Mirrors ExcelJS `isDateFmt`: quoted and bracketed sections are ignored first. */
function isDateFmt(fmt: string | undefined): boolean {
  if (!fmt) return false;
  const stripped = fmt.replace(/\[[^\]]*]/g, "").replace(/"[^"]*"/g, "");
  return /[ymdhMsb]+/.test(stripped);
}

/** Mirrors ExcelJS `numToDate` for the 1900 date system (no 1904 adjustment). */
function numToDate(serial: number): Date {
  return new Date(Math.round((serial - 25569) * 86400 * 1000));
}

function hasTimeComponent(value: Date, numberFormat?: string): boolean {
  return (
    value.getUTCHours() !== 0 ||
    value.getUTCMinutes() !== 0 ||
    value.getUTCSeconds() !== 0 ||
    /[hs]/i.test(numberFormat ?? "")
  );
}

function dateString(date: Date): string {
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}-${String(
    date.getUTCDate()
  ).padStart(2, "0")}`;
}

function dateTimeString(date: Date): string {
  return `${dateString(date)}T${String(date.getUTCHours()).padStart(2, "0")}:${String(
    date.getUTCMinutes()
  ).padStart(2, "0")}:${String(date.getUTCSeconds()).padStart(2, "0")}`;
}

function isUnsafeZipPath(name: string): boolean {
  return (
    name.includes("\\") ||
    name.includes("\0") ||
    name.startsWith("/") ||
    /^[a-zA-Z]:/.test(name) ||
    name.split("/").includes("..")
  );
}

function isWorksheetXmlEntry(name: string): boolean {
  return /^xl\/worksheets\/[^/]+\.xml$/i.test(name);
}

function isCriticalXlsxEntry(name: string): boolean {
  return name === "[Content_Types].xml" || name === "xl/workbook.xml" || isWorksheetXmlEntry(name);
}

function zipErrorFor(error: Error): Error {
  return /(?:absolute path|relative path|backslash)/i.test(error.message)
    ? validation("Unsafe XLSX ZIP entry path.")
    : validation("Malformed XLSX ZIP archive.");
}

/**
 * Bounded pass over the XLSX archive. Enforces ZIP-level limits from the
 * central directory for every entry (count, declared uncompressed bytes,
 * declared compression ratio, unsafe paths, duplicate critical entries,
 * required entries) and streams only the requested entries. Requested entries
 * with a stream handler are fed to the handler directly; the rest are
 * collected as buffers. Actual byte sizes and streaming ratios are verified
 * for every streamed entry.
 */
function readWantedZipEntries(
  source: Buffer | string,
  limits: XlsxReadLimits,
  wanted: Set<string>,
  streamHandlers?: Map<string, (stream: any) => Promise<void>>
): Promise<Map<string, Buffer>> {
  return new Promise((resolve, reject) => {
    const collected = new Map<string, Buffer>();
    let count = 0;
    let declaredTotal = 0;
    let actualTotal = 0;
    let settled = false;
    const names = new Set<string>();
    const critical = new Set<string>();
    let zip: any;
    const fail = (cause: unknown) => {
      if (settled) return;
      settled = true;
      try {
        zip?.close();
      } catch {
        // The archive may already be closed after a stream failure.
      }
      reject(cause instanceof Error ? cause : validation("Malformed XLSX ZIP archive."));
    };
    const succeed = () => {
      if (settled) return;
      settled = true;
      try {
        zip?.close();
      } catch {
        // noop
      }
      resolve(collected);
    };
    const readNext = () => {
      if (!settled) zip?.readEntry();
    };

    const streamEntry = (name: string, entry: any): Promise<void> => {
      const handler = streamHandlers?.get(name);
      return new Promise((resolveStream, rejectStream) => {
        zip.openReadStream(entry, (streamError: Error | null, stream: any) => {
          if (streamError || !stream) {
            rejectStream(
              streamError ? zipErrorFor(streamError) : validation("Malformed XLSX ZIP archive.")
            );
            return;
          }
          const chunks: Buffer[] = [];
          const handlerStream = handler ? new PassThrough() : undefined;
          let entryActual = 0;
          let entrySettled = false;
          const failEntry = (cause: unknown) => {
            if (entrySettled) return;
            entrySettled = true;
            try {
              stream.destroy();
            } catch {
              // noop
            }
            rejectStream(
              cause instanceof Error ? cause : validation("Malformed XLSX ZIP archive.")
            );
          };
          stream.on("data", (chunk: Buffer | Uint8Array | string) => {
            if (entrySettled) return;
            const size = typeof chunk === "string" ? Buffer.byteLength(chunk) : chunk.byteLength;
            entryActual += size;
            actualTotal += size;
            if (
              entryActual > limits.maxXlsxUncompressedBytes ||
              actualTotal > limits.maxXlsxUncompressedBytes
            ) {
              failEntry(validation("XLSX ZIP resource limit exceeded."));
              return;
            }
            if (entryActual > entry.uncompressedSize) {
              failEntry(validation("XLSX ZIP entry size mismatch."));
              return;
            }
            if (
              entryActual > 0 &&
              (entry.compressedSize === 0 ||
                entryActual / entry.compressedSize > limits.maxXlsxCompressionRatio)
            ) {
              failEntry(validation("XLSX compression ratio limit exceeded."));
            }
            if (!handler) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
          });
          stream.once("error", (streamFailure: Error) => failEntry(zipErrorFor(streamFailure)));
          handlerStream?.once("error", (streamFailure: Error) =>
            failEntry(zipErrorFor(streamFailure))
          );
          stream.once("end", () => {
            if (entrySettled) return;
            if (entryActual !== entry.uncompressedSize) {
              failEntry(validation("XLSX ZIP entry size mismatch."));
              return;
            }
            if (!handler) {
              entrySettled = true;
              collected.set(name, Buffer.concat(chunks));
              resolveStream();
            }
          });
          if (handler) {
            handler(handlerStream!).then(
              () => {
                if (entrySettled) return;
                entrySettled = true;
                resolveStream();
              },
              (cause: unknown) => failEntry(cause)
            );
            stream.pipe(handlerStream!);
          }
        });
      });
    };

    const onOpen = (error: Error | null, archive: any) => {
      if (error || !archive) {
        fail(error ? zipErrorFor(error) : validation("Malformed XLSX ZIP archive."));
        return;
      }
      zip = archive;
      zip.on("error", (zipError: Error) => fail(zipErrorFor(zipError)));
      zip.on("entry", (entry: any) => {
        void (async () => {
          try {
            count++;
            declaredTotal += entry.uncompressedSize;
            const name = String(entry.fileName);
            if (
              count > limits.maxXlsxZipEntries ||
              declaredTotal > limits.maxXlsxUncompressedBytes ||
              entry.uncompressedSize > limits.maxXlsxUncompressedBytes
            )
              throw validation("XLSX ZIP resource limit exceeded.");
            if (isUnsafeZipPath(name)) throw validation("Unsafe XLSX ZIP entry path.");
            if (names.has(name) && isCriticalXlsxEntry(name))
              throw validation("Duplicate critical XLSX ZIP entry.");
            names.add(name);
            if (isCriticalXlsxEntry(name)) critical.add(name);
            if (
              entry.uncompressedSize > 0 &&
              (entry.compressedSize === 0 ||
                entry.uncompressedSize / entry.compressedSize > limits.maxXlsxCompressionRatio)
            )
              throw validation("XLSX compression ratio limit exceeded.");
            if (wanted.has(name)) await streamEntry(name, entry);
            readNext();
          } catch (caught) {
            fail(caught);
          }
        })();
      });
      zip.on("end", () => {
        if (
          critical.has("[Content_Types].xml") &&
          critical.has("xl/workbook.xml") &&
          [...critical].some(isWorksheetXmlEntry)
        )
          succeed();
        else fail(validation("XLSX required OOXML entries are missing."));
      });
      zip.readEntry();
    };
    const options = { lazyEntries: true, validateEntrySizes: false };
    if (typeof source === "string") yauzl.open(source, options, onOpen);
    else yauzl.fromBuffer(source, options, onOpen);
  });
}

/** Runs sax synchronously over a string and preserves validation errors. */
function runSax(xml: string, configure: (parser: sax.SAXParser) => void): void {
  const parser = sax.parser(true, {
    trim: false,
    normalize: false,
    xmlns: false,
    position: false
  });
  let failure: unknown;
  configure(parser);
  parser.onerror = (error) => {
    failure = error;
  };
  try {
    parser.write(xml).close();
  } catch (caught) {
    failure = caught;
  }
  if (failure)
    throw failure instanceof Error ? failure : validation("Malformed XLSX workbook XML.");
}

interface WorkbookSheet {
  name: string;
  state: string;
  rid: string;
}

export interface XlsxWorkbookSheet {
  sheetIndex: number;
  name: string;
  hidden: boolean;
}

export interface XlsxWorkbookInspection {
  sheets: XlsxWorkbookSheet[];
  structureReadMs: number;
}

function workbookSheets(xml: Buffer): WorkbookSheet[] {
  const sheets: WorkbookSheet[] = [];
  runSax(xml.toString("utf8"), (parser) => {
    parser.onopentag = (tag) => {
      if (tag.name !== "sheet") return;
      const attributes = tag.attributes as Record<string, string>;
      sheets.push({
        name: attributes.name ?? "",
        state: attributes.state ?? "visible",
        rid: attributes["r:id"] ?? ""
      });
    };
  });
  return sheets;
}

function workbookRels(xml: Buffer): Map<string, string> {
  const rels = new Map<string, string>();
  runSax(xml.toString("utf8"), (parser) => {
    parser.onopentag = (tag) => {
      if (tag.name !== "Relationship") return;
      const attributes = tag.attributes as Record<string, string>;
      if (attributes.Id && attributes.Target) rels.set(attributes.Id, attributes.Target);
    };
  });
  return rels;
}

/**
 * Validates the complete ZIP central directory and reads only workbook metadata.
 * Partition XLSX decoding is delegated to Calamine, while this pass preserves the
 * service's existing archive limits, path checks, sheet order, and visibility contract.
 */
export async function inspectXlsxFile(
  filePath: string,
  limits: XlsxReadLimits
): Promise<XlsxWorkbookInspection> {
  const startedAt = performance.now();
  const structuralEntries = await readWantedZipEntries(
    filePath,
    limits,
    new Set(["xl/workbook.xml", "xl/_rels/workbook.xml.rels"])
  );
  const workbookXml = structuralEntries.get("xl/workbook.xml");
  const relsXml = structuralEntries.get("xl/_rels/workbook.xml.rels");
  if (!workbookXml || !relsXml) throw validation("XLSX required OOXML entries are missing.");
  const workbook = workbookSheets(workbookXml);
  if (workbook.length > limits.maxXlsxSheets) throw validation("XLSX sheet limit exceeded.");
  const rels = workbookRels(relsXml);
  for (const sheet of workbook) {
    const target = rels.get(sheet.rid);
    if (!target) throw validation("Malformed XLSX workbook XML.");
    worksheetEntryPath(target);
  }
  return {
    sheets: workbook.map((sheet, sheetIndex) => ({
      sheetIndex,
      name: sheet.name,
      hidden: sheet.state !== "visible"
    })),
    structureReadMs: performance.now() - startedAt
  };
}

function sharedStrings(xml: Buffer): string[] {
  const values: string[] = [];
  let inSi = false;
  let inT = false;
  let inPhonetic = false;
  let current = "";
  runSax(xml.toString("utf8"), (parser) => {
    parser.onopentag = (tag) => {
      if (tag.name === "si") {
        inSi = true;
        current = "";
      } else if (tag.name === "rPh") {
        inPhonetic = true;
      } else if (tag.name === "t" && inSi && !inPhonetic) {
        inT = true;
      }
    };
    parser.ontext = (text) => {
      if (inT) current += text;
    };
    parser.oncdata = (text) => {
      if (inT) current += text;
    };
    parser.onclosetag = (name) => {
      if (name === "t" && inT) inT = false;
      else if (name === "rPh") inPhonetic = false;
      else if (name === "si" && inSi) {
        inSi = false;
        values.push(current);
      }
    };
  });
  return values;
}

interface StyleTable {
  cellXfNumFmtIds: number[];
  numFmtCodes: Map<number, string>;
}

function stylesTable(xml: Buffer): StyleTable {
  const table: StyleTable = { cellXfNumFmtIds: [], numFmtCodes: new Map() };
  let inCellXfs = false;
  runSax(xml.toString("utf8"), (parser) => {
    parser.onopentag = (tag) => {
      const attributes = tag.attributes as Record<string, string>;
      if (tag.name === "numFmt") {
        table.numFmtCodes.set(Number(attributes.numFmtId), attributes.formatCode ?? "");
      } else if (tag.name === "cellXfs") {
        inCellXfs = true;
      } else if (tag.name === "xf" && inCellXfs) {
        table.cellXfNumFmtIds.push(Number(attributes.numFmtId ?? 0));
      }
    };
    parser.onclosetag = (name) => {
      if (name === "cellXfs") inCellXfs = false;
    };
  });
  return table;
}

function columnIndexFromRef(ref: string): number {
  const match = /^([A-Z]+)/.exec(ref);
  if (!match) return -1;
  const letters = match[1] ?? "";
  let index = 0;
  for (const char of letters) index = index * 26 + (char.charCodeAt(0) - 64);
  return index - 1;
}

interface MergeRange {
  startRow: number;
  startColumn: number;
  endRow: number;
  endColumn: number;
}

function parseMergeRange(ref: string): MergeRange | null {
  const match = /^([A-Z]+)(\d+)(?::([A-Z]+)(\d+))?$/.exec(ref);
  if (!match) return null;
  const startLetters = match[1] ?? "";
  const endLetters = match[3] ?? "";
  const startColumn = columnIndexFromRef(startLetters) + 1;
  const startRow = Number(match[2]);
  const endColumn = endLetters ? columnIndexFromRef(endLetters) + 1 : startColumn;
  const endRow = match[4] ? Number(match[4]) : startRow;
  if (startRow < 1 || startColumn < 1 || endRow < startRow || endColumn < startColumn) return null;
  return { startRow, startColumn, endRow, endColumn };
}

interface CellContext {
  type?: string;
  style?: number;
  formula: boolean;
  value: string;
  inlineParts: string[];
  collecting: "none" | "value" | "inline" | "inlineText";
}

interface SheetParseState {
  shared: string[];
  styles: StyleTable;
  limits: XlsxReadLimits;
  rowMap: Map<number, string[]>;
  mergeRanges: MergeRange[];
  maxRow: number;
  sequentialRow: number;
  currentRowNumber: number;
  rowCells: Map<number, string>;
  rowWidth: number;
  nextColumn: number;
  cell?: CellContext;
  onRow?: (rowNumber: number, cells: string[]) => void;
  mergeMasters: Map<MergeRange, string>;
  collectMergeRanges: boolean;
}

function createSheetState(
  shared: string[],
  styles: StyleTable,
  limits: XlsxReadLimits,
  onRow?: (rowNumber: number, cells: string[]) => void,
  mergeRanges: MergeRange[] = [],
  collectMergeRanges = true
): SheetParseState {
  return {
    shared,
    styles,
    limits,
    rowMap: new Map(),
    mergeRanges,
    maxRow: 0,
    sequentialRow: 0,
    currentRowNumber: 1,
    rowCells: new Map(),
    rowWidth: 0,
    nextColumn: 0,
    onRow,
    mergeMasters: new Map(),
    collectMergeRanges
  };
}

function numericFormat(cell: CellContext, styles: StyleTable): string | undefined {
  if (cell.style === undefined) return undefined;
  const numFmtId = styles.cellXfNumFmtIds[cell.style];
  if (numFmtId === undefined) return undefined;
  return styles.numFmtCodes.get(numFmtId) ?? DEFAULT_NUM_FORMATS[numFmtId];
}

function resolveCell(state: SheetParseState): string {
  const cell = state.cell;
  if (!cell) return "";
  const raw = cell.value;
  const type = cell.type;
  if (type === "s") {
    const index = Number(raw);
    const text = state.shared[index];
    if (text === undefined) throw validation("Malformed XLSX workbook XML.");
    return text;
  }
  if (type === "inlineStr") return cell.inlineParts.join("");
  if (type === "str") return raw;
  if (type === "b") return raw === "1" || raw.toLowerCase() === "true" ? "true" : "false";
  if (type === "e") throw validation("Unsupported XLSX cell value.");
  if (cell.formula) {
    if (raw === "") throw validation("Unevaluated XLSX formula is not supported.");
    return String(Number(raw));
  }
  if (raw === "") return "";
  const numFmt = numericFormat(cell, state.styles);
  if (numFmt !== undefined && isDateFmt(numFmt)) {
    const date = numToDate(Number(raw));
    return hasTimeComponent(date, numFmt) ? dateTimeString(date) : dateString(date);
  }
  return String(Number(raw));
}

function configureSheetParser(parser: sax.SAXParser, state: SheetParseState): void {
  parser.onopentag = (tag) => {
    const name = tag.name;
    if (name === "row") {
      const attributes = tag.attributes as Record<string, string>;
      const declared = attributes.r === undefined ? NaN : Number(attributes.r);
      state.sequentialRow += 1;
      state.currentRowNumber = Number.isFinite(declared) ? declared : state.sequentialRow;
      if (state.currentRowNumber > state.maxRow) state.maxRow = state.currentRowNumber;
      state.rowCells = new Map();
      state.rowWidth = 0;
      state.nextColumn = 0;
    } else if (name === "c") {
      const attributes = tag.attributes as Record<string, string>;
      const ref = attributes.r ?? "";
      const column = columnIndexFromRef(ref);
      if (column >= 0) state.nextColumn = column;
      state.cell = {
        type: attributes.t,
        style: attributes.s === undefined ? undefined : Number(attributes.s),
        formula: false,
        value: "",
        inlineParts: [],
        collecting: "none"
      };
    } else if (name === "mergeCell") {
      const range = parseMergeRange(String((tag.attributes as Record<string, string>).ref ?? ""));
      if (range && state.collectMergeRanges) state.mergeRanges.push(range);
    } else if (state.cell) {
      if (name === "f") {
        state.cell.formula = true;
      } else if (name === "v") {
        state.cell.collecting = "value";
      } else if (name === "is") {
        state.cell.collecting = "inline";
      } else if (name === "t" && state.cell.collecting === "inline") {
        state.cell.collecting = "inlineText";
      }
    }
  };
  parser.ontext = (text) => {
    if (!state.cell) return;
    if (state.cell.collecting === "value") state.cell.value += text;
    else if (state.cell.collecting === "inlineText") state.cell.inlineParts.push(text);
  };
  parser.oncdata = (text) => {
    if (!state.cell) return;
    if (state.cell.collecting === "value") state.cell.value += text;
    else if (state.cell.collecting === "inlineText") state.cell.inlineParts.push(text);
  };
  parser.onclosetag = (name) => {
    if (state.cell) {
      if (name === "t" && state.cell.collecting === "inlineText") {
        state.cell.collecting = "inline";
      } else if (name === "is" && state.cell.collecting === "inline") {
        state.cell.collecting = "none";
      } else if (name === "v" && state.cell.collecting === "value") {
        state.cell.collecting = "none";
      } else if (name === "c") {
        state.rowCells.set(state.nextColumn, checkedCellText(resolveCell(state), state.limits));
        if (state.nextColumn + 1 > state.rowWidth) state.rowWidth = state.nextColumn + 1;
        state.cell = undefined;
      }
    }
    if (name === "row") {
      const rendered: string[] = [];
      for (let index = 0; index < state.rowWidth; index++)
        rendered.push(state.rowCells.get(index) ?? "");
      applyKnownMerges(state, rendered);
      if (state.onRow) state.onRow(state.currentRowNumber, rendered);
      else state.rowMap.set(state.currentRowNumber, rendered);
    }
  };
}

function applyKnownMerges(state: SheetParseState, row: string[]): void {
  if (state.collectMergeRanges) return;
  for (const range of state.mergeRanges) {
    if (state.currentRowNumber < range.startRow || state.currentRowNumber > range.endRow) continue;
    if (state.currentRowNumber === range.startRow) {
      state.mergeMasters.set(range, row[range.startColumn - 1] ?? "");
    }
    const master = state.mergeMasters.get(range) ?? "";
    for (let column = range.startColumn; column <= range.endColumn; column += 1) {
      if (state.currentRowNumber === range.startRow && column === range.startColumn) continue;
      while (row.length < column) row.push("");
      row[column - 1] = master;
    }
  }
}

function finalizeSheetRows(state: SheetParseState): string[][] {
  for (const range of state.mergeRanges) {
    const master = state.rowMap.get(range.startRow)?.[range.startColumn - 1] ?? "";
    for (let rowNumber = range.startRow; rowNumber <= range.endRow; rowNumber++) {
      let row = state.rowMap.get(rowNumber);
      if (!row) {
        row = [];
        state.rowMap.set(rowNumber, row);
      }
      for (let column = range.startColumn; column <= range.endColumn; column++) {
        if (rowNumber === range.startRow && column === range.startColumn) continue;
        while (row.length < column) row.push("");
        row[column - 1] = master;
      }
      if (rowNumber > state.maxRow) state.maxRow = rowNumber;
    }
  }

  const filled: string[][] = [];
  for (let rowNumber = 1; rowNumber <= state.maxRow; rowNumber++) {
    filled.push(state.rowMap.get(rowNumber) ?? []);
  }
  return filled;
}

function parseSheetStream(
  stream: any,
  shared: string[],
  styles: StyleTable,
  limits: XlsxReadLimits
): Promise<string[][]> {
  return new Promise((resolve, reject) => {
    const state = createSheetState(shared, styles, limits);
    const parser = sax.parser(true, {
      trim: false,
      normalize: false,
      xmlns: false,
      position: false
    });
    configureSheetParser(parser, state);
    let failure: unknown;
    const decoder = new TextDecoder("utf-8");
    parser.onerror = (error) => {
      failure = error;
    };
    stream.on("data", (chunk: Buffer | Uint8Array | string) => {
      if (failure) return;
      try {
        const text = decoder.decode(Buffer.from(chunk), { stream: true });
        if (text) parser.write(text);
      } catch (caught) {
        failure = caught;
        reject(failure instanceof Error ? failure : validation("Malformed XLSX workbook XML."));
        try {
          stream.destroy();
        } catch {
          // noop
        }
      }
    });
    stream.once("error", (streamError: Error) => reject(zipErrorFor(streamError)));
    stream.once("end", () => {
      try {
        const tail = decoder.decode();
        if (tail) parser.write(tail);
        parser.close();
      } catch (caught) {
        failure = caught;
      }
      if (failure) {
        reject(failure instanceof Error ? failure : validation("Malformed XLSX workbook XML."));
        return;
      }
      resolve(finalizeSheetRows(state));
    });
  });
}

async function parseSheetStreamRows(
  stream: any,
  shared: string[],
  styles: StyleTable,
  limits: XlsxReadLimits,
  mergeRanges: MergeRange[],
  onRow: (rowNumber: number, cells: string[]) => Promise<void>
): Promise<void> {
  const pendingRows: Array<{ rowNumber: number; cells: string[] }> = [];
  const state = createSheetState(
    shared,
    styles,
    limits,
    (rowNumber, cells) => {
      pendingRows.push({ rowNumber, cells });
    },
    mergeRanges,
    false
  );
  const parser = sax.parser(true, {
    trim: false,
    normalize: false,
    xmlns: false,
    position: false
  });
  configureSheetParser(parser, state);
  let failure: unknown;
  const decoder = new TextDecoder("utf-8", { fatal: true });
  parser.onerror = (error) => {
    failure = error;
  };

  try {
    for await (const chunk of stream as AsyncIterable<Buffer | Uint8Array | string>) {
      const text = decoder.decode(Buffer.from(chunk), { stream: true });
      if (text) parser.write(text);
      if (failure) throw failure;
      for (const row of pendingRows.splice(0)) await onRow(row.rowNumber, row.cells);
    }
    const tail = decoder.decode();
    if (tail) parser.write(tail);
    parser.close();
    if (failure) throw failure;
    for (const row of pendingRows.splice(0)) await onRow(row.rowNumber, row.cells);
  } catch (error) {
    try {
      stream.destroy();
    } catch {
      // The entry may already be closed.
    }
    throw error instanceof Error ? error : validation("Malformed XLSX workbook XML.");
  }
}

async function parseMergeRangesStream(stream: any): Promise<MergeRange[]> {
  const ranges: MergeRange[] = [];
  const parser = sax.parser(true, {
    trim: false,
    normalize: false,
    xmlns: false,
    position: false
  });
  let failure: unknown;
  const decoder = new TextDecoder("utf-8", { fatal: true });
  parser.onerror = (error) => {
    failure = error;
  };
  parser.onopentag = (tag) => {
    if (tag.name !== "mergeCell") return;
    const range = parseMergeRange(String((tag.attributes as Record<string, string>).ref ?? ""));
    if (range) ranges.push(range);
  };
  for await (const chunk of stream as AsyncIterable<Buffer | Uint8Array | string>) {
    const text = decoder.decode(Buffer.from(chunk), { stream: true });
    if (text) parser.write(text);
    if (failure) throw failure;
  }
  const tail = decoder.decode();
  if (tail) parser.write(tail);
  parser.close();
  if (failure)
    throw failure instanceof Error ? failure : validation("Malformed XLSX workbook XML.");
  return ranges;
}

function worksheetEntryPath(target: string): string {
  const normalized = target.replace(/^\/+/, "");
  if (isUnsafeZipPath(normalized)) throw validation("Unsafe XLSX ZIP entry path.");
  if (normalized.startsWith("xl/")) return normalized;
  if (normalized.startsWith("worksheets/")) return `xl/${normalized}`;
  throw validation("Malformed XLSX workbook XML.");
}

export async function readXlsxRows(
  content: Buffer,
  limits: XlsxReadLimits
): Promise<XlsxSheetRows[]> {
  const structuralEntries = await readWantedZipEntries(
    content,
    limits,
    new Set([
      "xl/workbook.xml",
      "xl/_rels/workbook.xml.rels",
      "xl/sharedStrings.xml",
      "xl/styles.xml"
    ])
  );

  const workbookXml = structuralEntries.get("xl/workbook.xml");
  if (!workbookXml) throw validation("XLSX required OOXML entries are missing.");
  const workbook = workbookSheets(workbookXml);
  if (workbook.length > limits.maxXlsxSheets) throw validation("XLSX sheet limit exceeded.");

  const relsXml = structuralEntries.get("xl/_rels/workbook.xml.rels");
  if (!relsXml) throw validation("Malformed XLSX workbook XML.");
  const rels = workbookRels(relsXml);
  const sheetEntries = workbook.map((sheet) => {
    const target = rels.get(sheet.rid);
    if (!target) throw validation("Malformed XLSX workbook XML.");
    return worksheetEntryPath(target);
  });

  const shared = structuralEntries.has("xl/sharedStrings.xml")
    ? sharedStrings(structuralEntries.get("xl/sharedStrings.xml")!)
    : [];
  const styles = structuralEntries.has("xl/styles.xml")
    ? stylesTable(structuralEntries.get("xl/styles.xml")!)
    : { cellXfNumFmtIds: [], numFmtCodes: new Map<number, string>() };

  const sheetRows = new Map<string, string[][]>();
  const handlers = new Map<string, (stream: any) => Promise<void>>();
  for (const entry of sheetEntries) {
    handlers.set(entry, async (stream) => {
      sheetRows.set(entry, await parseSheetStream(stream, shared, styles, limits));
    });
  }
  await readWantedZipEntries(content, limits, new Set(sheetEntries), handlers);

  return workbook.map((sheet, index) => {
    const entry = sheetEntries[index];
    if (!entry) throw validation("Malformed XLSX workbook XML.");
    const rows = sheetRows.get(entry);
    if (!rows) throw validation("Malformed XLSX workbook XML.");
    return { name: sheet.name, hidden: sheet.state !== "visible", rows };
  });
}

export interface XlsxStreamSheet {
  sheetIndex: number;
  name: string;
  hidden: boolean;
}

export interface XlsxStreamConsumer {
  startSheet(sheet: XlsxStreamSheet): Promise<void> | void;
  row(sheet: XlsxStreamSheet, rowNumber: number, cells: string[]): Promise<void> | void;
  endSheet(sheet: XlsxStreamSheet): Promise<void> | void;
}

export interface XlsxStreamOptions {
  /** Defaults to true. Disable only when the source schema declares merged cells non-semantic. */
  expandMergedCells?: boolean;
}

export interface XlsxStreamProfile {
  structureReadMs: number;
  mergeScanMs: number;
  rowDecodeMs: number;
  consumerMs: number;
}

export async function streamXlsxFileRows(
  filePath: string,
  limits: XlsxReadLimits,
  consumer: XlsxStreamConsumer,
  options: XlsxStreamOptions = {}
): Promise<XlsxStreamProfile> {
  const structureStarted = performance.now();
  const structuralEntries = await readWantedZipEntries(
    filePath,
    limits,
    new Set([
      "xl/workbook.xml",
      "xl/_rels/workbook.xml.rels",
      "xl/sharedStrings.xml",
      "xl/styles.xml"
    ])
  );
  const workbookXml = structuralEntries.get("xl/workbook.xml");
  const relsXml = structuralEntries.get("xl/_rels/workbook.xml.rels");
  if (!workbookXml || !relsXml) throw validation("XLSX required OOXML entries are missing.");
  const workbook = workbookSheets(workbookXml);
  if (workbook.length > limits.maxXlsxSheets) throw validation("XLSX sheet limit exceeded.");
  const rels = workbookRels(relsXml);
  const sheetEntries = workbook.map((sheet) => {
    const target = rels.get(sheet.rid);
    if (!target) throw validation("Malformed XLSX workbook XML.");
    return worksheetEntryPath(target);
  });
  const shared = structuralEntries.has("xl/sharedStrings.xml")
    ? sharedStrings(structuralEntries.get("xl/sharedStrings.xml")!)
    : [];
  const styles = structuralEntries.has("xl/styles.xml")
    ? stylesTable(structuralEntries.get("xl/styles.xml")!)
    : { cellXfNumFmtIds: [], numFmtCodes: new Map<number, string>() };
  const structureReadMs = performance.now() - structureStarted;

  const mergeRanges = new Map<string, MergeRange[]>();
  let mergeScanMs = 0;
  if (options.expandMergedCells !== false) {
    const mergeScanStarted = performance.now();
    const mergeHandlers = new Map<string, (stream: any) => Promise<void>>();
    for (const entry of sheetEntries) {
      mergeHandlers.set(entry, async (stream) => {
        mergeRanges.set(entry, await parseMergeRangesStream(stream));
      });
    }
    await readWantedZipEntries(filePath, limits, new Set(sheetEntries), mergeHandlers);
    mergeScanMs = performance.now() - mergeScanStarted;
  }

  const rowScanStarted = performance.now();
  let consumerMs = 0;
  let nextSheetIndex = 0;
  const handlers = new Map<string, (stream: any) => Promise<void>>();
  sheetEntries.forEach((entry, sheetIndex) => {
    handlers.set(entry, async (stream) => {
      if (sheetIndex !== nextSheetIndex)
        throw validation("XLSX worksheet entries are not in workbook order.");
      const workbookSheet = workbook[sheetIndex]!;
      const sheet = {
        sheetIndex,
        name: workbookSheet.name,
        hidden: workbookSheet.state !== "visible"
      };
      let consumerStarted = performance.now();
      await consumer.startSheet(sheet);
      consumerMs += performance.now() - consumerStarted;
      await parseSheetStreamRows(
        stream,
        shared,
        styles,
        limits,
        mergeRanges.get(entry) ?? [],
        async (rowNumber, cells) => {
          consumerStarted = performance.now();
          await consumer.row(sheet, rowNumber, cells);
          consumerMs += performance.now() - consumerStarted;
        }
      );
      consumerStarted = performance.now();
      await consumer.endSheet(sheet);
      consumerMs += performance.now() - consumerStarted;
      nextSheetIndex += 1;
    });
  });
  await readWantedZipEntries(filePath, limits, new Set(sheetEntries), handlers);
  if (nextSheetIndex !== workbook.length)
    throw validation("XLSX required worksheet entries are missing.");
  const rowScanMs = performance.now() - rowScanStarted;
  return {
    structureReadMs,
    mergeScanMs,
    rowDecodeMs: Math.max(0, rowScanMs - consumerMs),
    consumerMs
  };
}
