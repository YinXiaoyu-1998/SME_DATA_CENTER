import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, mkdtemp, rename, rm, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import ExcelJS from "exceljs";
import sharp, { type OutputInfo } from "sharp";
import { STRUCTURED_DATASET_REGISTRIES } from "@smedc/domain";
import type { LedgerPrintRow, LedgerSnapshot, RenderedLedgerPdf } from "@smedc/ledger-archive";

const MIB = 1024 * 1024;
const MAX_PHOTO_BYTES = 500 * MIB;
const MAX_PDF_BYTES = 200 * MIB;
const CONVERSION_TIMEOUT_MS = 180_000;
const profile = STRUCTURED_DATASET_REGISTRIES.delivery_ledger.presentation!;
const columnWidths = [18, 20, 12, 20, 16, 22, 14, 23, 30, 20, 16];

export class LedgerRenderError extends Error {
  constructor(
    public readonly code: string,
    message: string
  ) {
    super(message);
    this.name = "LedgerRenderError";
  }
}
function fail(code: string, message: string): never {
  throw new LedgerRenderError(code, message);
}
function checkAbort(signal?: AbortSignal) {
  if (signal?.aborted) fail("LEDGER_RENDER_ABORTED", "Ledger rendering cancelled");
}
function validateSnapshot(snapshot: LedgerSnapshot) {
  if (!snapshot.rows.length) fail("LEDGER_EMPTY", "No ledger rows to render");
  if (
    snapshot.rows.length > 10_000 ||
    snapshot.certificates.length > 200 ||
    snapshot.certificates.some(
      (photo) => !Number.isSafeInteger(photo.byteSize) || photo.byteSize < 0
    ) ||
    snapshot.certificates.reduce((sum, photo) => sum + photo.byteSize, 0) > MAX_PHOTO_BYTES
  ) {
    fail("LEDGER_LIMIT_EXCEEDED", "Ledger partition exceeds rendering limits");
  }
}
function printValue(value: string | null) {
  return value === null || value.trim().toLowerCase() === "null" ? "" : value;
}
function wrappedLines(text: string, width: number) {
  return text
    .split("\n")
    .reduce(
      (lines, part) =>
        lines +
        Math.max(
          1,
          Math.ceil(
            [...part].reduce(
              (length, character) => length + (character.codePointAt(0)! > 255 ? 2 : 1),
              0
            ) /
              (width - 2)
          )
        ),
      0
    );
}

// Split oversized fields across continuation rows; never truncate valid registry text.
function printSegments(text: string, width: number): string[] {
  const segments: string[] = [];
  let segment = "",
    lineWidth = 0,
    lines = 1;
  for (const character of text) {
    const units = character.codePointAt(0)! > 255 ? 2 : 1;
    const nextLines = lines + (character === "\n" || lineWidth + units > width - 2 ? 1 : 0);
    if (nextLines > 18) {
      segments.push(segment);
      segment = "";
      lineWidth = 0;
      lines = 1;
    }
    if (character === "\n") {
      lines++;
      lineWidth = 0;
    } else if (lineWidth + units > width - 2) {
      lines++;
      lineWidth = units;
    } else lineWidth += units;
    segment += character;
  }
  segments.push(segment);
  return segments;
}

