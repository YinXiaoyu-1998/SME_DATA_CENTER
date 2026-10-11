import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SMEDC_MCP_TOOL_NAMES } from "@smedc/mcp-contract";
import { createLauncherRuntimeConfig } from "./config.js";
import * as localFiles from "./local-file.js";
import * as partitionTransfer from "./partition-transfer.js";
import * as runtime from "./runtime.js";
import type { CachedUserProfile } from "./user-profile.js";
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

const config = createLauncherRuntimeConfig({ smedcBaseUrl: "https://hub.example.test" });
const adminProfile: CachedUserProfile = {
  displayName: "Synthetic Admin",
  email: "admin@example.invalid",
  role: "admin",
  clearance: 0,
  organizationName: "Synthetic"
};
const employeeProfile: CachedUserProfile = { ...adminProfile, role: "employee" };
const uploadToolNames = [
  "upload_structured_dataset",
  "upload_evidence_document",
  "upload_quarantine_certificate"
] as const;

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("launcher upload role preflight", () => {
  it.each(uploadToolNames)(
    "denies malformed employee %s at the MCP request boundary",
    async (name) => {
      const auth = fakeAuth({ profile: employeeProfile });
      const accessToken = vi.spyOn(auth, "accessToken");
      const read = vi.spyOn(localFiles, "readLocalUploadFile");
      const partition = vi.spyOn(partitionTransfer, "uploadPartitionDataset");
      const remote = vi.fn<typeof fetch>();
      const inputInspected = vi.fn(() => "/definitely-missing/admin-only.csv");
      const server = new McpServer({ name: "employee-request-preflight", version: "1.0.0" });
      registerLauncherTools(
        server,
        createLauncherToolDependencies({ config, auth, fetchImplementation: remote })
      );
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      const client = new Client({ name: "employee-request-client", version: "1.0.0" });
      await server.connect(serverTransport);
      await client.connect(clientTransport);
      try {
        const tools = await client.listTools();
        expect(tools.tools.find((tool) => tool.name === name)?.inputSchema).toMatchObject({
          type: "object",
          required: expect.arrayContaining(["file"]),
          properties: { file: expect.any(Object) }
        });
        const result = await client.callTool({
          name,
          arguments: {
            file: {
              name: null,
              mediaType: 42,
              encoding: "path",
              get filePath() {
                return inputInspected();
              }
            }
          }
        });
        expect(result).toMatchObject({
          isError: true,
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  error: {
                    code: "UPLOAD_ADMIN_REQUIRED",
                    message: "File upload requires the admin role.",
                    retryable: false
                  }
                },
                null,
                2
              )
            }
          ]
        });
        expect(inputInspected).not.toHaveBeenCalled();
        expect(accessToken).not.toHaveBeenCalled();
        expect(read).not.toHaveBeenCalled();
        expect(partition).not.toHaveBeenCalled();
        expect(remote).not.toHaveBeenCalled();
      } finally {
        await client.close();
        await server.close();
      }
    }
  );

  it("still validates admin arguments and serves non-upload requests at the MCP boundary", async () => {
    const auth = fakeAuth({ profile: adminProfile, authenticated: true });
    const profile = vi.spyOn(auth, "profile");
    const accessToken = vi.spyOn(auth, "accessToken");
    const server = new McpServer({ name: "admin-request-preflight", version: "1.0.0" });
    registerLauncherTools(server, createLauncherToolDependencies({ config, auth }));
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "admin-request-client", version: "1.0.0" });
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    try {
      const result = await client.callTool({ name: "upload_evidence_document", arguments: {} });
      expect(result.isError).toBe(true);
      expect(JSON.stringify(result)).toContain("Input validation error");
      expect(profile).toHaveBeenCalledTimes(1);
      expect(accessToken).not.toHaveBeenCalled();
      const status = await client.callTool({ name: "smedc_auth_status", arguments: {} });
      expect(status).toMatchObject({
        isError: false,
        content: [
          {
            type: "text",
            text: JSON.stringify({ authenticated: true, serviceUrl: config.serviceUrl }, null, 2)
          }
        ]
      });
      expect(profile).toHaveBeenCalledTimes(1);
    } finally {
      await client.close();
      await server.close();
    }
  });

  it.each(uploadToolNames)("denies employee %s before local file or upload work", async (name) => {
    const auth = fakeAuth({ profile: employeeProfile });
    const accessToken = vi.spyOn(auth, "accessToken");
    const read = vi.spyOn(localFiles, "readLocalUploadFile");
    const partition = vi.spyOn(partitionTransfer, "uploadPartitionDataset");
    const remote = vi.fn<typeof fetch>();
    const input = {
      file: {
        name: "missing.csv",
        mediaType: "text/csv",
        encoding: "path",
        filePath: "/definitely-missing/admin-only.csv"
      },
      dataset: "business",
      enterpriseName: "Synthetic",
      startDate: "20260701",
      endDate: "20260731",
      idempotencyKey: "employee-denied"
    };
    const result = await createLauncherToolHandler(
      name,
      createLauncherToolDependencies({ config, auth, fetchImplementation: remote })
    )(input);
    expect(result.isError).toBe(true);
    expect(body(result)).toEqual({
      error: {
        code: "UPLOAD_ADMIN_REQUIRED",
        message: "File upload requires the admin role.",
        retryable: false
      }
    });
    expect(accessToken).not.toHaveBeenCalled();
    expect(read).not.toHaveBeenCalled();
    expect(partition).not.toHaveBeenCalled();
    expect(remote).not.toHaveBeenCalled();
  });

  it("denies employee base64 input without reading or converting its content", async () => {
    const content = vi.fn(() => "YQ==");
    const auth = fakeAuth({ profile: employeeProfile });
    const accessToken = vi.spyOn(auth, "accessToken");
    const remote = vi.fn<typeof fetch>();
    const result = await createLauncherToolHandler(
      "upload_evidence_document",
      createLauncherToolDependencies({ config, auth, fetchImplementation: remote })
    )({
      file: {
        encoding: "base64",
        get contentBase64() {
          return content();
        }
      }
    });
    expect(body(result)).toEqual({
      error: {
        code: "UPLOAD_ADMIN_REQUIRED",
        message: "File upload requires the admin role.",
        retryable: false
      }
    });
    expect(content).not.toHaveBeenCalled();
    expect(accessToken).not.toHaveBeenCalled();
    expect(remote).not.toHaveBeenCalled();
  });

  it("denies employee input before inspecting even the file property", async () => {
    const file = vi.fn(() => {
      throw new Error("input inspected before role gate");
    });
    const handler = createLauncherToolHandler(
      "upload_evidence_document",
      createLauncherToolDependencies({ config, auth: fakeAuth({ profile: employeeProfile }) })
    );
    expect(
      body(
        await handler({
          get file() {
            return file();
          }
        })
      )
    ).toMatchObject({ error: { code: "UPLOAD_ADMIN_REQUIRED" } });
    expect(file).not.toHaveBeenCalled();
  });

  it("keeps all upload tools discoverable for employees without resolving their profile", () => {
    const auth = fakeAuth({ profile: employeeProfile });
    const profile = vi.spyOn(auth, "profile");
    const names: string[] = [];
    registerLauncherTools(
      {
        registerTool: (name) => {
          names.push(name);
        }
      },
      createLauncherToolDependencies({ config, auth })
    );
    expect(names).toEqual(expect.arrayContaining([...uploadToolNames]));
    expect(profile).not.toHaveBeenCalled();
  });
});

