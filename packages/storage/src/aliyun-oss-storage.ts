import { createHash } from "node:crypto";
import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CreateMultipartUploadCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
  UploadPartCommand
} from "@aws-sdk/client-s3";
import { createWriteStream } from "node:fs";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { assertSafeObjectKey, createOriginalObjectKey } from "./object-key.js";
import type {
  CreateDownloadUrlOptions,
  HeadObjectResult,
  PutObjectInput,
  StorageAdapter,
  StorageObject,
  PutObjectAtKeyInput
} from "./storage-adapter.js";

const DEFAULT_KEY_PREFIX = "smedc";
const DEFAULT_PRESIGN_EXPIRES_SECONDS = 900;
const HASH_METADATA_KEY = "smedc-sha256";

type RuntimeEnv = Readonly<Record<string, string | undefined>>;

export interface AliyunOssStorageAdapterOptions {
  env?: RuntimeEnv;
  region?: string;
  endpoint?: string;
  bucket?: string;
  accessKeyId?: string;
  secretAccessKey?: string;
  sessionToken?: string;
  keyPrefix?: string;
  forcePathStyle?: boolean;
  presignExpiresInSeconds?: number;
  client?: S3Client;
  presign?: typeof getSignedUrl;
}

/**
 * Stores SMEDC source objects in Alibaba Cloud OSS through its
 * S3-compatible API while keeping database object keys provider-neutral.
 */
export class AliyunOssStorageAdapter implements StorageAdapter {
  readonly bucket: string;
  readonly keyPrefix: string;
  readonly presignExpiresInSeconds: number;
  private readonly client: S3Client;
  private readonly presign: typeof getSignedUrl;

  constructor(options: AliyunOssStorageAdapterOptions = {}) {
    const env = options.env ?? process.env;
    const region = options.region ?? requireEnv(env, "AWS_REGION");
    const endpoint = options.endpoint ?? requireEnv(env, "AWS_ENDPOINT");
    const accessKeyId = options.accessKeyId ?? requireEnv(env, "AWS_ACCESS_KEY_ID");
    const secretAccessKey = options.secretAccessKey ?? requireEnv(env, "AWS_SECRET_ACCESS_KEY");
    const sessionToken = options.sessionToken ?? nonBlank(env["AWS_SESSION_TOKEN"]);

    this.bucket = options.bucket ?? requireEnv(env, "AWS_S3_BUCKET");
    this.keyPrefix = normalizeKeyPrefix(
      options.keyPrefix ?? nonBlank(env["AWS_S3_PREFIX"]) ?? DEFAULT_KEY_PREFIX
    );
    this.presignExpiresInSeconds =
      options.presignExpiresInSeconds ??
      parsePositiveInteger(
        env["AWS_S3_PRESIGN_EXPIRES_SECONDS"],
        "AWS_S3_PRESIGN_EXPIRES_SECONDS",
        DEFAULT_PRESIGN_EXPIRES_SECONDS
      );
    this.presign = options.presign ?? getSignedUrl;
    this.client =
      options.client ??
      new S3Client({
        region,
        endpoint,
        forcePathStyle:
          options.forcePathStyle ?? parseBoolean(env["AWS_S3_FORCE_PATH_STYLE"], false),
        credentials: {
          accessKeyId,
          secretAccessKey,
          ...(sessionToken ? { sessionToken } : {})
        },
        requestChecksumCalculation: "WHEN_REQUIRED",
        responseChecksumValidation: "WHEN_REQUIRED"
      });
  }

