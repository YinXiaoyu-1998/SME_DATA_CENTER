import { describe, expect, it } from "vitest";
import { AliyunOssStorageAdapter } from "./aliyun-oss-storage.js";
import { createStorageAdapter } from "./storage-factory.js";
import { LocalFileSystemStorageAdapter } from "./local-storage.js";

describe("createStorageAdapter", () => {
  it("keeps local filesystem storage available through STORAGE_DRIVER=local", () => {
    const adapter = createStorageAdapter({
      STORAGE_DRIVER: "local",
      LOCAL_STORAGE_ROOT: ".data/test-storage"
    });

    expect(adapter).toBeInstanceOf(LocalFileSystemStorageAdapter);
  });

  it("selects Aliyun OSS through STORAGE_DRIVER=oss", () => {
    const adapter = createStorageAdapter({
      STORAGE_DRIVER: "oss",
      AWS_REGION: "oss-cn-beijing",
      AWS_ENDPOINT: "https://oss-cn-beijing.aliyuncs.com",
      AWS_S3_BUCKET: "test-bucket",
      AWS_ACCESS_KEY_ID: "test-access-key",
      AWS_SECRET_ACCESS_KEY: "test-secret-key"
    });

    expect(adapter).toBeInstanceOf(AliyunOssStorageAdapter);
  });

  it("fails fast for missing OSS configuration without including credential values", () => {
    expect(() =>
      createStorageAdapter({
        STORAGE_DRIVER: "oss",
        AWS_REGION: "oss-cn-beijing"
      })
    ).toThrow("AWS_ENDPOINT");
  });

  it("fails fast for an unsupported storage driver", () => {
    expect(() =>
      createStorageAdapter({
        STORAGE_DRIVER: "unknown"
      })
    ).toThrow("Unsupported STORAGE_DRIVER");
  });
});
