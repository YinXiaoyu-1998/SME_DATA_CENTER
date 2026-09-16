import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { getStructuredRegistry, type StructuredFieldRegistryEntry } from "@enterprise-hub/domain";
import { afterEach, describe, expect, test } from "vitest";
import { exportStructuredPartitions } from "./partition-export.js";

const roots: string[] = [];
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
        "fixtures/structured/maijia_dishes_20260706_20260712_first1000.xlsx"
      ),
      outputDirectory: path.join(root, "output"),
      limits: { ...limits, maxRows: 2_000 }
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
    expect(result.profile.mergeScanMs).toBeGreaterThan(0);
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
  const root = await mkdtemp(path.join(tmpdir(), "enterprise-hub-partitions-"));
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
