import { describe, expect, it } from "vitest";
import { createLauncherRuntimeConfig, loadLauncherRuntimeConfig } from "./config.js";

describe("Enterprise Hub MCP launcher config", () => {
  it("accepts only a canonical HTTPS Enterprise Hub origin", () => {
    expect(
      createLauncherRuntimeConfig({
        enterpriseHubBaseUrl: "https://HUB.example.com///"
      })
    ).toEqual({
      serviceUrl: "https://hub.example.com",
      transport: "stdio"
    });
  });

  it("loads the base URL from environment without token-bearing settings", () => {
    expect(
      loadLauncherRuntimeConfig({
        ENTERPRISE_HUB_BASE_URL: "https://hub.example.com/"
      })
    ).toEqual({
      serviceUrl: "https://hub.example.com",
      transport: "stdio"
    });
  });

  it("rejects non-base URL or credential-like config input", () => {
    expect(() =>
      createLauncherRuntimeConfig({
        enterpriseHubBaseUrl: "http://127.0.0.1:3000"
      })
    ).toThrow("Enterprise Hub base URL must be a canonical HTTPS origin.");

    expect(() =>
      createLauncherRuntimeConfig({
        enterpriseHubBaseUrl: "ftp://hub.example.com"
      })
    ).toThrow("Enterprise Hub base URL must be a canonical HTTPS origin.");

    expect(() =>
      createLauncherRuntimeConfig({
        enterpriseHubBaseUrl: "https://token@hub.example.com"
      })
    ).toThrow("Enterprise Hub base URL must not include credentials, query, or hash.");

    expect(() =>
      createLauncherRuntimeConfig({
        enterpriseHubBaseUrl: "https://hub.example.com?access_token=secret"
      })
    ).toThrow("Enterprise Hub base URL must not include credentials, query, or hash.");

    expect(() =>
      createLauncherRuntimeConfig({
        enterpriseHubBaseUrl: "https://hub.example.com#secret"
      })
    ).toThrow("Enterprise Hub base URL must not include credentials, query, or hash.");

    expect(() =>
      createLauncherRuntimeConfig({
        enterpriseHubBaseUrl: "https://hub.example.com",
        accessToken: "secret"
      } as unknown as { enterpriseHubBaseUrl: string })
    ).toThrow("Launcher config accepts only enterpriseHubBaseUrl.");
  });

  it("requires an explicit Enterprise Hub base URL", () => {
    expect(() => createLauncherRuntimeConfig({ enterpriseHubBaseUrl: "" })).toThrow(
      "Enterprise Hub base URL is required."
    );
    expect(() => loadLauncherRuntimeConfig({})).toThrow("ENTERPRISE_HUB_BASE_URL is required.");
  });
});
