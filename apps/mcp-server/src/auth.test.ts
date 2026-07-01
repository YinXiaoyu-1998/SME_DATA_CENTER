import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createEnterpriseHubApiClient } from "./api-client.js";
import { type McpRuntimeConfig } from "./config.js";
import { loginDevTool } from "./auth.js";
import { createToolHandler } from "./server.js";
import { LocalMcpSessionStore } from "./session-store.js";

interface FetchCall {
  url: string;
  init: RequestInit | undefined;
}

const baseConfig: McpRuntimeConfig = {
  apiUrl: "http://api.test",
  profile: "local-development",
  sessionFile: "/unused/session.json",
  transport: "stdio"
};

describe("MCP local development auth", () => {
  let tempDir: string | undefined;

  afterEach(async () => {
    if (tempDir) {
      await rm(tempDir, { recursive: true, force: true });
      tempDir = undefined;
    }
  });

  async function createSessionStore(): Promise<LocalMcpSessionStore> {
    tempDir = await mkdtemp(path.join(os.tmpdir(), "enterprise-hub-mcp-test-"));
    return new LocalMcpSessionStore(path.join(tempDir, ".data", "mcp-session.json"));
  }

  it("logs in with the API dev-login endpoint and stores a token without returning it", async () => {
    const calls: FetchCall[] = [];
    const sessionStore = await createSessionStore();
    const apiClient = createEnterpriseHubApiClient(baseConfig, async (url, init) => {
      calls.push({ url: String(url), init });
      return jsonResponse({
        accessToken: "secret-mcp-token",
        employee: {
          id: "emp_baoli_manager",
          email: "baoli.manager@example.com",
          role: "manager",
          disabled: false,
          labels: ["all_staff", "person:baoli.manager", "store:baoli"]
        }
      });
    });

    const result = await loginDevTool(
      { email: "baoli.manager@example.com", sessionName: "baoli" },
      { apiClient, config: baseConfig, sessionStore }
    );

    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      url: "http://api.test/auth/dev-login",
      init: {
        method: "POST"
      }
    });
    expect(calls[0]?.init?.body).toBe(JSON.stringify({ email: "baoli.manager@example.com" }));
    expect(result.isError).toBe(false);
    expect(JSON.stringify(result)).not.toContain("secret-mcp-token");
    expect(parseToolJson(result)).toMatchObject({
      employee: {
        email: "baoli.manager@example.com"
      },
      sessionName: "baoli",
      apiUrl: "http://api.test"
    });
    expect(await readFile(sessionStore.filePath, "utf8")).toContain("secret-mcp-token");
  });

  it("returns a clear API error for an unknown employee", async () => {
    const sessionStore = await createSessionStore();
    const apiClient = createEnterpriseHubApiClient(baseConfig, async () =>
      jsonResponse(
        {
          error: {
            code: "EMPLOYEE_NOT_FOUND",
            message: "Employee not found."
          }
        },
        404
      )
    );

    const result = await loginDevTool(
      { email: "missing@example.com" },
      { apiClient, config: baseConfig, sessionStore }
    );

    expect(result.isError).toBe(true);
    expect(parseToolJson(result)).toMatchObject({
      error: {
        code: "EMPLOYEE_NOT_FOUND",
        message: "Employee not found."
      }
    });
  });

  it("returns a clear API error for a disabled employee", async () => {
    const sessionStore = await createSessionStore();
    const apiClient = createEnterpriseHubApiClient(baseConfig, async () =>
      jsonResponse(
        {
          error: {
            code: "EMPLOYEE_DISABLED",
            message: "Employee account is disabled."
          }
        },
        403
      )
    );

    const result = await loginDevTool(
      { email: "disabled@example.com" },
      { apiClient, config: baseConfig, sessionStore }
    );

    expect(result.isError).toBe(true);
    expect(parseToolJson(result)).toMatchObject({
      error: {
        code: "EMPLOYEE_DISABLED"
      }
    });
  });

  it("keeps multiple named local employee sessions without overwriting each other", async () => {
    const sessionStore = await createSessionStore();
    const apiClient = createEnterpriseHubApiClient(baseConfig, async (url, init) => {
      const request = JSON.parse(String(init?.body)) as { email: string };
      const employeeKey = request.email.startsWith("baoli") ? "baoli" : "suzhou";

      return jsonResponse({
        accessToken: `${employeeKey}-token`,
        employee: {
          id: `emp_${employeeKey}_manager`,
          email: request.email,
          role: "manager",
          disabled: false,
          labels: [`store:${employeeKey}`]
        }
      });
    });

    await loginDevTool(
      { email: "baoli.manager@example.com", sessionName: "baoli" },
      { apiClient, config: baseConfig, sessionStore }
    );
    await loginDevTool(
      { email: "suzhou.manager@example.com", sessionName: "suzhou" },
      { apiClient, config: baseConfig, sessionStore }
    );

    await expect(sessionStore.requireSession("baoli")).resolves.toMatchObject({
      accessToken: "baoli-token",
      employee: {
        email: "baoli.manager@example.com"
      }
    });
    await expect(sessionStore.requireSession("suzhou")).resolves.toMatchObject({
      accessToken: "suzhou-token",
      employee: {
        email: "suzhou.manager@example.com"
      }
    });
  });

  it("returns a clear session-required error before Day 3 document and skill tools run", async () => {
    const sessionStore = await createSessionStore();
    const apiClient = createEnterpriseHubApiClient(baseConfig, async () => jsonResponse({}));
    const searchHandler = createToolHandler("enterprise_hub_search_documents", {
      apiClient,
      config: baseConfig,
      sessionStore
    });
    const skillsHandler = createToolHandler("enterprise_hub_list_skills", {
      apiClient,
      config: baseConfig,
      sessionStore
    });

    await expect(searchHandler({})).resolves.toMatchObject({
      isError: true
    });
    expect(parseToolJson(await searchHandler({}))).toEqual({
      error: {
        code: "MCP_SESSION_REQUIRED",
        message:
          "Run enterprise_hub_login_dev first or pass sessionName for an existing local MCP session."
      }
    });
    expect(parseToolJson(await skillsHandler({}))).toMatchObject({
      error: {
        code: "MCP_SESSION_REQUIRED"
      }
    });
  });
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json"
    }
  });
}

function parseToolJson(result: { content: Array<{ type: "text"; text: string }> }): unknown {
  return JSON.parse(result.content[0]?.text ?? "null");
}
