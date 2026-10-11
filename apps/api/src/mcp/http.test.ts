import { legacyPermissionService } from "../business-authorization.test-support.js";
import Fastify, { type FastifyInstance } from "fastify";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import { createSmedcHttpMcpServer } from "./server.js";
import type { InjectOptions, InjectPayload, Response as InjectResponse } from "light-my-request";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AuthenticatedEmployee, AuthorizationSnapshot } from "@smedc/domain";
import { SMEDC_MCP_TOOL_NAMES, type McpErrorBody } from "@smedc/mcp-contract";
import {
  createBusinessAuthorizationService,
  type BusinessAuthorizationRepository
} from "../business-authorization.js";
import { createSourceDocumentDownloadIssuer } from "../source-document-downloads.js";
import type { StorageAdapter } from "@smedc/storage";
import {
  createDocumentRepository,
  createOrganizationContextStorageAdapter,
  createMultipartPayload
} from "../test-support/api-server-fixtures.js";
import { buildApiServer } from "../server.js";
import type { EmployeeRepository } from "../employees.js";
import type { DocumentCatalogRepository, DocumentStatusRecord } from "../documents.js";
import type { EvidenceSearchInput, EvidenceSearchRepository } from "../evidence.js";
import type { SkillDirectoryRepository } from "../skills.js";
import type { SourceDocumentDownloadIssuer } from "../source-document-downloads.js";
import type {
  StructuredImportBatchRecord,
  StructuredImportRepository
} from "../structured-imports.js";
import type { StructuredCoverageRepository } from "../structured-coverage.js";
import type { StructuredQueryRepository } from "../structured-query.js";
import { registerMcpHttpRoute } from "./http.js";
import type { SmedcMcpToolHandlers, McpRequestContext } from "./tool-handlers.js";

const jwtSecret = "test-local-jwt-secret";
const officialTestTokens = new Map<string, AuthenticatedEmployee>();

async function authenticateTestAccessToken(token: string) {
  return officialTestTokens.get(token) ?? null;
}

const employee: AuthenticatedEmployee = {
  id: "emp_mcp",
  orgId: "default-org",
  organizationName: "Default Organization",
  displayName: "MCP Employee",
  email: "mcp.employee@example.com",
  role: "employee",
  disabled: false,
  clearance: 3
};

const adminEmployee: AuthenticatedEmployee = {
  id: "emp_mcp_admin",
  orgId: "default-org",
  organizationName: "Default Organization",
  displayName: "MCP Administrator",
  email: "mcp.admin@example.com",
  role: "admin",
  disabled: false,
  clearance: 3
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
    businessAuthorizationService: legacyPermissionService([employee, adminEmployee]),
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
        name: "smedc-api-test",
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
    confidentialityLevel: 0,
    processingRunStatus: "succeeded",
    documentIndexStatus: "indexed",
    documentIndexRetrievalConfigVersion: "phase3.retrieval.v1"
  };

  return {
    async createUploadedDocument() {
      throw new Error("createUploadedDocument should not be called by this test.");
    },
    async findEvidenceDocumentStatus(_orgId, documentId) {
      return documentId === evidenceStatus.id ? evidenceStatus : null;
    },
    async appendAuditLog() {},
    async archiveDocument() {
      return null;
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
    sourceDocumentConfidentialityLevel: 0,
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
          rerankStatus: "rerank_disabled",
          relevance: {
            policyVersion: "relevance.disabled@test",
            cutoffReason: "disabled",
            droppedCount: 0
          }
        },
        warnings: []
      };
    }
  };
}

