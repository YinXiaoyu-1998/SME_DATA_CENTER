import type { SecureCredentialStore } from "./auth.js";
import { cachedUserProfileSchema, type CachedUserProfile } from "./user-profile.js";

interface SessionRecord {
  schemaVersion: 2;
  origin: string;
  durableCredential: string;
  profile: CachedUserProfile | null;
}

export type LauncherErrorCode =
  | "AUTHENTICATION_REQUIRED"
  | "AUTHENTICATION_PENDING"
  | "SERVICE_UNAVAILABLE"
  | "FORBIDDEN"
  | "LAUNCHER_UPGRADE_REQUIRED";

export class LauncherTypedError extends Error {
  constructor(readonly code: LauncherErrorCode) {
    super(messageFor(code));
  }
}

export interface OAuthTokenClient {
  refresh(
    refreshCredential: string
  ): Promise<{ accessToken: string; refreshToken: string; expiresAt?: number }>;
  revoke(refreshCredential: string): Promise<boolean>;
}

export interface LauncherLock {
  acquire(): Promise<() => Promise<void>>;
}

export class LauncherSession {
  #accessToken: string | null = null;
  #accessTokenExpiresAt = 0;
  #accessTokenCredential: string | null = null;
  #memoryRecord: SessionRecord | null = null;
  #storeAvailable: boolean | null = null;
  #waitingForLogin: Promise<void> | null = null;
  #recordMutation: Promise<void> = Promise.resolve();

  constructor(
    private readonly dependencies: {
      origin: string;
      secureStore?: SecureCredentialStore;
      tokenClient: OAuthTokenClient;
      lock?: LauncherLock;
    }
  ) {}

  async ensureAccessToken(): Promise<string> {
    if (this.#accessToken !== null && this.#accessTokenExpiresAt > Date.now() + 60_000) {
      return this.#accessToken;
    }

    await this.waitForPendingLogin();
    const release = await this.acquireRecordLock();
    try {
      return await this.ensureAccessTokenLocked();
    } finally {
      await release();
    }
  }

