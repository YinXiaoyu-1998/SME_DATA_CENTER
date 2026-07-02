import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createEnterpriseHubApiClient } from "./api-client.js";
import { type McpRuntimeConfig } from "./config.js";
import { createToolHandler } from "./server.js";
import { LocalMcpSessionStore, type McpEmployeeSession } from "./session-store.js";

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

const baoliSession: McpEmployeeSession = {
  apiUrl: "http://api.test",
  accessToken: "baoli-token",
  createdAt: "2026-07-02T00:00:00.000Z",
  employee: {
    id: "emp_baoli_manager",
    email: "baoli.manager@example.com",
    role: "manager",
    disabled: false,
    labels: ["all_staff", "person:baoli.manager", "store:baoli"]
  }
};

describe("MCP document, label, and skill tools", () => {
  let tempDir: string | undefined;

  afterEach(async () => {
    if (tempDir) {
      await rm(tempDir, { recursive: true, force: true });
      tempDir = undefined;
    }
  });

  async function createSessionStore(): Promise<LocalMcpSessionStore> {
    tempDir = await mkdtemp(path.join(os.tmpdir(), "enterprise-hub-mcp-tools-test-"));
    const sessionStore = new LocalMcpSessionStore(path.join(tempDir, ".data", "mcp-session.json"));
    await sessionStore.saveSession("baoli", baoliSession);
    return sessionStore;
  }

  function createHandler(
    toolName: string,
    fetchImplementation: typeof fetch
  ): Promise<ReturnType<typeof createToolHandler>> {
    return createSessionStore().then((sessionStore) =>
      createToolHandler(toolName, {
        apiClient: createEnterpriseHubApiClient(baseConfig, fetchImplementation),
        config: baseConfig,
        sessionStore
      })
    );
  }

  it("lists labels through authenticated GET /labels", async () => {
    const calls: FetchCall[] = [];
    const handler = await createHandler("enterprise_hub_list_labels", async (url, init) => {
      calls.push({ url: String(url), init });
      return jsonResponse({
        labels: [
          {
            key: "store:baoli",
            name: "Baoli Store",
            type: "store"
          }
        ]
      });
    });

    const result = await handler({ sessionName: "baoli" });

    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      url: "http://api.test/labels",
      init: {
        method: "GET"
      }
    });
    expectAuthorization(calls[0]?.init?.headers, "Bearer baoli-token");
    expect(result.isError).toBe(false);
    expect(parseToolJson(result)).toEqual({
      labels: [
        {
          key: "store:baoli",
          name: "Baoli Store",
          type: "store"
        }
      ]
    });
  });

  it("uploads a local file through authenticated multipart POST /documents", async () => {
    const calls: FetchCall[] = [];
    const uploadPath = path.join(await createTempDir(), "baoli-june-meituan.csv");
    await writeFile(uploadPath, "date,store,orders\n2026-06-01,baoli,12\n");
    const handler = await createHandler("enterprise_hub_upload_document", async (url, init) => {
      calls.push({ url: String(url), init });
      return jsonResponse({
        id: "doc_pending",
        title: "Baoli June Meituan Export",
        documentType: "raw_material",
        status: "pending_processing",
        labels: ["person:baoli.manager", "store:baoli"],
        processingRunStatus: "queued"
      });
    });

    const result = await handler({
      sessionName: "baoli",
      filePath: uploadPath,
      title: "Baoli June Meituan Export",
      documentType: "raw_material",
      sourceSystem: "meituan",
      sourceTime: "2026-06-30T00:00:00.000Z",
      labelKeys: ["store:baoli"]
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      url: "http://api.test/documents",
      init: {
        method: "POST"
      }
    });
    expectAuthorization(calls[0]?.init?.headers, "Bearer baoli-token");
    const formData = calls[0]?.init?.body;
    expect(formData).toBeInstanceOf(FormData);
    expect((formData as FormData).get("title")).toBe("Baoli June Meituan Export");
    expect((formData as FormData).get("documentType")).toBe("raw_material");
    expect((formData as FormData).get("sourceSystem")).toBe("meituan");
    expect((formData as FormData).get("sourceTime")).toBe("2026-06-30T00:00:00.000Z");
    expect((formData as FormData).getAll("labelKeys[]")).toEqual(["store:baoli"]);
    const file = (formData as FormData).get("file");
    expect(file).toBeInstanceOf(File);
    expect((file as File).name).toBe("baoli-june-meituan.csv");
    expect(await (file as File).text()).toContain("baoli,12");
    expect(parseToolJson(result)).toMatchObject({
      id: "doc_pending",
      status: "pending_processing",
      labels: ["person:baoli.manager", "store:baoli"],
      processingRunStatus: "queued"
    });
  });

  it("returns a safe local-file error before upload when the file path is missing", async () => {
    const calls: FetchCall[] = [];
    const handler = await createHandler("enterprise_hub_upload_document", async (url, init) => {
      calls.push({ url: String(url), init });
      return jsonResponse({});
    });

    const result = await handler({
      sessionName: "baoli",
      filePath: path.join(await createTempDir(), "missing.csv"),
      title: "Missing",
      documentType: "raw_material"
    });

    expect(calls).toHaveLength(0);
    expect(result.isError).toBe(true);
    expect(parseToolJson(result)).toEqual({
      error: {
        code: "LOCAL_FILE_NOT_FOUND",
        message: "Local upload file was not found."
      }
    });
  });

  it("gets document status through authenticated GET /documents/:id/status", async () => {
    const calls: FetchCall[] = [];
    const handler = await createHandler("enterprise_hub_get_document_status", async (url, init) => {
      calls.push({ url: String(url), init });
      return jsonResponse({
        id: "doc_pending",
        status: "pending_processing",
        labels: ["store:baoli"],
        processingRunStatus: "queued"
      });
    });

    const result = await handler({ sessionName: "baoli", documentId: "doc_pending" });

    expect(calls[0]).toMatchObject({
      url: "http://api.test/documents/doc_pending/status",
      init: {
        method: "GET"
      }
    });
    expectAuthorization(calls[0]?.init?.headers, "Bearer baoli-token");
    expect(parseToolJson(result)).toMatchObject({
      status: "pending_processing",
      processingRunStatus: "queued"
    });
  });

  it("searches visible active documents with query filters delegated to the API", async () => {
    const calls: FetchCall[] = [];
    const handler = await createHandler("enterprise_hub_search_documents", async (url, init) => {
      calls.push({ url: String(url), init });
      return jsonResponse({
        documents: [
          {
            id: "doc_active",
            title: "Baoli June Meituan Export",
            status: "active",
            labels: ["store:baoli"]
          }
        ],
        nextCursor: null
      });
    });

    const result = await handler({
      sessionName: "baoli",
      q: "Meituan",
      documentType: "raw_material",
      labelKey: "store:baoli",
      limit: 10,
      cursor: "20"
    });

    expect(calls[0]?.url).toBe(
      "http://api.test/documents?q=Meituan&documentType=raw_material&labelKey=store%3Abaoli&limit=10&cursor=20"
    );
    expectAuthorization(calls[0]?.init?.headers, "Bearer baoli-token");
    expect(parseToolJson(result)).toMatchObject({
      documents: [
        {
          id: "doc_active",
          status: "active"
        }
      ],
      nextCursor: null
    });
  });

  it("gets document metadata and preserves API not-found semantics", async () => {
    const successHandler = await createHandler("enterprise_hub_get_document", async () =>
      jsonResponse({
        id: "doc_active",
        title: "Baoli June Meituan Export",
        status: "active",
        labels: ["store:baoli"]
      })
    );
    const notFoundHandler = await createHandler("enterprise_hub_get_document", async () =>
      jsonResponse(
        {
          error: {
            code: "DOCUMENT_NOT_FOUND",
            message: "Document not found."
          }
        },
        404
      )
    );

    expect(
      parseToolJson(await successHandler({ sessionName: "baoli", documentId: "doc_active" }))
    ).toMatchObject({
      id: "doc_active",
      status: "active"
    });
    const notFoundResult = await notFoundHandler({
      sessionName: "baoli",
      documentId: "hidden_doc"
    });
    expect(notFoundResult.isError).toBe(true);
    expect(parseToolJson(notFoundResult)).toEqual({
      error: {
        code: "DOCUMENT_NOT_FOUND",
        message: "Document not found."
      }
    });
  });

  it("gets document download URLs through the API without reading storage directly", async () => {
    const calls: FetchCall[] = [];
    const handler = await createHandler(
      "enterprise_hub_get_document_download_url",
      async (url, init) => {
        calls.push({ url: String(url), init });
        return jsonResponse({
          id: "doc_active",
          downloadUrl: "file:///tmp/baoli-june-meituan.csv"
        });
      }
    );

    const result = await handler({ sessionName: "baoli", documentId: "doc_active" });

    expect(calls[0]?.url).toBe("http://api.test/documents/doc_active/download");
    expectAuthorization(calls[0]?.init?.headers, "Bearer baoli-token");
    expect(parseToolJson(result)).toEqual({
      id: "doc_active",
      downloadUrl: "file:///tmp/baoli-june-meituan.csv"
    });
  });

  it("archives documents through authenticated POST /documents/:id/archive", async () => {
    const calls: FetchCall[] = [];
    const handler = await createHandler("enterprise_hub_archive_document", async (url, init) => {
      calls.push({ url: String(url), init });
      return jsonResponse({
        id: "doc_active",
        status: "archived",
        labels: ["store:baoli"]
      });
    });

    const result = await handler({ sessionName: "baoli", documentId: "doc_active" });

    expect(calls[0]).toMatchObject({
      url: "http://api.test/documents/doc_active/archive",
      init: {
        method: "POST"
      }
    });
    expectAuthorization(calls[0]?.init?.headers, "Bearer baoli-token");
    expect(parseToolJson(result)).toMatchObject({
      id: "doc_active",
      status: "archived"
    });
  });

  it("preserves archive API authorization errors", async () => {
    const handler = await createHandler("enterprise_hub_archive_document", async () =>
      jsonResponse(
        {
          error: {
            code: "DOCUMENT_UPDATE_FORBIDDEN",
            message: "Document cannot be changed."
          }
        },
        403
      )
    );

    const result = await handler({ sessionName: "baoli", documentId: "doc_active" });

    expect(result.isError).toBe(true);
    expect(parseToolJson(result)).toEqual({
      error: {
        code: "DOCUMENT_UPDATE_FORBIDDEN",
        message: "Document cannot be changed."
      }
    });
  });

  it("lists approved skills without executing them", async () => {
    const calls: FetchCall[] = [];
    const handler = await createHandler("enterprise_hub_list_skills", async (url, init) => {
      calls.push({ url: String(url), init });
      return jsonResponse({
        skills: [
          {
            id: "skill_menu_gross_margin_analysis",
            name: "menu-gross-margin-analysis",
            installInstructions:
              "Install the approved menu-gross-margin-analysis skill in the employee agent.",
            status: "approved"
          }
        ]
      });
    });

    const result = await handler({
      sessionName: "baoli",
      q: "菜单",
      category: "menu-analysis"
    });

    expect(calls[0]?.url).toBe(
      "http://api.test/skills?q=%E8%8F%9C%E5%8D%95&category=menu-analysis"
    );
    expectAuthorization(calls[0]?.init?.headers, "Bearer baoli-token");
    const body = parseToolJson(result);
    expect(body).toMatchObject({
      skills: [
        {
          name: "menu-gross-margin-analysis",
          status: "approved"
        }
      ]
    });
    expect(JSON.stringify(body)).not.toContain("executionResult");
  });

  async function createTempDir(): Promise<string> {
    if (!tempDir) {
      tempDir = await mkdtemp(path.join(os.tmpdir(), "enterprise-hub-mcp-tools-test-"));
    }

    return tempDir;
  }
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

function expectAuthorization(headers: HeadersInit | undefined, expected: string): void {
  expect(new Headers(headers).get("authorization")).toBe(expected);
}
