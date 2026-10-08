import { createHash } from "node:crypto";
import { readFile, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import JSZip from "jszip";
import { afterEach, describe, expect, it, vi } from "vitest";
import { downloadPartitionBundle } from "./partition-bundle.js";

const hash = (value: Buffer | string) => createHash("sha256").update(value).digest("hex");
const csv = Buffer.from("store,value\nA,1\n");
const fileName = `business_20260907_${"a".repeat(64)}.csv`;
const scope = {
  dataset: "business",
  enterpriseName: "Synthetic",
  startDate: "2026-09-07",
  endDate: "2026-09-07",
  storeNameContains: ["Store"]
};
const manifest = () => ({
  version: 1,
  ...scope,
  storeNameContains: undefined,
  filter: { storeNameContains: ["Store"] },
  partitionCount: 1,
  totalRowCount: "1",
  files: [
    {
      fileName,
      businessDate: scope.startDate,
      storeId: "001",
      storeName: "Store A",
      rowCount: "1",
      byteSize: String(csv.length),
      checksumSha256: hash(csv)
    }
  ]
});
async function fixture(change?: (zip: JSZip, data: ReturnType<typeof manifest>) => void) {
  const zip = new JSZip();
  const data = manifest();
  zip.file(fileName, csv);
  change?.(zip, data);
  zip.file("manifest.json", JSON.stringify(data));
  const bytes = await zip.generateAsync({
    type: "nodebuffer",
    compression: "STORE",
    platform: "UNIX"
  });
  return {
    bytes,
    metadata: {
      requestId: "req_1",
      status: "succeeded",
      scope,
      partitionCount: 1,
      totalRowCount: "1",
      totalByteSize: String(csv.length),
      expiresAt: "2099-01-01T00:00:00Z",
      archiveBounds: {
        maxRawByteSize: "268435456",
        maxManifestByteSize: 8388608,
        maxZipByteSize: "276829184"
      },
      downloadUrl: "https://storage.example/bundle",
      byteSize: String(bytes.length),
      checksumSha256: hash(bytes),
      urlExpiresAt: "2099-01-01T00:00:00Z"
    }
  };
}
const directories: string[] = [];
afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))
  );
});
function context(fetchImplementation: typeof fetch) {
  return {
    serviceUrl: "https://api.example",
    accessToken: "old",
    launcherVersion: "0.8.2",
    fetchImplementation
  };
}
describe("bounded partition bundles", () => {
  it("extracts verified files and a Python-compatible manifest without private URLs", async () => {
    const { bytes, metadata } = await fixture();
    const fetcher = vi.fn<typeof fetch>(async (url) =>
      String(url).includes("/url") ? Response.json(metadata) : new Response(new Uint8Array(bytes))
    );
    const result = await downloadPartitionBundle({ context: context(fetcher), requestId: "req_1" });
    directories.push(result.localDirectory);
    expect(await readFile(path.join(result.localDirectory, fileName))).toEqual(csv);
    expect(
      JSON.parse(await readFile(path.join(result.localDirectory, "manifest.json"), "utf8"))
    ).toMatchObject({
      ...JSON.parse(JSON.stringify(manifest())),
      totalRowCount: 1,
      files: [{ ...manifest().files[0], byteSize: csv.length, rowCount: 1 }]
    });
    expect(JSON.stringify(result)).not.toContain("https:");
    expect(await readdir(result.localDirectory)).toEqual([fileName, "manifest.json"]);
  });
  it.each([
    "archive checksum",
    "CSV checksum",
    "scope",
    "parent",
    "absolute",
    "symlink",
    "unknown",
    "too many",
    "raw bound",
    "uncompressed bytes",
    "duplicate"
  ])("rejects %s and removes invocation output without retry", async (kind) => {
    const before = await readdir(path.join(os.tmpdir(), "smedc-partition-extracts")).catch(
      () => []
    );
    const { bytes, metadata } = await fixture((zip, data) => {
      if (kind === "CSV checksum") data.files[0]!.checksumSha256 = "0".repeat(64);
      if (kind === "scope") data.enterpriseName = "Other";
      if (kind === "parent") zip.file("../evil.csv", "bad", { createFolders: false });
      if (kind === "absolute") zip.file("/evil.csv", "bad", { createFolders: false });
      if (kind === "symlink") zip.file(fileName, "target", { unixPermissions: 0o120777 });
      if (kind === "unknown") zip.file("unknown.csv", "bad");
      if (kind === "uncompressed bytes") zip.file(fileName, Buffer.alloc(csv.length + 1));
      if (kind === "duplicate") zip.file(fileName.replace("a".repeat(64), "b".repeat(64)), csv);
      if (kind === "too many") for (let i = 0; i < 2001; i++) zip.file(`extra${i}.csv`, "");
    });
    if (kind === "duplicate") {
      const needle = Buffer.from(fileName.replace("a".repeat(64), "b".repeat(64)));
      let offset = bytes.indexOf(needle);
      while (offset !== -1) {
        bytes.set(Buffer.from(fileName), offset);
        offset = bytes.indexOf(needle, offset + needle.length);
      }
      metadata.partitionCount = 2;
      metadata.totalByteSize = String(csv.length * 2);
      metadata.totalRowCount = "2";
      metadata.archiveBounds.maxZipByteSize = "276829696";
      metadata.checksumSha256 = hash(bytes);
    }
    if (kind === "archive checksum") metadata.checksumSha256 = "0".repeat(64);
    if (kind === "raw bound") metadata.archiveBounds.maxRawByteSize = "1";
    const fetcher = vi.fn<typeof fetch>(async (url) =>
      String(url).includes("/url") ? Response.json(metadata) : new Response(new Uint8Array(bytes))
    );
    await expect(
      downloadPartitionBundle({ context: context(fetcher), requestId: "req_1" })
    ).rejects.toThrow();
    expect(
      fetcher.mock.calls.filter(([url]) => String(url).includes("storage.example"))
    ).toHaveLength(kind === "raw bound" ? 0 : 1);
    expect(await readdir(path.join(os.tmpdir(), "smedc-partition-extracts"))).toEqual(before);
  });
  it("returns an empty compatible extract without requesting a ZIP", async () => {
    const { metadata } = await fixture();
    const zero = Object.fromEntries(
      Object.entries(metadata).filter(
        ([key]) => !["downloadUrl", "byteSize", "checksumSha256", "urlExpiresAt"].includes(key)
      )
    ) as Omit<typeof metadata, "downloadUrl" | "byteSize" | "checksumSha256" | "urlExpiresAt">;
    const fetcher = vi.fn<typeof fetch>(async () =>
      Response.json({
        ...zero,
        partitionCount: 0,
        totalRowCount: "0",
        totalByteSize: "0",
        archiveBounds: { ...zero.archiveBounds, maxZipByteSize: "276828672" }
      })
    );
    const result = await downloadPartitionBundle({ context: context(fetcher), requestId: "req_1" });
    directories.push(result.localDirectory);
    expect(result.files).toEqual([]);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});

it("removes the invocation directory and cancels the ZIP body on MCP cancellation", async () => {
  const { metadata } = await fixture();
  const root = path.join(os.tmpdir(), "smedc-partition-extracts");
  const before = await readdir(root).catch((): string[] => []);
  const cancel = vi.fn();
  const controller = new AbortController();
  let started!: () => void;
  const ready = new Promise<void>((resolve) => {
    started = resolve;
  });
  const fetcher = vi.fn<typeof fetch>(async (url) => {
    if (String(url).endsWith("/url")) return Response.json(metadata);
    started();
    return new Response(new ReadableStream({ cancel }));
  });
  const pending = downloadPartitionBundle({
    context: { ...context(fetcher), signal: controller.signal },
    requestId: "req_1"
  });
  const rejection = expect(pending).rejects.toThrow("cancelled");
  await ready;
  controller.abort(new Error("cancelled"));
  await rejection;
  expect(cancel).toHaveBeenCalledOnce();
  expect(fetcher).toHaveBeenCalledTimes(2);
  expect((await readdir(root)).filter((directory) => !before.includes(directory))).toEqual([]);
});
