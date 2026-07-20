import { describe, expect, test } from "vitest";
import { getStructuredRegistry } from "@enterprise-hub/domain";
import { parseStructuredFile, type StructuredIngestionLimits } from "./index.js";

const limits: StructuredIngestionLimits = {
  maxStructuredImportRows: 10,
  maxXlsxSheets: 3,
  maxStructuredCellChars: 100,
  maxXlsxUncompressedBytes: 1_000_000,
  maxXlsxZipEntries: 100,
  maxXlsxCompressionRatio: 100
};

describe("structured ingestion", () => {
  test("maps reordered CSV headers and RFC4180 quoted fields by their resolved source index", async () => {
    const headers = getStructuredRegistry("dishes").fields.map((field) => field.sourceColumn);
    const productIndex = headers.indexOf("菜品名称");
    const dateIndex = headers.indexOf("营业日");
    [headers[productIndex], headers[dateIndex]] = [headers[dateIndex]!, headers[productIndex]!];
    const row = headers.map(() => "");
    row[productIndex] = "20260701";
    row[dateIndex] = '"A, ""special""\nmeal"';

    const result = await parseStructuredFile({
      dataset: "dishes",
      fileName: "dishes.csv",
      fileType: "csv",
      content: Buffer.from(`\uFEFF${headers.join(",")}\r\n${row.join(",")}\r\n`, "utf8"),
      startDate: "20260701",
      endDate: "20260701",
      limits
    });

    expect(result.rows).toEqual([
      expect.objectContaining({
        sourceRowNumber: 2,
        payload: expect.objectContaining({
          product_name: 'A, "special"\nmeal',
          business_date: "2026-07-01"
        })
      })
    ]);
  });

  test("rejects malformed CSV quoting and scalar suffix junk", async () => {
    const headers = getStructuredRegistry("dishes").fields.map((field) => field.sourceColumn);
    const row = headers.map(() => "");
    row[headers.indexOf("营业日")] = "20260701";
    row[headers.indexOf("菜品销售数量")] = "12abc";

    await expect(
      parseStructuredFile({
        dataset: "dishes",
        fileName: "dishes.csv",
        fileType: "csv",
        content: Buffer.from(`${headers.join(",")}\n${row.join(",")}\n`, "utf8"),
        startDate: "20260701",
        endDate: "20260701",
        limits
      })
    ).rejects.toThrow(/dish_sales_quantity/);

    await expect(
      parseStructuredFile({
        dataset: "dishes",
        fileName: "dishes.csv",
        fileType: "csv",
        content: Buffer.from(`"unclosed\n`, "utf8"),
        startDate: "20260701",
        endDate: "20260701",
        limits
      })
    ).rejects.toThrow();
  });
});
