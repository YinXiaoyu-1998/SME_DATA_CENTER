import { streamXlsxFileRows } from "./xlsx-stream.js";

const argument = (name: string): string => {
  const index = process.argv.indexOf(name);
  const value = index < 0 ? undefined : process.argv[index + 1];
  if (!value) throw new Error(`Missing ${name}.`);
  return value;
};

const input = argument("--input");
const maxStructuredCellChars = Number(argument("--max-cell-chars"));
const maxXlsxSheets = Number(argument("--max-sheets"));
let sheetCount = 0;
let activeSheetIndex = -1;
let rows: Array<[number, string[]]> = [];

function emit(value: Record<string, unknown>): void {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

function flush(): void {
  if (rows.length === 0) return;
  emit({ type: "rows", sheetIndex: activeSheetIndex, rows });
  rows = [];
}

await streamXlsxFileRows(
  input,
  {
    maxStructuredCellChars,
    maxXlsxSheets,
    maxXlsxUncompressedBytes: 200_000_000,
    maxXlsxZipEntries: 10_000,
    maxXlsxCompressionRatio: 100
  },
  {
    startSheet(sheet) {
      activeSheetIndex = sheet.sheetIndex;
      sheetCount += 1;
      emit({
        type: "sheet",
        sheetIndex: sheet.sheetIndex,
        name: sheet.name,
        hidden: sheet.hidden
      });
    },
    row(_sheet, rowNumber, cells) {
      rows.push([rowNumber, cells]);
      if (rows.length >= 256) flush();
    },
    endSheet(sheet) {
      flush();
      emit({ type: "end_sheet", sheetIndex: sheet.sheetIndex });
      activeSheetIndex = -1;
    }
  },
  { expandMergedCells: false }
);
emit({ type: "complete", sheetCount });
