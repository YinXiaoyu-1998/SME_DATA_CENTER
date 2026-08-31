import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import type { AuthenticatedEmployee } from "@enterprise-hub/domain";
import { LocalFileSystemStorageAdapter } from "@enterprise-hub/storage";
import { buildApiServer } from "../server.js";
import {
  accessTokenFor,
  authenticateTestAccessToken,
  adminEmployee,
  baoliManagerEmployee,
  createDocumentRepository,
  createInMemoryQuarantineCertificateRepository,
  createMultipartPayload,
  createRepository,
  jwtSecret,
  suzhouManagerEmployee
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
    employees: AuthenticatedEmployee[] = [
      adminEmployee,
      baoliManagerEmployee,
      suzhouManagerEmployee
    ]
  ) {
    storageRoot = await mkdtemp(path.join(os.tmpdir(), "enterprise-hub-quarantine-"));
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
      labelKey?: string;
      fileName?: string;
      contentType?: string;
      body?: Buffer;
    } = {},
    employee: AuthenticatedEmployee = baoliManagerEmployee
  ) {
    const multipart = createMultipartPayload([
      {
        name: "file",
        fileName: input.fileName ?? "quarantine.png",
        contentType: input.contentType ?? "image/png",
        value: input.body ?? pngBytes
      },
      { name: "receiptId", value: input.receiptId ?? " sh2608250117 " },
      { name: "labelKeys[]", value: input.labelKey ?? "store:baoli" },
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
        authorization: `Bearer ${await accessTokenFor(baoliManagerEmployee)}`
      },
      payload: { receiptIds }
    });
  }

  async function archiveCertificates(
    server: FastifyInstance,
    body: Record<string, string>,
    employee: AuthenticatedEmployee = baoliManagerEmployee
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
      labels: ["store:baoli"]
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
        labelKey: "store:suzhou"
      },
      suzhouManagerEmployee
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

  it("rejects labels the uploader cannot assign", async () => {
    const { app, documentRepository } = await buildQuarantineTestServer();

    const response = await uploadCertificate(app, {
      idempotencyKey: "idem-forbidden-label",
      labelKey: "store:suzhou"
    });

    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ error: { code: "FORBIDDEN_LABEL" } });
    expect(documentRepository.documents).toHaveLength(0);
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
});
