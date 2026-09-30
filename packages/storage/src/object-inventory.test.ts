import { mkdtemp, rm, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { LocalFileSystemStorageAdapter } from "./local-storage.js";
import { AliyunOssStorageAdapter } from "./aliyun-oss-storage.js";

describe("bounded object inventory", () => {
  it("lists only exact org directory while keeping neighbor objects", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "pdf-inventory-"));
    try {
      const storage = new LocalFileSystemStorageAdapter({ root });
      const a = await storage.putObject({
        orgId: "test-a",
        documentId: "doc",
        fileName: "a.pdf",
        body: "synthetic",
        contentType: "application/pdf"
      });
      await storage.putObject({
        orgId: "test-ab",
        documentId: "doc",
        fileName: "sentinel.pdf",
        body: "sentinel"
      });
      expect(await storage.listObjectKeys!("org/test-a/")).toEqual([a.key]);
      await expect(storage.listObjectKeys!("org/test-a")).rejects.toThrow();
      await expect(storage.listObjectKeys!("org/")).rejects.toThrow();
      await rm(path.join(root, "org/test-a"), { recursive: true });
      await symlink(path.join(root, "org/test-ab"), path.join(root, "org/test-a"));
      await expect(storage.listObjectKeys!("org/test-a/")).rejects.toThrow(/symbolic/);
      expect(
        (await storage.statObject("org/test-ab/documents/doc/original/sentinel.pdf")).size
      ).toBe(8);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  it("paginates OSS within one prefix and rejects dishonest/malformed replies", async () => {
    const send = vi
      .fn()
      .mockResolvedValueOnce({
        Contents: [{ Key: "smedc/org/test-a/x" }],
        IsTruncated: true,
        NextContinuationToken: "next"
      })
      .mockResolvedValueOnce({ Contents: [{ Key: "smedc/org/test-a/y" }], IsTruncated: false });
    const storage = new AliyunOssStorageAdapter({
      region: "test",
      endpoint: "https://test.invalid",
      accessKeyId: "test",
      secretAccessKey: "test",
      bucket: "test",
      client: { send } as never
    });
    expect(await storage.listObjectKeys!("org/test-a/")).toEqual(["org/test-a/x", "org/test-a/y"]);
    expect(send.mock.calls[0]![0].input.Prefix).toBe("smedc/org/test-a/");
    send.mockResolvedValueOnce({ Contents: [{ Key: "smedc/org/test-ab/sentinel" }] });
    await expect(storage.listObjectKeys!("org/test-a/")).rejects.toThrow();
  });
});
