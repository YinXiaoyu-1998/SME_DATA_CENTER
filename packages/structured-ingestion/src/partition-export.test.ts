import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { getStructuredRegistry, type StructuredFieldRegistryEntry } from "@smedc/domain";
import { afterEach, describe, expect, test } from "vitest";
import { parse as parseCsv } from "csv-parse/sync";
import { exportStructuredPartitions } from "./partition-export.js";

const TAKEAWAY_HEADERS =
  "门店,机构编码,订单来源,外卖订单号,收银订单号,订单状态,订单形式,退单标识,取餐号,全渠道流水号,营业日期,下单时间,接单时间,完成时间,取消时间,退单时间,配送方式,菜品总价(元),餐盒费(元),配送费(元),订单金额(元),配送费(商家收入)(元),外卖营业额(元),平台服务费(元),商家活动支出(元),其他支出(元),本单预计收入(原)(元),部分退款(元),营业优惠/支出(元),营业收入(元),顾客实付(元),餐盒费优惠(元),餐盒费收入(元)".split(
    ","
  );

const roots: string[] = [];
const calamineIntegrationTest = process.env.RUN_CALAMINE_INTEGRATION === "1" ? test : test.skip;
const limits = {
  maxSourceBytes: 10_000_000,
  maxRows: 100,
  maxPartitions: 10,
  maxCanonicalBytes: 10_000_000,
  maxOpenFiles: 32,
  maxStructuredCellChars: 10_000,
  maxXlsxSheets: 20,
  maxXlsxUncompressedBytes: 200_000_000,
  maxXlsxZipEntries: 10_000,
  maxXlsxCompressionRatio: 100
};

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