describe("launcher live profile resolution", () => {
  it("resolves a missing cached profile once and reuses its exact value", async () => {
    const fixture = profileResolutionFixture(() =>
      Response.json({
        employee: {
          ...employeeProfile,
          id: "private-id",
          disabled: false,
          futureField: "never-cache"
        }
      })
    );
    const dependencies = createLauncherToolDependencies({
      config,
      fetchImplementation: fixture.fetch
    });
    const handler = createLauncherToolHandler("upload_evidence_document", dependencies);
    expect(body(await handler(null))).toMatchObject({ error: { code: "UPLOAD_ADMIN_REQUIRED" } });
    expect(JSON.parse(fixture.record()!)).toEqual({
      schemaVersion: 2,
      origin: config.serviceUrl,
      durableCredential: "rotated-refresh",
      profile: employeeProfile
    });
    expect(body(await handler(null))).toMatchObject({ error: { code: "UPLOAD_ADMIN_REQUIRED" } });
    expect(fixture.meRequests).toHaveLength(1);
    const request = fixture.meRequests[0]!;
    expect(request.method).toBe("GET");
    expect(new Headers(request.headers).get("authorization")).toBe("Bearer resolved-access");
    expect(new Headers(request.headers).get("x-smedc-launcher-version")).toBe("0.9.0");
    expect(request.signal).toBeInstanceOf(AbortSignal);
    expect(fixture.paths).not.toContain("/mcp");
    expect(body(await createLauncherToolHandler("smedc_auth_status", dependencies)({}))).toEqual({
      authenticated: true,
      serviceUrl: config.serviceUrl
    });

    await dependencies.auth.logout();
    expect(fixture.record()).toBeNull();
    expect(body(await handler(null))).toMatchObject({ error: { code: "AUTHENTICATION_REQUIRED" } });
    fixture.restoreProfilelessRecord();
    expect(body(await handler(null))).toMatchObject({ error: { code: "UPLOAD_ADMIN_REQUIRED" } });
    expect(fixture.meRequests).toHaveLength(2);
  });

  it.each([
    {
      label: "unauthenticated",
      response: () => new Response(null, { status: 401 }),
      code: "AUTHENTICATION_REQUIRED"
    },
    {
      label: "server failure",
      response: () => new Response(null, { status: 503 }),
      code: "SERVICE_UNAVAILABLE"
    },
    {
      label: "invalid JSON",
      response: () => new Response("not-json"),
      code: "SERVICE_UNAVAILABLE"
    },
    {
      label: "invalid profile",
      response: () => Response.json({ employee: { ...adminProfile, role: "owner" } }),
      code: "SERVICE_UNAVAILABLE"
    },
    {
      label: "network failure",
      response: () => {
        throw new Error("private connection details");
      },
      code: "SERVICE_UNAVAILABLE"
    }
  ])("fails closed on $label without inspecting upload input", async ({ response, code }) => {
    const fixture = profileResolutionFixture(response);
    const dependencies = createLauncherToolDependencies({
      config,
      fetchImplementation: fixture.fetch
    });
    const file = vi.fn(() => {
      throw new Error("input inspected before profile resolution");
    });
    const result = await createLauncherToolHandler(
      "upload_evidence_document",
      dependencies
    )({
      get file() {
        return file();
      }
    });
    expect(result.isError).toBe(true);
    expect(body(result)).toMatchObject({ error: { code } });
    expect(JSON.stringify(result)).not.toContain("private connection details");
    expect(file).not.toHaveBeenCalled();
    expect(fixture.meRequests).toHaveLength(1);
    expect(fixture.paths).not.toContain("/mcp");
    if (code === "AUTHENTICATION_REQUIRED") expect(fixture.record()).toBeNull();
    else expect(JSON.parse(fixture.record()!).profile).toBeNull();
  });

  it("keeps backend upload denial authoritative with a locally supplied admin profile", async () => {
    const denial = {
      error: {
        code: "UPLOAD_ADMIN_REQUIRED",
        message: "File upload requires the admin role.",
        retryable: false
      }
    };
    const calls: Array<{ method?: string; params?: unknown }> = [];
    const dependencies = createLauncherToolDependencies({
      config,
      auth: fakeAuth(),
      fetchImplementation: fakeMcpFetch(calls, denial, true)
    });
    const result = await createLauncherToolHandler(
      "upload_evidence_document",
      dependencies
    )({ file: { encoding: "base64", contentBase64: "YQ==" } });
    expect(result.isError).toBe(true);
    expect(body(result)).toEqual(denial);
    expect(calls.some((call) => call.method === "tools/call")).toBe(true);
  });

  it("always proxies current-user requests live without substituting cached identity", async () => {
    const calls: Array<{ method?: string; params?: unknown }> = [];
    const auth = fakeAuth({ profile: adminProfile });
    const profile = vi.spyOn(auth, "profile");
    const dependencies = createLauncherToolDependencies({
      config,
      auth,
      fetchImplementation: fakeMcpFetch(calls, { employee: employeeProfile })
    });
    const result = await createLauncherToolHandler("smedc_get_current_user", dependencies)({});
    expect(body(result)).toEqual({ employee: employeeProfile });
    expect(calls.filter((call) => call.method === "tools/call")).toEqual([
      { method: "tools/call", params: { name: "smedc_get_current_user", arguments: {} } }
    ]);
    expect(profile).not.toHaveBeenCalled();
  });
});

