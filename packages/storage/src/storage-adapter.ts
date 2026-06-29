export interface PutObjectInput {
  orgId: string;
  documentId: string;
  fileName: string;
  body: Buffer | Uint8Array | string | NodeJS.ReadableStream;
  contentType?: string;
}

export interface StorageObject {
  key: string;
  size: number;
  hash: string;
  contentType?: string;
}

export interface StorageAdapter {
  putObject(input: PutObjectInput): Promise<StorageObject>;
  getObjectStream(key: string): Promise<NodeJS.ReadableStream>;
  statObject(key: string): Promise<StorageObject>;
  createDownloadUrl(key: string): Promise<string>;
  deleteObject(key: string): Promise<void>;
}