describe("exportStructuredPartitions", () => {
  test("exports all 33 takeaway source fields without deduplicating or deriving columns", async () => {
    const root = await temporaryRoot();
    const headers = TAKEAWAY_HEADERS;
    const values = [
      " 合成门店 ",
      "0001",
      "未来平台",
      "000900719925474099312345",
      "0009",
      "制作中",
      "未知形式",
      "部分退款",
      "--",
      "0000002",
      "20261027",
      "2026-10-28 00:03",
      "--",
      "",
      "--",
      "2026-10-29 01:00",
      "未来配送",
      "12.30",
      "0",
      "--",
      "-001.2300",
      "",
      "20",
      "-0.10",
      "",
      "",
      "5",
      "-2.30",
      "",
      "4.5",
      "5",
      "",
      "0"
    ];
    const sourcePath = path.join(root, "source.csv");
    await writeFile(
      sourcePath,
      [
        "平台外卖订单明细—有效订单",
        "筛选说明",
        headers.join(","),
        values.join(","),
        values.join(",")
      ].join("\n")
    );
    const result = await exportStructuredPartitions({
      dataset: "takeaway_orders",
      sourcePath,
      outputDirectory: root,
      limits
    });
    expect(result.totalRowCount).toBe(2n);
    expect(result.partitions[0]).toMatchObject({
      businessDate: "2026-10-27",
      storeKey: "name:合成门店",
      merchantId: null
    });
    const rows = parseCsv(await readFile(result.partitions[0]!.filePath)) as string[][];
    expect(rows[0]).toEqual(headers);
    expect(rows[1]).toEqual([
      "合成门店",
      "0001",
      "未来平台",
      "000900719925474099312345",
      "0009",
      "制作中",
      "未知形式",
      "部分退款",
      "--",
      "0000002",
      "2026-10-27",
      "2026-10-28 00:03:00",
      "",
      "",
      "",
      "2026-10-29 01:00:00",
      "未来配送",
      "12.3",
      "0",
      "",
      "-1.23",
      "",
      "20",
      "-0.1",
      "",
      "",
      "5",
      "-2.3",
      "",
      "4.5",
      "5",
      "",
      "0"
    ]);
    expect(rows[2]).toEqual(rows[1]);
  });

  test("reorders takeaway headers and excludes only order-summary rows", async () => {
    const root = await temporaryRoot();
    const sourcePath = path.join(root, "source.csv");
    const headers = [...TAKEAWAY_HEADERS].reverse();
    const row = (values: Record<string, string>) =>
      headers.map((header) => values[header] ?? "").join(",");
    await writeFile(
      sourcePath,
      [
        headers.join(","),
        row({ 门店: "合计", 营业日期: "20261027", 订单来源: "总计平台", "营业收入(元)": "1" }),
        row({ 门店: "合计", 营业日期: "--", "营业收入(元)": "1" })
      ].join("\n")
    );
    const result = await exportStructuredPartitions({
      dataset: "takeaway_orders",
      sourcePath,
      outputDirectory: root,
      limits
    });
    const rows = parseCsv(await readFile(result.partitions[0]!.filePath)) as string[][];
    expect(rows).toHaveLength(2);
    expect(rows[0]).toEqual(TAKEAWAY_HEADERS);
    expect(rows[1]!.slice(0, 3)).toEqual(["合计", "", "总计平台"]);
  });

  test.each(["missing", "unknown", "duplicate", "blank"])(
    "rejects the entire takeaway source with a %s header",
    async (mutation) => {
      const root = await temporaryRoot();
      const sourcePath = path.join(root, "source.csv");
      const headers = [...TAKEAWAY_HEADERS];
      if (mutation === "missing") headers.pop();
      else if (mutation === "unknown") headers.push("未定义列");
      else if (mutation === "duplicate") headers.push("订单来源");
      else headers[2] = "";
      await writeFile(sourcePath, headers.join(",") + "\n合成店");
      await expect(
        exportStructuredPartitions({
          dataset: "takeaway_orders",
          sourcePath,
          outputDirectory: root,
          limits
        })
      ).rejects.toMatchObject({ code: "PARTITION_SOURCE_INVALID" });
      expect(await readdir(path.join(root, "candidates"))).toEqual([]);
    }
  );

  test.each([
    ["门店", "--", "store_name"],
    ["门店", "", "store_name"],
    ["营业日期", "--", "business_date"],
    ["营业日期", "20260230", "business_date"],
    ["完成时间", "2026-10-27 25:00", "completed_at"],
    ["营业收入(元)", "not-a-number", "business_income"]
  ])(
    "rejects a later invalid takeaway cell %s=%s without retaining candidates",
    async (column, value, canonicalName) => {
      const root = await temporaryRoot();
      const sourcePath = path.join(root, "source.csv");
      const base: Record<string, string> = { 门店: "合成店", 营业日期: "20261027" };
      const row = (values: Record<string, string>) =>
        TAKEAWAY_HEADERS.map((header) => values[header] ?? "").join(",");
      await writeFile(
        sourcePath,
        [TAKEAWAY_HEADERS.join(","), row(base), row({ ...base, [column!]: value! })].join("\n")
      );
      await expect(
        exportStructuredPartitions({
          dataset: "takeaway_orders",
          sourcePath,
          outputDirectory: root,
          limits
        })
      ).rejects.toMatchObject({
        code: "PARTITION_SOURCE_INVALID",
        message: expect.stringContaining(`Row 3 ${canonicalName}`)
      });
      expect(await readdir(path.join(root, "candidates"))).toEqual([]);
    }
  );

  test("preserves complete in-store order rows and ordered exact payment JSON", async () => {
    const root = await temporaryRoot();
    const fields = getStructuredRegistry("in_store_orders").fields.filter(
      (f) => f.inputSource === "file"
    );
    expect(fields).toHaveLength(30);
    const values: Record<string, string> = {
      store_name: "合成门店",
      business_date: "20261027",
      organization_code: "0001",
      order_id: "000023",
      ordered_at: "2026-10-28 00:03",
      diner_count: "--",
      refunded_at: "--",
      order_amount: "-001.2300",
      pickup_number: "--",
      member: "未知",
      payment_method:
        "员工 卡 10.00，现金 -2.30(退款)，现金 -2.30(退款)，现金 -0.1（找零），现金 +0.10(撤销找零)，现金 +0.10（撤销找零），精确 9007199254740993.123456789",
      order_note: '备注,含"引号"'
    };
    const csv = (cells: string[]) => cells.map((v) => `"${v.replaceAll('"', '""')}"`).join(",");
    const sourcePath = path.join(root, "source.csv");
    const row = fields.map((f) => values[f.canonicalName] ?? "");
    await writeFile(
      sourcePath,
      [csv(fields.map((f) => f.sourceColumn)), csv(row), csv(row)].join("\n")
    );
    const result = await exportStructuredPartitions({
      dataset: "in_store_orders",
      sourcePath,
      outputDirectory: root,
      limits
    });
    expect(result.totalRowCount).toBe(2n);
    expect(result.partitions[0]).toMatchObject({
      businessDate: "2026-10-27",
      merchantId: null,
      storeKey: "name:合成门店"
    });
    const rows = parseCsv(await readFile(result.partitions[0]!.filePath), {
      columns: true
    }) as Record<string, string>[];
    expect(Object.keys(rows[0]!)).toHaveLength(31);
    expect(rows[0]).toMatchObject({
      机构编码: "0001",
      订单号: "000023",
      下单时间: "2026-10-28 00:03:00",
      退单时间: "",
      用餐人数: "",
      "订单金额（元）": "-1.23",
      取餐号: "--",
      会员: "未知",
      结账方式: values.payment_method
    });
    expect(rows[0]!["结账方式JSON"]).toBe(
      '[{"method":"员工 卡","amount":10,"marker":null},{"method":"现金","amount":-2.3,"marker":"退款"},{"method":"现金","amount":-2.3,"marker":"退款"},{"method":"现金","amount":-0.1,"marker":"找零"},{"method":"现金","amount":0.1,"marker":"撤销找零"},{"method":"现金","amount":0.1,"marker":"撤销找零"},{"method":"精确","amount":9007199254740993.123456789,"marker":null}]'
    );
    expect(rows[1]).toEqual(rows[0]);
  });

  test.each(["", "--", "   "])("keeps absent payment %j as JSON null", async (payment) => {
    const root = await temporaryRoot();
    const fields = getStructuredRegistry("in_store_orders").fields.filter(
      (f) => f.inputSource === "file"
    );
    const sourcePath = path.join(root, "source.csv");
    await writeFile(
      sourcePath,
      fields.map((f) => f.sourceColumn).join(",") +
        "\n" +
        fields
          .map(
            (f) =>
              (
                ({
                  store_name: "合成门店",
                  business_date: "20261027",
                  payment_method: payment
                }) as Record<string, string>
              )[f.canonicalName] ?? ""
          )
          .join(",")
    );
    const result = await exportStructuredPartitions({
      dataset: "in_store_orders",
      sourcePath,
      outputDirectory: root,
      limits
    });
    const [row] = parseCsv(await readFile(result.partitions[0]!.filePath), {
      columns: true
    }) as Record<string, string>[];
    expect(row!["结账方式JSON"]).toBe("null");
    expect(row!["结账方式"]).toBe(payment);
  });

  test.each([
    { payment: "现金 10，现金 1(未知标记)", reason: "has an unsupported marker" },
    { payment: "现金 10，现金 1(撤销找零) trailing", reason: "cannot be parsed completely" }
  ])(
    "locates invalid payment items and cleans the whole source: $payment",
    async ({ payment, reason }) => {
      const root = await temporaryRoot();
      const fields = getStructuredRegistry("in_store_orders").fields.filter(
        (field) => field.inputSource === "file"
      );
      const values: Record<string, string> = {
        store_name: "合成门店",
        business_date: "20261027",
        payment_method: "现金 10"
      };
      const sourcePath = path.join(root, "source.csv");
      await writeFile(
        sourcePath,
        [
          fields.map((field) => field.sourceColumn).join(","),
          fields.map((field) => values[field.canonicalName] ?? "").join(","),
          fields
            .map((field) =>
              field.canonicalName === "payment_method"
                ? payment
                : (values[field.canonicalName] ?? "")
            )
            .join(",")
        ].join("\n")
      );
      await expect(
        exportStructuredPartitions({
          dataset: "in_store_orders",
          sourcePath,
          outputDirectory: root,
          limits
        })
      ).rejects.toMatchObject({
        code: "PARTITION_SOURCE_INVALID",
        message: expect.stringContaining(`Row 3 payment_method item 2 ${reason}`)
      });
      expect(await readdir(path.join(root, "candidates"))).toEqual([]);
    }
  );

  test.each([
    { field: "payment_method", value: "现金 10，无法解析" },
    { field: "payment_method", value: "现金 10 trailing" },
    { field: "store_name", value: "--" },
    { field: "business_date", value: "--" },
    { field: "diner_count", value: "unknown" }
  ])("rejects the complete source for invalid $field", async ({ field, value }) => {
    const root = await temporaryRoot();
    const fields = getStructuredRegistry("in_store_orders").fields.filter(
      (f) => f.inputSource === "file"
    );
    const values: Record<string, string> = { store_name: "合成门店", business_date: "20261027" };
    const sourcePath = path.join(root, "source.csv");
    await writeFile(
      sourcePath,
      [
        fields.map((f) => f.sourceColumn).join(","),
        fields.map((f) => values[f.canonicalName] ?? "").join(","),
        fields
          .map((f) => (f.canonicalName === field ? value : (values[f.canonicalName] ?? "")))
          .join(",")
      ].join("\n")
    );
    await expect(
      exportStructuredPartitions({
        dataset: "in_store_orders",
        sourcePath,
        outputDirectory: root,
        limits
      })
    ).rejects.toThrow(/Row 3/);
    expect(await readdir(path.join(root, "candidates"))).toEqual([]);
  });

  test.each([
    { label: "合计", reordered: false },
    { label: "总计", reordered: true }
  ])(
    "excludes in-store-order $label footer with placeholder business date",
    async ({ label, reordered }) => {
      const root = await temporaryRoot();
      const fields = getStructuredRegistry("in_store_orders").fields.filter(
        (field) => field.inputSource === "file"
      );
      if (reordered) fields.reverse();
      const values: Record<string, string> = {
        store_name: "合成门店",
        business_date: "20261026",
        order_amount: "10"
      };
      const footer: Record<string, string> = { store_name: label, order_amount: "10" };
      const sourcePath = path.join(root, "footer.csv");
      await writeFile(
        sourcePath,
        [
          fields.map((field) => field.sourceColumn).join(","),
          fields.map((field) => values[field.canonicalName] ?? "").join(","),
          fields.map((field) => footer[field.canonicalName] ?? "--").join(",")
        ].join("\n")
      );
      const result = await exportStructuredPartitions({
        dataset: "in_store_orders",
        sourcePath,
        outputDirectory: root,
        limits
      });
      expect(result.totalRowCount).toBe(1n);
      expect(result.partitions).toHaveLength(1);
      const rows = parseCsv(await readFile(result.partitions[0]!.filePath), {
        columns: true
      }) as Record<string, string>[];
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ 门店: "合成门店", 营业日期: "2026-10-26" });
    }
  );

  test("accepts reordered in-store-order source headers but rejects missing, unknown, duplicate and derived input columns", async () => {
    const fields = getStructuredRegistry("in_store_orders").fields.filter(
      (f) => f.inputSource === "file"
    );
    const headers = fields.map((f) => f.sourceColumn).reverse();
    const { resolveStructuredHeaders } = await import("@smedc/domain");
    expect(resolveStructuredHeaders("in_store_orders", headers).ok).toBe(true);
    for (const invalid of [
      headers.slice(1),
      [...headers, "未知列"],
      [...headers, headers[0]!],
      [...headers, "结账方式JSON"]
    ]) {
      expect(resolveStructuredHeaders("in_store_orders", invalid).ok).toBe(false);
    }
  });

  test.each(["order_note", "order_status"] as const)(
    "preserves summary labels in reordered in-store-order %s text and excludes footers",
    async (firstField) => {
      const root = await temporaryRoot();
      const fields = getStructuredRegistry("in_store_orders").fields.filter(
        (field) => field.inputSource === "file"
      );
      const reordered = [
        fields.find((field) => field.canonicalName === firstField)!,
        ...fields.filter((field) => field.canonicalName !== firstField)
      ];
      const values: Record<string, string> = {
        store_name: "合成甲店",
        business_date: "20261027",
        order_id: "0001",
        order_note: "合计",
        order_status: "总计"
      };
      const sourcePath = path.join(root, "reordered.csv");
      await writeFile(
        sourcePath,
        [
          reordered.map((field) => field.sourceColumn).join(","),
          reordered.map((field) => values[field.canonicalName] ?? "").join(","),
          ...["合计", "总计"].map((label) =>
            reordered.map((_field, index) => (index === 0 ? label : "")).join(",")
          )
        ].join("\n")
      );
      const result = await exportStructuredPartitions({
        dataset: "in_store_orders",
        sourcePath,
        outputDirectory: root,
        limits
      });
      expect(result.totalRowCount).toBe(1n);
      const rows = parseCsv(await readFile(result.partitions[0]!.filePath), {
        columns: true
      }) as Record<string, string>[];
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        门店: "合成甲店",
        营业日期: "2026-10-27",
        订单号: "0001",
        整单备注: "合计",
        订单状态: "总计"
      });
    }
  );

  test.each([
    { field: "store_name", value: "--" },
    { field: "business_date", value: "not-a-date" },
    { field: "business_date", value: "--" },
    { field: "business_date", value: "" }
  ])(
    "validates $field when a reordered order starts with a summary label",
    async ({ field, value }) => {
      const root = await temporaryRoot();
      const fields = getStructuredRegistry("in_store_orders")
        .fields.filter((entry) => entry.inputSource === "file")
        .reverse();
      const values: Record<string, string> = {
        store_name: "合成甲店",
        business_date: "20261027",
        order_note: "合计",
        [field]: value
      };
      const sourcePath = path.join(root, "invalid-reordered.csv");
      await writeFile(
        sourcePath,
        [
          fields.map((entry) => entry.sourceColumn).join(","),
          fields.map((entry) => values[entry.canonicalName] ?? "").join(",")
        ].join("\n")
      );
      await expect(
        exportStructuredPartitions({
          dataset: "in_store_orders",
          sourcePath,
          outputDirectory: root,
          limits
        })
      ).rejects.toThrow(new RegExp(`Row 2 ${field}`));
    }
  );

  calamineIntegrationTest(
    "reads original in-store-order XLSX with raw payments and source business dates",
    async () => {
      const root = await temporaryRoot();
      const { default: ExcelJS } = await import("exceljs");
      const workbook = new ExcelJS.Workbook();
      const sheet = workbook.addWorksheet("已结账合成");
      const fields = getStructuredRegistry("in_store_orders").fields.filter(
        (f) => f.inputSource === "file"
      );
      sheet.addRow(["店内订单明细"]);
      sheet.addRow(fields.map((f) => f.sourceColumn));
      const values: Record<string, string> = {
        store_name: "合成店",
        organization_code: "001",
        business_date: "20261027",
        order_id: "0001",
        ordered_at: "2026-10-28 00:01",
        payment_method: "  员工 卡 1.20，现金 -0.1（找零），现金 0.1(撤销找零)  ",
        diner_count: "--",
        member: "--"
      };
      sheet.addRow(fields.map((f) => values[f.canonicalName] ?? ""));
      const footer: Record<string, string> = { store_name: "合计", order_amount: "1.20" };
      sheet.addRow(fields.map((f) => footer[f.canonicalName] ?? "--"));
      const sourcePath = path.join(root, "original.xlsx");
      await workbook.xlsx.writeFile(sourcePath);
      const result = await exportStructuredPartitions({
        dataset: "in_store_orders",
        sourcePath,
        outputDirectory: root,
        limits
      });
      expect(result.totalRowCount).toBe(1n);
      expect(result.partitions).toHaveLength(1);
      expect(result.partitions[0]).toMatchObject({ businessDate: "2026-10-27", merchantId: null });
      const [row] = parseCsv(await readFile(result.partitions[0]!.filePath), {
        columns: true
      }) as Record<string, string>[];
      expect(row).toMatchObject({
        机构编码: "001",
        订单号: "0001",
        下单时间: "2026-10-28 00:01:00",
        结账方式: values.payment_method,
        会员: "--",
        用餐人数: ""
      });
      expect(JSON.parse(row!["结账方式JSON"]!)).toEqual([
        { method: "员工 卡", amount: 1.2, marker: null },
        { method: "现金", amount: -0.1, marker: "找零" },
        { method: "现金", amount: 0.1, marker: "撤销找零" }
      ]);
    }
  );

  test.each([
    ["business", "7f21e56922bdf510e000c7af4863934c2f7e36b5eb257679445f9311ca072050"],
    ["dishes", "cef9d62a49a995d63655b06d734cf49371ff6eddd124d61e1ea8de880a3d484e"]
  ] as const)("preserves pre-order canonical bytes for %s", async (dataset, checksum) => {
    const root = await temporaryRoot();
    const sourcePath = path.join(root, "source.csv");
    await writeFile(
      sourcePath,
      csvFor(dataset, [dataset === "business" ? businessRow() : dishRow()])
    );
    const result = await exportStructuredPartitions({
      dataset,
      sourcePath,
      outputDirectory: root,
      limits
    });
    // Recorded from the unchanged exporter at 291d6e5, before in_store_orders support.
    expect(result.partitions[0]!.checksumSha256).toBe(checksum);
  });

  test.each(["business", "dishes"] as const)(
    "continues rejecting typed placeholders in %s",
    async (dataset) => {
      const root = await temporaryRoot();
      const sourcePath = path.join(root, "source.csv");
      const numeric = fileFields(dataset).find((field) => field.type === "decimal")!;
      const row =
        dataset === "business"
          ? businessRow({ [numeric.canonicalName]: "--" })
          : dishRow({ [numeric.canonicalName]: "--" });
      await writeFile(sourcePath, csvFor(dataset, [row]));
      await expect(
        exportStructuredPartitions({ dataset, sourcePath, outputDirectory: root, limits })
      ).rejects.toThrow(/must be numeric/);
    }
  );

  test("streams a real XLSX fixture into store-day partitions", async () => {
    const root = await temporaryRoot();
    const result = await exportStructuredPartitions({
      dataset: "dishes",
      sourcePath: path.resolve(
        "fixtures/structured/synthetic_dishes_20260706_20260712_first1000.xlsx"
      ),
      outputDirectory: path.join(root, "output"),
      limits: { ...limits, maxRows: 2_000 },
      xlsxReaderCommand: fixtureReaderCommand()
    });

    expect(result.totalRowCount).toBe(997n);
    expect(result.partitions.length).toBeGreaterThan(0);
    expect(result.partitions.every((partition) => partition.rowCount > 0n)).toBe(true);
    expect(result.profile.sourceFormat).toBe("xlsx");
    expect(result.profile.totalMs).toBeGreaterThan(0);
    for (const phase of [
      "prepareMs",
      "structureReadMs",
      "mergeScanMs",
      "rowDecodeMs",
      "rowRoutingMs",
      "canonicalizeMs",
      "partitionWriteMs",
      "finalizeMs"
    ] as const) {
      expect(result.profile[phase]).toBeGreaterThanOrEqual(0);
    }
    expect(result.profile.structureReadMs).toBeGreaterThan(0);
    expect(result.profile.mergeScanMs).toBe(0);
  });

  calamineIntegrationTest(
    "exports the real fixture with the packaged Calamine binary",
    async () => {
      const root = await temporaryRoot();
      const result = await exportStructuredPartitions({
        dataset: "dishes",
        sourcePath: path.resolve(
          "fixtures/structured/synthetic_dishes_20260706_20260712_first1000.xlsx"
        ),
        outputDirectory: path.join(root, "output"),
        limits: { ...limits, maxRows: 2_000, maxPartitions: 100 }
      });

      expect(result.totalRowCount).toBe(997n);
      expect(result.partitions).toHaveLength(9);
      expect(partitionManifestDigest(result.partitions)).toBe(
        "6a968ed31b99301df3b11424b0c5c7e2a25197d74b807b6d8bb152b7f93d6dd4"
      );
    }
  );

  calamineIntegrationTest(
    "rejects forged worksheet sizes during native archive validation",
    async () => {
      const root = await temporaryRoot();
      const sourcePath = path.join(root, "forged-size.xlsx");
      const fixture = await readFile(
        path.resolve("fixtures/structured/synthetic_dishes_20260706_20260712_first1000.xlsx")
      );
      await writeFile(
        sourcePath,
        forgeCentralDirectorySize(fixture, "xl/worksheets/sheet1.xml", 10)
      );

      await expect(
        exportStructuredPartitions({
          dataset: "dishes",
          sourcePath,
          outputDirectory: path.join(root, "output"),
          limits: { ...limits, maxRows: 2_000, maxPartitions: 100 }
        })
      ).rejects.toMatchObject({ code: "PARTITION_SOURCE_INVALID" });
    }
  );

  test("uses the configured Calamine command as the XLSX row source", async () => {
    const root = await temporaryRoot();
    const command = await fakeCalamineCommand(root, [
      { type: "sheet", sheetIndex: 0, name: "菜品主题数据", hidden: false },
      {
        type: "rows",
        sheetIndex: 0,
        rows: [
          [1, fileFields("dishes").map((field) => field.sourceColumn)],
          [2, fileFields("dishes").map((field) => dishRow()[field.canonicalName] ?? "")]
        ]
      },
      { type: "end_sheet", sheetIndex: 0 },
      { type: "complete", sheetCount: 1 }
    ]);

    const result = await exportStructuredPartitions({
      dataset: "dishes",
      sourcePath: path.resolve(
        "fixtures/structured/synthetic_dishes_20260706_20260712_first1000.xlsx"
      ),
      outputDirectory: path.join(root, "output"),
      limits,
      xlsxReaderCommand: command
    });

    expect(result.totalRowCount).toBe(1n);
    expect(result.partitions).toHaveLength(1);
  });

  test("rejects the whole file when the Calamine reader exits unsuccessfully", async () => {
    const root = await temporaryRoot();
    const helperPath = path.join(root, "failed-reader.mjs");
    await writeFile(
      helperPath,
      'process.stderr.write("synthetic reader failure\\n"); process.exit(23);\n'
    );
    const outputDirectory = path.join(root, "output");

    await expect(
      exportStructuredPartitions({
        dataset: "dishes",
        sourcePath: path.resolve(
          "fixtures/structured/synthetic_dishes_20260706_20260712_first1000.xlsx"
        ),
        outputDirectory,
        limits,
        xlsxReaderCommand: [process.execPath, helperPath]
      })
    ).rejects.toMatchObject({ code: "PARTITION_SOURCE_INVALID" });
    await expect(readdir(path.join(outputDirectory, "candidates"))).resolves.toEqual([]);
  });

  test("terminates a Calamine reader before an oversized protocol line is buffered", async () => {
    const root = await temporaryRoot();
    const helperPath = path.join(root, "oversized-reader.mjs");
    await writeFile(helperPath, `process.stdout.write("x".repeat(${8 * 1024 * 1024 + 1}));\n`);

    await expect(
      exportStructuredPartitions({
        dataset: "dishes",
        sourcePath: path.resolve(
          "fixtures/structured/synthetic_dishes_20260706_20260712_first1000.xlsx"
        ),
        outputDirectory: path.join(root, "output"),
        limits,
        xlsxReaderCommand: [process.execPath, helperPath]
      })
    ).rejects.toThrow("Calamine reader protocol line exceeded its limit.");
  });

  test("writes deterministic canonical bytes grouped by merchant and business date", async () => {
    const root = await temporaryRoot();
    const sourcePath = path.join(root, "dishes.csv");
    const outputDirectory = path.join(root, "output");
    const rows = [
      dishRow({ merchant_id: "000123", store_name: " 门店 A ", product_name: "鱼,香" }),
      dishRow({ merchant_id: "000123", store_name: "门店 A", product_name: "第二道菜" }),
      dishRow({
        merchant_id: "000456",
        store_name: "门店 B",
        business_date: "2026-09-08",
        product_name: "第三道菜"
      })
    ];
    await writeFile(sourcePath, csvFor("dishes", rows));

    const result = await exportStructuredPartitions({
      dataset: "dishes",
      sourcePath,
      outputDirectory,
      limits
    });

    expect(result.totalRowCount).toBe(3n);
    expect(
      result.partitions.map(({ storeKey, businessDate, rowCount }) => ({
        storeKey,
        businessDate,
        rowCount
      }))
    ).toEqual([
      { storeKey: "merchant:000123", businessDate: "2026-09-07", rowCount: 2n },
      { storeKey: "merchant:000456", businessDate: "2026-09-08", rowCount: 1n }
    ]);

    const first = result.partitions[0]!;
    const bytes = await readFile(first.filePath);
    const text = bytes.toString("utf8");
    const expectedHeader = fileFields("dishes")
      .map((field) => csvCell(field.sourceColumn))
      .join(",");
    expect(text.startsWith(`${expectedHeader}\n`)).toBe(true);
    expect(text).toContain('"鱼,香"');
    expect(text.indexOf('"鱼,香"')).toBeLessThan(text.indexOf("第二道菜"));
    expect(text.endsWith("\n")).toBe(true);
    expect(bytes.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf]))).toBe(false);
    expect(first.byteSize).toBe(BigInt(bytes.byteLength));
    expect(first.checksumSha256).toBe(createHash("sha256").update(bytes).digest("hex"));
  });

  test("flushes many rows for one partition in bounded batches", async () => {
    const root = await temporaryRoot();
    const sourcePath = path.join(root, "dishes.csv");
    await writeFile(
      sourcePath,
      csvFor(
        "dishes",
        Array.from({ length: 200 }, (_, index) =>
          dishRow({ product_name: `批量菜品-${String(index).padStart(3, "0")}` })
        )
      )
    );

    const result = await exportStructuredPartitions({
      dataset: "dishes",
      sourcePath,
      outputDirectory: path.join(root, "output"),
      limits: { ...limits, maxRows: 500 }
    });

    expect(result.totalRowCount).toBe(200n);
    expect(result.profile.partitionFlushCount).toBeLessThan(10);
  });

  test("uses the normalized store-name fallback when merchant ID is absent", async () => {
    const root = await temporaryRoot();
    const sourcePath = path.join(root, "business.csv");
    await writeFile(
      sourcePath,
      csvFor("business", [
        businessRow({ merchant_id: "", store_name: " Store   A ", gross_sales_amount: "1.2300" })
      ])
    );

    const result = await exportStructuredPartitions({
      dataset: "business",
      sourcePath,
      outputDirectory: path.join(root, "output"),
      limits
    });

    expect(result.partitions[0]).toMatchObject({
      storeKey: "name:store a",
      merchantId: null,
      storeName: "Store A"
    });
    expect(await readFile(result.partitions[0]!.filePath, "utf8")).toContain("1.23");
  });

  test("rejects the whole file and removes candidates when one merchant identity conflicts", async () => {
    const root = await temporaryRoot();
    const sourcePath = path.join(root, "dishes.csv");
    const outputDirectory = path.join(root, "output");
    await writeFile(
      sourcePath,
      csvFor("dishes", [
        dishRow({ merchant_id: "001", store_name: "门店 A" }),
        dishRow({ merchant_id: "001", store_name: "门店 B" })
      ])
    );

    await expect(
      exportStructuredPartitions({ dataset: "dishes", sourcePath, outputDirectory, limits })
    ).rejects.toMatchObject({ code: "PARTITION_STORE_IDENTITY_CONFLICT" });
    await expect(readdir(path.join(outputDirectory, "candidates"))).resolves.toEqual([]);
  });

  test("aborts before publishing candidates and enforces the source row limit", async () => {
    const root = await temporaryRoot();
    const sourcePath = path.join(root, "business.csv");
    const outputDirectory = path.join(root, "output");
    await writeFile(sourcePath, csvFor("business", [businessRow(), businessRow()]));

    await expect(
      exportStructuredPartitions({
        dataset: "business",
        sourcePath,
        outputDirectory,
        limits: { ...limits, maxRows: 1 }
      })
    ).rejects.toMatchObject({ code: "PARTITION_LIMIT_EXCEEDED" });
    await expect(readdir(path.join(outputDirectory, "candidates"))).resolves.toEqual([]);

    const controller = new AbortController();
    controller.abort();
    await expect(
      exportStructuredPartitions({
        dataset: "business",
        sourcePath,
        outputDirectory,
        limits,
        signal: controller.signal
      })
    ).rejects.toMatchObject({ name: "AbortError" });
  });
});

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "smedc-partitions-"));
  roots.push(root);
  return root;
}

