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
import { canEmployeeAccessDocument } from "@enterprise-hub/domain";
import { LocalFileSystemStorageAdapter } from "@enterprise-hub/storage";
import { buildApiServer } from "./server.js";
import { signEmployeeAccessToken } from "./tokens.js";
import type { EmployeeRepository } from "./employees.js";
import type { SkillDirectoryRepository, SkillDirectoryEntry } from "./skills.js";

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

const lijieEmployee: AuthenticatedEmployee = {
  id: "emp_lijie",
  email: "lijie@example.com",
  role: "employee",
  disabled: false,
  labels: ["all_staff", "person:lijie"]
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

function createSkillRepository(entries: SkillDirectoryEntry[]): SkillDirectoryRepository {
  return {
    async listApprovedSkills(input) {
      const q = input.q?.toLowerCase() ?? null;
      return entries.filter((entry) => {
        if (entry.status !== "approved") {
          return false;
        }

        if (input.category && entry.category !== input.category) {
          return false;
        }

        if (!q) {
          return true;
        }

        return [
          entry.name,
          entry.description,
          entry.category,
          ...entry.inputRequirements,
          entry.installInstructions,
          ...entry.examplePrompts
        ]
          .join("\n")
          .toLowerCase()
          .includes(q);
      });
    }
  };
}

const skillEntries: SkillDirectoryEntry[] = [
  {
    id: "skill_weekly_store_report",
    name: "weekly-store-report",
    description: "门店周报 skill，帮助员工智能体基于已授权资料生成周报草稿。",
    version: "1.0.0",
    category: "reporting",
    inputRequirements: ["已授权的 active 经营数据", "门店标签", "目标周"],
    installInstructions: "Install the approved weekly-store-report skill in the employee agent.",
    examplePrompts: ["用保利店上周经营数据生成周报草稿"],
    status: "approved"
  },
  {
    id: "skill_menu_gross_margin_analysis",
    name: "menu-gross-margin-analysis",
    description: "菜单毛利分析 skill，帮助员工智能体分析菜品毛利和菜单结构。",
    version: "1.0.0",
    category: "menu-analysis",
    inputRequirements: ["已授权的菜单数据", "菜品成本数据", "销售明细"],
    installInstructions:
      "Install the approved menu-gross-margin-analysis skill in the employee agent.",
    examplePrompts: ["分析最近三个月菜单毛利，找出需要调整的菜品"],
    status: "approved"
  },
  {
    id: "skill_disabled",
    name: "disabled-skill",
    description: "Disabled internal experiment.",
    version: "0.1.0",
    category: "internal",
    inputRequirements: [],
    installInstructions: "Do not install.",
    examplePrompts: [],
    status: "disabled"
  }
];

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
  createdAt?: Date;
  sourceMetadata?: Record<string, unknown> | null;
  chunks?: string[];
}

interface RecordedProcessingRun {
  documentId: string;
  status: string;
}

interface RecordedAuditLog {
  id?: string;
  action: string;
  actorEmployeeId: string;
  targetType?: string;
  targetId: string | null;
  result?: string;
  metadata?: Record<string, unknown>;
  requestId?: string;
  clientIp?: string;
  createdAt?: Date;
}