  async putObject(input: PutObjectInput): Promise<StorageObject> {
    const key = createOriginalObjectKey(input);
    const body = await bodyToBuffer(input.body);
    const hash = createHash("sha256").update(body).digest("hex");

    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: this.physicalKey(key),
        Body: body,
        ContentLength: body.byteLength,
        ContentType: input.contentType,
        Metadata: {
          [HASH_METADATA_KEY]: hash
        }
      })
    );

    return {
      key,
      size: body.byteLength,
      contentType: input.contentType,
      hash
    };
  }

  async getObjectStream(key: string): Promise<NodeJS.ReadableStream> {
    const response = await this.client.send(
      new GetObjectCommand({
        Bucket: this.bucket,
        Key: this.physicalKey(key)
      })
    );

    if (!response.Body || !(Symbol.asyncIterator in response.Body)) {
      throw new Error("OSS object response did not contain a readable body.");
    }

    return response.Body as NodeJS.ReadableStream;
  }

  async headObject(key: string): Promise<HeadObjectResult> {
    const physicalKey = this.physicalKey(key);
    try {
      const response = await this.client.send(
        new HeadObjectCommand({ Bucket: this.bucket, Key: physicalKey })
      );
      if (response.ContentLength === undefined) {
        throw new Error("OSS object metadata did not contain a content length.");
      }
      const hash = response.Metadata?.[HASH_METADATA_KEY];
      return { state: "found", size: response.ContentLength, ...(hash ? { hash } : {}) };
    } catch (error) {
      if (isMissingObject(error)) return { state: "not_found" };
      throw error;
    }
  }

  async statObject(key: string): Promise<StorageObject> {
    const response = await this.client.send(
      new HeadObjectCommand({
        Bucket: this.bucket,
        Key: this.physicalKey(key)
      })
    );

    if (response.ContentLength === undefined) {
      throw new Error("OSS object metadata did not contain a content length.");
    }

    const hash =
      response.Metadata?.[HASH_METADATA_KEY] ?? (await hashStream(await this.getObjectStream(key)));

    return {
      key,
      size: response.ContentLength,
      contentType: response.ContentType,
      hash
    };
  }

  async createDownloadUrl(key: string, options: CreateDownloadUrlOptions = {}): Promise<string> {
    return this.presign(
      this.client,
      new GetObjectCommand({
        Bucket: this.bucket,
        Key: this.physicalKey(key),
        ...(options.downloadFileName
          ? { ResponseContentDisposition: attachmentDisposition(options.downloadFileName) }
          : {})
      }),
      { expiresIn: options.expiresInSeconds ?? this.presignExpiresInSeconds }
    );
  }

  async createMultipartUpload(input: {
    key: string;
    contentType?: string;
    checksumSha256: string;
  }): Promise<{ uploadId: string }> {
    const result = await this.client.send(
      new CreateMultipartUploadCommand({
        Bucket: this.bucket,
        Key: this.physicalKey(input.key),
        ContentType: input.contentType,
        Metadata: { [HASH_METADATA_KEY]: input.checksumSha256 }
      })
    );
    if (!result.UploadId) throw new Error("OSS did not return a multipart upload ID.");
    return { uploadId: result.UploadId };
  }

  async createUploadPartUrl(input: {
    key: string;
    uploadId: string;
    partNumber: number;
    expiresInSeconds?: number;
  }): Promise<string> {
    return this.presign(
      this.client,
      new UploadPartCommand({
        Bucket: this.bucket,
        Key: this.physicalKey(input.key),
        UploadId: input.uploadId,
        PartNumber: input.partNumber
      }),
      { expiresIn: input.expiresInSeconds ?? this.presignExpiresInSeconds }
    );
  }

  async completeMultipartUpload(input: {
    key: string;
    uploadId: string;
    parts: Array<{ partNumber: number; etag: string }>;
  }): Promise<void> {
    await this.client.send(
      new CompleteMultipartUploadCommand({
        Bucket: this.bucket,
        Key: this.physicalKey(input.key),
        UploadId: input.uploadId,
        MultipartUpload: {
          Parts: [...input.parts]
            .sort((a, b) => a.partNumber - b.partNumber)
            .map((part) => ({
              PartNumber: part.partNumber,
              ETag: part.etag
            }))
        }
      })
    );
  }

  async abortMultipartUpload(input: { key: string; uploadId: string }): Promise<void> {
    await this.client.send(
      new AbortMultipartUploadCommand({
        Bucket: this.bucket,
        Key: this.physicalKey(input.key),
        UploadId: input.uploadId
      })
    );
  }

  async putObjectAtKey(input: PutObjectAtKeyInput): Promise<StorageObject> {
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: this.physicalKey(input.key),
        Body: input.body,
        ContentLength: input.contentLength,
        ContentType: input.contentType,
        Metadata: { [HASH_METADATA_KEY]: input.checksumSha256 }
      })
    );
    return {
      key: input.key,
      size: input.contentLength,
      hash: input.checksumSha256,
      contentType: input.contentType
    };
  }

  async downloadObjectToFile(key: string, filePath: string): Promise<StorageObject> {
    await mkdir(path.dirname(filePath), { recursive: true });
    await pipeline(await this.getObjectStream(key), createWriteStream(filePath));
    return this.statObject(key);
  }

  async deleteObject(key: string): Promise<void> {
    await this.client.send(
      new DeleteObjectCommand({
        Bucket: this.bucket,
        Key: this.physicalKey(key)
      })
    );
  }

  private physicalKey(key: string): string {
    assertSafeObjectKey(key);
    const physicalKey = this.keyPrefix ? `${this.keyPrefix}/${key}` : key;
    if (Buffer.byteLength(physicalKey, "utf8") > 1023) {
      throw new Error(
        /^org\/[^/]+\/ledger_records\//.test(key)
          ? "LEDGER_OBJECT_KEY_TOO_LONG"
          : "Storage object key exceeds the 1023-byte limit."
      );
    }
    return physicalKey;
  }
}

