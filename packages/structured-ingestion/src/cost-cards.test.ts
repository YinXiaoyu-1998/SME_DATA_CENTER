import { createHash } from "node:crypto";
import { describe, expect, test } from "vitest";
import { createReadStream } from "node:fs";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import ExcelJS from "exceljs";
import JSZip from "jszip";
import { COST_CARD_UPLOAD_SCHEMA, hashCostCard } from "@smedc/domain";
import * as ingestion from "./index.js";

const limits = {
  maxStructuredImportRows: 100,
  maxXlsxSheets: 10,
  maxStructuredCellChars: 32767,
  maxXlsxUncompressedBytes: 10_000_000,
  maxXlsxZipEntries: 100,
  maxXlsxCompressionRatio: 100
};
const headers = COST_CARD_UPLOAD_SCHEMA.map((f) => f.sourceColumn);
function payload(overrides: Record<string, unknown> = {}) {
  return {
    ...Object.fromEntries(
      COST_CARD_UPLOAD_SCHEMA.map((f) => [
        f.canonicalName,
        f.nullable ? null : f.type === "boolean" ? false : "x"
      ])
    ),
    spu_id: "001",
    sku_id: "002",
    dish_name: "同名菜",
    recipe_type: "标准配方",
    recipe_name: "标准",
    item_code: "0003",
    item_name: "盐",
    cost_unit: "克",
    net_quantity: "0",
    sale_price: "99999999999999.123456",
    yield_rate: "82%",
    ...overrides
  };
}
function row(
  overrides: Record<string, unknown> = {},
  sourceRowNumber = 2
): ingestion.StructuredImportRow {
  return {
    sourceSheetIndex: 0,
    sourceSheetName: "标准",
    sourceRowNumber,
    payload: payload(overrides)
  };
}
function cells(p: Record<string, unknown>) {
  return COST_CARD_UPLOAD_SCHEMA.map((f) => p[f.canonicalName] ?? "");
}
async function workbook(bad?: "missing" | "hidden" | "duplicate" | "unknown") {
  const book = new ExcelJS.Workbook();
  book.addWorksheet("说明").addRow(["导出说明"]);
  const sheet = book.addWorksheet("标准");
  sheet.addRow(["成本卡导出"]);
  sheet.addRow([...headers].reverse());
  sheet.addRow(cells(payload()).reverse());
  if (bad) {
    const exception = book.addWorksheet("例外");
    if (bad === "hidden") exception.state = "hidden";
    exception.addRow(
      bad === "missing"
        ? headers.slice(0, -1)
        : bad === "duplicate"
          ? [...headers, headers[0]]
          : bad === "unknown"
            ? [...headers, "未知列"]
            : headers
    );
    exception.addRow(
      cells(
        payload({ recipe_type: "例外配方", recipe_name: "门店例外", source_stores_text: "甲店" })
      )
    );
  }
  const zip = await JSZip.loadAsync(await book.xlsx.writeBuffer());
  const entry = zip.file("xl/worksheets/sheet2.xml")!;
  zip.file(
    entry.name,
    (await entry.async("string")).replace(/<dimension ref="[^"]+"\/>/, '<dimension ref="A1:A1"/>')
  );
  return zip.generateAsync({ type: "nodebuffer" });
}

