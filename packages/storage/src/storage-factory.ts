import { AliyunOssStorageAdapter } from "./aliyun-oss-storage.js";
import { LocalFileSystemStorageAdapter } from "./local-storage.js";
import type { StorageAdapter } from "./storage-adapter.js";

type RuntimeEnv = Readonly<Record<string, string | undefined>>;

export function createStorageAdapter(env: RuntimeEnv = process.env): StorageAdapter {
  const driver = env["STORAGE_DRIVER"]?.trim().toLowerCase() || "local";

  if (driver === "local") {
    return new LocalFileSystemStorageAdapter({ root: env["LOCAL_STORAGE_ROOT"] });
  }

  if (driver === "oss") {
    return new AliyunOssStorageAdapter({ env });
  }

  throw new Error(`Unsupported STORAGE_DRIVER ${driver}. Expected local or oss.`);
}
