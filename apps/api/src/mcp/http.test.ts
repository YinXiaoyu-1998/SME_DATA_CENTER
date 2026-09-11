import Fastify, { type FastifyInstance } from "fastify";
import type { InjectOptions, InjectPayload, Response as InjectResponse } from "light-my-request";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AuthenticatedEmployee } from "@enterprise-hub/domain";
import { ENTERPRISE_HUB_MCP_TOOL_NAMES, type McpErrorBody } from "@enterprise-hub/mcp-contract";
import { buildApiServer } from "../server.js";
import type { EmployeeRepository } from "../employees.js";
import type { DocumentCatalogRepository, DocumentStatusRecord } from "../documents.js";
import type { EvidenceSearchInput, EvidenceSearchRepository } from "../evidence.js";
import type { SkillDirectoryRepository } from "../skills.js";
import type {
  StructuredImportBatchRecord,
  StructuredImportRepository
} from "../structured-imports.js";
import type { StructuredCoverageRepository } from "../structured-coverage.js";
import type { StructuredQueryRepository } from "../structured-query.js";
import { registerMcpHttpRoute } from "./http.js";
import type { EnterpriseHubMcpToolHandlers, McpRequestContext } from "./tool-handlers.js";

const jwtSecret = "test-local-jwt-secret";
const officialTestTokens = new Map<string, AuthenticatedEmployee>();

async function authenticateTestAccessToken(token: string) {
  return officialTestTokens.get(token) ?? null;
}

const employee: AuthenticatedEmployee = {
  id: "emp_mcp",
  orgId: "default-org",
  displayName: "MCP Manager",
  email: "mcp.employee@example.com",
  role: "manager",
  disabled: false,
  labels: ["all_staff", "person:mcp.employee", "store:baoli"]
};

const adminEmployee: AuthenticatedEmployee = {
  id: "emp_mcp_admin",
  orgId: "default-org",
  displayName: "MCP Administrator",
  email: "mcp.admin@example.com",
  role: "admin",
  disabled: false,
  labels: ["all_staff", "person:mcp.admin", "store:baoli"]
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });

  return { promise, resolve };
}

function createRepository(employees: AuthenticatedEmployee[]): EmployeeRepository {
  return {
    async findByEmail(email: string) {
      return employees.find((candidate) => candidate.email === email) ?? null;
    },
    async findById(id: string) {
      return employees.find((candidate) => candidate.id === id) ?? null;
    }
  };
}

function buildMcpTestServer(overrides: Partial<Parameters<typeof buildApiServer>[0]> = {}) {
  return buildApiServer({
    employeeRepository: createRepository([employee, adminEmployee]),
    cursorSigningSecret: jwtSecret,
    authenticateAccessToken: authenticateTestAccessToken,
    logger: false,
    ...overrides
  });
}

async function accessToken(authenticatedEmployee = employee) {
  const token = `eh_at_test_${authenticatedEmployee.id}`;
  officialTestTokens.set(token, authenticatedEmployee);
  return token;
}

function initializeRequest(id = 1) {
  return {
    jsonrpc: "2.0",
    id,
    method: "initialize",
    params: {
      protocolVersion: "2025-11-25",
      capabilities: {},
      clientInfo: {
        name: "enterprise-hub-api-test",
        version: "0.0.0"
      }
    }
  };
}

async function postMcp(
  app: FastifyInstance,
  payload: InjectPayload,
  headers: Record<string, string> = {},
  options: Pick<InjectOptions, "remoteAddress"> & { employee?: AuthenticatedEmployee } = {}
): Promise<InjectResponse> {
  return app.inject({
    method: "POST",
    url: "/mcp",
    ...options,
    headers: {
      host: "127.0.0.1:3000",
      authorization: `Bearer ${await accessToken(options.employee)}`,
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...headers
    },
    payload
  });
}

