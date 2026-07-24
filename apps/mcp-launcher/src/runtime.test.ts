import { mkdtemp, readFile, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createFileLock } from "./runtime.js";

describe("owned cross-process launcher lock", () => {
  it("serializes live owners and an old release cannot remove its successor", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "launcher-lock-"));
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
    const directory = await mkdtemp(path.join(os.tmpdir(), "launcher-lock-stale-"));
    const lockPath = path.join(directory, "session.lock");
    await writeFile(lockPath, JSON.stringify({ pid: 99999999, owner: "dead", createdAt: 1 }), {
      mode: 0o600
    });
    const release = await createFileLock(lockPath, {
      waitMs: 100,
      pollMs: 5,
      isProcessAlive: () => false
    }).acquire();
    expect(JSON.parse(await readFile(lockPath, "utf8")).owner).not.toBe("dead");
    await release();
  });

  it.each(["", "{malformed"])(
    "recovers a crash-orphaned malformed lock record: %j",
    async (record) => {
      const directory = await mkdtemp(path.join(os.tmpdir(), "launcher-lock-orphan-"));
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
