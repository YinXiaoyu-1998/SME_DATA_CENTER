import { chmod, mkdtemp, readFile, readdir, rm, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import ExcelJS from "exceljs";
import sharp from "sharp";
import { afterEach, describe, expect, it, vi } from "vitest";
import { STRUCTURED_DATASET_REGISTRIES } from "@smedc/domain";
import { buildLedgerWorkbook, renderLedgerPdf, runLedgerTool } from "./renderer.js";
import { syntheticSnapshot } from "../../../../fixtures/ledger-pdf/snapshot.js";

const directories: string[] = [];
async function scratch() {
  const path = await mkdtemp(join(tmpdir(), "smedc-render-test-"));
  directories.push(path);
  return path;
}
afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true }))
  );
});

describe("ledger PDF workbook", () => {
  it("prints registry columns, literal phones, blank nulls, and wrapped complete Chinese address", async () => {
    const snapshot = syntheticSnapshot(2);
    const workbook = await buildLedgerWorkbook(snapshot, new Map());
    const sheet = workbook.worksheets[0]!;
    expect(sheet.getRow(2).values).toEqual([
      undefined,
      ...STRUCTURED_DATASET_REGISTRIES.delivery_ledger.presentation!.columns.map(
        (column) => column.displayName
      )
    ]);
    expect(sheet.getCell("J3").value).toBe("00123");
    expect(sheet.getCell("J4").value).toBe("+86123");
    expect(sheet.getCell("C3").value).toBe("");
    expect(sheet.getCell("G3").value).toBe("");
    expect(sheet.getCell("I3").value).toBe(snapshot.rows[0]!.supplier_unit_address);
    expect(sheet.getCell("I3").alignment.wrapText).toBe(true);
    expect(sheet.getRow(3).height).toBeGreaterThan(24);
    expect(sheet.pageSetup.printTitlesRow).toBe("1:2");
    expect(sheet.pageSetup.fitToHeight).toBe(0);
    // XLSX reload proves phone strings and exact decimal strings survive serialization.
    const restored = new ExcelJS.Workbook();
    await restored.xlsx.load(await workbook.xlsx.writeBuffer());
    expect(restored.worksheets[0]!.getCell("D3").value).toBe("1234567890.123456789");
    expect(restored.worksheets[0]!.getCell("J3").value).toBe("00123");
  });

  it("prints valid 512-character Chinese fields as complete continuation rows", async () => {
    const snapshot = syntheticSnapshot(1);
    snapshot.rows[0]!.item_name = "食".repeat(512);
    snapshot.rows[0]!.supplier_unit_address = "址".repeat(512);
    const workbook = await buildLedgerWorkbook(snapshot, new Map());
    const sheet = workbook.worksheets[0]!;
    expect(sheet.rowCount).toBeGreaterThan(3);
    let names = "",
      addresses = "";
    for (let row = 3; row <= sheet.rowCount; row++) {
      names += sheet.getCell(`B${row}`).value ?? "";
      addresses += sheet.getCell(`I${row}`).value ?? "";
      expect(sheet.getRow(row).height).toBeLessThanOrEqual(300);
    }
    expect(names).toBe(snapshot.rows[0]!.item_name);
    expect(addresses).toBe(snapshot.rows[0]!.supplier_unit_address);
  });
  it("keeps wide Latin continuation chunks inside the font-width line bound", async () => {
    const snapshot = syntheticSnapshot(1);
    snapshot.rows[0]!.item_name = "W".repeat(512);
    snapshot.rows[0]!.supplier_unit_address = "M".repeat(512);
    const workbook = await buildLedgerWorkbook(snapshot, new Map());
    const sheet = workbook.worksheets[0]!;
    expect(String(sheet.getCell("B3").value).length).toBeLessThanOrEqual(162);
    expect(String(sheet.getCell("I3").value).length).toBeLessThanOrEqual(252);
    let names = "",
      addresses = "";
    for (let row = 3; row <= sheet.rowCount; row++) {
      names += sheet.getCell(`B${row}`).value ?? "";
      addresses += sheet.getCell(`I${row}`).value ?? "";
    }
    expect(names).toBe("W".repeat(512));
    expect(addresses).toBe("M".repeat(512));
  });
  it("adds one labelled attachment sheet per photo, auto-orients EXIF and preserves aspect ratio", async () => {
    const directory = await scratch();
    const imagePath = join(directory, "certificate.jpg");
    await sharp({ create: { width: 80, height: 40, channels: 3, background: "red" } })
      .jpeg()
      .withMetadata({ orientation: 6 })
      .toFile(imagePath);
    const snapshot = syntheticSnapshot(2, 3);
    snapshot.rows[1]!.receipt_id = "TEST-RECEIPT-002";
    snapshot.certificates[2]!.receiptId = "TEST-RECEIPT-002";
    const workbook = await buildLedgerWorkbook(
      snapshot,
      new Map(snapshot.certificates.map((c) => [c.sourceDocumentId, imagePath]))
    );
    expect(workbook.worksheets).toHaveLength(4);
    expect(workbook.worksheets.slice(1).map((s) => s.getCell("A1").value)).toEqual([
      "检疫证明 — 收货单号：TEST-RECEIPT-001 — 照片 1",
      "检疫证明 — 收货单号：TEST-RECEIPT-001 — 照片 2",
      "检疫证明 — 收货单号：TEST-RECEIPT-002 — 照片 1"
    ]);
    expect(workbook.worksheets[1]!.getCell("A1").value).toContain("TEST-RECEIPT-001");
    expect(workbook.worksheets[2]!.getCell("A1").value).toContain("TEST-RECEIPT-001");
    for (const sheet of workbook.worksheets.slice(1)) {
      const range = sheet.getImages()[0]!.range as ExcelJS.ImageRange & {
        ext: { width: number; height: number };
      };
      expect(range.ext!.width / range.ext!.height).toBeCloseTo(0.5);
    }
  });
});

