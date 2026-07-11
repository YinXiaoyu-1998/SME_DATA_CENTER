import JSZip from "jszip";
import {
  EvidenceParseError,
  type EvidenceBlockType,
  type EvidenceWarning,
  type ParsedEvidenceBlock,
  type ParsedEvidenceDocument
} from "@enterprise-hub/domain";

export interface ParseEvidenceDocumentInput {
  fileType: "md" | "txt" | "docx";
  originalFilename?: string;
  content: Buffer | string;
}

export async function parseEvidenceDocument(
  input: ParseEvidenceDocumentInput
): Promise<ParsedEvidenceDocument> {
  if (input.fileType === "md") {
    return parseMarkdown(toText(input.content));
  }

  if (input.fileType === "txt") {
    return parseTxt(input.content);
  }

  return parseDocx(toBuffer(input.content));
}

function parseMarkdown(markdown: string): ParsedEvidenceDocument {
  const lines = normalizeLineEndings(markdown).split("\n");
  const blocks: ParsedEvidenceBlock[] = [];
  const headingPath: string[] = [];
  let lineIndex = 0;

  while (lineIndex < lines.length) {
    const line = lines[lineIndex] ?? "";

    if (isBlank(line)) {
      lineIndex += 1;
      continue;
    }

    const heading = /^(#{1,6})\s+(.+?)\s*$/.exec(line);
    if (heading) {
      const marker = heading[1] ?? "#";
      const title = normalizeInlineMarkdown(heading[2] ?? "");
      setHeadingPath(headingPath, marker.length, title);
      blocks.push(
        createBlock(blocks, {
          blockType: "heading",
          text: title,
          headingPath,
          startLine: lineIndex + 1,
          endLine: lineIndex + 1,
          metadata: { level: marker.length }
        })
      );
      lineIndex += 1;
      continue;
    }

    if (/^```/.test(line.trim())) {
      const startLine = lineIndex + 1;
      const language = line.trim().slice(3).trim() || null;
      const codeLines: string[] = [];
      lineIndex += 1;

      while (lineIndex < lines.length && !/^```/.test((lines[lineIndex] ?? "").trim())) {
        codeLines.push(lines[lineIndex] ?? "");
        lineIndex += 1;
      }

      const endLine = lineIndex < lines.length ? lineIndex + 1 : lines.length;
      if (lineIndex < lines.length) {
        lineIndex += 1;
      }

      blocks.push(
        createBlock(blocks, {
          blockType: "code",
          text: codeLines.join("\n").trim(),
          headingPath,
          startLine,
          endLine,
          metadata: { language }
        })
      );
      continue;
    }

    if (isMarkdownTableStart(lines, lineIndex)) {
      const startLine = lineIndex + 1;
      const tableLines: string[] = [];

      while (lineIndex < lines.length && isMarkdownTableLine(lines[lineIndex] ?? "")) {
        tableLines.push(lines[lineIndex] ?? "");
        lineIndex += 1;
      }

      const rows = tableLines
        .map(parseMarkdownTableRow)
        .filter((row) => row.length > 0 && !isMarkdownSeparatorRow(row));

      blocks.push(
        createBlock(blocks, {
          blockType: "table",
          text: rows.map((row) => row.join(" | ")).join("\n"),
          headingPath,
          startLine,
          endLine: lineIndex,
          metadata: { rowCount: rows.length }
        })
      );
      continue;
    }

    if (isMarkdownListLine(line)) {
      const startLine = lineIndex + 1;
      const listLines: string[] = [];

      while (lineIndex < lines.length && isMarkdownListLine(lines[lineIndex] ?? "")) {
        listLines.push(cleanMarkdownListLine(lines[lineIndex] ?? ""));
        lineIndex += 1;
      }

      blocks.push(
        createBlock(blocks, {
          blockType: "list",
          text: listLines.map(normalizeInlineMarkdown).join("\n"),
          headingPath,
          startLine,
          endLine: lineIndex,
          metadata: { itemCount: listLines.length }
        })
      );
      continue;
    }

    const startLine = lineIndex + 1;
    const paragraphLines: string[] = [];

    while (
      lineIndex < lines.length &&
      !isBlank(lines[lineIndex] ?? "") &&
      !/^(#{1,6})\s+/.test(lines[lineIndex] ?? "") &&
      !/^```/.test((lines[lineIndex] ?? "").trim()) &&
      !isMarkdownListLine(lines[lineIndex] ?? "") &&
      !isMarkdownTableStart(lines, lineIndex)
    ) {
      paragraphLines.push(lines[lineIndex] ?? "");
      lineIndex += 1;
    }

    blocks.push(
      createBlock(blocks, {
        blockType: "paragraph",
        text: normalizeInlineMarkdown(paragraphLines.join(" ")),
        headingPath,
        startLine,
        endLine: lineIndex,
        metadata: {}
      })
    );
  }

  return { blocks: nonEmptyBlocks(blocks), warnings: [] };
}

function parseTxt(content: Buffer | string): ParsedEvidenceDocument {
  const text = decodeText(content);
  const lines = normalizeLineEndings(text)
    .split("\n")
    .map((line) => normalizeTextWhitespace(line.trim()));
  const blocks: ParsedEvidenceBlock[] = [];
  let paragraphLines: string[] = [];
  let paragraphStartLine: number | null = null;

  for (let index = 0; index <= lines.length; index += 1) {
    const line = lines[index] ?? "";

    if (line && index < lines.length) {
      paragraphStartLine ??= index + 1;
      paragraphLines.push(line);
      continue;
    }

    if (paragraphStartLine !== null && paragraphLines.length > 0) {
      blocks.push(
        createBlock(blocks, {
          blockType: "paragraph",
          text: normalizeTextWhitespace(paragraphLines.join(" ")),
          headingPath: [],
          startLine: paragraphStartLine,
          endLine: index,
          metadata: {}
        })
      );
    }

    paragraphLines = [];
    paragraphStartLine = null;
  }

  return { blocks: nonEmptyBlocks(blocks), warnings: [] };
}

async function parseDocx(content: Buffer): Promise<ParsedEvidenceDocument> {
  let zip: JSZip;

  try {
    zip = await JSZip.loadAsync(content);
  } catch {
    throw new EvidenceParseError("MALFORMED_DOCX", "DOCX file is not a readable zip package.");
  }

  const documentFile = zip.file("word/document.xml");
  if (!documentFile) {
    throw new EvidenceParseError("MALFORMED_DOCX", "DOCX file is missing word/document.xml.");
  }

  const xml = await documentFile.async("string");
  const body = /<w:body(?:\s[^>]*)?>([\s\S]*?)<\/w:body>/.exec(xml)?.[1];
  if (!body) {
    throw new EvidenceParseError("MALFORMED_DOCX", "DOCX file is missing a document body.");
  }

  const warnings: EvidenceWarning[] = [];
  if (/<(?:w:)?(?:drawing|pict)\b/.test(body) || /<a:blip\b/.test(body)) {
    warnings.push({
      code: "EMBEDDED_IMAGE_UNSUPPORTED",
      message: "Embedded images are not OCR extracted; only surrounding DOCX text is indexed."
    });
  }

  const blocks: ParsedEvidenceBlock[] = [];
  const headingPath: string[] = [];
  const blockPattern = /<w:p(?:\s[^>]*)?>[\s\S]*?<\/w:p>|<w:tbl(?:\s[^>]*)?>[\s\S]*?<\/w:tbl>/g;
  const matches = body.matchAll(blockPattern);
  let blockOrdinal = 0;

  for (const match of matches) {
    const blockXml = match[0];

    if (blockXml.startsWith("<w:tbl")) {
      const rows = extractDocxTableRows(blockXml);
      const text = rows.map((row) => row.join(" | ")).join("\n");
      blocks.push(
        createDocxBlock(blocks, {
          blockType: "table",
          text,
          headingPath,
          blockOrdinal,
          metadata: { rowCount: rows.length }
        })
      );
      blockOrdinal += 1;
      continue;
    }

    const text = normalizeTextWhitespace(extractDocxText(blockXml));
    if (!text) {
      blockOrdinal += 1;
      continue;
    }

    const headingLevel = extractDocxHeadingLevel(blockXml);
    if (headingLevel) {
      setHeadingPath(headingPath, headingLevel, text);
      blocks.push(
        createDocxBlock(blocks, {
          blockType: "heading",
          text,
          headingPath,
          blockOrdinal,
          metadata: { level: headingLevel }
        })
      );
      blockOrdinal += 1;
      continue;
    }

    blocks.push(
      createDocxBlock(blocks, {
        blockType: "paragraph",
        text,
        headingPath,
        blockOrdinal,
        metadata: {}
      })
    );
    blockOrdinal += 1;
  }

  return { blocks: nonEmptyBlocks(blocks), warnings };
}

function createBlock(
  existingBlocks: ParsedEvidenceBlock[],
  input: {
    blockType: EvidenceBlockType;
    text: string;
    headingPath: string[];
    startLine: number;
    endLine: number;
    metadata: Record<string, unknown>;
  }
): ParsedEvidenceBlock {
  return {
    blockId: `blk_${existingBlocks.length}`,
    blockType: input.blockType,
    text: input.text,
    headingPath: [...input.headingPath],
    sourceLocation: { startLine: input.startLine, endLine: input.endLine },
    metadata: input.metadata
  };
}

function createDocxBlock(
  existingBlocks: ParsedEvidenceBlock[],
  input: {
    blockType: EvidenceBlockType;
    text: string;
    headingPath: string[];
    blockOrdinal: number;
    metadata: Record<string, unknown>;
  }
): ParsedEvidenceBlock {
  return {
    blockId: `blk_${existingBlocks.length}`,
    blockType: input.blockType,
    text: input.text,
    headingPath: [...input.headingPath],
    sourceLocation: { blockOrdinal: input.blockOrdinal },
    metadata: input.metadata
  };
}

function nonEmptyBlocks(blocks: ParsedEvidenceBlock[]) {
  return blocks.filter((block) => block.text.trim().length > 0);
}

function setHeadingPath(headingPath: string[], level: number, title: string) {
  headingPath.length = Math.max(level - 1, 0);
  headingPath[level - 1] = title;
}

function normalizeInlineMarkdown(value: string) {
  return normalizeTextWhitespace(
    value.replace(/\[([^\]]+)]\([^)]+\)/g, "$1").replace(/[*_`]/g, "")
  );
}

