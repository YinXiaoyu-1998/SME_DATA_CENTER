import { describe, expect, test } from "vitest";
import { readFile } from "node:fs/promises";
import path from "node:path";
import ExcelJS from "exceljs";
import { readXlsxRows, type XlsxReadLimits, type XlsxSheetRows } from "./xlsx-stream.js";

const FIXTURES_DIR = path.resolve("fixtures/structured");
const GENERATED_DIR = path.join(FIXTURES_DIR, "xlsx");

const limits: XlsxReadLimits = {
  maxXlsxSheets: 20,
  maxXlsxUncompressedBytes: 209_715_200,
  maxXlsxZipEntries: 10_000,
  maxXlsxCompressionRatio: 100,
  maxStructuredCellChars: 32_767
};

/**
 * Oracle that mirrors the previous ExcelJS extraction path (readXlsx +
 * worksheetRows + cellText), including the checkedCellText trim/length step the
 * pipeline applied to every extracted cell.
 */
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
function xlsxCellValueText(value: unknown, numberFormat?: string): string {
  if (value == null) return "";
  if (value instanceof Date)
    return hasTimeComponent(value, numberFormat) ? dateTimeString(value) : dateString(value);
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean")
    return String(value);
  if (!(typeof value === "object")) throw new Error("Unsupported XLSX cell value.");
  const record = value as Record<string, unknown>;
  if ("formula" in record) {
    if (!("result" in record) || record.result == null)
      throw new Error("Unevaluated XLSX formula is not supported.");
    return xlsxCellValueText(record.result, numberFormat);
  }
  if (Array.isArray(record.richText))
    return record.richText
      .map((part) => (typeof part === "object" && part && "text" in part ? String(part.text) : ""))
      .join("");
  if (typeof record.text === "string") return record.text;
  throw new Error("Unsupported XLSX cell value.");
}
function oracleCellText(cell: ExcelJS.Cell, numberFormat?: string): string {
  return xlsxCellValueText(cell.value, numberFormat).trim();
}
async function excelJsExtraction(fileName: string, directory: string): Promise<XlsxSheetRows[]> {
  const content = await readFile(path.join(directory, fileName));
  const workbook = new ExcelJS.Workbook();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- ExcelJS load types are narrower than Node's Buffer.
  await workbook.xlsx.load(content as any);
  return workbook.worksheets.map((sheet) => {
    const rows: string[][] = [];
    for (let rowNumber = 1; rowNumber <= sheet.rowCount; rowNumber++) {
      const row = sheet.getRow(rowNumber);
      const cells: string[] = [];
      for (let columnNumber = 1; columnNumber <= row.cellCount; columnNumber++) {
        const cell = row.getCell(columnNumber);
        cells.push(oracleCellText(cell, cell.numFmt));
      }
      rows.push(cells);
    }
    return { name: sheet.name, hidden: sheet.state !== "visible", rows };
  });
}

const REJECTION_FIXTURES = ["unevaluated-formula.xlsx", "error-cell.xlsx"];
const GENERATED_FIXTURES = [
  "typed-cells.xlsx",
  "sparse-rows.xlsx",
  "hidden-sheet.xlsx",
  "cross-sheet.xlsx",
  "multi-sheet-visible.xlsx",
  "date-serials.xlsx"
];
const REAL_FIXTURES = [
  "maijia_dishes_20260706_20260712_first1000.xlsx",
  "maijia_business_20260706_20260712_first1000.xlsx"
];