  private async waitForPendingLogin(): Promise<void> {
    if (this.#accessToken !== null && this.#accessTokenExpiresAt > Date.now() + 60_000) return;
    if (this.#waitingForLogin !== null) {
      const pending = this.#waitingForLogin;
      this.#waitingForLogin = null;
      try {
        await pending;
      } catch {
        // The login attempt ended without a session; report the typed condition below.
      }
      if (this.#accessToken !== null && this.#accessTokenExpiresAt > Date.now() + 60_000) {
        return;
      }
      if (this.#accessToken === null && (await this.readCredential()) === null) {
        throw new LauncherTypedError("AUTHENTICATION_PENDING");
      }
    }
  }

  private async ensureAccessTokenLocked(): Promise<string> {
    const record = await this.readRecord();
    if (record === null) throw new LauncherTypedError("AUTHENTICATION_REQUIRED");
    if (
      this.#accessToken !== null &&
      this.#accessTokenExpiresAt > Date.now() + 60_000 &&
      this.#accessTokenCredential === record.durableCredential
    )
      return this.#accessToken;

    let refreshed: { accessToken: string; refreshToken: string; expiresAt?: number };
    try {
      refreshed = await this.dependencies.tokenClient.refresh(record.durableCredential);
    } catch (error) {
      const typed = asTypedError(error);
      if (typed.code === "AUTHENTICATION_REQUIRED") await this.invalidateLocked();
      throw typed;
    }

    try {
      await this.storeRecord(refreshed.refreshToken, record.profile);
      if ((await this.readCredential()) !== refreshed.refreshToken) {
        throw new Error("credential verification failed");
      }
    } catch {
      this.#accessToken = null;
      this.#accessTokenExpiresAt = 0;
      this.#accessTokenCredential = null;
      await this.dependencies.tokenClient.revoke(refreshed.refreshToken).catch(() => undefined);
      await this.deleteRecord();
      throw new LauncherTypedError("AUTHENTICATION_REQUIRED");
    }

    this.#accessToken = refreshed.accessToken;
    this.#accessTokenExpiresAt = refreshed.expiresAt ?? Date.now() + 9 * 60_000;
    this.#accessTokenCredential = refreshed.refreshToken;
    return refreshed.accessToken;
  }

  async establish(
    accessToken: string,
    refreshCredential: string,
    expiresAt: number
  ): Promise<void> {
    const release = await this.acquireRecordLock();
    try {
      await this.storeRecord(refreshCredential, null);
      if ((await this.readCredential()) !== refreshCredential)
        throw new Error("credential verification failed");
      this.#accessToken = accessToken;
      this.#accessTokenExpiresAt = expiresAt;
      this.#accessTokenCredential = refreshCredential;
    } catch {
      this.#accessToken = null;
      this.#accessTokenExpiresAt = 0;
      this.#accessTokenCredential = null;
      await this.dependencies.tokenClient.revoke(refreshCredential).catch(() => undefined);
      await this.deleteRecord();
      throw new LauncherTypedError("AUTHENTICATION_REQUIRED");
    } finally {
      await release();
    }
  }

  async logout(): Promise<{ remoteRevocationConfirmed: boolean; localCredentialRemoved: boolean }> {
    const release = await this.acquireRecordLock();
    try {
      const refreshCredential = await this.readCredential();
      this.#accessToken = null;
      this.#accessTokenExpiresAt = 0;
      this.#accessTokenCredential = null;
      this.#memoryRecord = null;
      const remoteRevocationConfirmed = refreshCredential
        ? await this.dependencies.tokenClient.revoke(refreshCredential).catch(() => false)
        : true;
      const localCredentialRemoved = await this.deleteRecord().then(
        () => true,
        () => false
      );
      return { remoteRevocationConfirmed, localCredentialRemoved };
    } finally {
      await release();
    }
  }

  async status(): Promise<{ authenticated: boolean }> {
    return {
      authenticated:
        this.#accessToken !== null ||
        this.#memoryRecord !== null ||
        (await this.readCredential()) !== null
    };
  }

  async invalidate(): Promise<void> {
    const release = await this.acquireRecordLock();
    try {
      await this.invalidateLocked();
    } finally {
      await release();
    }
  }

  async cachedProfile(): Promise<CachedUserProfile | null> {
    const profile = (await this.readRecord())?.profile;
    return profile ? cachedUserProfileSchema.parse(profile) : null;
  }

  async resolveProfile(
    resolver: (accessToken: string) => Promise<CachedUserProfile>
  ): Promise<CachedUserProfile> {
    // Device login must be able to establish its session before this lock is held.
    await this.waitForPendingLogin();
    const release = await this.acquireRecordLock();
    try {
      const cached = (await this.readRecord())?.profile;
      if (cached) return cached;
      const profile = cachedUserProfileSchema.parse(
        await resolver(await this.ensureAccessTokenLocked())
      );
      const credential = await this.readCredential();
      if (credential === null) throw new LauncherTypedError("AUTHENTICATION_REQUIRED");
      await this.storeRecord(credential, profile);
      return profile;
    } catch (error) {
      if (error instanceof LauncherTypedError && error.code === "AUTHENTICATION_REQUIRED") {
        await this.invalidateLocked();
      }
      throw error;
    } finally {
      await release();
    }
  }

  async storeProfile(profile: CachedUserProfile): Promise<void> {
    const validated = cachedUserProfileSchema.parse(profile);
    const release = await this.acquireRecordLock();
    try {
      const record = await this.readRecord();
      if (record === null) throw new LauncherTypedError("AUTHENTICATION_REQUIRED");
      await this.storeRecord(record.durableCredential, validated);
    } finally {
      await release();
    }
  }

  async secureStoreAvailable(): Promise<boolean> {
    return this.#isStoreAvailable();
  }

  waitForLogin(promise: Promise<void>): void {
    this.#waitingForLogin = promise;
  }

  private async acquireRecordLock(): Promise<() => Promise<void>> {
    const previous = this.#recordMutation;
    let releaseLocal!: () => void;
    this.#recordMutation = new Promise<void>((resolve) => {
      releaseLocal = resolve;
    });
    await previous;
    try {
      const releaseShared = await this.dependencies.lock?.acquire();
      return async () => {
        try {
          await releaseShared?.();
        } finally {
          releaseLocal();
        }
      };
    } catch (error) {
      releaseLocal();
      throw error;
    }
  }

  private async invalidateLocked(): Promise<void> {
    this.#accessToken = null;
    this.#accessTokenExpiresAt = 0;
    this.#accessTokenCredential = null;
    await this.deleteRecord();
  }

  private async readCredential(): Promise<string | null> {
    return (await this.readRecord())?.durableCredential ?? null;
  }

  private async readRecord(): Promise<SessionRecord | null> {
    if (!(await this.#isStoreAvailable())) {
      return this.#memoryRecord;
    }
    const record = await this.dependencies.secureStore!.get();
    if (!record) return null;
    try {
      const value = JSON.parse(record) as Record<string, unknown> | null;
      if (
        value === null ||
        (value.schemaVersion !== 1 && value.schemaVersion !== 2) ||
        value.origin !== this.dependencies.origin ||
        typeof value.durableCredential !== "string" ||
        !value.durableCredential
      )
        return null;
      const profile =
        value.schemaVersion === 1 || value.profile === null
          ? null
          : cachedUserProfileSchema.parse(value.profile);
      return {
        schemaVersion: 2,
        origin: this.dependencies.origin,
        durableCredential: value.durableCredential,
        profile
      };
    } catch {
      return null;
    }
  }

  async #isStoreAvailable(): Promise<boolean> {
    if (this.#storeAvailable !== null) return this.#storeAvailable;
    if (!this.dependencies.secureStore) {
      this.#storeAvailable = false;
      return false;
    }
    try {
      await this.dependencies.secureStore.get();
      this.#storeAvailable = true;
    } catch {
      this.#storeAvailable = false;
    }
    return this.#storeAvailable;
  }

  private async storeRecord(
    durableCredential: string,
    profile: CachedUserProfile | null
  ): Promise<void> {
    const record: SessionRecord = {
      schemaVersion: 2,
      origin: this.dependencies.origin,
      durableCredential,
      profile
    };
    if (await this.#isStoreAvailable()) {
      await this.dependencies.secureStore!.set(JSON.stringify(record));
      return;
    }
    this.#memoryRecord = record;
  }

  private async deleteRecord(): Promise<void> {
    this.#memoryRecord = null;
    if (await this.#isStoreAvailable()) {
      await this.dependencies.secureStore!.delete().catch(() => undefined);
    }
  }
}

