import { describe, expect, test } from "vitest";
import { readFile } from "node:fs/promises";
import path from "node:path";
import ExcelJS from "exceljs";
import JSZip from "jszip";
import { getStructuredRegistry, PHASE3_RUNTIME_LIMIT_DEFAULTS } from "@enterprise-hub/domain";
import {
  parseStructuredFile,
  preflightStructuredFile,
  profileStructuredFile,
  type StructuredIngestionLimits
} from "./index.js";

const limits: StructuredIngestionLimits = {
  maxStructuredImportRows: 10,
  maxXlsxSheets: 3,
  maxStructuredCellChars: 100,
  maxXlsxUncompressedBytes: 1_000_000,
  maxXlsxZipEntries: 100,
  maxXlsxCompressionRatio: 100
};

describe("structured ingestion", () => {
  test("rejects a hidden non-empty XLSX worksheet during profiling", async () => {
    const workbook = new ExcelJS.Workbook();
    workbook.addWorksheet("Visible");
    workbook
      .addWorksheet("HiddenData", { state: "hidden" })
      .addRows([dishesHeaders(), dishesRow()]);

    await expect(
      profileStructuredFile({
        dataset: "dishes",
        fileName: "hidden.xlsx",
        fileType: "xlsx",
        content: Buffer.from(await workbook.xlsx.writeBuffer()),
        limits
      })
    ).rejects.toThrow("Hidden non-empty sheet HiddenData is not allowed");
  });

  test("extracts formula results, rich text, hyperlinks, dates, and scalar XLSX cells deliberately", async () => {
    const workbook = new ExcelJS.Workbook();
    const headers = dishesHeaders();
    const row = dishesRow();
    row[headers.indexOf("菜品名称")] = {
      richText: [{ text: "Rich " }, { text: "product" }]
    } as unknown as string;
    row[headers.indexOf("门店")] = {
      text: "Linked Store",
      hyperlink: "https://example.test/store"
    } as unknown as string;
    row[headers.indexOf("营业日")] = new Date(Date.UTC(2026, 6, 1)) as unknown as string;
    row[headers.indexOf("下单时间")] = new Date(
      Date.UTC(2026, 6, 1, 12, 30, 45)
    ) as unknown as string;
    row[headers.indexOf("菜品销售数量")] = {
      formula: "1+2",
      result: 3
    } as unknown as string;
    const sheet = workbook.addWorksheet("Data");
    sheet.addRows([headers, row]);
    sheet.getRow(2).getCell(headers.indexOf("下单时间") + 1).numFmt = "yyyy-mm-dd hh:mm:ss";

    const result = await parseStructuredFile({
      dataset: "dishes",
      fileName: "typed-cells.xlsx",
      fileType: "xlsx",
      content: Buffer.from(await workbook.xlsx.writeBuffer()),
      startDate: "20260701",
      endDate: "20260701",
      limits: PHASE3_RUNTIME_LIMIT_DEFAULTS
    });

    expect(result.rows[0]?.payload).toMatchObject({
      product_name: "Rich product",
      store_name: "Linked Store",
      business_date: "2026-07-01",
      order_time: "2026-07-01T12:30:45",
      dish_sales_quantity: 3
    });
    expect(JSON.stringify(result.rows)).not.toContain("[object Object]");
  });

  test("rejects an XLSX formula without a cached result even in a nullable field", async () => {
    const row = dishesRow();
    row[dishesHeaders().indexOf("菜品名称")] = { formula: "1+1" } as unknown as string;

    await expect(
      parseStructuredFile({
        dataset: "dishes",
        fileName: "unevaluated-formula.xlsx",
        fileType: "xlsx",
        content: await dishesXlsx(dishesHeaders(), [row]),
        startDate: "20260701",
        endDate: "20260701",
        limits
      })
    ).rejects.toThrow("Unevaluated XLSX formula is not supported");
  });

  test("maps reordered canonical and alias CSV headers to their unique sentinel values", async () => {
    const headers = dishesHeaders();
    const productIndex = headers.indexOf("菜品名称");
    const storeIndex = headers.indexOf("门店");
    const dateIndex = headers.indexOf("营业日");
    [headers[productIndex], headers[dateIndex]] = [headers[dateIndex]!, headers[productIndex]!];
    headers[storeIndex] = "门店名称";
    headers[productIndex] = "营业日期";
    const row = dishesRow();
    row[productIndex] = "2026-07-01";
    row[dateIndex] = "Sentinel product";
    row[storeIndex] = "Sentinel store";

    const result = await parseStructuredFile({
      dataset: "dishes",
      fileName: "aliases.csv",
      fileType: "csv",
      content: Buffer.from(`\uFEFF${headers.join(",")}\r\n${row.join(",")}\r\n`, "utf8"),
      startDate: "20260701",
      endDate: "20260701",
      limits: PHASE3_RUNTIME_LIMIT_DEFAULTS
    });

    expect(result.rows[0]?.payload).toMatchObject({
      business_date: "2026-07-01",
      product_name: "Sentinel product",
      store_name: "Sentinel store"
    });
  });

  test("requires a time component for date_time scalar cells", async () => {
    await expect(parseDishesCsv({ order_time: "2026-07-01" })).rejects.toThrow(
      "order_time must be a date"
    );
  });

  test("preserves valid date_time scalar time components", async () => {
    const result = await parseDishesCsv({ order_time: "2026-07-01 12:30:45" });
    expect(result.rows[0]?.payload.order_time).toBe("2026-07-01T12:30:45");
  });

  test("preserves bare and suffixed percent scalar values with the same meaning", async () => {
    const [bare, suffixed] = await Promise.all([
      parseDishesCsv({ dishes_043_field: "12.5" }),
      parseDishesCsv({ dishes_043_field: "12.5%" })
    ]);

    expect(bare.rows[0]?.payload.dishes_043_field).toBe(12.5);
    expect(suffixed.rows[0]?.payload.dishes_043_field).toBe(12.5);
  });

  test("rejects empty required scalar cells before date-window evaluation", async () => {
    await expect(parseDishesCsv({ business_date: "" })).rejects.toThrow(
      "business_date is required"
    );
  });

  test("enforces the structured cell-length limit for CSV data cells", async () => {
    await expect(parseDishesCsv({ product_name: "x".repeat(101) })).rejects.toThrow(
      "Structured cell length limit exceeded"
    );
    const row = dishesRow();
    row[dishesHeaders().indexOf("菜品名称")] = "x".repeat(101);
    await expect(
      profileStructuredFile({
        dataset: "dishes",
        fileName: "long-data.csv",
        fileType: "csv",
        content: Buffer.from(validDishesCsvRows([row]), "utf8"),
        limits
      })
    ).rejects.toThrow("Structured cell length limit exceeded");
  });

  test("enforces the structured cell-length limit for CSV headers during profiling", async () => {
    await expect(
      profileStructuredFile({
        dataset: "dishes",
        fileName: "long-header.csv",
        fileType: "csv",
        content: Buffer.from(`${"h".repeat(101)}\nvalue\n`, "utf8"),
        limits
      })
    ).rejects.toThrow("Structured cell length limit exceeded");
  });

  test("enforces the import row limit when profiling a CSV", async () => {
    const csv = validDishesCsvRows([dishesRow(), dishesRow()]);
    await expect(
      profileStructuredFile({
        dataset: "dishes",
        fileName: "too-many-rows.csv",
        fileType: "csv",
        content: Buffer.from(csv, "utf8"),
        limits: limitsFor({ maxStructuredImportRows: 1 })
      })
    ).rejects.toThrow("Structured import row limit exceeded");
  });

  test("enforces the import row limit when profiling an XLSX", async () => {
    await expect(
      profileStructuredFile({
        dataset: "dishes",
        fileName: "too-many-rows.xlsx",
        fileType: "xlsx",
        content: await dishesXlsx(dishesHeaders(), [dishesRow(), dishesRow()]),
        limits: limitsFor({ maxStructuredImportRows: 1 })
      })
    ).rejects.toThrow("Structured import row limit exceeded");
  });

  test("enforces the import row limit across profiled XLSX sheets", async () => {
    const workbook = new ExcelJS.Workbook();
    workbook.addWorksheet("First").addRows([dishesHeaders(), dishesRow()]);
    workbook.addWorksheet("Second").addRows([dishesHeaders(), dishesRow()]);

    await expect(
      profileStructuredFile({
        dataset: "dishes",
        fileName: "cross-sheet-rows.xlsx",
        fileType: "xlsx",
        content: Buffer.from(await workbook.xlsx.writeBuffer()),
        limits: limitsFor({ maxStructuredImportRows: 1 })
      })
    ).rejects.toThrow("Structured import row limit exceeded");
  });

  test("enforces resolved header width during CSV and XLSX profiling while allowing empty tails", async () => {
    const extraData = [...dishesRow(), "unexpected"];
    const emptyTail = [...dishesRow(), "", ""];

    await expect(
      profileStructuredFile({
        dataset: "dishes",
        fileName: "extra-data.csv",
        fileType: "csv",
        content: Buffer.from(validDishesCsvRows([extraData]), "utf8"),
        limits
      })
    ).rejects.toThrow("data outside the resolved header width");
    await expect(
      profileStructuredFile({
        dataset: "dishes",
        fileName: "extra-data.xlsx",
        fileType: "xlsx",
        content: await dishesXlsx(dishesHeaders(), [extraData]),
        limits
      })
    ).rejects.toThrow("data outside the resolved header width");
    await expect(
      profileStructuredFile({
        dataset: "dishes",
        fileName: "empty-tail.csv",
        fileType: "csv",
        content: Buffer.from(validDishesCsvRows([emptyTail]), "utf8"),
        limits
      })
    ).resolves.toMatchObject({ sheets: [expect.objectContaining({ dataRowCount: 1 })] });
  });

  test.each([
    ["integer suffix", { dishes_049_served: "12abc" }, "must be an integer"],
    ["integer exponent", { dishes_049_served: "1e3" }, "must be an integer"],
    ["decimal suffix", { dish_sales_quantity: "12abc" }, "must be numeric"],
    ["malformed decimal", { dish_sales_quantity: "1." }, "must be numeric"],
    ["non-finite number", { dish_sales_quantity: "Infinity" }, "must be numeric"],
    ["non-finite NaN", { dish_sales_quantity: "NaN" }, "must be numeric"],
    ["malformed percent", { dishes_043_field: "10%%" }, "must be numeric"],
    ["percent suffix junk", { dishes_043_field: "12.5%junk" }, "must be numeric"],
    ["malformed percent decimal", { dishes_043_field: "12.%" }, "must be numeric"],
    ["date suffix", { business_date: "2026-07-01T00:00:00" }, "must be a date"],
    ["impossible date", { business_date: "2026-02-30" }, "must be a date"],
    ["mixed date separators", { business_date: "2026-07/01" }, "must be a date"],
    ["date_time suffix", { order_time: "2026-07-01 12:30:00Z" }, "must be a date"],
    ["impossible date_time", { order_time: "2026-02-30 12:30:00" }, "must be a date"]
  ])("rejects strict scalar parse case: %s", async (_name, overrides, error) => {
    await expect(parseDishesCsv(overrides)).rejects.toThrow(error);
  });

  test.each([
    ["unknown", [...dishesHeaders(), "未知列"], "UNKNOWN_COLUMN:未知列"],
    ["missing", dishesHeaders().slice(1), "MISSING_REQUIRED_COLUMN:下单时间"],
    [
      "canonical duplicate through an alias",
      [...dishesHeaders(), "门店名称"],
      "DUPLICATE_COLUMN:门店名称"
    ]
  ])("rejects %s CSV header validation errors", async (_name, headers, error) => {
    await expect(
      parseStructuredFile({
        dataset: "dishes",
        fileName: "invalid-headers.csv",
        fileType: "csv",
        content: Buffer.from(`${headers.join(",")}\n${dishesRow().join(",")}\n`, "utf8"),
        startDate: "20260701",
        endDate: "20260701",
        limits
      })
    ).rejects.toThrow(error);
  });

  test("rejects Windows-drive ZIP paths before XLSX parsing", async () => {
    await expect(
      profileStructuredFile({
        dataset: "dishes",
        fileName: "unsafe.xlsx",
        fileType: "xlsx",
        content: await xlsxZip({ "C:/outside.xml": "not a workbook" }),
        limits
      })
    ).rejects.toThrow("Unsafe XLSX ZIP entry path");
  });

  test("does not treat a worksheet directory as a worksheet XML entry", async () => {
    await expect(
      profileStructuredFile({
        dataset: "dishes",
        fileName: "directory-only.xlsx",
        fileType: "xlsx",
        content: await xlsxZip({ "xl/worksheets/": "" }, { worksheet: false }),
        limits
      })
    ).rejects.toThrow("XLSX required OOXML entries are missing");
  });

  test("maps reordered alias XLSX headers to their unique sentinel values", async () => {
    const headers = dishesHeaders();
    const productIndex = headers.indexOf("菜品名称");
    const dateIndex = headers.indexOf("营业日");
    [headers[productIndex], headers[dateIndex]] = [headers[dateIndex]!, headers[productIndex]!];
    headers[productIndex] = "营业日期";
    const row = dishesRow();
    row[productIndex] = "2026-07-01";
    row[dateIndex] = "XLSX sentinel product";

    const result = await parseStructuredFile({
      dataset: "dishes",
      fileName: "aliases.xlsx",
      fileType: "xlsx",
      content: await dishesXlsx(headers, [row]),
      startDate: "20260701",
      endDate: "20260701",
      limits
    });

    expect(result.rows[0]?.payload).toMatchObject({
      business_date: "2026-07-01",
      product_name: "XLSX sentinel product"
    });
  });

  test("rejects hidden non-empty XLSX worksheets during parsing but allows empty hidden sheets", async () => {
    const hiddenData = new ExcelJS.Workbook();
    hiddenData.addWorksheet("Data").addRows([dishesHeaders(), dishesRow()]);
    hiddenData
      .addWorksheet("HiddenData", { state: "veryHidden" })
      .addRows([dishesHeaders(), dishesRow()]);
    const emptyHidden = new ExcelJS.Workbook();
    emptyHidden.addWorksheet("Data").addRows([dishesHeaders(), dishesRow()]);
    emptyHidden.addWorksheet("EmptyHidden", { state: "hidden" });

    await expect(
      parseStructuredFile({
        dataset: "dishes",
        fileName: "hidden-data.xlsx",
        fileType: "xlsx",
        content: Buffer.from(await hiddenData.xlsx.writeBuffer()),
        startDate: "20260701",
        endDate: "20260701",
        limits
      })
    ).rejects.toThrow("Hidden non-empty sheet HiddenData is not allowed");
    await expect(
      profileStructuredFile({
        dataset: "dishes",
        fileName: "empty-hidden.xlsx",
        fileType: "xlsx",
        content: Buffer.from(await emptyHidden.xlsx.writeBuffer()),
        limits
      })
    ).resolves.toMatchObject({ ignoredEmptySheets: ["EmptyHidden"] });
  });

  test("enforces XLSX sheet, row, cell, and extra-data-column limits", async () => {
    const twoSheets = new ExcelJS.Workbook();
    twoSheets.addWorksheet("First").addRows([dishesHeaders(), dishesRow()]);
    twoSheets.addWorksheet("Second").addRows([dishesHeaders(), dishesRow()]);
    const longCell = dishesRow();
    longCell[dishesHeaders().indexOf("菜品名称")] = "x".repeat(101);
    const extraData = [...dishesRow(), "unexpected"];

    await expect(
      profileStructuredFile({
        dataset: "dishes",
        fileName: "too-many-sheets.xlsx",
        fileType: "xlsx",
        content: Buffer.from(await twoSheets.xlsx.writeBuffer()),
        limits: limitsFor({ maxXlsxSheets: 1 })
      })
    ).rejects.toThrow("XLSX sheet limit exceeded");
    await expect(
      parseStructuredFile({
        dataset: "dishes",
        fileName: "too-many-rows.xlsx",
        fileType: "xlsx",
        content: await dishesXlsx(dishesHeaders(), [dishesRow(), dishesRow()]),
        startDate: "20260701",
        endDate: "20260701",
        limits: limitsFor({ maxStructuredImportRows: 1 })
      })
    ).rejects.toThrow("Structured import row limit exceeded");
    await expect(
      parseStructuredFile({
        dataset: "dishes",
        fileName: "long-cell.xlsx",
        fileType: "xlsx",
        content: await dishesXlsx(dishesHeaders(), [longCell]),
        startDate: "20260701",
        endDate: "20260701",
        limits
      })
    ).rejects.toThrow("Structured cell length limit exceeded");
    await expect(
      parseStructuredFile({
        dataset: "dishes",
        fileName: "extra-data.xlsx",
        fileType: "xlsx",
        content: await dishesXlsx(dishesHeaders(), [extraData]),
        startDate: "20260701",
        endDate: "20260701",
        limits
      })
    ).rejects.toThrow("data outside the resolved header width");
  });

  test.each([
    [
      "truncated ZIP",
      async () => (await xlsxZip({ note: "valid zip first" })).subarray(0, 20),
      "Malformed XLSX ZIP archive"
    ],
    [
      "parent traversal",
      async () => xlsxZip({ "../outside.xml": "x" }),
      "Unsafe XLSX ZIP entry path"
    ],
    ["absolute path", async () => xlsxZip({ "/outside.xml": "x" }), "Unsafe XLSX ZIP entry path"],
    [
      "backslash traversal",
      async () => xlsxZip({ "..\\outside.xml": "x" }),
      "Unsafe XLSX ZIP entry path"
    ],
    [
      "Windows drive path",
      async () => xlsxZip({ "C:/outside.xml": "x" }),
      "Unsafe XLSX ZIP entry path"
    ]
  ])("rejects XLSX %s", async (_name, content, error) => {
    await expect(
      profileStructuredFile({
        dataset: "dishes",
        fileName: "unsafe.xlsx",
        fileType: "xlsx",
        content: await content(),
        limits
      })
    ).rejects.toThrow(error);
  });

  test("enforces ZIP entry-count, total/single-entry size, and compression-ratio limits", async () => {
    await expect(
      profileStructuredFile({
        dataset: "dishes",
        fileName: "entries.xlsx",
        fileType: "xlsx",
        content: await xlsxZip({ note: "one extra entry" }),
        limits: limitsFor({ maxXlsxZipEntries: 1 })
      })
    ).rejects.toThrow("XLSX ZIP resource limit exceeded");
    await expect(
      profileStructuredFile({
        dataset: "dishes",
        fileName: "single-entry.xlsx",
        fileType: "xlsx",
        content: await xlsxZip({ "xl/sharedStrings.xml": "x".repeat(101) }),
        limits: limitsFor({ maxXlsxUncompressedBytes: 100 })
      })
    ).rejects.toThrow("XLSX ZIP resource limit exceeded");
    await expect(
      profileStructuredFile({
        dataset: "dishes",
        fileName: "ratio.xlsx",
        fileType: "xlsx",
        content: await xlsxZip({ "xl/sharedStrings.xml": "x".repeat(5_000) }, {}, "DEFLATE"),
        limits: limitsFor({ maxXlsxCompressionRatio: 2 })
      })
    ).rejects.toThrow("XLSX compression ratio limit exceeded");
  });

  test("rejects forged XLSX central-directory sizes during bounded preflight streaming", async () => {
    const forged = forgeCentralDirectoryUncompressedSizes(
      await xlsxZip({ "xl/sharedStrings.xml": "x".repeat(50_000) }, {}, "DEFLATE"),
      10,
      "xl/sharedStrings.xml"
    );

    await expect(
      profileStructuredFile({
        dataset: "dishes",
        fileName: "forged-size.xlsx",
        fileType: "xlsx",
        content: forged,
        limits: limitsFor({
          maxStructuredCellChars: 100_000,
          maxXlsxUncompressedBytes: 100_000,
          maxXlsxCompressionRatio: 1_000
        })
      })
    ).rejects.toThrow("XLSX ZIP entry size mismatch");
    await expect(
      profileStructuredFile({
        dataset: "dishes",
        fileName: "forged-size-limit.xlsx",
        fileType: "xlsx",
        content: forged,
        limits: limitsFor({
          maxStructuredCellChars: 100_000,
          maxXlsxUncompressedBytes: 8_000,
          maxXlsxCompressionRatio: 1_000
        })
      })
    ).rejects.toThrow("XLSX ZIP resource limit exceeded");
  });

  test("accepts a valid XLSX through streamed ZIP preflight", async () => {
    await expect(
      profileStructuredFile({
        dataset: "dishes",
        fileName: "valid-preflight.xlsx",
        fileType: "xlsx",
        content: await dishesXlsx(dishesHeaders(), [dishesRow()]),
        limits
      })
    ).resolves.toMatchObject({ sheets: [expect.objectContaining({ dataRowCount: 1 })] });
  });

  test("rejects missing and duplicate critical OOXML entries", async () => {
    const missingContentTypes = storedZip([
      ["xl/workbook.xml", "workbook"],
      ["xl/worksheets/sheet1.xml", "worksheet"]
    ]);
    const missingWorkbook = storedZip([
      ["[Content_Types].xml", "content types"],
      ["xl/worksheets/sheet1.xml", "worksheet"]
    ]);
    const duplicateWorkbook = storedZip([
      ["[Content_Types].xml", "content types"],
      ["xl/workbook.xml", "first"],
      ["xl/workbook.xml", "second"],
      ["xl/worksheets/sheet1.xml", "worksheet"]
    ]);
    const duplicateWorksheet = storedZip([
      ["[Content_Types].xml", "content types"],
      ["xl/workbook.xml", "workbook"],
      ["xl/worksheets/sheet1.xml", "first"],
      ["xl/worksheets/sheet1.xml", "second"]
    ]);

    for (const [content, error] of [
      [missingContentTypes, "XLSX required OOXML entries are missing"],
      [missingWorkbook, "XLSX required OOXML entries are missing"],
      [duplicateWorkbook, "Duplicate critical XLSX ZIP entry"],
      [duplicateWorksheet, "Duplicate critical XLSX ZIP entry"]
    ] as const) {
      await expect(
        profileStructuredFile({
          dataset: "dishes",
          fileName: "critical.xlsx",
          fileType: "xlsx",
          content,
          limits
        })
      ).rejects.toThrow(error);
    }
  });

  test.each([
    ["dishes", "maijia_dishes_20260706_20260712_first1000.xlsx"],
    ["business", "maijia_business_20260706_20260712_first1000.xlsx"]
  ] as const)("profiles and imports the real Maijia %s fixture", async (dataset, fileName) => {
    const content = await readFile(path.join(process.cwd(), "fixtures", "structured", fileName));
    const profile = await profileStructuredFile({
      dataset,
      fileName,
      fileType: "xlsx",
      content,
      limits: PHASE3_RUNTIME_LIMIT_DEFAULTS
    });
    const imported = await parseStructuredFile({
      dataset,
      fileName,
      fileType: "xlsx",
      content,
      startDate: "20260706",
      endDate: "20260712",
      limits: PHASE3_RUNTIME_LIMIT_DEFAULTS
    });

    expect(profile.sheets).toEqual([expect.objectContaining({ dataRowCount: 997 })]);
    expect(imported.rows).toHaveLength(997);
    if (dataset === "dishes") {
      expect(imported.rows[0]?.payload.dishes_050_dish_gross_margin_rate).toBe(1);
    }
    if (dataset === "business") {
      expect(imported.rows[0]?.payload).toMatchObject({
        business_date: "2026-07-06",
        gross_sales_amount: 67.8,
        discount_rate: 0.1622
      });
    }
  });

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

  test("collects safe validation issues without retaining raw cell values after the first 100", async () => {
    const headers = dishesHeaders();
    const quantityColumn = headers.indexOf("菜品销售数量");
    const rows = Array.from({ length: 101 }, (_, index) => {
      const row = dishesRow();
      row[quantityColumn] = `secret-cell-value-${index + 1}`;
      return row;
    });

    const result = await parseStructuredFile({
      dataset: "dishes",
      fileName: "invalid-values.csv",
      fileType: "csv",
      content: Buffer.from(validDishesCsvRows(rows), "utf8"),
      startDate: "20260701",
      endDate: "20260701",
      limits: limitsFor({ maxStructuredImportRows: 200 }),
      validationMode: "collect"
    });

    expect(result.rows).toEqual([]);
    expect(result.validationErrorCount).toBe(101);
    expect(result.validationErrorsTruncated).toBe(true);
    expect(result.validationErrors).toHaveLength(100);
    expect(result.validationErrors[0]).toEqual({
      code: "INVALID_FIELD_VALUE",
      message: "Field value is invalid.",
      sheetName: "Sheet1",
      sheetIndex: 0,
      rowNumber: 2,
      column: "dish_sales_quantity"
    });
    expect(JSON.stringify(result.validationErrors)).not.toContain("secret-cell-value");
  });

  test("preserves source worksheet lineage for XLSX rows and the stable CSV default sheet", async () => {
    const workbook = new ExcelJS.Workbook();
    workbook.addWorksheet("First").addRows([dishesHeaders(), dishesRow()]);
    workbook.addWorksheet("Second").addRows([dishesHeaders(), dishesRow()]);

    const xlsx = await parseStructuredFile({
      dataset: "dishes",
      fileName: "lineage.xlsx",
      fileType: "xlsx",
      content: Buffer.from(await workbook.xlsx.writeBuffer()),
      startDate: "20260701",
      endDate: "20260701",
      limits
    });
    const csv = await parseDishesCsv({});

    expect(
      xlsx.rows.map(({ sourceSheetIndex, sourceSheetName, sourceRowNumber }) => ({
        sourceSheetIndex,
        sourceSheetName,
        sourceRowNumber
      }))
    ).toEqual([
      { sourceSheetIndex: 0, sourceSheetName: "First", sourceRowNumber: 2 },
      { sourceSheetIndex: 1, sourceSheetName: "Second", sourceRowNumber: 2 }
    ]);
    expect(csv.rows[0]).toMatchObject({
      sourceSheetIndex: 0,
      sourceSheetName: "Sheet1",
      sourceRowNumber: 2
    });
  });

  test("imports a catalog CSV snapshot with a zero sale price", async () => {
    const result = await parseStructuredFile({
      dataset: "dish_catalog",
      fileName: "catalog.csv",
      fileType: "csv",
      content: Buffer.from(
        `${catalogHeaders().join(",")}\n${catalogRow({ sale_price: "0" }).join(",")}\n`,
        "utf8"
      ),
      startDate: "20260819",
      endDate: "20260819",
      limits
    });

    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]?.payload).toMatchObject({
      snapshot_date: "2026-08-19",
      sku_id: "sku-001",
      sale_price: 0
    });
  });

  test("rejects duplicate catalog sku_ids across a CSV snapshot", async () => {
    const result = await parseStructuredFile({
      dataset: "dish_catalog",
      fileName: "duplicate-catalog.csv",
      fileType: "csv",
      content: Buffer.from(
        `${catalogHeaders().join(",")}\n${catalogRow().join(",")}\n${catalogRow({ dish_name: "Duplicate SKU" }).join(",")}\n`,
        "utf8"
      ),
      startDate: "20260819",
      endDate: "20260819",
      limits,
      validationMode: "collect"
    });

    expect(result.rows).toHaveLength(1);
    expect(result.validationErrors).toEqual([
      expect.objectContaining({ code: "DUPLICATE_KEY", column: "sku_id", rowNumber: 3 })
    ]);
  });

  test("rejects a header-only catalog CSV as an empty snapshot", async () => {
    const result = await parseStructuredFile({
      dataset: "dish_catalog",
      fileName: "empty-catalog.csv",
      fileType: "csv",
      content: Buffer.from(`${catalogHeaders().join(",")}\n`, "utf8"),
      startDate: "20260819",
      endDate: "20260819",
      limits,
      validationMode: "collect"
    });

    expect(result.validationErrors).toEqual([expect.objectContaining({ code: "EMPTY_SNAPSHOT" })]);
  });

  test("rejects a catalog CSV with no matching sheet schema", async () => {
    const result = await parseStructuredFile({
      dataset: "dish_catalog",
      fileName: "unmatched-catalog.csv",
      fileType: "csv",
      content: Buffer.from("unrelated column\nvalue\n", "utf8"),
      startDate: "20260819",
      endDate: "20260819",
      limits,
      validationMode: "collect"
    });

    expect(result.rows).toHaveLength(0);
    expect(result.ignoredSheets).toEqual([
      expect.objectContaining({ name: "Sheet1", reason: "SCHEMA_NOT_MATCHED" })
    ]);
    expect(result.validationErrors).toEqual([
      expect.objectContaining({ code: "NO_MATCHING_SHEET" })
    ]);
  });

  test("merges matching visible catalog worksheets and ignores nonmatching worksheets", async () => {
    const workbook = new ExcelJS.Workbook();
    workbook.addWorksheet("Catalog A").addRows([catalogHeaders(), catalogRow()]);
    workbook.addWorksheet("总部套餐").addRows([["套餐名称"], ["Ignored set"]]);
    workbook
      .addWorksheet("Catalog B")
      .addRows([catalogHeaders(), catalogRow({ sku_id: "sku-002", dish_name: "Second dish" })]);
    workbook
      .addWorksheet("Hidden notes", { state: "hidden" })
      .addRows([["Not a catalog header"], ["Ignored note"]]);

    const result = await parseStructuredFile({
      dataset: "dish_catalog",
      fileName: "catalog-workbook.xlsx",
      fileType: "xlsx",
      content: Buffer.from(await workbook.xlsx.writeBuffer()),
      startDate: "20260819",
      endDate: "20260819",
      limits: limitsFor({ maxXlsxSheets: 4 }),
      validationMode: "collect"
    });

    expect(result.validationErrorCount).toBe(0);
    expect(result.rows.map((row) => row.payload.sku_id)).toEqual(["sku-001", "sku-002"]);
    expect(result.ignoredSheets).toEqual([
      expect.objectContaining({ name: "总部套餐", reason: "SCHEMA_NOT_MATCHED" })
    ]);
  });

  test("rejects a matching hidden catalog worksheet", async () => {
    const workbook = new ExcelJS.Workbook();
    workbook
      .addWorksheet("Hidden catalog", { state: "hidden" })
      .addRows([catalogHeaders(), catalogRow()]);

    const result = await parseStructuredFile({
      dataset: "dish_catalog",
      fileName: "hidden-catalog.xlsx",
      fileType: "xlsx",
      content: Buffer.from(await workbook.xlsx.writeBuffer()),
      startDate: "20260819",
      endDate: "20260819",
      limits,
      validationMode: "collect"
    });

    expect(result.validationErrors).toEqual([expect.objectContaining({ code: "HIDDEN_SHEET" })]);
  });

  test("preflight checks only transport-safe CSV properties without parsing business rows", () => {
    expect(() =>
      preflightStructuredFile({
        fileName: "unvalidated.csv",
        fileType: "csv",
        content: Buffer.from("unrecognized header\nraw cell value\n", "utf8")
      })
    ).not.toThrow();
    expect(() =>
      preflightStructuredFile({
        fileName: "invalid.csv",
        fileType: "csv",
        content: Buffer.from([0x61, 0x00])
      })
    ).toThrow("CSV content must be UTF-8 text.");
  });
});

