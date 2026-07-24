import { AsyncEntry } from "@napi-rs/keyring";
import { mkdir, open, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { SecureCredentialStore } from "./auth.js";
import type { LauncherLock } from "./session.js";

const SERVICE_NAME = "com.smedatacenter.enterprise-hub.launcher";
const LOCK_WAIT_MS = 10_000;
const STALE_LOCK_MS = 30_000;

export function createKeychainCredentialStore(origin: string): SecureCredentialStore {
  const entry = new AsyncEntry(SERVICE_NAME, origin);
  return {
    get: async () => (await entry.getPassword()) ?? null,
    set: async (credential) => entry.setPassword(credential),
    delete: async () => {
      await entry.deleteCredential();
    }
  };
}

export function createCrossProcessLock(origin: string): LauncherLock {
  const filename = `${encodeURIComponent(origin)}.lock`;
  const lockPath = path.join(appDataDirectory(), "Enterprise Hub", "launcher", "locks", filename);
  return {
    acquire: async () => {
      await mkdir(path.dirname(lockPath), { recursive: true });
      const deadline = Date.now() + LOCK_WAIT_MS;
      while (true) {
        try {
          const handle = await open(lockPath, "wx", 0o600);
          await handle.writeFile(JSON.stringify({ pid: process.pid, createdAt: Date.now() }));
          return async () => {
            await handle.close();
            await rm(lockPath, { force: true });
          };
        } catch (error) {
          if (isAlreadyExists(error) && (await isStale(lockPath))) {
            await rm(lockPath, { force: true });
            continue;
          }
          if (!isAlreadyExists(error) || Date.now() >= deadline) {
            throw new Error("Enterprise Hub launcher session is busy.");
          }
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
      }
    }
  };
}

async function isStale(lockPath: string): Promise<boolean> {
  try {
    return Date.now() - (await stat(lockPath)).mtimeMs > STALE_LOCK_MS;
  } catch {
    return false;
  }
}

function appDataDirectory(): string {
  if (process.platform === "win32") {
    return process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local");
  }
  return process.env.XDG_DATA_HOME || path.join(os.homedir(), "Library", "Application Support");
}

function isAlreadyExists(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "EEXIST"
  );
}
