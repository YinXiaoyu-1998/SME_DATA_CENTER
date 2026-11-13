import { createHash } from "node:crypto";
import { readFile, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { LEDGER_BUNDLE_LIMITS, LEDGER_BUNDLE_MAX_ZIP_BYTES } from "@smedc/domain";
import JSZip from "jszip";
import { afterEach, describe, expect, it, vi } from "vitest";
import { downloadLedgerPdfBundle } from "./ledger-pdf-transfer.js";

const hash = (value: Buffer | string) => createHash("sha256").update(value).digest("hex");
const pdf = Buffer.from("%PDF-1.4 synthetic ledger");
const storeName = "一号店";
const date = "2026-11-01";
const entryName = `${storeName}/${date}/食品经营单位进货台帐_${storeName}_${date}.pdf`;
const extractsRoot = path.join(os.tmpdir(), "smedc-ledger-extracts");

async function archive(entries: Array<[string, Buffer]>): Promise<Buffer> {
  const zip = new JSZip();
  for (const [name, data] of entries) zip.file(name, data, { createFolders: false });
  return zip.generateAsync({ type: "nodebuffer", compression: "STORE", platform: "UNIX" });
}

function linkFor(bytes: Buffer, overrides: Record<string, unknown> = {}) {
  return {
    requestId: "req_1",
    downloadUrl: "https://storage.example/bundle.zip",
    expiresAt: "2099-01-01T00:00:00Z",
    byteSize: bytes.length,
    checksumSha256: hash(bytes),
    ...overrides
  };
}

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))
  );
});

function context(fetchImplementation: typeof fetch, signal?: AbortSignal) {
  return {
    serviceUrl: "https://api.example",
    accessToken: "token",
    launcherVersion: "0.20.0",
    fetchImplementation,
    ...(signal ? { signal } : {})
  };
}

function fetcher(link: unknown, bytes: Buffer) {
  return vi.fn<typeof fetch>(async (url) =>
    String(url).includes("/download-url")
      ? Response.json(link)
      : new Response(new Uint8Array(bytes))
  );
}

async function extractDirectories(): Promise<string[]> {
  return (await readdir(extractsRoot).catch(() => [])).filter((name) =>
    name.startsWith("extract-")
  );
}

