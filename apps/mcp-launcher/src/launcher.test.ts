import http, { type IncomingMessage, type ServerResponse } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
  ENTERPRISE_HUB_MCP_TOOL_CONTRACTS,
  ENTERPRISE_HUB_MCP_TOOL_NAMES,
  type McpJsonToolResult
} from "@enterprise-hub/mcp-contract";
import {
  LAUNCHER_BOOTSTRAP_TOOL_NAMES,
  MemoryLauncherSession,
  createLauncherToolDependencies,
  createLauncherToolHandler,
  registerLauncherTools
} from "./launcher.js";
import { createLauncherRuntimeConfig } from "./config.js";
import { createEnterpriseHubMcpLauncherServer } from "./server.js";

const config = createLauncherRuntimeConfig({
  enterpriseHubBaseUrl: "http://enterprise-hub.test/"
});

describe("Enterprise Hub MCP launcher bootstrap", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("registers exactly two local bootstrap tools plus stateless business contracts", () => {
    const registered: Array<{ name: string; inputSchema: Record<string, unknown> }> = [];
    const dependencies = createLauncherToolDependencies({ config });

    registerLauncherTools(
      {
        registerTool(name, options) {
          registered.push({ name, inputSchema: options.inputSchema });
        }
      },
      dependencies
    );

    expect(registered.map((tool) => tool.name)).toEqual([
      ...LAUNCHER_BOOTSTRAP_TOOL_NAMES,
      ...ENTERPRISE_HUB_MCP_TOOL_NAMES
    ]);
    expect(LAUNCHER_BOOTSTRAP_TOOL_NAMES).toEqual([
      "enterprise_hub_login_local",
      "enterprise_hub_logout_local"
    ]);

    for (const contract of ENTERPRISE_HUB_MCP_TOOL_CONTRACTS) {
      const registeredTool = registered.find((tool) => tool.name === contract.name);

      expect(registeredTool?.inputSchema).toBe(contract.inputShape);
      expect(Object.keys(registeredTool?.inputSchema ?? {})).not.toContain("sessionName");
      expect(Object.keys(registeredTool?.inputSchema ?? {})).not.toContain("filePath");
    }
  });

  it("logs in through dev-login and keeps the access token out of tool output", async () => {
    const secretToken = "secret-access-token";
    const fetchImplementation = vi.fn(async (...args: Parameters<typeof fetch>) => {
      void args;

      return jsonResponse(200, {
        accessToken: secretToken,
        employee: {
          id: "emp_admin",
          orgId: "default-org",
          email: "admin@example.com",
          role: "admin",
          disabled: false,
          labels: ["all_staff"]
        }
      });
    });
    const dependencies = createLauncherToolDependencies({ config, fetchImplementation });

    const login = createLauncherToolHandler("enterprise_hub_login_local", dependencies);
    const loginResult = await login({ email: "admin@example.com" });

    expect(fetchImplementation).toHaveBeenCalledOnce();
    const [request, init] = fetchImplementation.mock.calls[0] as unknown as Parameters<
      typeof fetch
    >;

    expect(request.toString()).toBe("http://enterprise-hub.test/auth/dev-login");
    expect(JSON.stringify(init)).not.toContain(secretToken);

    const body = resultBody(loginResult);
    expect(body).toEqual({
      employee: {
        id: "emp_admin",
        orgId: "default-org",
        email: "admin@example.com",
        role: "admin",
        disabled: false,
        labels: ["all_staff"]
      },
      serviceUrl: "http://enterprise-hub.test"
    });
    expect(JSON.stringify(loginResult)).not.toContain(secretToken);

    expect(dependencies.session.isAuthenticated()).toBe(true);
  });

  it("logs out by clearing only process memory and does not leak tokens", async () => {
    const dependencies = createLauncherToolDependencies({
      config,
      fetchImplementation: successfulLoginFetch("logout-secret-token")
    });

    await createLauncherToolHandler(
      "enterprise_hub_login_local",
      dependencies
    )({
      email: "admin@example.com"
    });

    const logoutResult = await createLauncherToolHandler(
      "enterprise_hub_logout_local",
      dependencies
    )({});

    expect(resultBody(logoutResult)).toEqual({ success: true });
    expect(JSON.stringify(logoutResult)).not.toContain("logout-secret-token");

    const businessResult = await createLauncherToolHandler(
      "enterprise_hub_list_labels",
      dependencies
    )({});
    expect(resultBody(businessResult)).toMatchObject({
      error: {
        code: "EMPLOYEE_AUTH_REQUIRED",
        message: "Enterprise Hub local login is required."
      }
    });
  });

  it("starts unauthenticated for a fresh launcher instance", async () => {
    const firstInstance = createLauncherToolDependencies({
      config,
      fetchImplementation: successfulLoginFetch("restart-secret-token")
    });
    await createLauncherToolHandler(
      "enterprise_hub_login_local",
      firstInstance
    )({
      email: "admin@example.com"
    });

    const freshInstance = createLauncherToolDependencies({ config });
    const result = await createLauncherToolHandler("enterprise_hub_list_labels", freshInstance)({});

    expect(resultBody(result)).toMatchObject({
      error: {
        code: "EMPLOYEE_AUTH_REQUIRED",
        message: "Enterprise Hub local login is required."
      }
    });
  });

  it("maps login failure and network errors to safe no-token responses", async () => {
    const secretToken = "failed-secret-token";
    const failedLogin = createLauncherToolDependencies({
      config,
      fetchImplementation: vi.fn(async () =>
        jsonResponse(403, {
          error: {
            code: "EMPLOYEE_DISABLED",
            message: `disabled ${secretToken}`
          }
        })
      )
    });

    const failedResult = await createLauncherToolHandler(
      "enterprise_hub_login_local",
      failedLogin
    )({
      email: "disabled@example.com"
    });

    expect(resultBody(failedResult)).toMatchObject({
      error: {
        code: "EMPLOYEE_AUTH_REQUIRED",
        message: "Enterprise Hub local login failed."
      }
    });
    expect(JSON.stringify(failedResult)).not.toContain(secretToken);

    const networkFailure = createLauncherToolDependencies({
      config,
      fetchImplementation: vi.fn(async () => {
        throw new Error(`network ${secretToken}`);
      })
    });

    const networkResult = await createLauncherToolHandler(
      "enterprise_hub_login_local",
      networkFailure
    )({ email: "admin@example.com" });

    expect(resultBody(networkResult)).toMatchObject({
      error: {
        code: "ENTERPRISE_HUB_API_ERROR",
        message: "Enterprise Hub API request failed."
      }
    });
    expect(JSON.stringify(networkResult)).not.toContain(secretToken);
  });

  it("stores sessions only in the supplied process memory object", async () => {
    const sharedSession = new MemoryLauncherSession();
    const firstDependencies = createLauncherToolDependencies({
      config,
      session: sharedSession,
      fetchImplementation: successfulLoginFetch("memory-secret-token")
    });
    const secondDependencies = createLauncherToolDependencies({
      config,
      session: sharedSession
    });

    await createLauncherToolHandler(
      "enterprise_hub_login_local",
      firstDependencies
    )({
      email: "admin@example.com"
    });

    expect(secondDependencies.session.isAuthenticated()).toBe(true);
  });

  it("delegates access token use only through an authenticated callback", async () => {
    const session = new MemoryLauncherSession();
    const dependencies = createLauncherToolDependencies({
      config,
      session,
      fetchImplementation: successfulLoginFetch("callback-secret-token")
    });

    await createLauncherToolHandler(
      "enterprise_hub_login_local",
      dependencies
    )({
      email: "admin@example.com"
    });

    const delegatedValue = await session.withAccessToken((context) => {
      expect(context.accessToken).toBe("callback-secret-token");
      expect(context.employee.email).toBe("admin@example.com");
      expect(context.serviceUrl).toBe("http://enterprise-hub.test");

      return "delegated";
    });

    expect(delegatedValue).toBe("delegated");
    expect(JSON.stringify(session)).not.toContain("callback-secret-token");

    session.clear();
    await expect(session.withAccessToken(() => "unused")).rejects.toThrow(
      "Enterprise Hub local login is required."
    );
  });

  it("aborts dev-login after a finite timeout without leaking request details", async () => {
    vi.useFakeTimers();

    let fetchSignal: AbortSignal | undefined;
    const fetchImplementation = vi.fn((_request: RequestInfo | URL, init?: RequestInit) => {
      fetchSignal = init?.signal ?? undefined;
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          reject(new Error("aborted secret-timeout-token"));
        });
      });
    }) as unknown as typeof fetch;
    const dependencies = createLauncherToolDependencies({ config, fetchImplementation });
    const login = createLauncherToolHandler("enterprise_hub_login_local", dependencies);

    const loginPromise = login({ email: "admin@example.com" });

    await vi.advanceTimersByTimeAsync(10_000);

    expect(fetchSignal).toBeInstanceOf(AbortSignal);
    expect(fetchSignal?.aborted).toBe(true);

    const result = await loginPromise;
    expect(resultBody(result)).toMatchObject({
      error: {
        code: "ENTERPRISE_HUB_API_ERROR",
        message: "Enterprise Hub API request failed."
      }
    });
    expect(JSON.stringify(result)).not.toContain("secret-timeout-token");
  });

  it("does not consume unsuccessful login response bodies", async () => {
    const response = new Response("disabled-secret-token", { status: 403 });
    const text = vi.spyOn(response, "text");
    const dependencies = createLauncherToolDependencies({
      config,
      fetchImplementation: vi.fn(async () => response) as unknown as typeof fetch
    });

    const result = await createLauncherToolHandler(
      "enterprise_hub_login_local",
      dependencies
    )({
      email: "disabled@example.com"
    });

    expect(text).not.toHaveBeenCalled();
    expect(resultBody(result)).toMatchObject({
      error: {
        code: "EMPLOYEE_AUTH_REQUIRED",
        message: "Enterprise Hub local login failed."
      }
    });
    expect(JSON.stringify(result)).not.toContain("disabled-secret-token");
  });

  it("rejects oversized successful login bodies without storing a token", async () => {
    const hugeToken = `oversized-secret-${"x".repeat(70_000)}`;
    const dependencies = createLauncherToolDependencies({
      config,
      fetchImplementation: vi.fn(async () =>
        jsonResponse(200, {
          accessToken: hugeToken,
          employee: {
            id: "emp_admin",
            orgId: "default-org",
            email: "admin@example.com",
            role: "admin",
            disabled: false,
            labels: ["all_staff"]
          }
        })
      ) as unknown as typeof fetch
    });

    const result = await createLauncherToolHandler(
      "enterprise_hub_login_local",
      dependencies
    )({
      email: "admin@example.com"
    });

    expect(resultBody(result)).toMatchObject({
      error: {
        code: "ENTERPRISE_HUB_API_ERROR",
        message: "Enterprise Hub API request failed."
      }
    });
    expect(JSON.stringify(result)).not.toContain("oversized-secret");

    const businessResult = await createLauncherToolHandler(
      "enterprise_hub_list_labels",
      dependencies
    )({});
    expect(resultBody(businessResult)).toMatchObject({
      error: {
        code: "EMPLOYEE_AUTH_REQUIRED"
      }
    });
  });
});

