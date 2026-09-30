import { mkdtemp, readFile, readdir, rm, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createCrossProcessLock,
  createKeychainCredentialStore,
  createFileLock
} from "./runtime.js";

describe("owned cross-process launcher lock", () => {
  it("fails closed immediately when opening an owner record fails with a non-EEXIST error", async () => {
    const directory = await temporaryDirectory(
      path.join(os.tmpdir(), "launcher-lock-open-failure-")
    );
    const lockPath = path.join(directory, "session.lock");
    let attempts = 0;
    const options = {
      waitMs: 25,
      pollMs: 5,
      openOwnerFile: async () => {
        attempts += 1;
        throw Object.assign(new Error("permission denied"), { code: "EACCES" });
      }
    };

    await expect(createFileLock(lockPath, options).acquire()).rejects.toThrow(
      "SMEDC launcher session lock failed."
    );
    expect(attempts).toBe(1);
  });

  it("bounds EEXIST owner-record retries by both polling and the acquisition deadline", async () => {
    const directory = await temporaryDirectory(
      path.join(os.tmpdir(), "launcher-lock-open-collision-")
    );
    const lockPath = path.join(directory, "session.lock");
    let attempts = 0;
    const startedAt = Date.now();
    const options = {
      waitMs: 25,
      pollMs: 10,
      openOwnerFile: async () => {
        attempts += 1;
        throw Object.assign(new Error("already exists"), { code: "EEXIST" });
      }
    };

    await expect(createFileLock(lockPath, options).acquire()).rejects.toThrow(
      "SMEDC launcher session is busy."
    );
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(20);
    expect(attempts).toBeGreaterThan(1);
    expect(attempts).toBeLessThanOrEqual(5);
  });

  it("serializes live owners and an old release cannot remove its successor", async () => {
    const directory = await temporaryDirectory(path.join(os.tmpdir(), "launcher-lock-"));
    const lockPath = path.join(directory, "session.lock");
    const first = createFileLock(lockPath, { waitMs: 500, pollMs: 5 });
    const second = createFileLock(lockPath, { waitMs: 500, pollMs: 5 });
    const releaseFirst = await first.acquire();
    let secondEntered = false;
    const secondPromise = second.acquire().then((release) => {
      secondEntered = true;
      return release;
    });
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(secondEntered).toBe(false);
    await releaseFirst();
    const releaseSecond = await secondPromise;
    await releaseFirst();
    expect(JSON.parse(await readFile(lockPath, "utf8"))).toMatchObject({ pid: process.pid });
    await releaseSecond();
  });

  it("recovers a dead-owner record but never age-deletes a live owner", async () => {
    const directory = await temporaryDirectory(path.join(os.tmpdir(), "launcher-lock-stale-"));
    const lockPath = path.join(directory, "session.lock");
    await writeFile(lockPath, JSON.stringify({ pid: 99999999, owner: "dead", createdAt: 1 }), {
      mode: 0o600
    });
    const release = await createFileLock(lockPath, {
      waitMs: 2_000,
      pollMs: 5,
      isProcessAlive: () => false
    }).acquire();
    expect(JSON.parse(await readFile(lockPath, "utf8")).owner).not.toBe("dead");
    await release();
  });

  it.each(["", "{malformed"])(
    "recovers a crash-orphaned malformed lock record: %j",
    async (record) => {
      const directory = await temporaryDirectory(path.join(os.tmpdir(), "launcher-lock-orphan-"));
      const lockPath = path.join(directory, "session.lock");
      await writeFile(lockPath, record, { mode: 0o600 });
      await utimes(lockPath, new Date(0), new Date(0));
      const release = await createFileLock(lockPath, {
        waitMs: 100,
        pollMs: 5,
        orphanRecoveryMs: 10
      }).acquire();
      expect(JSON.parse(await readFile(lockPath, "utf8"))).toMatchObject({ pid: process.pid });
      await release();
    }
  );
});

