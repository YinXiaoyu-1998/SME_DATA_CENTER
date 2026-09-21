import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import JSZip from "jszip";
import { describe, expect, it } from "vitest";
import { createEvidenceChunks } from "../chunking/evidence-chunker.js";
import { parseEvidenceDocument } from "./evidence-parser.js";

const fixturesRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../../fixtures/evidence"
);

interface EvidenceFixtureManifestV1 {
  schemaVersion: 1;
  documents: Array<{
    fixtureId: string;
    path: string;
    title: string;
    sha256: string;
    confidentialityLevel: 0;
  }>;
}

const maijiaManifest = JSON.parse(
  readFileSync(path.join(fixturesRoot, "maijia/golden.json"), "utf8")
) as EvidenceFixtureManifestV1;
const maijiaFixturesRoot = path.join(fixturesRoot, "maijia");

describe("evidence parser", () => {
  it("extracts Markdown structure while preserving heading paths, links, lists, tables, and code", async () => {
    const content = await readFile(path.join(fixturesRoot, "kitchen-sop.md"));

    const result = await parseEvidenceDocument({
      fileType: "md",
      originalFilename: "kitchen-sop.md",
      content
    });

    expect(result.warnings).toEqual([]);
    expect(result.blocks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          blockType: "paragraph",
          headingPath: ["Operations SOP"],
          text: "The Operations Portal stores the current checklist.",
          sourceLocation: expect.objectContaining({ startLine: 3, endLine: 3 })
        }),
        expect.objectContaining({
          blockType: "list",
          headingPath: ["Operations SOP", "Opening Checklist"],
          text: expect.stringContaining("Check fridge temperatures")
        }),
        expect.objectContaining({
          blockType: "table",
          headingPath: ["Operations SOP", "Opening Checklist"],
          text: "Metric | Owner\nTemperature log | Shift lead\nCash count | Cashier"
        }),
        expect.objectContaining({
          blockType: "code",
          headingPath: ["Operations SOP", "Opening Checklist"],
          text: "npm run worker:once",
          metadata: expect.objectContaining({ language: "bash" })
        })
      ])
    );
  });

  it("normalizes TXT encoding, line endings, whitespace, and paragraphs deterministically", async () => {
    const content = await readFile(path.join(fixturesRoot, "shift-notes.txt"));

    const result = await parseEvidenceDocument({
      fileType: "txt",
      originalFilename: "shift-notes.txt",
      content
    });

    expect(result.warnings).toEqual([]);
    expect(result.blocks.map((block) => block.text)).toEqual([
      "First line continues here.",
      "Second paragraph with spaces.",
      "Final paragraph."
    ]);
    expect(result.blocks.map((block) => block.sourceLocation)).toEqual([
      { startLine: 1, endLine: 2 },
      { startLine: 5, endLine: 5 },
      { startLine: 7, endLine: 7 }
    ]);
  });

  it("extracts DOCX body paragraphs and table cells in deterministic row order", async () => {
    const content = await createDocxFixture({
      paragraphs: [
        { text: "客户反馈", style: "Heading1" },
        { text: "差评处理", style: "Heading2" },
        { text: "先联系门店经理。" }
      ],
      tableRows: [
        ["字段", "值"],
        ["SLA", "24小时"]
      ]
    });

    const result = await parseEvidenceDocument({
      fileType: "docx",
      originalFilename: "feedback-sop.docx",
      content
    });

    expect(result.warnings).toEqual([]);
    expect(result.blocks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          blockType: "paragraph",
          headingPath: ["客户反馈", "差评处理"],
          text: "先联系门店经理。"
        }),
        expect.objectContaining({
          blockType: "table",
          headingPath: ["客户反馈", "差评处理"],
          text: "字段 | 值\nSLA | 24小时"
        })
      ])
    );
  });

  it.each(maijiaManifest.documents)(
    "parses and chunks the real-world DOCX fixture $fixtureId",
    async (fixture) => {
      const content = await readFile(path.join(maijiaFixturesRoot, fixture.path));
      const result = await parseEvidenceDocument({
        fileType: "docx",
        originalFilename: path.basename(fixture.path),
        content
      });

      expect(result.blocks.length).toBeGreaterThan(0);
      expect(result.blocks.map((block) => block.sourceLocation.blockOrdinal)).toEqual(
        [...result.blocks]
          .map((block) => block.sourceLocation.blockOrdinal)
          .sort((left, right) => (left ?? 0) - (right ?? 0))
      );
      const parsedText = result.blocks.map((block) => block.text).join("\n");
      const hasDisallowedControlCharacter = [...parsedText].some((character) => {
        const codePoint = character.codePointAt(0) ?? 0;
        return codePoint < 32 && ![9, 10, 13].includes(codePoint);
      });
      expect(parsedText).not.toMatch(/<\/?w:/u);
      expect(hasDisallowedControlCharacter).toBe(false);

      const chunking = createEvidenceChunks({
        documentId: fixture.fixtureId,
        contentVersion: 1,
        retrievalConfigVersion: "phase3.retrieval.v1",
        blocks: result.blocks
      });

      expect(chunking.chunks.length).toBeGreaterThan(0);
    }
  );

  it("records embedded image warnings without OCR text", async () => {
    const content = await createDocxFixture({
      paragraphs: [{ text: "有截图的流程", style: "Heading1" }],
      includeImage: true
    });

    const result = await parseEvidenceDocument({
      fileType: "docx",
      originalFilename: "screenshot.docx",
      content
    });

    expect(result.warnings).toEqual([
      expect.objectContaining({
        code: "EMBEDDED_IMAGE_UNSUPPORTED",
        message: expect.stringContaining("Embedded images are not OCR extracted")
      })
    ]);
    expect(result.blocks.map((block) => block.text).join("\n")).not.toContain(
      "OCR SHOULD NOT APPEAR"
    );
  });

  it("rejects malformed DOCX so it cannot become active", async () => {
    await expect(
      parseEvidenceDocument({
        fileType: "docx",
        originalFilename: "broken.docx",
        content: Buffer.from("not a zip")
      })
    ).rejects.toMatchObject({
      code: "MALFORMED_DOCX",
      canBecomeActive: false
    });
  });
});

