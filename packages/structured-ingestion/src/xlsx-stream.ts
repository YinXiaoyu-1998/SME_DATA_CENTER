import sax from "sax";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- yauzl has no bundled types.
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
 * Bounded pass over the XLSX archive. Enforces the same ZIP-level limits as the
 * previous preflight (entry count, declared/actual uncompressed bytes,
 * compression ratio, unsafe paths, duplicate critical entries, required
 * entries) while collecting only the requested entry buffers.
 */
function readWantedZipEntries(
  content: Buffer,
  limits: XlsxReadLimits,
  wanted: Set<string>
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

    yauzl.fromBuffer(
      content,
      { lazyEntries: true, validateEntrySizes: false },
      (error: Error | null, archive: any) => {
        if (error || !archive) {
          fail(error ? zipErrorFor(error) : validation("Malformed XLSX ZIP archive."));
          return;
        }
        zip = archive;
        zip.on("error", (zipError: Error) => fail(zipErrorFor(zipError)));
        zip.on("entry", (entry: any) => {
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

            zip.openReadStream(entry, (streamError: Error | null, stream: any) => {
              if (streamError || !stream) {
                fail(
                  streamError ? zipErrorFor(streamError) : validation("Malformed XLSX ZIP archive.")
                );
                return;
              }
              const wantedEntry = wanted.has(name);
              const chunks: Buffer[] = [];
              let entryActual = 0;
              stream.on("data", (chunk: Buffer | Uint8Array | string) => {
                if (settled) return;
                const size =
                  typeof chunk === "string" ? Buffer.byteLength(chunk) : chunk.byteLength;
                entryActual += size;
                actualTotal += size;
                if (
                  entryActual > limits.maxXlsxUncompressedBytes ||
                  actualTotal > limits.maxXlsxUncompressedBytes
                ) {
                  stream.destroy();
                  fail(validation("XLSX ZIP resource limit exceeded."));
                  return;
                }
                if (entryActual > entry.uncompressedSize) {
                  stream.destroy();
                  fail(validation("XLSX ZIP entry size mismatch."));
                  return;
                }
                if (
                  entryActual > 0 &&
                  (entry.compressedSize === 0 ||
                    entryActual / entry.compressedSize > limits.maxXlsxCompressionRatio)
                ) {
                  stream.destroy();
                  fail(validation("XLSX compression ratio limit exceeded."));
                }
                if (wantedEntry) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
              });
              stream.once("error", (streamFailure: Error) => fail(zipErrorFor(streamFailure)));
              stream.once("end", () => {
                if (settled) return;
                if (entryActual !== entry.uncompressedSize) {
                  fail(validation("XLSX ZIP entry size mismatch."));
                  return;
                }
                if (wantedEntry) collected.set(name, Buffer.concat(chunks));
                readNext();
              });
            });
          } catch (caught) {
            fail(caught);
          }
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
      }
    );
  });
}

/** Runs sax synchronously over a string and wraps any parse failure. */
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

function numericFormat(cell: CellContext, styles: StyleTable): string | undefined {
  if (cell.style === undefined) return undefined;
  const numFmtId = styles.cellXfNumFmtIds[cell.style];
  if (numFmtId === undefined) return undefined;
  return styles.numFmtCodes.get(numFmtId) ?? DEFAULT_NUM_FORMATS[numFmtId];
}

