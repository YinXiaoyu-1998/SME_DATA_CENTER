import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { AliyunOssStorageAdapter } from "./aliyun-oss-storage.js";
import { createStorageAdapter } from "./storage-factory.js";

async function readStream(stream: NodeJS.ReadableStream): Promise<Buffer> {
  const chunks: Buffer[] = [];

  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  return Buffer.concat(chunks);
}

describe.runIf(process.env["RUN_OSS_INTEGRATION"] === "1")(
  "AliyunOssStorageAdapter live integration",
  () => {
    it("round-trips and removes an isolated test object through the configured driver", async () => {
      const adapter = createStorageAdapter(process.env);
      expect(adapter).toBeInstanceOf(AliyunOssStorageAdapter);

      const documentId = `live_${randomUUID().replaceAll("-", "_")}`;
      const originalBytes = Buffer.from(`enterprise-hub-live-oss-${randomUUID()}`, "utf8");
      let objectKey: string | undefined;

      try {
        const stored = await adapter.putObject({
          orgId: "live_test",
          documentId,
          fileName: "round-trip.txt",
          body: originalBytes,
          contentType: "text/plain"
        });
        objectKey = stored.key;

        await expect(adapter.statObject(stored.key)).resolves.toEqual(stored);
        await expect(readStream(await adapter.getObjectStream(stored.key))).resolves.toEqual(
          originalBytes
        );

        const downloadUrl = await adapter.createDownloadUrl(stored.key);
        const response = await fetch(downloadUrl);
        expect(response.status).toBe(200);
        await expect(Buffer.from(await response.arrayBuffer())).toEqual(originalBytes);
      } finally {
        if (objectKey) {
          await adapter.deleteObject(objectKey);
        }
      }

      await expect(adapter.statObject(objectKey ?? "missing")).rejects.toThrow();
    });
  }
);
