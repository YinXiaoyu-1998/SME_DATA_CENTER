import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import {
  CreateMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  type S3Client
} from "@aws-sdk/client-s3";
import { describe, expect, it, vi } from "vitest";
import {
  AliyunOssStorageAdapter,
  type AliyunOssStorageAdapterOptions
} from "./aliyun-oss-storage.js";

interface FakeObject {
  body: Buffer;
  contentType?: string;
  metadata?: Record<string, string>;
}

function createFakeS3Client() {
  const objects = new Map<string, FakeObject>();
  const commands: unknown[] = [];

  const send = vi.fn(async (command: unknown) => {
    commands.push(command);

    if (command instanceof PutObjectCommand) {
      const body = Buffer.from(command.input.Body as Uint8Array);
      objects.set(command.input.Key ?? "", {
        body,
        contentType: command.input.ContentType,
        metadata: command.input.Metadata
      });
      return {};
    }

    if (command instanceof HeadObjectCommand) {
      const object = objects.get(command.input.Key ?? "");
      if (!object) throw new Error("not found");
      return {
        ContentLength: object.body.byteLength,
        ContentType: object.contentType,
        Metadata: object.metadata
      };
    }

    if (command instanceof GetObjectCommand) {
      const object = objects.get(command.input.Key ?? "");
      if (!object) throw new Error("not found");
      return { Body: Readable.from([object.body]) };
    }

    if (command instanceof DeleteObjectCommand) {
      objects.delete(command.input.Key ?? "");
      return {};
    }

    throw new Error(`Unexpected command ${command?.constructor.name}`);
  });

  return {
    client: { send } as unknown as S3Client,
    send,
    commands,
    objects
  };
}

async function readStream(stream: NodeJS.ReadableStream): Promise<Buffer> {
  const chunks: Buffer[] = [];

  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  return Buffer.concat(chunks);
}

describe("AliyunOssStorageAdapter", () => {
  it("stores, stats, reads, presigns, and deletes original bytes under an isolated prefix", async () => {
    const fake = createFakeS3Client();
    const presign = vi.fn(async () => "https://download.example.test/signed");
    const adapter = new AliyunOssStorageAdapter({
      bucket: "test-bucket",
      region: "oss-cn-beijing",
      endpoint: "https://oss-cn-beijing.aliyuncs.com",
      accessKeyId: "test-access-key",
      secretAccessKey: "test-secret-key",
      keyPrefix: "smedc-tests/",
      client: fake.client,
      presign: presign as unknown as NonNullable<AliyunOssStorageAdapterOptions["presign"]>
    });
    const originalBytes = Buffer.from("document bytes\nwith exact content", "utf8");

    const storedObject = await adapter.putObject({
      orgId: "default-org",
      documentId: "doc_123",
      fileName: "../store:baoli/../June Report.csv",
      body: Readable.from([originalBytes]),
      contentType: "text/csv"
    });

    expect(storedObject).toEqual({
      key: "org/default-org/documents/doc_123/original/June_Report.csv",
      size: originalBytes.byteLength,
      contentType: "text/csv",
      hash: createHash("sha256").update(originalBytes).digest("hex")
    });
    expect([...fake.objects.keys()]).toEqual([
      "smedc-tests/org/default-org/documents/doc_123/original/June_Report.csv"
    ]);
    await expect(adapter.statObject(storedObject.key)).resolves.toEqual(storedObject);
    await expect(readStream(await adapter.getObjectStream(storedObject.key))).resolves.toEqual(
      originalBytes
    );
    await expect(
      adapter.createDownloadUrl(storedObject.key, {
        expiresInSeconds: 86_400,
        downloadFileName: "检疫证明.png"
      })
    ).resolves.toBe("https://download.example.test/signed");
    expect(presign).toHaveBeenCalledWith(fake.client, expect.any(GetObjectCommand), {
      expiresIn: 86_400
    });
    const presignCalls = presign.mock.calls as unknown as unknown[][];
    const getObjectCommand = presignCalls[0]?.[1] as GetObjectCommand;
    expect(getObjectCommand.input).toMatchObject({
      ResponseContentDisposition:
        "attachment; filename*=UTF-8''%E6%A3%80%E7%96%AB%E8%AF%81%E6%98%8E.png"
    });

    await adapter.deleteObject(storedObject.key);
    expect(fake.objects.size).toBe(0);
  });

  it("replaces stale content type and keeps object keys logical when overwriting", async () => {
    const fake = createFakeS3Client();
    const adapter = new AliyunOssStorageAdapter({
      bucket: "test-bucket",
      region: "oss-cn-beijing",
      endpoint: "https://oss-cn-beijing.aliyuncs.com",
      accessKeyId: "test-access-key",
      secretAccessKey: "test-secret-key",
      keyPrefix: "smedc",
      client: fake.client
    });

    const first = await adapter.putObject({
      orgId: "default-org",
      documentId: "doc_123",
      fileName: "report.csv",
      body: "first",
      contentType: "text/csv"
    });
    const second = await adapter.putObject({
      orgId: "default-org",
      documentId: "doc_123",
      fileName: "report.csv",
      body: "second"
    });

    expect(second.key).toBe(first.key);
    expect(second.contentType).toBeUndefined();
    await expect(adapter.statObject(second.key)).resolves.toEqual(second);
  });

  it("rejects unsafe physical prefixes before issuing a request", () => {
    const fake = createFakeS3Client();

    expect(
      () =>
        new AliyunOssStorageAdapter({
          bucket: "test-bucket",
          region: "oss-cn-beijing",
          endpoint: "https://oss-cn-beijing.aliyuncs.com",
          accessKeyId: "test-access-key",
          secretAccessKey: "test-secret-key",
          keyPrefix: "../escape",
          client: fake.client
        })
    ).toThrow("unsafe");
    expect(fake.commands).toHaveLength(0);
  });
});