function fileFields(dataset: "business" | "dishes"): StructuredFieldRegistryEntry[] {
  return getStructuredRegistry(dataset).fields.filter((field) => field.inputSource === "file");
}

function csvFor(dataset: "business" | "dishes", rows: Array<Record<string, string>>): string {
  const fields = fileFields(dataset);
  return [
    fields.map((field) => csvCell(field.sourceColumn)).join(","),
    ...rows.map((row) => fields.map((field) => csvCell(row[field.canonicalName] ?? "")).join(","))
  ].join("\n");
}

function dishRow(overrides: Record<string, string> = {}): Record<string, string> {
  return validRow("dishes", {
    business_date: "2026-09-07",
    merchant_id: "000123",
    store_name: "门店 A",
    ...overrides
  });
}

function businessRow(overrides: Record<string, string> = {}): Record<string, string> {
  return validRow("business", {
    business_date: "2026-09-07",
    merchant_id: "000123",
    store_name: "门店 A",
    ...overrides
  });
}

function validRow(
  dataset: "business" | "dishes",
  overrides: Record<string, string>
): Record<string, string> {
  return Object.fromEntries(
    fileFields(dataset).map((field) => [
      field.canonicalName,
      overrides[field.canonicalName] ?? valueFor(field)
    ])
  );
}