async function createDocxFixture(input: {
  paragraphs: Array<{ text: string; style?: "Heading1" | "Heading2" }>;
  tableRows?: string[][];
  includeImage?: boolean;
}): Promise<Buffer> {
  const zip = new JSZip();
  const paragraphXml = input.paragraphs.map((paragraph) => docxParagraph(paragraph)).join("");
  const tableXml = input.tableRows ? docxTable(input.tableRows) : "";
  const imageXml = input.includeImage
    ? '<w:p><w:r><w:drawing><wp:inline><wp:docPr id="1" name="Screenshot" descr="OCR SHOULD NOT APPEAR"/></wp:inline></w:drawing></w:r></w:p>'
    : "";

  zip.file(
    "[Content_Types].xml",
    '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>'
  );
  zip
    .folder("_rels")
    ?.file(
      ".rels",
      '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>'
    );
  zip
    .folder("word")
    ?.file(
      "document.xml",
      `<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing"><w:body>${paragraphXml}${tableXml}${imageXml}<w:sectPr/></w:body></w:document>`
    );

  return zip.generateAsync({ type: "nodebuffer" });
}

function docxParagraph(paragraph: { text: string; style?: "Heading1" | "Heading2" }) {
  const styleXml = paragraph.style ? `<w:pPr><w:pStyle w:val="${paragraph.style}"/></w:pPr>` : "";

  return `<w:p>${styleXml}<w:r><w:t>${escapeXml(paragraph.text)}</w:t></w:r></w:p>`;
}

function docxTable(rows: string[][]) {
  const rowXml = rows
    .map(
      (row) =>
        `<w:tr>${row
          .map((cell) => `<w:tc><w:p><w:r><w:t>${escapeXml(cell)}</w:t></w:r></w:p></w:tc>`)
          .join("")}</w:tr>`
    )
    .join("");

  return `<w:tbl>${rowXml}</w:tbl>`;
}

function escapeXml(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}
