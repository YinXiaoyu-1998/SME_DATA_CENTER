import multipart from "@fastify/multipart";
import type { FastifyInstance } from "fastify";
import { PUBLIC_INPUT_LIMITS } from "@enterprise-hub/domain";

export interface MultipartFieldPart {
  type: "field";
  fieldname: string;
  value: unknown;
}

export interface MultipartFilePart {
  type: "file";
  fieldname: string;
  filename: string;
  mimetype?: string;
  file: AsyncIterable<Buffer | Uint8Array | string>;
}

export type MultipartPart = MultipartFieldPart | MultipartFilePart;

export function registerApiMultipart(
  app: FastifyInstance,
  input: { maxUploadBytes: number }
): void {
  void app.register(multipart, {
    limits: {
      fileSize: input.maxUploadBytes,
      files: PUBLIC_INPUT_LIMITS.multipartFiles,
      fields: PUBLIC_INPUT_LIMITS.multipartFields,
      parts: PUBLIC_INPUT_LIMITS.multipartParts
    }
  });
}

export async function readMultipartFile(file: MultipartFilePart["file"]): Promise<Buffer> {
  const chunks: Buffer[] = [];

  for await (const chunk of file) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  return Buffer.concat(chunks);
}