function profileResolutionFixture(meResponse: () => Response) {
  const profilelessRecord = JSON.stringify({
    schemaVersion: 2,
    origin: config.serviceUrl,
    durableCredential: "current-refresh",
    profile: null
  });
  let record: string | null = profilelessRecord;
  vi.spyOn(runtime, "createKeychainCredentialStore").mockReturnValue({
    get: async () => record,
    set: async (value: string) => {
      record = value;
    },
    delete: async () => {
      record = null;
    }
  });
  vi.spyOn(runtime, "createCrossProcessLock").mockReturnValue({
    acquire: async () => async () => undefined
  });
  const paths: string[] = [];
  const meRequests: RequestInit[] = [];
  const fetchImplementation: typeof fetch = async (input, init) => {
    const pathname = new URL(input instanceof Request ? input.url : input).pathname;
    paths.push(pathname);
    if (pathname === "/.well-known/oauth-authorization-server")
      return Response.json({
        issuer: config.serviceUrl,
        device_authorization_endpoint: `${config.serviceUrl}/oauth/device_authorization`,
        token_endpoint: `${config.serviceUrl}/oauth/token`,
        revocation_endpoint: `${config.serviceUrl}/oauth/revoke`,
        grant_types_supported: ["refresh_token", "urn:ietf:params:oauth:grant-type:device_code"],
        smedc_launcher_minimum_version: "0.6.0",
        smedc_launcher_recommended_version: "0.6.0"
      });
    if (pathname === "/oauth/token")
      return Response.json({
        access_token: "resolved-access",
        refresh_token: "rotated-refresh",
        token_type: "Bearer",
        expires_in: 600
      });
    if (pathname === "/oauth/revoke") return new Response(null, { status: 200 });
    if (pathname === "/me") {
      meRequests.push(init ?? {});
      return meResponse();
    }
    throw new Error(`Unexpected request: ${pathname}`);
  };
  vi.stubGlobal("fetch", fetchImplementation);
  return {
    fetch: fetchImplementation,
    paths,
    meRequests,
    record: () => record,
    restoreProfilelessRecord: () => {
      record = profilelessRecord;
    }
  };
}