describe("complete cost card ingestion", () => {
  test("groups by full SPU plus SKU and preserves zero, duplicates and overlapping exceptions", () => {
    const parsed = ingestion.groupCostCardRows(
      [
        row(),
        row({}, 3),
        row({ spu_id: "other" }, 4),
        row({ recipe_type: "例外配方", recipe_name: "一", source_stores_text: "甲店,乙店" }, 5),
        row({ recipe_type: "例外配方", recipe_name: "二", source_stores_text: "乙店" }, 6)
      ],
      { enterpriseKey: "e" }
    );
    expect(parsed.validationErrorCount).toBe(0);
    expect(parsed.cards).toHaveLength(2);
    expect(parsed.inputItemRowCount).toBe(5);
    const card = parsed.cards.find((c) => c.identity.spuId === "001")!;
    expect(card.recipes).toHaveLength(3);
    expect(card.recipes[0]!.items).toHaveLength(2);
    expect(card.recipes[0]!.items[0]!.net_quantity).toBe("0");
  });
  test("common-field conflicts reject the whole file with both source locations and combination", () => {
    const parsed = ingestion.groupCostCardRows([row(), row({ sale_price: "1" }, 8)], {
      enterpriseKey: "e"
    });
    expect(parsed.cards).toHaveLength(0);
    expect(parsed.validationErrors[0]).toMatchObject({ column: "sale_price", rowNumber: 8 });
    expect(parsed.validationErrors[0]!.message).toMatch(/001.*002.*标准.*2.*8/);
    expect(
      ingestion.groupCostCardRows([row({ net_quantity: "wrong" })], { enterpriseKey: "e" })
        .validationErrors[0]
    ).toMatchObject({ column: "net_quantity" });
  });
  test("preserves observed source recipe literals and does not invent an enum for other text", () => {
    const parsed = ingestion.groupCostCardRows(
      [
        row({ recipe_type: "全局（标准配方）" }),
        row({ recipe_type: "特定（例外配方）", source_stores_text: "甲店" }, 3),
        row({ recipe_type: "其他来源配方类型" }, 4)
      ],
      { enterpriseKey: "e" }
    );
    expect(parsed.validationErrorCount).toBe(0);
    expect(parsed.cards[0]!.recipes.map((r) => r.recipe_type)).toEqual([
      "全局（标准配方）",
      "特定（例外配方）",
      "其他来源配方类型"
    ]);
    expect(
      ingestion.groupCostCardRows(
        [row({ recipe_type: "全局（标准配方）", source_stores_text: "甲店" })],
        { enterpriseKey: "e" }
      ).validationErrorCount
    ).toBe(1);
    expect(
      ingestion.groupCostCardRows([row({ recipe_type: "特定（例外配方）" })], {
        enterpriseKey: "e"
      }).validationErrorCount
    ).toBe(1);
  });
  test("recipe conflicts are located and equivalent store sets preserve each raw rendering", () => {
    const conflict = ingestion.groupCostCardRows([row(), row({ other_cost: "0" }, 9)], {
      enterpriseKey: "e"
    });
    expect(conflict.cards).toHaveLength(0);
    expect(conflict.validationErrors[0]).toMatchObject({ column: "other_cost", rowNumber: 9 });
    const parsed = ingestion.groupCostCardRows(
      [
        row({ recipe_type: "例外配方", source_stores_text: " 乙店； 甲店 " }),
        row({ recipe_type: "例外配方", source_stores_text: "甲店,乙店" }, 3)
      ],
      { enterpriseKey: "e" }
    );
    expect(parsed.validationErrorCount).toBe(0);
    expect(parsed.cards[0]!.recipes[0]!.items.map((i) => i.sourceStoresText)).toEqual([
      " 乙店； 甲店 ",
      "甲店,乙店"
    ]);
  });
  test("title, reordered columns, wrong dimensions and unrelated sheets preserve all data", async () => {
    const parsed = await ingestion.parseStructuredFile({
      dataset: "cost_cards",
      fileName: "synthetic.xlsx",
      fileType: "xlsx",
      content: await workbook(),
      limits
    });
    expect(parsed.rows).toHaveLength(1);
    expect(parsed.rows[0]).toMatchObject({
      sourceSheetIndex: 1,
      sourceSheetName: "标准",
      sourceRowNumber: 3,
      payload: { sale_price: "99999999999999.123456", spu_id: "001", yield_rate: "0.82" }
    });
    expect(parsed.ignoredSheets).toHaveLength(1);
  });
  test.each(["missing", "hidden", "duplicate", "unknown"] as const)(
    "valid standard plus %s exception candidate is rejected",
    async (bad) => {
      const parsed = await ingestion.parseStructuredFile({
        dataset: "cost_cards",
        fileName: "synthetic.xlsx",
        fileType: "xlsx",
        content: await workbook(bad),
        limits,
        validationMode: "collect"
      });
      expect(parsed.validationErrorCount).toBeGreaterThan(0);
      expect(parsed.rows).toHaveLength(0);
      expect(parsed.validationErrors[0]!.sheetName).toBe("例外");
    }
  );
  test("per-card CSV is 38 columns and round-trips exact business values, source text and duplicates", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "cost-card-test-"));
    try {
      const parsed = ingestion.groupCostCardRows(
        [
          row(),
          row({}, 3),
          row(
            {
              recipe_type: "例外配方",
              recipe_name: '"例外,一"',
              source_stores_text: "乙店； 甲店",
              remark: "第一行\n第二行"
            },
            4
          )
        ],
        { enterpriseKey: "e" }
      );
      const exported = await ingestion.exportCostCardCsv(parsed, { workDirectory: dir });
      expect(exported.cards).toHaveLength(1);
      const entry = exported.cards[0]!;
      const csv = await readFile(entry.localFilePath, "utf8");
      expect(csv.split("\n")[0]!.split(",")).toHaveLength(38);
      expect(csv).toContain("99999999999999.123456");
      expect(csv).toContain("乙店； 甲店");
      expect(entry.byteSize).toBe(Buffer.byteLength(csv));
      expect(entry.checksumSha256).toBe(createHash("sha256").update(csv).digest("hex"));
      const card = await ingestion.readCostCardCsv({
        stream: createReadStream(entry.localFilePath),
        schemaVersion: 1,
        identity: entry.identity
      });
      expect(hashCostCard(card)).toBe(entry.contentHash);
      expect(entry.itemRowCount).toBe(3);
      expect(card.card.spu_id).toBe("001");
      await expect(
        ingestion.readCostCardCsv({
          stream: Readable.from(csv),
          schemaVersion: 1,
          identity: { ...entry.identity, spuId: "other" }
        })
      ).rejects.toThrow(/identity/);
      await expect(
        ingestion.parseStructuredFile({
          dataset: "cost_cards",
          fileName: "download.csv",
          fileType: "csv",
          content: Buffer.from(csv),
          limits
        })
      ).rejects.toThrow(/source_sheet/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
  test("CSV source rendering changes checksum without changing business fingerprint", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "cost-card-hash-"));
    try {
      const first = await ingestion.exportCostCardCsv(
        ingestion.groupCostCardRows(
          [row({ recipe_type: "例外配方", source_stores_text: "乙店；甲店" })],
          { enterpriseKey: "e" }
        ),
        { workDirectory: dir }
      );
      const second = await ingestion.exportCostCardCsv(
        ingestion.groupCostCardRows(
          [row({ recipe_type: "例外配方", source_stores_text: "甲店,乙店" }, 8)],
          { enterpriseKey: "e" }
        ),
        { workDirectory: dir }
      );
      expect(first.cards[0]!.contentHash).toBe(second.cards[0]!.contentHash);
      expect(first.cards[0]!.checksumSha256).not.toBe(second.cards[0]!.checksumSha256);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
  test("source item row limit is enforced once per row across multiple sheets", async () => {
    const book = new ExcelJS.Workbook();
    for (const name of ["甲", "乙"]) {
      const s = book.addWorksheet(name);
      s.addRow(headers);
      s.addRow(cells(payload()));
    }
    const parsed = await ingestion.parseStructuredFile({
      dataset: "cost_cards",
      fileName: "rows.xlsx",
      fileType: "xlsx",
      content: Buffer.from(await book.xlsx.writeBuffer()),
      limits: { ...limits, maxStructuredImportRows: 2 }
    });
    expect(parsed.rows).toHaveLength(2);
    await expect(
      ingestion.parseStructuredFile({
        dataset: "cost_cards",
        fileName: "rows.csv",
        fileType: "csv",
        content: Buffer.from(
          [headers.join(","), cells(payload()).join(","), cells(payload()).join(",")].join("\n")
        ),
        limits: { ...limits, maxStructuredImportRows: 2 }
      })
    ).resolves.toMatchObject({ validationErrorCount: 0 });
  });
  test("blank CSV rows do not consume item limit and preserve source row numbers", async () => {
    const parsed = await ingestion.parseStructuredFile({
      dataset: "cost_cards",
      fileName: "blank.csv",
      fileType: "csv",
      content: Buffer.from(
        [headers.join(","), "", cells(payload()).join(","), "   ", cells(payload()).join(",")].join(
          "\n"
        )
      ),
      limits: { ...limits, maxStructuredImportRows: 2 }
    });
    expect(parsed.rows.map((r) => r.sourceRowNumber)).toEqual([3, 5]);
  });
  test("card and disk limits reject before any partial output survives", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "cost-card-limit-"));
    try {
      const parsed = ingestion.groupCostCardRows([row(), row({ spu_id: "other" }, 3)], {
        enterpriseKey: "e"
      });
      await expect(
        ingestion.exportCostCardCsv(parsed, {
          workDirectory: dir,
          limits: { maxPartitions: 1, maxCanonicalBytes: 100000 }
        })
      ).rejects.toThrow(/card count/);
      await expect(
        ingestion.exportCostCardCsv(parsed, {
          workDirectory: dir,
          limits: { maxPartitions: 10, maxCanonicalBytes: 10 }
        })
      ).rejects.toThrow(/bytes/);
      expect(await readdir(dir)).toEqual([]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