/** The fixed workbook is an intermediate artifact; all cells remain literal text. */
export async function buildLedgerWorkbook(
  snapshot: LedgerSnapshot,
  certificateFiles: ReadonlyMap<string, string>,
  signal?: AbortSignal
): Promise<ExcelJS.Workbook> {
  validateSnapshot(snapshot);
  checkAbort(signal);
  let actualPhotoBytes = 0;
  for (const certificate of snapshot.certificates) {
    const path = certificateFiles.get(certificate.sourceDocumentId);
    if (!path) fail("LEDGER_IMAGE_INVALID", "Missing certificate image");
    const metadata = await stat(path).catch(() =>
      fail("LEDGER_IMAGE_INVALID", "Unavailable certificate image")
    );
    if (!metadata.isFile()) fail("LEDGER_IMAGE_INVALID", "Certificate must be a regular file");
    actualPhotoBytes += metadata.size;
    if (actualPhotoBytes > MAX_PHOTO_BYTES)
      fail("LEDGER_LIMIT_EXCEEDED", "Certificate images exceed input limit");
  }
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("食品进货台账", {
    pageSetup: {
      paperSize: 9,
      orientation: "landscape",
      fitToPage: true,
      fitToWidth: 1,
      fitToHeight: 0,
      printTitlesRow: "1:2",
      margins: { left: 0.25, right: 0.25, top: 0.35, bottom: 0.35, header: 0.1, footer: 0.1 }
    }
  });
  sheet.columns = columnWidths.map((width) => ({ width }));
  sheet.mergeCells("A1:K1");
  sheet.getCell("A1").value =
    `${profile.title} — ${snapshot.key.storeName} — ${snapshot.key.purchaseDate}`;
  sheet.getRow(1).height = 30;
  sheet.addRow(profile.columns.map((column) => column.displayName));
  sheet.getRow(2).height = 42;
  for (const input of snapshot.rows) {
    checkAbort(signal);
    const values = profile.columns.map((column) =>
      printValue(
        input[
          column.canonicalName as keyof Omit<LedgerPrintRow, "sourceSheetIndex" | "sourceRowNumber">
        ] as string | null
      )
    );
    const segments = values.map((value, index) => printSegments(value, columnWidths[index]!));
    for (
      let continuation = 0;
      continuation < Math.max(...segments.map((parts) => parts.length));
      continuation++
    ) {
      const partValues = segments.map((parts) => parts[continuation] ?? "");
      if (continuation > 0 && !partValues[0]) {
        partValues[0] =
          wrappedLines(values[0]!, columnWidths[0]!) <= 2 ? `${values[0]}（续）` : "（续）";
      }
      const row = sheet.addRow(partValues);
      row.height = Math.max(
        28,
        ...partValues.map((value, index) => wrappedLines(value, columnWidths[index]!) * 15 + 8)
      );
    }
  }
  sheet.eachRow((row) =>
    row.eachCell((cell) => {
      cell.font = { name: "Noto Sans CJK SC", size: 10, bold: row.number <= 2 };
      cell.numFmt = "@";
      cell.alignment = { vertical: "middle", wrapText: true };
      if (row.number > 1)
        cell.border = {
          top: { style: "thin" },
          bottom: { style: "thin" },
          left: { style: "thin" },
          right: { style: "thin" }
        };
    })
  );
  sheet.pageSetup.printArea = `A1:K${sheet.rowCount}`;
  sheet.headerFooter.oddFooter = "&C第 &P 页 / 共 &N 页";
  let imageBytesRead = 0;
  let normalizedBytes = 0;
  for (const [index, certificate] of snapshot.certificates.entries()) {
    checkAbort(signal);
    let normalized: { data: Buffer; info: OutputInfo };
    try {
      // Sequential bounded reads; normalize EXIF, preserve aspect, and never crop.
      const chunks: Buffer[] = [];
      for await (const chunk of createReadStream(
        certificateFiles.get(certificate.sourceDocumentId)!
      )) {
        checkAbort(signal);
        imageBytesRead += chunk.length;
        if (imageBytesRead > MAX_PHOTO_BYTES)
          fail("LEDGER_LIMIT_EXCEEDED", "Certificate images exceed input limit");
        chunks.push(chunk as Buffer);
      }
      const input = Buffer.concat(chunks);
      normalized = await sharp(input, { limitInputPixels: 40_000_000, failOn: "warning" })
        .rotate()
        .resize({ width: 2048, height: 2048, fit: "inside", withoutEnlargement: true })
        .png()
        .toBuffer({ resolveWithObject: true });
    } catch (error) {
      if (error instanceof LedgerRenderError) throw error;
      fail("LEDGER_IMAGE_INVALID", "Certificate image is corrupt or unsupported");
    }
    normalizedBytes += normalized.data.length;
    if (normalizedBytes > MAX_PHOTO_BYTES)
      fail("LEDGER_LIMIT_EXCEEDED", "Normalized certificate images exceed memory limit");
    const attachment = workbook.addWorksheet(`检疫附件${index + 1}`, {
      pageSetup: {
        paperSize: 9,
        orientation: "portrait",
        fitToPage: true,
        fitToWidth: 1,
        fitToHeight: 1,
        margins: { left: 0.25, right: 0.25, top: 0.35, bottom: 0.35, header: 0.1, footer: 0.1 }
      }
    });
    attachment.columns = Array.from({ length: 8 }, () => ({ width: 14 }));
    attachment.mergeCells("A1:H2");
    attachment.getCell("A1").value =
      `检疫证明 — 收货单号：${certificate.receiptId} — 照片 ${index + 1}`;
    attachment.getCell("A1").font = { name: "Noto Sans CJK SC", size: 14, bold: true };
    attachment.getCell("A1").alignment = { wrapText: true, vertical: "middle" };
    for (let row = 1; row <= 55; row++) attachment.getRow(row).height = 16;
    const scale = Math.min(700 / normalized.info.width, 800 / normalized.info.height);
    const width = normalized.info.width * scale,
      height = normalized.info.height * scale;
    const image = workbook.addImage({
      buffer: normalized.data as unknown as ExcelJS.Buffer,
      extension: "png"
    });
    attachment.addImage(image, {
      tl: { col: 0, row: 3 },
      ext: { width, height },
      editAs: "absolute"
    });
    attachment.pageSetup.printArea = "A1:H55";
  }
  return workbook;
}

