import * as oauth from "oauth4webapi";
import type { OAuthTokenClient } from "./session.js";

const CLIENT: oauth.Client = { client_id: "enterprise-hub-desktop-launcher" };
const VERSION_HEADER = { "x-enterprise-hub-launcher-version": "0.1.0" };

export interface LauncherMetadata {
  authorizationEndpoint: URL;
  minimumVersion?: string;
  recommendedVersion?: string;
}

export class EnterpriseHubOAuthClient implements OAuthTokenClient {
  #server: oauth.AuthorizationServer | null = null;

  constructor(private readonly origin: URL) {}

  async metadata(): Promise<LauncherMetadata> {
    const server = await this.discovery();
    if (!server.authorization_endpoint || !server.token_endpoint) {
      throw new Error("Enterprise Hub OAuth metadata is incomplete.");
    }
    const extensions = server as oauth.AuthorizationServer & {
      enterprise_hub_launcher_minimum_version?: string;
      enterprise_hub_launcher_recommended_version?: string;
    };
    return {
      authorizationEndpoint: new URL(server.authorization_endpoint),
      minimumVersion: extensions.enterprise_hub_launcher_minimum_version,
      recommendedVersion: extensions.enterprise_hub_launcher_recommended_version
    };
  }

  async exchange(
    code: string,
    redirectUri: URL,
    verifier: string
  ): Promise<{ accessToken: string; refreshToken: string; expiresAt: number }> {
    const server = await this.discovery();
    const response = await oauth.authorizationCodeGrantRequest(
      server,
      CLIENT,
      oauth.None(),
      new URLSearchParams({ code }),
      redirectUri.toString(),
      verifier,
      { headers: VERSION_HEADER }
    );
    return readToken(await oauth.processAuthorizationCodeResponse(server, CLIENT, response));
  }

  async refresh(
    refreshCredential: string
  ): Promise<{ accessToken: string; refreshToken: string; expiresAt: number }> {
    const server = await this.discovery();
    try {
      const response = await oauth.refreshTokenGrantRequest(
        server,
        CLIENT,
        oauth.None(),
        refreshCredential,
        {
          headers: VERSION_HEADER
        }
      );
      return readToken(await oauth.processRefreshTokenResponse(server, CLIENT, response));
    } catch (error) {
      throw mapOAuthError(error);
    }
  }

  async revoke(refreshCredential: string): Promise<void> {
    const server = await this.discovery();
    if (!server.revocation_endpoint) return;
    await oauth.revocationRequest(server, CLIENT, oauth.None(), refreshCredential, {
      headers: VERSION_HEADER
    });
  }

  private async discovery(): Promise<oauth.AuthorizationServer> {
    if (this.#server) return this.#server;
    const response = await oauth.discoveryRequest(this.origin, {
      algorithm: "oauth2",
      headers: VERSION_HEADER
    });
    this.#server = await oauth.processDiscoveryResponse(this.origin, response);
    return this.#server;
  }
}

function readToken(response: oauth.TokenEndpointResponse): {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
} {
  if (!response.access_token || !response.refresh_token)
    throw new Error("Enterprise Hub did not return a durable session.");
  const seconds =
    typeof response.expires_in === "number" && response.expires_in > 0 ? response.expires_in : 600;
  return {
    accessToken: response.access_token,
    refreshToken: response.refresh_token,
    expiresAt: Date.now() + seconds * 1000
  };
}

function mapOAuthError(error: unknown): Error {
  const message = error instanceof Error ? error.message.toLowerCase() : "";
  if (message.includes("forbidden"))
    return Object.assign(new Error("forbidden"), { code: "FORBIDDEN" });
  if (message.includes("fetch") || message.includes("network"))
    return Object.assign(new Error("unavailable"), { code: "SERVICE_UNAVAILABLE" });
  return Object.assign(new Error("authentication required"), { code: "AUTHENTICATION_REQUIRED" });
}