describe("official launcher bootstrap tools", () => {
  it("registers empty strict login, logout, and auth-status tools", () => {
    const registered: Array<{ name: string; shape: Record<string, unknown> }> = [];
    registerLauncherTools(
      {
        registerTool: (name, options) =>
          registered.push({
            name,
            shape:
              options.inputSchema instanceof z.ZodObject
                ? options.inputSchema.shape
                : options.inputSchema
          })
      },
      createLauncherToolDependencies({ config, auth: fakeAuth() })
    );

    expect(LAUNCHER_BOOTSTRAP_TOOL_NAMES).toEqual([
      "smedc_login",
      "smedc_logout",
      "smedc_auth_status"
    ]);
    expect(registered.map(({ name }) => name).sort()).toEqual(
      [...LAUNCHER_BOOTSTRAP_TOOL_NAMES, ...SMEDC_MCP_TOOL_NAMES].sort()
    );
    for (const bootstrap of registered.slice(0, 3))
      expect(Object.keys(bootstrap.shape)).toEqual([]);
  });

  it("returns stable safe authentication state without credentials", async () => {
    const auth = fakeAuth({ authenticated: true });
    const dependencies = createLauncherToolDependencies({ config, auth });
    const result = await createLauncherToolHandler("smedc_auth_status", dependencies)({});

    expect(body(result)).toEqual({ authenticated: true, serviceUrl: "https://hub.example.test" });
    expect(JSON.stringify(result)).not.toContain("secret");
  });

  it("maps login and business authentication failures to typed errors without token redaction failures", async () => {
    const dependencies = createLauncherToolDependencies({
      config,
      auth: fakeAuth({ loginError: { code: "AUTHENTICATION_REQUIRED", message: "secret-token" } })
    });
    const result = await createLauncherToolHandler("smedc_login", dependencies)({});
    expect(body(result)).toMatchObject({
      error: { code: "AUTHENTICATION_REQUIRED", message: "SMEDC sign-in is required." }
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

  it.each(["eh_rt_", "eh_ps_", "eh_at_"])(
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
        tokenFormat: "Credential prefixes alone are documentation, not credentials."
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
      name: "vip.csv",
      mediaType: "text/csv",
      encoding: "path",
      filePath
    },
    dataset: "vip",
    enterpriseName: "Synthetic",
    startDate: "20260701",
    endDate: "20260731",
    idempotencyKey: "path-upload-key",
    confidentialityLevel: 0
  });
  const base64Input = {
    file: {
      name: "dishes.csv",
      mediaType: "text/csv",
      encoding: "base64",
      contentBase64: "YSwNCg=="
    },
    dataset: "dishes",
    enterpriseName: "Synthetic",
    startDate: "20260701",
    endDate: "20260731",
    idempotencyKey: "base64-upload-key",
    confidentialityLevel: 0
  };
  const base64QuarantineFile = {
    name: "quarantine.png",
    mediaType: "image/png",
    encoding: "base64" as const,
    contentBase64: "iVBORw0KGgo="
  };
  const evidenceInput = () => ({
    file: {
      name: "sop.md",
      mediaType: "text/markdown",
      encoding: "path",
      filePath: "/tmp/sop.md"
    },
    title: "Baoli Roujiamo SOP",
    categoryId: "memo",
    scopes: [{ enterpriseKey: "enterprise", ownership: "group", dimensions: {} }],
    sourceSystem: "manual_acceptance_probe",
    confidentialityLevel: 0
  });
  const quarantineInput = (filePath: string) => ({
    file: {
      name: "quarantine.png",
      mediaType: "image/png",
      encoding: "path",
      filePath
    },
    receiptId: "SH2608250117",
    idempotencyKey: "quarantine-upload-key",
    enterpriseName: "Enterprise",
    storeName: "Store A ",
    confidentialityLevel: 0
  });

  it("registers path-capable schemas for upload tools", () => {
    const registered: Array<{ name: string; shape: Record<string, unknown> }> = [];
    registerLauncherTools(
      {
        registerTool: (name, options) =>
          registered.push({
            name,
            shape:
              options.inputSchema instanceof z.ZodObject
                ? options.inputSchema.shape
                : options.inputSchema
          })
      },
      createLauncherToolDependencies({ config, auth: fakeAuth() })
    );

    for (const name of [
      "upload_structured_dataset",
      "upload_evidence_document",
      "upload_quarantine_certificate"
    ] as const) {
      const shape = registered.find((entry) => entry.name === name)?.shape;
      const schema = z.object(shape as z.ZodRawShape);
      const input =
        name === "upload_structured_dataset"
          ? pathInput("/tmp/dishes.csv")
          : name === "upload_evidence_document"
            ? evidenceInput()
            : quarantineInput("/tmp/quarantine.png");
      expect(schema.safeParse(input).success).toBe(true);
      const base64 =
        name === "upload_structured_dataset"
          ? base64Input
          : name === "upload_evidence_document"
            ? { ...evidenceInput(), file: base64Input.file }
            : { ...quarantineInput("/tmp/quarantine.png"), file: base64QuarantineFile };
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
            "confidentialityLevel"
          ])
        );
      } else if (name === "upload_evidence_document") {
        expect(Object.keys(shape ?? {})).toEqual(
          expect.arrayContaining(["file", "title", "sourceSystem", "confidentialityLevel"])
        );
      } else {
        expect(Object.keys(shape ?? {})).toEqual(
          expect.arrayContaining(["file", "receiptId", "idempotencyKey", "confidentialityLevel"])
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
    expect(forwarded?.dataset).toBe("vip");
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

describe("launcher evidence search proxy", () => {
  it("preserves automatic source links without calling the explicit download tool", async () => {
    const calls: Array<{ method?: string; params?: unknown }> = [];
    const sourceUrl = "https://downloads.example.test/evidence/doc_1?signature=opaque";
    const dependencies = createLauncherToolDependencies({
      config,
      auth: fakeAuth(),
      fetchImplementation: fakeMcpFetch(calls, {
        results: [{ documentId: "doc_1", chunkId: "chunk_1", text: "制作规范" }],
        sources: [
          {
            sourceDocumentId: "doc_1",
            documentTitle: "肉夹馍制作标准",
            downloadStatus: "available",
            downloadUrl: sourceUrl
          }
        ],
        page: { nextCursor: null },
        retrieval: { configVersion: "phase3.retrieval.v2-bm25" },
        warnings: []
      })
    });

    const result = await createLauncherToolHandler(
      "search_document_evidence",
      dependencies
    )({
      query: "肉夹馍怎么制作"
    });

    expect(result.isError).toBe(false);
    expect(body(result)).toMatchObject({
      sources: [{ downloadStatus: "available", downloadUrl: sourceUrl }]
    });
    const toolCalls = calls
      .filter((call) => call.method === "tools/call")
      .map((call) => (call.params as { name?: string }).name);
    expect(toolCalls).toEqual(["search_document_evidence"]);
    expect(toolCalls).not.toContain("get_source_document_download_url");
  });
});

describe("public partition preparation handlers", () => {
  const prepare = {
    dataset: "business",
    enterpriseName: "Synthetic",
    startDate: "20261001",
    endDate: "20261002",
    idempotencyKey: "stable-retry"
  };
  it.each(["prepare_structured_partition_download", "get_structured_partition_download_status"])(
    "%s refreshes once and preserves the exact request",
    async (name) => {
      const auth = {
        ...fakeAuth(),
        refreshAccessToken: vi.fn(async () => "replacement-secret"),
        invalidate: vi.fn(async () => {})
      };
      const calls: RequestInit[] = [];
      const remote = vi.fn<typeof fetch>(async (_url, init) => {
        calls.push(init!);
        return calls.length === 1
          ? new Response(null, { status: 401 })
          : Response.json({ requestId: "pd_1", status: "queued" });
      });
      const handler = createLauncherToolHandler(
        name,
        createLauncherToolDependencies({ config, auth, fetchImplementation: remote })
      );
      const result = await handler(name.startsWith("prepare") ? prepare : { requestId: "pd_1" });
      expect(result.isError).not.toBe(true);
      expect(body(result)).toMatchObject({ requestId: "pd_1", status: "queued" });
      expect(auth.refreshAccessToken).toHaveBeenCalledTimes(1);
      expect(auth.invalidate).not.toHaveBeenCalled();
      expect(calls[0]!.body).toEqual(calls[1]!.body);
      expect(new Headers(calls[1]!.headers).get("authorization")).toBe("Bearer replacement-secret");
      if (name.startsWith("prepare"))
        expect(JSON.parse(String(calls[1]!.body))).toMatchObject({
          ...prepare,
          startDate: "2026-10-01",
          endDate: "2026-10-02"
        });
    }
  );
  it("repeated 401 stops after one refresh and invalidates rejected authentication", async () => {
    const auth = {
      ...fakeAuth(),
      refreshAccessToken: vi.fn(async () => "replacement-secret"),
      invalidate: vi.fn(async () => {})
    };
    const remote = vi.fn<typeof fetch>(async () => new Response(null, { status: 401 }));
    const handler = createLauncherToolHandler(
      "prepare_structured_partition_download",
      createLauncherToolDependencies({ config, auth, fetchImplementation: remote })
    );
    expect(body(await handler(prepare))).toMatchObject({
      error: { code: "AUTHENTICATION_REQUIRED" }
    });
    expect(remote).toHaveBeenCalledTimes(2);
    expect(auth.refreshAccessToken).toHaveBeenCalledTimes(1);
    expect(auth.invalidate).toHaveBeenCalledTimes(1);
  });
  it.each(["cancel", "deadline"])(
    "%s bounds a pending refresh without another API request",
    async (mode) => {
      vi.useFakeTimers();
      const controller = new AbortController();
      let refreshing!: () => void;
      const started = new Promise<void>((resolve) => {
        refreshing = resolve;
      });
      const auth = {
        ...fakeAuth(),
        refreshAccessToken: vi.fn(() => {
          refreshing();
          return new Promise<string>(() => {});
        })
      };
      const remote = vi.fn<typeof fetch>(async () => new Response(null, { status: 401 }));
      const handler = createLauncherToolHandler(
        "get_structured_partition_download_status",
        createLauncherToolDependencies({ config, auth, fetchImplementation: remote })
      );
      try {
        const result = handler({ requestId: "pd_1" }, { signal: controller.signal });
        await started;
        if (mode === "cancel") controller.abort();
        else await vi.advanceTimersByTimeAsync(30_000);
        expect((await result).isError).toBe(true);
        expect(remote).toHaveBeenCalledTimes(1);
        expect(auth.refreshAccessToken).toHaveBeenCalledTimes(1);
      } finally {
        vi.useRealTimers();
      }
    }
  );
});

function fakeAuth(
  options: {
    authenticated?: boolean;
    loginError?: { code: string; message: string };
    profile?: CachedUserProfile;
  } = {}
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
    profile: async () => options.profile ?? adminProfile,
    invalidate: async () => undefined,
    selfCheck: async () => {
      throw new Error("not used");
    }
  };
}

function body(result: { content: Array<{ text: string }> }): unknown {
  return JSON.parse(result.content[0]?.text ?? "null");
}

function fakeMcpFetch(
  calls: Array<{ method?: string; params?: unknown }>,
  toolBody: unknown = { accepted: true },
  isError = false
): typeof fetch {
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
            serverInfo: { name: "fake-smedc", version: "0.0.0" }
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
            content: [{ type: "text", text: JSON.stringify(toolBody) }],
            isError
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

it("advertises PDF side effects and validates scope before contacting service", async () => {
  const server = new McpServer({ name: "ledger-contract", version: "0.0.0" });
  const remote = vi.fn<typeof fetch>();
  registerLauncherTools(
    server,
    createLauncherToolDependencies({ config, auth: fakeAuth(), fetchImplementation: remote })
  );
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "ledger-contract-test", version: "0.0.0" });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  try {
    const tools = await client.listTools();
    expect(tools.tools.map((tool) => tool.name)).not.toContain("refresh_ledger_pdfs");
    const removed = await client.callTool({
      name: "refresh_ledger_pdfs",
      arguments: { storeNames: ["店"], dates: ["2026-02-28"], idempotencyKey: "key" }
    });
    expect(removed.isError).toBe(true);
    expect(remote).not.toHaveBeenCalled();
    for (const name of ["prepare_ledger_pdf_download"])
      expect(tools.tools.find((tool) => tool.name === name)?.annotations).toMatchObject({
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true
      });
    for (const name of [
      "describe_ledger_pdf_coverage",
      "get_ledger_pdf_request_status",
      "get_ledger_pdf_download_url"
    ])
      expect(tools.tools.find((tool) => tool.name === name)?.annotations?.readOnlyHint).toBe(true);
    const result = await client.callTool({
      name: "prepare_ledger_pdf_download",
      arguments: { storeNames: ["店"], dates: ["2026-02-30"], idempotencyKey: "key" }
    });
    expect(result.isError).toBe(true);
    expect(remote).not.toHaveBeenCalled();
    const crossOrganization = await client.callTool({
      name: "prepare_ledger_pdf_download",
      arguments: {
        storeNames: ["店"],
        dates: ["2026-02-28"],
        idempotencyKey: "key",
        orgId: "other-org"
      }
    });
    expect(crossOrganization.isError).toBe(true);
    expect(remote).not.toHaveBeenCalled();
  } finally {
    await client.close();
    await server.close();
  }
});

it("passes SDK cancellation into requestId bundle transfers and rejects mixed scope", async () => {
  const bundle = await import("./partition-bundle.js");
  let observedSignal: AbortSignal | undefined;
  let started!: () => void;
  const ready = new Promise<void>((resolve) => {
    started = resolve;
  });
  const transfer = vi
    .spyOn(bundle, "downloadPartitionBundle")
    .mockImplementation(async ({ context }) => {
      observedSignal = context.signal;
      started();
      return new Promise((_resolve, reject) =>
        context.signal!.addEventListener("abort", () => reject(context.signal!.reason), {
          once: true
        })
      );
    });
  const server = new McpServer({ name: "bundle-cancellation", version: "1.0.0" });
  registerLauncherTools(
    server,
    createLauncherToolDependencies({ config, auth: fakeAuth({ authenticated: true }) })
  );
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "bundle-cancellation-client", version: "1.0.0" });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  try {
    const mixed = await client.callTool({
      name: "download_structured_partitions",
      arguments: { requestId: "pd_1", dataset: "business" }
    });
    expect(mixed.isError).toBe(true);
    expect(transfer).not.toHaveBeenCalled();
    const controller = new AbortController();
    const pending = client.callTool(
      { name: "download_structured_partitions", arguments: { requestId: "pd_1" } },
      undefined,
      { signal: controller.signal }
    );
    const rejection = expect(pending).rejects.toThrow();
    await ready;
    expect(transfer.mock.calls[0]![0].requestId).toBe("pd_1");
    controller.abort();
    await rejection;
    await vi.waitFor(() => expect(observedSignal?.aborted).toBe(true));
  } finally {
    await client.close();
    await server.close();
  }
});

it("retains strict permission schemas and fixed/evidence refinements at the launcher MCP boundary", async () => {
  const server = new McpServer({ name: "permission-schema", version: "1.0.0" });
  const remote = vi.fn<typeof fetch>(async () => {
    throw new Error("must not forward invalid input");
  });
  registerLauncherTools(
    server,
    createLauncherToolDependencies({ config, auth: fakeAuth(), fetchImplementation: remote })
  );
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: "permission-client", version: "1.0.0" });
  await client.connect(clientTransport);
  try {
    for (const [name, args] of [
      ["get_my_permissions", { orgId: "foreign" }],
      [
        "update_business_category",
        {
          categoryId: "business",
          name: "Business",
          expectedVersion: "7",
          confidentialityLevel: 1,
          ownerships: ["store"],
          requiredDimensionIds: []
        }
      ],
      ["activate_authorization_cutover", { expectedVersion: "7", confirm: false }]
    ] as const) {
      const result = await client.callTool({ name, arguments: args });
      expect(result.isError).toBe(true);
    }
    expect(remote).not.toHaveBeenCalled();
  } finally {
    await client.close();
    await server.close();
  }
});
