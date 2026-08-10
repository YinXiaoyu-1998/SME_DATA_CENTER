import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { LocalFileSystemStorageAdapter } from "@enterprise-hub/storage";
import { buildApiServer } from "../server.js";
import {
  adminEmployee,
  baoliManagerEmployee,
  orgBAdminEmployee,
  suzhouManagerEmployee,
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
  let app: FastifyInstance | undefined;

  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  it("uploads evidence documents and queues evidence indexing", async () => {
    const documentRepository = createDocumentRepository();
    const storageRoot = await mkdtemp(path.join(os.tmpdir(), "enterprise-hub-evidence-upload-"));
    app = buildApiServer({
      employeeRepository: createRepository([adminEmployee]),
      documentRepository,
      storageAdapter: new LocalFileSystemStorageAdapter({ root: storageRoot }),
      cursorSigningSecret: jwtSecret,
      authenticateAccessToken: authenticateTestAccessToken,
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
      { name: "labelKeys[]", value: "all_staff" }
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
          retrievalConfigVersion: "phase3.retrieval.v1"
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
      { name: "labelKeys[]", value: "all_staff" }
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
      { fileName: "sop.md", title: "t".repeat(513), sourceSystem: "manual", labels: ["all_staff"] },
      { fileName: "sop.md", title: "SOP", sourceSystem: "s".repeat(256), labels: ["all_staff"] },
      {
        fileName: `${"f".repeat(253)}.md`,
        title: "SOP",
        sourceSystem: "manual",
        labels: ["all_staff"]
      },
      {
        fileName: "sop.md",
        title: "SOP",
        sourceSystem: "manual",
        labels: ["l".repeat(129)]
      },
      {
        fileName: "sop.md",
        title: "SOP",
        sourceSystem: "manual",
        labels: Array.from({ length: 51 }, (_, index) => `label_${index}`)
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
        { name: "sourceSystem", value: testCase.sourceSystem },
        ...testCase.labels.map((label) => ({ name: "labelKeys[]", value: label }))
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
        { name: "labelKeys[]", value: "all_staff" }
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
        { name: "labelKeys[]", value: "all_staff" }
      ]),
      createMultipartPayload([
        {
          name: "file",
          fileName: "sop.md",
          contentType: "text/markdown",
          value: Buffer.from("content", "utf8")
        },
        { name: "title", value: "SOP" },
        { name: "labelKeys[]", value: "all_staff" },
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

  it("returns evidence indexing status only to the uploader or admin", async () => {
    const documentRepository = createDocumentRepository();
    documentRepository.documents.push({
      id: "doc_evidence_status",
      orgId: "default-org",
      uploaderId: baoliManagerEmployee.id,
      title: "客户反馈处理 SOP",
      documentType: "management_knowledge",
      documentKind: "evidence",
      fileType: "md",
      labels: ["store:baoli", "person:baoli.manager"],
      processingRunStatus: "succeeded",
      documentIndexStatus: "ready",
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
      employeeRepository: createRepository([
        adminEmployee,
        baoliManagerEmployee,
        suzhouManagerEmployee
      ]),
      documentRepository,
      cursorSigningSecret: jwtSecret,
      authenticateAccessToken: authenticateTestAccessToken,
      logger: false
    });

    const uploaderResponse = await app.inject({
      method: "GET",
      url: "/v1/documents/evidence/doc_evidence_status/status",
      headers: {
        authorization: `Bearer ${await accessTokenFor(baoliManagerEmployee)}`
      }
    });
    const adminResponse = await app.inject({
      method: "GET",
      url: "/v1/documents/evidence/doc_evidence_status/status",
      headers: {
        authorization: `Bearer ${await accessTokenFor(adminEmployee)}`
      }
    });
    const otherManagerResponse = await app.inject({
      method: "GET",
      url: "/v1/documents/evidence/doc_evidence_status/status",
      headers: {
        authorization: `Bearer ${await accessTokenFor(suzhouManagerEmployee)}`
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
        retrievalConfigVersion: "phase3.retrieval.v1"
      }
    });
    expect(adminResponse.statusCode).toBe(200);
    expect(otherManagerResponse.statusCode).toBe(404);
  });

  it("searches evidence chunks without returning natural-language answers", async () => {
    const evidenceRepository = createEvidenceSearchRepository();
    app = buildApiServer({
      employeeRepository: createRepository([adminEmployee]),
      evidenceRepository,
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
          documentIds: [],
          labelIds: []
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
  });

  it("treats a forged public delegation proof as ordinary HTTP provenance", async () => {
    const evidenceRepository = createEvidenceSearchRepository();
    app = buildApiServer({
      employeeRepository: createRepository([adminEmployee]),
      evidenceRepository,
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
        "x-enterprise-hub-launcher-version": "0.1.0",
        "x-enterprise-hub-internal-delegation": Buffer.alloc(32, 0xa5).toString("base64url")
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
        payload: {
          query: "q",
          filters: {
            labelIds: Array.from({ length: 101 }, (_, index) => `label_${index}`)
          }
        },
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

  it("uses the reloaded org-B employee for evidence labels, storage, catalog, and audit context", async () => {
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
      { name: "labelKeys[]", value: "same-named" }
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
    expect(documentRepository.labelLookupOrgIds).toEqual(["org-b"]);
    expect(documentRepository.personalLabelLookupOrgIds).toEqual(["org-b"]);
    expect(storageAdapter.putInputs).toEqual([
      expect.objectContaining({ orgId: "org-b", contentType: "text/markdown" })
    ]);
    expect(documentRepository.catalogWriteOrgIds).toEqual(["org-b"]);
    expect(documentRepository.auditWriteOrgIds).toEqual(["org-b"]);
  });
});