function dishesHeaders() {
  return getStructuredRegistry("dishes").fields.map((field) => field.sourceColumn);
}

function catalogHeaders() {
  return getStructuredRegistry("dish_catalog")
    .fields.filter((field) => field.inputSource === "file")
    .map((field) => field.sourceColumn);
}

function catalogRow(overrides: Record<string, string> = {}) {
  const values: Record<string, string> = {
    spu_id: "spu-001",
    sku_id: "sku-001",
    dish_name: "Catalog dish",
    brand_name: "Catalog brand",
    base_category_name: "Catalog category",
    level_1_category_code: "L1",
    level_2_category_code: "L2",
    specification_name: "Regular",
    sale_price: "12.5",
    dish_alias: "Catalog alias",
    ...overrides
  };
  return getStructuredRegistry("dish_catalog")
    .fields.filter((field) => field.inputSource === "file")
    .map((field) => values[field.canonicalName]!);
}

function dishesRow() {
  return getStructuredRegistry("dishes").fields.map((field, index) => {
    if (field.canonicalName === "business_date") return "2026-07-01";
    if (field.type === "integer") return String(index + 1);
    if (field.type === "decimal" || field.type === "percent") return `${index + 1}.5`;
    if (field.type === "date") return "2026-07-01";
    if (field.type === "date_time") return "2026-07-01 12:30:00";
    return `value_${index + 1}`;
  });
}

