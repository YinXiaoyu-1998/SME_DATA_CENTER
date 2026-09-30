import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { LocalFileSystemStorageAdapter } from "@smedc/storage";
import { buildApiServer } from "../server.js";
import { buildRetrievalConfigSeed, loadActiveRetrievalConfig } from "@smedc/domain";
import { PrismaEvidenceRevalidator, createEvidenceSearchService } from "../evidence.js";
import { createPdfTableBlocks } from "../../../worker/src/chunking/pdf-table-chunker.js";
import { createEvidenceChunks } from "../../../worker/src/chunking/evidence-chunker.js";
import {
  adminEmployee,
  baoliEmployee,
  orgBAdminEmployee,
  suzhouEmployee,
  accessTokenFor,
  authenticateTestAccessToken,
  createDocumentRepository,
  createEvidenceSearchRepository,
  createMultipartPayload,
  createOrganizationContextDocumentRepository,
  createOrganizationContextStorageAdapter,
  createRepository,
  jwtSecret
} from "../test-support/api-server-fixtures.js";

describe("evidence routes", () => {
  it.each([false, true])(
    "denies employee upload before parsing or side effects (audit failure: %s)",
    async (auditFails) => {
      const documentRepository = createDocumentRepository();
      const documentCalls = Object.keys(documentRepository)
        .filter(
          (key) => typeof documentRepository[key as keyof typeof documentRepository] === "function"
        )
        .map((key) => vi.spyOn(documentRepository, key as "createUploadedDocument"));
      const appendDenied = vi.fn(async () => {
        if (auditFails) throw new Error("sensitive upload metadata");
      });
      const storagePut = vi.fn();
      const logAuditFailure = vi.fn();
      const parseParts = vi.fn(() => {
        throw new Error("multipart parser must not run");
      });
      app = buildApiServer({
        employeeRepository: createRepository([baoliEmployee]),
        documentRepository,
        storageAdapter: {
          putObject: storagePut
        } as unknown as import("@smedc/storage").StorageAdapter,
        uploadAuthorizationAuditRepository: { appendDenied },
        cursorSigningSecret: jwtSecret,
        authenticateAccessToken: authenticateTestAccessToken,
        logger: false
      });
      app.addHook("onRequest", async (request) => {
        request.parts = parseParts;
        request.log.error = logAuditFailure;
      });
      const multipart = createMultipartPayload([{ name: "dataset", value: "delivery_ledger" }]);
      const response = await app.inject({
        method: "POST",
        url: "/v1/documents/evidence",
        headers: {
          authorization: `Bearer ${await accessTokenFor(baoliEmployee)}`,
          "x-request-id": "req_upload_denied",
          "content-type": multipart.contentType
        },
        remoteAddress: "198.51.100.8",
        payload: multipart.body
      });
      expect(response.statusCode).toBe(403);
      expect(response.json()).toEqual({
        error: {
          code: "UPLOAD_ADMIN_REQUIRED",
          message: "File upload requires the admin role.",
          retryable: false,
          details: {},
          requestId: "req_upload_denied"
        }
      });
      expect(appendDenied).toHaveBeenCalledExactlyOnceWith({
        orgId: baoliEmployee.orgId,
        actorEmployeeId: baoliEmployee.id,
        uploadSurface: "evidence_document",
        audit: {
          requestId: "req_upload_denied",
          sourceIp: "198.51.100.8",
          clientSource: "http_api",
          launcherVersion: null
        }
      });
      expect(parseParts).not.toHaveBeenCalled();
      expect(storagePut).not.toHaveBeenCalled();
      if (auditFails) {
        expect(logAuditFailure).toHaveBeenCalledExactlyOnceWith(
          { requestId: "req_upload_denied", uploadSurface: "evidence_document" },
          "upload denial audit failed"
        );
      } else {
        expect(logAuditFailure).not.toHaveBeenCalled();
      }
      for (const call of documentCalls) expect(call).not.toHaveBeenCalled();
      expect(documentRepository.documents).toHaveLength(0);
    }
  );
  let app: FastifyInstance | undefined;

  afterEach(async () => {
    await app?.close();
    app = undefined;
    vi.unstubAllGlobals();
  });

  async function uploadPdfCase(
    options: {
      fileName?: string;
      contentType?: string;
      content?: Buffer;
      enabled?: boolean;
      verified?: boolean;
      ready?: boolean;
    } = {}
  ) {
    const documents = createDocumentRepository();
    const storage = createOrganizationContextStorageAdapter();
    const readyFetch = vi.fn<typeof fetch>(async () => {
      if (options.ready === false) throw new Error("private parser host unavailable");
      return Response.json({
        status: "ready",
        schemaVersion: 1,
        parserFingerprint: "a".repeat(64)
      });
    });
    vi.stubGlobal("fetch", readyFetch);
    app = buildApiServer({
      employeeRepository: createRepository([adminEmployee]),
      documentRepository: documents,
      storageAdapter: storage,
      cursorSigningSecret: jwtSecret,
      authenticateAccessToken: authenticateTestAccessToken,
      logger: false,
      runtimeEnv: {
        SMEDC_PDF_UPLOAD_ENABLED: options.enabled === false ? "false" : "true",
        SMEDC_PDF_SERVICE_URL: "http://parser.synthetic.test",
        SMEDC_PDF_SERVICE_TOKEN: "s".repeat(32)
      },
      pdfRollbackFloorVerifier: async () => options.verified !== false
    });
    const multipart = createMultipartPayload([
      {
        name: "file",
        fileName: options.fileName ?? "synthetic.pdf",
        contentType: options.contentType ?? "application/pdf",
        value: options.content ?? Buffer.from("%PDF-1.7\nsynthetic")
      },
      { name: "title", value: "Synthetic PDF" }
    ]);
    const response = await app.inject({
      method: "POST",
      url: "/v1/documents/evidence",
      headers: {
        authorization: `Bearer ${await accessTokenFor(adminEmployee)}`,
        "content-type": multipart.contentType
      },
      payload: multipart.body
    });
    return { response, documents, storage, readyFetch };
  }

  it("admits an authenticated admin PDF only after verified rollback floor and authenticated readiness", async () => {
    const { response, documents, storage, readyFetch } = await uploadPdfCase();
    expect(response.statusCode).toBe(202);
    expect(response.json()).toMatchObject({
      document: { fileType: "pdf" },
      processing: { status: "queued" }
    });
    expect(documents.processingRuns).toEqual([
      expect.objectContaining({ jobType: "evidence_document_index" })
    ]);
    expect(storage.putInputs).toHaveLength(1);
    expect(readyFetch).toHaveBeenCalledWith(
      "http://parser.synthetic.test/v1/ready",
      expect.objectContaining({
        method: "GET",
        redirect: "error",
        headers: { authorization: `Bearer ${"s".repeat(32)}` }
      })
    );
  });

  it.each([
    { content: Buffer.from("not a PDF") },
    { content: Buffer.from([0xa5, 0xd0, 0xc4, 0xc6, 0xad, 0xb1, 0xae, 0xb7, 0x8a]) },
    { contentType: "text/plain" },
    { fileName: "renamed.md" },
    { fileName: "renamed.txt", contentType: "text/plain" }
  ])("rejects mismatched PDF extension, MIME or magic before storage %j", async (options) => {
    const { response, documents, storage, readyFetch } = await uploadPdfCase(options);
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: { code: "INVALID_EVIDENCE_UPLOAD" } });
    expect(documents.documents).toHaveLength(0);
    expect(storage.putInputs).toHaveLength(0);
    expect(readyFetch).not.toHaveBeenCalled();
  });

  it.each([
    { enabled: false, code: "PDF_UPLOAD_DISABLED" },
    { verified: false, code: "PDF_ROLLBACK_FLOOR_UNVERIFIED" },
    { ready: false, code: "PDF_SERVICE_UNAVAILABLE" }
  ])("refuses new PDF admission without durable queueing when unavailable %j", async (options) => {
    const { response, documents, storage } = await uploadPdfCase(options);
    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({ error: { code: options.code } });
    expect(response.payload).not.toContain("private parser");
    expect(documents.processingRuns).toHaveLength(0);
    expect(storage.putInputs).toHaveLength(0);
  });

  it("keeps PDF search independent of upload readiness", async () => {
    const repository = createEvidenceSearchRepository();
    const search = vi.spyOn(repository, "searchEvidence");
    app = buildApiServer({
      employeeRepository: createRepository([adminEmployee]),
      evidenceRepository: repository,
      sourceDocumentDownloadIssuer: { issueMany: async () => ({ sources: [], warnings: [] }) },
      cursorSigningSecret: jwtSecret,
      authenticateAccessToken: authenticateTestAccessToken,
      runtimeEnv: { SMEDC_PDF_UPLOAD_ENABLED: "false" },
      logger: false
    });
    const response = await app.inject({
      method: "POST",
      url: "/v1/evidence/search",
      headers: { authorization: `Bearer ${await accessTokenFor(adminEmployee)}` },
      payload: { query: "synthetic clause", filters: { fileTypes: ["pdf"] } }
    });
    expect(response.statusCode).toBe(200);
    expect(search).toHaveBeenCalledWith(
      expect.objectContaining({ filters: { fileTypes: ["pdf"], documentIds: [] } })
    );
  });

  it("preserves row continuation provenance from real PDF table chunks through API and MCP while excluding arbitrary metadata", async () => {
    const blocks = createPdfTableBlocks(
      {
        id: "synthetic-table",
        rowCount: 2,
        columnCount: 2,
        headerRows: [0],
        cells: [
          { row: 0, column: 0, rowSpan: 1, columnSpan: 1, text: "Clause" },
          { row: 0, column: 1, rowSpan: 1, columnSpan: 1, text: "Amount" },
          { row: 1, column: 0, rowSpan: 1, columnSpan: 1, text: "x".repeat(500) },
          { row: 1, column: 1, rowSpan: 1, columnSpan: 1, text: "100-200" }
        ]
      },
      {
        headingPath: ["Synthetic"],
        sourceLocation: { pageNumber: 3, method: "native" },
        maxChunkChars: 100
      }
    );
    const chunking = createEvidenceChunks({
      documentId: "synthetic-table-doc",
      contentVersion: 2,
      retrievalConfigVersion: "phase3.retrieval.v1",
      blocks,
      maxChunkChars: 100
    });
    expect(chunking.chunks.length).toBeGreaterThan(1);
    const chunk = chunking.chunks[0]!;
    const location = {
      sectionHeadingPath: chunk.headingPath,
      blockTypes: chunk.blockTypes,
      sourceLocations: chunk.sourceLocations,
      metadata: {
        ...chunk.metadata,
        pdfTable: {
          ...chunk.metadata.pdfTable,
          parsedObjectKey: "private/parsed.json",
          url: "https://private.invalid"
        }
      }
    };
    const revalidator = new PrismaEvidenceRevalidator({
      documentChunk: {
        findMany: async () => [
          {
            qdrantPointId: chunk.pointId,
            documentId: "synthetic-table-doc",
            chunkId: chunk.chunkId,
            contentVersion: 2,
            retrievalConfigVersion: "phase3.retrieval.v1",
            chunkText: chunk.text,
            sourceLocation: location,
            document: { title: "Synthetic PDF", fileType: "pdf", confidentialityLevel: 0 },
            documentIndex: { contentVersion: 2, parseSummary: { warnings: chunking.warnings } }
          }
        ]
      }
    } as unknown as ConstructorParameters<typeof PrismaEvidenceRevalidator>[0]);
    const retrievalConfig = loadActiveRetrievalConfig(
      buildRetrievalConfigSeed({
        retrievalConfigVersion: "phase3.retrieval.v1",
        qdrantCollection: "synthetic"
      }),
      "phase3.retrieval.v1"
    );
    const repository = createEvidenceSearchService({
      retrievalConfig,
      revalidator,
      rerankProvider: null,
      qdrantSearcher: {
        hybridSearch: async () => [
          {
            chunkId: chunk.chunkId,
            documentId: "synthetic-table-doc",
            qdrantPointId: chunk.pointId,
            contentVersion: 2,
            retrievalConfigVersion: "phase3.retrieval.v1",
            text: "stale",
            hybridScore: 0.9,
            matchedBy: ["dense"]
          }
        ]
      }
    });
    app = buildApiServer({
      employeeRepository: createRepository([adminEmployee]),
      evidenceRepository: repository,
      sourceDocumentDownloadIssuer: { issueMany: async () => ({ sources: [], warnings: [] }) },
      cursorSigningSecret: jwtSecret,
      authenticateAccessToken: authenticateTestAccessToken,
      runtimeEnv: { SMEDC_PDF_UPLOAD_ENABLED: "false" },
      logger: false
    });
    const args = { query: "synthetic clause", filters: { fileTypes: ["pdf"] } };
    const token = await accessTokenFor(adminEmployee);
    const api = await app.inject({
      method: "POST",
      url: "/v1/evidence/search",
      headers: { authorization: `Bearer ${token}` },
      payload: args
    });
    expect(api.statusCode).toBe(200);
    const expected = {
      tableId: "synthetic-table",
      rowStart: 1,
      rowEnd: 1,
      rowIds: ["synthetic-table:row:1"],
      cellOrigins: [
        { row: 1, column: 0, rowSpan: 1, columnSpan: 1 },
        { row: 1, column: 1, rowSpan: 1, columnSpan: 1 }
      ],
      continuation: { rowId: "synthetic-table:row:1", partIndex: 0, partCount: expect.any(Number) }
    };
    expect(api.json().results[0].source.pdfTable).toEqual(expected);
    expect(api.json().results[0].source.pdfTable.continuation.partCount).toBeGreaterThan(1);
    expect(api.payload).not.toContain("private/");
    expect(api.payload).not.toContain("private.invalid");
    const mcp = await app.inject({
      method: "POST",
      url: "/mcp",
      headers: {
        host: "127.0.0.1:3000",
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        "mcp-protocol-version": "2025-11-25"
      },
      payload: {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "search_document_evidence", arguments: args }
      }
    });
    expect(mcp.statusCode).toBe(200);
    const output = JSON.parse(mcp.json().result.content[0].text);
    expect(output.results[0].source.pdfTable).toEqual(expected);
    expect(output.warnings).toContain("PDF_TABLE_ROW_CONTINUED");
    expect(mcp.payload).not.toContain("parsedObjectKey");
  });

  it("projects PDF parsing summary without private artifacts and denies foreign organization or insufficient clearance", async () => {
    const documents = createDocumentRepository();
    const created = await documents.createUploadedDocument({
      id: "synthetic-pdf-status",
      orgId: adminEmployee.orgId,
      uploaderId: adminEmployee.id,
      status: "active",
      title: "Synthetic PDF",
      documentType: "management_knowledge",
      documentKind: "evidence",
      fileType: "pdf",
      sourceSystem: null,
      sourceTime: null,
      storageObjectKey: "private/original.pdf",
      originalFileName: "synthetic.pdf",
      byteSize: 12,
      checksumSha256: "a".repeat(64),
      confidentialityLevel: 0,
      processingJobType: "evidence_document_index",
      audit: {
        requestId: "synthetic",
        sourceIp: "127.0.0.1",
        clientSource: "http_api",
        launcherVersion: null
      }
    });
    const parsing = {
      schemaVersion: 1,
      pageCount: 2,
      pages: [
        { pageNumber: 1, outcome: "parsed" },
        { pageNumber: 2, outcome: "image_only" }
      ],
      complete: true,
      tableCount: 1,
      pictureCount: 1,
      warnings: [
        {
          code: "PDF_IMAGE_ONLY",
          message: "No searchable text",
          sourceLocation: { pageNumber: 2, method: "ocr" }
        }
      ]
    };
    Object.assign(created, {
      documentIndexParseSummary: { ...parsing, parsedObjectKey: "private/parsed.json" },
      parsedObjectKey: "private/parsed.json"
    });
    app = buildApiServer({
      employeeRepository: createRepository([adminEmployee, orgBAdminEmployee]),
      documentRepository: documents,
      cursorSigningSecret: jwtSecret,
      authenticateAccessToken: authenticateTestAccessToken,
      runtimeEnv: { SMEDC_PDF_UPLOAD_ENABLED: "false" },
      logger: false
    });
    const status = () =>
      app!.inject({
        method: "GET",
        url: "/v1/documents/evidence/synthetic-pdf-status/status",
        headers: { authorization: `Bearer ${token}` }
      });
    const token = await accessTokenFor(adminEmployee);
    const allowed = await status();
    expect(allowed.statusCode).toBe(200);
    expect(allowed.json().parsing).toEqual(parsing);
    expect(allowed.payload).not.toContain("private/");
    Object.assign(created, {
      processingRunStatus: "failed",
      documentIndexParseSummary: null,
      processingRunErrorSummary: "private/path token provider-body"
    });
    for (const [code, message] of [
      ["PDF_INVALID_OR_ENCRYPTED", "PDF is invalid or password protected."],
      ["PDF_INCOMPLETE_PARSE", "PDF conversion is incomplete."],
      ["PDF_PIXEL_LIMIT", "PDF rendering exceeds the limit."]
    ]) {
      Object.assign(created, { processingRunErrorCode: code });
      const failed = await status();
      expect(failed.json()).toMatchObject({
        parsing: null,
        processing: { status: "failed", error: { code, message } }
      });
      expect(failed.payload).not.toContain("private/");
      expect(failed.payload).not.toContain("provider-body");
    }
    for (const code of ["UNKNOWN private/path", "__proto__", "constructor"]) {
      Object.assign(created, { processingRunErrorCode: code });
      expect((await status()).json().processing.error).toBeNull();
    }
    Object.assign(created, { processingRunErrorCode: "PDF_PIXEL_LIMIT" });
    const mcpStatus = await app.inject({
      method: "POST",
      url: "/mcp",
      headers: {
        host: "127.0.0.1:3000",
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        "mcp-protocol-version": "2025-11-25"
      },
      payload: {
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name: "get_evidence_document_status", arguments: { documentId: created.id } }
      }
    });
    expect(mcpStatus.statusCode).toBe(200);
    expect(JSON.parse(mcpStatus.json().result.content[0].text).processing.error).toEqual({
      code: "PDF_PIXEL_LIMIT",
      message: "PDF rendering exceeds the limit."
    });
    expect(mcpStatus.payload).not.toContain("provider-body");
    created.uploaderId = "another-uploader";
    expect((await status()).statusCode).toBe(404);
    created.uploaderId = adminEmployee.id;
    created.orgId = orgBAdminEmployee.orgId;
    const foreign = await status();
    expect(foreign.statusCode).toBe(404);
    expect(foreign.payload).not.toContain("parsing");
    created.orgId = adminEmployee.orgId;
    created.confidentialityLevel = adminEmployee.clearance + 1;
    const denied = await status();
    expect(denied.statusCode).toBe(404);
    expect(denied.payload).not.toContain("PDF_IMAGE_ONLY");
  });

  it("uploads evidence documents and queues evidence indexing", async () => {
    const documentRepository = createDocumentRepository();
    const storageRoot = await mkdtemp(path.join(os.tmpdir(), "smedc-evidence-upload-"));
    app = buildApiServer({
      employeeRepository: createRepository([adminEmployee]),
      documentRepository,
      storageAdapter: new LocalFileSystemStorageAdapter({ root: storageRoot }),
      cursorSigningSecret: jwtSecret,
      authenticateAccessToken: authenticateTestAccessToken,
      runtimeEnv: { RETRIEVAL_CONFIG_VERSION: "phase3.retrieval.v2-bm25" },
      logger: false
    });
    const accessToken = await accessTokenFor(adminEmployee);
    const multipartPayload = createMultipartPayload([
      {
        name: "file",
        fileName: "customer-feedback-sop.md",
        contentType: "text/markdown",
        value: Buffer.from("# 差评处理\n\n先联系客户，再登记处置结果。", "utf8")
      },
      { name: "title", value: "客户反馈处理 SOP" },
      { name: "confidentialityLevel", value: "0" }
    ]);

    try {
      const response = await app.inject({
        method: "POST",
        url: "/v1/documents/evidence",
        headers: {
          authorization: `Bearer ${accessToken}`,
          "x-request-id": "req_http_1",
          "content-type": multipartPayload.contentType
        },
        remoteAddress: "198.51.100.8",
        payload: multipartPayload.body
      });

      expect(response.statusCode).toBe(202);
      expect(response.json()).toMatchObject({
        document: {
          documentKind: "evidence",
          fileType: "md",
          status: "pending_processing"
        },
        processing: {
          status: "queued"
        },
        documentIndex: {
          status: "pending",
          retrievalConfigVersion: "phase3.retrieval.v2-bm25"
        }
      });
      expect(documentRepository.documents[0]).toMatchObject({
        documentKind: "evidence",
        fileType: "md",
        status: "pending_processing",
        title: "客户反馈处理 SOP"
      });
      expect(documentRepository.processingRuns[0]).toMatchObject({
        jobType: "evidence_document_index",
        status: "queued"
      });
      expect(documentRepository.uploadInputs[0]).toMatchObject({
        audit: {
          requestId: "req_http_1",
          sourceIp: "198.51.100.8",
          clientSource: "http_api",
          launcherVersion: null
        }
      });
    } finally {
      await rm(storageRoot, { recursive: true, force: true });
    }
  });

  it("accepts evidence metadata exactly at the public string boundaries", async () => {
    const documentRepository = createDocumentRepository();
    const storageAdapter = createOrganizationContextStorageAdapter();
    app = buildApiServer({
      employeeRepository: createRepository([adminEmployee]),
      documentRepository,
      storageAdapter,
      cursorSigningSecret: jwtSecret,
      authenticateAccessToken: authenticateTestAccessToken,
      logger: false
    });
    const multipartPayload = createMultipartPayload([
      {
        name: "file",
        fileName: `${"f".repeat(252)}.md`,
        contentType: "text/markdown",
        value: Buffer.from("# SOP", "utf8")
      },
      { name: "title", value: "t".repeat(512) },
      { name: "sourceSystem", value: "s".repeat(255) },
      { name: "confidentialityLevel", value: "0" }
    ]);

    const response = await app.inject({
      method: "POST",
      url: "/v1/documents/evidence",
      headers: {
        authorization: `Bearer ${await accessTokenFor(adminEmployee)}`,
        "content-type": multipartPayload.contentType
      },
      payload: multipartPayload.body
    });

    expect(response.statusCode).toBe(202);
    expect(documentRepository.documents[0]).toMatchObject({
      title: "t".repeat(512),
      sourceSystem: "s".repeat(255),
      originalFileName: `${"f".repeat(252)}.md`
    });
  });

  it("rejects evidence metadata above the public boundaries before storage", async () => {
    const documentRepository = createDocumentRepository();
    const storageAdapter = createOrganizationContextStorageAdapter();
    app = buildApiServer({
      employeeRepository: createRepository([adminEmployee]),
      documentRepository,
      storageAdapter,
      cursorSigningSecret: jwtSecret,
      authenticateAccessToken: authenticateTestAccessToken,
      logger: false
    });
    const cases = [
      { fileName: "sop.md", title: "t".repeat(513), sourceSystem: "manual" },
      { fileName: "sop.md", title: "SOP", sourceSystem: "s".repeat(256) },
      {
        fileName: `${"f".repeat(253)}.md`,
        title: "SOP",
        sourceSystem: "manual"
      }
    ];

    for (const testCase of cases) {
      const multipartPayload = createMultipartPayload([
        {
          name: "file",
          fileName: testCase.fileName,
          contentType: "text/markdown",
          value: Buffer.from("# SOP", "utf8")
        },
        { name: "title", value: testCase.title },
        { name: "sourceSystem", value: testCase.sourceSystem }
      ]);
      const response = await app.inject({
        method: "POST",
        url: "/v1/documents/evidence",
        headers: {
          authorization: `Bearer ${await accessTokenFor(adminEmployee)}`,
          "content-type": multipartPayload.contentType
        },
        payload: multipartPayload.body
      });

      expect(response.statusCode).toBe(400);
      expect(response.json()).toMatchObject({
        error: { code: "INVALID_EVIDENCE_UPLOAD" }
      });
    }

    expect(storageAdapter.putInputs).toHaveLength(0);
    expect(documentRepository.documents).toHaveLength(0);
  });

  it("maps multipart file, file-count, field-count, and part-count excess to 413", async () => {
    const documentRepository = createDocumentRepository();
    const storageAdapter = createOrganizationContextStorageAdapter();
    app = buildApiServer({
      employeeRepository: createRepository([adminEmployee]),
      documentRepository,
      storageAdapter,
      cursorSigningSecret: jwtSecret,
      authenticateAccessToken: authenticateTestAccessToken,
      logger: false,
      runtimeEnv: { MAX_UPLOAD_BYTES: "8" }
    });
    const payloads = [
      createMultipartPayload([
        {
          name: "file",
          fileName: "sop.md",
          contentType: "text/markdown",
          value: Buffer.from("123456789", "utf8")
        },
        { name: "title", value: "SOP" },
        { name: "confidentialityLevel", value: "0" }
      ]),
      createMultipartPayload([
        {
          name: "file",
          fileName: "first.md",
          contentType: "text/markdown",
          value: Buffer.from("first", "utf8")
        },
        {
          name: "file",
          fileName: "second.md",
          contentType: "text/markdown",
          value: Buffer.from("second", "utf8")
        },
        { name: "title", value: "SOP" },
        { name: "confidentialityLevel", value: "0" }
      ]),
      createMultipartPayload([
        {
          name: "file",
          fileName: "sop.md",
          contentType: "text/markdown",
          value: Buffer.from("content", "utf8")
        },
        { name: "title", value: "SOP" },
        { name: "confidentialityLevel", value: "0" },
        ...Array.from({ length: 59 }, (_, index) => ({
          name: `compatibility_${index}`,
          value: "value"
        }))
      ])
    ];

    for (const multipartPayload of payloads) {
      const response = await app.inject({
        method: "POST",
        url: "/v1/documents/evidence",
        headers: {
          authorization: `Bearer ${await accessTokenFor(adminEmployee)}`,
          "content-type": multipartPayload.contentType
        },
        payload: multipartPayload.body
      });

      expect(response.statusCode).toBe(413);
      expect(response.json()).toMatchObject({
        error: {
          code: "PAYLOAD_TOO_LARGE",
          requestId: expect.any(String)
        }
      });
    }

    expect(storageAdapter.putInputs).toHaveLength(0);
    expect(documentRepository.documents).toHaveLength(0);
  });

  it("returns evidence indexing status only to the uploader", async () => {
    const documentRepository = createDocumentRepository();
    documentRepository.documents.push({
      id: "doc_evidence_status",
      orgId: "default-org",
      uploaderId: baoliEmployee.id,
      title: "客户反馈处理 SOP",
      documentType: "management_knowledge",
      documentKind: "evidence",
      fileType: "md",
      confidentialityLevel: 0,
      processingRunStatus: "succeeded",
      documentIndexStatus: "ready",
      documentIndexRetrievalConfigVersion: "phase3.retrieval.v2-bm25",
      status: "active",
      sourceSystem: "manual",
      sourceTime: null,
      storageObjectKey: "org/default-org/documents/doc_evidence_status/original/sop.md",
      originalFileName: "sop.md",
      contentType: "text/markdown",
      byteSize: 123,
      checksumSha256: "hash"
    });
    app = buildApiServer({
      employeeRepository: createRepository([adminEmployee, baoliEmployee, suzhouEmployee]),
      documentRepository,
      cursorSigningSecret: jwtSecret,
      authenticateAccessToken: authenticateTestAccessToken,
      logger: false
    });

    const uploaderResponse = await app.inject({
      method: "GET",
      url: "/v1/documents/evidence/doc_evidence_status/status",
      headers: {
        authorization: `Bearer ${await accessTokenFor(baoliEmployee)}`
      }
    });
    const adminResponse = await app.inject({
      method: "GET",
      url: "/v1/documents/evidence/doc_evidence_status/status",
      headers: {
        authorization: `Bearer ${await accessTokenFor(adminEmployee)}`
      }
    });
    const otherEmployeeResponse = await app.inject({
      method: "GET",
      url: "/v1/documents/evidence/doc_evidence_status/status",
      headers: {
        authorization: `Bearer ${await accessTokenFor(suzhouEmployee)}`
      }
    });

    expect(uploaderResponse.statusCode).toBe(200);
    expect(uploaderResponse.json()).toMatchObject({
      document: {
        documentId: "doc_evidence_status",
        documentKind: "evidence",
        fileType: "md",
        status: "active"
      },
      processing: {
        status: "succeeded"
      },
      documentIndex: {
        status: "ready",
        retrievalConfigVersion: "phase3.retrieval.v2-bm25"
      }
    });
    expect(adminResponse.statusCode).toBe(404);
    expect(otherEmployeeResponse.statusCode).toBe(404);
  });

  it("searches evidence chunks without returning natural-language answers", async () => {
    const evidenceRepository = createEvidenceSearchRepository();
    const issueMany = vi.fn(async () => ({
      sources: [
        {
          sourceDocumentId: "doc_evidence",
          documentTitle: "客户反馈处理 SOP.docx",
          originalFileName: "customer-feedback-sop.docx",
          contentType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
          byteSize: 123,
          downloadStatus: "available" as const,
          downloadUrl: "https://download.example.test/doc_evidence",
          expiresAt: "2026-09-22T00:00:00.000Z"
        }
      ],
      warnings: []
    }));
    app = buildApiServer({
      employeeRepository: createRepository([adminEmployee]),
      evidenceRepository,
      sourceDocumentDownloadIssuer: { issueMany },
      cursorSigningSecret: jwtSecret,
      authenticateAccessToken: authenticateTestAccessToken,
      logger: false
    });
    const accessToken = await accessTokenFor(adminEmployee);

    const response = await app.inject({
      method: "POST",
      url: "/v1/evidence/search",
      headers: {
        authorization: `Bearer ${accessToken}`,
        "x-request-id": "req_http_1"
      },
      remoteAddress: "198.51.100.8",
      payload: {
        query: "差评处理 SOP",
        filters: {
          fileTypes: ["docx"],
          documentIds: []
        },
        limit: 10,
        cursor: null
      }
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body).toMatchObject({
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
      retrieval: {
        retrievalConfigVersion: "phase3.retrieval.v1",
        rerankStatus: "enabled"
      },
      sources: [
        {
          sourceDocumentId: "doc_evidence",
          downloadStatus: "available",
          downloadUrl: "https://download.example.test/doc_evidence"
        }
      ],
      requestId: expect.any(String)
    });
    expect(JSON.stringify(body)).not.toContain("answer");
    expect(evidenceRepository.queries).toEqual([
      { query: "差评处理 SOP", employeeId: adminEmployee.id }
    ]);
    expect(evidenceRepository.inputs[0]?.audit).toEqual({
      requestId: "req_http_1",
      sourceIp: "198.51.100.8",
      clientSource: "http_api",
      launcherVersion: null
    });
    expect(issueMany).toHaveBeenCalledWith(
      expect.objectContaining({
        orgId: adminEmployee.orgId,
        reason: "evidence_search_auto",
        requestedSources: [
          {
            sourceDocumentId: "doc_evidence",
            documentTitle: "客户反馈处理 SOP.docx"
          }
        ]
      })
    );
  });

  it("returns an explicit unavailable source and warning after an authorization race", async () => {
    const evidenceRepository = createEvidenceSearchRepository();
    app = buildApiServer({
      employeeRepository: createRepository([adminEmployee]),
      evidenceRepository,
      sourceDocumentDownloadIssuer: {
        async issueMany() {
          return {
            sources: [
              {
                sourceDocumentId: "doc_evidence",
                documentTitle: "客户反馈处理 SOP.docx",
                originalFileName: null,
                contentType: null,
                byteSize: null,
                downloadStatus: "unavailable",
                downloadUrl: null,
                expiresAt: null
              }
            ],
            warnings: ["SOURCE_DOWNLOAD_URL_UNAVAILABLE"]
          };
        }
      },
      cursorSigningSecret: jwtSecret,
      authenticateAccessToken: authenticateTestAccessToken,
      logger: false
    });

    const response = await app.inject({
      method: "POST",
      url: "/v1/evidence/search",
      headers: { authorization: `Bearer ${await accessTokenFor(adminEmployee)}` },
      payload: { query: "差评处理 SOP" }
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      sources: [
        {
          sourceDocumentId: "doc_evidence",
          originalFileName: null,
          downloadStatus: "unavailable",
          downloadUrl: null
        }
      ],
      warnings: ["SOURCE_DOWNLOAD_URL_UNAVAILABLE"]
    });
  });

  it("treats a forged public delegation proof as ordinary HTTP provenance", async () => {
    const evidenceRepository = createEvidenceSearchRepository();
    app = buildApiServer({
      employeeRepository: createRepository([adminEmployee]),
      evidenceRepository,
      sourceDocumentDownloadIssuer: {
        async issueMany() {
          return {
            sources: [
              {
                sourceDocumentId: "doc_evidence",
                documentTitle: "客户反馈处理 SOP.docx",
                originalFileName: "customer-feedback-sop.docx",
                contentType:
                  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
                byteSize: 123,
                downloadStatus: "available",
                downloadUrl: "https://download.example.test/doc_evidence",
                expiresAt: "2026-09-22T00:00:00.000Z"
              }
            ],
            warnings: []
          };
        }
      },
      cursorSigningSecret: jwtSecret,
      authenticateAccessToken: authenticateTestAccessToken,
      internalDelegationProof: Buffer.alloc(32, 0x5a).toString("base64url"),
      logger: false
    });

    const response = await app.inject({
      method: "POST",
      url: "/v1/evidence/search",
      headers: {
        authorization: `Bearer ${await accessTokenFor(adminEmployee)}`,
        "x-request-id": "forged_request_1",
        "x-forwarded-for": "203.0.113.9",
        "x-smedc-launcher-version": "0.1.0",
        "x-smedc-internal-delegation": Buffer.alloc(32, 0xa5).toString("base64url")
      },
      remoteAddress: "198.51.100.8",
      payload: {
        query: "forged delegation proof",
        limit: 1
      }
    });

    expect(response.statusCode).toBe(200);
    expect(evidenceRepository.inputs[0]?.audit).toEqual({
      requestId: "forged_request_1",
      sourceIp: "198.51.100.8",
      clientSource: "http_api",
      launcherVersion: null
    });
  });

  it("rejects null and over-limit evidence search inputs before retrieval", async () => {
    const evidenceRepository = createEvidenceSearchRepository();
    app = buildApiServer({
      employeeRepository: createRepository([adminEmployee]),
      evidenceRepository,
      cursorSigningSecret: jwtSecret,
      authenticateAccessToken: authenticateTestAccessToken,
      logger: false
    });
    const headers = {
      authorization: `Bearer ${await accessTokenFor(adminEmployee)}`,
      "content-type": "application/json"
    };
    const cases = [
      { payload: "null", code: "INVALID_QUERY" },
      { payload: { query: "q".repeat(4_001) }, code: "LIMIT_EXCEEDED" },
      { payload: { query: "q", cursor: "c".repeat(4_097) }, code: "INVALID_CURSOR" },
      {
        payload: { query: "q", filters: { documentIds: ["d".repeat(65)] } },
        code: "LIMIT_EXCEEDED"
      },
      {
        payload: { query: "q", filters: { documentIds: "doc_1" } },
        code: "INVALID_QUERY"
      }
    ];

    for (const testCase of cases) {
      const response = await app.inject({
        method: "POST",
        url: "/v1/evidence/search",
        headers,
        payload: testCase.payload
      });

      expect(response.statusCode).toBe(400);
      expect(response.json()).toMatchObject({
        error: { code: testCase.code }
      });
    }

    expect(evidenceRepository.queries).toHaveLength(0);
  });

  it("does not expose unexpected evidence provider failures", async () => {
    app = buildApiServer({
      employeeRepository: createRepository([adminEmployee]),
      evidenceRepository: {
        async searchEvidence() {
          throw new Error("provider detail: private-host.internal:6333");
        }
      },
      cursorSigningSecret: jwtSecret,
      authenticateAccessToken: authenticateTestAccessToken,
      logger: false
    });

    const response = await app.inject({
      method: "POST",
      url: "/v1/evidence/search",
      headers: {
        authorization: `Bearer ${await accessTokenFor(adminEmployee)}`
      },
      payload: { query: "差评处理 SOP" }
    });

    expect(response.statusCode).toBe(500);
    expect(response.json()).toEqual({
      error: {
        code: "INTERNAL_ERROR",
        message: "Internal server error.",
        requestId: expect.any(String)
      }
    });
    expect(response.payload).not.toContain("private-host.internal:6333");
  });

  it("uses the reloaded org-B employee for evidence storage, catalog, and audit context", async () => {
    const documentRepository = createOrganizationContextDocumentRepository();
    const storageAdapter = createOrganizationContextStorageAdapter();
    app = buildApiServer({
      employeeRepository: createRepository([orgBAdminEmployee]),
      documentRepository,
      storageAdapter,
      cursorSigningSecret: jwtSecret,
      authenticateAccessToken: authenticateTestAccessToken,
      logger: false
    });
    const staleOrgToken = await accessTokenFor(orgBAdminEmployee);
    const multipartPayload = createMultipartPayload([
      {
        name: "file",
        fileName: "org-b-sop.md",
        contentType: "text/markdown",
        value: Buffer.from("org B evidence", "utf8")
      },
      { name: "title", value: "Org B SOP" },
      { name: "confidentialityLevel", value: "0" }
    ]);

    const response = await app.inject({
      method: "POST",
      url: "/v1/documents/evidence",
      headers: {
        authorization: `Bearer ${staleOrgToken}`,
        "content-type": multipartPayload.contentType
      },
      payload: multipartPayload.body
    });

    expect(response.statusCode).toBe(202);
    expect(storageAdapter.putInputs).toEqual([
      expect.objectContaining({ orgId: "org-b", contentType: "text/markdown" })
    ]);
    expect(documentRepository.catalogWriteOrgIds).toEqual(["org-b"]);
    expect(documentRepository.auditWriteOrgIds).toEqual(["org-b"]);
  });

  it("rejects evidence uploads in unsupported formats", async () => {
    app = buildApiServer({
      employeeRepository: createRepository([adminEmployee]),
      documentRepository: createDocumentRepository(),
      storageAdapter: new LocalFileSystemStorageAdapter({
        root: await mkdtemp(path.join(os.tmpdir(), "smedc-evidence-format-"))
      }),
      cursorSigningSecret: jwtSecret,
      authenticateAccessToken: authenticateTestAccessToken,
      logger: false
    });
    const accessToken = await accessTokenFor(adminEmployee);
    const multipartPayload = createMultipartPayload([
      {
        name: "file",
        fileName: "invalid-format.csv",
        contentType: "text/csv",
        value: Buffer.from("a,b\n1,2", "utf8")
      },
      { name: "title", value: "CSV 不是支持的证据格式" },
      { name: "confidentialityLevel", value: "0" }
    ]);

    const response = await app.inject({
      method: "POST",
      url: "/v1/documents/evidence",
      headers: {
        authorization: `Bearer ${accessToken}`,
        "content-type": multipartPayload.contentType
      },
      payload: multipartPayload.body
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      error: {
        code: "INVALID_DOCUMENT_KIND_FILE_TYPE",
        message: "Evidence documents must be .md, .txt, .docx, or .pdf files."
      }
    });
  });
});
