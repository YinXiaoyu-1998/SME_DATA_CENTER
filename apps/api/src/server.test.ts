import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import type {
  AuthenticatedEmployee,
  DocumentStatusName,
  DocumentTypeName
} from "@enterprise-hub/domain";
import { LocalFileSystemStorageAdapter } from "@enterprise-hub/storage";
import { buildApiServer } from "./server.js";
import { signEmployeeAccessToken } from "./tokens.js";
import type { EmployeeRepository } from "./employees.js";

const jwtSecret = "test-local-jwt-secret";

const adminEmployee: AuthenticatedEmployee = {
  id: "emp_admin",
  email: "admin@example.com",
  role: "admin",
  disabled: false,
  labels: ["all_staff", "person:admin", "store:baoli", "store:suzhou"]
};

const disabledEmployee: AuthenticatedEmployee = {
  id: "emp_disabled",
  email: "disabled@example.com",
  role: "employee",
  disabled: true,
  labels: ["all_staff", "person:disabled"]
};

const baoliManagerEmployee: AuthenticatedEmployee = {
  id: "emp_baoli_manager",
  email: "baoli.manager@example.com",
  role: "manager",
  disabled: false,
  labels: ["all_staff", "person:baoli.manager", "store:baoli"]
};

const suzhouManagerEmployee: AuthenticatedEmployee = {
  id: "emp_suzhou_manager",
  email: "suzhou.manager@example.com",
  role: "manager",
  disabled: false,
  labels: ["all_staff", "person:suzhou.manager", "store:suzhou"]
};

function createRepository(employees: AuthenticatedEmployee[]): EmployeeRepository {
  return {
    async findByEmail(email: string) {
      return employees.find((employee) => employee.email === email) ?? null;
    },
    async findById(id: string) {
      return employees.find((employee) => employee.id === id) ?? null;
    }
  };
}

function buildTestServer(employees = [adminEmployee, disabledEmployee]) {
  return buildApiServer({
    employeeRepository: createRepository(employees),
    jwtSecret,
    enableDevLogin: true,
    logger: false
  });
}

interface RecordedDocument {
  id: string;
  orgId: string;
  uploaderId: string;
  status: DocumentStatusName;
  title: string;
  documentType: DocumentTypeName;
  sourceSystem: string | null;
  sourceTime: Date | null;
  storageObjectKey: string;
  originalFileName: string;
  contentType: string | null;
  byteSize: number;
  checksumSha256: string;
  labels: string[];
  processingRunStatus: string | null;
}

interface RecordedProcessingRun {
  documentId: string;
  status: string;
}

interface RecordedAuditLog {
  action: string;
  actorEmployeeId: string;
  targetId: string;
}

function createDocumentRepository() {
  const labelCatalog = new Map([
    ["all_staff", { id: "label_all_staff", key: "all_staff", type: "all_staff" }],
    ["store:baoli", { id: "label_store_baoli", key: "store:baoli", type: "store" }],
    [
      "person:baoli.manager",
      { id: "label_person_baoli_manager", key: "person:baoli.manager", type: "personal" }
    ],
    [
      "person:suzhou.manager",
      { id: "label_person_suzhou_manager", key: "person:suzhou.manager", type: "personal" }
    ],
    ["person:admin", { id: "label_person_admin", key: "person:admin", type: "personal" }]
  ]);
  const documents: RecordedDocument[] = [];
  const processingRuns: RecordedProcessingRun[] = [];
  const auditLogs: RecordedAuditLog[] = [];

  return {
    documents,
    processingRuns,
    auditLogs,
    async findLabelsByKeys(_orgId: string, keys: string[]) {
      return keys
        .map((key) => labelCatalog.get(key))
        .filter((label): label is { id: string; key: string; type: string } => Boolean(label));
    },
    async findPersonalLabelForEmployee(_orgId: string, employeeId: string) {
      if (employeeId === baoliManagerEmployee.id) {
        return labelCatalog.get("person:baoli.manager") ?? null;
      }

      if (employeeId === suzhouManagerEmployee.id) {
        return labelCatalog.get("person:suzhou.manager") ?? null;
      }

      if (employeeId === adminEmployee.id) {
        return labelCatalog.get("person:admin") ?? null;
      }

      return null;
    },
    async createUploadedDocument(
      input: Omit<RecordedDocument, "contentType" | "processingRunStatus"> & {
        contentType?: string;
      }
    ) {
      const document = {
        ...input,
        contentType: input.contentType ?? null,
        processingRunStatus: "queued"
      };
      documents.push(document);
      processingRuns.push({ documentId: input.id, status: "queued" });
      auditLogs.push({
        action: "document.uploaded",
        actorEmployeeId: input.uploaderId,
        targetId: input.id
      });
      return document;
    },
    async findDocumentStatus(_orgId: string, documentId: string) {
      const document = documents.find((candidate) => candidate.id === documentId);

      if (!document) {
        return null;
      }

      return document;
    }
  };
}