function asTypedError(error: unknown): LauncherTypedError {
  if (error instanceof LauncherTypedError) {
    return error;
  }

  if (typeof error === "object" && error !== null && "code" in error) {
    const code = (error as { code?: unknown }).code;
    if (
      code === "AUTHENTICATION_REQUIRED" ||
      code === "AUTHENTICATION_PENDING" ||
      code === "SERVICE_UNAVAILABLE" ||
      code === "FORBIDDEN" ||
      code === "LAUNCHER_UPGRADE_REQUIRED"
    ) {
      return new LauncherTypedError(code);
    }
  }

  const message = error instanceof Error ? error.message.toLowerCase() : "";
  return new LauncherTypedError(
    message.includes("network") || message.includes("fetch") || message.includes("timeout")
      ? "SERVICE_UNAVAILABLE"
      : "AUTHENTICATION_REQUIRED"
  );
}

function messageFor(code: LauncherErrorCode): string {
  switch (code) {
    case "AUTHENTICATION_REQUIRED":
      return "SMEDC sign-in is required.";
    case "AUTHENTICATION_PENDING":
      return "SMEDC sign-in is still pending.";
    case "SERVICE_UNAVAILABLE":
      return "SMEDC service is unavailable.";
    case "FORBIDDEN":
      return "SMEDC denied this request.";
    case "LAUNCHER_UPGRADE_REQUIRED":
      return "This SMEDC launcher must be upgraded.";
  }
}
