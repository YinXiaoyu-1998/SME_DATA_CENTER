// The document workbook uses JSZip; the full ExcelJS entry also loads unused
// streaming archive readers/writers and their legacy filesystem dependencies.
export { default as Workbook } from "exceljs/lib/doc/workbook.js";
export type { Workbook as LedgerWorkbook, Buffer as WorkbookBuffer } from "exceljs";