function normalizeTextWhitespace(value: string) {
  return value.replace(/[\t\v\f \u00a0]+/g, " ").trim();
}

function normalizeLineEndings(value: string) {
  return value.replace(/\r\n?/g, "\n");
}

function isBlank(line: string) {
  return line.trim().length === 0;
}

function isMarkdownListLine(line: string) {
  return /^\s*(?:[-*+]|\d+[.)])\s+/.test(line);
}

function cleanMarkdownListLine(line: string) {
  return line.replace(/^\s*(?:[-*+]|\d+[.)])\s+/, "");
}

function isMarkdownTableLine(line: string) {
  return line.trim().startsWith("|") && line.trim().endsWith("|");
}

function isMarkdownTableStart(lines: string[], lineIndex: number) {
  return (
    isMarkdownTableLine(lines[lineIndex] ?? "") &&
    lineIndex + 1 < lines.length &&
    isMarkdownSeparatorRow(parseMarkdownTableRow(lines[lineIndex + 1] ?? ""))
  );
}

function parseMarkdownTableRow(line: string) {
  return line
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((cell) => normalizeInlineMarkdown(cell));
}

function isMarkdownSeparatorRow(row: string[]) {
  return row.length > 0 && row.every((cell) => /^:?-{3,}:?$/.test(cell));
}