describe("ledger render failures", () => {
  it("rejects empty or oversized partitions before conversion without leaving files", async () => {
    const directory = await scratch();
    await expect(
      renderLedgerPdf({
        snapshot: syntheticSnapshot(0),
        certificateFiles: new Map(),
        workDirectory: directory
      })
    ).rejects.toMatchObject({ code: "LEDGER_EMPTY" });
    const snapshot = syntheticSnapshot(1, 201);
    await expect(
      renderLedgerPdf({ snapshot, certificateFiles: new Map(), workDirectory: directory })
    ).rejects.toMatchObject({ code: "LEDGER_LIMIT_EXCEEDED" });
    const manyRows = syntheticSnapshot(1);
    manyRows.rows = Array(10001).fill(manyRows.rows[0]);
    await expect(
      renderLedgerPdf({ snapshot: manyRows, certificateFiles: new Map(), workDirectory: directory })
    ).rejects.toMatchObject({ code: "LEDGER_LIMIT_EXCEEDED" });
    const large = syntheticSnapshot(1, 1);
    large.certificates[0]!.byteSize = 500 * 1024 * 1024 + 1;
    await expect(
      renderLedgerPdf({ snapshot: large, certificateFiles: new Map(), workDirectory: directory })
    ).rejects.toMatchObject({ code: "LEDGER_LIMIT_EXCEEDED" });
    expect(await readdir(directory)).toEqual([]);
  });
  it("cleans the private directory after corrupt images or cancellation", async () => {
    const directory = await scratch();
    const corrupt = join(directory, "broken.png");
    await writeFile(corrupt, "invalid image");
    const snapshot = syntheticSnapshot(1, 1);
    await expect(
      renderLedgerPdf({
        snapshot,
        certificateFiles: new Map([[snapshot.certificates[0]!.sourceDocumentId, corrupt]]),
        workDirectory: directory
      })
    ).rejects.toMatchObject({ code: "LEDGER_IMAGE_INVALID" });
    await expect(
      renderLedgerPdf({
        snapshot: syntheticSnapshot(1),
        certificateFiles: new Map(),
        workDirectory: directory,
        signal: AbortSignal.abort()
      })
    ).rejects.toMatchObject({ code: "LEDGER_RENDER_ABORTED" });
    expect(await readdir(directory)).toEqual(["broken.png"]);
  });
  it("checks actual file sizes before reading oversized certificate inputs", async () => {
    const directory = await scratch();
    const path = join(directory, "large.png");
    await writeFile(path, "");
    await truncate(path, 500 * 1024 * 1024 + 1);
    const snapshot = syntheticSnapshot(1, 1);
    await expect(
      renderLedgerPdf({
        snapshot,
        certificateFiles: new Map([[snapshot.certificates[0]!.sourceDocumentId, path]]),
        workDirectory: directory
      })
    ).rejects.toMatchObject({ code: "LEDGER_LIMIT_EXCEEDED" });
    expect(await readdir(directory)).toEqual(["large.png"]);
  });
  it.each(["failed conversion", "invalid page count", "oversized PDF"])(
    "removes every candidate after %s",
    async (mode) => {
      const directory = await scratch();
      const bin = await scratch();
      const converter = join(bin, "soffice");
      await writeFile(
        converter,
        `#!${process.execPath}\nconst fs=require('node:fs'),p=require('node:path');const out=process.argv[process.argv.indexOf('--outdir')+1];const pdf=p.join(out,'ledger.pdf');fs.writeFileSync(pdf,'%PDF-synthetic');${mode === "oversized PDF" ? "fs.truncateSync(pdf,201*1024*1024)" : ""};process.exit(${mode === "failed conversion" ? 1 : 0});`
      );
      await chmod(converter, 0o755);
      const pdfinfo = join(bin, "pdfinfo");
      await writeFile(pdfinfo, `#!${process.execPath}\nconsole.log('Pages: 0');`);
      await chmod(pdfinfo, 0o755);
      vi.stubEnv("PATH", `${bin}:${process.env.PATH}`);
      const code =
        mode === "failed conversion"
          ? "LEDGER_RENDER_FAILED"
          : mode === "oversized PDF"
            ? "LEDGER_LIMIT_EXCEEDED"
            : "LEDGER_PDF_INVALID";
      await expect(
        renderLedgerPdf({
          snapshot: syntheticSnapshot(1),
          certificateFiles: new Map(),
          workDirectory: directory
        })
      ).rejects.toMatchObject({ code });
      expect(await readdir(directory)).toEqual([]);
    }
  );
  it("terminates a timed-out process group, including its child", async () => {
    const directory = await scratch();
    const marker = join(directory, "child-output");
    const code = `const {spawn}=require('node:child_process');spawn(process.execPath,['-e',${JSON.stringify(`setTimeout(()=>require('node:fs').writeFileSync(${JSON.stringify(marker)},'survived'),250)`)}],{stdio:'ignore'});setTimeout(()=>{},10000)`;
    await expect(
      runLedgerTool(process.execPath, ["-e", code], { timeoutMs: 80 })
    ).rejects.toMatchObject({ code: "LEDGER_RENDER_TIMEOUT" });
    await new Promise((resolve) => setTimeout(resolve, 350));
    await expect(readFile(marker)).rejects.toMatchObject({ code: "ENOENT" });
  });
});
