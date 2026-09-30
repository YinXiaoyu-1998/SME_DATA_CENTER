import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createOfficialLauncherAuthentication } from "./launcher.js";
import { LAUNCHER_VERSION } from "./oauth-client.js";
import { MCP_LAUNCHER_SERVER_VERSION } from "./server.js";

describe("launcher CLI entrypoint", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("reports the runtime launcher version for --version", async () => {
    const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const previousArgv = process.argv;
    process.argv = ["node", "index.js", "--version"];
    try {
      const { runCommand } = await import("./index.js");
      await runCommand();
    } finally {
      process.argv = previousArgv;
    }
    expect(write).toHaveBeenCalledWith(`${LAUNCHER_VERSION}\n`);
  });

  it("keeps the package, protocol server, and runtime release on 0.7.0", () => {
    expect(LAUNCHER_VERSION).toBe("0.7.0");
    expect(MCP_LAUNCHER_SERVER_VERSION).toBe(LAUNCHER_VERSION);
    expect(
      JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version
    ).toBe(LAUNCHER_VERSION);
  });
});

const keychain = vi.hoisted(() => ({
  records: new Map<string, string>(),
  touched: [] as string[]
}));
vi.mock("@napi-rs/keyring", () => ({
  AsyncEntry: class {
    key: string;
    constructor(service: string, account: string) {
      this.key = `${service}|${account}`;
      keychain.touched.push(this.key);
    }
    async getPassword() {
      return keychain.records.get(this.key) ?? null;
    }
    async setPassword(value: string) {
      keychain.records.set(this.key, value);
    }
    async deleteCredential() {
      keychain.records.delete(this.key);
    }
  }
}));

it("actual CLI env assembly reads and logs out only its named profile, never the default sentinel", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "launcher-cli-profile-"));
  const origin = "https://hub.example.test";
  const defaultKey = `com.smedatacenter.smedc.launcher|${origin}`;
  const namedKey = 'com.smedatacenter.smedc.launcher|["https://hub.example.test","pdf-run1-admin"]';
  keychain.records.set(defaultKey, "default-sentinel");
  keychain.records.set(
    namedKey,
    JSON.stringify({
      schemaVersion: 2,
      origin,
      durableCredential: "synthetic-refresh",
      profile: null
    })
  );
  keychain.touched.length = 0;
  vi.stubEnv("SMEDC_BASE_URL", origin);
  vi.stubEnv("SMEDC_CREDENTIAL_PROFILE", "pdf-run1-admin");
  vi.stubEnv("XDG_DATA_HOME", directory);
  vi.stubEnv("LOCALAPPDATA", directory);
  vi.stubGlobal("fetch", async (input: URL | string) => {
    if (String(input).endsWith("/.well-known/oauth-authorization-server"))
      return Response.json({
        issuer: origin,
        device_authorization_endpoint: origin + "/oauth/device_authorization",
        token_endpoint: origin + "/oauth/token",
        revocation_endpoint: origin + "/oauth/revoke",
        smedc_launcher_minimum_version: "0.6.0",
        smedc_launcher_recommended_version: "0.6.0"
      });
    if (String(input).endsWith("/oauth/revoke")) return new Response(null, { status: 200 });
    throw new Error("unexpected network request");
  });
  const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  const argv = process.argv;
  const exitCode = process.exitCode;
  process.argv = ["node", "index.js", "logout"];
  try {
    const { runCommand } = await import("./index.js");
    await runCommand();
    expect(write).toHaveBeenCalledWith(
      JSON.stringify({ remoteRevocationConfirmed: true, localCredentialRemoved: true }) + "\n"
    );
    expect(keychain.records.has(namedKey)).toBe(false);
    expect(keychain.records.get(defaultKey)).toBe("default-sentinel");
    expect(keychain.touched).toEqual([namedKey]);
  } finally {
    process.argv = argv;
    process.exitCode = exitCode;
    await rm(directory, { recursive: true, force: true });
    keychain.records.clear();
  }
});

it("refresh, invalidation, missing credentials and failed refresh stay inside the selected namespace", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "launcher-refresh-profile-"));
  vi.stubEnv("XDG_DATA_HOME", directory);
  vi.stubEnv("LOCALAPPDATA", directory);
  const origin = "https://hub.example.test",
    defaultKey = `com.smedatacenter.smedc.launcher|${origin}`;
  const namedKey = 'com.smedatacenter.smedc.launcher|["https://hub.example.test","pdf-run1-admin"]';
  keychain.records.set(defaultKey, "default-sentinel");
  keychain.records.set(
    namedKey,
    JSON.stringify({
      schemaVersion: 2,
      origin,
      durableCredential: "synthetic-refresh",
      profile: null
    })
  );
  keychain.touched.length = 0;
  const { createLauncherRuntimeConfig } = await import("./config.js");
  const config = createLauncherRuntimeConfig({
    smedcBaseUrl: origin,
    credentialProfile: "pdf-run1-admin"
  });
  let denied = false;
  const fetch: typeof globalThis.fetch = async (input) => {
    if (String(input).endsWith("/.well-known/oauth-authorization-server"))
      return Response.json({
        issuer: origin,
        device_authorization_endpoint: origin + "/oauth/device_authorization",
        token_endpoint: origin + "/oauth/token",
        revocation_endpoint: origin + "/oauth/revoke",
        smedc_launcher_minimum_version: "0.6.0",
        smedc_launcher_recommended_version: "0.6.0"
      });
    if (String(input).endsWith("/oauth/token"))
      return denied
        ? Response.json({ error: "invalid_grant" }, { status: 400 })
        : Response.json({
            access_token: "synthetic-access",
            refresh_token: "synthetic-rotated",
            token_type: "Bearer",
            expires_in: 600
          });
    if (String(input).endsWith("/oauth/revoke")) return new Response(null, { status: 200 });
    throw new Error("unexpected network request");
  };
  try {
    const auth = createOfficialLauncherAuthentication(config, fetch);
    expect(await auth.accessToken()).toBe("synthetic-access");
    expect(JSON.parse(keychain.records.get(namedKey)!).durableCredential).toBe("synthetic-rotated");
    await auth.invalidate();
    expect(await auth.status()).toEqual({ authenticated: false });
    await expect(
      createOfficialLauncherAuthentication(config, fetch).accessToken()
    ).rejects.toMatchObject({ code: "AUTHENTICATION_REQUIRED" });
    keychain.records.set(
      namedKey,
      JSON.stringify({
        schemaVersion: 2,
        origin,
        durableCredential: "synthetic-failed",
        profile: null
      })
    );
    denied = true;
    await expect(
      createOfficialLauncherAuthentication(config, fetch).accessToken()
    ).rejects.toMatchObject({ code: "AUTHENTICATION_REQUIRED" });
    expect(keychain.records.has(namedKey)).toBe(false);
    expect(keychain.records.get(defaultKey)).toBe("default-sentinel");
    expect(keychain.touched).not.toContain(defaultKey);
    const check = await auth.selfCheck();
    expect(check.credentialProfile).toBe("pdf-run1-admin");
  } finally {
    await rm(directory, { recursive: true, force: true });
    keychain.records.clear();
  }
});