function decodeText(content: Buffer | string) {
  const buffer = toBuffer(content);

  if (buffer.length >= 3 && buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf) {
    return buffer.subarray(3).toString("utf8");
  }

  if (buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xfe) {
    return buffer.subarray(2).toString("utf16le");
  }

  if (buffer.length >= 2 && buffer[0] === 0xfe && buffer[1] === 0xff) {
    const swapped = Buffer.alloc(buffer.length - 2);
    for (let index = 2; index + 1 < buffer.length; index += 2) {
      swapped[index - 2] = buffer[index + 1] ?? 0;
      swapped[index - 1] = buffer[index] ?? 0;
    }
    return swapped.toString("utf16le");
  }

  return buffer.toString("utf8");
}

function toText(content: Buffer | string) {
  return typeof content === "string" ? content : decodeText(content);
}

function toBuffer(content: Buffer | string) {
  return typeof content === "string" ? Buffer.from(content, "utf8") : content;
}

function extractDocxHeadingLevel(xml: string) {
  const style = /<w:pStyle\b[^>]*(?:w:val|val)="([^"]+)"/.exec(xml)?.[1];
  const heading = /^Heading([1-6])$/i.exec(style ?? "");

  return heading ? Number(heading[1]) : null;
}

function extractDocxTableRows(xml: string) {
  return [...xml.matchAll(/<w:tr(?:\s[^>]*)?>[\s\S]*?<\/w:tr>/g)]
    .map((rowMatch) =>
      [...rowMatch[0].matchAll(/<w:tc(?:\s[^>]*)?>[\s\S]*?<\/w:tc>/g)]
        .map((cellMatch) => normalizeTextWhitespace(extractDocxText(cellMatch[0])))
        .filter((cell) => cell.length > 0)
    )
    .filter((row) => row.length > 0);
}

function extractDocxText(xml: string) {
  return [...xml.matchAll(/<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>/g)]
    .map((match) => decodeXml(match[1] ?? ""))
    .join("");
}

function decodeXml(value: string) {
  return value
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}