function parseSheetRows(
  xml: Buffer,
  shared: string[],
  styles: StyleTable,
  limits: XlsxReadLimits
): string[][] {
  const rowMap = new Map<number, string[]>();
  let maxRow = 0;
  let sequentialRow = 0;
  let currentRowNumber = 1;
  let rowCells = new Map<number, string>();
  let rowWidth = 0;
  let nextColumn = 0;
  let cell: CellContext | undefined;
  const mergeRanges: MergeRange[] = [];

  const resolveCell = (): string => {
    if (!cell) return "";
    const raw = cell.value;
    const type = cell.type;
    if (type === "s") {
      const index = Number(raw);
      const text = shared[index];
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
    const numFmt = numericFormat(cell, styles);
    if (numFmt !== undefined && isDateFmt(numFmt)) {
      const date = numToDate(Number(raw));
      return hasTimeComponent(date, numFmt) ? dateTimeString(date) : dateString(date);
    }
    return String(Number(raw));
  };

  runSax(xml.toString("utf8"), (parser) => {
    parser.onopentag = (tag) => {
      const name = tag.name;
      if (name === "row") {
        const attributes = tag.attributes as Record<string, string>;
        const declared = attributes.r === undefined ? NaN : Number(attributes.r);
        sequentialRow += 1;
        currentRowNumber = Number.isFinite(declared) ? declared : sequentialRow;
        if (currentRowNumber > maxRow) maxRow = currentRowNumber;
        rowCells = new Map();
        rowWidth = 0;
        nextColumn = 0;
      } else if (name === "c") {
        const attributes = tag.attributes as Record<string, string>;
        const ref = attributes.r ?? "";
        const column = columnIndexFromRef(ref);
        if (column >= 0) nextColumn = column;
        cell = {
          type: attributes.t,
          style: attributes.s === undefined ? undefined : Number(attributes.s),
          formula: false,
          value: "",
          inlineParts: [],
          collecting: "none"
        };
      } else if (name === "mergeCell") {
        const range = parseMergeRange(String((tag.attributes as Record<string, string>).ref ?? ""));
        if (range) mergeRanges.push(range);
      } else if (cell) {
        if (name === "f") {
          cell.formula = true;
        } else if (name === "v") {
          cell.collecting = "value";
        } else if (name === "is") {
          cell.collecting = "inline";
        } else if (name === "t" && cell.collecting === "inline") {
          cell.collecting = "inlineText";
        }
      }
    };
    parser.ontext = (text) => {
      if (!cell) return;
      if (cell.collecting === "value") cell.value += text;
      else if (cell.collecting === "inlineText") cell.inlineParts.push(text);
    };
    parser.oncdata = (text) => {
      if (!cell) return;
      if (cell.collecting === "value") cell.value += text;
      else if (cell.collecting === "inlineText") cell.inlineParts.push(text);
    };
    parser.onclosetag = (name) => {
      if (cell) {
        if (name === "t" && cell.collecting === "inlineText") {
          cell.collecting = "inline";
        } else if (name === "is" && cell.collecting === "inline") {
          cell.collecting = "none";
        } else if (name === "v" && cell.collecting === "value") {
          cell.collecting = "none";
        } else if (name === "c") {
          rowCells.set(nextColumn, checkedCellText(resolveCell(), limits));
          if (nextColumn + 1 > rowWidth) rowWidth = nextColumn + 1;
          cell = undefined;
        }
      }
      if (name === "row") {
        const rendered: string[] = [];
        for (let index = 0; index < rowWidth; index++) rendered.push(rowCells.get(index) ?? "");
        rowMap.set(currentRowNumber, rendered);
      }
    };
  });

  // Expand merged-cell slave positions with the master value, matching ExcelJS
  // behavior where every covered cell reports the master's text.
  for (const range of mergeRanges) {
    const master = rowMap.get(range.startRow)?.[range.startColumn - 1] ?? "";
    for (let rowNumber = range.startRow; rowNumber <= range.endRow; rowNumber++) {
      let row = rowMap.get(rowNumber);
      if (!row) {
        row = [];
        rowMap.set(rowNumber, row);
      }
      for (let column = range.startColumn; column <= range.endColumn; column++) {
        if (rowNumber === range.startRow && column === range.startColumn) continue;
        while (row.length < column) row.push("");
        row[column - 1] = master;
      }
      if (rowNumber > maxRow) maxRow = rowNumber;
    }
  }

  const filled: string[][] = [];
  for (let rowNumber = 1; rowNumber <= maxRow; rowNumber++) {
    filled.push(rowMap.get(rowNumber) ?? []);
  }
  return filled;
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

  const sheetXmls = await readWantedZipEntries(content, limits, new Set(sheetEntries));

  const shared = structuralEntries.has("xl/sharedStrings.xml")
    ? sharedStrings(structuralEntries.get("xl/sharedStrings.xml")!)
    : [];
  const styles = structuralEntries.has("xl/styles.xml")
    ? stylesTable(structuralEntries.get("xl/styles.xml")!)
    : { cellXfNumFmtIds: [], numFmtCodes: new Map<number, string>() };

  return workbook.map((sheet, index) => {
    const entry = sheetEntries[index];
    if (!entry) throw validation("Malformed XLSX workbook XML.");
    const sheetXml = sheetXmls.get(entry);
    if (!sheetXml) throw validation("Malformed XLSX workbook XML.");
    return {
      name: sheet.name,
      hidden: sheet.state !== "visible",
      rows: parseSheetRows(sheetXml, shared, styles, limits)
    };
  });
}
