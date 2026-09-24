import { describe, expect, it, vi } from "vitest";
import {
  LauncherSession,
  LauncherTypedError,
  type LauncherLock,
  type OAuthTokenClient
} from "./session.js";
import type { CachedUserProfile } from "./user-profile.js";

const origin = "https://hub.example.test";
const adminProfile: CachedUserProfile = {
  displayName: "Admin",
  email: "admin@example.invalid",
  role: "admin",
  clearance: 0,
  organizationName: "Example Org"
};

describe("versioned launcher profile record", () => {
  it("reads v1 lazily and writes only the v2 credential and public profile fields", async () => {
    const secureStore = memoryStore("legacy-refresh");
    await secureStore.set(
      JSON.stringify({
        schemaVersion: 1,
        origin,
        durableCredential: "legacy-refresh",
        internal: "discard"
      })
    );
    const session = new LauncherSession({
      origin,
      secureStore,
      tokenClient: tokenClientReturning({ accessToken: "access", refreshToken: "rotated" })
    });

    await expect(session.cachedProfile()).resolves.toBeNull();
    expect(JSON.parse((await secureStore.get())!).schemaVersion).toBe(1);
    await session.storeProfile(adminProfile);

    expect(JSON.parse((await secureStore.get())!)).toEqual({
      schemaVersion: 2,
      origin,
      durableCredential: "legacy-refresh",
      profile: adminProfile
    });
    const restarted = new LauncherSession({
      origin,
      secureStore,
      tokenClient: tokenClientReturning({ accessToken: "access", refreshToken: "rotated" })
    });
    await expect(restarted.cachedProfile()).resolves.toEqual(adminProfile);
  });

  it("preserves the profile when a refresh rotates the durable credential", async () => {
    const secureStore = memoryStore("legacy-refresh");
    const session = new LauncherSession({
      origin,
      secureStore,
      tokenClient: tokenClientReturning({ accessToken: "access", refreshToken: "rotated" }),
      lock: immediateLock()
    });
    await session.storeProfile(adminProfile);

    await expect(session.ensureAccessToken()).resolves.toBe("access");

    expect(JSON.parse((await secureStore.get())!)).toEqual({
      schemaVersion: 2,
      origin,
      durableCredential: "rotated",
      profile: adminProfile
    });
  });

  it.each(["logout", "invalidate"] as const)(
    "clears the complete stored record on %s",
    async (operation) => {
      const secureStore = memoryStore("legacy-refresh");
      const session = new LauncherSession({
        origin,
        secureStore,
        tokenClient: tokenClientReturning({ accessToken: "access", refreshToken: "rotated" })
      });
      await session.storeProfile(adminProfile);

      await session[operation]();

      await expect(secureStore.get()).resolves.toBeNull();
      await expect(session.cachedProfile()).resolves.toBeNull();
      await expect(session.status()).resolves.toEqual({ authenticated: false });
    }
  );

  it("clears the profile on definitive refresh failure", async () => {
    const secureStore = memoryStore("invalid-refresh");
    const session = new LauncherSession({
      origin,
      secureStore,
      tokenClient: {
        refresh: async () => {
          throw new LauncherTypedError("AUTHENTICATION_REQUIRED");
        },
        revoke: async () => true
      }
    });
    await session.storeProfile(adminProfile);

    await expect(session.ensureAccessToken()).rejects.toMatchObject({
      code: "AUTHENTICATION_REQUIRED"
    });

    await expect(secureStore.get()).resolves.toBeNull();
    await expect(session.cachedProfile()).resolves.toBeNull();
  });

  it("preserves the profile and credential through transient refresh failure", async () => {
    const secureStore = memoryStore("retry-refresh");
    const session = new LauncherSession({
      origin,
      secureStore,
      tokenClient: {
        refresh: async () => {
          throw new LauncherTypedError("SERVICE_UNAVAILABLE");
        },
        revoke: async () => true
      }
    });
    await session.storeProfile(adminProfile);

    await expect(session.ensureAccessToken()).rejects.toMatchObject({
      code: "SERVICE_UNAVAILABLE"
    });
    await expect(session.cachedProfile()).resolves.toEqual(adminProfile);
    expect(JSON.parse((await secureStore.get())!).durableCredential).toBe("retry-refresh");
  });

  it("clears the prior account profile when establishing a replacement session", async () => {
    const secureStore = memoryStore("admin-refresh");
    const session = new LauncherSession({
      origin,
      secureStore,
      tokenClient: tokenClientReturning({ accessToken: "access", refreshToken: "rotated" })
    });
    await session.storeProfile(adminProfile);

    await session.establish("employee-access", "employee-refresh", Date.now() + 9 * 60_000);

    await expect(session.cachedProfile()).resolves.toBeNull();
    expect(JSON.parse((await secureStore.get())!)).toEqual({
      schemaVersion: 2,
      origin,
      durableCredential: "employee-refresh",
      profile: null
    });
  });

  it("rejects a profile and credential from a different origin", async () => {
    const secureStore = memoryStore(null);
    await secureStore.set(
      JSON.stringify({
        schemaVersion: 2,
        origin: "https://other.example.test",
        durableCredential: "foreign-refresh",
        profile: adminProfile
      })
    );
    const session = new LauncherSession({
      origin,
      secureStore,
      tokenClient: tokenClientReturning({ accessToken: "access", refreshToken: "rotated" })
    });

    await expect(session.cachedProfile()).resolves.toBeNull();
    await expect(session.ensureAccessToken()).rejects.toMatchObject({
      code: "AUTHENTICATION_REQUIRED"
    });
  });

  it.each([
    { ...adminProfile, clearance: 4 },
    { ...adminProfile, id: "internal" },
    { role: "admin" }
  ])("cannot expose malformed v2 profiles as trusted profiles: %j", async (profile) => {
    const secureStore = memoryStore(null);
    await secureStore.set(
      JSON.stringify({ schemaVersion: 2, origin, durableCredential: "refresh", profile })
    );
    const session = new LauncherSession({
      origin,
      secureStore,
      tokenClient: tokenClientReturning({ accessToken: "access", refreshToken: "rotated" })
    });

    await expect(session.cachedProfile()).resolves.toBeNull();
  });

  it("does not create an orphan profile without an authenticated record", async () => {
    const secureStore = memoryStore(null);
    const session = new LauncherSession({
      origin,
      secureStore,
      tokenClient: tokenClientReturning({ accessToken: "access", refreshToken: "rotated" })
    });

    await expect(session.storeProfile(adminProfile)).rejects.toMatchObject({
      code: "AUTHENTICATION_REQUIRED"
    });
    await expect(secureStore.get()).resolves.toBeNull();
  });

  it.each(["logout", "invalidate"] as const)(
    "keeps memory-only profiles in-process and clears them on %s",
    async (operation) => {
      const tokenClient = tokenClientReturning({
        accessToken: "refreshed",
        refreshToken: "rotated"
      });
      const session = new LauncherSession({ origin, tokenClient });
      await session.establish("access", "refresh", Date.now() + 30_000);
      await session.storeProfile(adminProfile);
      await expect(session.ensureAccessToken()).resolves.toBe("refreshed");
      await expect(session.cachedProfile()).resolves.toEqual(adminProfile);

      const restarted = new LauncherSession({ origin, tokenClient });
      await expect(restarted.cachedProfile()).resolves.toBeNull();
      await expect(restarted.status()).resolves.toEqual({ authenticated: false });
      await session[operation]();
      await expect(session.cachedProfile()).resolves.toBeNull();
      await expect(session.status()).resolves.toEqual({ authenticated: false });
    }
  );
});

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

