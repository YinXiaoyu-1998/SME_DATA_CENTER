import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { getStructuredRegistry, type StructuredFieldRegistryEntry } from "@smedc/domain";
import { afterEach, describe, expect, test } from "vitest";
import { exportStructuredPartitions } from "./partition-export.js";

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
