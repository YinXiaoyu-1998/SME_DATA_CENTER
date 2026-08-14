import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import JSZip from "jszip";
import { getStructuredRegistry } from "@enterprise-hub/domain";

/**
 * Deterministically generate the "rejected upload" fixture set used by the
 * structured-import rejection tests. Each file must be rejected by the
 * service for a distinct reason (file format, encoding, header structure,
 * worksheet structure, or cell typing). Keep them small and independent of
 * any real customer export; the valid VIP slice lives separately at
 * fixtures/structured/maijia_vip_20260809_20260809_first1000.xlsx.
 */

const STRUCTURED_DIR = path.resolve("fixtures/structured");
const XLSX_DIR = path.join(STRUCTURED_DIR, "xlsx");

const NS = {
  main: "http://schemas.openxmlformats.org/spreadsheetml/2006/main",
  relationship: "http://schemas.openxmlformats.org/officeDocument/2006/relationships",
  packageRelationship: "http://schemas.openxmlformats.org/package/2006/relationships",
  contentTypes: "http://schemas.openxmlformats.org/package/2006/content-types"
};
const FIXED_ZIP_DATE = new Date("2026-01-01T00:00:00Z");

function vipHeaders(): string[] {
  return getStructuredRegistry("vip").fields.map((field) => field.sourceColumn);
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function columnName(index: number): string {
  let name = "";
  let value = index;
  while (value >= 0) {
    name = String.fromCharCode(65 + (value % 26)) + name;
    value = Math.floor(value / 26) - 1;
  }
  return name;
}

interface SheetSpec {
  name: string;
  state?: "visible" | "hidden";
  rows: string[][];
}

function sheetXml(spec: SheetSpec): string {
  const rows = spec.rows
    .map((cells, rowIndex) => {
      const rowNumber = rowIndex + 1;
      const rendered = cells
        .map((value, columnIndex) => {
          const ref = `${columnName(columnIndex)}${rowNumber}`;
          const preserved = /^\s|\s$/.test(value) ? ' xml:space="preserve"' : "";
          return `<c r="${ref}" t="inlineStr"><is><t${preserved}>${escapeXml(value)}</t></is></c>`;
        })
        .join("");
      return `<row r="${rowNumber}">${rendered}</row>`;
    })
    .join("");
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="${NS.main}" xmlns:r="${NS.relationship}"><sheetData>${rows}</sheetData></worksheet>`;
}

async function buildWorkbook(sheets: SheetSpec[]): Promise<Buffer> {
  const zip = new JSZip();
  const sheetEntries = sheets
    .map(
      (sheet, index) =>
        `<sheet name="${escapeXml(sheet.name)}" sheetId="${index + 1}"${
          sheet.state === "hidden" ? ' state="hidden"' : ""
        } r:id="rId${index + 1}"/>`
    )
    .join("");

  zip.file(
    "[Content_Types].xml",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="${NS.contentTypes}">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
  ${sheets
    .map(
      (_, index) =>
        `<Override PartName="/xl/worksheets/sheet${index + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`
    )
    .join("")}
  <Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>
