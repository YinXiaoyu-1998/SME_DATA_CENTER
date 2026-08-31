import { createHash } from "node:crypto";
import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { assertSafeObjectKey, createOriginalObjectKey } from "./object-key.js";
import type {
  CreateDownloadUrlOptions,
  PutObjectInput,
  StorageAdapter,
  StorageObject
} from "./storage-adapter.js";

const DEFAULT_KEY_PREFIX = "enterprise-hub";
const DEFAULT_PRESIGN_EXPIRES_SECONDS = 900;
const HASH_METADATA_KEY = "enterprise-hub-sha256";

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
 * Stores Enterprise Hub source objects in Alibaba Cloud OSS through its
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
    return this.keyPrefix ? `${this.keyPrefix}/${key}` : key;
  }
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