function metadataAdapter(client: S3Client, keyPrefix = "") {
  return new AliyunOssStorageAdapter({ ...metadataAdapterOptions(client), keyPrefix });
}

describe("OSS metadata-only HEAD", () => {
  it("returns metadata without downloading when checksum metadata is absent", async () => {
    const fake = createFakeS3Client();
    const adapter = metadataAdapter(fake.client);
    fake.objects.set("legacy/file.pdf", { body: Buffer.from("pdf") });
    await expect(adapter.headObject("legacy/file.pdf")).resolves.toEqual({
      state: "found",
      size: 3
    });
    expect(fake.commands).toHaveLength(1);
    expect(fake.commands[0]).toBeInstanceOf(HeadObjectCommand);
    const written = await adapter.putObject({
      orgId: "org_1",
      documentId: "doc_1",
      fileName: "file.pdf",
      body: "new"
    });
    await expect(adapter.headObject(written.key)).resolves.toEqual({
      state: "found",
      size: written.size,
      hash: written.hash
    });
  });

  it("preserves statObject payload fallback and multipart checksum metadata", async () => {
    const fake = createFakeS3Client();
    const adapter = metadataAdapter(fake.client);
    fake.objects.set("legacy/file.pdf", { body: Buffer.from("pdf") });
    await expect(adapter.statObject("legacy/file.pdf")).resolves.toMatchObject({
      hash: createHash("sha256").update("pdf").digest("hex")
    });
    expect(fake.commands[1]).toBeInstanceOf(GetObjectCommand);

    const hash = createHash("sha256").update("pdf").digest("hex");
    const send = vi
      .fn()
      .mockResolvedValueOnce({ UploadId: "upload-1" })
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({ ContentLength: 3, Metadata: { "smedc-sha256": hash } });
    const multipartAdapter = metadataAdapter({ send } as unknown as S3Client);
    const key = "org/org_1/ledger_records/store/file.pdf";
    const { uploadId } = await multipartAdapter.createMultipartUpload({
      key,
      checksumSha256: hash
    });
    await multipartAdapter.completeMultipartUpload({
      key,
      uploadId,
      parts: [{ partNumber: 1, etag: "part" }]
    });
    await expect(multipartAdapter.headObject(key)).resolves.toEqual({
      state: "found",
      size: 3,
      hash
    });
    const create = send.mock.calls[0]?.[0] as CreateMultipartUploadCommand;
    expect(create).toBeInstanceOf(CreateMultipartUploadCommand);
    expect(create.input.Metadata).toEqual({ "smedc-sha256": hash });
    expect(send.mock.calls[1]?.[0]).toBeInstanceOf(CompleteMultipartUploadCommand);
    expect(send.mock.calls[2]?.[0]).toBeInstanceOf(HeadObjectCommand);
  });

  it.each([
    { $metadata: { httpStatusCode: 404 }, name: "NotFound" },
    { name: "NoSuchKey" },
    { Code: "NoSuchKey" }
  ])("reports definitive absence: %j", async (failure) => {
    const send = vi.fn().mockRejectedValue(failure);
    const adapter = metadataAdapter({ send } as unknown as S3Client);
    await expect(adapter.headObject("org/org_1/ledger_records/store/file.pdf")).resolves.toEqual({
      state: "not_found"
    });
    expect(send).toHaveBeenCalledTimes(1);
  });

  it.each([
    { $metadata: { httpStatusCode: 403 }, name: "AccessDenied" },
    { $metadata: { httpStatusCode: 429 }, name: "TooManyRequests" },
    { $metadata: { httpStatusCode: 503 }, name: "SlowDown" },
    { name: "TimeoutError" },
    { code: "ECONNRESET" },
    { $metadata: { httpStatusCode: 403 }, name: "NoSuchKey" },
    new Error("not found")
  ])("preserves operational errors: %j", async (failure) => {
    const send = vi.fn().mockRejectedValue(failure);
    const adapter = metadataAdapter({ send } as unknown as S3Client);
    await expect(adapter.headObject("file.pdf")).rejects.toBe(failure);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("does not classify malformed successful metadata as missing", async () => {
    const send = vi.fn().mockResolvedValue({ Metadata: {} });
    await expect(
      metadataAdapter({ send } as unknown as S3Client).headObject("file.pdf")
    ).rejects.toThrow("content length");
  });
});

describe("OSS physical key byte budget", () => {
  it("accepts 1023 UTF-8 bytes including Unicode prefix and rejects 1024", async () => {
    const fake = createFakeS3Client();
    const adapter = metadataAdapter(fake.client, "企业");
    const key = `org/org_1/ledger_records/${"店".repeat(329)}${"x".repeat(2)}/a`;
    expect(Buffer.byteLength(`企业/${key}`)).toBe(1023);
    fake.objects.set(`企业/${key}`, { body: Buffer.from("pdf") });
    await expect(adapter.headObject(key)).resolves.toEqual({ state: "found", size: 3 });
    await expect(adapter.headObject(`${key}a`)).rejects.toThrow("LEDGER_OBJECT_KEY_TOO_LONG");
    expect(fake.commands).toHaveLength(1);
  });

  it("rejects over-budget keys before each object operation and signing", async () => {
    const fake = createFakeS3Client();
    const presign = vi.fn(async () => "signed");
    const adapter = new AliyunOssStorageAdapter({
      ...metadataAdapterOptions(fake.client),
      keyPrefix: "p",
      presign: presign as unknown as NonNullable<AliyunOssStorageAdapterOptions["presign"]>
    });
    const key = `org/org_1/ledger_records/${"店".repeat(340)}/file.pdf`;
    const calls = [
      () => adapter.headObject(key),
      () => adapter.statObject(key),
      () => adapter.getObjectStream(key),
      () => adapter.createDownloadUrl(key),
      () => adapter.deleteObject(key),
      () =>
        adapter.putObjectAtKey({
          key,
          body: Readable.from(["pdf"]),
          contentLength: 3,
          checksumSha256: "hash"
        }),
      () => adapter.createMultipartUpload({ key, checksumSha256: "hash" }),
      () => adapter.createUploadPartUrl({ key, uploadId: "id", partNumber: 1 }),
      () => adapter.completeMultipartUpload({ key, uploadId: "id", parts: [] }),
      () => adapter.abortMultipartUpload({ key, uploadId: "id" })
    ];
    for (const call of calls) await expect(call()).rejects.toThrow("LEDGER_OBJECT_KEY_TOO_LONG");
    await expect(
      adapter.putObject({
        orgId: "org_1",
        documentId: "doc_1",
        fileName: "x".repeat(1024),
        body: "pdf"
      })
    ).rejects.toThrow("Storage object key");
    expect(fake.commands).toHaveLength(0);
    expect(presign).not.toHaveBeenCalled();
  });

  it("keeps path traversal validation and uses generic errors outside scoped ledger paths", async () => {
    const fake = createFakeS3Client();
    const adapter = metadataAdapter(fake.client);
    await expect(adapter.headObject("org/org_1/ledger_records/../file.pdf")).rejects.toThrow(
      "unsafe"
    );
    await expect(adapter.headObject(`other/ledger_records/${"x".repeat(1024)}`)).rejects.toThrow(
      "Storage object key"
    );
    expect(fake.commands).toHaveLength(0);
  });
});

function metadataAdapterOptions(client: S3Client): AliyunOssStorageAdapterOptions {
  return {
    bucket: "test-bucket",
    region: "oss-cn-beijing",
    endpoint: "https://oss-cn-beijing.aliyuncs.com",
    accessKeyId: "test-access-key",
    secretAccessKey: "test-secret-key",
    client
  };
}