function createDocumentRepository() {
  const labelCatalog = new Map([
    [
      "all_staff",
      { id: "label_all_staff", key: "all_staff", name: "All Staff", type: "all_staff" }
    ],
    [
      "store:baoli",
      { id: "label_store_baoli", key: "store:baoli", name: "Baoli Store", type: "store" }
    ],
    [
      "store:suzhou",
      { id: "label_store_suzhou", key: "store:suzhou", name: "Suzhou Store", type: "store" }
    ],
    [
      "person:baoli.manager",
      {
        id: "label_person_baoli_manager",
        key: "person:baoli.manager",
        name: "Baoli Manager Personal",
        type: "personal"
      }
    ],
    [
      "person:suzhou.manager",
      {
        id: "label_person_suzhou_manager",
        key: "person:suzhou.manager",
        name: "Suzhou Manager Personal",
        type: "personal"
      }
    ],
    [
      "person:lijie",
      {
        id: "label_person_lijie",
        key: "person:lijie",
        name: "Li Jie Personal",
        type: "personal"
      }
    ],
    [
      "person:admin",
      {
        id: "label_person_admin",
        key: "person:admin",
        name: "Admin Personal",
        type: "personal"
      }
    ]
  ]);
  const documents: RecordedDocument[] = [];
  const processingRuns: RecordedProcessingRun[] = [];
  const auditLogs: RecordedAuditLog[] = [];

  return {
    documents,
    processingRuns,
    auditLogs,
    async listLabels() {
      return [...labelCatalog.values()].sort(
        (first, second) =>
          first.type.localeCompare(second.type) || first.key.localeCompare(second.key)
      );
    },
    async findLabelsByKeys(_orgId: string, keys: string[]) {
      return keys
        .map((key) => labelCatalog.get(key))
        .filter((label): label is { id: string; key: string; name: string; type: string } =>
          Boolean(label)
        );
    },
    async findPersonalLabelForEmployee(_orgId: string, employeeId: string) {
      if (employeeId === baoliManagerEmployee.id) {
        return labelCatalog.get("person:baoli.manager") ?? null;
      }

      if (employeeId === suzhouManagerEmployee.id) {
        return labelCatalog.get("person:suzhou.manager") ?? null;
      }

      if (employeeId === lijieEmployee.id) {
        return labelCatalog.get("person:lijie") ?? null;
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
    },
    async listAccessibleActiveDocuments(input: {
      employee: AuthenticatedEmployee;
      q: string | null;
      documentType: DocumentTypeName | null;
      labelKey: string | null;
      limit: number;
      cursor: string | null;
    }) {
      const offset = input.cursor ? Number.parseInt(input.cursor, 10) : 0;
      const matchingDocuments = documents
        .filter((document) => document.status === "active")
        .filter((document) => documentMatchesEmployee(document, input.employee))
        .filter((document) => !input.documentType || document.documentType === input.documentType)
        .filter((document) => !input.labelKey || document.labels.includes(input.labelKey))
        .filter((document) => documentMatchesKeyword(document, input.q))
        .sort(compareDocuments);
      const page = matchingDocuments.slice(offset, offset + input.limit);

      return {
        documents: page.map(withDefaultCreatedAt),
        nextCursor:
          matchingDocuments.length > offset + input.limit ? String(offset + input.limit) : null
      };
    },
    async findAccessibleActiveDocument(
      _orgId: string,
      documentId: string,
      employee: AuthenticatedEmployee
    ) {
      const document = documents.find((candidate) => candidate.id === documentId);

      if (
        !document ||
        document.status !== "active" ||
        !documentMatchesEmployee(document, employee)
      ) {
        return null;
      }

      return withDefaultCreatedAt(document);
    },
    async appendDocumentQueryAudit(input: {
      employeeId: string;
      q: string | null;
      documentType: DocumentTypeName | null;
      labelKey: string | null;
      resultCount: number;
    }) {
      auditLogs.push({
        action: "document.queried",
        actorEmployeeId: input.employeeId,
        targetId: null,
        metadata: {
          q: input.q,
          documentType: input.documentType,
          labelKey: input.labelKey,
          resultCount: input.resultCount
        }
      });
    },
    async appendDocumentDownloadAudit(input: { employeeId: string; documentId: string }) {
      auditLogs.push({
        action: "document.downloaded",
        actorEmployeeId: input.employeeId,
        targetId: input.documentId,
        metadata: {
          documentId: input.documentId
        }
      });
    },
    async archiveDocument(input: {
      documentId: string;
      actorEmployeeId: string;
      requestId: string;
      clientIp: string;
    }) {
      const document = documents.find((candidate) => candidate.id === input.documentId);

      if (!document) {
        return null;
      }

      const previousStatus = document.status;
      document.status = "archived";
      auditLogs.push({
        id: `audit_${auditLogs.length + 1}`,
        action: "document.archived",
        actorEmployeeId: input.actorEmployeeId,
        targetType: "document",
        targetId: input.documentId,
        result: "succeeded",
        metadata: {
          previousStatus
        },
        requestId: input.requestId,
        clientIp: input.clientIp,
        createdAt: new Date()
      });

      return withDefaultCreatedAt(document);
    },
    async addDocumentLabels(input: {
      documentId: string;
      actorEmployeeId: string;
      labelKeys: string[];
      requestId: string;
      clientIp: string;
    }) {
      const document = documents.find((candidate) => candidate.id === input.documentId);

      if (!document) {
        return null;
      }

      document.labels = [...new Set([...document.labels, ...input.labelKeys])].sort();
      auditLogs.push({
        id: `audit_${auditLogs.length + 1}`,
        action: "document.labels_added",
        actorEmployeeId: input.actorEmployeeId,
        targetType: "document",
        targetId: input.documentId,
        result: "succeeded",
        metadata: {
          labelKeys: input.labelKeys
        },
        requestId: input.requestId,
        clientIp: input.clientIp,
        createdAt: new Date()
      });

      return withDefaultCreatedAt(document);
    },
    async listAuditLogs(input: { limit: number; cursor: string | null }) {
      const offset = input.cursor ? Number.parseInt(input.cursor, 10) : 0;
      const orderedAuditLogs = auditLogs
        .map((auditLog, index) => ({
          id: auditLog.id ?? `audit_${index + 1}`,
          actorEmployeeId: auditLog.actorEmployeeId,
          action: auditLog.action,
          targetType: auditLog.targetType ?? "document",
          targetId: auditLog.targetId,
          result: auditLog.result ?? "succeeded",
          metadata: auditLog.metadata ?? null,
          requestId: auditLog.requestId ?? null,
          clientIp: auditLog.clientIp ?? null,
          createdAt: auditLog.createdAt ?? new Date(index)
        }))
        .sort((first, second) => {
          const timeDifference = second.createdAt.getTime() - first.createdAt.getTime();

          if (timeDifference !== 0) {
            return timeDifference;
          }

          return second.id.localeCompare(first.id);
        });
      const page = orderedAuditLogs.slice(offset, offset + input.limit);

      return {
        auditLogs: page,
        nextCursor:
          orderedAuditLogs.length > offset + input.limit ? String(offset + input.limit) : null
      };
    }
  };
}

function activeDocument(
  input: Partial<RecordedDocument> & Pick<RecordedDocument, "id" | "title" | "labels">
): RecordedDocument {
  return {
    orgId: "default-org",
    uploaderId: baoliManagerEmployee.id,
    status: "active",
    documentType: "raw_material",
    sourceSystem: "meituan",
    sourceTime: new Date("2026-06-30T00:00:00.000Z"),
    storageObjectKey: `org/default-org/documents/${input.id}/original/${input.id}.csv`,
    originalFileName: `${input.id}.csv`,
    contentType: "text/csv",
    byteSize: 24,
    checksumSha256: "hash",
    processingRunStatus: "succeeded",
    createdAt: new Date("2026-06-30T01:00:00.000Z"),
    sourceMetadata: null,
    chunks: [],
    ...input
  };
}

function documentMatchesEmployee(document: RecordedDocument, employee: AuthenticatedEmployee) {
  if (employee.role === "admin") {
    return true;
  }

  return canEmployeeAccessDocument({
    employee: {
      disabled: employee.disabled,
      labelKeys: employee.labels
    },
    document: {
      labelKeys: document.labels
    }
  });
}

function documentMatchesKeyword(document: RecordedDocument, q: string | null) {
  const keyword = q?.trim().toLowerCase();

  if (!keyword) {
    return true;
  }

  return [
    document.title,
    document.sourceSystem,
    document.originalFileName,
    JSON.stringify(document.sourceMetadata ?? {}),
    ...(document.chunks ?? [])
  ]
    .filter((value): value is string => Boolean(value))
    .join("\n")
    .toLowerCase()
    .includes(keyword);
}

function compareDocuments(first: RecordedDocument, second: RecordedDocument) {
  const firstSourceTime = first.sourceTime?.getTime() ?? 0;
  const secondSourceTime = second.sourceTime?.getTime() ?? 0;

  if (firstSourceTime !== secondSourceTime) {
    return secondSourceTime - firstSourceTime;
  }

  const firstCreatedAt = first.createdAt?.getTime() ?? 0;
  const secondCreatedAt = second.createdAt?.getTime() ?? 0;

  if (firstCreatedAt !== secondCreatedAt) {
    return secondCreatedAt - firstCreatedAt;
  }

  return second.id.localeCompare(first.id);
}

function withDefaultCreatedAt(document: RecordedDocument) {
  return {
    ...document,
    createdAt: document.createdAt ?? new Date("2026-06-30T00:00:00.000Z"),
    sourceMetadata: document.sourceMetadata ?? null
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

describe("label catalog", () => {
  let app: FastifyInstance | undefined;

  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  function buildLabelTestServer() {
    app = buildApiServer({
      employeeRepository: createRepository([adminEmployee, baoliManagerEmployee]),
      documentRepository: createDocumentRepository(),
      jwtSecret,
      enableDevLogin: true,
      logger: false
    });

    return app;
  }

  it("requires authentication before listing labels", async () => {
    app = buildLabelTestServer();

    const response = await app.inject({
      method: "GET",
      url: "/labels"
    });

    expect(response.statusCode).toBe(401);
    expect(response.json()).toMatchObject({
      error: {
        code: "UNAUTHENTICATED"
      }
    });
  });

  it("lists the authenticated label catalog without granting assignment rights", async () => {
    app = buildLabelTestServer();

    const response = await app.inject({
      method: "GET",
      url: "/labels",
      headers: {
        authorization: `Bearer ${await accessTokenFor(baoliManagerEmployee)}`
      }
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      labels: [
        { key: "all_staff", name: "All Staff", type: "all_staff" },
        { key: "person:admin", name: "Admin Personal", type: "personal" },
        {
          key: "person:baoli.manager",
          name: "Baoli Manager Personal",
          type: "personal"
        },
        { key: "person:lijie", name: "Li Jie Personal", type: "personal" },
        { key: "person:suzhou.manager", name: "Suzhou Manager Personal", type: "personal" },
        { key: "store:baoli", name: "Baoli Store", type: "store" },
        { key: "store:suzhou", name: "Suzhou Store", type: "store" }
      ]
    });
    expect(JSON.stringify(response.json())).not.toContain("label_");
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
        suzhouManagerEmployee,
        lijieEmployee
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

  it("keeps processing failed document status visible only to the uploader and admin", async () => {
    const { app, documentRepository } = await buildDocumentTestServer();
    documentRepository.documents.push({
      id: "doc_failed",
      orgId: "default-org",
      uploaderId: baoliManagerEmployee.id,
      status: "processing_failed",
      title: "Unsupported binary upload",
      documentType: "raw_material",
      sourceSystem: null,
      sourceTime: null,
      storageObjectKey: "org/default-org/documents/doc_failed/original/receipt.pdf",
      originalFileName: "receipt.pdf",
      contentType: "application/pdf",
      byteSize: 4,
      checksumSha256: "hash",
      labels: ["person:baoli.manager", "store:baoli"],
      processingRunStatus: "failed"
    });

    const uploaderStatus = await app.inject({
      method: "GET",
      url: "/documents/doc_failed/status",
      headers: {
        authorization: `Bearer ${await accessTokenFor(baoliManagerEmployee)}`
      }
    });
    const adminStatus = await app.inject({
      method: "GET",
      url: "/documents/doc_failed/status",
      headers: {
        authorization: `Bearer ${await accessTokenFor(adminEmployee)}`
      }
    });
    const inaccessibleStatus = await app.inject({
      method: "GET",
      url: "/documents/doc_failed/status",
      headers: {
        authorization: `Bearer ${await accessTokenFor(suzhouManagerEmployee)}`
      }
    });

    expect(uploaderStatus.statusCode).toBe(200);
    expect(uploaderStatus.json()).toMatchObject({
      id: "doc_failed",
      status: "processing_failed",
      processingRunStatus: "failed"
    });
    expect(adminStatus.statusCode).toBe(200);
    expect(inaccessibleStatus.statusCode).toBe(404);
  });

  it("lists only active documents accessible to the employee and appends query audit", async () => {
    const { app, documentRepository } = await buildDocumentTestServer();
    documentRepository.documents.push(
      activeDocument({
        id: "doc_baoli_active",
        title: "Baoli June Meituan Export",
        labels: ["store:baoli"],
        chunks: ["Baoli Meituan revenue export"]
      }),
      activeDocument({
        id: "doc_suzhou_active",
        title: "Suzhou June Meituan Export",
        labels: ["store:suzhou"],
        chunks: ["Suzhou Meituan revenue export"]
      }),
      activeDocument({
        id: "doc_baoli_pending",
        title: "Baoli Pending Meituan Export",
        labels: ["store:baoli"],
        status: "pending_processing"
      }),
      activeDocument({
        id: "doc_baoli_archived",
        title: "Baoli Archived Meituan Export",
        labels: ["store:baoli"],
        status: "archived"
      })
    );

    const response = await app.inject({
      method: "GET",
      url: "/documents?q=Meituan&limit=10",
      headers: {
        authorization: `Bearer ${await accessTokenFor(baoliManagerEmployee)}`
      }
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      documents: [
        {
          id: "doc_baoli_active",
          title: "Baoli June Meituan Export",
          status: "active",
          labels: ["store:baoli"]
        }
      ],
      nextCursor: null
    });
    expect(JSON.stringify(response.json())).not.toContain("Suzhou June Meituan Export");
    expect(documentRepository.auditLogs.at(-1)).toMatchObject({
      action: "document.queried",
      actorEmployeeId: baoliManagerEmployee.id,
      targetId: null,
      metadata: {
        resultCount: 1,
        q: "Meituan"
      }
    });
    expect(JSON.stringify(documentRepository.auditLogs.at(-1)?.metadata)).not.toContain(
      "Suzhou June Meituan Export"
    );
  });

  it("does not reveal inaccessible documents in list or detail responses", async () => {
    const { app, documentRepository } = await buildDocumentTestServer();
    documentRepository.documents.push(
      activeDocument({
        id: "doc_baoli_active",
        title: "Baoli Secret Revenue Export",
        labels: ["store:baoli"]
      })
    );
    const suzhouToken = await accessTokenFor(suzhouManagerEmployee);

    const listResponse = await app.inject({
      method: "GET",
      url: "/documents?q=Baoli",
      headers: {
        authorization: `Bearer ${suzhouToken}`
      }
    });
    const detailResponse = await app.inject({
      method: "GET",
      url: "/documents/doc_baoli_active",
      headers: {
        authorization: `Bearer ${suzhouToken}`
      }
    });

    expect(listResponse.statusCode).toBe(200);
    expect(listResponse.json()).toEqual({ documents: [], nextCursor: null });
    expect(JSON.stringify(listResponse.json())).not.toContain("Baoli Secret Revenue Export");
    expect(detailResponse.statusCode).toBe(404);
    expect(detailResponse.json()).toMatchObject({
      error: {
        code: "DOCUMENT_NOT_FOUND"
      }
    });
    expect(JSON.stringify(detailResponse.json())).not.toContain("Baoli Secret Revenue Export");
  });

  it("allows admins to list all active documents", async () => {
    const { app, documentRepository } = await buildDocumentTestServer();
    documentRepository.documents.push(
      activeDocument({
        id: "doc_baoli_active",
        title: "Baoli June Meituan Export",
        labels: ["store:baoli"],
        sourceTime: new Date("2026-06-29T00:00:00.000Z")
      }),
      activeDocument({
        id: "doc_suzhou_active",
        title: "Suzhou June Meituan Export",
        labels: ["store:suzhou"],
        sourceTime: new Date("2026-06-30T00:00:00.000Z")
      })
    );

    const response = await app.inject({
      method: "GET",
      url: "/documents",
      headers: {
        authorization: `Bearer ${await accessTokenFor(adminEmployee)}`
      }
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().documents.map((document: { id: string }) => document.id)).toEqual([
      "doc_suzhou_active",
      "doc_baoli_active"
    ]);
  });

  it("returns detail and download URL for an accessible active document", async () => {
    const { app, documentRepository, storageRoot } = await buildDocumentTestServer();
    const storedObject = await new LocalFileSystemStorageAdapter({ root: storageRoot }).putObject({
      orgId: "default-org",
      documentId: "doc_baoli_active",
      fileName: "baoli-june-meituan.csv",
      body: "date,revenue\n2026-06-01,100\n",
      contentType: "text/csv"
    });
    documentRepository.documents.push(
      activeDocument({
        id: "doc_baoli_active",
        title: "Baoli June Meituan Export",
        labels: ["store:baoli"],
        storageObjectKey: storedObject.key
      })
    );
    const accessToken = await accessTokenFor(baoliManagerEmployee);

    const detailResponse = await app.inject({
      method: "GET",
      url: "/documents/doc_baoli_active",
      headers: {
        authorization: `Bearer ${accessToken}`
      }
    });
    const downloadResponse = await app.inject({
      method: "GET",
      url: "/documents/doc_baoli_active/download",
      headers: {
        authorization: `Bearer ${accessToken}`
      }
    });

    expect(detailResponse.statusCode).toBe(200);
    expect(detailResponse.json()).toMatchObject({
      id: "doc_baoli_active",
      title: "Baoli June Meituan Export",
      status: "active",
      labels: ["store:baoli"]
    });
    expect(downloadResponse.statusCode).toBe(200);
    expect(downloadResponse.json()).toMatchObject({
      id: "doc_baoli_active",
      downloadUrl: expect.stringMatching(/^file:\/\//)
    });
    expect(documentRepository.auditLogs.at(-1)).toMatchObject({
      action: "document.downloaded",
      actorEmployeeId: baoliManagerEmployee.id,
      targetId: "doc_baoli_active"
    });
  });

  it("archives an active document without deleting storage and hides it from search", async () => {
    const { app, documentRepository, storageRoot } = await buildDocumentTestServer();
    const originalBytes = Buffer.from("date,revenue\n2026-06-01,100\n");
    const storedObject = await new LocalFileSystemStorageAdapter({ root: storageRoot }).putObject({
      orgId: "default-org",
      documentId: "doc_archive_target",
      fileName: "baoli-archive.csv",
      body: originalBytes,
      contentType: "text/csv"
    });
    documentRepository.documents.push(
      activeDocument({
        id: "doc_archive_target",
        title: "Baoli Archive Target",
        labels: ["store:baoli"],
        storageObjectKey: storedObject.key
      })
    );
    const accessToken = await accessTokenFor(baoliManagerEmployee);

    const archiveResponse = await app.inject({
      method: "POST",
      url: "/documents/doc_archive_target/archive",
      headers: {
        authorization: `Bearer ${accessToken}`
      }
    });
    const searchResponse = await app.inject({
      method: "GET",
      url: "/documents?q=Archive",
      headers: {
        authorization: `Bearer ${accessToken}`
      }
    });

    expect(archiveResponse.statusCode).toBe(200);
    expect(archiveResponse.json()).toMatchObject({
      id: "doc_archive_target",
      status: "archived"
    });
    expect(documentRepository.documents[0]?.status).toBe("archived");
    expect(searchResponse.json()).toEqual({ documents: [], nextCursor: null });
    await expect(readFile(path.join(storageRoot, storedObject.key))).resolves.toEqual(
      originalBytes
    );
    expect(
      documentRepository.auditLogs.find((auditLog) => auditLog.action === "document.archived")
    ).toMatchObject({
      action: "document.archived",
      actorEmployeeId: baoliManagerEmployee.id,
      targetId: "doc_archive_target"
    });
  });

  it("adds an existing personal label and makes the document visible to that employee", async () => {
    const { app, documentRepository } = await buildDocumentTestServer();
    documentRepository.documents.push(
      activeDocument({
        id: "doc_private_menu_report",
        title: "Private Menu Analysis Report",
        labels: ["person:baoli.manager"]
      })
    );

    const shareResponse = await app.inject({
      method: "POST",
      url: "/documents/doc_private_menu_report/labels",
      headers: {
        authorization: `Bearer ${await accessTokenFor(baoliManagerEmployee)}`
      },
      payload: {
        labelKeys: ["person:lijie"]
      }
    });
    const lijieSearchResponse = await app.inject({
      method: "GET",
      url: "/documents?q=Private",
      headers: {
        authorization: `Bearer ${await accessTokenFor(lijieEmployee)}`
      }
    });

    expect(shareResponse.statusCode).toBe(200);
    expect(shareResponse.json()).toMatchObject({
      id: "doc_private_menu_report",
      labels: ["person:baoli.manager", "person:lijie"]
    });
    expect(lijieSearchResponse.statusCode).toBe(200);
    expect(lijieSearchResponse.json().documents).toMatchObject([
      {
        id: "doc_private_menu_report",
        title: "Private Menu Analysis Report"
      }
    ]);
    expect(
      documentRepository.auditLogs.find((auditLog) => auditLog.action === "document.labels_added")
    ).toMatchObject({
      action: "document.labels_added",
      actorEmployeeId: baoliManagerEmployee.id,
      targetId: "doc_private_menu_report",
      metadata: {
        labelKeys: ["person:lijie"]
      }
    });
  });

  it("rejects unknown label additions", async () => {
    const { app, documentRepository } = await buildDocumentTestServer();
    documentRepository.documents.push(
      activeDocument({
        id: "doc_unknown_label",
        title: "Unknown Label Target",
        labels: ["person:baoli.manager"]
      })
    );

    const response = await app.inject({
      method: "POST",
      url: "/documents/doc_unknown_label/labels",
      headers: {
        authorization: `Bearer ${await accessTokenFor(baoliManagerEmployee)}`
      },
      payload: {
        labelKeys: ["person:unknown"]
      }
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      error: {
        code: "UNKNOWN_LABEL"
      }
    });
    expect(documentRepository.documents[0]?.labels).toEqual(["person:baoli.manager"]);
  });

  it("prevents non-uploader non-admin employees from changing document labels", async () => {
    const { app, documentRepository } = await buildDocumentTestServer();
    documentRepository.documents.push(
      activeDocument({
        id: "doc_all_staff_reference",
        title: "All Staff Reference",
        labels: ["all_staff"]
      })
    );

    const response = await app.inject({
      method: "POST",
      url: "/documents/doc_all_staff_reference/labels",
      headers: {
        authorization: `Bearer ${await accessTokenFor(suzhouManagerEmployee)}`
      },
      payload: {
        labelKeys: ["person:suzhou.manager"]
      }
    });

    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({
      error: {
        code: "DOCUMENT_UPDATE_FORBIDDEN"
      }
    });
    expect(documentRepository.documents[0]?.labels).toEqual(["all_staff"]);
  });

  it("returns ordered audit events to admins and denies non-admins", async () => {
    const { app, documentRepository } = await buildDocumentTestServer();
    documentRepository.auditLogs.push(
      {
        id: "audit_older",
        action: "document.queried",
        actorEmployeeId: baoliManagerEmployee.id,
        targetType: "document_query",
        targetId: null,
        result: "succeeded",
        metadata: { resultCount: 1 },
        createdAt: new Date("2026-06-30T01:00:00.000Z")
      },
      {
        id: "audit_newer",
        action: "document.archived",
        actorEmployeeId: adminEmployee.id,
        targetType: "document",
        targetId: "doc_old",
        result: "succeeded",
        metadata: { previousStatus: "active" },
        createdAt: new Date("2026-06-30T02:00:00.000Z")
      }
    );

    const nonAdminResponse = await app.inject({
      method: "GET",
      url: "/audit",
      headers: {
        authorization: `Bearer ${await accessTokenFor(baoliManagerEmployee)}`
      }
    });
    const adminResponse = await app.inject({
      method: "GET",
      url: "/audit",
      headers: {
        authorization: `Bearer ${await accessTokenFor(adminEmployee)}`
      }
    });

    expect(nonAdminResponse.statusCode).toBe(403);
    expect(nonAdminResponse.json()).toMatchObject({
      error: {
        code: "FORBIDDEN"
      }
    });
    expect(adminResponse.statusCode).toBe(200);
    expect(adminResponse.json().auditEvents.map((event: { id: string }) => event.id)).toEqual([
      "audit_newer",
      "audit_older"
    ]);
    expect(adminResponse.json().auditEvents[0]).toMatchObject({
      id: "audit_newer",
      action: "document.archived",
      actorEmployeeId: adminEmployee.id,
      targetType: "document",
      targetId: "doc_old",
      result: "succeeded",
      metadata: {
        previousStatus: "active"
      },
      createdAt: "2026-06-30T02:00:00.000Z"
    });
  });
});

describe("skill directory", () => {
  let app: FastifyInstance | undefined;

  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  function buildSkillTestServer() {
    app = buildApiServer({
      employeeRepository: createRepository([adminEmployee, baoliManagerEmployee]),
      skillRepository: createSkillRepository(skillEntries),
      jwtSecret,
      enableDevLogin: true,
      logger: false
    });

    return app;
  }

  it("requires authentication before listing skills", async () => {
    app = buildSkillTestServer();

    const response = await app.inject({
      method: "GET",
      url: "/skills"
    });

    expect(response.statusCode).toBe(401);
    expect(response.json()).toMatchObject({
      error: {
        code: "UNAUTHENTICATED"
      }
    });
  });

  it("returns the menu analysis skill for Chinese keyword search without executing it", async () => {
    app = buildSkillTestServer();

    const response = await app.inject({
      method: "GET",
      url: "/skills?q=%E8%8F%9C%E5%8D%95",
      headers: {
        authorization: `Bearer ${await accessTokenFor(baoliManagerEmployee)}`
      }
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      skills: [
        {
          id: "skill_menu_gross_margin_analysis",
          name: "menu-gross-margin-analysis",
          description: "菜单毛利分析 skill，帮助员工智能体分析菜品毛利和菜单结构。",
          version: "1.0.0",
          category: "menu-analysis",
          inputRequirements: ["已授权的菜单数据", "菜品成本数据", "销售明细"],
          installInstructions:
            "Install the approved menu-gross-margin-analysis skill in the employee agent.",
          examplePrompts: ["分析最近三个月菜单毛利，找出需要调整的菜品"],
          status: "approved"
        }
      ]
    });
    expect(JSON.stringify(response.json())).not.toContain("executionResult");
    expect(JSON.stringify(response.json())).not.toContain("Disabled internal experiment");
  });

  it("filters approved skills by category", async () => {
    app = buildSkillTestServer();

    const response = await app.inject({
      method: "GET",
      url: "/skills?category=reporting",
      headers: {
        authorization: `Bearer ${await accessTokenFor(adminEmployee)}`
      }
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().skills.map((skill: { name: string }) => skill.name)).toEqual([
      "weekly-store-report"
    ]);
    expect(JSON.stringify(response.json())).not.toContain("disabled-skill");
  });
});