describe("Enterprise Hub MCP launcher remote proxy", () => {
  it("proxies an outer MCP business tool call through Streamable HTTP with bearer auth on every remote request", async () => {
    const secretToken = "proxy-secret-token";
    const remoteResult: McpJsonToolResult = {
      content: [
        {
          type: "text",
          text: JSON.stringify({ labels: [{ key: "all_staff", name: "All staff" }] })
        }
      ],
      isError: false
    };
    const remote = await startRemoteMcpStub({
      token: secretToken,
      toolResult: remoteResult
    });
    const launcherConfig = createLauncherRuntimeConfig({
      enterpriseHubBaseUrl: remote.baseUrl
    });
    const launcherServer = createEnterpriseHubMcpLauncherServer(launcherConfig);
    const launcherClient = new Client({
      name: "launcher-test-client",
      version: "0.0.0"
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

    try {
      await launcherServer.connect(serverTransport);
      await launcherClient.connect(clientTransport);

      const loginResult = await launcherClient.callTool({
        name: "enterprise_hub_login_local",
        arguments: {
          email: "admin@example.com"
        }
      });
      const businessResult = await launcherClient.callTool({
        name: "enterprise_hub_list_labels",
        arguments: {}
      });

      expect(JSON.stringify(loginResult)).not.toContain(secretToken);
      expect(businessResult).toEqual(remoteResult);
      expect(JSON.stringify(businessResult)).not.toContain(secretToken);
      expect(remote.mcpRequests.map((request) => request.authorization)).toEqual([
        `Bearer ${secretToken}`,
        `Bearer ${secretToken}`,
        `Bearer ${secretToken}`
      ]);
      expect(remote.mcpRequests.map((request) => request.body.method)).toEqual([
        "initialize",
        "notifications/initialized",
        "tools/call"
      ]);
      expect(remote.mcpRequests[2]?.body.params).toEqual({
        name: "enterprise_hub_list_labels",
        arguments: {}
      });
    } finally {
      await launcherClient.close();
      await launcherServer.close();
      await remote.close();
    }
  });

  it("preserves remote MCP tool error results as safe tool results", async () => {
    const secretToken = "backend-error-secret-token";
    const remoteErrorResult = jsonErrorResult("MCP_NOT_FOUND", "Requested data is not visible.");
    const remote = await startRemoteMcpStub({
      token: secretToken,
      toolResult: remoteErrorResult
    });
    const dependencies = createLauncherToolDependencies({
      config: createLauncherRuntimeConfig({ enterpriseHubBaseUrl: remote.baseUrl })
    });

    try {
      await createLauncherToolHandler(
        "enterprise_hub_login_local",
        dependencies
      )({
        email: "admin@example.com"
      });

      const result = await createLauncherToolHandler(
        "enterprise_hub_list_labels",
        dependencies
      )({});

      expect(result).toEqual(remoteErrorResult);
      expect(JSON.stringify(result)).not.toContain(secretToken);
    } finally {
      await remote.close();
    }
  });

  it("does not pass through a remote tool result that contains the in-memory JWT", async () => {
    const secretToken = "remote-leaked-secret-token";
    const remote = await startRemoteMcpStub({
      token: secretToken,
      toolResult: jsonResponseBody({ leaked: secretToken })
    });
    const dependencies = createLauncherToolDependencies({
      config: createLauncherRuntimeConfig({ enterpriseHubBaseUrl: remote.baseUrl })
    });

    try {
      await createLauncherToolHandler(
        "enterprise_hub_login_local",
        dependencies
      )({
        email: "admin@example.com"
      });

      const result = await createLauncherToolHandler(
        "enterprise_hub_list_labels",
        dependencies
      )({});

      expect(resultBody(result)).toMatchObject({
        error: {
          code: "ENTERPRISE_HUB_API_ERROR",
          message: "Enterprise Hub API request failed."
        }
      });
      expect(JSON.stringify(result)).not.toContain(secretToken);
    } finally {
      await remote.close();
    }
  });

  it("clears memory and returns EMPLOYEE_AUTH_REQUIRED when the remote service rejects an expired token", async () => {
    const secretToken = "expired-secret-token";
    const remote = await startRemoteMcpStub({
      token: secretToken,
      mcpStatus: 401,
      mcpBody: {
        error: {
          code: "UNAUTHENTICATED",
          message: `expired ${secretToken}`,
          retryable: false
        }
      }
    });
    const dependencies = createLauncherToolDependencies({
      config: createLauncherRuntimeConfig({ enterpriseHubBaseUrl: remote.baseUrl })
    });

    try {
      await createLauncherToolHandler(
        "enterprise_hub_login_local",
        dependencies
      )({
        email: "admin@example.com"
      });

      const expiredResult = await createLauncherToolHandler(
        "enterprise_hub_list_labels",
        dependencies
      )({});
      const afterClearResult = await createLauncherToolHandler(
        "enterprise_hub_list_labels",
        dependencies
      )({});

      expect(resultBody(expiredResult)).toMatchObject({
        error: {
          code: "EMPLOYEE_AUTH_REQUIRED",
          message: "Enterprise Hub local login is required."
        }
      });
      expect(resultBody(afterClearResult)).toMatchObject({
        error: {
          code: "EMPLOYEE_AUTH_REQUIRED",
          message: "Enterprise Hub local login is required."
        }
      });
      expect(JSON.stringify(expiredResult)).not.toContain(secretToken);
      expect(JSON.stringify(expiredResult)).not.toContain("UNAUTHENTICATED");
      expect(remote.mcpRequests).toHaveLength(1);
    } finally {
      await remote.close();
    }
  });

  it("returns ENTERPRISE_HUB_UNREACHABLE when the remote MCP endpoint is unavailable", async () => {
    const secretToken = "unreachable-secret-token";
    const remote = await startRemoteMcpStub({ token: secretToken });
    const dependencies = createLauncherToolDependencies({
      config: createLauncherRuntimeConfig({ enterpriseHubBaseUrl: remote.baseUrl })
    });

    await createLauncherToolHandler(
      "enterprise_hub_login_local",
      dependencies
    )({
      email: "admin@example.com"
    });
    await remote.close();

    const result = await createLauncherToolHandler("enterprise_hub_list_labels", dependencies)({});

    expect(resultBody(result)).toMatchObject({
      error: {
        code: "ENTERPRISE_HUB_UNREACHABLE",
        message: "Enterprise Hub service is unreachable."
      }
    });
    expect(JSON.stringify(result)).not.toContain(secretToken);
  });
});

function successfulLoginFetch(secretToken: string): typeof fetch {
  return vi.fn(async () =>
    jsonResponse(200, {
      accessToken: secretToken,
      employee: {
        id: "emp_admin",
        orgId: "default-org",
        email: "admin@example.com",
        role: "admin",
        disabled: false,
        labels: ["all_staff"]
      }
    })
  ) as unknown as typeof fetch;
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json"
    }
  });
}

