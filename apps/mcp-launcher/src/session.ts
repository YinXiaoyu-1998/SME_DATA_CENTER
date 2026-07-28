import type { SecureCredentialStore } from "./auth.js";

export type LauncherErrorCode =
  "AUTHENTICATION_REQUIRED" | "SERVICE_UNAVAILABLE" | "FORBIDDEN" | "LAUNCHER_UPGRADE_REQUIRED";

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

  constructor(
    private readonly dependencies: {
      origin: string;
      secureStore: SecureCredentialStore;
      tokenClient: OAuthTokenClient;
      lock: LauncherLock;
    }
  ) {}

  async ensureAccessToken(): Promise<string> {
    if (this.#accessToken !== null && this.#accessTokenExpiresAt > Date.now() + 60_000) {
      return this.#accessToken;
    }

    const release = await this.dependencies.lock.acquire();
    try {
      // Another launcher may have rotated the durable credential while this process waited.
      const refreshCredential = await this.readCredential();
      if (refreshCredential === null) {
        throw new LauncherTypedError("AUTHENTICATION_REQUIRED");
      }

      let refreshed: { accessToken: string; refreshToken: string; expiresAt?: number };
      try {
        refreshed = await this.dependencies.tokenClient.refresh(refreshCredential);
      } catch (error) {
        const typed = asTypedError(error);
        if (typed.code === "AUTHENTICATION_REQUIRED") await this.invalidate();
        throw typed;
      }

      try {
        await this.dependencies.secureStore.set(
          credentialRecord(this.dependencies.origin, refreshed.refreshToken)
        );
        if ((await this.readCredential()) !== refreshed.refreshToken)
          throw new Error("credential verification failed");
      } catch {
        this.#accessToken = null;
        this.#accessTokenExpiresAt = 0;
        await this.dependencies.tokenClient.revoke(refreshed.refreshToken).catch(() => undefined);
        await this.dependencies.secureStore.delete().catch(() => undefined);
        throw new LauncherTypedError("AUTHENTICATION_REQUIRED");
      }

      this.#accessToken = refreshed.accessToken;
      this.#accessTokenExpiresAt = refreshed.expiresAt ?? Date.now() + 9 * 60_000;
      return refreshed.accessToken;
    } finally {
      await release();
    }
  }

  async establish(
    accessToken: string,
    refreshCredential: string,
    expiresAt: number
  ): Promise<void> {
    try {
      await this.dependencies.secureStore.set(
        credentialRecord(this.dependencies.origin, refreshCredential)
      );
      if ((await this.readCredential()) !== refreshCredential)
        throw new Error("credential verification failed");
      this.#accessToken = accessToken;
      this.#accessTokenExpiresAt = expiresAt;
    } catch {
      this.#accessToken = null;
      this.#accessTokenExpiresAt = 0;
      await this.dependencies.tokenClient.revoke(refreshCredential).catch(() => undefined);
      await this.dependencies.secureStore.delete().catch(() => undefined);
      throw new LauncherTypedError("AUTHENTICATION_REQUIRED");
    }
  }

  async logout(): Promise<{ remoteRevocationConfirmed: boolean; localCredentialRemoved: boolean }> {
    const release = await this.dependencies.lock.acquire();
    try {
      const refreshCredential = await this.readCredential();
      this.#accessToken = null;
      this.#accessTokenExpiresAt = 0;
      const remoteRevocationConfirmed = refreshCredential
        ? await this.dependencies.tokenClient.revoke(refreshCredential).catch(() => false)
        : true;
      const localCredentialRemoved = await this.dependencies.secureStore.delete().then(
        () => true,
        () => false
      );
      return { remoteRevocationConfirmed, localCredentialRemoved };
    } finally {
      await release();
    }
  }

  async status(): Promise<{ authenticated: boolean }> {
    return { authenticated: this.#accessToken !== null || (await this.readCredential()) !== null };
  }

  async invalidate(): Promise<void> {
    this.#accessToken = null;
    this.#accessTokenExpiresAt = 0;
    await this.dependencies.secureStore.delete().catch(() => undefined);
  }

  private async readCredential(): Promise<string | null> {
    const record = await this.dependencies.secureStore.get();
    if (!record) return null;
    try {
      const value = JSON.parse(record) as {
        schemaVersion?: unknown;
        origin?: unknown;
        durableCredential?: unknown;
      };
      return value.schemaVersion === 1 &&
        value.origin === this.dependencies.origin &&
        typeof value.durableCredential === "string" &&
        value.durableCredential
        ? value.durableCredential
        : null;
    } catch {
      return null;
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

function credentialRecord(origin: string, durableCredential: string): string {
  return JSON.stringify({ schemaVersion: 1, origin, durableCredential });
}

function messageFor(code: LauncherErrorCode): string {
  switch (code) {
    case "AUTHENTICATION_REQUIRED":
      return "Enterprise Hub sign-in is required.";
    case "SERVICE_UNAVAILABLE":
      return "Enterprise Hub service is unavailable.";
    case "FORBIDDEN":
      return "Enterprise Hub denied this request.";
    case "LAUNCHER_UPGRADE_REQUIRED":
      return "This Enterprise Hub launcher must be upgraded.";
  }
}
