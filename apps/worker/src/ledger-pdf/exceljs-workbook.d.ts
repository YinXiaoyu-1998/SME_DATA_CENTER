declare module "exceljs/lib/doc/workbook.js" {
  import type ExcelJS from "exceljs";

  const Workbook: typeof ExcelJS.Workbook;
  export default Workbook;
}