function validDishesCsvRows(rows: string[][]) {
  return `${dishesHeaders().join(",")}\n${rows.map((row) => row.join(",")).join("\n")}\n`;
}

function parseDishesCsv(overrides: Record<string, string>) {
  const headers = dishesHeaders();
  const row = dishesRow();
  for (const [canonicalName, value] of Object.entries(overrides)) {
    const sourceColumn = getStructuredRegistry("dishes").fields.find(
      (field) => field.canonicalName === canonicalName
    )?.sourceColumn;
    if (!sourceColumn) throw new Error(`Unknown dishes field ${canonicalName}`);
    row[headers.indexOf(sourceColumn)] = value;
  }
  return parseStructuredFile({
    dataset: "dishes",
    fileName: "scalars.csv",
    fileType: "csv",
    content: Buffer.from(`${headers.join(",")}\n${row.join(",")}\n`, "utf8"),
    startDate: "20260701",
    endDate: "20260701",
    limits
  });
}

function limitsFor(overrides: Partial<StructuredIngestionLimits>): StructuredIngestionLimits {
  return { ...limits, ...overrides };
}

async function dishesXlsx(headers: string[], rows: Array<Array<unknown>>) {
  const workbook = new ExcelJS.Workbook();
  workbook.addWorksheet("Data").addRows([headers, ...rows]);
  return Buffer.from(await workbook.xlsx.writeBuffer());
}

