import { describe, expect, it } from "vitest";
import { createLauncherRuntimeConfig, loadLauncherRuntimeConfig } from "./config.js";

describe("SMEDC MCP launcher config", () => {
  it("accepts only a canonical HTTPS SMEDC origin", () => {
    expect(
      createLauncherRuntimeConfig({
        smedcBaseUrl: "https://HUB.example.com///"
      })
    ).toEqual({
      serviceUrl: "https://hub.example.com",
      transport: "stdio",
      credentialProfile: "default"
    });
  });

  it("loads the base URL from environment without token-bearing settings", () => {
    expect(
      loadLauncherRuntimeConfig({
        SMEDC_BASE_URL: "https://hub.example.com/"
      })
    ).toEqual({
      serviceUrl: "https://hub.example.com",
      transport: "stdio",
      credentialProfile: "default"
    });
  });

  it("rejects the removed legacy SMEDC base URL aliases", () => {
    expect(() =>
      loadLauncherRuntimeConfig({ SMEDC_API_URL: "https://old.example" } as never)
    ).toThrow("SMEDC_BASE_URL is required.");
    const legacyBaseUrlKey = ["ENTERPRISE", "HUB", "BASE", "URL"].join("_");
    expect(() =>
      loadLauncherRuntimeConfig({ [legacyBaseUrlKey]: "https://old.example" } as never)
    ).toThrow("SMEDC_BASE_URL is required.");
  });

  it("rejects non-base URL or credential-like config input", () => {
    expect(() =>
      createLauncherRuntimeConfig({
        smedcBaseUrl: "http://127.0.0.1:3000"
      })
    ).toThrow("SMEDC base URL must be a canonical HTTPS origin.");

    expect(() =>
      createLauncherRuntimeConfig({
        smedcBaseUrl: "ftp://hub.example.com"
      })
    ).toThrow("SMEDC base URL must be a canonical HTTPS origin.");

    expect(() =>
      createLauncherRuntimeConfig({
        smedcBaseUrl: "https://token@hub.example.com"
      })
    ).toThrow("SMEDC base URL must not include credentials, query, or hash.");

    expect(() =>
      createLauncherRuntimeConfig({
        smedcBaseUrl: "https://hub.example.com?access_token=secret"
      })
    ).toThrow("SMEDC base URL must not include credentials, query, or hash.");

    expect(() =>
      createLauncherRuntimeConfig({
        smedcBaseUrl: "https://hub.example.com#secret"
      })
    ).toThrow("SMEDC base URL must not include credentials, query, or hash.");

    expect(() =>
      createLauncherRuntimeConfig({
        smedcBaseUrl: "https://hub.example.com",
        accessToken: "secret"
      } as unknown as { smedcBaseUrl: string })
    ).toThrow("Launcher config accepts only smedcBaseUrl and credentialProfile.");
  });

  it("requires an explicit SMEDC base URL", () => {
    expect(() => createLauncherRuntimeConfig({ smedcBaseUrl: "" })).toThrow(
      "SMEDC base URL is required."
    );
    expect(() => loadLauncherRuntimeConfig({})).toThrow("SMEDC_BASE_URL is required.");
  });
});

describe("launcher credential profiles", () => {
  it("loads and preserves an explicit named credential namespace", () => {
    expect(
      loadLauncherRuntimeConfig({
        SMEDC_BASE_URL: "https://hub.example.test",
        SMEDC_CREDENTIAL_PROFILE: "pdf-run1-admin"
      })
    ).toMatchObject({ credentialProfile: "pdf-run1-admin" });
    expect(
      createLauncherRuntimeConfig({
        smedcBaseUrl: "https://hub.example.test",
        credentialProfile: "default"
      }).credentialProfile
    ).toBe("default");
  });
  it.each(["", "../default", "a/b", "a\\b", "a.b", " spaced", "x".repeat(65)])(
    "rejects invalid profile %j",
    (credentialProfile) => {
      expect(() =>
        createLauncherRuntimeConfig({ smedcBaseUrl: "https://hub.example.test", credentialProfile })
      ).toThrow("credential profile");
    }
  );
});
