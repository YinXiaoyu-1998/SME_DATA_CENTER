import { describe, expect, it } from "vitest";
import { loadMcpRuntimeConfig } from "./config.js";

describe("MCP runtime config", () => {
  it("requires an explicit local API URL", () => {
    expect(() => loadMcpRuntimeConfig({}, "/workspace")).toThrow(
      /ENTERPRISE_HUB_API_URL is required/
    );
  });

  it("normalizes the local-development profile and session file", () => {
    const config = loadMcpRuntimeConfig(
      {
        ENTERPRISE_HUB_API_URL: "http://127.0.0.1:3000/",
        ENTERPRISE_HUB_MCP_SESSION_FILE: ".data/custom-mcp-session.json"
      },
      "/workspace"
    );

    expect(config).toEqual({
      apiUrl: "http://127.0.0.1:3000",
      profile: "local-development",
      sessionFile: "/workspace/.data/custom-mcp-session.json",
      transport: "stdio"
    });
  });

  it("rejects non-URL API configuration", () => {
    expect(() =>
      loadMcpRuntimeConfig(
        {
          ENTERPRISE_HUB_API_URL: "not a url"
        },
        "/workspace"
      )
    ).toThrow(/ENTERPRISE_HUB_API_URL must be an http\(s\) URL/);
  });
});
