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

  it("searches evidence chunks through authenticated POST /v1/evidence/search without answers", async () => {
    const calls: FetchCall[] = [];
    const handler = await createHandler("search_document_evidence", async (url, init) => {
      calls.push({ url: String(url), init });
      return jsonResponse({
        results: [
          {
            chunkId: "chk_1",
            documentId: "doc_evidence",
            documentTitle: "客户反馈处理 SOP.docx",
            text: "差评处理 SOP：先联系客户，再登记处置结果。",
            source: {
              fileType: "docx",
              sectionHeadingPath: ["客户反馈", "差评处理"],
              blockType: "paragraph",
              pageNumber: null
            },
            matchedBy: ["dense", "lexical", "rerank"]
          }
        ],
        page: { limit: 10, nextCursor: null, hasMore: false },
        retrieval: { retrievalConfigVersion: "phase3.retrieval.v1", rerankStatus: "enabled" },
        warnings: []
      });
    });

    const result = await handler({
      sessionName: "baoli",
      query: "差评处理 SOP",
      filters: {
        fileTypes: ["docx"],
        documentIds: ["doc_evidence"],
        labelIds: ["lbl_all_staff"]
      },
      limit: 10
    });

    expect(calls[0]).toMatchObject({
      url: "http://api.test/v1/evidence/search",
      init: {
        method: "POST"
      }
    });
    expectAuthorization(calls[0]?.init?.headers, "Bearer baoli-token");
    expect(new Headers(calls[0]?.init?.headers).get("content-type")).toBe("application/json");
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({
      query: "差评处理 SOP",
      filters: {
        fileTypes: ["docx"],
        documentIds: ["doc_evidence"],
        labelIds: ["lbl_all_staff"]
      },
      limit: 10,
      cursor: null
    });
    const body = parseToolJson(result);
    expect(body).toMatchObject({
      results: [
        {
          chunkId: "chk_1",
          text: "差评处理 SOP：先联系客户，再登记处置结果。"
        }
      ],
      retrieval: {
        retrievalConfigVersion: "phase3.retrieval.v1"
      }
    });
    expect(JSON.stringify(body)).not.toContain("answer");
  });

  it("lists structured dataset registry through authenticated GET /v1/structured/datasets", async () => {
    const calls: FetchCall[] = [];
    const handler = await createHandler("list_structured_datasets", async (url, init) => {
      calls.push({ url: String(url), init });
      return jsonResponse({
        limits: { defaultLimit: 50, maxRows: 200 },
        datasets: [
          {
            dataset: "dishes",
            registryVersion: "dishes.2026-07-11.v1",
            rowTable: "dish_rows",
            fields: [{ canonicalName: "business_date", operators: ["eq", "between"] }]
          }
        ]
      });
    });

    const result = await handler({ sessionName: "baoli" });

    expect(calls[0]).toMatchObject({
      url: "http://api.test/v1/structured/datasets",
      init: {
        method: "GET"
      }
    });
    expectAuthorization(calls[0]?.init?.headers, "Bearer baoli-token");
    expect(parseToolJson(result)).toMatchObject({
      datasets: [{ dataset: "dishes", registryVersion: "dishes.2026-07-11.v1" }]
    });
  });

  it("queries structured datasets through controlled authenticated POST /v1/structured/query", async () => {
    const calls: FetchCall[] = [];
    const handler = await createHandler("query_structured_dataset", async (url, init) => {
      calls.push({ url: String(url), init });
      return jsonResponse({
        dataset: "dishes",
        registryVersion: "dishes.2026-07-11.v1",
        mode: "detail",
        rows: [{ business_date: "2026-07-01", matched_product_name: "肉夹馍" }],
        nextCursor: null
      });
    });

    const result = await handler({
      sessionName: "baoli",
      dataset: "dishes",
      registryVersion: "dishes.2026-07-11.v1",
      select: ["business_date", "matched_product_name"],
      filter: {
        field: "matched_product_name",
        op: "contains",
        value: "肉夹馍"
      },
      sort: [{ field: "business_date", direction: "asc" }],
      page: { limit: 20 }
    });

    expect(calls[0]).toMatchObject({
      url: "http://api.test/v1/structured/query",
      init: {
        method: "POST"
      }
    });
    expectAuthorization(calls[0]?.init?.headers, "Bearer baoli-token");
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({
      dataset: "dishes",
      registryVersion: "dishes.2026-07-11.v1",
      select: ["business_date", "matched_product_name"],
      filter: {
        field: "matched_product_name",
        op: "contains",
        value: "肉夹馍"
      },
      sort: [{ field: "business_date", direction: "asc" }],
      page: { limit: 20 }
    });
    expect(parseToolJson(result)).toMatchObject({
      dataset: "dishes",
      mode: "detail",
      rows: [{ matched_product_name: "肉夹馍" }]
    });
  });

  it("uploads structured datasets through authenticated multipart POST /v1/structured/imports", async () => {
    const calls: FetchCall[] = [];
    const uploadPath = path.join(await createTempDir(), "maijia-dishes.csv");
    await writeFile(uploadPath, "营业日,匹配商品名称\n2026-07-01,肉夹馍\n");
    const handler = await createHandler("upload_structured_dataset", async (url, init) => {
      calls.push({ url: String(url), init });
      return jsonResponse(
        {
          document: {
            documentId: "doc_structured",
            documentKind: "structured",
            fileType: "csv",
            status: "active",
            originalFileName: "maijia-dishes.csv"
          },
          processing: { processingRunId: null, status: "succeeded" },
          importBatch: {
            importBatchId: "imp_1",
            dataset: "dishes",
            status: "applied",
            appliedRowCount: 1,
            queryableRowCount: 1
          }
        },
        202
      );
    });

    const result = await handler({
      sessionName: "baoli",
      filePath: uploadPath,
      dataset: "dishes",
      enterpriseName: "麦家",
      startDate: "20260701",
      endDate: "20260705",
      idempotencyKey: "structured-retry-key",
      labelKeys: ["store:baoli"]
    });

    expect(calls[0]).toMatchObject({
      url: "http://api.test/v1/structured/imports",
      init: {
        method: "POST"
      }
    });
    expectAuthorization(calls[0]?.init?.headers, "Bearer baoli-token");
    const formData = calls[0]?.init?.body as FormData;
    expect(formData).toBeInstanceOf(FormData);
    expect(formData.get("dataset")).toBe("dishes");
    expect(formData.get("enterprise_name")).toBe("麦家");
    expect(formData.get("startDate")).toBe("20260701");
    expect(formData.get("endDate")).toBe("20260705");
    expect(formData.get("idempotencyKey")).toBe("structured-retry-key");
    expect(formData.getAll("labelKeys[]")).toEqual(["store:baoli"]);
    expect((formData.get("file") as File).name).toBe("maijia-dishes.csv");
    expect(parseToolJson(result)).toMatchObject({
      importBatch: {
        importBatchId: "imp_1",
        status: "applied"
      }
    });
  });

  it("requires explicit structured import labels before calling the API", async () => {
    const calls: FetchCall[] = [];
    const uploadPath = path.join(await createTempDir(), "maijia-dishes.csv");
    await writeFile(uploadPath, "营业日,匹配商品名称\n2026-07-01,肉夹馍\n");
    const handler = await createHandler("upload_structured_dataset", async (url, init) => {
      calls.push({ url: String(url), init });
      return jsonResponse({});
    });

    await expect(
      handler({
        sessionName: "baoli",
        filePath: uploadPath,
        dataset: "dishes",
        enterpriseName: "麦家",
        startDate: "20260701",
        endDate: "20260705",
        idempotencyKey: "missing-labels",
        labelKeys: []
      })
    ).rejects.toThrow();
    expect(calls).toHaveLength(0);
  });

  it("uploads evidence documents through authenticated multipart POST /v1/documents/evidence", async () => {
    const calls: FetchCall[] = [];
    const uploadPath = path.join(await createTempDir(), "feedback-sop.md");
    await writeFile(uploadPath, "# 差评处理 SOP\n先联系客户，再登记处置结果。\n");
    const handler = await createHandler("upload_evidence_document", async (url, init) => {
      calls.push({ url: String(url), init });
      return jsonResponse(
        {
          document: {
            documentId: "doc_evidence",
            documentKind: "evidence",
            fileType: "md",
            status: "pending_processing"
          },
          processing: { processingRunId: null, status: "queued" },
          documentIndex: {
            status: "pending",
            retrievalConfigVersion: "phase3.retrieval.v1"
          }
        },
        202
      );
    });

    const result = await handler({
      sessionName: "baoli",
      filePath: uploadPath,
      title: "客户反馈处理 SOP",
      sourceSystem: "manual",
      labelKeys: ["all_staff"]
    });

    expect(calls[0]).toMatchObject({
      url: "http://api.test/v1/documents/evidence",
      init: {
        method: "POST"
      }
    });
    expectAuthorization(calls[0]?.init?.headers, "Bearer baoli-token");
    const formData = calls[0]?.init?.body as FormData;
    expect(formData).toBeInstanceOf(FormData);
    expect(formData.get("title")).toBe("客户反馈处理 SOP");
    expect(formData.get("sourceSystem")).toBe("manual");
    expect(formData.getAll("labelKeys[]")).toEqual(["all_staff"]);
    expect((formData.get("file") as File).name).toBe("feedback-sop.md");
    expect(await (formData.get("file") as File).text()).toContain("差评处理 SOP");
    expect(parseToolJson(result)).toMatchObject({
      document: {
        documentKind: "evidence",
        status: "pending_processing"
      },
      documentIndex: {
        status: "pending"
      }
    });
  });

  it("requires explicit evidence labels before calling the API", async () => {
    const calls: FetchCall[] = [];
    const uploadPath = path.join(await createTempDir(), "feedback-sop.md");
    await writeFile(uploadPath, "# 差评处理 SOP\n");
    const handler = await createHandler("upload_evidence_document", async (url, init) => {
      calls.push({ url: String(url), init });
      return jsonResponse({});
    });

    await expect(
      handler({
        sessionName: "baoli",
        filePath: uploadPath,
        title: "客户反馈处理 SOP",
        labelKeys: []
      })
    ).rejects.toThrow();
    expect(calls).toHaveLength(0);
  });

  it("gets structured import status and preserves import API not-found semantics", async () => {
    const successHandler = await createHandler("get_import_status", async () =>
      jsonResponse({
        importBatch: {
          importBatchId: "imp_1",
          dataset: "dishes",
          status: "applied",
          queryableRowCount: 1
        }
      })
    );
    const notFoundHandler = await createHandler("get_import_status", async () =>
      jsonResponse(
        {
          error: {
            code: "IMPORT_BATCH_NOT_FOUND",
            message: "Import batch not found."
          }
        },
        404
      )
    );

    expect(
      parseToolJson(await successHandler({ sessionName: "baoli", importBatchId: "imp_1" }))
    ).toMatchObject({
      importBatch: {
        status: "applied"
      }
    });
    const notFoundResult = await notFoundHandler({
      sessionName: "baoli",
      importBatchId: "hidden_import"
    });
    expect(notFoundResult.isError).toBe(true);
    expect(parseToolJson(notFoundResult)).toEqual({
      error: {
        code: "IMPORT_BATCH_NOT_FOUND",
        message: "Import batch not found."
      }
    });
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