async function xlsxZip(
  entries: Record<string, string | Buffer>,
  options: { worksheet?: boolean } = {},
  compression: "STORE" | "DEFLATE" = "STORE"
) {
  const zip = new JSZip();
  zip.file("[Content_Types].xml", "content types");
  zip.file("xl/workbook.xml", "workbook");
  if (options.worksheet ?? true) zip.file("xl/worksheets/sheet1.xml", "worksheet");
  for (const [name, value] of Object.entries(entries)) zip.file(name, value);
  return Buffer.from(await zip.generateAsync({ type: "nodebuffer", compression }));
}

function storedZip(entries: Array<[string, string | Buffer]>) {
  const localEntries: Buffer[] = [];
  const centralEntries: Buffer[] = [];
  let offset = 0;

  for (const [name, value] of entries) {
    const fileName = Buffer.from(name, "utf8");
    const content = Buffer.isBuffer(value) ? value : Buffer.from(value, "utf8");
    const crc = crc32(content);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(content.length, 18);
    local.writeUInt32LE(content.length, 22);
    local.writeUInt16LE(fileName.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(content.length, 20);
    central.writeUInt32LE(content.length, 24);
    central.writeUInt16LE(fileName.length, 28);
    central.writeUInt32LE(offset, 42);
    localEntries.push(local, fileName, content);
    centralEntries.push(central, fileName);
    offset += local.length + fileName.length + content.length;
  }

  const centralDirectory = Buffer.concat(centralEntries);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralDirectory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...localEntries, centralDirectory, end]);
}