describe("memory-only official launcher session", () => {
  it("keeps the durable credential only in memory and refreshes within the process", async () => {
    const tokenClient = tokenClientReturning({
      accessToken: "new-access",
      refreshToken: "new-refresh"
    });
    const session = new LauncherSession({ origin, tokenClient });

    await session.establish("initial-access", "initial-durable", Date.now() + 30_000);
    expect(await session.status()).toEqual({ authenticated: true });
    await expect(session.ensureAccessToken()).resolves.toBe("new-access");
  });

  it("requires a new login after a launcher restart", async () => {
    const tokenClient = tokenClientReturning({
      accessToken: "new-access",
      refreshToken: "new-refresh"
    });
    const first = new LauncherSession({ origin, tokenClient });
    await first.establish("initial-access", "initial-durable", Date.now() + 60_000);

    const restarted = new LauncherSession({ origin, tokenClient });
    await expect(restarted.ensureAccessToken()).rejects.toMatchObject({
      code: "AUTHENTICATION_REQUIRED"
    });
  });

  it("clears the in-memory credential on logout", async () => {
    const tokenClient = tokenClientReturning({
      accessToken: "new-access",
      refreshToken: "new-refresh"
    });
    const session = new LauncherSession({ origin, tokenClient });
    await session.establish("initial-access", "initial-durable", Date.now() + 60_000);

    const outcome = await session.logout();

    expect(outcome).toEqual({ remoteRevocationConfirmed: true, localCredentialRemoved: true });
    expect(await session.status()).toEqual({ authenticated: false });
  });

  it("waits for an in-flight device login before serving the session", async () => {
    const tokenClient = tokenClientReturning({
      accessToken: "after-login",
      refreshToken: "rotated"
    });
    const session = new LauncherSession({ origin, tokenClient });
    let resolveLogin!: () => void;
    session.waitForLogin(
      new Promise<void>((resolve) => {
        resolveLogin = resolve;
      })
    );
    const waiting = session.ensureAccessToken();

    await session.establish("initial-access", "initial-durable", Date.now() + 9 * 60_000);
    resolveLogin();

    await expect(waiting).resolves.toBe("initial-access");
  });

  it("reports AUTHENTICATION_PENDING when the device login ends without a session", async () => {
    const tokenClient = tokenClientReturning({
      accessToken: "after-login",
      refreshToken: "rotated"
    });
    const session = new LauncherSession({ origin, tokenClient });
    session.waitForLogin(Promise.resolve());

    await expect(session.ensureAccessToken()).rejects.toMatchObject({
      code: "AUTHENTICATION_PENDING"
    });
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