function parseJsonRpc(responsePayload: string) {
  return JSON.parse(responsePayload) as {
    jsonrpc: "2.0";
    id: string | number | null;
    result?: Record<string, unknown>;
    error?: { code: number; message: string; data?: unknown };
  };
}

function parseToolPayload(responsePayload: string) {
  const result = parseJsonRpc(responsePayload).result as
    { content?: Array<{ type: string; text: string }>; isError?: boolean } | undefined;
  const text = result?.content?.[0]?.text;

  if (!text) {
    throw new Error(`Missing MCP tool text content: ${responsePayload}`);
  }

  return {
    result,
    payload: JSON.parse(text) as unknown
  };
}

function fakeDocumentRepository(): DocumentCatalogRepository {
  const labels = [
    { id: "lbl_all_staff", key: "all_staff", name: "All staff", type: "system" },
    { id: "lbl_store_baoli", key: "store:baoli", name: "Baoli store", type: "store" },
    { id: "lbl_person_mcp", key: "person:mcp.employee", name: "MCP employee", type: "personal" }
  ];
  const evidenceStatus: DocumentStatusRecord = {
    id: "doc_evidence_status",
    orgId: "default-org",
    uploaderId: employee.id,
    title: "Evidence status doc",
    documentType: "management_knowledge",
    documentKind: "evidence",
    fileType: "md",
    status: "active",
    storageObjectKey: "evidence/doc_evidence_status.md",
    originalFileName: "evidence-status.md",
    contentType: "text/markdown",
    byteSize: 12,
    checksumSha256: "hash",
    sourceSystem: "manual",
    sourceTime: null,
    labels: ["all_staff"],
    processingRunStatus: "succeeded",
    documentIndexStatus: "indexed"
  };

  return {
    async listLabels() {
      return labels;
    },
    async findLabelsByKeys(_orgId, keys) {
      return labels.filter((label) => keys.includes(label.key));
    },
    async findPersonalLabelForEmployee() {
      return labels.find((label) => label.key === "person:mcp.employee") ?? null;
    },
    async createUploadedDocument() {
      throw new Error("createUploadedDocument should not be called by this test.");
    },
    async findEvidenceDocumentStatus(_orgId, documentId) {
      return documentId === evidenceStatus.id ? evidenceStatus : null;
    },
    async appendAuditLog() {},
    async archiveDocument() {
      return null;
    },
    async listAuditLogs() {
      return { auditLogs: [], nextCursor: null };
    }
  };
}

function fakeSkillRepository(): SkillDirectoryRepository {
  return {
    async listApprovedSkills(input) {
      return [
        {
          id: "skill_menu",
          name: "Menu analysis",
          description: `q=${input.q ?? ""};category=${input.category ?? ""}`,
          version: "1.0.0",
          category: "menu-analysis",
          inputRequirements: ["sales data"],
          installInstructions: "Install locally.",
          examplePrompts: ["Analyze menu mix."],
          status: "approved"
        }
      ];
    }
  };
}

function fakeStructuredImportRepository(): StructuredImportRepository {
  const importBatch: StructuredImportBatchRecord = {
    id: "imp_status",
    orgId: "default-org",
    sourceDocumentId: "doc_structured",
    sourceDocumentLabelKeys: ["store:baoli"],
    dataset: "dishes",
    status: "pending",
    startDate: "20260701",
    endDate: "20260731",
    sourceSheetSummary: [],
    validationErrors: [],
    validationErrorCount: 0,
    validationErrorsTruncated: false,
    totalRowCount: 2,
    appliedRowCount: 0,
    queryableRowCount: 0,
    sourceDocumentStatus: "pending_processing",
    sourceDocumentFileType: "csv",
    storageObjectKey: "org/default-org/documents/doc_structured/original/data.csv",
    originalFileName: "data.csv",
    processingRunId: "run_status",
    processingStatus: "queued"
  };

  return {
    async reserveStructuredImport() {
      throw new Error("reserveStructuredImport should not be called by this test.");
    },
    async applyReservedStructuredImport() {
      throw new Error("applyReservedStructuredImport should not be called by this test.");
    },
    async enqueueReservedStructuredImport() {
      throw new Error("enqueueReservedStructuredImport should not be called by this test.");
    },
    async markStructuredImportStorageFailure() {
      throw new Error("markStructuredImportStorageFailure should not be called by this test.");
    },
    async findImportBatch(orgId, importBatchId) {
      return importBatchId === importBatch.id && orgId === importBatch.orgId ? importBatch : null;
    }
  };
}

