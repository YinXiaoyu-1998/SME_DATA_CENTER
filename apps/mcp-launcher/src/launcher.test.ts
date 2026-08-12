import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ENTERPRISE_HUB_MCP_TOOL_NAMES } from "@enterprise-hub/mcp-contract";
import { createLauncherRuntimeConfig } from "./config.js";
import {
  LAUNCHER_BOOTSTRAP_TOOL_NAMES,
  type LauncherLoginResult,
  canOpenBrowser,
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

  it("reports browser availability from the platform and display environment", () => {
    if (process.platform === "darwin" || process.platform === "win32") {
      expect(canOpenBrowser()).toBe(true);
      return;
    }
    vi.stubEnv("DISPLAY", "");
    vi.stubEnv("WAYLAND_DISPLAY", "");
    expect(canOpenBrowser()).toBe(false);
    vi.stubEnv("DISPLAY", ":0");
    expect(canOpenBrowser()).toBe(true);
    vi.unstubAllEnvs();
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

  it.each(["eh_rt_", "eh_ac_", "eh_ps_", "eh_tx_", "eh_at_"])(
    "rejects a high-entropy %s credential in an ordinary value",
    (prefix) => {
      const leakedCredential = `${prefix}${"a".repeat(43)}`;
      const safe = sanitizeRemoteToolResult(
        {
          content: [
            {
              type: "text",
              text: JSON.stringify({ description: `unexpected value ${leakedCredential}` })
            }
          ],
          structuredContent: { description: leakedCredential },
          isError: false
        },
        "different-active-token"
      );
      expect(safe.isError).toBe(true);
      expect(JSON.stringify(safe)).not.toContain(leakedCredential);
    }
  );

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
            tokenFormat: "The eh_rt_ prefix identifies a rotating credential.",
            error: { code: "MCP_NOT_FOUND", message: "not visible" }
          })
        }
      ],
      structuredContent: {
        description: "secret recipe",
        storeCode: "S001",
        barcode: "6900000000000",
        secretMenu: true,
        tokenFormat: "The eh_tx_ prefix alone is documentation, not a credential."
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

describe("launcher local path upload proxy", () => {
  const tempRoots: string[] = [];

  afterAll(async () => {
    await Promise.all(tempRoots.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  const pathInput = (filePath: string) => ({
    file: {
      name: "dishes.csv",
      mediaType: "text/csv",
      encoding: "path",
      filePath
    },
    dataset: "dishes",
    enterpriseName: "Maijia",
    startDate: "20260701",
    endDate: "20260731",
    idempotencyKey: "path-upload-key",
    labelKeys: ["store:baoli"]
  });
  const base64Input = {
    file: {
      name: "dishes.csv",
      mediaType: "text/csv",
      encoding: "base64",
      contentBase64: "YSwNCg=="
    },
    dataset: "dishes",
    enterpriseName: "Maijia",
    startDate: "20260701",
    endDate: "20260731",
    idempotencyKey: "base64-upload-key",
    labelKeys: ["store:baoli"]
  };
  const evidenceInput = () => ({
    file: {
      name: "sop.md",
      mediaType: "text/markdown",
      encoding: "path",
      filePath: "/tmp/sop.md"
    },
    title: "Baoli Roujiamo SOP",
    sourceSystem: "manual_acceptance_probe",
    labelKeys: ["store:baoli"]
  });

  it("registers path-capable schemas for both upload tools", () => {
    const registered: Array<{ name: string; shape: Record<string, unknown> }> = [];
    registerLauncherTools(
      { registerTool: (name, options) => registered.push({ name, shape: options.inputSchema }) },
      createLauncherToolDependencies({ config, auth: fakeAuth() })
    );

    for (const name of ["upload_structured_dataset", "upload_evidence_document"] as const) {
      const shape = registered.find((entry) => entry.name === name)?.shape;
      const schema = z.object(shape as z.ZodRawShape);
      const input =
        name === "upload_structured_dataset" ? pathInput("/tmp/dishes.csv") : evidenceInput();
      expect(schema.safeParse(input).success).toBe(true);
      const base64 =
        name === "upload_structured_dataset"
          ? base64Input
          : { ...evidenceInput(), file: base64Input.file };
      expect(schema.safeParse(base64).success).toBe(true);
      expect(
        schema.safeParse({
          ...input,
          file: {
            name: "dishes.csv",
            mediaType: "text/csv",
            encoding: "path",
            filePath: "relative.csv"
          }
        }).success
      ).toBe(false);
      expect(
        schema.safeParse({
          name: "dishes.csv",
          mediaType: "text/csv",
          encoding: "base64",
          contentBase64: "YSwNCg=="
        }).success
      ).toBe(false);
      if (name === "upload_structured_dataset") {
        expect(Object.keys(shape ?? {})).toEqual(
          expect.arrayContaining([
            "file",
            "dataset",
            "enterpriseName",
            "startDate",
            "endDate",
            "idempotencyKey",
            "labelKeys"
          ])
        );
      } else {
        expect(Object.keys(shape ?? {})).toEqual(
          expect.arrayContaining(["file", "title", "sourceSystem", "labelKeys"])
        );
      }
    }
  });

  it("accepts nested upload files through the real MCP server boundary", async () => {
    const server = new McpServer({ name: "launcher-schema-test", version: "1.0.0" });
    registerLauncherTools(
      server,
      createLauncherToolDependencies({
        config,
        auth: fakeAuth(),
        fetchImplementation: async () => {
          throw new Error("probe fetch must not be used");
        }
      })
    );
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    const client = new Client({ name: "launcher-schema-test-client", version: "1.0.0" });
    await client.connect(clientTransport);
    try {
      const result = await client.callTool(
        { name: "upload_structured_dataset", arguments: base64Input },
        undefined,
        { timeout: 5_000 }
      );
      expect(JSON.stringify(result)).not.toContain("Input validation error");
      expect(JSON.stringify(result)).not.toContain("-32602");
    } finally {
      await client.close();
    }
  });

  it("converts path-mode input to exact base64 before proxying", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "eh-launcher-proxy-"));
    tempRoots.push(dir);
    const filePath = path.join(dir, "dishes.csv");
    const bytes = Buffer.from("dish_name,business_date\n合成菜品,20260703\n", "utf8");
    await writeFile(filePath, bytes);

    const calls: Array<{ method?: string; params?: { arguments?: unknown } }> = [];
    const dependencies = createLauncherToolDependencies({
      config,
      auth: fakeAuth(),
      fetchImplementation: fakeMcpFetch(calls)
    });

    const result = await createLauncherToolHandler(
      "upload_structured_dataset",
      dependencies
    )(pathInput(filePath));

    expect(result.isError).toBe(false);
    const forwarded = calls.find((call) => call.method === "tools/call")?.params?.arguments as {
      file?: { encoding?: string; contentBase64?: string; filePath?: string };
      dataset?: string;
    };
    expect(forwarded?.file?.encoding).toBe("base64");
    expect(forwarded?.file?.contentBase64).toBe(bytes.toString("base64"));
    expect("filePath" in (forwarded?.file ?? {})).toBe(false);
    expect(forwarded?.dataset).toBe("dishes");
  });

  it("forwards base64-mode input unchanged", async () => {
    const calls: Array<{ method?: string; params?: { arguments?: unknown } }> = [];
    const dependencies = createLauncherToolDependencies({
      config,
      auth: fakeAuth(),
      fetchImplementation: fakeMcpFetch(calls)
    });

    const result = await createLauncherToolHandler(
      "upload_structured_dataset",
      dependencies
    )(base64Input);

    expect(result.isError).toBe(false);
    const forwarded = calls.find((call) => call.method === "tools/call")?.params?.arguments;
    expect(forwarded).toEqual(base64Input);
  });

  it("reports local file read failures without proxying", async () => {
    const calls: Array<{ method?: string }> = [];
    const dependencies = createLauncherToolDependencies({
      config,
      auth: fakeAuth(),
      fetchImplementation: fakeMcpFetch(calls)
    });

    const result = await createLauncherToolHandler(
      "upload_structured_dataset",
      dependencies
    )(pathInput(path.join("/definitely-missing", "dishes.csv")));

    expect(result.isError).toBe(true);
    expect(body(result)).toMatchObject({
      error: { code: "MCP_LOCAL_FILE_NOT_FOUND", retryable: false }
    });
    expect(calls.some((call) => call.method === "tools/call")).toBe(false);
  });
});

function fakeAuth(
  options: { authenticated?: boolean; loginError?: { code: string; message: string } } = {}
) {
  return {
    login: async (): Promise<LauncherLoginResult> => {
      if (options.loginError) throw options.loginError;
      return {
        authenticated: false as const,
        flow: "device" as const,
        verificationUri: "https://hub.example.test/oauth/device/verify",
        verificationUriComplete: "https://hub.example.test/oauth/device/verify?user_code=ABCDEFGH",
        userCode: "ABCDEFGH",
        instanceName: "agent-a",
        instanceHostname: "vps-1",
        openedBrowser: false
      } satisfies LauncherLoginResult;
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

function fakeMcpFetch(calls: Array<{ method?: string; params?: unknown }>): typeof fetch {
  return async (url: string | URL | Request, init?: RequestInit) => {
    let parsed: { method?: string; params?: unknown; id?: unknown } | null = null;
    if (typeof init?.body === "string") {
      try {
        parsed = JSON.parse(init.body) as { method?: string; params?: unknown; id?: unknown };
      } catch {
        parsed = null;
      }
    }
    if (parsed) {
      calls.push({ method: parsed.method, params: parsed.params });
    }
    if (parsed?.method === "initialize") {
      return new Response(
        JSON.stringify({
          jsonrpc: "2.0",
          id: parsed.id,
          result: {
            protocolVersion: "2025-11-25",
            capabilities: { tools: { listChanged: false } },
            serverInfo: { name: "fake-enterprise-hub", version: "0.0.0" }
          }
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    }
    if (parsed?.method === "notifications/initialized") {
      return new Response(null, { status: 202 });
    }
    if (parsed?.method === "tools/call") {
      return new Response(
        JSON.stringify({
          jsonrpc: "2.0",
          id: parsed.id,
          result: {
            content: [{ type: "text", text: JSON.stringify({ accepted: true }) }],
            isError: false
          }
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    }
    if (init?.method === "DELETE") {
      return new Response(null, { status: 204 });
    }
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: parsed?.id, result: {} }), {
      status: 200,
      headers: { "content-type": "application/json" }
    });
  };
}
