import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";
import { syntheticSnapshot } from "../../../../fixtures/ledger-pdf/snapshot.js";
import { renderLedgerPdf, runLedgerTool } from "./renderer.js";

/** Executable synthetic acceptance fixture, with all converters from the worker image. */
export async function verifySyntheticLedgerRender(directory: string) {
  await mkdir(directory, { recursive: true });
  const snapshot = syntheticSnapshot(80, 2);
  snapshot.rows[1]!.receipt_id = "TEST-RECEIPT-002";
  snapshot.certificates[1]!.receiptId = "TEST-RECEIPT-002";
  snapshot.rows[0]!.item_name = "锚".repeat(512);
  snapshot.rows[0]!.supplier_unit_address = "鎏".repeat(512);
  snapshot.rows[1]!.item_name = "W".repeat(512);
  snapshot.rows[1]!.supplier_unit_address = "M".repeat(512);
  const paths = new Map<string, string>();
  const originalChecksums = new Map<string, string>();
  for (const [index, certificate] of snapshot.certificates.entries()) {
    const path = join(directory, `synthetic-photo-${index}.png`);
    const color = index === 0 ? "#db2020" : "#2040db";
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="2560" height="1920"><rect width="2560" height="1920" fill="${color}"/><rect x="80" y="80" width="2400" height="1760" fill="none" stroke="white" stroke-width="12"/><g fill="white" font-family="Noto Sans CJK SC" font-size="120"><text x="180" y="360">合成检疫证明</text><text x="180" y="640">${certificate.receiptId}</text><text x="180" y="920">检疫结果：合成样本合格</text><text x="180" y="1200">日期：2026-10-04</text><text x="180" y="1480">照片 1 / 无真实业务数据</text></g></svg>`;
    await sharp(Buffer.from(svg)).png().toFile(path);
    paths.set(certificate.sourceDocumentId, path);
    originalChecksums.set(
      path,
      createHash("sha256")
        .update(await readFile(path))
        .digest("hex")
    );
  }
  const result = await renderLedgerPdf({
    snapshot,
    certificateFiles: paths,
    workDirectory: directory
  });
  for (const [path, checksum] of originalChecksums)
    assert.equal(
      createHash("sha256")
        .update(await readFile(path))
        .digest("hex"),
      checksum,
      "Original certificate changed"
    );
  assert.ok(
    !(await readdir(directory)).some(
      (name) => name.startsWith("ledger-render-") && !name.endsWith(".pdf")
    ),
    "Intermediate render directory leaked"
  );
  const text = await runLedgerTool("pdftotext", ["-raw", result.path, "-"], {
    timeoutMs: 15_000
  });
  const pages = text.split("\f").filter((page) => page.trim());
  assert.equal(pages.length, result.pageCount);
  assert.ok(pages.length > 3, "Fixture must span multiple body pages and two attachments");
  const compact = (value: string) => value.replace(/\s/g, "");
  const body = pages.slice(0, -2).map(compact);
  for (const page of body) {
    for (const header of [
      "收货单号",
      "食品名称",
      "规格",
      "进货数量",
      "进货金额",
      "生产日期或生产批号",
      "保质期",
      "供货单位名称",
      "供货单位地址",
      "供货单位联系方式",
      "进货日期"
    ]) {
      assert.ok(page.includes(header), `Missing repeated header: ${header}`);
    }
  }
  const bodyText = body.join("");
  for (const row of snapshot.rows.slice(2))
    assert.ok(bodyText.includes(row.item_name), `Missing row: ${row.item_name}`);
  for (const value of [
    "00123",
    "+86123",
    "1234567890.123456789",
    "12.3400",
    snapshot.rows[2]!.supplier_unit_address!
  ]) {
    assert.ok(bodyText.includes(value), `Lost or changed literal text: ${value}`);
  }
  assert.ok(!bodyText.includes("null"));
  assert.equal([...bodyText].filter((character) => character === "锚").length, 512);
  assert.equal([...bodyText].filter((character) => character === "鎏").length, 512);
  assert.equal([...bodyText].filter((character) => character === "W").length, 512);
  assert.equal([...bodyText].filter((character) => character === "M").length, 512);
  for (const [index, page] of pages.slice(-2).entries())
    assert.ok(
      compact(page).includes(`检疫证明—收货单号：${snapshot.certificates[index]!.receiptId}—照片1`)
    );
  const imageDirectory = join(directory, "pages");
  await mkdir(imageDirectory);
  await runLedgerTool(
    "pdftoppm",
    ["-scale-to", "1400", "-png", result.path, join(imageDirectory, "ledger")],
    { timeoutMs: 30_000 }
  );
  const images = (await readdir(imageDirectory)).filter((name) => name.endsWith(".png")).sort();
  assert.equal(images.length, result.pageCount);
  // Extracted text can include glyphs that Calc clips. Compare their geometry
  // against actual rasterized full-width row rules, not text completeness alone.
  const bbox = await runLedgerTool("pdftotext", ["-bbox", result.path, "-"], { timeoutMs: 15_000 });
  const bboxPages = [
    ...bbox.matchAll(/<page width="([\d.]+)" height="[\d.]+">([\s\S]*?)<\/page>/g)
  ];
  assert.equal(bboxPages.length, result.pageCount);
  let checkedWideWords = 0;
  for (const [index, page] of bboxPages.slice(0, -2).entries()) {
    const { data, info } = await sharp(await readFile(join(imageDirectory, images[index]!)))
      .removeAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    const scale = info.width / Number(page[1]);
    const rules: number[] = [];
    for (let y = 0; y < info.height; y++) {
      let dark = 0;
      for (let x = 0; x < info.width; x++)
        if (data[(y * info.width + x) * info.channels]! < 220) dark++;
      if (dark > info.width * 0.7) rules.push(y);
    }
    assert.ok(rules.length > 1, "No rasterized table row boundaries detected");
    for (const word of page[2]!.matchAll(
      /<word xMin="[\d.]+" yMin="([\d.]+)" xMax="[\d.]+" yMax="([\d.]+)">([WM]+)<\/word>/g
    )) {
      checkedWideWords++;
      const top = Number(word[1]) * scale,
        bottom = Number(word[2]) * scale;
      assert.ok(
        !rules.some((y) => y >= top - 1 && y <= bottom + 1),
        `Wide glyph overlaps a row boundary on page ${index + 1}: ${word[3]} (y=${top.toFixed(1)}..${bottom.toFixed(1)})`
      );
    }
  }
  assert.ok(checkedWideWords > 20, "Wide-glyph raster-bound regression was not exercised");
  for (const [index, file] of images.slice(-2).entries()) {
    const { data, info } = await sharp(await readFile(join(imageDirectory, file)))
      .removeAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    let pixels = 0;
    for (let offset = 0; offset < data.length; offset += info.channels) {
      const red = data[offset]!,
        blue = data[offset + 2]!;
      if (index === 0 ? red > 160 && blue < 100 : blue > 160 && red < 100) pixels++;
    }
    assert.ok(
      pixels > info.width * info.height * 0.1,
      "Certificate image missing or substantially clipped"
    );
  }
  return { ...result, imageDirectory };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.env.LEDGER_PDF_RENDER_INTEGRATION !== "1")
    throw new Error("Set LEDGER_PDF_RENDER_INTEGRATION=1 for synthetic conversion verification");
  const suppliedDirectory = process.env.LEDGER_PDF_OUTPUT_DIRECTORY;
  const directory = suppliedDirectory
    ? resolve(suppliedDirectory)
    : await mkdtemp(join(tmpdir(), "smedc-synthetic-render-"));
  try {
    process.stdout.write(`${JSON.stringify(await verifySyntheticLedgerRender(directory))}\n`);
  } finally {
    if (!suppliedDirectory) await rm(directory, { recursive: true, force: true });
  }
}