function fakeSourceDocumentDownloadIssuer(): SourceDocumentDownloadIssuer {
  return {
    async issueMany(input) {
      return {
        sources: input.requestedSources.map((source) => ({
          sourceDocumentId: source.sourceDocumentId,
          documentTitle: source.documentTitle ?? source.sourceDocumentId,
          originalFileName: "evidence-status.md",
          contentType: "text/markdown",
          byteSize: 128,
          downloadStatus: "available" as const,
          downloadUrl: `https://downloads.example.test/${source.sourceDocumentId}`,
          expiresAt: "2026-09-22T00:00:00.000Z"
        })),
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
    sourceDocumentDownloadIssuer: fakeSourceDocumentDownloadIssuer(),
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

function buildCustomMcpTestServer(toolHandlers: SmedcMcpToolHandlers) {
  const customApp = Fastify({
    logger: false,
    requestIdHeader: "x-request-id"
  });

  customApp.addHook("onRequest", async (request, reply) => {
    reply.header("x-request-id", request.id);
  });

  registerMcpHttpRoute(customApp, {
    uploadAuthorizationAudit: () => ({ appendDenied: async () => {} }),
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

  it.each([
    ["upload_evidence_document", "evidence_document", {}],
    [
      "upload_quarantine_certificate",
      "quarantine_certificate",
      { file: { contentBase64: "private-not-base64" } }
    ],
    ["upload_structured_dataset", "structured_dataset", {}],
    ["upload_structured_dataset", "structured_dataset", { dataset: "private-fake-dataset" }],
    ["upload_structured_dataset", "structured_dataset", { dataset: "delivery_ledger" }]
  ] as const)(
    "denies old-launcher employee %s before SDK upload validation (%j)",
    async (name, surface, arguments_) => {
      const appendDenied = vi.fn(async () => {});
      app = buildMcpTestServer({ uploadAuthorizationAuditRepository: { appendDenied } });
      const requests: string[] = [];
      app.addHook("onRequest", async (request) => {
        requests.push(request.url);
      });
      const response = await postMcp(
        app,
        {
          jsonrpc: "2.0",
          id: 61,
          method: "tools/call",
          params: { name, arguments: arguments_ }
        },
        {
          "mcp-protocol-version": "2025-11-25",
          "x-request-id": "denied_upload_req",
          "x-smedc-launcher-version": "0.5.0"
        }
      );
      expect(response.statusCode).toBe(200);
      expect(response.payload).toContain("UPLOAD_ADMIN_REQUIRED");
      const result = parseToolPayload(response.payload);
      expect(result.result?.isError).toBe(true);
      expect(result.payload).toEqual({
        error: {
          code: "UPLOAD_ADMIN_REQUIRED",
          message: "File upload requires the admin role.",
          retryable: false,
          requestId: "denied_upload_req"
        }
      });
      expect(appendDenied).toHaveBeenCalledExactlyOnceWith({
        orgId: employee.orgId,
        actorEmployeeId: employee.id,
        uploadSurface: surface,
        audit: {
          requestId: "denied_upload_req",
          sourceIp: "127.0.0.1",
          clientSource: "mcp_launcher",
          launcherVersion: "0.5.0"
        }
      });
      expect(requests).toEqual(["/mcp"]);
      expect(JSON.stringify([result, appendDenied.mock.calls])).not.toContain("private-");
    }
  );

  it("keeps admin upload validation and independent HTTP authorization", async () => {
    const appendDenied = vi.fn(async () => {});
    app = buildMcpTestServer({ uploadAuthorizationAuditRepository: { appendDenied } });
    const requests: string[] = [];
    app.addHook("onRequest", async (request) => {
      requests.push(request.url);
      if (request.url === "/v1/documents/evidence") {
        officialTestTokens.set(`eh_at_test_${adminEmployee.id}`, {
          ...adminEmployee,
          role: "employee"
        });
      }
    });
    const headers = { "mcp-protocol-version": "2025-11-25", "x-request-id": "admin_recheck_req" };
    const invalid = await postMcp(
      app,
      {
        jsonrpc: "2.0",
        id: 62,
        method: "tools/call",
        params: { name: "upload_evidence_document", arguments: {} }
      },
      headers,
      { employee: adminEmployee }
    );
    expect(invalid.payload).toContain("MCP_INPUT_VALIDATION_ERROR");
    expect(parseToolPayload(invalid.payload).payload).toMatchObject({
      error: { code: "MCP_INPUT_VALIDATION_ERROR" }
    });
    expect(requests).toEqual(["/mcp"]);
    expect(appendDenied).not.toHaveBeenCalled();
    requests.length = 0;
    const response = await postMcp(
      app,
      {
        jsonrpc: "2.0",
        id: 63,
        method: "tools/call",
        params: {
          name: "upload_evidence_document",
          arguments: {
            file: {
              name: "evidence.md",
              mediaType: "text/markdown",
              encoding: "base64",
              contentBase64: "IyBFdmlkZW5jZQo="
            },
            title: "Evidence",
            categoryId: "memo",
            scopes: [{ enterpriseKey: "enterprise", ownership: "group", dimensions: {} }],
            confidentialityLevel: 0
          }
        }
      },
      headers,
      { employee: adminEmployee }
    );
    expect(response.statusCode).toBe(200);
    expect(parseToolPayload(response.payload).payload).toMatchObject({
      error: { code: "UPLOAD_ADMIN_REQUIRED", requestId: "admin_recheck_req" }
    });
    expect(requests).toEqual(["/mcp", "/v1/documents/evidence"]);
    expect(appendDenied).toHaveBeenCalledOnce();
    expect(appendDenied.mock.calls[0]).toEqual([
      expect.objectContaining({
        actorEmployeeId: adminEmployee.id,
        uploadSurface: "evidence_document"
      })
    ]);
  });

  it("preserves SDK unknown-tool and non-upload validation errors", async () => {
    app = buildMcpTestServer();
    for (const name of ["unknown_tool", "refresh_ledger_pdfs", "get_import_status"]) {
      const response = await postMcp(
        app,
        { jsonrpc: "2.0", id: 64, method: "tools/call", params: { name, arguments: {} } },
        { "mcp-protocol-version": "2025-11-25" }
      );
      expect(response.statusCode).toBe(200);
      expect(parseJsonRpc(response.payload).result).toMatchObject({
        isError: true,
        content: [
          {
            type: "text",
            text: expect.stringContaining(
              name === "get_import_status"
                ? "MCP error -32602: Input validation error"
                : `MCP error -32602: Tool ${name} not found`
            )
          }
        ]
      });
    }
  });

  it.each(["throw", "reject"] as const)(
    "normalizes an unexpected upload handler %s like an ordinary SDK tool failure",
    async (mode) => {
      const fail = vi.fn(() => {
        if (mode === "throw") throw new Error("unexpected tool failure");
        return Promise.reject("unexpected tool failure");
      });
      app = buildCustomMcpTestServer({
        smedc_get_current_user: fail,
        upload_evidence_document: fail
      });
      const results = [];
      for (const name of ["smedc_get_current_user", "upload_evidence_document"]) {
        const response = await postMcp(
          app,
          { jsonrpc: "2.0", id: 65, method: "tools/call", params: { name, arguments: {} } },
          { "mcp-protocol-version": "2025-11-25" }
        );
        expect(response.statusCode).toBe(200);
        const body = parseJsonRpc(response.payload);
        expect(body).not.toHaveProperty("error");
        expect(body.result).toEqual({
          content: [{ type: "text", text: "unexpected tool failure" }],
          isError: true
        });
        results.push(body);
      }
      expect(results[1]).toEqual(results[0]);
      expect(fail).toHaveBeenCalledTimes(2);
    }
  );

  it("preserves the SDK URL-elicitation protocol exception for upload handlers", async () => {
    const fail = async () => {
      throw new McpError(ErrorCode.UrlElicitationRequired, "URL elicitation required");
    };
    app = buildCustomMcpTestServer({
      smedc_get_current_user: fail,
      upload_evidence_document: fail
    });
    const results = [];
    for (const name of ["smedc_get_current_user", "upload_evidence_document"]) {
      const response = await postMcp(
        app,
        { jsonrpc: "2.0", id: 66, method: "tools/call", params: { name, arguments: {} } },
        { "mcp-protocol-version": "2025-11-25" }
      );
      expect(response.statusCode).toBe(200);
      const body = parseJsonRpc(response.payload);
      expect(body).not.toHaveProperty("result");
      expect(body.error?.code).toBe(ErrorCode.UrlElicitationRequired);
      results.push(body);
    }
    expect(results[1]).toEqual(results[0]);
  });

  it("restores the SDK registration method when tool registration throws", () => {
    const instances: Server[] = [];
    const register = vi.spyOn(McpServer.prototype, "registerTool").mockImplementation(function (
      this: McpServer
    ) {
      instances.push(this.server);
      expect(this.server.setRequestHandler).not.toBe(Server.prototype.setRequestHandler);
      throw new Error("registration failed");
    });
    try {
      expect(() =>
        createSmedcHttpMcpServer({
          context: {
            employee,
            audit: {
              requestId: "restore_req",
              sourceIp: "127.0.0.1",
              clientSource: "mcp_launcher",
              launcherVersion: null
            }
          }
        })
      ).toThrow("registration failed");
      expect(instances[0]?.setRequestHandler).toBe(Server.prototype.setRequestHandler);
    } finally {
      register.mockRestore();
    }
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
      host: "smedc.example.com"
    });

    expect(response.statusCode).toBe(403);
    expectErrorCode(response.json<McpErrorBody>(), "MCP_LOOPBACK_REQUIRED");
  });

  it("accepts the exact configured public Host only from a loopback reverse-proxy peer", async () => {
    app = buildMcpTestServer({
      runtimeEnv: {
        SMEDC_PUBLIC_ORIGIN: "https://api.smedatacenter.xyz"
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
        host: "smedc.example.com"
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
        name: "smedc_get_current_user",
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
      smedc_list_skills: async (_input, context) => {
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
          name: "smedc_list_skills",
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

  it.each([employee, adminEmployee])(
    "initializes and lists all static tools for $role",
    async (authenticatedEmployee) => {
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
        },
        { employee: authenticatedEmployee }
      );

      expect(initialize.statusCode).toBe(200);
      expect(initialize.headers["mcp-session-id"]).toBeUndefined();
      expect(parseJsonRpc(initialize.payload).result).toMatchObject({
        serverInfo: {
          name: "smedc-api-mcp"
        }
      });

      expect(toolsList.statusCode).toBe(200);
      expect(toolsList.headers["mcp-session-id"]).toBeUndefined();
      const toolNames = (
        parseJsonRpc(toolsList.payload).result?.["tools"] as Array<{ name: string }>
      ).map((tool) => tool.name);
      expect(toolNames.sort()).toEqual([...SMEDC_MCP_TOOL_NAMES].sort());
      expect(toolNames).not.toContain("refresh_ledger_pdfs");
      const removed = await postMcp(
        app,
        {
          jsonrpc: "2.0",
          id: 3,
          method: "tools/call",
          params: {
            name: "refresh_ledger_pdfs",
            arguments: { storeNames: ["店"], dates: ["2026-10-04"], idempotencyKey: "key" }
          }
        },
        { "mcp-protocol-version": "2025-11-25" },
        { employee: authenticatedEmployee }
      );
      expect(parseJsonRpc(removed.payload).result).toMatchObject({
        isError: true,
        content: [
          { type: "text", text: expect.stringContaining("Tool refresh_ledger_pdfs not found") }
        ]
      });
      const tools = parseJsonRpc(toolsList.payload).result?.["tools"] as Array<{
        name: string;
        annotations?: Record<string, boolean>;
      }>;
      for (const name of ["prepare_ledger_pdf_download"])
        expect(tools.find((tool) => tool.name === name)?.annotations).toMatchObject({
          readOnlyHint: false,
          destructiveHint: false,
          idempotentHint: true
        });
      for (const name of [
        "describe_ledger_pdf_coverage",
        "get_ledger_pdf_request_status",
        "get_ledger_pdf_download_url"
      ])
        expect(tools.find((tool) => tool.name === name)?.annotations?.readOnlyHint).toBe(true);
    }
  );

  it("returns only the current authenticated employee's self-profile", async () => {
    app = buildLiveMcpApiTestServer();
    const request = (id: number) => ({
      jsonrpc: "2.0",
      id,
      method: "tools/call",
      params: {
        name: "smedc_get_current_user",
        arguments: {}
      }
    });

    const employeeResponse = await postMcp(
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

    expect(parseToolPayload(employeeResponse.payload).payload).toEqual({
      user: {
        displayName: "MCP Employee",
        email: "mcp.employee@example.com",
        role: "employee",
        clearance: 3,
        organizationName: "Default Organization"
      }
    });
    expect(parseToolPayload(adminResponse.payload).payload).toEqual({
      user: {
        displayName: "MCP Administrator",
        email: "mcp.admin@example.com",
        role: "admin",
        clearance: 3,
        organizationName: "Default Organization"
      }
    });
  });

  it("serves live skills, structured coverage, structured query, evidence search, and status tools through MCP framing", async () => {
    app = buildLiveMcpApiTestServer();

    const skills = await postMcp(
      app,
      {
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: {
          name: "smedc_list_skills",
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
            dataset: "vip",
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
            dataset: "vip"
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
      skills,
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

    expect(parseToolPayload(skills.payload).payload).toMatchObject({
      skills: expect.arrayContaining([expect.objectContaining({ id: "skill_menu" })])
    });
    expect(parseToolPayload(structuredDatasets.payload).payload).toMatchObject({
      datasets: expect.arrayContaining([expect.objectContaining({ dataset: "dishes" })])
    });
    expect(parseToolPayload(structuredQuery.payload).payload).toMatchObject({
      dataset: "vip",
      rows: [{ dish_name: "Noodles", sales_amount: 128 }]
    });
    expect(parseToolPayload(structuredCoverage.payload).payload).toMatchObject({
      dataset: "vip",
      metadataPolicy: "window",
      sources: [expect.objectContaining({ importBatchId: "imp_coverage" })]
    });
    expect(parseToolPayload(evidenceSearch.payload).payload).toMatchObject({
      results: [expect.objectContaining({ chunkId: "chk_1" })],
      sources: [
        expect.objectContaining({
          sourceDocumentId: "doc_evidence_status",
          downloadStatus: "available",
          downloadUrl: "https://downloads.example.test/doc_evidence_status"
        })
      ],
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
    const appendDenied = vi.fn(async () => {});
    app = buildLiveMcpApiTestServer([], {
      uploadAuthorizationAuditRepository: { appendDenied }
    });

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
              name: "level-four.md",
              mediaType: "text/markdown",
              encoding: "base64",
              contentBase64: Buffer.from("# Evidence\n", "utf8").toString("base64")
            },
            title: "Out-of-range confidentiality evidence",
            confidentialityLevel: 4
          }
        }
      },
      {
        "mcp-protocol-version": "2025-11-25"
      }
    );
    const result = parseJsonRpc(response.payload).result as {
      content?: Array<{ text?: string }>;
      isError?: boolean;
    };

    expect(response.statusCode).toBe(200);
    expect(result).toMatchObject({ isError: true });
    expect(JSON.stringify(result)).not.toContain("MCP_TOOL_NOT_IMPLEMENTED");
    expect(JSON.stringify(result)).not.toContain("filePath");
    expect(result.content?.[0]?.text).toContain("UPLOAD_ADMIN_REQUIRED");
    expect(appendDenied).toHaveBeenCalledTimes(1);
    expect(appendDenied).toHaveBeenCalledWith(
      expect.objectContaining({
        actorEmployeeId: employee.id,
        uploadSurface: "evidence_document"
      })
    );
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

    const employeeResponse = await postMcp(
      app,
      searchPayload(10),
      { "mcp-protocol-version": "2025-11-25", "x-request-id": "mcp-employee-req" },
      { employee }
    );
    const adminResponse = await postMcp(
      app,
      searchPayload(11),
      { "mcp-protocol-version": "2025-11-25", "x-request-id": "mcp-admin-req" },
      { employee: adminEmployee }
    );

    expect(employeeResponse.statusCode).toBe(200);
    expect(adminResponse.statusCode).toBe(200);
    expect(evidenceCalls.map((call) => call.employee.email)).toEqual([
      employee.email,
      adminEmployee.email
    ]);
    expect(evidenceCalls.map((call) => call.audit.requestId)).toEqual([
      "mcp-employee-req",
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
        "x-smedc-launcher-version": "0.1.0"
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

describe("HTTP and official MCP business authorization parity", () => {
  function permissionFixture() {
    const snapshot: AuthorizationSnapshot = {
      orgId: employee.orgId,
      employeeId: employee.id,
      role: "employee",
      disabled: false,
      mode: "enabled",
      authorizationVersion: "7",
      clearance: 1,
      categories: [
        {
          id: "vip",
          kind: "fixed",
          key: "vip",
          confidentialityLevel: 1,
          ownerships: ["group"],
          requiredDimensionIds: []
        }
      ],
      grants: [
        {
          id: "grant",
          orgId: employee.orgId,
          enterpriseKey: "precise-enterprise",
          categoryIds: ["vip"],
          ownership: "group",
          dimensions: {}
        }
      ]
    };
    const repository = {
      loadAuthorizationSnapshot: vi.fn(async (id: string, orgId: string) => {
        if (id === "foreign") throw new Error("AUTHORIZATION_ACCOUNT_NOT_FOUND");
        return { ...snapshot, employeeId: id, orgId };
      }),
      listAccounts: vi.fn(async () => [
        { employeeId: employee.id, clearance: 1, grants: snapshot.grants }
      ]),
      configureAccount: vi.fn(async (input: { expectedVersion: string }) => {
        if (input.expectedVersion !== snapshot.authorizationVersion)
          throw new Error("AUTHORIZATION_VERSION_CONFLICT");
        return { authorizationVersion: "8" };
      })
    };
    return {
      snapshot,
      repository,
      service: createBusinessAuthorizationService(
        repository as unknown as BusinessAuthorizationRepository
      )
    };
  }
  async function call(
    app: FastifyInstance,
    name: string,
    args: Record<string, unknown> = {},
    identity = employee
  ) {
    return parseToolPayload(
      (
        await postMcp(
          app,
          { jsonrpc: "2.0", id: 91, method: "tools/call", params: { name, arguments: args } },
          { "mcp-protocol-version": "2025-11-25", "x-smedc-launcher-version": "0.9.0" },
          { employee: identity }
        )
      ).payload
    );
  }
  it("delegates the same current grant predicate and rejects suspended reads identically", async () => {
    const fixture = permissionFixture();
    const compiled: Array<Parameters<StructuredQueryRepository["execute"]>[0]> = [];
    const app = buildMcpTestServer({
      businessAuthorizationService: fixture.service,
      structuredQueryRepository: {
        execute: async (query) => {
          compiled.push(query);
          return {
            rows: query.sql.includes("(0 = 1)") ? [] : [{ member_id: "synthetic" }],
            hasMore: false
          };
        }
      }
    });
    try {
      const query = { dataset: "vip", select: ["member_id"] };
      const headers = { authorization: `Bearer ${await accessToken()}` };
      const http = await app.inject({
        method: "POST",
        url: "/v1/structured/query",
        headers,
        payload: query
      });
      const mcp = await call(app, "query_structured_dataset", query);
      expect(http.statusCode).toBe(200);
      expect(mcp.payload).toEqual(http.json());
      expect(compiled).toHaveLength(2);
      expect(compiled[0]!.sql).toBe(compiled[1]!.sql);
      expect(compiled[0]!.params).toEqual(compiled[1]!.params);
      expect(compiled[0]!.sql).toContain("EXISTS (SELECT 1 FROM business_resources");
      expect(compiled[0]!.params).toContain("precise-enterprise");
      fixture.snapshot.mode = "suspended";
      const denied = await app.inject({
        method: "POST",
        url: "/v1/structured/query",
        headers,
        payload: query
      });
      const deniedMcp = await call(app, "query_structured_dataset", query);
      expect(denied.json().rows).toEqual([]);
      expect(deniedMcp.payload).toEqual(denied.json());
      expect(compiled).toHaveLength(4);
      expect(compiled[2]!.sql).toContain("(0 = 1)");
      expect(compiled[3]!.sql).toBe(compiled[2]!.sql);
    } finally {
      await app.close();
    }
  });
  it("reads full admin self/other configuration live and applies current role, tenant and version checks", async () => {
    const fixture = permissionFixture();
    fixture.snapshot.role = "admin";
    fixture.snapshot.categories.push({
      id: "ungranted",
      kind: "evidence",
      confidentialityLevel: null,
      ownerships: ["group"],
      requiredDimensionIds: []
    });
    const app = buildMcpTestServer({
      businessAuthorizationService: fixture.service,
      documentRepository: fakeDocumentRepository()
    });
    try {
      const headers = { authorization: `Bearer ${await accessToken(adminEmployee)}` };
      for (const employeeId of [adminEmployee.id, employee.id]) {
        const http = await app.inject({
          url: `/v1/admin/permissions/accounts/${employeeId}`,
          headers
        });
        const mcp = await call(app, "get_account_permissions", { employeeId }, adminEmployee);
        expect(mcp.payload).toEqual(http.json());
        expect(http.json().categories).toHaveLength(2);
        expect(JSON.stringify(mcp.payload)).not.toContain("downloadUrl");
      }
      const card = await call(app, "get_my_permissions", {}, adminEmployee);
      expect(card.payload).toMatchObject({
        authorizationVersion: "7",
        categories: [expect.objectContaining({ id: "vip" })]
      });
      expect((card.payload as { categories: unknown[] }).categories).toHaveLength(1);
      const management = await call(
        app,
        "get_evidence_document_management_status",
        { documentId: "doc_evidence_status" },
        adminEmployee
      );
      expect(management.result?.isError).toBe(false);
      expect(JSON.stringify(management.payload)).not.toContain("downloadUrl");
      const ordinary = await call(
        app,
        "get_evidence_document_status",
        { documentId: "doc_evidence_status" },
        adminEmployee
      );
      expect(ordinary.payload).toMatchObject({ error: { code: "DOCUMENT_NOT_FOUND" } });
      const foreign = await call(
        app,
        "get_account_permissions",
        { employeeId: "foreign" },
        adminEmployee
      );
      expect(foreign.payload).toMatchObject({ error: { code: "AUTHORIZATION_ACCOUNT_NOT_FOUND" } });
      const args = { employeeId: employee.id, expectedVersion: "6", clearance: 1, grants: [] };
      const conflict = await call(app, "update_account_permissions", args, adminEmployee);
      expect(conflict.payload).toMatchObject({ error: { code: "AUTHORIZATION_VERSION_CONFLICT" } });
      fixture.snapshot.role = "employee";
      const denied = await app.inject({
        url: `/v1/admin/permissions/accounts/${employee.id}`,
        headers
      });
      const deniedMcp = await call(
        app,
        "get_account_permissions",
        { employeeId: employee.id },
        adminEmployee
      );
      expect(denied.statusCode).toBe(403);
      expect(deniedMcp.payload).toMatchObject({ error: { code: denied.json().error.code } });
      fixture.snapshot.authorizationVersion = "8";
      expect((await call(app, "get_my_permissions")).payload).toMatchObject({
        authorizationVersion: "8",
        role: "employee"
      });
    } finally {
      await app.close();
    }
  });
  it("uses the real HTTP multipart boundary for explicit MCP evidence attributes", async () => {
    const fixture = permissionFixture();
    fixture.snapshot.role = "admin";
    const documents = createDocumentRepository();
    const app = buildMcpTestServer({
      businessAuthorizationService: fixture.service,
      documentRepository: documents,
      storageAdapter: createOrganizationContextStorageAdapter()
    });
    try {
      const attrs = {
        title: "Synthetic procedure",
        categoryId: "memo",
        scopes: [
          {
            enterpriseKey: "enterprise",
            ownership: "store",
            storeName: "Store A ",
            dimensions: { project: "X" }
          }
        ],
        confidentialityLevel: 2,
        historicalSupplementReason: "Explicit historical declaration"
      };
      const body = Buffer.from("# Synthetic procedure\n");
      const file = {
        name: "procedure.md",
        mediaType: "text/markdown",
        encoding: "base64",
        contentBase64: body.toString("base64")
      };
      const mcp = await call(app, "upload_evidence_document", { file, ...attrs }, adminEmployee);
      expect(mcp.result?.isError).toBe(false);
      const multipart = createMultipartPayload([
        { name: "file", fileName: file.name, contentType: file.mediaType, value: body },
        { name: "title", value: attrs.title },
        { name: "categoryId", value: attrs.categoryId },
        { name: "scopes", value: JSON.stringify(attrs.scopes) },
        { name: "confidentialityLevel", value: "2" },
        { name: "historicalSupplementReason", value: attrs.historicalSupplementReason }
      ]);
      const http = await app.inject({
        method: "POST",
        url: "/v1/documents/evidence",
        headers: {
          authorization: `Bearer ${await accessToken(adminEmployee)}`,
          "content-type": multipart.contentType
        },
        payload: multipart.body
      });
      expect(http.statusCode).toBe(202);
      expect(documents.uploadInputs).toHaveLength(2);
      for (const input of documents.uploadInputs)
        expect(input).toMatchObject({
          uploaderId: adminEmployee.id,
          orgId: adminEmployee.orgId,
          businessCategoryId: attrs.categoryId,
          businessScopes: attrs.scopes,
          confidentialityLevel: 2,
          historicalSupplementReason: attrs.historicalSupplementReason
        });
      expect(JSON.stringify(mcp.payload)).not.toContain("downloadUrl");
    } finally {
      await app.close();
    }
  });
  it("has no MCP bypass for raw ledger aggregation or original links", async () => {
    const fixture = permissionFixture();
    const sign = vi.fn();
    const issueMany = createSourceDocumentDownloadIssuer({
      repository: {
        findDownloadableSourceDocuments: async () => [
          {
            sourceDocumentId: "ledger",
            orgId: employee.orgId,
            status: "active",
            storageObjectKey: "private/ledger",
            originalFileName: "ledger.xlsx",
            contentType: "application/octet-stream",
            byteSize: 10,
            confidentialityLevel: 0,
            importDataset: "delivery_ledger"
          }
        ],
        recordDownloadsIssued: vi.fn()
      },
      storage: { createDownloadUrl: sign } as unknown as StorageAdapter
    }).issueMany;
    const app = buildMcpTestServer({
      businessAuthorizationService: fixture.service,
      sourceDocumentDownloadIssuer: { issueMany }
    });
    try {
      const headers = { authorization: `Bearer ${await accessToken()}` };
      const query = { dataset: "delivery_ledger", aggregates: [{ op: "count" }] };
      const http = await app.inject({
        method: "POST",
        url: "/v1/structured/query",
        headers,
        payload: query
      });
      expect(http.statusCode).toBe(403);
      expect((await call(app, "query_structured_dataset", query)).payload).toMatchObject({
        error: { code: "LEDGER_DETAIL_DISABLED" }
      });
      const original = await app.inject({
        method: "POST",
        url: "/v1/source-documents/ledger/download-url",
        headers
      });
      expect(original.statusCode).toBe(404);
      const mcp = await call(app, "get_source_document_download_url", {
        sourceDocumentId: "ledger"
      });
      expect(mcp.payload).toMatchObject({ error: { code: original.json().error.code } });
      expect(JSON.stringify(mcp.payload)).not.toContain("private/ledger");
      expect(sign).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });
});