function createMultipartPayload(
  parts: Array<
    | { name: string; value: string }
    | {
        name: string;
        fileName: string;
        contentType: string;
        value: Buffer;
      }
  >
) {
  const boundary = `test-boundary-${Math.random().toString(16).slice(2)}`;
  const chunks: Buffer[] = [];

  for (const part of parts) {
    chunks.push(Buffer.from(`--${boundary}\r\n`, "utf8"));

    if ("fileName" in part) {
      chunks.push(
        Buffer.from(
          `Content-Disposition: form-data; name="${part.name}"; filename="${part.fileName}"\r\n` +
            `Content-Type: ${part.contentType}\r\n\r\n`,
          "utf8"
        )
      );
      chunks.push(part.value);
      chunks.push(Buffer.from("\r\n", "utf8"));
    } else {
      chunks.push(
        Buffer.from(
          `Content-Disposition: form-data; name="${part.name}"\r\n\r\n${part.value}\r\n`,
          "utf8"
        )
      );
    }
  }

  chunks.push(Buffer.from(`--${boundary}--\r\n`, "utf8"));

  return {
    body: Buffer.concat(chunks),
    contentType: `multipart/form-data; boundary=${boundary}`
  };
}

async function accessTokenFor(employee: AuthenticatedEmployee) {
  return signEmployeeAccessToken(employee, jwtSecret);
}

async function listFiles(root: string): Promise<string[]> {
  const entries = await readdir(root, { recursive: true, withFileTypes: true });

  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => path.join(entry.parentPath, entry.name))
    .sort();
}

describe("api auth shell", () => {
  let app: FastifyInstance | undefined;

  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  it("returns the health check response", async () => {
    app = buildTestServer();

    const response = await app.inject({
      method: "GET",
      url: "/healthz"
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      ok: true,
      service: "enterprise-hub-api"
    });
    expect(response.headers["x-request-id"]).toBeTruthy();
  });

  it("issues a development token for a seeded employee without password fields", async () => {
    app = buildTestServer();

    const response = await app.inject({
      method: "POST",
      url: "/auth/dev-login",
      payload: {
        email: "admin@example.com"
      }
    });

    const body = response.json();
    expect(response.statusCode).toBe(200);
    expect(body.accessToken).toEqual(expect.any(String));
    expect(body.employee).toEqual(adminEmployee);
    expect(JSON.stringify(body)).not.toContain("password");
  });

  it("returns the authenticated employee from /me", async () => {
    app = buildTestServer();
    const accessToken = await signEmployeeAccessToken(adminEmployee, jwtSecret);

    const response = await app.inject({
      method: "GET",
      url: "/me",
      headers: {
        authorization: `Bearer ${accessToken}`
      }
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      employee: adminEmployee
    });
  });

  it("rejects missing and invalid bearer tokens", async () => {
    app = buildTestServer();

    const missingToken = await app.inject({
      method: "GET",
      url: "/me"
    });
    const invalidToken = await app.inject({
      method: "GET",
      url: "/me",
      headers: {
        authorization: "Bearer not-a-real-token"
      }
    });

    expect(missingToken.statusCode).toBe(401);
    expect(missingToken.json()).toMatchObject({
      error: {
        code: "UNAUTHENTICATED"
      }
    });
    expect(invalidToken.statusCode).toBe(401);
    expect(invalidToken.json()).toMatchObject({
      error: {
        code: "UNAUTHENTICATED"
      }
    });
  });

  it("rejects disabled employees even when the token is otherwise valid", async () => {
    app = buildTestServer();
    const accessToken = await signEmployeeAccessToken(disabledEmployee, jwtSecret);

    const response = await app.inject({
      method: "GET",
      url: "/me",
      headers: {
        authorization: `Bearer ${accessToken}`
      }
    });

    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({
      error: {
        code: "EMPLOYEE_DISABLED"
      }
    });
  });
});

