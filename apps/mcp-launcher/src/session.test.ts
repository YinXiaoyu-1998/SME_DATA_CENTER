import { describe, expect, it, vi } from "vitest";
import {
  LauncherSession,
  LauncherTypedError,
  type LauncherLock,
  type OAuthTokenClient
} from "./session.js";

const origin = "https://hub.example.test";

describe("durable official launcher session", () => {
  it("reuses a durable credential after a launcher restart and rotates it on refresh", async () => {
    const secureStore = memoryStore("old-refresh");
    const tokenClient = tokenClientReturning({
      accessToken: "new-access",
      refreshToken: "new-refresh"
    });
    const first = new LauncherSession({ origin, secureStore, tokenClient, lock: immediateLock() });

    await first.ensureAccessToken();
    expect(await secureStore.get()).toContain("new-refresh");

    const restarted = new LauncherSession({
      origin,
      secureStore,
      tokenClient,
      lock: immediateLock()
    });
    await expect(restarted.ensureAccessToken()).resolves.toBe("new-access");
    expect(tokenClient.refresh).toHaveBeenCalledTimes(2);
  });

  it("fails closed and clears in-memory access when rotating credential storage fails", async () => {
    const secureStore = memoryStore("old-refresh", { failSet: true });
    const sessionTokenClient = tokenClientReturning({
      accessToken: "access-secret",
      refreshToken: "new-refresh"
    });
    const session = new LauncherSession({
      origin,
      secureStore,
      tokenClient: sessionTokenClient,
      lock: immediateLock()
    });

    await expect(session.ensureAccessToken()).rejects.toMatchObject({
      code: "AUTHENTICATION_REQUIRED"
    });
    expect(sessionTokenClient.revoke).toHaveBeenCalledWith("new-refresh");
    await expect(session.status()).resolves.toEqual({ authenticated: false });
  });

  it("preserves exchange expiry and refreshes after the safety window", async () => {
    const tokenClient = tokenClientReturning({ accessToken: "refreshed", refreshToken: "rotated" });
    const session = new LauncherSession({
      origin,
      secureStore: memoryStore(null),
      tokenClient,
      lock: immediateLock()
    });
    await session.establish("initial", "durable", Date.now() + 30_000);
    await expect(session.ensureAccessToken()).resolves.toBe("refreshed");
  });

  it("clears definitive invalid credentials and returns logout outcomes", async () => {
    const secureStore = memoryStore("invalid");
    const tokenClient: OAuthTokenClient = {
      refresh: async () => {
        throw new LauncherTypedError("AUTHENTICATION_REQUIRED");
      },
      revoke: vi.fn(async () => true)
    };
    const session = new LauncherSession({
      origin,
      secureStore,
      tokenClient,
      lock: immediateLock()
    });
    await expect(session.ensureAccessToken()).rejects.toMatchObject({
      code: "AUTHENTICATION_REQUIRED"
    });
    expect(await secureStore.get()).toBeNull();
    await secureStore.set(
      JSON.stringify({ schemaVersion: 1, origin, durableCredential: "logout" })
    );
    await expect(session.logout()).resolves.toEqual({
      remoteRevocationConfirmed: true,
      localCredentialRemoved: true
    });
  });

  it("serializes concurrent refreshes and rereads the keychain after acquiring the lock", async () => {
    const secureStore = memoryStore("before-lock");
    let releases = 0;
    const lock: LauncherLock = {
      acquire: async () => {
        releases += 1;
        return async () => undefined;
      }
    };
    const tokenClient = tokenClientReturning({ accessToken: "access", refreshToken: "after-lock" });
    const first = new LauncherSession({ origin, secureStore, tokenClient, lock });
    const second = new LauncherSession({ origin, secureStore, tokenClient, lock });

    await Promise.all([first.ensureAccessToken(), second.ensureAccessToken()]);
    expect(releases).toBe(2);
    expect(await secureStore.get()).toContain("after-lock");
  });

  it("turns unavailable, forbidden, and upgrade conditions into stable typed errors", async () => {
    const unavailable = new LauncherSession({
      origin,
      secureStore: memoryStore("refresh"),
      tokenClient: {
        refresh: async () => {
          throw new LauncherTypedError("SERVICE_UNAVAILABLE");
        },
        revoke: async () => true
      },
      lock: immediateLock()
    });
    await expect(unavailable.ensureAccessToken()).rejects.toMatchObject({
      code: "SERVICE_UNAVAILABLE"
    });

    const forbidden = new LauncherTypedError("FORBIDDEN");
    expect(forbidden.message).not.toContain("refresh");
    expect(new LauncherTypedError("LAUNCHER_UPGRADE_REQUIRED").code).toBe(
      "LAUNCHER_UPGRADE_REQUIRED"
    );
  });
});

function memoryStore(initial: string | null, options: { failSet?: boolean } = {}) {
  let value =
    initial === null
      ? null
      : JSON.stringify({ schemaVersion: 1, origin, durableCredential: initial });
  return {
    get: async () => value,
    set: async (next: string) => {
      if (options.failSet) throw new Error("keychain unavailable");
      value = next;
    },
    delete: async () => {
      value = null;
    }
  };
}

function tokenClientReturning(result: {
  accessToken: string;
  refreshToken: string;
}): OAuthTokenClient & { refresh: ReturnType<typeof vi.fn> } {
  const refresh = vi.fn(async () => result);
  return { refresh, revoke: vi.fn(async () => true) };
}

function immediateLock(): LauncherLock {
  return { acquire: async () => async () => undefined };
}