function fakeStructuredQueryRepository(): StructuredQueryRepository {
  return {
    async execute() {
      return {
        rows: [{ dish_name: "Noodles", sales_amount: 128 }],
        hasMore: false
      };
    }
  };
}

function fakeStructuredCoverageRepository(): StructuredCoverageRepository {
  return {
    async list(compiled) {
      return {
        dataset: compiled.dataset,
        metadataPolicy: "window",
        sources: [
          {
            importBatchId: "imp_coverage",
            sourceDocumentId: "doc_coverage",
            sourceDocumentTitle: "Coverage source",
            appliedAt: "2026-08-01T00:00:00.000Z",
            rowCount: 2,
            startDate: "2026-07-01",
            endDate: "2026-07-31"
          }
        ]
      };
    }
  };
}

function fakeEvidenceRepository(calls: EvidenceSearchInput[] = []): EvidenceSearchRepository {
  return {
    async searchEvidence(input) {
      calls.push(input);

      return {
        results: [
          {
            chunkId: "chk_1",
            documentId: "doc_evidence_status",
            documentTitle: "Evidence status doc",
            text: `result for ${input.query} as ${input.employee.email}`,
            sectionText: `result for ${input.query} as ${input.employee.email}`,
            sectionTruncated: false,
            source: {
              fileType: "md",
              sectionHeadingPath: ["Menu"],
              blockType: "paragraph",
              pageNumber: null
            },
            score: {
              hybrid: 0.91,
              rerank: null
            },
            matchedBy: ["dense"]
          }
        ],
        page: {
          limit: input.limit,
          nextCursor: null,
          hasMore: false
        },
        retrieval: {
          retrievalConfigVersion: "test",
          embeddingVersion: "test-embedding",
          lexicalIndexVersion: "test-lexical",
          rerankVersion: null,
          rerankStatus: "rerank_disabled"
        },
        warnings: []
      };
    }
  };
}

function buildLiveMcpApiTestServer(
  evidenceCalls: EvidenceSearchInput[] = [],
  overrides: Partial<Parameters<typeof buildApiServer>[0]> = {}
) {
  return buildMcpTestServer({
    documentRepository: fakeDocumentRepository(),
    skillRepository: fakeSkillRepository(),
    structuredImportRepository: fakeStructuredImportRepository(),
    structuredQueryRepository: fakeStructuredQueryRepository(),
    structuredCoverageRepository: fakeStructuredCoverageRepository(),
    evidenceRepository: fakeEvidenceRepository(evidenceCalls),
    ...overrides
  });
}

function expectErrorCode(body: McpErrorBody, code: string) {
  expect(body).toMatchObject({
    error: {
      code
    }
  });
}

function buildCustomMcpTestServer(toolHandlers: EnterpriseHubMcpToolHandlers) {
  const customApp = Fastify({
    logger: false,
    requestIdHeader: "x-request-id"
  });

  customApp.addHook("onRequest", async (request, reply) => {
    reply.header("x-request-id", request.id);
  });

  registerMcpHttpRoute(customApp, {
    maxUploadBytes: 52_428_800,
    delegationProof: Buffer.alloc(32, 0x5a).toString("base64url"),
    authenticate: async () => employee,
    toolHandlers
  });

  return customApp;
}

