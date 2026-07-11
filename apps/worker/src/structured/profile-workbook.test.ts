import { utils, write } from "xlsx";
import { describe, expect, test } from "vitest";
import { getStructuredRegistry } from "@enterprise-hub/domain";
import { profileStructuredWorkbook } from "./profile-workbook.js";

function workbookBuffer(sheets: Array<{ name: string; rows: unknown[][]; hidden?: boolean }>) {
  const workbook = utils.book_new();

  for (const sheet of sheets) {
    const worksheet = utils.aoa_to_sheet(sheet.rows);
    utils.book_append_sheet(workbook, worksheet, sheet.name);
  }

  workbook.Workbook = {
    Sheets: sheets.map((sheet) => ({ Hidden: sheet.hidden ? 1 : 0 }))
  };

  return Buffer.from(write(workbook, { type: "buffer", bookType: "xlsx" }) as ArrayBuffer);
}

describe("structured workbook profiling", () => {
  test("scans the first ten rows to find headers and includes hidden non-empty sheets", () => {
    const headers = getStructuredRegistry("dishes").fields.map((field) => field.sourceColumn);
    const buffer = workbookBuffer([
      { name: "visible", rows: [["title"], ["filters"], headers, ["2026-07-01"]] },
      { name: "hidden", hidden: true, rows: [["title"], ["filters"], headers, ["2026-07-02"]] },
      { name: "empty", rows: [] }
    ]);

    const profile = profileStructuredWorkbook({
      dataset: "dishes",
      fileName: "synthetic.xlsx",
      content: buffer
    });

    expect(profile.dataset).toBe("dishes");
    expect(profile.sheets).toEqual([
      expect.objectContaining({
        name: "visible",
        hidden: false,
        headerRowNumber: 3,
        columnCount: 51,
        dataRowCount: 1
      }),
      expect.objectContaining({
        name: "hidden",
        hidden: true,
        headerRowNumber: 3,
        columnCount: 51,
        dataRowCount: 1
      })
    ]);
    expect(profile.ignoredEmptySheets).toEqual(["empty"]);
  });

  test("rejects a non-empty sheet with a nonmatching structure", () => {
    const buffer = workbookBuffer([
      { name: "wrong", rows: [["title"], ["未知列", "菜品销售数量"]] }
    ]);

    expect(() =>
      profileStructuredWorkbook({
        dataset: "dishes",
        fileName: "bad.xlsx",
        content: buffer
      })
    ).toThrow(/VALIDATION_FAILED/);
  });
});
