import { describe, expect, it } from "vitest";
import { canonicalApiOrigin, canonicalWebOrigin, resolveApiOrigins } from "./origins.js";

describe("canonical origins", () => {
  it("accepts a canonical HTTPS API origin", () => {
    expect(canonicalApiOrigin("https://api.smedatacenter.xyz")).toBe(
      "https://api.smedatacenter.xyz"
    );
  });

  it("rejects plain HTTP, credentials, paths, queries, fragments and custom ports", () => {
    expect(() => canonicalApiOrigin("http://api.smedatacenter.xyz")).toThrow(/must use HTTPS/);
    expect(() => canonicalApiOrigin("https://user:pw@api.smedatacenter.xyz")).toThrow(
      /must not include credentials/
    );
    expect(() => canonicalApiOrigin("https://api.smedatacenter.xyz/v1")).toThrow(
      /must not include a path/
    );
    expect(() => canonicalApiOrigin("https://api.smedatacenter.xyz?x=1")).toThrow(
      /must not include a path/
    );
    expect(() => canonicalApiOrigin("https://api.smedatacenter.xyz#x")).toThrow(
      /must not include a path/
    );
    expect(() => canonicalApiOrigin("https://api.smedatacenter.xyz:8443")).toThrow(
      /must use the default HTTPS port/
    );
    expect(() => canonicalApiOrigin("not a url")).toThrow(/must be a canonical origin/);
  });

  it("allows loopback HTTP only for the web origin", () => {
    expect(canonicalWebOrigin("http://localhost:5173")).toBe("http://localhost:5173");
    expect(canonicalWebOrigin("http://127.0.0.1:5173")).toBe("http://127.0.0.1:5173");
    expect(() => canonicalWebOrigin("http://192.168.1.10:5173")).toThrow(/must use HTTPS/);
    expect(() => canonicalApiOrigin("http://localhost:5173")).toThrow(/must use HTTPS/);
  });

  it("requires both variables", () => {
    expect(() => resolveApiOrigins({})).toThrow(/SMEDC_API_ORIGIN is required/);
    expect(() => resolveApiOrigins({ SMEDC_API_ORIGIN: "https://api.example.invalid" })).toThrow(
      /SMEDC_WEB_ORIGIN is required/
    );
  });

  it("resolves the pair and keeps them distinct", () => {
    expect(
      resolveApiOrigins({
        SMEDC_API_ORIGIN: "https://api.smedatacenter.xyz",
        SMEDC_WEB_ORIGIN: "https://app.smedatacenter.xyz"
      })
    ).toEqual({
      apiOrigin: "https://api.smedatacenter.xyz",
      webOrigin: "https://app.smedatacenter.xyz"
    });
  });
});