</Types>`,
    { date: FIXED_ZIP_DATE }
  );
  zip.file(
    "_rels/.rels",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="${NS.packageRelationship}">
  <Relationship Id="rId1" Type="${NS.relationship}/officeDocument" Target="xl/workbook.xml"/>
</Relationships>`,
    { date: FIXED_ZIP_DATE }
  );
  zip.file(
    "xl/workbook.xml",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="${NS.main}" xmlns:r="${NS.relationship}"><sheets>${sheetEntries}</sheets></workbook>`,
    { date: FIXED_ZIP_DATE }
  );
  zip.file(
    "xl/_rels/workbook.xml.rels",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="${NS.packageRelationship}">
  ${sheets
    .map(
      (_, index) =>
        `<Relationship Id="rId${index + 1}" Type="${NS.relationship}/worksheet" Target="worksheets/sheet${index + 1}.xml"/>`
    )
    .join("")}
  <Relationship Id="rIdT" Type="${NS.relationship}/styles" Target="styles.xml"/>
</Relationships>`,
    { date: FIXED_ZIP_DATE }
  );
  zip.file(
    "xl/styles.xml",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="${NS.main}"><fonts count="1"><font><sz val="11"/><name val="Calibri"/></font></fonts><fills count="1"><fill><patternFill patternType="none"/></fill></fills><borders count="1"><border/></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/></cellXfs></styleSheet>`,
    { date: FIXED_ZIP_DATE }
  );
  for (const [index, sheet] of sheets.entries()) {
    zip.file(`xl/worksheets/sheet${index + 1}.xml`, sheetXml(sheet), { date: FIXED_ZIP_DATE });
  }
  for (const entry of Object.values(zip.files)) {
    entry.date = FIXED_ZIP_DATE;
  }
  return zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
}

function csvRow(values: string[]): string {
  return values
    .map((value) => (/[",\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value))
    .join(",");
}

function vipDataRow(overrides: Record<string, string> = {}): string[] {
  const headers = vipHeaders();
  const values = headers.map((header) => overrides[header] ?? "");
  const dateIndex = headers.indexOf("日期");
  if (dateIndex >= 0 && !overrides["日期"]) values[dateIndex] = "2026/08/09";
  return values;
}

async function writeText(dir: string, fileName: string, content: string | Buffer): Promise<void> {
  await mkdir(dir, { recursive: true });
  const bytes = typeof content === "string" ? Buffer.from(content, "utf8") : content;
  await writeFile(path.join(dir, fileName), bytes);
  console.log(`${path.join(dir, fileName)}: ${bytes.byteLength} bytes`);
}

async function main(): Promise<void> {
  const headers = vipHeaders();

  // 1. vip-invalid-missing-column.csv: header is missing the required 日期 column.
  await writeText(
    STRUCTURED_DIR,
    "vip-invalid-missing-column.csv",
    [csvRow(headers.filter((header) => header !== "日期")), csvRow(vipDataRow())].join("\n") + "\n"
  );

  // 2. vip-invalid-unknown-column.csv: header contains a column not in the registry.
  await writeText(
    STRUCTURED_DIR,
    "vip-invalid-unknown-column.csv",
    [csvRow([...headers, "不存在的列"]), csvRow([...vipDataRow(), "x"])].join("\n") + "\n"
  );

  // 3. vip-invalid-cell-type.csv: 充值笔数 must be numeric; "abc" fails cell typing.
  await writeText(
    STRUCTURED_DIR,
    "vip-invalid-cell-type.csv",
    [csvRow(headers), csvRow(vipDataRow({ 充值笔数: "abc" }))].join("\n") + "\n"
  );

  // 4. structured-invalid-not-utf8.csv: Latin-1 bytes are not valid UTF-8 text.
  await writeText(
    STRUCTURED_DIR,
    "structured-invalid-not-utf8.csv",
    Buffer.from("日期,周\n2026/08/09,2026第32周\n", "latin1")
  );

  // 5. structured-invalid-empty.csv: no header or data rows at all.
  await writeText(STRUCTURED_DIR, "structured-invalid-empty.csv", "");

  // 6. structured-invalid-not-xlsx.xlsx: plain text with an .xlsx name (no ZIP signature).
  await writeText(XLSX_DIR, "structured-invalid-not-xlsx.xlsx", "this is not a real xlsx file");

  // 7. vip-invalid-header-not-in-first10.xlsx: header only appears after 11 junk rows.
  await writeText(
    XLSX_DIR,
    "vip-invalid-header-not-in-first10.xlsx",
    await buildWorkbook([
      {
        name: "会员主题",
        rows: [
          ...Array.from({ length: 11 }, (_, index) => [`标题${index + 1}`]),
          headers,
          vipDataRow()
        ]
      }
    ])
  );

  // 8. vip-invalid-hidden-sheet.xlsx: a non-empty hidden worksheet is rejected.
  await writeText(
    XLSX_DIR,
    "vip-invalid-hidden-sheet.xlsx",
    await buildWorkbook([
      { name: "Visible", rows: [headers, vipDataRow()] },
      { name: "Hidden", state: "hidden", rows: [headers, vipDataRow()] }
    ])
  );

  console.log("Generated rejected-upload fixtures");
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
