import { afterEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import type { AuthenticatedEmployee } from "@smedc/domain";
import type { StorageAdapter } from "@smedc/storage";
import { buildApiServer } from "../server.js";
import type { SourceDocumentRecord } from "../source-documents.js";

const employee: AuthenticatedEmployee = {
  id: "synthetic",
  orgId: "synthetic_org",
  organizationName: "Synthetic",
  displayName: "Synthetic",
  email: "synthetic@example.test",
  role: "admin",
  disabled: false,
  clearance: 3
};
const records: SourceDocumentRecord[] = [
  {
    sourceDocumentId: "ledger_pending",
    orgId: "synthetic_org",
    status: "pending_processing",
    storageObjectKey: "synthetic/ledger",
    originalFileName: "ledger.xlsx",
    contentType: "application/octet-stream",
    byteSize: 12,
    confidentialityLevel: 0,
    importDataset: "delivery_ledger"
  },
  {
    sourceDocumentId: "vip",
    orgId: "synthetic_org",
    status: "active",
    storageObjectKey: "synthetic/vip",
    originalFileName: "vip.xlsx",
    contentType: "application/octet-stream",
    byteSize: 12,
    confidentialityLevel: 0,
    importDataset: "vip"
  }
];

describe("public ledger source download policy", () => {
  let app: FastifyInstance;
  afterEach(async () => {
    await app?.close();
  });
  function build(enabled: boolean) {
    const createDownloadUrl = vi.fn<StorageAdapter["createDownloadUrl"]>(
      async (key) => `https://download.test/${key}`
    );
    const storage: StorageAdapter = {
      async putObject() {
        throw new Error("unused");
      },
      async getObjectStream() {
        throw new Error("unused");
      },
      async statObject(key) {
        return { key, size: 12, hash: "synthetic", contentType: "application/octet-stream" };
      },
      createDownloadUrl,
      async deleteObject() {
        throw new Error("unused");
      }
    };
    app = buildApiServer({
      runtimeEnv: { LEDGER_PDF_DELIVERY_ENABLED: String(enabled) },
      cursorSigningSecret: "synthetic",
      logger: false,
      authenticateAccessToken: async (token) =>
        token === "admin"
          ? employee
          : token === "other"
            ? { ...employee, id: "other", orgId: "other_org" }
            : null,
      storageAdapter: storage,
      sourceDocumentRepository: {
        async findDownloadableSourceDocuments(input) {
          return records.filter(
            (record) =>
              record.orgId === input.orgId &&
              input.sourceDocumentIds.includes(record.sourceDocumentId) &&
              record.confidentialityLevel <= input.employee.clearance
          );
        },
        async recordDownloadsIssued() {}
      }
    });
    return createDownloadUrl;
  }
  function download(id: string, token?: string) {
    return app.inject({
      method: "POST",
      url: `/v1/source-documents/${id}/download-url`,
      headers: token ? { authorization: `Bearer ${token}` } : {}
    });
  }
  it("blocks ledger originals before signing, including non-applied imports", async () => {
    const sign = build(true);
    expect((await download("ledger_pending")).statusCode).toBe(401);
    expect((await download("ledger_pending", "admin")).statusCode).toBe(404);
    expect((await download("vip", "other")).statusCode).toBe(404);
    expect(sign).not.toHaveBeenCalled();
    expect((await download("vip", "admin")).statusCode).toBe(200);
    expect(sign.mock.calls.map(([key]) => key)).toEqual(["synthetic/vip"]);
  });
  it("preserves ledger original download when disabled", async () => {
    build(false);
    expect((await download("ledger_pending", "admin")).statusCode).toBe(200);
  });
});