describe("stateless /mcp streamable HTTP endpoint", () => {
  let app: FastifyInstance | undefined;

  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  it("requires bearer auth before initialize or tool discovery can list tools", async () => {
    app = buildMcpTestServer();

    const response = await app.inject({
      method: "POST",
      url: "/mcp",
      headers: {
        host: "127.0.0.1:3000",
        "content-type": "application/json"
      },
      payload: initializeRequest()
    });

    expect(response.statusCode).toBe(401);
    expectErrorCode(response.json<McpErrorBody>(), "UNAUTHENTICATED");
    expect(response.payload).not.toContain("upload_evidence_document");
  });

  it("rejects non-loopback host headers even with a valid bearer token", async () => {
    app = buildMcpTestServer();

    const response = await postMcp(app, initializeRequest(), {
      host: "enterprise-hub.example.com"
    });

    expect(response.statusCode).toBe(403);
    expectErrorCode(response.json<McpErrorBody>(), "MCP_LOOPBACK_REQUIRED");
  });

  it("accepts the exact configured public Host only from a loopback reverse-proxy peer", async () => {
    app = buildMcpTestServer({
      runtimeEnv: {
        ENTERPRISE_HUB_PUBLIC_ORIGIN: "https://api.smedatacenter.xyz"
      }
    });

    const response = await postMcp(app, initializeRequest(), {
      host: "api.smedatacenter.xyz"
    });

    expect(response.statusCode).toBe(200);
    expect(parseJsonRpc(response.payload).result).toBeDefined();

    const directResponse = await postMcp(
      app,
      initializeRequest(),
      { host: "api.smedatacenter.xyz" },
      { remoteAddress: "198.51.100.10" }
    );
    expect(directResponse.statusCode).toBe(403);
    expectErrorCode(directResponse.json<McpErrorBody>(), "MCP_LOOPBACK_REQUIRED");
  });

  it("rejects non-loopback peer addresses even when Host is loopback", async () => {
    app = buildMcpTestServer();

    const response = await postMcp(
      app,
      initializeRequest(),
      {},
      { remoteAddress: "198.51.100.10" }
    );

    expect(response.statusCode).toBe(403);
    expectErrorCode(response.json<McpErrorBody>(), "MCP_LOOPBACK_REQUIRED");
  });

  it("does not apply MCP loopback peer restrictions to ordinary API routes", async () => {
    app = buildMcpTestServer();

    const response = await app.inject({
      method: "GET",
      url: "/healthz",
      remoteAddress: "198.51.100.10",
      headers: {
        host: "enterprise-hub.example.com"
      }
    });

    expect(response.statusCode).toBe(200);
  });

  it("rejects unsupported methods with Allow: POST after authentication", async () => {
    app = buildMcpTestServer();

    const response = await app.inject({
      method: "GET",
      url: "/mcp",
      headers: {
        host: "127.0.0.1:3000",
        authorization: `Bearer ${await accessToken()}`
      }
    });

    expect(response.statusCode).toBe(405);
    expect(response.headers["allow"]).toBe("POST");
    expectErrorCode(response.json<McpErrorBody>(), "MCP_METHOD_NOT_ALLOWED");
  });

  it("rejects unsupported media types with a stable MCP transport error", async () => {
    app = buildMcpTestServer();

    const response = await app.inject({
      method: "POST",
      url: "/mcp",
      headers: {
        host: "127.0.0.1:3000",
        authorization: `Bearer ${await accessToken()}`,
        "content-type": "text/plain"
      },
      payload: "not json"
    });

    expect(response.statusCode).toBe(415);
    expectErrorCode(response.json<McpErrorBody>(), "MCP_UNSUPPORTED_MEDIA_TYPE");
  });

  it("rejects client supplied MCP session IDs because the endpoint is stateless", async () => {
    app = buildMcpTestServer();

    const response = await postMcp(app, initializeRequest(), {
      "mcp-session-id": "client-session"
    });

    expect(response.statusCode).toBe(400);
    expectErrorCode(response.json<McpErrorBody>(), "MCP_SESSION_UNSUPPORTED");
  });

  it("maps malformed JSON and malformed JSON-RPC envelopes to stable 400 errors", async () => {
    app = buildMcpTestServer();

    const malformedJson = await app.inject({
      method: "POST",
      url: "/mcp",
      headers: {
        host: "127.0.0.1:3000",
        authorization: `Bearer ${await accessToken()}`,
        "content-type": "application/json"
      },
      payload: '{"jsonrpc":'
    });
    const malformedEnvelope = await postMcp(app, {
      jsonrpc: "2.0",
      id: 1,
      params: {}
    });

    expect(malformedJson.statusCode).toBe(400);
    expectErrorCode(malformedJson.json<McpErrorBody>(), "MCP_MALFORMED_JSON");
    expect(malformedEnvelope.statusCode).toBe(400);
    expectErrorCode(malformedEnvelope.json<McpErrorBody>(), "MCP_MALFORMED_ENVELOPE");
  });

  it("rejects JSON bodies over the typed MAX_UPLOAD_BYTES limit", async () => {
    app = buildMcpTestServer({
      runtimeEnv: { MAX_UPLOAD_BYTES: "1" }
    });

    const response = await postMcp(app, {
      jsonrpc: "2.0",
      id: 10,
      method: "tools/call",
      params: {
        name: "enterprise_hub_list_labels",
        arguments: {
          oversized: "x".repeat(70_000)
        }
      }
    });

    expect(response.statusCode).toBe(413);
    expectErrorCode(response.json<McpErrorBody>(), "MCP_REQUEST_TOO_LARGE");
  });

  it("uses the typed MCP concurrency override from API construction", async () => {
    const firstAuthenticationStarted = deferred<void>();
    const firstAuthentication = deferred<AuthenticatedEmployee>();
    let authenticationCalls = 0;

    app = buildMcpTestServer({
      authenticateAccessToken() {
        authenticationCalls += 1;

        if (authenticationCalls === 1) {
          firstAuthenticationStarted.resolve();
          return firstAuthentication.promise;
        }

        return Promise.resolve(employee);
      },
      runtimeEnv: { MCP_MAX_CONCURRENT_REQUESTS: "1" }
    });

    const firstRequest = postMcp(app, initializeRequest(10));
    await firstAuthenticationStarted.promise;

    const rejectedRequest = await postMcp(app, initializeRequest(11));

    expect(rejectedRequest.statusCode).toBe(503);
    expectErrorCode(rejectedRequest.json<McpErrorBody>(), "MCP_BUSY");

    firstAuthentication.resolve(employee);
    expect((await firstRequest).statusCode).toBe(200);
  });

  it("rejects invalid client-supplied MCP request IDs before SDK handoff", async () => {
    app = buildMcpTestServer();

    const response = await postMcp(app, initializeRequest(), {
      "x-request-id": "bad request id"
    });
    const body = response.json<McpErrorBody>();

    expect(response.statusCode).toBe(400);
    expectErrorCode(body, "MCP_INVALID_REQUEST_ID");
    expect(body.error.requestId).not.toBe("bad request id");
    expect(response.headers["x-request-id"]).not.toBe("bad request id");
  });

  it("rejects unacceptable Accept headers with a stable MCP envelope before SDK handoff", async () => {
    app = buildMcpTestServer();

    const response = await postMcp(app, initializeRequest(), {
      accept: "text/plain"
    });

    expect(response.statusCode).toBe(406);
    expectErrorCode(response.json<McpErrorBody>(), "MCP_NOT_ACCEPTABLE");
    expect(response.payload).not.toContain("Client must accept");
  });

  it("rejects unsupported MCP protocol version headers with a stable MCP envelope", async () => {
    app = buildMcpTestServer();

    const response = await postMcp(app, initializeRequest(), {
      "mcp-protocol-version": "1900-01-01"
    });

    expect(response.statusCode).toBe(400);
    expectErrorCode(response.json<McpErrorBody>(), "MCP_UNSUPPORTED_PROTOCOL_VERSION");
    expect(response.payload).not.toContain("supported versions");
  });

  it("keeps SDK initialize protocol negotiation compatible when only the body version is unsupported", async () => {
    app = buildMcpTestServer();

    const request = initializeRequest(20);
    request.params.protocolVersion = "1900-01-01";
    const response = await postMcp(app, request);

    expect(response.statusCode).toBe(200);
    expect(parseJsonRpc(response.payload).result).toMatchObject({
      protocolVersion: "2025-11-25"
    });
  });

  it("propagates the SDK abort signal into MCP tool context", async () => {
    const capturedContext = vi.fn<(context: McpRequestContext) => void>();
    app = buildCustomMcpTestServer({
      enterprise_hub_list_labels: async (_input, context) => {
        capturedContext(context);
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({ ok: true })
            }
          ],
          isError: false
        };
      }
    });

    const response = await postMcp(
      app,
      {
        jsonrpc: "2.0",
        id: 30,
        method: "tools/call",
        params: {
          name: "enterprise_hub_list_labels",
          arguments: {}
        }
      },
      {
        "mcp-protocol-version": "2025-11-25"
      }
    );

    expect(response.statusCode).toBe(200);
    expect(capturedContext).toHaveBeenCalledOnce();
    expect(capturedContext.mock.calls[0]?.[0].abortSignal).toBeInstanceOf(AbortSignal);
  });

  it("initializes without returning a session id and lists contract tools", async () => {
    app = buildMcpTestServer();

    const initialize = await postMcp(app, initializeRequest());
    const toolsList = await postMcp(
      app,
      {
        jsonrpc: "2.0",
        id: 2,
        method: "tools/list",
        params: {}
      },
      {
        "mcp-protocol-version": "2025-11-25"
      }
    );

    expect(initialize.statusCode).toBe(200);
    expect(initialize.headers["mcp-session-id"]).toBeUndefined();
    expect(parseJsonRpc(initialize.payload).result).toMatchObject({
      serverInfo: {
        name: "enterprise-hub-api-mcp"
      }
    });

    expect(toolsList.statusCode).toBe(200);
    expect(toolsList.headers["mcp-session-id"]).toBeUndefined();
    const toolNames = (
      parseJsonRpc(toolsList.payload).result?.["tools"] as Array<{ name: string }>
    ).map((tool) => tool.name);
    expect(toolNames).toEqual([...ENTERPRISE_HUB_MCP_TOOL_NAMES]);
  });

  it("returns only the current authenticated employee's self-profile", async () => {
    app = buildLiveMcpApiTestServer();
    const request = (id: number) => ({
      jsonrpc: "2.0",
      id,
      method: "tools/call",
      params: {
        name: "enterprise_hub_get_current_user",
        arguments: {}
      }
    });

    const managerResponse = await postMcp(
      app,
      request(20),
      { "mcp-protocol-version": "2025-11-25" },
      { employee }
    );
    const adminResponse = await postMcp(
      app,
      request(21),
      { "mcp-protocol-version": "2025-11-25" },
      { employee: adminEmployee }
    );

    expect(parseToolPayload(managerResponse.payload).payload).toEqual({
      user: {
        displayName: "MCP Manager",
        email: "mcp.employee@example.com",
        role: "manager"
      }
    });
    expect(parseToolPayload(adminResponse.payload).payload).toEqual({
      user: {
        displayName: "MCP Administrator",
        email: "mcp.admin@example.com",
        role: "admin"
      }
    });
  });

  it("serves live labels, structured coverage, structured query, evidence search, and status tools through MCP framing", async () => {
    app = buildLiveMcpApiTestServer();

    const labels = await postMcp(
      app,
      {
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: {
          name: "enterprise_hub_list_labels",
          arguments: {}
        }
      },
      {
        "mcp-protocol-version": "2025-11-25"
      }
    );
    const structuredDatasets = await postMcp(
      app,
      {
        jsonrpc: "2.0",
        id: 4,
        method: "tools/call",
        params: {
          name: "list_structured_datasets",
          arguments: {}
        }
      },
      {
        "mcp-protocol-version": "2025-11-25"
      }
    );
    const structuredQuery = await postMcp(
      app,
      {
        jsonrpc: "2.0",
        id: 5,
        method: "tools/call",
        params: {
          name: "query_structured_dataset",
          arguments: {
            dataset: "dishes",
            page: { limit: 1 }
          }
        }
      },
      {
        "mcp-protocol-version": "2025-11-25"
      }
    );
    const structuredCoverage = await postMcp(
      app,
      {
        jsonrpc: "2.0",
        id: 15,
        method: "tools/call",
        params: {
          name: "describe_structured_dataset_coverage",
          arguments: {
            dataset: "dishes"
          }
        }
      },
      {
        "mcp-protocol-version": "2025-11-25"
      }
    );
    const evidenceSearch = await postMcp(
      app,
      {
        jsonrpc: "2.0",
        id: 6,
        method: "tools/call",
        params: {
          name: "search_document_evidence",
          arguments: {
            query: "menu margin",
            limit: 3
          }
        }
      },
      {
        "mcp-protocol-version": "2025-11-25"
      }
    );
    const evidenceStatus = await postMcp(
      app,
      {
        jsonrpc: "2.0",
        id: 7,
        method: "tools/call",
        params: {
          name: "get_evidence_document_status",
          arguments: {
            documentId: "doc_evidence_status"
          }
        }
      },
      {
        "mcp-protocol-version": "2025-11-25"
      }
    );
    const importStatus = await postMcp(
      app,
      {
        jsonrpc: "2.0",
        id: 8,
        method: "tools/call",
        params: {
          name: "get_import_status",
          arguments: {
            importBatchId: "imp_status"
          }
        }
      },
      {
        "mcp-protocol-version": "2025-11-25"
      }
    );

    for (const response of [
      labels,
      structuredDatasets,
      structuredQuery,
      structuredCoverage,
      evidenceSearch,
      evidenceStatus,
      importStatus
    ]) {
      expect(response.statusCode).toBe(200);
      expect(response.payload).not.toContain("MCP_TOOL_NOT_IMPLEMENTED");
      expect(parseToolPayload(response.payload).result).toMatchObject({ isError: false });
    }

    expect(parseToolPayload(labels.payload).payload).toMatchObject({
      labels: expect.arrayContaining([expect.objectContaining({ key: "all_staff" })])
    });
    expect(parseToolPayload(structuredDatasets.payload).payload).toMatchObject({
      datasets: expect.arrayContaining([expect.objectContaining({ dataset: "dishes" })])
    });
    expect(parseToolPayload(structuredQuery.payload).payload).toMatchObject({
      dataset: "dishes",
      rows: [{ dish_name: "Noodles", sales_amount: 128 }]
    });
    expect(parseToolPayload(structuredCoverage.payload).payload).toMatchObject({
      dataset: "dishes",
      metadataPolicy: "window",
      sources: [expect.objectContaining({ importBatchId: "imp_coverage" })]
    });
    expect(parseToolPayload(evidenceSearch.payload).payload).toMatchObject({
      results: [expect.objectContaining({ chunkId: "chk_1" })],
      requestId: expect.any(String)
    });
    expect(parseToolPayload(evidenceStatus.payload).payload).toMatchObject({
      document: { documentId: "doc_evidence_status", documentKind: "evidence" },
      documentIndex: { status: "indexed" }
    });
    expect(parseToolPayload(importStatus.payload).payload).toMatchObject({
      importBatch: { importBatchId: "imp_status", dataset: "dishes", status: "pending" },
      processing: { status: "queued" }
    });
  });

  it("serves live upload handlers through MCP without filesystem path inputs", async () => {
    app = buildLiveMcpApiTestServer();

    const response = await postMcp(
      app,
      {
        jsonrpc: "2.0",
        id: 9,
        method: "tools/call",
        params: {
          name: "upload_evidence_document",
          arguments: {
            file: {
              name: "unknown-label.md",
              mediaType: "text/markdown",
              encoding: "base64",
              contentBase64: Buffer.from("# Evidence\n", "utf8").toString("base64")
            },
            title: "Unknown label evidence",
            labelKeys: ["missing_label"]
          }
        }
      },
      {
        "mcp-protocol-version": "2025-11-25"
      }
    );
    const tool = parseToolPayload(response.payload);

    expect(response.statusCode).toBe(200);
    expect(JSON.stringify(tool.result)).not.toContain("MCP_TOOL_NOT_IMPLEMENTED");
    expect(JSON.stringify(tool.result)).not.toContain("filePath");
    expect(tool.result).toMatchObject({ isError: true });
    expect(tool.payload).toMatchObject({
      error: {
        code: "UNKNOWN_LABEL",
        message: "One or more labels do not exist.",
        retryable: false
      }
    });
  });

  it("builds live handler state per request so delegated auth never reuses a prior bearer token", async () => {
    const evidenceCalls: EvidenceSearchInput[] = [];
    app = buildLiveMcpApiTestServer(evidenceCalls);

    const searchPayload = (id: number) => ({
      jsonrpc: "2.0",
      id,
      method: "tools/call",
      params: {
        name: "search_document_evidence",
        arguments: {
          query: `request ${id}`,
          limit: 1
        }
      }
    });

    const managerResponse = await postMcp(
      app,
      searchPayload(10),
      { "mcp-protocol-version": "2025-11-25", "x-request-id": "mcp-manager-req" },
      { employee }
    );
    const adminResponse = await postMcp(
      app,
      searchPayload(11),
      { "mcp-protocol-version": "2025-11-25", "x-request-id": "mcp-admin-req" },
      { employee: adminEmployee }
    );

    expect(managerResponse.statusCode).toBe(200);
    expect(adminResponse.statusCode).toBe(200);
    expect(evidenceCalls.map((call) => call.employee.email)).toEqual([
      employee.email,
      adminEmployee.email
    ]);
    expect(evidenceCalls.map((call) => call.audit.requestId)).toEqual([
      "mcp-manager-req",
      "mcp-admin-req"
    ]);
    expect(JSON.stringify(parseToolPayload(adminResponse.payload).payload)).toContain(
      adminEmployee.email
    );
    expect(JSON.stringify(parseToolPayload(adminResponse.payload).payload)).not.toContain(
      employee.email
    );
  });

  it("preserves the outer launcher audit context through delegated business routes", async () => {
    const evidenceCalls: EvidenceSearchInput[] = [];
    app = buildLiveMcpApiTestServer(evidenceCalls, {
      internalDelegationProof: Buffer.alloc(32, 0x5a).toString("base64url")
    });

    const response = await postMcp(
      app,
      {
        jsonrpc: "2.0",
        id: 12,
        method: "tools/call",
        params: {
          name: "search_document_evidence",
          arguments: {
            query: "delegated provenance",
            limit: 1
          }
        }
      },
      {
        "mcp-protocol-version": "2025-11-25",
        "x-forwarded-for": "203.0.113.9",
        "x-request-id": "mcp_request_1",
        "x-enterprise-hub-launcher-version": "0.1.0"
      },
      { remoteAddress: "127.0.0.1" }
    );

    expect(response.statusCode).toBe(200);
    expect(parseToolPayload(response.payload).result).toMatchObject({ isError: false });
    expect(evidenceCalls[0]?.audit).toEqual({
      requestId: "mcp_request_1",
      sourceIp: "203.0.113.9",
      clientSource: "mcp_launcher",
      launcherVersion: "0.1.0"
    });
  });
});
