import { AsyncEntry } from "@napi-rs/keyring";
import { randomUUID } from "node:crypto";
import { link, mkdir, open, readFile, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { SecureCredentialStore } from "./auth.js";
import type { LauncherLock } from "./session.js";

const SERVICE_NAME = "com.smedatacenter.enterprise-hub.launcher";

export function createKeychainCredentialStore(origin: string): SecureCredentialStore {
  let entry: AsyncEntry | null = null;
  const entryFor = () => (entry ??= new AsyncEntry(SERVICE_NAME, origin));
  return {
    get: async () => (await entryFor().getPassword()) ?? null,
    set: async (credential) => entryFor().setPassword(credential),
    delete: async () => {
      await entryFor().deleteCredential();
    }
  };
}

export function createCrossProcessLock(origin: string): LauncherLock {
  const filename = `${encodeURIComponent(origin)}.lock`;
  return createFileLock(
    path.join(appDataDirectory(), "Enterprise Hub", "launcher", "locks", filename)
  );
}

export function createFileLock(
  lockPath: string,
  options: {
    waitMs?: number;
    pollMs?: number;
    orphanRecoveryMs?: number;
    isProcessAlive?: (pid: number) => boolean;
    openOwnerFile?: typeof open;
  } = {}
): LauncherLock {
  const waitMs = options.waitMs ?? 10_000;
  const pollMs = options.pollMs ?? 50;
  const orphanRecoveryMs = options.orphanRecoveryMs ?? 5_000;
  const isProcessAlive = options.isProcessAlive ?? processIsAlive;
  const openOwnerFile = options.openOwnerFile ?? open;
  return {
    acquire: async () => {
      await mkdir(path.dirname(lockPath), { recursive: true });
      const deadline = Date.now() + waitMs;
      while (true) {
        const owner = randomUUID();
        const ownerPath = `${lockPath}.owner-${owner}`;
        let handle: Awaited<ReturnType<typeof open>>;
        try {
          handle = await openOwnerFile(ownerPath, "wx", 0o600);
        } catch (error) {
          if (!isAlreadyExists(error)) {
            throw new Error("Enterprise Hub launcher session lock failed.");
          }
          await waitForRetry(deadline, pollMs);
          continue;
        }
        try {
          await handle.writeFile(
            JSON.stringify({ pid: process.pid, owner, createdAt: Date.now() })
          );
          await handle.sync();
          const inode = (await handle.stat()).ino;
          try {
            await link(ownerPath, lockPath);
            await rm(ownerPath, { force: true });
            let released = false;
            return async () => {
              if (released) return;
              released = true;
              await handle.close();
              const [current, currentStat] = await Promise.all([
                readOwner(lockPath),
                stat(lockPath).catch(() => null)
              ]);
              if (current?.owner === owner && currentStat?.ino === inode) {
                await rm(lockPath, { force: true });
              }
            };
          } catch (error) {
            await handle.close();
            await rm(ownerPath, { force: true });
            if (!isAlreadyExists(error)) {
              throw new Error("Enterprise Hub launcher session lock failed.");
            }
          }
        } catch {
          await handle.close().catch(() => undefined);
          await rm(ownerPath, { force: true }).catch(() => undefined);
          throw new Error("Enterprise Hub launcher session lock failed.");
        }

        const existing = await readOwner(lockPath);
        if (existing && !isProcessAlive(existing.pid)) {
          await removeClaimedRecord(lockPath, existing.owner);
        } else if (!existing && (await isBoundedOrphan(lockPath, orphanRecoveryMs))) {
          await removeClaimedRecord(lockPath, null);
        }
        await waitForRetry(deadline, pollMs);
      }
    }
  };
}

async function waitForRetry(deadline: number, pollMs: number): Promise<void> {
  const remainingMs = deadline - Date.now();
  if (remainingMs <= 0) throw new Error("Enterprise Hub launcher session is busy.");
  await new Promise((resolve) => setTimeout(resolve, Math.min(pollMs, remainingMs)));
  if (Date.now() >= deadline) throw new Error("Enterprise Hub launcher session is busy.");
}

async function removeClaimedRecord(lockPath: string, expectedOwner: string | null): Promise<void> {
  const claimPath = `${lockPath}.claim-${randomUUID()}`;
  try {
    await link(lockPath, claimPath);
    const [claimed, claimedStat, currentStat] = await Promise.all([
      readOwner(claimPath),
      stat(claimPath),
      stat(lockPath).catch(() => null)
    ]);
    const ownerMatches =
      expectedOwner === null ? claimed === null : claimed?.owner === expectedOwner;
    if (ownerMatches && currentStat?.ino === claimedStat.ino) await rm(lockPath, { force: true });
  } catch {
    // A contender changed the path; inode mismatch prevents deleting its successor record.
  } finally {
    await rm(claimPath, { force: true }).catch(() => undefined);
  }
}

async function isBoundedOrphan(lockPath: string, orphanRecoveryMs: number): Promise<boolean> {
  const metadata = await stat(lockPath).catch(() => null);
  return metadata !== null && Date.now() - metadata.mtimeMs >= orphanRecoveryMs;
}

async function readOwner(lockPath: string): Promise<{ pid: number; owner: string } | null> {
  try {
    const value = JSON.parse(await readFile(lockPath, "utf8")) as {
      pid?: unknown;
      owner?: unknown;
    };
    return Number.isInteger(value.pid) && typeof value.owner === "string" && value.owner
      ? { pid: value.pid as number, owner: value.owner }
      : null;
  } catch {
    return null;
  }
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !isNoSuchProcess(error);
  }
}

function appDataDirectory(): string {
  if (process.platform === "win32")
    return process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local");
  return process.env.XDG_DATA_HOME || path.join(os.homedir(), "Library", "Application Support");
}

function isAlreadyExists(error: unknown): boolean {
  return errorCode(error) === "EEXIST";
}
function isNoSuchProcess(error: unknown): boolean {
  return errorCode(error) === "ESRCH";
}
function errorCode(error: unknown): unknown {
  return typeof error === "object" && error !== null && "code" in error
    ? (error as { code?: unknown }).code
    : undefined;
}