function resultBody(result: McpJsonToolResult): unknown {
  expect(result.content).toHaveLength(1);
  return JSON.parse(result.content[0]?.text ?? "null");
}

interface RemoteMcpRequest {
  authorization: string | undefined;
  body: {
    id?: string | number | null;
    method?: string;
    params?: unknown;
  };
}

interface RemoteMcpStubOptions {
  token: string;
  toolResult?: McpJsonToolResult;
  mcpStatus?: number;
  mcpBody?: unknown;
}

async function startRemoteMcpStub(options: RemoteMcpStubOptions): Promise<{
  baseUrl: string;
  mcpRequests: RemoteMcpRequest[];
  close: () => Promise<void>;
}> {
  const mcpRequests: RemoteMcpRequest[] = [];
  const server = http.createServer(async (request, response) => {
    try {
      if (request.method === "POST" && request.url === "/auth/dev-login") {
        return sendJson(response, 200, {
          accessToken: options.token,
          employee: {
            id: "emp_admin",
            orgId: "default-org",
            email: "admin@example.com",
            role: "admin",
            disabled: false,
            labels: ["all_staff"]
          }
        });
      }

      if (request.method === "GET" && request.url === "/mcp") {
        return sendJson(response, 405, {
          error: {
            code: "MCP_METHOD_NOT_ALLOWED",
            message: "POST only",
            retryable: false
          }
        });
      }

      if (request.method === "POST" && request.url === "/mcp") {
        const body = JSON.parse(await readRequestBody(request)) as RemoteMcpRequest["body"];
        mcpRequests.push({
          authorization: request.headers.authorization,
          body
        });

        if (options.mcpStatus !== undefined) {
          return sendJson(response, options.mcpStatus, options.mcpBody ?? {});
        }

        if (body.method === "initialize") {
          return sendJson(response, 200, {
            jsonrpc: "2.0",
            id: body.id,
            result: {
              protocolVersion: (body.params as { protocolVersion?: string }).protocolVersion,
              capabilities: {
                tools: {}
              },
              serverInfo: {
                name: "remote-enterprise-hub-test",
                version: "0.0.0"
              }
            }
          });
        }

        if (body.method === "notifications/initialized") {
          response.statusCode = 202;
          response.end();
          return;
        }

        if (body.method === "tools/call") {
          return sendJson(response, 200, {
            jsonrpc: "2.0",
            id: body.id,
            result: options.toolResult ?? jsonResponseBody({ ok: true })
          });
        }

        return sendJson(response, 400, {
          jsonrpc: "2.0",
          id: body.id ?? null,
          error: {
            code: -32601,
            message: "Unknown method"
          }
        });
      }

      return sendJson(response, 404, { error: { code: "NOT_FOUND" } });
    } catch {
      return sendJson(response, 500, { error: { code: "TEST_STUB_ERROR" } });
    }
  });

  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();

  if (address === null || typeof address === "string") {
    throw new Error("Expected local TCP server address.");
  }

  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    mcpRequests,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
            return;
          }

          resolve();
        });
      })
  };
}

async function readRequestBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];

  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  return Buffer.concat(chunks).toString("utf8");
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, {
    "content-type": "application/json"
  });
  response.end(JSON.stringify(body));
}

function jsonResponseBody(payload: unknown): McpJsonToolResult {
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(payload)
      }
    ],
    isError: false
  };
}

function jsonErrorResult(code: string, message: string): McpJsonToolResult {
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify({
          error: {
            code,
            message,
            retryable: false
          }
        })
      }
    ],
    isError: true
  };
}
