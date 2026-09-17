import JSZip from "jszip";
import { getStructuredRegistry } from "@smedc/domain";

const NS_MAIN = "http://schemas.openxmlformats.org/spreadsheetml/2006/main";
const NS_REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const NS_PKG = "http://schemas.openxmlformats.org/package/2006/relationships";
const NS_CT = "http://schemas.openxmlformats.org/package/2006/content-types";
const FIXED_ZIP_DATE = new Date("2026-01-01T00:00:00Z");

function columnName(index: number): string {
  let name = "";
  let value = index;
  while (value >= 0) {
    name = String.fromCharCode(65 + (value % 26)) + name;
    value = Math.floor(value / 26) - 1;
  }
  return name;
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/**
 * Build a dataset-valid dishes workbook with `dataRowCount` rows. Every cell is
 * a shared string; only a few business-meaningful columns carry distinct values
 * so the workbook stays representative without a huge shared string table.
 */
export async function buildSyntheticDishesXlsx(dataRowCount: number): Promise<Buffer> {
  const headers = getStructuredRegistry("dishes")
    .fields.filter((field) => field.inputSource === "file")
    .map((field) => field.sourceColumn);
  const shared = ["", ...headers, "2026-07-01", "2026-07-01 08:00:00", "合成门店", "合成菜品"];
  const sharedIndex = new Map(shared.map((value, index) => [value, index]));
  const cell = (column: number, row: number, text: string) =>
    `<c r="${columnName(column)}${row}" t="s"><v>${sharedIndex.get(text) ?? 0}</v></c>`;

  const headerCells = headers.map((header, column) => cell(column, 1, header)).join("");
  const dataRows: string[] = [];
  for (let rowNumber = 0; rowNumber < dataRowCount; rowNumber++) {
    const excelRow = rowNumber + 2;
    const cells: string[] = [];
    for (let column = 0; column < headers.length; column++) {
      let value = "";
      if (column === 0) value = "2026-07-01 08:00:00";
      else if (column === 1) value = "合成门店";
      else if (column === 10) value = "合成菜品";
      else if (column === 14) value = "2026-07-01";
      cells.push(cell(column, excelRow, value));
    }
    dataRows.push(`<row r="${excelRow}">${cells.join("")}</row>`);
  }

  const sheetXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="${NS_MAIN}" xmlns:r="${NS_REL}"><sheetData><row r="1">${headerCells}</row>${dataRows.join("")}</sheetData></worksheet>`;
  const sharedStringsXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<sst xmlns="${NS_MAIN}" count="${shared.length}" uniqueCount="${shared.length}">${shared
    .map((value) => `<si><t>${escapeXml(value)}</t></si>`)
    .join("")}</sst>`;
  const stylesXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="${NS_MAIN}"><fonts count="1"><font><sz val="11"/><name val="Calibri"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border/></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/></cellXfs></styleSheet>`;
  const workbookXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="${NS_MAIN}" xmlns:r="${NS_REL}"><sheets><sheet name="Data" sheetId="1" r:id="rId1"/></sheets></workbook>`;
  const workbookRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="${NS_PKG}"><Relationship Id="rId1" Type="${NS_REL}/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rIdS" Type="${NS_REL}/sharedStrings" Target="sharedStrings.xml"/><Relationship Id="rIdT" Type="${NS_REL}/styles" Target="styles.xml"/></Relationships>`;
  const contentTypes = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="${NS_CT}"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>`;
  const rootRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="${NS_PKG}"><Relationship Id="rId1" Type="${NS_REL}/officeDocument" Target="xl/workbook.xml"/></Relationships>`;

  const zip = new JSZip();
  zip.file("[Content_Types].xml", contentTypes, { date: FIXED_ZIP_DATE });
  zip.file("_rels/.rels", rootRels, { date: FIXED_ZIP_DATE });
  zip.file("xl/workbook.xml", workbookXml, { date: FIXED_ZIP_DATE });
  zip.file("xl/_rels/workbook.xml.rels", workbookRels, { date: FIXED_ZIP_DATE });
  zip.file("xl/worksheets/sheet1.xml", sheetXml, { date: FIXED_ZIP_DATE });
  zip.file("xl/sharedStrings.xml", sharedStringsXml, { date: FIXED_ZIP_DATE });
  zip.file("xl/styles.xml", stylesXml, { date: FIXED_ZIP_DATE });
  for (const entry of Object.values(zip.files)) entry.date = FIXED_ZIP_DATE;
  return zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
}
