import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import type { AuthenticatedEmployee } from "@smedc/domain";
import { LocalFileSystemStorageAdapter } from "@smedc/storage";
import { buildApiServer } from "../server.js";
import {
  accessTokenFor,
  authenticateTestAccessToken,
  adminEmployee,
  baoliEmployee,
  createDocumentRepository,
  createInMemoryQuarantineCertificateRepository,
  createMultipartPayload,
  createRepository,
  jwtSecret,
  lowClearanceAdminEmployee,
  clearanceZeroAdminEmployee,
  suzhouEmployee
} from "../test-support/api-server-fixtures.js";

const pngBytes = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d
]);

describe("quarantine certificate routes", () => {
  it.each([false, true])(
    "denies employee upload before parsing or side effects (audit failure: %s)",
    async (auditFails) => {
      const documentRepository = createDocumentRepository();
      const quarantineCertificateRepository = createInMemoryQuarantineCertificateRepository(
        documentRepository.documents,
        documentRepository.auditLogs
      );
      const uploadRepositoryCalls = Object.keys(quarantineCertificateRepository)
        .filter(
          (key) =>
            typeof quarantineCertificateRepository[
              key as keyof typeof quarantineCertificateRepository
            ] === "function"
        )
        .map((key) => vi.spyOn(quarantineCertificateRepository, key as "findByIdempotencyKey"));
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
        quarantineCertificateRepository,
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
        url: "/v1/documents/quarantine-certificates",
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
        uploadSurface: "quarantine_certificate",
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
          { requestId: "req_upload_denied", uploadSurface: "quarantine_certificate" },
          "upload denial audit failed"
        );
      } else {
        expect(logAuditFailure).not.toHaveBeenCalled();
      }
      for (const call of documentCalls) expect(call).not.toHaveBeenCalled();
      for (const call of uploadRepositoryCalls) expect(call).not.toHaveBeenCalled();
      expect(documentRepository.documents).toHaveLength(0);
    }
  );
  let app: FastifyInstance | undefined;
  let storageRoot: string | undefined;

  afterEach(async () => {
    await app?.close();
    app = undefined;

    if (storageRoot) {
      await rm(storageRoot, { recursive: true, force: true });
      storageRoot = undefined;
    }
  });

  async function buildQuarantineTestServer(
    employees: AuthenticatedEmployee[] = [
      adminEmployee,
      baoliEmployee,
      suzhouEmployee,
      clearanceZeroAdminEmployee
    ]
  ) {
    storageRoot = await mkdtemp(path.join(os.tmpdir(), "smedc-quarantine-"));
    const documentRepository = createDocumentRepository();
    const quarantineCertificateRepository = createInMemoryQuarantineCertificateRepository(
      documentRepository.documents,
      documentRepository.auditLogs
    );
    const storageAdapter = new LocalFileSystemStorageAdapter({ root: storageRoot });

    app = buildApiServer({
      employeeRepository: createRepository(employees),
      documentRepository,
      quarantineCertificateRepository,
      storageAdapter,
      cursorSigningSecret: jwtSecret,
      authenticateAccessToken: authenticateTestAccessToken,
      logger: false
    });

    return { app, documentRepository, storageAdapter };
  }

  async function uploadCertificate(
    server: FastifyInstance,
    input: {
      receiptId?: string;
      idempotencyKey?: string;
      confidentialityLevel?: number;
      fileName?: string;
      contentType?: string;
      body?: Buffer;
    } = {},
    employee: AuthenticatedEmployee = adminEmployee
  ) {
    const multipart = createMultipartPayload([
      {
        name: "file",
        fileName: input.fileName ?? "quarantine.png",
        contentType: input.contentType ?? "image/png",
        value: input.body ?? pngBytes
      },
      { name: "receiptId", value: input.receiptId ?? " sh2608250117 " },
      { name: "confidentialityLevel", value: String(input.confidentialityLevel ?? 0) },
      { name: "idempotencyKey", value: input.idempotencyKey ?? "idem-quarantine-1" }
    ]);

    return server.inject({
      method: "POST",
      url: "/v1/documents/quarantine-certificates",
      headers: {
        authorization: `Bearer ${await accessTokenFor(employee)}`,
        "x-request-id": "req_quarantine_1",
        "content-type": multipart.contentType
      },
      remoteAddress: "198.51.100.9",
      payload: multipart.body
    });
  }

  async function queryCertificates(server: FastifyInstance, receiptIds: string[]) {
    return server.inject({
      method: "POST",
      url: "/v1/quarantine-certificates/query",
      headers: {
        authorization: `Bearer ${await accessTokenFor(baoliEmployee)}`
      },
      payload: { receiptIds }
    });
  }

  async function archiveCertificates(
    server: FastifyInstance,
    body: Record<string, string>,
    employee: AuthenticatedEmployee = baoliEmployee
  ) {
    return server.inject({
      method: "POST",
      url: "/v1/quarantine-certificates/archive",
      headers: {
        authorization: `Bearer ${await accessTokenFor(employee)}`
      },
      payload: body
    });
  }

  it("uploads one image synchronously and exact idempotent replay returns the same certificate", async () => {
    const { app, documentRepository } = await buildQuarantineTestServer();

    const first = await uploadCertificate(app);
    const replay = await uploadCertificate(app);

    expect(first.statusCode).toBe(201);
    expect(replay.statusCode).toBe(201);
    expect(replay.json()).toEqual(first.json());
    expect(first.json()).toMatchObject({
      sourceDocumentId: expect.stringMatching(/^doc_/),
      receiptId: "SH2608250117",
      originalFileName: "quarantine.png",
      contentType: "image/png",
      byteSize: pngBytes.byteLength,
      uploadedAt: expect.any(String)
    });
    expect(documentRepository.documents).toHaveLength(1);
    expect(documentRepository.documents[0]).toMatchObject({
      documentKind: "quarantine_certificate",
      fileType: "png",
      status: "active",
      confidentialityLevel: 0
    });
  });

  it("queries visible certificates grouped by normalized receipt IDs without leaking hidden matches", async () => {
    const { app } = await buildQuarantineTestServer();
    const visible = await uploadCertificate(app);
    await uploadCertificate(
      app,
      {
        receiptId: "SH2608260003",
        idempotencyKey: "idem-hidden",
        confidentialityLevel: 3
      },
      adminEmployee
    );

    const response = await queryCertificates(app, [
      "sh2608250117",
      "missing",
      "SH2608260003",
      " SH2608250117 "
    ]);

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      results: [
        {
          receiptId: "SH2608250117",
          certificates: [visible.json()]
        },
        {
          receiptId: "MISSING",
          certificates: []
        },
        {
          receiptId: "SH2608260003",
          certificates: []
        }
      ]
    });
  });

  it("rejects idempotency-key reuse with different certificate content", async () => {
    const { app } = await buildQuarantineTestServer();

    const first = await uploadCertificate(app);
    const conflict = await uploadCertificate(app, {
      body: Buffer.concat([pngBytes, Buffer.from("changed")])
    });

    expect(first.statusCode).toBe(201);
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json()).toEqual({
      error: {
        code: "IDEMPOTENCY_KEY_CONFLICT",
        message: "Idempotency key was reused with different certificate content."
      }
    });
  });

  it("rejects image uploads when extension, MIME type, and magic bytes do not agree", async () => {
    const { app, documentRepository } = await buildQuarantineTestServer();

    const response = await uploadCertificate(app, {
      idempotencyKey: "idem-bad-image",
      fileName: "quarantine.png",
      contentType: "image/png",
      body: Buffer.from([0xff, 0xd8, 0xff])
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      error: { code: "INVALID_QUARANTINE_CERTIFICATE_IMAGE" }
    });
    expect(documentRepository.documents).toHaveLength(0);
  });

  it("allows an uploader to declare any confidentiality level", async () => {
    const { app, documentRepository } = await buildQuarantineTestServer();

    const response = await uploadCertificate(
      app,
      {
        idempotencyKey: "idem-level-3",
        confidentialityLevel: 3
      },
      clearanceZeroAdminEmployee
    );

    expect(response.statusCode).toBe(201);
    expect(documentRepository.documents).toHaveLength(1);
    expect(documentRepository.documents[0]?.confidentialityLevel).toBe(3);
  });

  it("archives by source document for the uploader and by receipt ID for admins only", async () => {
    const formerUploader: AuthenticatedEmployee = { ...baoliEmployee, role: "admin" };
    const { app } = await buildQuarantineTestServer([adminEmployee, formerUploader]);
    const first = await uploadCertificate(
      app,
      { idempotencyKey: "idem-archive-1" },
      formerUploader
    );
    await uploadCertificate(app, { idempotencyKey: "idem-archive-2" }, formerUploader);
    formerUploader.role = "employee";

    const bySource = await archiveCertificates(app, {
      sourceDocumentId: first.json().sourceDocumentId
    });
    const employeeBulk = await archiveCertificates(app, { receiptId: "SH2608250117" });
    const adminBulk = await archiveCertificates(app, { receiptId: "sh2608250117" }, adminEmployee);
    const repeatAdminBulk = await archiveCertificates(
      app,
      { receiptId: "SH2608250117" },
      adminEmployee
    );

    expect(bySource.statusCode).toBe(200);
    expect(bySource.json()).toEqual({ archivedCount: 1, affectedLedgerPartitions: [] });
    expect(employeeBulk.statusCode).toBe(403);
    expect(adminBulk.statusCode).toBe(200);
    expect(adminBulk.json()).toEqual({ archivedCount: 1, affectedLedgerPartitions: [] });
    expect(repeatAdminBulk.json()).toEqual({ archivedCount: 0, affectedLedgerPartitions: [] });
    expect((await queryCertificates(app, ["SH2608250117"])).json()).toEqual({
      results: [{ receiptId: "SH2608250117", certificates: [] }]
    });
  });

  it("lets an admin PAO archive above clearance without granting ordinary read access", async () => {
    const { app } = await buildQuarantineTestServer([
      lowClearanceAdminEmployee,
      adminEmployee,
      baoliEmployee,
      suzhouEmployee
    ]);
    const sourceLevelThree = await uploadCertificate(
      app,
      {
        receiptId: "SH2608250999",
        idempotencyKey: "idem-admin-pao-level-3",
        confidentialityLevel: 3
      },
      adminEmployee
    );
    await uploadCertificate(
      app,
      {
        receiptId: "SH2608251000",
        idempotencyKey: "idem-admin-pao-level-3-receipt",
        confidentialityLevel: 3
      },
      adminEmployee
    );

    const ordinaryQuery = await app.inject({
      method: "POST",
      url: "/v1/quarantine-certificates/query",
      headers: {
        authorization: `Bearer ${await accessTokenFor(lowClearanceAdminEmployee)}`
      },
      payload: { receiptIds: ["SH2608250999"] }
    });
    const paoArchive = await archiveCertificates(
      app,
      { receiptId: "SH2608251000" },
      lowClearanceAdminEmployee
    );
    const paoArchiveBySource = await archiveCertificates(
      app,
      { sourceDocumentId: sourceLevelThree.json().sourceDocumentId },
      lowClearanceAdminEmployee
    );

    expect(ordinaryQuery.statusCode).toBe(200);
    expect(ordinaryQuery.json()).toEqual({
      results: [{ receiptId: "SH2608250999", certificates: [] }]
    });
    expect(paoArchive.statusCode).toBe(200);
    expect(paoArchive.json()).toEqual({ archivedCount: 1, affectedLedgerPartitions: [] });
    expect(paoArchiveBySource.statusCode).toBe(200);
    expect(paoArchiveBySource.json()).toEqual({ archivedCount: 1, affectedLedgerPartitions: [] });
  });
});