describe("ledger PDF bundle download", () => {
  it("verifies the archive, extracts the daily PDFs, and never returns the signed link", async () => {
    const bytes = await archive([[entryName, pdf]]);
    const result = await downloadLedgerPdfBundle({
      context: context(fetcher(linkFor(bytes), bytes)),
      requestId: "req_1"
    });
    directories.push(result.localDirectory);
    expect(result).toEqual({
      localDirectory: result.localDirectory,
      requestId: "req_1",
      fileCount: 1,
      files: [entryName]
    });
    expect(await readFile(path.join(result.localDirectory, entryName))).toEqual(pdf);
    const manifest = JSON.parse(
      await readFile(path.join(result.localDirectory, "manifest.json"), "utf8")
    );
    expect(manifest).toMatchObject({
      requestId: "req_1",
      byteSize: bytes.length,
      checksumSha256: hash(bytes),
      fileCount: 1,
      files: [{ storeName, purchaseDate: date, byteSize: pdf.length }]
    });
    expect(JSON.stringify(result)).not.toContain("https:");
    expect((await readdir(result.localDirectory)).sort()).toEqual(
      [storeName, "manifest.json"].sort()
    );
  });

  it("decodes the escaped store segment for the manifest while keeping the ZIP path", async () => {
    const escaped = "A%2FB%20";
    const name = `${escaped}/${date}/食品经营单位进货台帐_${escaped}_${date}.pdf`;
    const bytes = await archive([[name, pdf]]);
    const result = await downloadLedgerPdfBundle({
      context: context(fetcher(linkFor(bytes), bytes)),
      requestId: "req_1"
    });
    directories.push(result.localDirectory);
    expect(result.files).toEqual([name]);
    const manifest = JSON.parse(
      await readFile(path.join(result.localDirectory, "manifest.json"), "utf8")
    );
    expect(manifest.files[0].storeName).toBe("A/B ");
  });

  it("rejects an archive whose bytes do not match the signed checksum and leaves no output", async () => {
    const bytes = await archive([[entryName, pdf]]);
    const before = await extractDirectories();
    await expect(
      downloadLedgerPdfBundle({
        context: context(fetcher(linkFor(bytes, { checksumSha256: "b".repeat(64) }), bytes)),
        requestId: "req_1"
      })
    ).rejects.toMatchObject({ code: "LEDGER_PDF_BUNDLE_VERIFY_FAILED" });
    expect(await extractDirectories()).toEqual(before);
  });

  it("rejects a signed link that is expired, mismatched, or missing verification metadata", async () => {
    const bytes = await archive([[entryName, pdf]]);
    for (const candidate of [
      linkFor(bytes, { expiresAt: "2020-01-01T00:00:00Z" }),
      linkFor(bytes, { requestId: "req_other" }),
      {
        requestId: "req_1",
        downloadUrl: "https://storage.example/bundle.zip",
        expiresAt: "2099-01-01T00:00:00Z"
      },
      linkFor(bytes, { checksumSha256: "not-a-checksum" })
    ]) {
      await expect(
        downloadLedgerPdfBundle({ context: context(fetcher(candidate, bytes)), requestId: "req_1" })
      ).rejects.toMatchObject({ code: "LEDGER_PDF_BUNDLE_URL_INVALID" });
    }
  });

  it("rejects unsafe entries: unexpected layout or a non-statutory file name", async () => {
    for (const name of [
      `${storeName}/${date}/other.pdf`,
      `${storeName}/not-a-date/食品经营单位进货台帐_${storeName}_not-a-date.pdf`,
      `${storeName}/nested/${date}/食品经营单位进货台帐_${storeName}_${date}.pdf`,
      `${storeName}/${date}/食品经营单位进货台帐_${storeName}_${date}.xlsx`
    ]) {
      const bytes = await archive([[name, pdf]]);
      await expect(
        downloadLedgerPdfBundle({
          context: context(fetcher(linkFor(bytes), bytes)),
          requestId: "req_1"
        })
      ).rejects.toMatchObject({ code: "LEDGER_PDF_BUNDLE_VERIFY_FAILED" });
    }
  });

  it("rejects an empty archive instead of returning an empty result", async () => {
    const bytes = await archive([]);
    await expect(
      downloadLedgerPdfBundle({
        context: context(fetcher(linkFor(bytes), bytes)),
        requestId: "req_1"
      })
    ).rejects.toMatchObject({ code: "LEDGER_PDF_BUNDLE_VERIFY_FAILED" });
  });

  it("maps ZIP parser failures to verification errors and removes the output", async () => {
    const before = await extractDirectories();
    for (const bytes of [Buffer.from("not a ZIP"), await archive([[`../${entryName}`, pdf]])]) {
      await expect(
        downloadLedgerPdfBundle({
          context: context(fetcher(linkFor(bytes), bytes)),
          requestId: "req_1"
        })
      ).rejects.toMatchObject({ code: "LEDGER_PDF_BUNDLE_VERIFY_FAILED" });
    }
    expect(await extractDirectories()).toEqual(before);
  });

  it("allows ZIP overhead above the PDF size limit but rejects oversized metadata before transfer", async () => {
    const bytes = await archive([[entryName, pdf]]);
    const withinBudget = fetcher(
      linkFor(bytes, { byteSize: LEDGER_BUNDLE_LIMITS.bytes + 1 }),
      bytes
    );
    await expect(
      downloadLedgerPdfBundle({ context: context(withinBudget), requestId: "req_1" })
    ).rejects.toMatchObject({ code: "LEDGER_PDF_BUNDLE_VERIFY_FAILED" });
    expect(withinBudget).toHaveBeenCalledTimes(2); // ZIP fetch happened; the fixture is shorter than declared.

    const overBudget = fetcher(
      linkFor(bytes, { byteSize: LEDGER_BUNDLE_MAX_ZIP_BYTES + 1 }),
      bytes
    );
    await expect(
      downloadLedgerPdfBundle({ context: context(overBudget), requestId: "req_1" })
    ).rejects.toMatchObject({ code: "LEDGER_PDF_BUNDLE_LIMIT_EXCEEDED" });
    expect(overBudget).toHaveBeenCalledOnce();
  });

  it("propagates caller cancellation and removes partial output", async () => {
    const bytes = await archive([[entryName, pdf]]);
    const controller = new AbortController();
    const before = await extractDirectories();
    const pending = downloadLedgerPdfBundle({
      context: context(fetcher(linkFor(bytes), bytes), controller.signal),
      requestId: "req_1"
    });
    controller.abort();
    await expect(pending).rejects.toBeDefined();
    expect(await extractDirectories()).toEqual(before);
  });
});
