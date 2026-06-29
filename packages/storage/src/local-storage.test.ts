import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { LocalFileSystemStorageAdapter } from "./local-storage.js";

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
    if (storageRoot) {
      await rm(storageRoot, { force: true, recursive: true });
      storageRoot = undefined;
    }
  });

  it("stores, stats, reads, and creates a local download URL for original file bytes", async () => {
    storageRoot = await mkdtemp(path.join(tmpdir(), "enterprise-hub-storage-"));
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

    const stat = await adapter.statObject(storedObject.key);
    expect(stat).toEqual(storedObject);

    const readBytes = await readStream(await adapter.getObjectStream(storedObject.key));
    expect(readBytes).toEqual(originalBytes);

    const downloadUrl = await adapter.createDownloadUrl(storedObject.key);
    expect(downloadUrl).toMatch(/^file:\/\//);
    expect(fileURLToPath(downloadUrl)).toBe(physicalFilePath);
  });

  it("does not keep stale content type metadata when an object is overwritten without content type", async () => {
    storageRoot = await mkdtemp(path.join(tmpdir(), "enterprise-hub-storage-"));
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
  });
});
