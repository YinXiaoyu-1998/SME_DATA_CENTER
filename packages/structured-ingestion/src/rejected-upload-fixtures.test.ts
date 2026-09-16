import { describe, expect, test } from "vitest";
import { readFile } from "node:fs/promises";
import { PHASE3_RUNTIME_LIMIT_DEFAULTS } from "@smedc/domain";
import {
  parseStructuredFile,
  preflightStructuredFile,
  type StructuredIngestionLimits,
  type StructuredParseResult
} from "./index.js";

const FIXTURES_DIR = "fixtures/structured";

const limits: StructuredIngestionLimits = {
  maxStructuredImportRows: PHASE3_RUNTIME_LIMIT_DEFAULTS.maxStructuredImportRows,
  maxXlsxSheets: PHASE3_RUNTIME_LIMIT_DEFAULTS.maxXlsxSheets,
  maxStructuredCellChars: PHASE3_RUNTIME_LIMIT_DEFAULTS.maxStructuredCellChars,
  maxXlsxUncompressedBytes: PHASE3_RUNTIME_LIMIT_DEFAULTS.maxXlsxUncompressedBytes,
  maxXlsxZipEntries: PHASE3_RUNTIME_LIMIT_DEFAULTS.maxXlsxZipEntries,
  maxXlsxCompressionRatio: PHASE3_RUNTIME_LIMIT_DEFAULTS.maxXlsxCompressionRatio
};

function fileNameAndType(file: string): { fileName: string; fileType: "csv" | "xlsx" } {
  const fileName = file.split("/").at(-1)!;
  const fileType = fileName.endsWith(".csv") ? "csv" : "xlsx";
  return { fileName, fileType };
}

async function parseFixture(file: string): Promise<StructuredParseResult> {
  const { fileName, fileType } = fileNameAndType(file);
  return parseStructuredFile({
    dataset: "vip",
    fileName,
    fileType,
    content: await readFile(file),
    startDate: "20260809",
    endDate: "20260809",
    limits,
    validationMode: "collect"
  });
}

describe("rejected-upload fixtures", () => {
  test("the vip first-1000 slice is a valid typical case", async () => {
    const file = `${FIXTURES_DIR}/maijia_vip_20260809_20260809_first1000.xlsx`;
    const { fileName, fileType } = fileNameAndType(file);
    const content = await readFile(file);
    expect(() => preflightStructuredFile({ fileName, fileType, content })).not.toThrow();

    const result = await parseFixture(file);
    expect(result.validationErrorCount).toBe(0);
    expect(result.sheetSummary).toEqual([
      expect.objectContaining({ name: "会员主题", headerRowNumber: 3, dataRowCount: 997 })
    ]);
    expect(result.rows).toHaveLength(997);
    expect(result.rows[0]?.payload).toMatchObject({
      business_date: "2026-08-09",
      store_name: "麦家小馆（上海沙龙店）",
      member_card_type_name: "尊享友情卡-"
    });
  });

  const rejectedCases: Array<{
    file: string;
    preflightThrows?: boolean;
    codes: string[];
    column?: string;
    rows?: number;
  }> = [
    {
      file: `${FIXTURES_DIR}/vip-invalid-missing-column.csv`,
      codes: ["INVALID_HEADER"],
      column: "日期"
    },
    {
      file: `${FIXTURES_DIR}/vip-invalid-unknown-column.csv`,
      codes: ["INVALID_HEADER"]
    },
    {
      file: `${FIXTURES_DIR}/vip-invalid-cell-type.csv`,
      codes: ["INVALID_FIELD_VALUE"]
    },
    {
      file: `${FIXTURES_DIR}/structured-invalid-not-utf8.csv`,
      preflightThrows: true,
      codes: ["INVALID_FILE"]
    },
    {
      file: `${FIXTURES_DIR}/structured-invalid-empty.csv`,
      codes: ["NO_IMPORT_SHEETS"]
    },
    {
      file: `${FIXTURES_DIR}/xlsx/structured-invalid-not-xlsx.xlsx`,
      preflightThrows: true,
      codes: ["INVALID_FILE"]
    },
    {
      file: `${FIXTURES_DIR}/xlsx/vip-invalid-header-not-in-first10.xlsx`,
      codes: ["INVALID_HEADER"]
    },
    {
      file: `${FIXTURES_DIR}/xlsx/vip-invalid-hidden-sheet.xlsx`,
      codes: ["HIDDEN_SHEET"],
      rows: 1
    }
  ];

  test.each(rejectedCases)(
    "$file is rejected ($codes)",
    async ({ file, preflightThrows, codes, column, rows }) => {
      const { fileName, fileType } = fileNameAndType(file);
      const content = await readFile(file);

      if (preflightThrows) {
        expect(() => preflightStructuredFile({ fileName, fileType, content })).toThrow();
      } else {
        expect(() => preflightStructuredFile({ fileName, fileType, content })).not.toThrow();
      }

      const result = await parseStructuredFile({
        dataset: "vip",
        fileName,
        fileType,
        content,
        startDate: "20260809",
        endDate: "20260809",
        limits,
        validationMode: "collect"
      });

      const issueCodes = result.validationErrors.map((issue) => issue.code);
      for (const code of codes) {
        expect(issueCodes).toContain(code);
      }
      if (column) {
        expect(result.validationErrors.some((issue) => issue.column === column)).toBe(true);
      }
      expect(result.rows).toHaveLength(rows ?? 0);
      expect(result.validationErrorCount).toBeGreaterThan(0);
    }
  );
});
