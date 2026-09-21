import { describe, expect, it, vi } from "vitest";
import type { AuthenticatedEmployee } from "@smedc/domain";
import type { StorageAdapter } from "@smedc/storage";
import {
  createSourceDocumentDownloadIssuer,
  type SourceDocumentDownloadRepository
} from "./source-document-downloads.js";

const employee: AuthenticatedEmployee = {
  id: "emp_1",
  orgId: "org_1",
  organizationName: "Test Org",
  displayName: "Employee",
  email: "employee@example.test",
  role: "employee",
  disabled: false,
  clearance: 1
};

describe("source document download issuer", () => {
  it("dedupes in stable order and issues one audited 24-hour link per authorized document", async () => {
    const recorded: unknown[] = [];
    const repository = fakeRepository(
      {
        doc_a: record("doc_a", "a.docx"),
        doc_b: record("doc_b", "b.docx")
      },
      recorded
    );
    const createDownloadUrl = vi.fn(async (key: string) => `https://download.test/${key}`);
    const issuer = createSourceDocumentDownloadIssuer({
      repository,
      storage: fakeStorage(createDownloadUrl),
      now: () => new Date("2026-09-21T00:00:00.000Z")
    });

    const result = await issuer.issueMany({
      orgId: "org_1",
      employee,
      requestedSources: [
        { sourceDocumentId: "doc_b", documentTitle: "B" },
        { sourceDocumentId: "doc_a", documentTitle: "A" },
        { sourceDocumentId: "doc_b", documentTitle: "B duplicate" }
      ],
      audit: {
        requestId: "req_1",
        sourceIp: "127.0.0.1",
        clientSource: "http_api",
        launcherVersion: null
      },
      reason: "evidence_search_auto"
    });

    expect(result.warnings).toEqual([]);
    expect(result.sources.map((source) => source.sourceDocumentId)).toEqual(["doc_b", "doc_a"]);
    expect(result.sources).toEqual([
      expect.objectContaining({
        sourceDocumentId: "doc_b",
        documentTitle: "B",
        originalFileName: "b.docx",
        downloadStatus: "available",
        downloadUrl: "https://download.test/org/org_1/doc_b",
        expiresAt: "2026-09-22T00:00:00.000Z"
      }),
      expect.objectContaining({
        sourceDocumentId: "doc_a",
        documentTitle: "A",
        downloadStatus: "available"
      })
    ]);
    expect(recorded).toEqual([
      expect.objectContaining({
        sourceDocumentIds: ["doc_b", "doc_a"],
        reason: "evidence_search_auto"
      })
    ]);
    expect(createDownloadUrl).toHaveBeenCalledTimes(2);
  });

  it("keeps healthy links when another signing call fails", async () => {
    const repository = fakeRepository({
      doc_ok: record("doc_ok", "ok.docx"),
      doc_fail: record("doc_fail", "fail.docx")
    });
    const issuer = createSourceDocumentDownloadIssuer({
      repository,
      storage: fakeStorage(async (key) => {
        if (key.endsWith("doc_fail")) throw new Error("signer unavailable");
        return `https://download.test/${key}`;
      })
    });

    const result = await issuer.issueMany(baseInput(["doc_ok", "doc_fail"]));

    expect(result.sources).toEqual([
      expect.objectContaining({ sourceDocumentId: "doc_ok", downloadStatus: "available" }),
      {
        sourceDocumentId: "doc_fail",
        documentTitle: "Title doc_fail",
        originalFileName: null,
        contentType: null,
        byteSize: null,
        downloadStatus: "unavailable",
        downloadUrl: null,
        expiresAt: null
      }
    ]);
    expect(result.warnings).toEqual(["SOURCE_DOWNLOAD_URL_UNAVAILABLE"]);
  });

  it("returns safe unavailable entries for documents rejected by the second authorization check", async () => {
    const repository = fakeRepository({});
    const createDownloadUrl = vi.fn(async () => "https://download.test/should-not-run");
    const issuer = createSourceDocumentDownloadIssuer({
      repository,
      storage: fakeStorage(createDownloadUrl)
    });

    const result = await issuer.issueMany(baseInput(["doc_archived"]));

    expect(result.sources).toEqual([
      {
        sourceDocumentId: "doc_archived",
        documentTitle: "Title doc_archived",
        originalFileName: null,
        contentType: null,
        byteSize: null,
        downloadStatus: "unavailable",
        downloadUrl: null,
        expiresAt: null
      }
    ]);
    expect(createDownloadUrl).not.toHaveBeenCalled();
    expect(result.warnings).toEqual(["SOURCE_DOWNLOAD_URL_UNAVAILABLE"]);
  });

  it("refuses automatic evidence links when the document is no longer active", async () => {
    const repository = fakeRepository({
      doc_failed: { ...record("doc_failed", "failed.docx"), status: "processing_failed" }
    });
    const createDownloadUrl = vi.fn(async () => "https://download.test/should-not-run");
    const issuer = createSourceDocumentDownloadIssuer({
      repository,
      storage: fakeStorage(createDownloadUrl)
    });

    const result = await issuer.issueMany(baseInput(["doc_failed"]));

    expect(result.sources).toEqual([
      expect.objectContaining({
        sourceDocumentId: "doc_failed",
        downloadStatus: "unavailable",
        downloadUrl: null
      })
    ]);
    expect(result.warnings).toEqual(["SOURCE_DOWNLOAD_URL_UNAVAILABLE"]);
    expect(createDownloadUrl).not.toHaveBeenCalled();
  });
});

function baseInput(documentIds: string[]) {
  return {
    orgId: "org_1",
    employee,
    requestedSources: documentIds.map((sourceDocumentId) => ({
      sourceDocumentId,
      documentTitle: `Title ${sourceDocumentId}`
    })),
    audit: {
      requestId: "req_1",
      sourceIp: "127.0.0.1",
      clientSource: "http_api" as const,
      launcherVersion: null
    },
    reason: "evidence_search_auto" as const
  };
}

function record(sourceDocumentId: string, originalFileName: string) {
  return {
    sourceDocumentId,
    orgId: "org_1",
    status: "active",
    storageObjectKey: `org/org_1/${sourceDocumentId}`,
    originalFileName,
    contentType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    byteSize: 123,
    confidentialityLevel: 0
  };
}

function fakeRepository(
  records: Record<string, ReturnType<typeof record>>,
  recorded: unknown[] = []
): SourceDocumentDownloadRepository {
  return {
    async findDownloadableSourceDocuments(input) {
      return input.sourceDocumentIds.flatMap((id) => (records[id] ? [records[id]] : []));
    },
    async recordDownloadsIssued(input) {
      recorded.push(input);
    }
  };
}

function fakeStorage(createDownloadUrl: StorageAdapter["createDownloadUrl"]): StorageAdapter {
  return {
    async putObject() {
      throw new Error("not used");
    },
    async getObjectStream() {
      throw new Error("not used");
    },
    async statObject(key) {
      return { key, size: 123, hash: "hash", contentType: "application/octet-stream" };
    },
    createDownloadUrl,
    async deleteObject() {}
  };
}
