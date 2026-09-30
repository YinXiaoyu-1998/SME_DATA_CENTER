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
