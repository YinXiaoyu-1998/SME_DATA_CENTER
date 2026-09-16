import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
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
  suzhouEmployee
} from "../test-support/api-server-fixtures.js";

const pngBytes = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d
]);

describe("quarantine certificate routes", () => {
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
    employees: AuthenticatedEmployee[] = [adminEmployee, baoliEmployee, suzhouEmployee]
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
    employee: AuthenticatedEmployee = baoliEmployee
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
      suzhouEmployee
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

    const response = await uploadCertificate(app, {
      idempotencyKey: "idem-level-3",
      confidentialityLevel: 3
    });

    expect(response.statusCode).toBe(201);
    expect(documentRepository.documents).toHaveLength(1);
    expect(documentRepository.documents[0]?.confidentialityLevel).toBe(3);
  });

  it("archives by source document for the uploader and by receipt ID for admins only", async () => {
    const { app } = await buildQuarantineTestServer();
    const first = await uploadCertificate(app, { idempotencyKey: "idem-archive-1" });
    await uploadCertificate(app, { idempotencyKey: "idem-archive-2" });

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
    expect(bySource.json()).toEqual({ archivedCount: 1 });
    expect(employeeBulk.statusCode).toBe(403);
    expect(adminBulk.statusCode).toBe(200);
    expect(adminBulk.json()).toEqual({ archivedCount: 1 });
    expect(repeatAdminBulk.json()).toEqual({ archivedCount: 0 });
    expect((await queryCertificates(app, ["SH2608250117"])).json()).toEqual({
      results: [{ receiptId: "SH2608250117", certificates: [] }]
    });
  });

  it("lets an admin PAO archive above clearance without granting ordinary read access", async () => {
    const { app } = await buildQuarantineTestServer([
      lowClearanceAdminEmployee,
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
      baoliEmployee
    );
    await uploadCertificate(
      app,
      {
        receiptId: "SH2608251000",
        idempotencyKey: "idem-admin-pao-level-3-receipt",
        confidentialityLevel: 3
      },
      baoliEmployee
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
    expect(paoArchive.json()).toEqual({ archivedCount: 1 });
    expect(paoArchiveBySource.statusCode).toBe(200);
    expect(paoArchiveBySource.json()).toEqual({ archivedCount: 1 });
  });
});
