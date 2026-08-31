import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import type { StorageAdapter } from "@enterprise-hub/storage";
import { LocalFileSystemStorageAdapter } from "@enterprise-hub/storage";
import { buildApiServer } from "../server.js";
import {
  accessTokenFor,
  authenticateTestAccessToken,
  baoliManagerEmployee,
  createDocumentRepository,
  createInMemoryQuarantineCertificateRepository,
  createInMemorySourceDocumentRepository,
  createMultipartPayload,
  createRepository,
  jwtSecret
} from "../test-support/api-server-fixtures.js";

const pngBytes = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d
]);

describe("source document download routes", () => {
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

  async function buildDownloadTestServer() {
    storageRoot = await mkdtemp(path.join(os.tmpdir(), "enterprise-hub-source-download-"));
    const documentRepository = createDocumentRepository();
    const quarantineCertificateRepository = createInMemoryQuarantineCertificateRepository(
      documentRepository.documents,
      documentRepository.auditLogs
    );
    const sourceDocumentRepository = createInMemorySourceDocumentRepository(
      documentRepository.documents,
      documentRepository.auditLogs
    );
    const localStorage = new LocalFileSystemStorageAdapter({ root: storageRoot });
    const createDownloadUrl = vi.fn<StorageAdapter["createDownloadUrl"]>(
      async () => "https://download.example.test/source"
    );
    const storageAdapter: StorageAdapter = {
      putObject: localStorage.putObject.bind(localStorage),
      getObjectStream: localStorage.getObjectStream.bind(localStorage),
      statObject: localStorage.statObject.bind(localStorage),
      createDownloadUrl,
      deleteObject: localStorage.deleteObject.bind(localStorage)
    };

    app = buildApiServer({
      employeeRepository: createRepository([baoliManagerEmployee]),
      documentRepository,
      quarantineCertificateRepository,
      sourceDocumentRepository,
      storageAdapter,
      cursorSigningSecret: jwtSecret,
      authenticateAccessToken: authenticateTestAccessToken,
      logger: false
    });

    return { app, createDownloadUrl };
  }

  async function uploadCertificate(server: FastifyInstance) {
    const multipart = createMultipartPayload([
      {
        name: "file",
        fileName: "quarantine.png",
        contentType: "image/png",
        value: pngBytes
      },
      { name: "receiptId", value: "SH2608250117" },
      { name: "labelKeys[]", value: "store:baoli" },
      { name: "idempotencyKey", value: "idem-download" }
    ]);

    return server.inject({
      method: "POST",
      url: "/v1/documents/quarantine-certificates",
      headers: {
        authorization: `Bearer ${await accessTokenFor(baoliManagerEmployee)}`,
        "content-type": multipart.contentType
      },
      payload: multipart.body
    });
  }

  it("issues a 24-hour attachment download URL for an authorized source document", async () => {
    const { app, createDownloadUrl } = await buildDownloadTestServer();
    const upload = await uploadCertificate(app);

    const response = await app.inject({
      method: "POST",
      url: `/v1/source-documents/${upload.json().sourceDocumentId}/download-url`,
      headers: {
        authorization: `Bearer ${await accessTokenFor(baoliManagerEmployee)}`
      }
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      sourceDocumentId: upload.json().sourceDocumentId,
      downloadUrl: "https://download.example.test/source",
      originalFileName: "quarantine.png",
      contentType: "image/png",
      byteSize: pngBytes.byteLength
    });
    expect(Date.parse(response.json().expiresAt)).toBeGreaterThan(Date.now() + 86_000_000);
    expect(createDownloadUrl).toHaveBeenCalledWith(expect.any(String), {
      expiresInSeconds: 86_400,
      downloadFileName: "quarantine.png"
    });
  });
});