describe("xlsx streaming reader", () => {
  test("committed fixture manifest is present", async () => {
    for (const file of [...GENERATED_FIXTURES, ...REJECTION_FIXTURES]) {
      await expect(readFile(path.join(GENERATED_DIR, file))).resolves.toBeInstanceOf(Buffer);
    }
  });

  test.each([
    ...GENERATED_FIXTURES.map((file) => [file, GENERATED_DIR] as const),
    ...REAL_FIXTURES.map((file) => [file, FIXTURES_DIR] as const)
  ])("extraction parity with the ExcelJS oracle: %s", async (fileName, directory) => {
    const content = await readFile(path.join(directory, fileName));
    const expected = await excelJsExtraction(fileName, directory);
    const actual = await readXlsxRows(content, limits);
    expect(actual).toEqual(expected);
  });

  test("extracts every deliberate cell type from typed-cells.xlsx", async () => {
    const content = await readFile(path.join(GENERATED_DIR, "typed-cells.xlsx"));
    const [sheet] = await readXlsxRows(content, limits);
    expect(sheet).toBeDefined();
    const row = sheet!.rows[1]!;
    expect(row[0]).toBe("2026-07-01T12:30:45"); // 下单时间 date_time serial
    expect(row[1]).toBe("Linked Store"); // 门店 shared string + hyperlink
    expect(row[9]).toBe("true"); // 是否是会员 boolean
    expect(row[10]).toBe("Rich product"); // 菜品名称 rich-text shared string
    expect(row[12]).toBe("Inline product"); // 关联菜品名称 inlineStr
    expect(row[13]).toBe("堂食"); // 订单分类 t="str"
    expect(row[14]).toBe("2026-07-01"); // 营业日 date serial
    expect(row[22]).toBe("3"); // 菜品销售数量 formula result
    expect(row[23]).toBe("10.5"); // 菜品销售额 numeric
  });

  test("rejects an unevaluated formula with the exact legacy message", async () => {
    const content = await readFile(path.join(GENERATED_DIR, "unevaluated-formula.xlsx"));
    await expect(readXlsxRows(content, limits)).rejects.toThrow(
      "Unevaluated XLSX formula is not supported"
    );
  });

  test("rejects an error cell with the exact legacy message", async () => {
    const content = await readFile(path.join(GENERATED_DIR, "error-cell.xlsx"));
    await expect(readXlsxRows(content, limits)).rejects.toThrow("Unsupported XLSX cell value.");
  });

  test("fills row gaps with empty rows like ExcelJS getRow iteration", async () => {
    const content = await readFile(path.join(GENERATED_DIR, "sparse-rows.xlsx"));
    const [sheet] = await readXlsxRows(content, limits);
    expect(sheet!.rows.map((row) => row.length)).toEqual([51, 51, 0, 0, 0, 51]);
    expect(sheet!.rows[1]![14]).toBe("2026-07-01");
    expect(sheet!.rows[5]![14]).toBe("2026-07-02");
  });

  test("reports hidden sheets and preserves sheet order", async () => {
    const hidden = await readXlsxRows(
      await readFile(path.join(GENERATED_DIR, "hidden-sheet.xlsx")),
      limits
    );
    expect(hidden.map((sheet) => sheet.hidden)).toEqual([false, true]);

    const ordered = await readXlsxRows(
      await readFile(path.join(GENERATED_DIR, "multi-sheet-visible.xlsx")),
      limits
    );
    expect(ordered.map((sheet) => sheet.name)).toEqual(["First", "Second"]);
    expect(ordered[0]!.rows[1]![10]).toBe("First");
    expect(ordered[1]!.rows[1]![10]).toBe("Second");
  });

  test("converts Excel serial dates and the 1900 boundary like ExcelJS", async () => {
    const content = await readFile(path.join(GENERATED_DIR, "date-serials.xlsx"));
    const [sheet] = await readXlsxRows(content, limits);
    expect(sheet!.rows.slice(1, 6).map((row) => row[14])).toEqual([
      "1900-02-27",
      "1900-02-28",
      "1900-03-01",
      "1900-03-02",
      "2026-07-01"
    ]);
    expect(sheet!.rows[6]![0]).toBe("2026-07-02T23:58:32");
  });

  test("enforces the XLSX sheet limit during extraction", async () => {
    const content = await readFile(path.join(GENERATED_DIR, "multi-sheet-visible.xlsx"));
    await expect(readXlsxRows(content, { ...limits, maxXlsxSheets: 1 })).rejects.toThrow(
      "XLSX sheet limit exceeded"
    );
  });

  test("enforces the structured cell-length limit during extraction", async () => {
    const content = await readFile(path.join(GENERATED_DIR, "typed-cells.xlsx"));
    await expect(readXlsxRows(content, { ...limits, maxStructuredCellChars: 1 })).rejects.toThrow(
      "Structured cell length limit exceeded"
    );
  });

  test("rejects a malformed XLSX archive", async () => {
    await expect(readXlsxRows(Buffer.from("not a zip"), limits)).rejects.toThrow(
      "Malformed XLSX ZIP archive"
    );
  });
});
