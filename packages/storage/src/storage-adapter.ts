export interface PutObjectInput {
  orgId: string;
  documentId: string;
  fileName: string;
  body: Buffer | Uint8Array | string | NodeJS.ReadableStream;
  contentType?: string;
}

export interface PutObjectAtKeyInput {
  key: string;
  body: Readable;
  contentLength: number;
  checksumSha256: string;
  contentType?: string;
}

export interface MultipartUploadPart {
  partNumber: number;
  etag: string;
}

export interface StorageObject {
  key: string;
  size: number;
  hash: string;
  contentType?: string;
}

export interface CreateDownloadUrlOptions {
  expiresInSeconds?: number;
  downloadFileName?: string;
}

export interface StorageAdapter {
  putObject(input: PutObjectInput): Promise<StorageObject>;
  getObjectStream(key: string): Promise<NodeJS.ReadableStream>;
  statObject(key: string): Promise<StorageObject>;
  createDownloadUrl(key: string, options?: CreateDownloadUrlOptions): Promise<string>;
  createMultipartUpload?(input: {
    key: string;
    contentType?: string;
    checksumSha256: string;
  }): Promise<{ uploadId: string }>;
  createUploadPartUrl?(input: {
    key: string;
    uploadId: string;
    partNumber: number;
    expiresInSeconds?: number;
  }): Promise<string>;
  completeMultipartUpload?(input: {
    key: string;
    uploadId: string;
    parts: MultipartUploadPart[];
  }): Promise<void>;
  abortMultipartUpload?(input: { key: string; uploadId: string }): Promise<void>;
  putObjectAtKey?(input: PutObjectAtKeyInput): Promise<StorageObject>;
  downloadObjectToFile?(key: string, filePath: string): Promise<StorageObject>;
  /** Bounded read-only inventory of one exact org directory; never a deletion selector. */
  listObjectKeys?(prefix: string): Promise<string[]>;
  deleteObject(key: string): Promise<void>;
}
import type { Readable } from "node:stream";
