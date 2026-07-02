import { describe, expect, it } from "vitest";
import { buildMcpBootupConfig, createApiChildSpec } from "./mcp-bootup.js";

describe("mcp bootup config", () => {
  it("derives a local API URL and injects it into the MCP environment", () => {
    const config = buildMcpBootupConfig(
      {
        PATH: "/usr/bin",
        PORT: "4567",
        DATABASE_URL: "mysql://local",
        JWT_SECRET: "local-secret"
      },
      "/workspace"
    );

    expect(config.apiUrl).toBe("http://127.0.0.1:4567");
    expect(config.apiEnv["HOST"]).toBe("127.0.0.1");
    expect(config.apiEnv["PORT"]).toBe("4567");
    expect(config.mcpEnv["ENTERPRISE_HUB_API_URL"]).toBe("http://127.0.0.1:4567");
  });

  it("fails early when ENTERPRISE_HUB_API_URL and PORT disagree", () => {
    expect(() =>
      buildMcpBootupConfig(
        {
          ENTERPRISE_HUB_API_URL: "http://127.0.0.1:3000",
          PORT: "4000"
        },
        "/workspace"
      )
    ).toThrow("PORT must match ENTERPRISE_HUB_API_URL");
  });

  it("starts the API through npm silently with stdout and stderr captured", () => {
    const config = buildMcpBootupConfig({ PORT: "4567" }, "/workspace");

    expect(createApiChildSpec(config)).toMatchObject({
      command: "npm",
      args: ["run", "--silent", "api:dev"],
      cwd: "/workspace",
      stdio: ["ignore", "pipe", "pipe"]
    });
  });
});