/** Spawn without a shell and kill the complete POSIX process group on timeout/cancellation. */
export async function runLedgerTool(
  command: string,
  args: string[],
  options: { timeoutMs: number; signal?: AbortSignal }
): Promise<string> {
  checkAbort(options.signal);
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, {
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, LC_ALL: "C.UTF-8" }
    });
    let stdout = "",
      bytes = 0,
      failure: LedgerRenderError | undefined;
    const terminate = (error: LedgerRenderError) => {
      failure ??= error;
      if (child.pid) {
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch {
          child.kill("SIGKILL");
        }
      }
    };
    const abort = () =>
      terminate(new LedgerRenderError("LEDGER_RENDER_ABORTED", "Ledger rendering cancelled"));
    const timer = setTimeout(
      () =>
        terminate(new LedgerRenderError("LEDGER_RENDER_TIMEOUT", "Ledger conversion timed out")),
      options.timeoutMs
    );
    options.signal?.addEventListener("abort", abort, { once: true });
    if (options.signal?.aborted) abort();
    child.stdout.on("data", (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > MIB)
        terminate(new LedgerRenderError("LEDGER_RENDER_FAILED", "Converter output exceeded limit"));
      else stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > MIB)
        terminate(new LedgerRenderError("LEDGER_RENDER_FAILED", "Converter output exceeded limit"));
    });
    child.once("error", () => {
      failure ??= new LedgerRenderError("LEDGER_RENDER_FAILED", "Converter could not start");
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", abort);
      if (failure) reject(failure);
      else if (code !== 0)
        reject(new LedgerRenderError("LEDGER_RENDER_FAILED", "Converter exited unsuccessfully"));
      else resolvePromise(stdout);
    });
  });
}

export async function renderLedgerPdf(input: {
  snapshot: LedgerSnapshot;
  certificateFiles: ReadonlyMap<string, string>;
  workDirectory: string;
  signal?: AbortSignal;
}): Promise<RenderedLedgerPdf> {
  validateSnapshot(input.snapshot);
  checkAbort(input.signal);
  await mkdir(input.workDirectory, { recursive: true });
  const directory = await mkdtemp(join(resolve(input.workDirectory), "ledger-render-"));
  const candidate = join(directory, "ledger.pdf");
  let publishedPath: string | undefined;
  let result: RenderedLedgerPdf | undefined;
  let failed = false;
  let failure: unknown;
  try {
    const workbook = await buildLedgerWorkbook(
      input.snapshot,
      input.certificateFiles,
      input.signal
    );
    const xlsx = join(directory, "ledger.xlsx");
    await workbook.xlsx.writeFile(xlsx);
    checkAbort(input.signal);
    await runLedgerTool(
      "soffice",
      [
        `-env:UserInstallation=${pathToFileURL(join(directory, "profile")).href}`,
        "--headless",
        "--nologo",
        "--nodefault",
        "--nolockcheck",
        "--norestore",
        "--convert-to",
        "pdf:calc_pdf_Export",
        "--outdir",
        directory,
        xlsx
      ],
      { timeoutMs: CONVERSION_TIMEOUT_MS, signal: input.signal }
    );
    const info = await stat(candidate).catch(() =>
      fail("LEDGER_PDF_INVALID", "Converter produced no PDF")
    );
    if (!info.isFile() || !info.size) fail("LEDGER_PDF_INVALID", "Converter produced an empty PDF");
    if (info.size > MAX_PDF_BYTES) fail("LEDGER_LIMIT_EXCEEDED", "PDF exceeds output limit");
    const output = await runLedgerTool("pdfinfo", [candidate], {
      timeoutMs: 15_000,
      signal: input.signal
    });
    const pages = /^Pages:\s+(\d+)\s*$/m.exec(output);
    const pageCount = Number(pages?.[1]);
    if (!Number.isSafeInteger(pageCount) || pageCount < 1 + input.snapshot.certificates.length)
      fail("LEDGER_PDF_INVALID", "PDF page validation failed");
    const digest = createHash("sha256");
    for await (const chunk of createReadStream(candidate)) digest.update(chunk);
    checkAbort(input.signal);
    publishedPath = `${directory}.pdf`;
    await rename(candidate, publishedPath);
    result = {
      path: publishedPath,
      byteSize: info.size,
      checksumSha256: digest.digest("hex"),
      pageCount
    };
  } catch (error) {
    failed = true;
    failure = error;
  } finally {
    try {
      await rm(directory, { recursive: true, force: true });
    } catch (error) {
      if (!failed) {
        failed = true;
        failure = error;
      }
    }
  }
  if (failed) {
    if (publishedPath) await rm(publishedPath, { force: true });
    throw failure;
  }
  return result!;
}
