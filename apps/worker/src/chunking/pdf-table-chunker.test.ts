import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parsePdfEvidenceResult, type PdfTable } from "@smedc/domain";
import { createEvidenceChunks } from "./evidence-chunker.js";
import { createPdfTableBlocks } from "./pdf-table-chunker.js";

const context = {
  headingPath: ["合成规则"],
  sourceLocation: {
    pageNumber: 1,
    method: "ocr" as const,
    bbox: { left: 0.1, top: 0.2, right: 0.9, bottom: 0.8 }
  },
  maxChunkChars: 90
};
function table(): PdfTable {
  return parsePdfEvidenceResult(
    JSON.parse(readFileSync("fixtures/evidence/pdf/contracts/valid-mixed.json", "utf8"))
  ).tables[0]!;
}
function chunks(blocks: ReturnType<typeof createPdfTableBlocks>, maxChunkChars = 90) {
  return createEvidenceChunks({
    documentId: "synthetic",
    contentVersion: 1,
    retrievalConfigVersion: "existing.v1",
    blocks,
    maxChunkChars
  });
}

describe("PDF table chunker", () => {
  it("keeps headers, repeated valid rows, amount relationships and physical provenance", () => {
    const result = chunks(createPdfTableBlocks(table(), context));
    expect(result.chunks.length).toBeGreaterThan(0);
    expect(
      result.chunks
        .map((chunk) => chunk.text)
        .join("\n")
        .match(/条款: 条款甲/g)
    ).toHaveLength(2);
    const rowA = result.chunks.filter((chunk) => chunk.text.includes("条款甲"));
    expect(rowA.length).toBeGreaterThan(0);
    expect(rowA.every((chunk) => chunk.text.includes("金额: 20元"))).toBe(true);
    const rowB = result.chunks.find((chunk) => chunk.text.includes("条款乙"));
    expect(rowB?.text).toContain("金额: 30元");
    for (const chunk of result.chunks) {
      expect(chunk.text).toContain("表头: 条款 | 金额");
      expect(chunk.headingPath).toEqual(["合成规则"]);
      expect(chunk.sourceLocations).toEqual([
        expect.objectContaining({ pageNumber: 1, method: "ocr", bbox: context.sourceLocation.bbox })
      ]);
      expect(chunk.metadata.pdfTable).toMatchObject({ tableId: "table-synthetic-p1-0" });
    }
  });

  it("expands merged cells into affected rows with column labels", () => {
    const merged: PdfTable = {
      id: "merged",
      rowCount: 3,
      columnCount: 3,
      headerRows: [0],
      cells: [
        { row: 0, column: 0, rowSpan: 1, columnSpan: 2, text: "类别" },
        { row: 0, column: 2, rowSpan: 1, columnSpan: 1, text: "金额" },
        { row: 1, column: 0, rowSpan: 2, columnSpan: 1, text: "分组甲" },
        { row: 1, column: 1, rowSpan: 1, columnSpan: 1, text: "条款甲" },
        { row: 1, column: 2, rowSpan: 1, columnSpan: 1, text: "20元" },
        { row: 2, column: 1, rowSpan: 1, columnSpan: 1, text: "条款乙" },
        { row: 2, column: 2, rowSpan: 1, columnSpan: 1, text: "30元" }
      ]
    };
    const result = createPdfTableBlocks(merged, { ...context, maxChunkChars: 90 });
    expect(result.length).toBeGreaterThan(0);
    expect(
      result
        .map((block) => block.text)
        .join("\n")
        .match(/类别: 分组甲/g)
    ).toHaveLength(2);
    expect(result.find((block) => block.text.includes("条款乙"))?.text).toContain("金额: 30元");
  });

  it("marks oversized row continuations with stable row ID and repeats the amount", () => {
    const input = table();
    input.cells.find((cell) => cell.row === 1 && cell.column === 0)!.text =
      "条款甲" + "长说明".repeat(100);
    const blocks = createPdfTableBlocks(input, context);
    const repeated = createPdfTableBlocks(input, context);
    expect(blocks.map((block) => block.blockId)).toEqual(repeated.map((block) => block.blockId));
    const continued = blocks.filter((block) => block.metadata.continuation);
    expect(continued.length).toBeGreaterThan(1);
    const result = chunks(blocks);
    expect(result.chunks.length).toBeGreaterThan(1);
    expect(result.warnings).toContainEqual(
      expect.objectContaining({
        code: "PDF_TABLE_ROW_CONTINUED",
        sourceLocation: expect.objectContaining({ pageNumber: 1, tableRow: 1 })
      })
    );
    for (const block of continued) {
      expect(block.text).toContain("表头: 条款 | 金额");
      expect(block.text).toContain("金额: 20元");
      expect(block.text.length).toBeLessThanOrEqual(90);
      expect(block.metadata.continuation).toMatchObject({
        rowId: "table-synthetic-p1-0:row:1",
        partCount: continued.length
      });
    }
    expect(result.chunks.every((chunk) => chunk.metadata.fallbackStrategy === null)).toBe(true);
    expect(result.chunks[0]?.metadata.pdfTable).toMatchObject({
      continuation: expect.objectContaining({ rowId: "table-synthetic-p1-0:row:1" })
    });
  });

  it("preserves a longer amount range in every continuation and reconstructs long cells", () => {
    const input = table();
    input.cells.find((cell) => cell.row === 1 && cell.column === 0)!.text =
      "条款甲" + "长说明".repeat(100);
    input.cells.find((cell) => cell.row === 1 && cell.column === 1)!.text = "10000元至20000元";
    const blocks = createPdfTableBlocks(input, { ...context, maxChunkChars: 60 });
    const continued = blocks.filter((block) => block.metadata.continuation);
    expect(continued.length).toBeGreaterThan(1);
    expect(continued.every((block) => block.text.includes("金额: 10000元至20000元"))).toBe(true);
    const recovered = continued
      .map((block) => block.text.split("条款: ")[1]!.split(" | 金额:")[0])
      .join("");
    expect(recovered).toBe("条款甲" + "长说明".repeat(100));
  });

  it("does not corrupt Unicode code points at continuation boundaries", () => {
    const input = table();
    input.cells.find((cell) => cell.row === 1 && cell.column === 0)!.text =
      "条款甲" + "😀".repeat(100);
    const continued = createPdfTableBlocks(input, context).filter(
      (block) => block.metadata.continuation
    );
    expect(continued.length).toBeGreaterThan(1);
    for (const block of continued) expect(block.text).not.toMatch(/[\uD800-\uDFFF]/u);
    const recovered = continued
      .map((block) => block.text.split("条款: ")[1]!.split(" | 金额:")[0])
      .join("");
    expect(recovered).toBe("条款甲" + "😀".repeat(100));
  });

  it("refuses generic silent splitting of unprepared PDF tables", () => {
    expect(() =>
      chunks([
        {
          blockId: "raw",
          blockType: "table",
          text: "raw ".repeat(200),
          headingPath: [],
          sourceLocation: context.sourceLocation,
          metadata: { tableId: "raw" }
        }
      ])
    ).toThrow("PDF tables require row-aware chunking.");
  });

  it("keeps oversized header context intact with a visible warning", () => {
    const input = table();
    input.cells[0]!.text = "很长表头".repeat(50);
    const blocks = createPdfTableBlocks(input, { ...context, maxChunkChars: 40 });
    const result = chunks(blocks, 40);
    expect(result.chunks.length).toBeGreaterThan(0);
    expect(result.warnings).toContainEqual(
      expect.objectContaining({ code: "PDF_TABLE_CONTEXT_EXCEEDS_CHUNK_LIMIT" })
    );
    expect(result.chunks[0]?.text).toContain("很长表头".repeat(50));
  });
});
