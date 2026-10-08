import * as oauth from "oauth4webapi";
import semver from "semver";
import { LauncherTypedError, type OAuthTokenClient } from "./session.js";

export const LAUNCHER_VERSION = "0.8.1";
const CLIENT: oauth.Client = { client_id: "smedc-desktop-launcher" };
const VERSION_HEADER = { "x-smedc-launcher-version": LAUNCHER_VERSION };
const REQUEST_TIMEOUT_MS = 10_000;

export interface LauncherMetadata {
  deviceAuthorizationEndpoint: URL;
  minimumVersion: string;
  recommendedVersion: string;
  recommendedUpdateAvailable: boolean;
  compatible: boolean;
}

export class SmedcOAuthClient implements OAuthTokenClient {
  #server: oauth.AuthorizationServer | null = null;

  constructor(
    private readonly origin: URL,
    private readonly fetchImplementation: typeof globalThis.fetch = globalThis.fetch
  ) {}

  async metadata(force = false, enforce = true): Promise<LauncherMetadata> {
    const server = await this.discovery(force);
    if (!server.device_authorization_endpoint || !server.token_endpoint) {
      throw new LauncherTypedError("SERVICE_UNAVAILABLE");
    }
    const extensions = server as oauth.AuthorizationServer & Record<string, unknown>;
    const minimumVersion = metadataVersion(extensions, ["smedc_launcher_minimum_version"]);
    const recommendedVersion = metadataVersion(extensions, ["smedc_launcher_recommended_version"]);
    if (!minimumVersion || !recommendedVersion) throw new LauncherTypedError("SERVICE_UNAVAILABLE");
    const compatible = !semver.lt(LAUNCHER_VERSION, minimumVersion);
    if (enforce && !compatible) {
      throw new LauncherTypedError("LAUNCHER_UPGRADE_REQUIRED");
    }
    return {
      deviceAuthorizationEndpoint: new URL(server.device_authorization_endpoint),
      minimumVersion,
      recommendedVersion,
      recommendedUpdateAvailable: semver.lt(LAUNCHER_VERSION, recommendedVersion),
      compatible
    };
  }

  async requestDeviceAuthorization(input: {
    instanceName: string;
    instanceHostname: string;
  }): Promise<DeviceAuthorizationRequest> {
    const server = await this.discovery();
    if (!server.device_authorization_endpoint) {
      throw new LauncherTypedError("SERVICE_UNAVAILABLE");
    }
    const response = await oauth.deviceAuthorizationRequest(
      server,
      CLIENT,
      oauth.None(),
      new URLSearchParams({
        instanceName: input.instanceName,
        instanceHostname: input.instanceHostname
      }),
      requestOptions(this.fetchImplementation)
    );
    try {
      const parsed = await oauth.processDeviceAuthorizationResponse(server, CLIENT, response);
      return {
        deviceCode: parsed.device_code,
        userCode: parsed.user_code,
        verificationUri: new URL(parsed.verification_uri),
        verificationUriComplete: parsed.verification_uri_complete
          ? new URL(parsed.verification_uri_complete)
          : null,
        expiresInSeconds: parsed.expires_in,
        intervalSeconds: parsed.interval ?? 5
      };
    } catch (error) {
      throw mapOAuthError(error);
    }
  }

  async pollDeviceAuthorization(deviceCode: string): Promise<DeviceCodePollResult> {
    const server = await this.discovery();
    const response = await oauth.deviceCodeGrantRequest(
      server,
      CLIENT,
      oauth.None(),
      deviceCode,
      requestOptions(this.fetchImplementation)
    );
    try {
      const parsed = await oauth.processDeviceCodeResponse(server, CLIENT, response);
      return {
        status: "complete",
        accessToken: parsed.access_token,
        refreshToken: parsed.refresh_token ?? "",
        expiresAt:
          typeof parsed.expires_in === "number" && parsed.expires_in > 0
            ? Date.now() + parsed.expires_in * 1000
            : undefined
      };
    } catch (error) {
      if (error instanceof oauth.ResponseBodyError) {
        if (error.error === "authorization_pending") {
          return { status: "pending" };
        }
        if (error.error === "slow_down") {
          return { status: "slow_down", intervalSeconds: 5 };
        }
        if (error.error === "expired_token" || error.error === "invalid_grant") {
          return { status: "expired" };
        }
      }
      throw mapOAuthError(error);
    }
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

export interface DeviceAuthorizationRequest {
  deviceCode: string;
  userCode: string;
  verificationUri: URL;
  verificationUriComplete: URL | null;
  expiresInSeconds: number;
  intervalSeconds: number;
}

export type DeviceCodePollResult =
  | { status: "pending" }
  | { status: "slow_down"; intervalSeconds: number }
  | { status: "expired" }
  | {
      status: "complete";
      accessToken: string;
      refreshToken: string;
      expiresAt?: number;
    };
