import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import {
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
      keyPrefix: "enterprise-hub-tests/",
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
      "enterprise-hub-tests/org/default-org/documents/doc_123/original/June_Report.csv"
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
      keyPrefix: "enterprise-hub",
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
