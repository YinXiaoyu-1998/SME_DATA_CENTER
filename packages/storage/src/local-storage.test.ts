import * as fs from "node:fs";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LocalFileSystemStorageAdapter } from "./local-storage.js";

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return { ...actual, createReadStream: vi.fn(actual.createReadStream) };
});

async function readStream(stream: NodeJS.ReadableStream): Promise<Buffer> {
  const chunks: Buffer[] = [];

  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  return Buffer.concat(chunks);
}

describe("LocalFileSystemStorageAdapter", () => {
  let storageRoot: string | undefined;

  afterEach(async () => {
    vi.restoreAllMocks();
    if (storageRoot) {
      await rm(storageRoot, { force: true, recursive: true });
      storageRoot = undefined;
    }
  });

  it("stores, stats, reads, and creates a local download URL for original file bytes", async () => {
    storageRoot = await mkdtemp(path.join(tmpdir(), "smedc-storage-"));
    const adapter = new LocalFileSystemStorageAdapter({ root: storageRoot });
    const originalBytes = Buffer.from("document bytes\nwith exact content", "utf8");

    const storedObject = await adapter.putObject({
      orgId: "default-org",
      documentId: "doc_123",
      fileName: "../store:baoli/../June Report.csv",
      body: originalBytes,
      contentType: "text/csv"
    });

    expect(storedObject).toEqual({
      key: "org/default-org/documents/doc_123/original/June_Report.csv",
      size: originalBytes.byteLength,
      contentType: "text/csv",
      hash: createHash("sha256").update(originalBytes).digest("hex")
    });

    const physicalFilePath = path.join(
      storageRoot,
      "org/default-org/documents/doc_123/original/June_Report.csv"
    );
    await expect(readFile(physicalFilePath)).resolves.toEqual(originalBytes);

    await expect(adapter.headObject(storedObject.key)).resolves.toEqual({
      state: "found",
      size: storedObject.size,
      hash: storedObject.hash
    });
    const stat = await adapter.statObject(storedObject.key);
    expect(stat).toEqual(storedObject);

    const readBytes = await readStream(await adapter.getObjectStream(storedObject.key));
    expect(readBytes).toEqual(originalBytes);

    const downloadUrl = await adapter.createDownloadUrl(storedObject.key);
    expect(downloadUrl).toMatch(/^file:\/\//);
    expect(fileURLToPath(downloadUrl)).toBe(physicalFilePath);
  });

  it("does not keep stale content type metadata when an object is overwritten without content type", async () => {
    storageRoot = await mkdtemp(path.join(tmpdir(), "smedc-storage-"));
    const adapter = new LocalFileSystemStorageAdapter({ root: storageRoot });

    const firstWrite = await adapter.putObject({
      orgId: "default-org",
      documentId: "doc_123",
      fileName: "report.csv",
      body: "first",
      contentType: "text/csv"
    });
    const secondBytes = Buffer.from("second", "utf8");

    const secondWrite = await adapter.putObject({
      orgId: "default-org",
      documentId: "doc_123",
      fileName: "report.csv",
      body: secondBytes
    });

    expect(secondWrite).toEqual({
      key: firstWrite.key,
      size: secondBytes.byteLength,
      hash: createHash("sha256").update(secondBytes).digest("hex")
    });
    await expect(adapter.statObject(secondWrite.key)).resolves.toEqual(secondWrite);
    await expect(adapter.headObject(secondWrite.key)).resolves.toEqual({
      state: "found",
      size: secondWrite.size,
      hash: secondWrite.hash
    });
  });

  it("stores content type metadata for a 255-character public filename", async () => {
    storageRoot = await mkdtemp(path.join(tmpdir(), "smedc-storage-"));
    const adapter = new LocalFileSystemStorageAdapter({ root: storageRoot });
    const fileName = `${"f".repeat(251)}.csv`;

    const storedObject = await adapter.putObject({
      orgId: "default-org",
      documentId: "doc_long_filename",
      fileName,
      body: "content",
      contentType: "text/csv"
    });

    expect(storedObject.key.endsWith(`/${fileName}`)).toBe(true);
    await expect(adapter.statObject(storedObject.key)).resolves.toEqual(storedObject);
    await adapter.deleteObject(storedObject.key);
    await expect(adapter.statObject(storedObject.key)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(adapter.headObject(storedObject.key)).resolves.toEqual({ state: "not_found" });
  });

  it("completes multipart sources and streams immutable partition objects", async () => {
    storageRoot = await mkdtemp(path.join(tmpdir(), "smedc-storage-"));
    const adapter = new LocalFileSystemStorageAdapter({ root: storageRoot });
    const sourceKey = "structured-import-staging/org_1/pjob_1/source";
    const multipart = await adapter.createMultipartUpload({
      key: sourceKey,
      contentType: "text/csv"
    });
    const firstUrl = await adapter.createUploadPartUrl({
      key: sourceKey,
      uploadId: multipart.uploadId,
      partNumber: 1
    });
    const secondUrl = await adapter.createUploadPartUrl({
      key: sourceKey,
      uploadId: multipart.uploadId,
      partNumber: 2
    });
    await writeFile(fileURLToPath(firstUrl), "first");
    await writeFile(fileURLToPath(secondUrl), "second");
    await adapter.completeMultipartUpload({
      key: sourceKey,
      uploadId: multipart.uploadId,
      parts: [
        { partNumber: 1, etag: "one" },
        { partNumber: 2, etag: "two" }
      ]
    });
    await expect(readStream(await adapter.getObjectStream(sourceKey))).resolves.toEqual(
      Buffer.from("firstsecond")
    );

    await expect(adapter.headObject(sourceKey)).resolves.toEqual({
      state: "found",
      size: 11,
      hash: createHash("sha256").update("firstsecond").digest("hex")
    });
    await expect(adapter.statObject(sourceKey)).resolves.toMatchObject({ contentType: "text/csv" });

    const bytes = Buffer.from("canonical\n");
    const hash = createHash("sha256").update(bytes).digest("hex");
    const key = "structured-partitions/org_1/pjob_1/part_1.csv";
    await adapter.putObjectAtKey({
      key,
      body: Readable.from([bytes]),
      contentLength: bytes.length,
      checksumSha256: hash,
      contentType: "text/csv"
    });
    await expect(adapter.headObject(key)).resolves.toEqual({
      state: "found",
      size: bytes.length,
      hash
    });
    await expect(adapter.statObject(key)).resolves.toMatchObject({ contentType: "text/csv" });
    const download = path.join(storageRoot, "download.csv");
    await expect(adapter.downloadObjectToFile(key, download)).resolves.toMatchObject({
      key,
      size: bytes.length,
      hash
    });
    await expect(readFile(download)).resolves.toEqual(bytes);
  });
  it("returns legacy size without opening payload when metadata is absent or stale", async () => {
    storageRoot = await mkdtemp(path.join(tmpdir(), "smedc-storage-"));
    const adapter = new LocalFileSystemStorageAdapter({ root: storageRoot });
    const key = "legacy/file.pdf";
    const target = path.join(storageRoot, key);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, "pdf");
    vi.mocked(fs.createReadStream).mockClear();
    const payloadRead = vi.mocked(fs.createReadStream).mockImplementation(() => {
      throw new Error("Payload read forbidden");
    });
    await expect(adapter.headObject(key)).resolves.toEqual({ state: "found", size: 3 });
    await writeFile(`${target}.metadata.json`, JSON.stringify({ size: 4, hash: "a".repeat(64) }));
    await expect(adapter.headObject(key)).resolves.toEqual({ state: "found", size: 3 });
    await writeFile(`${target}.metadata.json`, JSON.stringify({ size: 3, hash: "invalid" }));
    await expect(adapter.headObject(key)).resolves.toEqual({ state: "found", size: 3 });
    expect(payloadRead).not.toHaveBeenCalled();
    await expect(adapter.headObject("../escape")).rejects.toThrow("unsafe");
  });
});