function crc32(content: Buffer) {
  let crc = 0xffffffff;
  for (const byte of content) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function forgeCentralDirectoryUncompressedSizes(content: Buffer, size: number, entryName?: string) {
  const forged = Buffer.from(content);
  for (let offset = 0; offset <= forged.length - 46;) {
    if (forged.readUInt32LE(offset) !== 0x02014b50) {
      offset++;
      continue;
    }
    const nameLength = forged.readUInt16LE(offset + 28);
    const name = forged.subarray(offset + 46, offset + 46 + nameLength).toString("utf8");
    if (!entryName || name === entryName) forged.writeUInt32LE(size, offset + 24);
    offset += 46 + nameLength + forged.readUInt16LE(offset + 30) + forged.readUInt16LE(offset + 32);
  }
  return forged;
}

describe("committed XLSX fixture pipeline", () => {
  const fixturePath = (...parts: string[]) =>
    path.join(process.cwd(), "fixtures", "structured", "xlsx", ...parts);

  test("imports typed-cells.xlsx with exact payload values", async () => {
    const result = await parseStructuredFile({
      dataset: "dishes",
      fileName: "typed-cells.xlsx",
      fileType: "xlsx",
      content: await readFile(fixturePath("typed-cells.xlsx")),
      startDate: "20260701",
      endDate: "20260701",
      limits: PHASE3_RUNTIME_LIMIT_DEFAULTS
    });

    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]?.payload).toMatchObject({
      product_name: "Rich product",
      store_name: "Linked Store",
      business_date: "2026-07-01",
      order_time: "2026-07-01T12:30:45",
      dish_sales_quantity: 3,
      is_member: "true",
      matched_product_name: "Inline product",
      order_category: "堂食",
      dishes_024_dish_sales_amount: 10.5
    });
  });

  test("imports sparse-rows.xlsx with legacy sourceRowNumber semantics", async () => {
    const result = await parseStructuredFile({
      dataset: "dishes",
      fileName: "sparse-rows.xlsx",
      fileType: "xlsx",
      content: await readFile(fixturePath("sparse-rows.xlsx")),
      startDate: "20260701",
      endDate: "20260702",
      limits: PHASE3_RUNTIME_LIMIT_DEFAULTS
    });

    expect(result.rows.map((row) => row.sourceRowNumber)).toEqual([2, 6]);
    expect(result.rows.map((row) => row.payload.product_name)).toEqual(["Alpha", "Beta"]);
  });

  test("rejects hidden-sheet.xlsx during profiling", async () => {
    await expect(
      profileStructuredFile({
        dataset: "dishes",
        fileName: "hidden-sheet.xlsx",
        fileType: "xlsx",
        content: await readFile(fixturePath("hidden-sheet.xlsx")),
        limits: PHASE3_RUNTIME_LIMIT_DEFAULTS
      })
    ).rejects.toThrow("Hidden non-empty sheet HiddenData is not allowed.");
  });

  test("rejects cross-sheet.xlsx row limit during profiling", async () => {
    await expect(
      profileStructuredFile({
        dataset: "dishes",
        fileName: "cross-sheet.xlsx",
        fileType: "xlsx",
        content: await readFile(fixturePath("cross-sheet.xlsx")),
        limits: limitsFor({ maxStructuredImportRows: 1 })
      })
    ).rejects.toThrow("Structured import row limit exceeded");
  });

  test("preserves multi-sheet order and per-sheet values", async () => {
    const result = await parseStructuredFile({
      dataset: "dishes",
      fileName: "multi-sheet-visible.xlsx",
      fileType: "xlsx",
      content: await readFile(fixturePath("multi-sheet-visible.xlsx")),
      startDate: "20260701",
      endDate: "20260702",
      limits: PHASE3_RUNTIME_LIMIT_DEFAULTS
    });

    expect(result.rows.map((row) => row.payload.product_name)).toEqual(["First", "Second"]);
  });

  test("imports the real catalog snapshot and safely reports its nonmatching sheet", async () => {
    const result = await parseStructuredFile({
      dataset: "dish_catalog",
      fileName: "maijia_dish_catalog_20260819.xlsx",
      fileType: "xlsx",
      content: await readFile(
        path.join(process.cwd(), "fixtures", "structured", "maijia_dish_catalog_20260819.xlsx")
      ),
      startDate: "20260819",
      endDate: "20260819",
      limits: PHASE3_RUNTIME_LIMIT_DEFAULTS,
      validationMode: "collect"
    });

    expect(result.validationErrorCount).toBe(0);
    expect(result.rows).toHaveLength(1123);
    expect(result.ignoredSheets).toEqual([
      expect.objectContaining({ name: "总部套餐", reason: "SCHEMA_NOT_MATCHED" })
    ]);
    expect(result.rows[0]?.payload.snapshot_date).toBe("2026-08-19");
  });
});
