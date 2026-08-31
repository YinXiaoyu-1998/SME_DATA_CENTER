import { createHash, timingSafeEqual } from "node:crypto";

export const OAUTH_CLIENT_ID = "enterprise-hub-desktop-launcher";
export const OAUTH_TRANSACTION_COOKIE = "__Host-eh_oauth_transaction";
export const PASSWORD_SETUP_COOKIE = "__Host-eh_password_setup";
export const DEVICE_VERIFY_COOKIE = "__Host-eh_device_verify";
export const DEVICE_CODE_GRANT_TYPE = "urn:ietf:params:oauth:grant-type:device_code";
export const DEVICE_USER_CODE_PATTERN = /^[A-HJ-NP-Z2-9]{8}$/;

interface AuthorizationQuery {
  response_type?: unknown;
  client_id?: unknown;
  redirect_uri?: unknown;
  state?: unknown;
  code_challenge?: unknown;
  code_challenge_method?: unknown;
}

export interface ValidAuthorizationRequest {
  clientId: typeof OAUTH_CLIENT_ID;
  redirectUri: string;
  state: string;
  pkceChallenge: string;
}

export interface OAuthAuthorizationServerMetadata {
  issuer: string;
  authorization_endpoint: string;
  device_authorization_endpoint: string;
  token_endpoint: string;
  revocation_endpoint: string;
  response_types_supported: ["code"];
  grant_types_supported: ["authorization_code", "refresh_token", typeof DEVICE_CODE_GRANT_TYPE];
  code_challenge_methods_supported: ["S256"];
  token_endpoint_auth_methods_supported: ["none"];
  enterprise_hub_launcher_package: "enterprise-hub-mcp-launcher";
  enterprise_hub_launcher_minimum_version: "0.1.0";
  enterprise_hub_launcher_recommended_version: "0.2.5";
}

export function authorizationRequest(query: AuthorizationQuery): ValidAuthorizationRequest {
  const responseType = singleString(query.response_type);
  const clientId = singleString(query.client_id);
  const redirectUri = singleString(query.redirect_uri);
  const state = singleString(query.state);
  const pkceChallenge = singleString(query.code_challenge);
  const pkceMethod = singleString(query.code_challenge_method);

  if (
    responseType !== "code" ||
    clientId !== OAUTH_CLIENT_ID ||
    !redirectUri ||
    !isExactLoopbackRedirect(redirectUri) ||
    !state ||
    !/^[A-Za-z0-9_-]{16,512}$/.test(state) ||
    !pkceChallenge ||
    !/^[A-Za-z0-9_-]{43}$/.test(pkceChallenge) ||
    pkceMethod !== "S256"
  ) {
    throw invalidAuthorizationRequest();
  }

  return {
    clientId,
    redirectUri,
    state,
    pkceChallenge
  };
}

export function hostOnlyCookie(name: string, value: string, maxAgeSeconds: number): string {
  if (!/^__Host-[A-Za-z0-9_-]{1,64}$/.test(name)) {
    throw new Error("invalid cookie name");
  }
  if (!/^[A-Za-z0-9._~-]{1,2048}$/.test(value)) {
    throw new Error("invalid cookie value");
  }
  if (!Number.isSafeInteger(maxAgeSeconds) || maxAgeSeconds < 0 || maxAgeSeconds > 86_400) {
    throw new Error("invalid cookie lifetime");
  }

  return `${name}=${value}; Max-Age=${maxAgeSeconds}; Path=/; HttpOnly; Secure; SameSite=Lax`;
}

export function cookieValue(cookieHeader: string | undefined, name: string): string | null {
  if (!cookieHeader) {
    return null;
  }

  for (const part of cookieHeader.split(";")) {
    const separator = part.indexOf("=");
    if (separator === -1) {
      continue;
    }

    const candidateName = part.slice(0, separator).trim();
    if (candidateName === name) {
      return part.slice(separator + 1).trim() || null;
    }
  }

  return null;
}

export function csrfTokenForSecret(transactionSecret: string): string {
  return createHash("sha256")
    .update("enterprise-hub-browser-csrf\0")
    .update(transactionSecret)
    .digest("base64url");
}

export function matchesCsrfToken(transactionSecret: string, suppliedToken: string): boolean {
  const expected = Buffer.from(csrfTokenForSecret(transactionSecret), "utf8");
  const supplied = Buffer.from(suppliedToken, "utf8");

  return expected.byteLength === supplied.byteLength && timingSafeEqual(expected, supplied);
}

export function pkceChallengeForVerifier(verifier: string): string {
  if (!/^[A-Za-z0-9._~-]{43,128}$/.test(verifier)) {
    throw new Error("invalid PKCE verifier");
  }

  return createHash("sha256").update(verifier, "utf8").digest("base64url");
}

export function oauthMetadata(publicOrigin: string): OAuthAuthorizationServerMetadata {
  const issuer = canonicalHttpsOrigin(publicOrigin);

  return {
    issuer,
    authorization_endpoint: `${issuer}/oauth/authorize`,
    device_authorization_endpoint: `${issuer}/oauth/device_authorization`,
    token_endpoint: `${issuer}/oauth/token`,
    revocation_endpoint: `${issuer}/oauth/revoke`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token", DEVICE_CODE_GRANT_TYPE],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none"],
    enterprise_hub_launcher_package: "enterprise-hub-mcp-launcher",
    enterprise_hub_launcher_minimum_version: "0.1.0",
    enterprise_hub_launcher_recommended_version: "0.2.5"
  };
}

export function isValidDeviceUserCode(value: unknown): value is string {
  return typeof value === "string" && DEVICE_USER_CODE_PATTERN.test(value);
}

function isExactLoopbackRedirect(value: string): boolean {
  const match = /^http:\/\/127\.0\.0\.1:(\d{1,5})\/oauth\/callback$/.exec(value);
  if (!match) {
    return false;
  }

  const port = Number(match[1]);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    return false;
  }

  try {
    const url = new URL(value);
    return (
      url.protocol === "http:" &&
      url.hostname === "127.0.0.1" &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash &&
      url.pathname === "/oauth/callback"
    );
  } catch {
    return false;
  }
}

function singleString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function invalidAuthorizationRequest(): Error {
  return new Error("invalid OAuth authorization request");
}

function canonicalHttpsOrigin(value: string): string {
  try {
    const url = new URL(value);
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      url.pathname !== "/" ||
      url.search ||
      url.hash ||
      (url.port && url.port !== "443")
    ) {
      throw new Error();
    }
    return url.origin;
  } catch {
    throw new Error("public origin must be canonical HTTPS");
  }
}
