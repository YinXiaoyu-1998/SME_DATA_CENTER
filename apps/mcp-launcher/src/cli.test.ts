import { describe, expect, it } from "vitest";
import { formatLauncherCommandResult } from "./cli.js";

describe("launcher machine-readable CLI contract", () => {
  it("emits exact safe self-check JSON", () => {
    const result = {
      ok: true,
      launcherVersion: "0.2.0",
      serviceOrigin: "https://hub.example.test",
      platform: "darwin",
      secureStore: { available: true, durableCredentialPresent: false },
      server: {
        reachable: true,
        metadataCompatible: true,
        minimumLauncherVersion: "0.1.0",
        recommendedLauncherVersion: "0.2.0",
        recommendedUpdateAvailable: true
      },
      mcp: { handshake: "not_authenticated" as const }
    };
    expect(formatLauncherCommandResult("self-check", result)).toBe(`${JSON.stringify(result)}\n`);
  });

  it("emits exact safe logout JSON", () => {
    const result = { remoteRevocationConfirmed: false, localCredentialRemoved: true };
    expect(formatLauncherCommandResult("logout", result)).toBe(`${JSON.stringify(result)}\n`);
  });
});