const keychain = vi.hoisted(() => ({
  entries: new Map<string, string>(),
  touched: [] as string[]
}));
vi.mock("@napi-rs/keyring", () => ({
  AsyncEntry: class {
    key: string;
    constructor(service: string, account: string) {
      this.key = `${service}|${account}`;
      keychain.touched.push(this.key);
    }
    async getPassword() {
      return keychain.entries.get(this.key) ?? null;
    }
    async setPassword(value: string) {
      keychain.entries.set(this.key, value);
    }
    async deleteCredential() {
      keychain.entries.delete(this.key);
    }
  }
}));
const tempDirectories: string[] = [];
async function temporaryDirectory(prefix: string) {
  const directory = await mkdtemp(prefix);
  tempDirectories.push(directory);
  return directory;
}
afterEach(async () => {
  vi.unstubAllEnvs();
  keychain.entries.clear();
  keychain.touched.length = 0;
  await Promise.all(
    tempDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))
  );
});
describe("isolated credential namespaces", () => {
  it("keeps legacy service/account for implicit and explicit default, isolates named reads and deletes", async () => {
    const origin = "https://hub.example.test";
    const legacyKey = "com.smedatacenter.smedc.launcher|https://hub.example.test";
    keychain.entries.set(legacyKey, "default-sentinel");
    expect(await createKeychainCredentialStore(origin).get()).toBe("default-sentinel");
    expect(await createKeychainCredentialStore(origin, "default").get()).toBe("default-sentinel");
    keychain.touched.length = 0;
    const named = createKeychainCredentialStore(origin, "pdf-run1-admin");
    expect(await named.get()).toBeNull();
    await named.set("synthetic-profile");
    expect(await named.get()).toBe("synthetic-profile");
    await named.delete();
    expect(await named.get()).toBeNull();
    expect(keychain.entries.get(legacyKey)).toBe("default-sentinel");
    expect(keychain.touched).not.toContain(legacyKey);
  });
  it("preserves the default lock name and lets a named profile acquire independently", async () => {
    const directory = await temporaryDirectory(path.join(os.tmpdir(), "launcher-profile-lock-"));
    vi.stubEnv("XDG_DATA_HOME", directory);
    vi.stubEnv("LOCALAPPDATA", directory);
    const origin = "https://hub.example.test";
    const releaseDefault = await createCrossProcessLock(origin).acquire();
    let releaseNamed: (() => Promise<void>) | undefined;
    try {
      releaseNamed = await createCrossProcessLock(origin, "pdf-run1-admin").acquire();
      const names = await readdir(path.join(directory, "SMEDC", "launcher", "locks"));
      expect(names.filter((name) => name.endsWith(".lock"))).toHaveLength(2);
      expect(names).toContain("https%3A%2F%2Fhub.example.test.lock");
      await releaseDefault();
      const releaseExplicit = await createCrossProcessLock(origin, "default").acquire();
      expect(
        (await readdir(path.join(directory, "SMEDC", "launcher", "locks"))).filter((name) =>
          name.endsWith(".lock")
        )
      ).toHaveLength(2);
      await releaseExplicit();
    } finally {
      await releaseNamed?.();
      await releaseDefault();
      await rm(directory, { recursive: true, force: true });
    }
  });
  it("bounds named lock filenames even for long valid origins and the maximum profile", async () => {
    const directory = await temporaryDirectory(
      path.join(os.tmpdir(), "launcher-long-profile-lock-")
    );
    vi.stubEnv("XDG_DATA_HOME", directory);
    vi.stubEnv("LOCALAPPDATA", directory);
    const origin = `https://${"a".repeat(63)}.${"b".repeat(63)}.${"c".repeat(63)}.${"d".repeat(40)}.test`;
    try {
      const release = await createCrossProcessLock(origin, "x".repeat(64)).acquire();
      await release();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
  it("rejects invalid profiles before creating any Keychain entry or lock", () => {
    expect(() => createKeychainCredentialStore("https://hub.example.test", "../default")).toThrow(
      "credential profile"
    );
    expect(() => createCrossProcessLock("https://hub.example.test", "../default")).toThrow(
      "credential profile"
    );
    expect(keychain.touched).toEqual([]);
  });
});
