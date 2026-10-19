import { createHash, timingSafeEqual } from "node:crypto";

export const OAUTH_CLIENT_ID = "smedc-desktop-launcher";
export const PASSWORD_SETUP_COOKIE = "__Host-eh_password_setup";
export const DEVICE_VERIFY_COOKIE = "__Host-eh_device_verify";
export const DEVICE_CODE_GRANT_TYPE = "urn:ietf:params:oauth:grant-type:device_code";
export const DEVICE_USER_CODE_PATTERN = /^[A-HJ-NP-Z2-9]{8}$/;

export interface OAuthAuthorizationServerMetadata {
  issuer: string;
  device_authorization_endpoint: string;
  token_endpoint: string;
  revocation_endpoint: string;
  grant_types_supported: ["refresh_token", typeof DEVICE_CODE_GRANT_TYPE];
  token_endpoint_auth_methods_supported: ["none"];
  smedc_launcher_package: "smedc-mcp-launcher";
  smedc_launcher_minimum_version: "0.6.0";
  smedc_launcher_recommended_version: "0.12.0";
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
    .update("smedc-browser-csrf\0")
    .update(transactionSecret)
    .digest("base64url");
}

export function matchesCsrfToken(transactionSecret: string, suppliedToken: string): boolean {
  const expected = Buffer.from(csrfTokenForSecret(transactionSecret), "utf8");
  const supplied = Buffer.from(suppliedToken, "utf8");

  return expected.byteLength === supplied.byteLength && timingSafeEqual(expected, supplied);
}

export function oauthMetadata(publicOrigin: string): OAuthAuthorizationServerMetadata {
  const issuer = canonicalHttpsOrigin(publicOrigin);

  return {
    issuer,
    device_authorization_endpoint: `${issuer}/oauth/device_authorization`,
    token_endpoint: `${issuer}/oauth/token`,
    revocation_endpoint: `${issuer}/oauth/revoke`,
    grant_types_supported: ["refresh_token", DEVICE_CODE_GRANT_TYPE],
    token_endpoint_auth_methods_supported: ["none"],
    smedc_launcher_package: "smedc-mcp-launcher",
    smedc_launcher_minimum_version: "0.6.0",
    smedc_launcher_recommended_version: "0.12.0"
  };
}

export function isValidDeviceUserCode(value: unknown): value is string {
  return typeof value === "string" && DEVICE_USER_CODE_PATTERN.test(value);
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
