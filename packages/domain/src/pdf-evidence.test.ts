import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { EvidenceParseError } from "./evidence.js";
import { parsePdfEvidenceResult } from "./pdf-evidence.js";

function fixture() {
  return JSON.parse(readFileSync("fixtures/evidence/pdf/contracts/valid-mixed.json", "utf8"));
}

describe("PDF evidence contract", () => {
  it("accepts synthetic mixed pages with repeated rows and picture OCR provenance", () => {
    const parsed = parsePdfEvidenceResult(fixture());
    expect(parsed.pageCount).toBe(3);
    expect(parsed.blocks).toHaveLength(1);
    expect(parsed.blocks[0]?.sourceLocation).toMatchObject({ pageNumber: 1, method: "ocr" });
    expect(parsed.tables[0]?.cells.filter((cell) => cell.text === "20元")).toHaveLength(2);
    expect(parsed.pictures[0]?.ocrBlockIds).toEqual(["block-synthetic-p1-0"]);
  });

  it("rejects the shared duplicate-page JSON contract fixture", () => {
    const invalid = JSON.parse(
      readFileSync("fixtures/evidence/pdf/contracts/invalid-duplicate-page.json", "utf8")
    );
    expect(() => parsePdfEvidenceResult(invalid)).toThrow(EvidenceParseError);
  });

  it.each([
    [
      "non-string page outcome",
      (v: ReturnType<typeof fixture>) => {
        v.pages[0].outcome = ["parsed"];
      }
    ],
    [
      "duplicate physical page",
      (v: ReturnType<typeof fixture>) => {
        v.pages[1].pageNumber = 1;
      }
    ],
    [
      "missing physical page",
      (v: ReturnType<typeof fixture>) => {
        v.pages.pop();
      }
    ],
    [
      "out of range page",
      (v: ReturnType<typeof fixture>) => {
        v.blocks[0].sourceLocation.pageNumber = 4;
      }
    ],
    [
      "NaN bbox",
      (v: ReturnType<typeof fixture>) => {
        v.blocks[0].sourceLocation.bbox.left = NaN;
      }
    ],
    [
      "out of bounds bbox",
      (v: ReturnType<typeof fixture>) => {
        v.pictures[0].bbox.right = 1.1;
      }
    ],
    [
      "inverted bbox",
      (v: ReturnType<typeof fixture>) => {
        v.pictures[0].bbox.left = 0.95;
      }
    ],
    [
      "zero span",
      (v: ReturnType<typeof fixture>) => {
        v.tables[0].cells[0].rowSpan = 0;
      }
    ],
    [
      "overflow span",
      (v: ReturnType<typeof fixture>) => {
        v.tables[0].cells[0].columnSpan = 3;
      }
    ],
    [
      "overlapping cells",
      (v: ReturnType<typeof fixture>) => {
        v.tables[0].cells[0].columnSpan = 2;
      }
    ],
    [
      "invalid header row",
      (v: ReturnType<typeof fixture>) => {
        v.tables[0].headerRows = [4];
      }
    ],
    [
      "unknown table",
      (v: ReturnType<typeof fixture>) => {
        v.blocks[0].metadata.tableId = "missing";
      }
    ],
    [
      "out of range table rows",
      (v: ReturnType<typeof fixture>) => {
        v.blocks[0].metadata.rowEnd = 4;
      }
    ],
    [
      "duplicate block ID",
      (v: ReturnType<typeof fixture>) => {
        v.blocks.push(v.blocks[0]);
      }
    ],
    [
      "unknown OCR block",
      (v: ReturnType<typeof fixture>) => {
        v.pictures[0].ocrBlockIds = ["missing"];
      }
    ],
    [
      "wrong page OCR link",
      (v: ReturnType<typeof fixture>) => {
        v.pictures[1].ocrBlockIds = [v.blocks[0].blockId];
      }
    ],
    [
      "content on blank page",
      (v: ReturnType<typeof fixture>) => {
        v.blocks[0].sourceLocation.pageNumber = 2;
      }
    ],
    [
      "parsed page without content",
      (v: ReturnType<typeof fixture>) => {
        v.pages[1].outcome = "parsed";
      }
    ],
    [
      "generated description",
      (v: ReturnType<typeof fixture>) => {
        v.blocks[0].metadata.sourceType = "generated_description";
      }
    ]
  ])("rejects %s without exposing input text", (_label, mutate) => {
    const input = fixture();
    mutate(input);
    expect(() => parsePdfEvidenceResult(input)).toThrow(EvidenceParseError);
    expect(() => parsePdfEvidenceResult(input)).toThrow("Invalid PDF evidence result.");
  });

  it.each(["rowCount", "columnCount"])(
    "rejects enormous declared %s before table work",
    (dimension) => {
      const input = fixture();
      input.tables[0][dimension] = Number.MAX_SAFE_INTEGER;
      expect(() => parsePdfEvidenceResult(input)).toThrow(EvidenceParseError);
    }
  );

  it("rejects excessive grid expansion from one merged cell", () => {
    const input = fixture();
    Object.assign(input.tables[0], {
      rowCount: 512,
      columnCount: 64,
      cells: [{ row: 0, column: 0, rowSpan: 512, columnSpan: 64, text: "合成合并单元格" }]
    });
    expect(() => parsePdfEvidenceResult(input)).toThrow(EvidenceParseError);
  });

  it("rejects excessive total grid work across individually bounded tables", () => {
    const input = fixture();
    input.tables = Array.from({ length: 5 }, (_, index) => ({
      id: `synthetic-${index}`,
      rowCount: 128,
      columnCount: 128,
      headerRows: [0],
      cells: [{ row: 0, column: 0, rowSpan: 128, columnSpan: 128, text: "合成" }]
    }));
    input.blocks = input.tables.map((table: { id: string }, index: number) => ({
      ...input.blocks[0],
      blockId: `block-${index}`,
      metadata: { tableId: table.id, rowStart: 0, rowEnd: 127 }
    }));
    input.pictures[0].ocrBlockIds = ["block-0"];
    expect(() => parsePdfEvidenceResult(input)).toThrow(EvidenceParseError);
  });

  it("rejects excessive text expansion from an otherwise bounded merged grid", () => {
    const input = fixture();
    Object.assign(input.tables[0], {
      rowCount: 16,
      columnCount: 16,
      cells: [{ row: 0, column: 0, rowSpan: 16, columnSpan: 16, text: "x".repeat(17000) }]
    });
    expect(() => parsePdfEvidenceResult(input)).toThrow(EvidenceParseError);
  });

  it("retains bounded sparse grids and valid merged cells", () => {
    const input = fixture();
    Object.assign(input.tables[0], {
      rowCount: 32,
      columnCount: 32,
      cells: [{ row: 0, column: 0, rowSpan: 2, columnSpan: 3, text: "合成合并单元格" }]
    });
    const parsed = parsePdfEvidenceResult(input);
    expect(parsed.tables[0]?.cells).toEqual([
      { row: 0, column: 0, rowSpan: 2, columnSpan: 3, text: "合成合并单元格" }
    ]);
    expect(parsed.tables[0]?.rowCount).toBe(32);
    expect(parsed.tables[0]?.columnCount).toBe(32);
  });

  it("retains explicit failed pages so activation can reject incomplete parsing", () => {
    const input = fixture();
    input.pages[1].outcome = "failed";
    input.warnings = [
      {
        code: "PDF_PAGE_FAILED",
        message: "A page failed.",
        sourceLocation: { pageNumber: 2, method: "ocr" }
      }
    ];
    const parsed = parsePdfEvidenceResult(input);
    expect(parsed.pages[1]).toEqual({ pageNumber: 2, outcome: "failed" });
    expect(parsed.warnings[0]?.sourceLocation).toMatchObject({ pageNumber: 2 });
  });
});