function valueFor(field: StructuredFieldRegistryEntry): string {
  if (field.type === "date") return "2026-09-07";
  if (field.type === "date_time") return "2026-09-07 10:01:02";
  if (field.type === "integer") return "1";
  if (field.type === "decimal" || field.type === "percent") return "1.00";
  return "值";
}

function csvCell(value: string): string {
  return /[",\r\n]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value;
}

async function fakeCalamineCommand(
  root: string,
  events: Array<Record<string, unknown>>
): Promise<string[]> {
  const helperPath = path.join(root, "fake-calamine-reader.mjs");
  const output = `${events.map((event) => JSON.stringify(event)).join("\n")}\n`;
  await writeFile(
    helperPath,
    `const required = ${JSON.stringify([
      "--max-uncompressed-bytes",
      "--max-zip-entries",
      "--max-compression-ratio"
    ])};
if (required.some((flag) => !process.argv.includes(flag))) process.exit(24);
process.stdout.write(${JSON.stringify(output)});
`
  );
  return [process.execPath, helperPath];
}

function fixtureReaderCommand(): string[] {
  return [
    process.execPath,
    "--import",
    "tsx",
    path.resolve("packages/structured-ingestion/src/calamine-reader-test-helper.ts")
  ];
}

function partitionManifestDigest(
  partitions: Array<{
    storeKey: string;
    businessDate: string;
    rowCount: bigint;
    byteSize: bigint;
    checksumSha256: string;
  }>
): string {
  const manifest = partitions.map((partition) => ({
    storeKey: partition.storeKey,
    businessDate: partition.businessDate,
    rowCount: partition.rowCount.toString(),
    byteSize: partition.byteSize.toString(),
    checksumSha256: partition.checksumSha256
  }));
  return createHash("sha256").update(JSON.stringify(manifest)).digest("hex");
}

function forgeCentralDirectorySize(content: Buffer, entryName: string, size: number): Buffer {
  const forged = Buffer.from(content);
  for (let offset = 0; offset <= forged.length - 46;) {
    if (forged.readUInt32LE(offset) !== 0x02014b50) {
      offset += 1;
      continue;
    }
    const nameLength = forged.readUInt16LE(offset + 28);
    const name = forged.subarray(offset + 46, offset + 46 + nameLength).toString("utf8");
    if (name === entryName) forged.writeUInt32LE(size, offset + 24);
    offset += 46 + nameLength + forged.readUInt16LE(offset + 30) + forged.readUInt16LE(offset + 32);
  }
  return forged;
}