describe("document upload and status", () => {
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

  async function buildDocumentTestServer() {
    storageRoot = await mkdtemp(path.join(os.tmpdir(), "enterprise-hub-api-upload-"));
    const documentRepository = createDocumentRepository();
    const storageAdapter = new LocalFileSystemStorageAdapter({ root: storageRoot });

    app = buildApiServer({
      employeeRepository: createRepository([
        adminEmployee,
        baoliManagerEmployee,
        suzhouManagerEmployee
      ]),
      documentRepository,
      storageAdapter,
      jwtSecret,
      enableDevLogin: true,
      logger: false
    });

    return { app, documentRepository, storageRoot };
  }

  it("uploads a document, saves the original bytes, queues processing, and appends audit", async () => {
    const { app, documentRepository, storageRoot } = await buildDocumentTestServer();
    const fixture = await readFile(path.join(process.cwd(), "fixtures", "baoli-june-meituan.csv"));
    const multipart = createMultipartPayload([
      {
        name: "file",
        fileName: "baoli-june-meituan.csv",
        contentType: "text/csv",
        value: fixture
      },
      { name: "title", value: "Baoli June Meituan Export" },
      { name: "documentType", value: "raw_material" },
      { name: "sourceSystem", value: "meituan" },
      { name: "sourceTime", value: "2026-06-30T00:00:00.000Z" },
      { name: "labelKeys[]", value: "store:baoli" }
    ]);
    const accessToken = await accessTokenFor(baoliManagerEmployee);

    const response = await app.inject({
      method: "POST",
      url: "/documents",
      headers: {
        authorization: `Bearer ${accessToken}`,
        "content-type": multipart.contentType
      },
      payload: multipart.body
    });

    const body = response.json();
    expect(response.statusCode).toBe(201);
    expect(body).toMatchObject({
      id: expect.any(String),
      status: "pending_processing",
      labels: ["person:baoli.manager", "store:baoli"],
      storageObjectKey: expect.stringContaining(`/documents/${body.id}/original/`)
    });
    expect(documentRepository.documents).toHaveLength(1);
    expect(documentRepository.documents[0]).toMatchObject({
      id: body.id,
      title: "Baoli June Meituan Export",
      documentType: "raw_material",
      sourceSystem: "meituan",
      status: "pending_processing",
      labels: ["person:baoli.manager", "store:baoli"]
    });
    expect(documentRepository.processingRuns).toEqual([{ documentId: body.id, status: "queued" }]);
    expect(documentRepository.auditLogs).toEqual([
      {
        action: "document.uploaded",
        actorEmployeeId: baoliManagerEmployee.id,
        targetId: body.id
      }
    ]);

    const storedBytes = await readFile(path.join(storageRoot, body.storageObjectKey));
    expect(storedBytes).toEqual(fixture);
  });

  it("rejects unknown labels without creating a document or file", async () => {
    const { app, documentRepository, storageRoot } = await buildDocumentTestServer();
    const multipart = createMultipartPayload([
      {
        name: "file",
        fileName: "baoli-june-meituan.csv",
        contentType: "text/csv",
        value: Buffer.from("date,revenue\n2026-06-01,100\n")
      },
      { name: "title", value: "Baoli June Meituan Export" },
      { name: "documentType", value: "raw_material" },
      { name: "labelKeys[]", value: "store:unknown" }
    ]);
    const accessToken = await accessTokenFor(baoliManagerEmployee);

    const response = await app.inject({
      method: "POST",
      url: "/documents",
      headers: {
        authorization: `Bearer ${accessToken}`,
        "content-type": multipart.contentType
      },
      payload: multipart.body
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      error: {
        code: "UNKNOWN_LABEL"
      }
    });
    expect(documentRepository.documents).toHaveLength(0);
    await expect(readFile(path.join(storageRoot, "org/default-org/documents"))).rejects.toThrow();
  });

  it("rejects existing labels that the uploader is not allowed to assign", async () => {
    const { app, documentRepository, storageRoot } = await buildDocumentTestServer();
    const multipart = createMultipartPayload([
      {
        name: "file",
        fileName: "suzhou-share.csv",
        contentType: "text/csv",
        value: Buffer.from("date,revenue\n2026-06-01,100\n")
      },
      { name: "title", value: "Unauthorized Share" },
      { name: "documentType", value: "raw_material" },
      { name: "labelKeys[]", value: "person:suzhou.manager" }
    ]);
    const accessToken = await accessTokenFor(baoliManagerEmployee);

    const response = await app.inject({
      method: "POST",
      url: "/documents",
      headers: {
        authorization: `Bearer ${accessToken}`,
        "content-type": multipart.contentType
      },
      payload: multipart.body
    });

    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({
      error: {
        code: "FORBIDDEN_LABEL"
      }
    });
    expect(documentRepository.documents).toHaveLength(0);
    expect(await listFiles(storageRoot)).toEqual([]);
  });

  it("rejects all-staff labels from non-admin uploaders", async () => {
    const { app, documentRepository } = await buildDocumentTestServer();
    const multipart = createMultipartPayload([
      {
        name: "file",
        fileName: "all-staff-share.csv",
        contentType: "text/csv",
        value: Buffer.from("date,revenue\n2026-06-01,100\n")
      },
      { name: "title", value: "All Staff Share" },
      { name: "documentType", value: "raw_material" },
      { name: "labelKeys[]", value: "all_staff" }
    ]);
    const accessToken = await accessTokenFor(baoliManagerEmployee);

    const response = await app.inject({
      method: "POST",
      url: "/documents",
      headers: {
        authorization: `Bearer ${accessToken}`,
        "content-type": multipart.contentType
      },
      payload: multipart.body
    });

    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({
      error: {
        code: "FORBIDDEN_LABEL"
      }
    });
    expect(documentRepository.documents).toHaveLength(0);
  });

  it("removes the stored object when catalog creation fails after storage write", async () => {
    const { app, documentRepository, storageRoot } = await buildDocumentTestServer();
    const originalCreate = documentRepository.createUploadedDocument;
    documentRepository.createUploadedDocument = async (input) => {
      await originalCreate(input);
      throw new Error("catalog write failed");
    };
    const multipart = createMultipartPayload([
      {
        name: "file",
        fileName: "catalog-failure.csv",
        contentType: "text/csv",
        value: Buffer.from("date,revenue\n2026-06-01,100\n")
      },
      { name: "title", value: "Catalog failure" },
      { name: "documentType", value: "raw_material" },
      { name: "labelKeys[]", value: "store:baoli" }
    ]);
    const accessToken = await accessTokenFor(baoliManagerEmployee);

    const response = await app.inject({
      method: "POST",
      url: "/documents",
      headers: {
        authorization: `Bearer ${accessToken}`,
        "content-type": multipart.contentType
      },
      payload: multipart.body
    });

    expect(response.statusCode).toBe(500);
    await expect(readFile(path.join(storageRoot, "org/default-org/documents"))).rejects.toThrow();
  });

  it("adds the uploader personal label when no labels are requested", async () => {
    const { app, documentRepository } = await buildDocumentTestServer();
    const multipart = createMultipartPayload([
      {
        name: "file",
        fileName: "private-note.csv",
        contentType: "text/csv",
        value: Buffer.from("note\npersonal upload\n")
      },
      { name: "title", value: "Private note" },
      { name: "documentType", value: "management_knowledge" }
    ]);
    const accessToken = await accessTokenFor(baoliManagerEmployee);

    const response = await app.inject({
      method: "POST",
      url: "/documents",
      headers: {
        authorization: `Bearer ${accessToken}`,
        "content-type": multipart.contentType
      },
      payload: multipart.body
    });

    expect(response.statusCode).toBe(201);
    expect(response.json()).toMatchObject({
      status: "pending_processing",
      labels: ["person:baoli.manager"]
    });
    expect(documentRepository.documents[0]?.labels).toEqual(["person:baoli.manager"]);
  });

  it("returns document status to the uploader and admin but hides it from other employees", async () => {
    const { app } = await buildDocumentTestServer();
    const multipart = createMultipartPayload([
      {
        name: "file",
        fileName: "baoli-june-meituan.csv",
        contentType: "text/csv",
        value: Buffer.from("date,revenue\n2026-06-01,100\n")
      },
      { name: "title", value: "Baoli June Meituan Export" },
      { name: "documentType", value: "raw_material" },
      { name: "labelKeys[]", value: "store:baoli" }
    ]);
    const uploaderToken = await accessTokenFor(baoliManagerEmployee);
    const uploadResponse = await app.inject({
      method: "POST",
      url: "/documents",
      headers: {
        authorization: `Bearer ${uploaderToken}`,
        "content-type": multipart.contentType
      },
      payload: multipart.body
    });
    const documentId = uploadResponse.json().id as string;

    const uploaderStatus = await app.inject({
      method: "GET",
      url: `/documents/${documentId}/status`,
      headers: {
        authorization: `Bearer ${uploaderToken}`
      }
    });
    const adminStatus = await app.inject({
      method: "GET",
      url: `/documents/${documentId}/status`,
      headers: {
        authorization: `Bearer ${await accessTokenFor(adminEmployee)}`
      }
    });
    const inaccessibleStatus = await app.inject({
      method: "GET",
      url: `/documents/${documentId}/status`,
      headers: {
        authorization: `Bearer ${await accessTokenFor(suzhouManagerEmployee)}`
      }
    });

    expect(uploaderStatus.statusCode).toBe(200);
    expect(uploaderStatus.json()).toMatchObject({
      id: documentId,
      status: "pending_processing",
      processingRunStatus: "queued"
    });
    expect(adminStatus.statusCode).toBe(200);
    expect(inaccessibleStatus.statusCode).toBe(404);
  });
});
