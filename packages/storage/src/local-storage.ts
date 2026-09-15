import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { pathToFileURL } from "node:url";
import { randomUUID } from "node:crypto";
import { assertSafeObjectKey, createOriginalObjectKey } from "./object-key.js";
import type {
  CreateDownloadUrlOptions,
  PutObjectInput,
  StorageAdapter,
  StorageObject,
  PutObjectAtKeyInput
} from "./storage-adapter.js";

interface LocalFileSystemStorageAdapterOptions {
  root?: string;
}

interface StoredObjectMetadata {
  contentType?: string;
}

export class LocalFileSystemStorageAdapter implements StorageAdapter {
  readonly root: string;

  constructor(options: LocalFileSystemStorageAdapterOptions = {}) {
    const root = options.root ?? process.env.LOCAL_STORAGE_ROOT;

    if (!root) {
      throw new Error("LOCAL_STORAGE_ROOT is required for local storage.");
    }

    this.root = path.resolve(root);
  }

  async putObject(input: PutObjectInput): Promise<StorageObject> {
    const key = createOriginalObjectKey(input);
    const targetPath = this.resolveObjectPath(key);
    await mkdir(path.dirname(targetPath), { recursive: true });

    const hash = createHash("sha256");
    let size = 0;
    const source = toReadable(input.body);

    source.on("data", (chunk: Buffer | string) => {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += bytes.byteLength;
      hash.update(bytes);
    });

    await pipeline(source, createWriteStream(targetPath));

    if (input.contentType) {
      await writeFile(
        metadataPathFor(targetPath),
        JSON.stringify({ contentType: input.contentType }, null, 2),
        "utf8"
      );
    } else {
      await rm(metadataPathFor(targetPath), { force: true });
    }

    return {
      key,
      size,
      contentType: input.contentType,
      hash: hash.digest("hex")
    };
  }

  async getObjectStream(key: string): Promise<NodeJS.ReadableStream> {
    return createReadStream(this.resolveObjectPath(key));
  }

  async statObject(key: string): Promise<StorageObject> {
    const objectPath = this.resolveObjectPath(key);
    const objectStat = await stat(objectPath);
    const hash = await hashFile(objectPath);
    const metadata = await readMetadata(objectPath);

    return {
      key,
      size: objectStat.size,
      contentType: metadata.contentType,
      hash
    };
  }

  async createDownloadUrl(key: string, options: CreateDownloadUrlOptions = {}): Promise<string> {
    void options;
    return pathToFileURL(this.resolveObjectPath(key)).href;
  }

  async createMultipartUpload(input: { key: string }): Promise<{ uploadId: string }> {
    assertSafeObjectKey(input.key);
    const uploadId = randomUUID();
    await mkdir(this.multipartDirectory(uploadId), { recursive: true });
    await writeFile(path.join(this.multipartDirectory(uploadId), "key"), input.key, "utf8");
    return { uploadId };
  }

  async createUploadPartUrl(input: {
    key: string;
    uploadId: string;
    partNumber: number;
  }): Promise<string> {
    await this.assertMultipartKey(input.uploadId, input.key);
    return pathToFileURL(
      path.join(this.multipartDirectory(input.uploadId), `${input.partNumber}.part`)
    ).href;
  }

  async completeMultipartUpload(input: {
    key: string;
    uploadId: string;
    parts: Array<{ partNumber: number; etag: string }>;
  }): Promise<void> {
    await this.assertMultipartKey(input.uploadId, input.key);
    const target = this.resolveObjectPath(input.key);
    await mkdir(path.dirname(target), { recursive: true });
    const output = createWriteStream(target);
    for (const part of [...input.parts].sort((a, b) => a.partNumber - b.partNumber)) {
      await pipeline(
        createReadStream(
          path.join(this.multipartDirectory(input.uploadId), `${part.partNumber}.part`)
        ),
        output,
        { end: false }
      );
    }
    output.end();
    await new Promise<void>((resolve, reject) => {
      output.once("finish", resolve);
      output.once("error", reject);
    });
    await rm(this.multipartDirectory(input.uploadId), { recursive: true, force: true });
  }

  async abortMultipartUpload(input: { key: string; uploadId: string }): Promise<void> {
    await this.assertMultipartKey(input.uploadId, input.key);
    await rm(this.multipartDirectory(input.uploadId), { recursive: true, force: true });
  }

  async putObjectAtKey(input: PutObjectAtKeyInput): Promise<StorageObject> {
    assertSafeObjectKey(input.key);
    const target = this.resolveObjectPath(input.key);
    const temporary = `${target}.${randomUUID()}.tmp`;
    await mkdir(path.dirname(target), { recursive: true });
    await pipeline(input.body, createWriteStream(temporary));
    const actual = await stat(temporary);
    const hash = await hashFile(temporary);
    if (actual.size !== input.contentLength || hash !== input.checksumSha256) {
      await rm(temporary, { force: true });
      throw new Error("Storage object size or checksum did not match the declared value.");
    }
    await rename(temporary, target);
    return { key: input.key, size: actual.size, hash, contentType: input.contentType };
  }

  async downloadObjectToFile(key: string, filePath: string): Promise<StorageObject> {
    await mkdir(path.dirname(filePath), { recursive: true });
    await pipeline(createReadStream(this.resolveObjectPath(key)), createWriteStream(filePath));
    return this.statObject(key);
  }

  async deleteObject(key: string): Promise<void> {
    const objectPath = this.resolveObjectPath(key);
    await Promise.all([
      rm(objectPath, { force: true }),
      rm(metadataPathFor(objectPath), { force: true })
    ]);
  }

  private resolveObjectPath(key: string): string {
    assertSafeObjectKey(key);
    const objectPath = path.resolve(this.root, key);
    const relativePath = path.relative(this.root, objectPath);

    if (relativePath.startsWith("..") || path.isAbsolute(relativePath)) {
      throw new Error("Storage object key escapes the storage root.");
    }

    return objectPath;
  }

  private multipartDirectory(uploadId: string): string {
    if (!/^[A-Za-z0-9-]+$/.test(uploadId)) throw new Error("Invalid multipart upload ID.");
    return path.join(this.root, ".multipart", uploadId);
  }

  private async assertMultipartKey(uploadId: string, key: string): Promise<void> {
    const expected = await readFile(path.join(this.multipartDirectory(uploadId), "key"), "utf8");
    if (expected !== key) throw new Error("Multipart upload key mismatch.");
  }
}

function toReadable(body: PutObjectInput["body"]): NodeJS.ReadableStream {
  if (typeof body === "string" || body instanceof Uint8Array) {
    return Readable.from([body]);
  }

  return body;
}

async function hashFile(filePath: string): Promise<string> {
  const hash = createHash("sha256");
  const stream = createReadStream(filePath);

  for await (const chunk of stream) {
    hash.update(chunk);
  }

  return hash.digest("hex");
}

async function readMetadata(objectPath: string): Promise<StoredObjectMetadata> {
  try {
    return JSON.parse(await readFile(metadataPathFor(objectPath), "utf8")) as StoredObjectMetadata;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return {};
    }

    throw error;
  }
}

function metadataPathFor(objectPath: string): string {
  const metadataFileName = `${path.basename(objectPath)}.metadata.json`;

  if (Buffer.byteLength(metadataFileName, "utf8") <= 255) {
    return path.join(path.dirname(objectPath), metadataFileName);
  }

  const digest = createHash("sha256")
    .update(path.basename(objectPath), "utf8")
    .digest("hex")
    .slice(0, 32);
  return path.join(path.dirname(objectPath), `.metadata-${digest}.json`);
}