function isMissingObject(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const failure = error as {
    $metadata?: { httpStatusCode?: number };
    name?: string;
    Code?: string;
    code?: string;
  };
  const status = failure.$metadata?.httpStatusCode;
  if (status !== undefined) return status === 404;
  return (
    failure.name === "NoSuchKey" || failure.Code === "NoSuchKey" || failure.code === "NoSuchKey"
  );
}

function attachmentDisposition(fileName: string): string {
  return `attachment; filename*=UTF-8''${encodeURIComponent(fileName)}`;
}

async function bodyToBuffer(body: PutObjectInput["body"]): Promise<Buffer> {
  if (typeof body === "string") {
    return Buffer.from(body);
  }

  if (body instanceof Uint8Array) {
    return Buffer.from(body);
  }

  const chunks: Buffer[] = [];
  const stream = body as AsyncIterable<Buffer | Uint8Array | string>;

  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  return Buffer.concat(chunks);
}

async function hashStream(stream: NodeJS.ReadableStream): Promise<string> {
  const hash = createHash("sha256");

  for await (const chunk of stream as AsyncIterable<Buffer | Uint8Array | string>) {
    hash.update(chunk);
  }

  return hash.digest("hex");
}

function normalizeKeyPrefix(prefix: string): string {
  const normalized = prefix.replace(/^\/+|\/+$/g, "");

  if (!normalized) {
    return "";
  }

  try {
    assertSafeObjectKey(normalized);
  } catch {
    throw new Error("AWS_S3_PREFIX contains unsafe object-key segments.");
  }

  return normalized;
}

function requireEnv(env: RuntimeEnv, name: string): string {
  const value = nonBlank(env[name]);

  if (!value) {
    throw new Error(`${name} is required when STORAGE_DRIVER=oss.`);
  }

  return value;
}

function nonBlank(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized ? normalized : undefined;
}

function parseBoolean(value: string | undefined, defaultValue: boolean): boolean {
  const normalized = nonBlank(value)?.toLowerCase();

  if (!normalized) return defaultValue;
  if (normalized === "true") return true;
  if (normalized === "false") return false;
  throw new Error("AWS_S3_FORCE_PATH_STYLE must be true or false.");
}

function parsePositiveInteger(
  value: string | undefined,
  name: string,
  defaultValue: number
): number {
  const normalized = nonBlank(value);

  if (!normalized) return defaultValue;

  const parsed = Number(normalized);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer.`);
  }

  return parsed;
}
