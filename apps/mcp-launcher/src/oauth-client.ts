import * as oauth from "oauth4webapi";
import semver from "semver";
import { LauncherTypedError, type OAuthTokenClient } from "./session.js";

export const LAUNCHER_VERSION = "0.1.1";
const CLIENT: oauth.Client = { client_id: "enterprise-hub-desktop-launcher" };
const VERSION_HEADER = { "x-enterprise-hub-launcher-version": LAUNCHER_VERSION };
const REQUEST_TIMEOUT_MS = 10_000;

export interface LauncherMetadata {
  authorizationEndpoint: URL;
  minimumVersion: string;
  recommendedVersion: string;
  recommendedUpdateAvailable: boolean;
  compatible: boolean;
}

export class EnterpriseHubOAuthClient implements OAuthTokenClient {
  #server: oauth.AuthorizationServer | null = null;

  constructor(
    private readonly origin: URL,
    private readonly fetchImplementation: typeof globalThis.fetch = globalThis.fetch
  ) {}

  async metadata(force = false, enforce = true): Promise<LauncherMetadata> {
    const server = await this.discovery(force);
    if (!server.authorization_endpoint || !server.token_endpoint) {
      throw new LauncherTypedError("SERVICE_UNAVAILABLE");
    }
    const extensions = server as oauth.AuthorizationServer & Record<string, unknown>;
    const minimumVersion = metadataVersion(extensions, [
      "enterprise_hub_launcher_minimum_version",
      "minimum_launcher_version",
      "minimumLauncherVersion"
    ]);
    const recommendedVersion = metadataVersion(extensions, [
      "enterprise_hub_launcher_recommended_version",
      "recommended_launcher_version",
      "recommendedLauncherVersion"
    ]);
    if (!minimumVersion || !recommendedVersion) throw new LauncherTypedError("SERVICE_UNAVAILABLE");
    const compatible = !semver.lt(LAUNCHER_VERSION, minimumVersion);
    if (enforce && !compatible) {
      throw new LauncherTypedError("LAUNCHER_UPGRADE_REQUIRED");
    }
    return {
      authorizationEndpoint: new URL(server.authorization_endpoint),
      minimumVersion,
      recommendedVersion,
      recommendedUpdateAvailable: semver.lt(LAUNCHER_VERSION, recommendedVersion),
      compatible
    };
  }

  async exchange(
    callbackParameters: URLSearchParams,
    redirectUri: URL,
    verifier: string
  ): Promise<{ accessToken: string; refreshToken: string; expiresAt: number }> {
    const server = await this.discovery();
    try {
      const response = await oauth.authorizationCodeGrantRequest(
        server,
        CLIENT,
        oauth.None(),
        callbackParameters,
        redirectUri.toString(),
        verifier,
        requestOptions(this.fetchImplementation)
      );
      return readToken(await oauth.processAuthorizationCodeResponse(server, CLIENT, response));
    } catch (error) {
      throw mapOAuthError(error);
    }
  }

  validateCallback(callbackUrl: URL, expectedState: string): URLSearchParams {
    if (!this.#server) throw new LauncherTypedError("SERVICE_UNAVAILABLE");
    return validateAuthorizationCallback(this.#server, callbackUrl, expectedState);
  }

  async refresh(
    refreshCredential: string
  ): Promise<{ accessToken: string; refreshToken: string; expiresAt: number }> {
    await this.metadata(true);
    const server = await this.discovery();
    try {
      const response = await oauth.refreshTokenGrantRequest(
        server,
        CLIENT,
        oauth.None(),
        refreshCredential,
        requestOptions(this.fetchImplementation)
      );
      return readToken(await oauth.processRefreshTokenResponse(server, CLIENT, response));
    } catch (error) {
      throw mapOAuthError(error);
    }
  }

  async revoke(refreshCredential: string): Promise<boolean> {
    const server = await this.discovery(true);
    if (!server.revocation_endpoint) return false;
    try {
      const response = await oauth.revocationRequest(
        server,
        CLIENT,
        oauth.None(),
        refreshCredential,
        requestOptions(this.fetchImplementation)
      );
      await oauth.processRevocationResponse(response);
      return true;
    } catch (error) {
      const typed = mapOAuthError(error);
      if (typed.code === "AUTHENTICATION_REQUIRED") return true;
      throw typed;
    }
  }

  private async discovery(force = false): Promise<oauth.AuthorizationServer> {
    if (this.#server && !force) return this.#server;
    try {
      const response = await oauth.discoveryRequest(this.origin, {
        algorithm: "oauth2",
        ...requestOptions(this.fetchImplementation)
      });
      this.#server = await oauth.processDiscoveryResponse(this.origin, response);
      return this.#server;
    } catch (error) {
      throw mapOAuthError(error, "SERVICE_UNAVAILABLE");
    }
  }
}

export function validateAuthorizationCallback(
  server: oauth.AuthorizationServer,
  callbackUrl: URL,
  expectedState: string
): URLSearchParams {
  try {
    for (const name of ["code", "state", "error", "iss"]) {
      if (callbackUrl.searchParams.getAll(name).length > 1) {
        throw new LauncherTypedError("AUTHENTICATION_REQUIRED");
      }
    }
    return oauth.validateAuthResponse(server, CLIENT, callbackUrl, expectedState);
  } catch (error) {
    throw mapOAuthError(error);
  }
}

function readToken(response: oauth.TokenEndpointResponse): {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
} {
  if (!response.access_token || !response.refresh_token)
    throw new LauncherTypedError("AUTHENTICATION_REQUIRED");
  const seconds =
    typeof response.expires_in === "number" && response.expires_in > 0 ? response.expires_in : 600;
  return {
    accessToken: response.access_token,
    refreshToken: response.refresh_token,
    expiresAt: Date.now() + seconds * 1000
  };
}

function requestOptions(fetchImplementation: typeof globalThis.fetch) {
  return {
    headers: VERSION_HEADER,
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    [oauth.customFetch]: fetchImplementation
  };
}

function metadataVersion(metadata: Record<string, unknown>, keys: string[]): string | null {
  for (const key of keys) {
    const value = metadata[key];
    if (typeof value === "string" && semver.valid(value)) return value;
  }
  return null;
}

export function mapOAuthError(
  error: unknown,
  fallback?: "SERVICE_UNAVAILABLE"
): LauncherTypedError {
  if (error instanceof LauncherTypedError) return error;
  if (error instanceof oauth.AuthorizationResponseError) {
    return new LauncherTypedError(
      error.error === "access_denied" ? "AUTHENTICATION_REQUIRED" : "SERVICE_UNAVAILABLE"
    );
  }
  if (error instanceof oauth.ResponseBodyError) {
    if (error.error === "invalid_grant" || error.status === 401)
      return new LauncherTypedError("AUTHENTICATION_REQUIRED");
    if (error.status === 403 || error.error === "insufficient_scope")
      return new LauncherTypedError("FORBIDDEN");
    return new LauncherTypedError("SERVICE_UNAVAILABLE");
  }
  const status =
    typeof error === "object" && error !== null && "status" in error
      ? Number((error as { status?: unknown }).status)
      : 0;
  if (status === 401) return new LauncherTypedError("AUTHENTICATION_REQUIRED");
  if (status === 403) return new LauncherTypedError("FORBIDDEN");
  return new LauncherTypedError(fallback ?? "SERVICE_UNAVAILABLE");
}
