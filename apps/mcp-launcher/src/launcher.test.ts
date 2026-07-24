import { describe, expect, it } from "vitest";
import { ENTERPRISE_HUB_MCP_TOOL_NAMES } from "@enterprise-hub/mcp-contract";
import { createLauncherRuntimeConfig } from "./config.js";
import {
  LAUNCHER_BOOTSTRAP_TOOL_NAMES,
  createLauncherToolDependencies,
  createLauncherToolHandler,
  mapMcpError,
  registerLauncherTools,
  sanitizeRemoteToolResult
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

  it("denies remote results containing credentials or the exact access token", () => {
    const token = "exact-access-token";
    for (const result of [
      { content: [{ type: "text", text: JSON.stringify({ value: token }) }], isError: false },
      {
        content: [{ type: "text", text: JSON.stringify({ authorization: "Bearer other" }) }],
        isError: false
      },
      {
        content: [{ type: "text", text: JSON.stringify({ nested: { cookie: "secret" } }) }],
        isError: false
      }
    ]) {
      const safe = sanitizeRemoteToolResult(result, token);
      expect(safe.isError).toBe(true);
      expect(JSON.stringify(safe)).not.toContain(token);
      expect(JSON.stringify(safe)).not.toContain("Bearer other");
    }
  });

  it("checks the exact active access token in structured-content keys", () => {
    const token = "active-token-value";
    const safe = sanitizeRemoteToolResult(
      {
        content: [{ type: "text", text: "{}" }],
        structuredContent: { [token]: "leaked through a key" },
        isError: false
      },
      token
    );
    expect(safe.isError).toBe(true);
    expect(JSON.stringify(safe)).not.toContain(token);
  });

  it("preserves legitimate code and secret language plus standard error codes", () => {
    const legitimate = {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            description: "secret recipe with a discount code",
            storeCode: "S001",
            barcode: "6900000000000",
            secretMenu: true,
            error: { code: "MCP_NOT_FOUND", message: "not visible" }
          })
        }
      ],
      structuredContent: {
        description: "secret recipe",
        storeCode: "S001",
        barcode: "6900000000000",
        secretMenu: true
      },
      isError: true
    };
    expect(sanitizeRemoteToolResult(legitimate, "active-token-value")).toEqual(legitimate);
  });

  it("maps remote MCP transport states without triggering the wrong recovery", () => {
    expect(mapMcpError({ code: 401 }).code).toBe("AUTHENTICATION_REQUIRED");
    expect(mapMcpError(new Error("HTTP 403 Forbidden")).code).toBe("FORBIDDEN");
    expect(mapMcpError(new Error("request timed out")).code).toBe("SERVICE_UNAVAILABLE");
  });
});

function fakeAuth(
  options: { authenticated?: boolean; loginError?: { code: string; message: string } } = {}
) {
  return {
    login: async () => {
      if (options.loginError) throw options.loginError;
    },
    logout: async () => ({
      remoteRevocationConfirmed: true,
      localCredentialRemoved: true
    }),
    status: async () => ({ authenticated: options.authenticated ?? false }),
    accessToken: async () => "access-secret",
    invalidate: async () => undefined,
    selfCheck: async () => {
      throw new Error("not used");
    }
  };
}

function body(result: { content: Array<{ text: string }> }): unknown {
  return JSON.parse(result.content[0]?.text ?? "null");
}
