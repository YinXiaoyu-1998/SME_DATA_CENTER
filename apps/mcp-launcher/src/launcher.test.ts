import { describe, expect, it } from "vitest";
import { ENTERPRISE_HUB_MCP_TOOL_NAMES } from "@enterprise-hub/mcp-contract";
import { createLauncherRuntimeConfig } from "./config.js";
import {
  LAUNCHER_BOOTSTRAP_TOOL_NAMES,
  createLauncherToolDependencies,
  createLauncherToolHandler,
  registerLauncherTools
} from "./launcher.js";

const config = createLauncherRuntimeConfig({ enterpriseHubBaseUrl: "https://hub.example.test" });

describe("official launcher bootstrap tools", () => {
  it("registers empty strict login, logout, and auth-status tools", () => {
    const registered: Array<{ name: string; shape: Record<string, unknown> }> = [];
    registerLauncherTools(
      { registerTool: (name, options) => registered.push({ name, shape: options.inputSchema }) },
      createLauncherToolDependencies({ config, auth: fakeAuth() })
    );

    expect(LAUNCHER_BOOTSTRAP_TOOL_NAMES).toEqual([
      "enterprise_hub_login",
      "enterprise_hub_logout",
      "enterprise_hub_auth_status"
    ]);
    expect(registered.map(({ name }) => name)).toEqual([
      ...LAUNCHER_BOOTSTRAP_TOOL_NAMES,
      ...ENTERPRISE_HUB_MCP_TOOL_NAMES
    ]);
    for (const bootstrap of registered.slice(0, 3))
      expect(Object.keys(bootstrap.shape)).toEqual([]);
  });

  it("returns stable safe authentication state without credentials", async () => {
    const auth = fakeAuth({ authenticated: true });
    const dependencies = createLauncherToolDependencies({ config, auth });
    const result = await createLauncherToolHandler("enterprise_hub_auth_status", dependencies)({});

    expect(body(result)).toEqual({ authenticated: true, serviceUrl: "https://hub.example.test" });
    expect(JSON.stringify(result)).not.toContain("secret");
  });

  it("maps login and business authentication failures to typed errors without token redaction failures", async () => {
    const dependencies = createLauncherToolDependencies({
      config,
      auth: fakeAuth({ loginError: { code: "AUTHENTICATION_REQUIRED", message: "secret-token" } })
    });
    const result = await createLauncherToolHandler("enterprise_hub_login", dependencies)({});
    expect(body(result)).toMatchObject({
      error: { code: "AUTHENTICATION_REQUIRED", message: "Enterprise Hub sign-in is required." }
    });
    expect(JSON.stringify(result)).not.toContain("secret-token");
  });
});

function fakeAuth(
  options: { authenticated?: boolean; loginError?: { code: string; message: string } } = {}
) {
  return {
    login: async () => {
      if (options.loginError) throw options.loginError;
    },
    logout: async () => undefined,
    status: async () => ({ authenticated: options.authenticated ?? false }),
    accessToken: async () => "access-secret"
  };
}

function body(result: { content: Array<{ text: string }> }): unknown {
  return JSON.parse(result.content[0]?.text ?? "null");
}
