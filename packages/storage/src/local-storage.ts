import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { pathToFileURL } from "node:url";
import type { PutObjectInput, StorageAdapter, StorageObject } from "./storage-adapter.js";

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

  async createDownloadUrl(key: string): Promise<string> {
    return pathToFileURL(this.resolveObjectPath(key)).href;
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
}

export function createOriginalObjectKey(
  input: Pick<PutObjectInput, "orgId" | "documentId" | "fileName">
): string {
  const orgId = sanitizeStorageSegment(input.orgId, "orgId");
  const documentId = sanitizeStorageSegment(input.documentId, "documentId");
  const safeFileName = sanitizeFileName(input.fileName);

  return `org/${orgId}/documents/${documentId}/original/${safeFileName}`;
}

function sanitizeStorageSegment(value: string, fieldName: string): string {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) {
    throw new Error(`${fieldName} contains unsafe storage characters.`);
  }

  return value;
}

function sanitizeFileName(fileName: string): string {
  const baseName = path.basename(fileName.replaceAll("\\", "/"));
  const safeName = baseName
    .replace(/[^A-Za-z0-9._-]+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^[._-]+/, "")
    .replace(/[._-]+$/, "");

  return safeName || "file";
}

function assertSafeObjectKey(key: string): void {
  if (key.includes("\\") || path.isAbsolute(key)) {
    throw new Error("Storage object key must be relative.");
  }

  const segments = key.split("/");
  if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
    throw new Error("Storage object key contains unsafe path segments.");
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
  return `${objectPath}.metadata.json`;
}
