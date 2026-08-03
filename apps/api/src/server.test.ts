import { mkdtemp, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import ExcelJS from "exceljs";
import type { FastifyInstance } from "fastify";
import type {
  AuthenticatedEmployee,
  DocumentStatusName,
  DocumentTypeName,
  Phase3FileType,
  StructuredDatasetName
} from "@enterprise-hub/domain";
import { AUDIT_ACTIONS, getStructuredRegistry } from "@enterprise-hub/domain";
import { LocalFileSystemStorageAdapter, type StorageAdapter } from "@enterprise-hub/storage";
import { buildApiServer } from "./server.js";
import type { DocumentCatalogRepository } from "./documents.js";
import type { EmployeeRepository } from "./employees.js";
import type { EvidenceSearchRepository } from "./evidence.js";
import type { RequestAuditContext } from "./request-audit-context.js";
import type { SkillDirectoryRepository, SkillDirectoryEntry } from "./skills.js";

const jwtSecret = "test-local-jwt-secret";
const officialTestTokens = new Map<string, AuthenticatedEmployee>();

async function authenticateTestAccessToken(token: string) {
  return officialTestTokens.get(token) ?? null;
}

const adminEmployee: AuthenticatedEmployee = {
  id: "emp_admin",
  orgId: "default-org",
  email: "admin@example.com",
  role: "admin",
  disabled: false,
  labels: ["all_staff", "person:admin", "store:baoli", "store:suzhou"]
};

const disabledEmployee: AuthenticatedEmployee = {
  id: "emp_disabled",
  orgId: "default-org",
  email: "disabled@example.com",
  role: "employee",
  disabled: true,
  labels: ["all_staff", "person:disabled"]
};

const baoliManagerEmployee: AuthenticatedEmployee = {
  id: "emp_baoli_manager",
  orgId: "default-org",
  email: "baoli.manager@example.com",
  role: "manager",
  disabled: false,
  labels: ["all_staff", "person:baoli.manager", "store:baoli"]
};

const suzhouManagerEmployee: AuthenticatedEmployee = {
  id: "emp_suzhou_manager",
  orgId: "default-org",
  email: "suzhou.manager@example.com",
  role: "manager",
  disabled: false,
  labels: ["all_staff", "person:suzhou.manager", "store:suzhou"]
};

const lijieEmployee: AuthenticatedEmployee = {
  id: "emp_lijie",
  orgId: "default-org",
  email: "lijie@example.com",
  role: "employee",
  disabled: false,
  labels: ["all_staff", "person:lijie"]
};

const orgAAdminEmployee: AuthenticatedEmployee = {
  id: "emp_org_a_admin",
  orgId: "org-a",
  email: "org-a.admin@example.com",
  role: "admin",
  disabled: false,
  labels: ["all_staff", "person:org-a.admin"]
};

const orgBAdminEmployee: AuthenticatedEmployee = {
  id: "emp_org_b_admin",
  orgId: "org-b",
  email: "org-b.admin@example.com",
  role: "admin",
  disabled: false,
  labels: ["all_staff", "person:org-b.admin"]
};

const labelLessEmployee: AuthenticatedEmployee = {
  id: "emp_label_less",
  orgId: "default-org",
  email: "label.less@example.com",
  role: "employee",
  disabled: false,
  labels: []
};

const unlabeledAdminEmployee: AuthenticatedEmployee = {
  id: "emp_unlabeled_admin",
  orgId: "default-org",
  email: "unlabeled.admin@example.com",
  role: "admin",
  disabled: false,
  labels: []
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

function createEvidenceSearchRepository(): EvidenceSearchRepository & {
  queries: Array<{ query: string; employeeId: string }>;
  inputs: Array<{
    orgId: string;
    employeeId: string;
    audit: Parameters<EvidenceSearchRepository["searchEvidence"]>[0]["audit"];
  }>;
} {
  const queries: Array<{ query: string; employeeId: string }> = [];
  const inputs: Array<{
    orgId: string;
    employeeId: string;
    audit: Parameters<EvidenceSearchRepository["searchEvidence"]>[0]["audit"];
  }> = [];

  return {
    queries,
    inputs,
    async searchEvidence(input) {
      queries.push({ query: input.query, employeeId: input.employee.id });
      inputs.push({ orgId: input.orgId, employeeId: input.employee.id, audit: input.audit });

      return {
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
            score: {
              hybrid: 0.82,
              rerank: 0.91
            },
            matchedBy: ["dense", "lexical", "rerank"]
          }
        ],
        page: {
          limit: input.limit,
          nextCursor: null,
          hasMore: false
        },
        retrieval: {
          retrievalConfigVersion: "phase3.retrieval.v1",
          embeddingVersion: "fake-embedding-v1@phase3.retrieval.v1",
          lexicalIndexVersion: "lexical.v1",
          rerankVersion: "fake-rerank-v1@phase3.retrieval.v1",
          rerankStatus: "enabled"
        },
        warnings: []
      };
    }
  };
}

function createOrganizationContextDocumentRepository(): DocumentCatalogRepository & {
  labelListOrgIds: string[];
  labelLookupOrgIds: string[];
  personalLabelLookupOrgIds: string[];
  catalogWriteOrgIds: string[];
  auditWriteOrgIds: string[];
  auditListOrgIds: string[];
} {
  const base = createDocumentRepository() as DocumentCatalogRepository;
  const labelsByOrg = new Map([
    [
      "default-org",
      [
        { id: "label_default_shared", key: "same-named", name: "Shared Label", type: "store" },
        {
          id: "label_default_personal",
          key: "person:admin",
          name: "Default Personal",
          type: "personal"
        }
      ]
    ],
    [
      "org-a",
      [
        { id: "label_org_a_shared", key: "same-named", name: "Shared Label", type: "store" },
        {
          id: "label_org_a_personal",
          key: "person:org-a.admin",
          name: "Org A Personal",
          type: "personal"
        }
      ]
    ],
    [
      "org-b",
      [
        { id: "label_org_b_shared", key: "same-named", name: "Shared Label", type: "store" },
        {
          id: "label_org_b_personal",
          key: "person:org-b.admin",
          name: "Org B Personal",
          type: "personal"
        }
      ]
    ]
  ]);
  const labelLookupOrgIds: string[] = [];
  const labelListOrgIds: string[] = [];
  const personalLabelLookupOrgIds: string[] = [];
  const catalogWriteOrgIds: string[] = [];
  const auditWriteOrgIds: string[] = [];
  const auditListOrgIds: string[] = [];

  return {
    ...base,
    labelListOrgIds,
    labelLookupOrgIds,
    personalLabelLookupOrgIds,
    catalogWriteOrgIds,
    auditWriteOrgIds,
    auditListOrgIds,
    async listLabels(orgId) {
      labelListOrgIds.push(orgId);
      return labelsByOrg.get(orgId) ?? [];
    },
    async findLabelsByKeys(orgId, keys) {
      labelLookupOrgIds.push(orgId);
      return (labelsByOrg.get(orgId) ?? []).filter((label) => keys.includes(label.key));
    },
    async findPersonalLabelForEmployee(orgId, employeeId) {
      personalLabelLookupOrgIds.push(orgId);
      return (
        (labelsByOrg.get(orgId) ?? []).find((label) =>
          employeeId === orgBAdminEmployee.id
            ? label.key === "person:org-b.admin"
            : employeeId === orgAAdminEmployee.id
              ? label.key === "person:org-a.admin"
              : employeeId === adminEmployee.id && label.key === "person:admin"
        ) ?? null
      );
    },
    async createUploadedDocument(input) {
      catalogWriteOrgIds.push(input.orgId);
      auditWriteOrgIds.push(input.orgId);
      return base.createUploadedDocument(input);
    },
    async listAuditLogs(input) {
      auditListOrgIds.push(input.orgId);
      return {
        auditLogs: [
          {
            id: `audit_${input.orgId}`,
            actorEmployeeId: `employee_${input.orgId}`,
            action: "document.uploaded",
            targetType: "document",
            targetId: `document_${input.orgId}`,
            result: "succeeded",
            metadata: null,
            requestId: "request",
            clientIp: "127.0.0.1",
            clientSource: input.orgId === "org-b" ? null : "http_api",
            launcherVersion: null,
            createdAt: new Date("2026-07-18T00:00:00.000Z")
          }
        ],
        nextCursor: null
      };
    }
  };
}

function createOrganizationContextStorageAdapter(): StorageAdapter & {
  putInputs: Array<{ orgId: string; documentId: string; contentType?: string }>;
} {
  const putInputs: Array<{ orgId: string; documentId: string; contentType?: string }> = [];

  return {
    putInputs,
    async putObject(input) {
      putInputs.push({
        orgId: input.orgId,
        documentId: input.documentId,
        contentType: input.contentType
      });
      return {
        key: `org/${input.orgId}/documents/${input.documentId}/original/${input.fileName}`,
        size: Buffer.byteLength(input.body as Buffer),
        hash: "test-hash",
        contentType: input.contentType
      };
    },
    async getObjectStream() {
      throw new Error("not used by this test");
    },
    async statObject() {
      throw new Error("not used by this test");
    },
    async createDownloadUrl() {
      throw new Error("not used by this test");
    },
    async deleteObject() {}
  };
}

function buildTestServer(employees = [adminEmployee, disabledEmployee]) {
  return buildApiServer({
    employeeRepository: createRepository(employees),
    cursorSigningSecret: jwtSecret,
    authenticateAccessToken: authenticateTestAccessToken,
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
  documentKind: "evidence" | "structured" | null;
  fileType: Phase3FileType | null;
  sourceSystem: string | null;
  sourceTime: Date | null;
  storageObjectKey: string;
  originalFileName: string;
  contentType: string | null;
  byteSize: number;
  checksumSha256: string;
  labels: string[];
  processingRunStatus: string | null;
  documentIndexStatus: string | null;
  createdAt?: Date;
  sourceMetadata?: Record<string, unknown> | null;
  chunks?: string[];
}

interface RecordedProcessingRun {
  documentId: string;
  status: string;
  jobType: string;
}

interface RecordedAuditLog {
  id?: string;
  action: string;
  actorEmployeeId: string | null;
  targetType?: string;
  targetId: string | null;
  result?: string;
  metadata?: Record<string, unknown> | null;
  requestId?: string;
  clientIp?: string;
  clientSource?: string | null;
  launcherVersion?: string | null;
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
  const uploadInputs: unknown[] = [];

  return {
    documents,
    processingRuns,
    auditLogs,
    uploadInputs,
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
      input: Omit<
        RecordedDocument,
        "contentType" | "processingRunStatus" | "documentIndexStatus" | "documentKind" | "fileType"
      > & {
        contentType?: string;
        documentKind?: "evidence" | "structured";
        fileType?: Phase3FileType;
        processingJobType: string;
        audit: RequestAuditContext;
      }
    ) {
      uploadInputs.push(input);
      const document = {
        ...input,
        documentKind: input.documentKind ?? null,
        fileType: input.fileType ?? null,
        contentType: input.contentType ?? null,
        processingRunStatus: "queued",
        documentIndexStatus: null
      };
      documents.push(document);
      processingRuns.push({
        documentId: input.id,
        status: "queued",
        jobType: input.processingJobType
      });
      auditLogs.push({
        action: "document.uploaded",
        actorEmployeeId: input.uploaderId,
        targetId: input.id,
        requestId: input.audit.requestId,
        clientIp: input.audit.sourceIp,
        clientSource: input.audit.clientSource,
        launcherVersion: input.audit.launcherVersion
      });
      return document;
    },
    async findEvidenceDocumentStatus(_orgId: string, documentId: string) {
      const document = documents.find((candidate) => candidate.id === documentId);

      if (!document || document.documentKind !== "evidence") {
        return null;
      }

      return document;
    },
    async appendAuditLog(input: Parameters<DocumentCatalogRepository["appendAuditLog"]>[0]) {
      auditLogs.push({
        id: `audit_${auditLogs.length + 1}`,
        action: input.action,
        actorEmployeeId: input.actorEmployeeId,
        targetType: input.targetType,
        targetId: input.targetId,
        result: input.result,
        metadata: input.metadata,
        requestId: input.audit.requestId,
        clientIp: input.audit.sourceIp,
        clientSource: input.audit.clientSource,
        launcherVersion: input.audit.launcherVersion,
        createdAt: new Date()
      });
    },
    async archiveDocument(input: {
      orgId: string;
      documentId: string;
      actorEmployeeId: string;
      audit: RequestAuditContext;
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
        requestId: input.audit.requestId,
        clientIp: input.audit.sourceIp,
        clientSource: input.audit.clientSource,
        launcherVersion: input.audit.launcherVersion,
        createdAt: new Date()
      });

      return document;
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
          clientSource: auditLog.clientSource ?? null,
          launcherVersion: auditLog.launcherVersion ?? null,
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

function validStructuredCsv(
  dataset: StructuredDatasetName,
  overrides: Record<string, string> = {}
) {
  const registry = getStructuredRegistry(dataset);
  const values = registry.fields.map((field, index) => {
    if (overrides[field.canonicalName] !== undefined) {
      return overrides[field.canonicalName];
    }

    if (field.canonicalName === "business_date") {
      return "2026-07-02";
    }

    if (field.type === "integer") {
      return String(index + 1);
    }

    if (field.type === "decimal" || field.type === "percent") {
      return `${index + 1}.5`;
    }

    if (field.type === "date") {
      return "2026-07-02";
    }

    if (field.type === "date_time") {
      return "2026-07-02 12:30:00";
    }

    return `value_${index + 1}`;
  });

  return `${registry.fields.map((field) => field.sourceColumn).join(",")}\n${values.join(",")}\n`;
}

async function structuredWorkbook(input: {
  dataset: StructuredDatasetName;
  includeHiddenSheet?: boolean;
  includeExplanationSheet?: boolean;
  prefaceRows?: string[][];
  rowCount?: number;
  cellOverrides?: Record<string, unknown>;
}) {
  const registry = getStructuredRegistry(input.dataset);
  const workbook = new ExcelJS.Workbook();
  const headers = registry.fields.map((field) => field.sourceColumn);
  const row = registry.fields.map((field, index): unknown => {
    if (input.cellOverrides?.[field.canonicalName] !== undefined) {
      return input.cellOverrides[field.canonicalName];
    }
    if (field.canonicalName === "business_date") {
      return "2026-07-02";
    }

    if (field.type === "integer") {
      return String(index + 1);
    }

    if (field.type === "decimal" || field.type === "percent") {
      return `${index + 1}.5`;
    }

    if (field.type === "date") {
      return "2026-07-02";
    }

    if (field.type === "date_time") {
      return "2026-07-02 12:30:00";
    }

    return `value_${index + 1}`;
  });
  workbook
    .addWorksheet("Data")
    .addRows([
      ...(input.prefaceRows ?? []),
      headers,
      ...Array.from({ length: input.rowCount ?? 1 }, () => row)
    ]);

  if (input.includeHiddenSheet) {
    workbook.addWorksheet("HiddenData", { state: "hidden" }).addRows([headers, row]);
  }

  if (input.includeExplanationSheet) {
    workbook.addWorksheet("Explanation").addRows([["说明"], ["这个 sheet 不是结构化数据"]]);
  }

  return Buffer.from(await workbook.xlsx.writeBuffer());
}

function createStructuredImportMultipart(input: {
  dataset?: StructuredDatasetName;
  enterpriseName?: string;
  startDate?: string;
  endDate?: string;
  idempotencyKey?: string;
  labelKeys?: string[];
  fileName?: string;
  contentType?: string;
  body?: Buffer;
}) {
  return createMultipartPayload([
    { name: "dataset", value: input.dataset ?? "dishes" },
    { name: "enterprise_name", value: input.enterpriseName ?? "保利店" },
    { name: "startDate", value: input.startDate ?? "20260701" },
    { name: "endDate", value: input.endDate ?? "20260705" },
    { name: "idempotencyKey", value: input.idempotencyKey ?? "import-key-1" },
    ...(input.labelKeys ?? ["store:baoli"]).map((labelKey) => ({
      name: "labelKeys[]",
      value: labelKey
    })),
    {
      name: "file",
      fileName: input.fileName ?? "original-dishes.csv",
      contentType: input.contentType ?? "text/csv",
      value: input.body ?? Buffer.from(validStructuredCsv(input.dataset ?? "dishes"), "utf8")
    }
  ]);
}

async function accessTokenFor(employee: AuthenticatedEmployee) {
  const token = `eh_at_test_${employee.id}`;
  officialTestTokens.set(token, employee);
  return token;
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

  it("uses forwarded client IPs only from a loopback proxy peer", async () => {
    app = buildTestServer();
    app.get("/__test/request-audit-ip", async (request) => ({ sourceIp: request.ip }));

    const trustedProxyResponse = await app.inject({
      method: "GET",
      url: "/__test/request-audit-ip",
      remoteAddress: "127.0.0.1",
      headers: { "x-forwarded-for": "203.0.113.9" }
    });
    const forgedForwardingResponse = await app.inject({
      method: "GET",
      url: "/__test/request-audit-ip",
      remoteAddress: "198.51.100.8",
      headers: { "x-forwarded-for": "203.0.113.9" }
    });

    expect(trustedProxyResponse.json()).toEqual({ sourceIp: "203.0.113.9" });
    expect(forgedForwardingResponse.json()).toEqual({ sourceIp: "198.51.100.8" });
  });

  it("replaces invalid request IDs with bounded server-generated values", async () => {
    app = buildTestServer();

    for (const requestId of ["x".repeat(129), "invalid request id"]) {
      const response = await app.inject({
        method: "GET",
        url: "/healthz",
        headers: { "x-request-id": requestId }
      });
      const responseRequestId = response.headers["x-request-id"];

      expect(responseRequestId).toMatch(
        /^req_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
      );
      expect(Buffer.byteLength(responseRequestId as string, "utf8")).toBeLessThanOrEqual(128);
    }
  });

  it("echoes valid structured request IDs unchanged", async () => {
    app = buildTestServer();

    const response = await app.inject({
      method: "GET",
      url: "/healthz",
      headers: { "x-request-id": "req_valid-123" }
    });

    expect(response.headers["x-request-id"]).toBe("req_valid-123");
  });

  it("returns local readiness results and maps failures to 503", async () => {
    app = buildApiServer({
      employeeRepository: createRepository([adminEmployee]),
      cursorSigningSecret: jwtSecret,
      authenticateAccessToken: authenticateTestAccessToken,
      logger: false,
      readinessCheck: async () => ({
        ok: false,
        retrievalConfigVersion: "test-retrieval",
        checks: [
          {
            name: "mysql",
            ok: true,
            message: "mysql readiness check passed."
          },
          {
            name: "qdrant",
            ok: false,
            message: "Qdrant evidence collection is missing."
          }
        ]
      })
    });

    const response = await app.inject({
      method: "GET",
      url: "/readyz",
      remoteAddress: "127.0.0.1"
    });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({
      ok: false,
      service: "enterprise-hub-api",
      retrievalConfigVersion: "test-retrieval",
      checks: [
        {
          name: "mysql",
          ok: true,
          message: "mysql readiness check passed."
        },
        {
          name: "qdrant",
          ok: false,
          message: "Qdrant evidence collection is missing."
        }
      ]
    });
  });

  it("does not expose readiness to non-loopback clients", async () => {
    app = buildApiServer({
      employeeRepository: createRepository([adminEmployee]),
      cursorSigningSecret: jwtSecret,
      authenticateAccessToken: authenticateTestAccessToken,
      logger: false,
      readinessCheck: async () => {
        throw new Error("readiness should not run for non-loopback clients");
      }
    });

    const response = await app.inject({
      method: "GET",
      url: "/readyz",
      remoteAddress: "203.0.113.10"
    });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({
      error: {
        code: "NOT_FOUND",
        message: "Not found."
      }
    });
  });

  it("does not expose the removed development login endpoint", async () => {
    app = buildTestServer();

    const response = await app.inject({
      method: "POST",
      url: "/auth/dev-login",
      payload: {
        email: "admin@example.com"
      }
    });

    expect(response.statusCode).toBe(404);
  });

  it("returns the authenticated employee from /me", async () => {
    app = buildTestServer();
    const accessToken = await accessTokenFor(adminEmployee);

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

  it("keeps the authoritative organization in authenticated employee responses", async () => {
    app = buildTestServer();
    const accessToken = await accessTokenFor(adminEmployee);

    const response = await app.inject({
      method: "GET",
      url: "/me",
      headers: {
        authorization: `Bearer ${accessToken}`
      }
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      employee: {
        id: adminEmployee.id,
        orgId: "default-org"
      }
    });
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

  it("does not register removed ordinary document endpoints", async () => {
    app = buildTestServer();
    const removedEndpoints = [
      { method: "POST", url: "/documents" },
      { method: "GET", url: "/documents" },
      { method: "GET", url: "/documents/doc_removed" },
      { method: "GET", url: "/documents/doc_removed/download" },
      { method: "GET", url: "/documents/doc_removed/status" },
      { method: "POST", url: "/documents/doc_removed/archive" },
      { method: "POST", url: "/documents/doc_removed/labels" }
    ] as const;

    for (const endpoint of removedEndpoints) {
      const response = await app.inject(endpoint);
      expect(response.statusCode).toBe(404);
    }
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

  it("rejects an over-limit audit cursor before repository access", async () => {
    const documentRepository = createDocumentRepository();
    app = buildApiServer({
      employeeRepository: createRepository([adminEmployee]),
      documentRepository,
      cursorSigningSecret: jwtSecret,
      authenticateAccessToken: authenticateTestAccessToken,
      logger: false
    });

    const response = await app.inject({
      method: "GET",
      url: `/audit?cursor=${"1".repeat(4_097)}`,
      headers: {
        authorization: `Bearer ${await accessTokenFor(adminEmployee)}`
      }
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      error: { code: "INVALID_AUDIT_QUERY" }
    });
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

  it("rejects disabled employees even when the token is otherwise valid", async () => {
    app = buildTestServer();
    const accessToken = await accessTokenFor(disabledEmployee);

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

  it("requires backend authorization for every non-health Phase 3 endpoint", async () => {
    app = buildApiServer({
      employeeRepository: createRepository([adminEmployee]),
      documentRepository: createDocumentRepository(),
      evidenceRepository: createEvidenceSearchRepository(),
      cursorSigningSecret: jwtSecret,
      authenticateAccessToken: authenticateTestAccessToken,
      logger: false
    });
    const phase3Endpoints = [
      {
        method: "POST",
        url: "/v1/documents/evidence",
        headers: {
          "content-type": "multipart/form-data; boundary=phase3-auth-check"
        },
        payload: Buffer.from("--phase3-auth-check--\r\n")
      },
      {
        method: "POST",
        url: "/v1/evidence/search",
        payload: { query: "差评处理" }
      },
      {
        method: "GET",
        url: "/v1/documents/evidence/doc_auth/status"
      },
      {
        method: "POST",
        url: "/v1/structured/imports",
        headers: {
          "content-type": "multipart/form-data; boundary=phase3-auth-check"
        },
        payload: Buffer.from("--phase3-auth-check--\r\n")
      },
      {
        method: "GET",
        url: "/v1/structured/imports/imp_hidden"
      },
      {
        method: "GET",
        url: "/v1/structured/datasets"
      },
      {
        method: "POST",
        url: "/v1/structured/query",
        payload: { dataset: "dishes", select: ["business_date"] }
      }
    ] as const;

    for (const endpoint of phase3Endpoints) {
      const response = await app.inject(endpoint);

      expect(response.statusCode, `${endpoint.method} ${endpoint.url}`).toBe(401);
      expect(response.json(), `${endpoint.method} ${endpoint.url}`).toMatchObject({
        error: {
          code: "UNAUTHENTICATED"
        }
      });
    }
  });
});

describe("authenticated organization context", () => {
  let app: FastifyInstance | undefined;

  afterEach(async () => {
    await app?.close();
    app = undefined;
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

  it("keeps same-named org-A and org-B records isolated while default-org behavior remains available", async () => {
    const documentRepository = createOrganizationContextDocumentRepository();
    const evidenceRepository = createEvidenceSearchRepository();
    const skillInputs: Array<{ orgId: string }> = [];
    const skillRepository: SkillDirectoryRepository = {
      async listApprovedSkills(input) {
        skillInputs.push({ orgId: input.orgId });
        return [
          {
            id: `skill_${input.orgId}`,
            name: "same-named-skill",
            description: `Skill for ${input.orgId}`,
            version: "1.0.0",
            category: "reporting",
            inputRequirements: [],
            installInstructions: "Install it.",
            examplePrompts: [],
            status: "approved"
          }
        ];
      }
    };
    app = buildApiServer({
      employeeRepository: createRepository([adminEmployee, orgAAdminEmployee, orgBAdminEmployee]),
      documentRepository,
      evidenceRepository,
      skillRepository,
      cursorSigningSecret: jwtSecret,
      authenticateAccessToken: authenticateTestAccessToken,
      logger: false
    });

    const orgAHeaders = { authorization: `Bearer ${await accessTokenFor(orgAAdminEmployee)}` };
    const orgBHeaders = { authorization: `Bearer ${await accessTokenFor(orgBAdminEmployee)}` };
    const defaultOrgHeaders = { authorization: `Bearer ${await accessTokenFor(adminEmployee)}` };

    const orgALabels = await app.inject({ method: "GET", url: "/labels", headers: orgAHeaders });
    const orgBLabels = await app.inject({ method: "GET", url: "/labels", headers: orgBHeaders });
    const defaultOrgLabels = await app.inject({
      method: "GET",
      url: "/labels",
      headers: defaultOrgHeaders
    });
    const orgASkills = await app.inject({ method: "GET", url: "/skills", headers: orgAHeaders });
    const orgBSkills = await app.inject({ method: "GET", url: "/skills", headers: orgBHeaders });
    const defaultOrgSkills = await app.inject({
      method: "GET",
      url: "/skills",
      headers: defaultOrgHeaders
    });
    const orgAEvidenceSearch = await app.inject({
      method: "POST",
      url: "/v1/evidence/search",
      headers: orgAHeaders,
      payload: { query: "same-named evidence" }
    });
    const orgBEvidenceSearch = await app.inject({
      method: "POST",
      url: "/v1/evidence/search",
      headers: orgBHeaders,
      payload: { query: "same-named evidence" }
    });
    const defaultOrgEvidenceSearch = await app.inject({
      method: "POST",
      url: "/v1/evidence/search",
      headers: defaultOrgHeaders,
      payload: { query: "default evidence" }
    });
    const orgAAudit = await app.inject({ method: "GET", url: "/audit", headers: orgAHeaders });
    const orgBAudit = await app.inject({ method: "GET", url: "/audit", headers: orgBHeaders });
    const defaultOrgAudit = await app.inject({
      method: "GET",
      url: "/audit",
      headers: defaultOrgHeaders
    });

    expect(orgALabels.statusCode).toBe(200);
    expect(orgBLabels.statusCode).toBe(200);
    expect(defaultOrgLabels.statusCode).toBe(200);
    expect(documentRepository.labelListOrgIds).toEqual(["org-a", "org-b", "default-org"]);
    expect(orgASkills.json().skills[0].id).toBe("skill_org-a");
    expect(orgBSkills.json().skills[0].id).toBe("skill_org-b");
    expect(defaultOrgSkills.json().skills[0].id).toBe("skill_default-org");
    expect(skillInputs).toEqual([{ orgId: "org-a" }, { orgId: "org-b" }, { orgId: "default-org" }]);
    expect(orgAEvidenceSearch.statusCode).toBe(200);
    expect(orgBEvidenceSearch.statusCode).toBe(200);
    expect(defaultOrgEvidenceSearch.statusCode).toBe(200);
    expect(evidenceRepository.inputs).toEqual([
      expect.objectContaining({ orgId: "org-a", employeeId: orgAAdminEmployee.id }),
      expect.objectContaining({ orgId: "org-b", employeeId: orgBAdminEmployee.id }),
      expect.objectContaining({ orgId: "default-org", employeeId: adminEmployee.id })
    ]);
    expect(orgAAudit.json().auditEvents[0].targetId).toBe("document_org-a");
    expect(orgAAudit.json().auditEvents[0]).toMatchObject({
      requestId: "request",
      clientIp: "127.0.0.1",
      clientSource: "http_api",
      launcherVersion: null
    });
    expect(orgBAudit.json().auditEvents[0].targetId).toBe("document_org-b");
    expect(orgBAudit.json().auditEvents[0]).toMatchObject({
      requestId: "request",
      clientIp: "127.0.0.1",
      clientSource: null,
      launcherVersion: null
    });
    expect(defaultOrgAudit.json().auditEvents[0].targetId).toBe("document_default-org");
    expect(documentRepository.auditListOrgIds).toEqual(["org-a", "org-b", "default-org"]);
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
      cursorSigningSecret: jwtSecret,
      authenticateAccessToken: authenticateTestAccessToken,
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

function createInMemoryStructuredImportRepository(
  documents: RecordedDocument[],
  auditLogs: RecordedAuditLog[]
) {
  type StoredRow = {
    dataset: StructuredDatasetName;
    sourceDocumentId: string;
  };
  type StoredBatch = {
    id: string;
    orgId: string;
    dataset: StructuredDatasetName;
    startDate: string;
    endDate: string;
    idempotencyKey: string;
    requestFingerprint: string;
    status: string;
    sourceDocumentId: string;
    totalRowCount: number;
    appliedRowCount: number;
    sourceSheetSummary: unknown[];
    validationErrors: unknown[];
  };

  const batches: StoredBatch[] = [];
  const rows: StoredRow[] = [];
  const inProgressWindows = new Set<string>();
  let nextApplyFailure: Error | null = null;

  function windowKey(input: {
    dataset: StructuredDatasetName;
    startDate: string;
    endDate: string;
  }) {
    return `${input.dataset}:${input.startDate}:${input.endDate}`;
  }

  return {
    batches,
    rows,
    failNextApply(message = "simulated apply failure") {
      nextApplyFailure = new Error(message);
    },
    markWindowInProgress(input: {
      dataset: StructuredDatasetName;
      startDate: string;
      endDate: string;
    }) {
      inProgressWindows.add(windowKey(input));
    },
    storedRowCount(dataset: StructuredDatasetName) {
      return rows.filter((row) => row.dataset === dataset).length;
    },
    queryableRowCount(dataset: StructuredDatasetName) {
      const documentStatus = new Map(documents.map((document) => [document.id, document.status]));
      return rows.filter(
        (row) => row.dataset === dataset && documentStatus.get(row.sourceDocumentId) === "active"
      ).length;
    },
    async findImportBatch(orgId: string, importBatchId: string) {
      const batch = batches.find(
        (candidate) => candidate.id === importBatchId && candidate.orgId === orgId
      );

      if (!batch) {
        return null;
      }

      const sourceDocument = documents.find((document) => document.id === batch.sourceDocumentId);
      const queryableRowCount = this.queryableRowCount(batch.dataset);

      return {
        ...batch,
        sourceDocumentLabelKeys: sourceDocument?.labels ?? [],
        status: sourceDocument?.status === "archived" ? "archived" : batch.status,
        queryableRowCount,
        sourceDocumentStatus: sourceDocument?.status ?? "processing_failed",
        sourceDocumentFileType: sourceDocument?.fileType ?? "csv",
        storageObjectKey: sourceDocument?.storageObjectKey ?? "",
        originalFileName: sourceDocument?.originalFileName ?? "file"
      };
    },
    async reserveStructuredImport(input: {
      orgId: string;
      actorEmployeeId: string;
      documentId: string;
      dataset: StructuredDatasetName;
      fileType: "xlsx" | "csv";
      startDate: string;
      endDate: string;
      idempotencyKey: string;
      requestFingerprint: string;
      document: {
        title: string;
        storageObjectKey: string;
        originalFileName: string;
        contentType?: string;
        byteSize: number;
        checksumSha256: string;
        labelIds: string[];
        labels: string[];
      };
      sourceSheetSummary: unknown[];
      totalRowCount: number;
      audit: RequestAuditContext;
    }) {
      const existingIdempotencyBatch = batches.find(
        (batch) => batch.orgId === input.orgId && batch.idempotencyKey === input.idempotencyKey
      );

      if (existingIdempotencyBatch) {
        if (existingIdempotencyBatch.requestFingerprint !== input.requestFingerprint) {
          throw Object.assign(new Error("IDEMPOTENCY_KEY_CONFLICT"), {
            code: "IDEMPOTENCY_KEY_CONFLICT"
          });
        }

        return {
          state: existingIdempotencyBatch.status === "applied" ? "existing" : "resumable",
          importBatch: await this.findImportBatch(input.orgId, existingIdempotencyBatch.id)
        };
      }

      if (inProgressWindows.has(windowKey(input))) {
        throw Object.assign(new Error("IMPORT_IN_PROGRESS"), {
          code: "IMPORT_IN_PROGRESS"
        });
      }

      const existingWindowBatch = batches.find(
        (batch) =>
          batch.orgId === input.orgId &&
          batch.dataset === input.dataset &&
          batch.startDate === input.startDate &&
          batch.endDate === input.endDate &&
          batch.status === "applied"
      );

      if (existingWindowBatch) {
        throw Object.assign(new Error("ACTIVE_IMPORT_EXISTS"), {
          code: "ACTIVE_IMPORT_EXISTS"
        });
      }

      const batch: StoredBatch = {
        id: `imp_${batches.length + 1}`,
        orgId: input.orgId,
        dataset: input.dataset,
        startDate: input.startDate,
        endDate: input.endDate,
        idempotencyKey: input.idempotencyKey,
        requestFingerprint: input.requestFingerprint,
        status: "pending",
        sourceDocumentId: input.documentId,
        totalRowCount: input.totalRowCount,
        appliedRowCount: 0,
        sourceSheetSummary: input.sourceSheetSummary,
        validationErrors: []
      };
      batches.push(batch);
      documents.push({
        id: input.documentId,
        orgId: input.orgId,
        uploaderId: input.actorEmployeeId,
        status: "pending_processing",
        title: input.document.title,
        documentType: "structured_dataset",
        documentKind: "structured",
        fileType: input.fileType,
        sourceSystem: "structured_import",
        sourceTime: null,
        storageObjectKey: input.document.storageObjectKey,
        originalFileName: input.document.originalFileName,
        contentType: input.document.contentType ?? null,
        byteSize: input.document.byteSize,
        checksumSha256: input.document.checksumSha256,
        labels: input.document.labels,
        processingRunStatus: null,
        documentIndexStatus: null,
        createdAt: new Date(),
        sourceMetadata: {
          dataset: input.dataset,
          importBatchId: batch.id
        },
        chunks: []
      });
      auditLogs.push({
        action: AUDIT_ACTIONS.structuredImportStarted,
        actorEmployeeId: input.actorEmployeeId,
        targetType: "import_batch",
        targetId: batch.id,
        result: "succeeded",
        metadata: {
          dataset: input.dataset,
          startDate: input.startDate,
          endDate: input.endDate,
          rowCount: input.totalRowCount,
          sourceDocumentId: input.documentId
        },
        requestId: input.audit.requestId,
        clientIp: input.audit.sourceIp,
        clientSource: input.audit.clientSource,
        launcherVersion: input.audit.launcherVersion
      });

      return {
        state: "created",
        importBatch: await this.findImportBatch(input.orgId, batch.id)
      };
    },
    async applyReservedStructuredImport(input: {
      orgId: string;
      actorEmployeeId: string;
      importBatchId: string;
      rows: Array<{ payload: Record<string, unknown>; sourceRowNumber: number }>;
      audit: RequestAuditContext;
    }) {
      const batch = batches.find(
        (candidate) => candidate.id === input.importBatchId && candidate.orgId === input.orgId
      );
      if (!batch) throw new Error("Reserved import batch was not found.");
      if (batch.status === "applied") return this.findImportBatch(input.orgId, batch.id);
      if (nextApplyFailure) {
        const failure = nextApplyFailure;
        nextApplyFailure = null;
        throw failure;
      }
      rows.splice(
        0,
        rows.length,
        ...rows.filter((row) => row.sourceDocumentId !== batch.sourceDocumentId),
        ...input.rows.map(() => ({
          dataset: batch.dataset,
          sourceDocumentId: batch.sourceDocumentId
        }))
      );
      batch.status = "applied";
      batch.totalRowCount = input.rows.length;
      batch.appliedRowCount = input.rows.length;
      const document = documents.find((candidate) => candidate.id === batch.sourceDocumentId);
      if (!document) throw new Error("Reserved source document was not found.");
      document.status = "active";
      document.processingRunStatus = "succeeded";
      auditLogs.push({
        action: AUDIT_ACTIONS.structuredImportApplied,
        actorEmployeeId: input.actorEmployeeId,
        targetType: "import_batch",
        targetId: batch.id,
        result: "succeeded",
        metadata: {
          dataset: batch.dataset,
          startDate: batch.startDate,
          endDate: batch.endDate,
          appliedRowCount: input.rows.length,
          sourceDocumentId: batch.sourceDocumentId
        },
        requestId: input.audit.requestId,
        clientIp: input.audit.sourceIp,
        clientSource: input.audit.clientSource,
        launcherVersion: input.audit.launcherVersion
      });
      return this.findImportBatch(input.orgId, batch.id);
    },
    async markStructuredImportStorageFailure(input: {
      orgId: string;
      importBatchId: string;
      errorCode: string;
      errorSummary: string;
    }) {
      const batch = batches.find(
        (candidate) => candidate.id === input.importBatchId && candidate.orgId === input.orgId
      );
      if (!batch) throw new Error("Reserved import batch was not found.");
      batch.status = "failed";
      const document = documents.find((candidate) => candidate.id === batch.sourceDocumentId);
      if (!document) throw new Error("Reserved source document was not found.");
      document.status = "processing_failed";
      document.processingRunStatus = "failed";
      return this.findImportBatch(input.orgId, batch.id);
    }
  };
}

describe("structured imports", () => {
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

  async function buildStructuredImportTestServer(
    employees: AuthenticatedEmployee[] = [adminEmployee, baoliManagerEmployee],
    options: {
      runtimeEnv?: NodeJS.ProcessEnv;
      storageAdapter?: StorageAdapter;
      failStoragePuts?: number;
    } = {}
  ) {
    storageRoot = await mkdtemp(path.join(os.tmpdir(), "enterprise-hub-structured-import-"));
    const documentRepository = createDocumentRepository();
    const structuredImportRepository = createInMemoryStructuredImportRepository(
      documentRepository.documents,
      documentRepository.auditLogs
    );
    const localStorage = new LocalFileSystemStorageAdapter({ root: storageRoot });
    let storagePutCalls = 0;
    const delegateStorage = options.storageAdapter ?? localStorage;
    let remainingStorageFailures = options.failStoragePuts ?? 0;
    const storageAdapter: StorageAdapter = {
      async putObject(input) {
        storagePutCalls++;
        if (remainingStorageFailures > 0) {
          remainingStorageFailures--;
          throw new Error("simulated storage failure");
        }
        return delegateStorage.putObject(input);
      },
      getObjectStream: delegateStorage.getObjectStream.bind(delegateStorage),
      statObject: delegateStorage.statObject.bind(delegateStorage),
      createDownloadUrl: delegateStorage.createDownloadUrl.bind(delegateStorage),
      deleteObject: delegateStorage.deleteObject.bind(delegateStorage)
    };

    app = buildApiServer({
      employeeRepository: createRepository(employees),
      documentRepository,
      structuredImportRepository,
      storageAdapter,
      cursorSigningSecret: jwtSecret,
      authenticateAccessToken: authenticateTestAccessToken,
      logger: false,
      runtimeEnv: options.runtimeEnv
    } as Parameters<typeof buildApiServer>[0] & {
      structuredImportRepository: unknown;
    });

    return {
      app,
      documentRepository,
      structuredImportRepository,
      storagePutCalls: () => storagePutCalls
    };
  }

  async function postStructuredImport(
    server: FastifyInstance,
    input: Parameters<typeof createStructuredImportMultipart>[0] = {},
    employee: AuthenticatedEmployee = baoliManagerEmployee
  ) {
    const multipartBody = createStructuredImportMultipart(input);

    return server.inject({
      method: "POST",
      url: "/v1/structured/imports",
      headers: {
        authorization: `Bearer ${await accessTokenFor(employee)}`,
        "x-request-id": "req_http_1",
        "content-type": multipartBody.contentType
      },
      remoteAddress: "198.51.100.8",
      payload: multipartBody.body
    });
  }

  it("applies valid CSV imports as active structured documents with canonical storage names", async () => {
    const { app, documentRepository, structuredImportRepository } =
      await buildStructuredImportTestServer();

    const response = await postStructuredImport(app, {
      enterpriseName: "保利店",
      dataset: "dishes",
      idempotencyKey: "csv-success"
    });

    expect(response.statusCode).toBe(202);
    expect(response.json()).toMatchObject({
      document: {
        documentKind: "structured",
        fileType: "csv",
        status: "active",
        originalFileName: "original-dishes.csv"
      },
      importBatch: {
        dataset: "dishes",
        status: "applied",
        startDate: "20260701",
        endDate: "20260705",
        appliedRowCount: 1
      }
    });
    expect(response.json().document.storageObjectKey).toContain(
      "u4fdd_u5229_u5e97_dishes_20260701_20260705.csv"
    );
    expect(documentRepository.documents[0]).toMatchObject({
      status: "active",
      documentType: "structured_dataset",
      originalFileName: "original-dishes.csv"
    });
    expect(structuredImportRepository.queryableRowCount("dishes")).toBe(1);
    expect(documentRepository.auditLogs).toEqual([
      expect.objectContaining({
        action: "structured_import.started",
        actorEmployeeId: baoliManagerEmployee.id,
        targetType: "import_batch",
        result: "succeeded",
        requestId: "req_http_1",
        clientIp: "198.51.100.8",
        clientSource: "http_api",
        launcherVersion: null,
        metadata: {
          dataset: "dishes",
          startDate: "20260701",
          endDate: "20260705",
          rowCount: 1,
          sourceDocumentId: response.json().document.documentId
        }
      }),
      expect.objectContaining({
        action: "structured_import.applied",
        actorEmployeeId: baoliManagerEmployee.id,
        targetType: "import_batch",
        targetId: response.json().importBatch.importBatchId,
        result: "succeeded",
        requestId: "req_http_1",
        clientIp: "198.51.100.8",
        clientSource: "http_api",
        launcherVersion: null,
        metadata: {
          dataset: "dishes",
          startDate: "20260701",
          endDate: "20260705",
          appliedRowCount: 1,
          sourceDocumentId: response.json().document.documentId
        }
      })
    ]);
    expect(JSON.stringify(documentRepository.auditLogs)).not.toContain("value_1");
    expect(JSON.stringify(documentRepository.auditLogs)).not.toContain("保利店_dishes");
  });

  it("accepts structured upload metadata exactly at the public string boundaries", async () => {
    const { app, documentRepository } = await buildStructuredImportTestServer();
    const response = await postStructuredImport(app, {
      enterpriseName: "e".repeat(255),
      idempotencyKey: "i".repeat(255),
      fileName: `${"f".repeat(251)}.csv`
    });

    expect(response.statusCode).toBe(202);
    expect(documentRepository.documents[0]).toMatchObject({
      originalFileName: `${"f".repeat(251)}.csv`
    });
  });

  it.each([
    {
      name: "enterprise name",
      input: { enterpriseName: "e".repeat(256), idempotencyKey: "enterprise-too-long" }
    },
    {
      name: "idempotency key",
      input: { idempotencyKey: "i".repeat(256) }
    },
    {
      name: "filename",
      input: { fileName: `${"f".repeat(252)}.csv`, idempotencyKey: "filename-too-long" }
    },
    {
      name: "label key",
      input: { labelKeys: ["l".repeat(129)], idempotencyKey: "label-too-long" }
    },
    {
      name: "label count",
      input: {
        labelKeys: Array.from({ length: 51 }, (_, index) => `label_${index}`),
        idempotencyKey: "labels-too-many"
      }
    }
  ])("rejects structured upload $name above the public boundary", async ({ input }) => {
    const { app, documentRepository, storagePutCalls } = await buildStructuredImportTestServer();
    const response = await postStructuredImport(app, input);

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      error: { code: "INVALID_STRUCTURED_IMPORT_UPLOAD" }
    });
    expect(storagePutCalls()).toBe(0);
    expect(documentRepository.documents).toHaveLength(0);
  });

  it("finds a structured XLSX header after prefatory title rows", async () => {
    const { app } = await buildStructuredImportTestServer();

    const response = await postStructuredImport(app, {
      enterpriseName: "麦家",
      dataset: "dishes",
      idempotencyKey: "xlsx-preface-success",
      fileName: "麦家菜品记录.xlsx",
      contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      body: await structuredWorkbook({
        dataset: "dishes",
        prefaceRows: [["菜品主题数据"], ["统计时间：2026-07-01 至 2026-07-05"]]
      })
    });

    expect(response.statusCode).toBe(202);
    expect(response.json()).toMatchObject({
      importBatch: {
        dataset: "dishes",
        status: "applied",
        appliedRowCount: 1,
        sourceSheetSummary: [
          {
            name: "Data",
            headerRowNumber: 3,
            dataRowCount: 1
          }
        ]
      }
    });
  });

  it("skips explicit structured summary footer rows", async () => {
    const { app, structuredImportRepository } = await buildStructuredImportTestServer();
    const registry = getStructuredRegistry("business");
    const footer = ["合计", ...registry.fields.slice(1).map(() => "--")].join(",");

    const response = await postStructuredImport(app, {
      enterpriseName: "麦家",
      dataset: "business",
      idempotencyKey: "csv-summary-footer-success",
      fileName: "business.csv",
      contentType: "text/csv",
      body: Buffer.from(`${validStructuredCsv("business")}${footer}\n`, "utf8")
    });

    expect(response.statusCode).toBe(202);
    expect(response.json()).toMatchObject({
      importBatch: {
        dataset: "business",
        status: "applied",
        appliedRowCount: 1,
        totalRowCount: 1
      }
    });
    expect(structuredImportRepository.queryableRowCount("business")).toBe(1);
  });

  it("handles import idempotency and active/in-progress window conflicts", async () => {
    const { app, documentRepository, structuredImportRepository, storagePutCalls } =
      await buildStructuredImportTestServer();

    const firstResponse = await postStructuredImport(app, {
      idempotencyKey: "stable-key"
    });
    const replayResponse = await postStructuredImport(app, {
      idempotencyKey: "stable-key"
    });
    const conflictResponse = await postStructuredImport(app, {
      idempotencyKey: "stable-key",
      body: Buffer.from(validStructuredCsv("dishes", { business_date: "2026-07-03" }), "utf8")
    });
    const activeWindowResponse = await postStructuredImport(app, {
      idempotencyKey: "new-key-same-window"
    });

    structuredImportRepository.markWindowInProgress({
      dataset: "business",
      startDate: "20260701",
      endDate: "20260705"
    });
    const inProgressWindowResponse = await postStructuredImport(app, {
      dataset: "business",
      idempotencyKey: "business-window",
      body: Buffer.from(validStructuredCsv("business"), "utf8")
    });

    expect(firstResponse.statusCode).toBe(202);
    expect(replayResponse.statusCode).toBe(202);
    expect(replayResponse.json().importBatch.importBatchId).toBe(
      firstResponse.json().importBatch.importBatchId
    );
    expect(replayResponse.json().document).toEqual(firstResponse.json().document);
    expect(conflictResponse.statusCode).toBe(409);
    expect(conflictResponse.json()).toMatchObject({
      error: { code: "IDEMPOTENCY_KEY_CONFLICT" }
    });
    expect(activeWindowResponse.statusCode).toBe(409);
    expect(activeWindowResponse.json()).toMatchObject({
      error: { code: "ACTIVE_IMPORT_EXISTS" }
    });
    expect(inProgressWindowResponse.statusCode).toBe(409);
    expect(inProgressWindowResponse.json()).toMatchObject({
      error: { code: "IMPORT_IN_PROGRESS" }
    });
    expect(storagePutCalls()).toBe(1);
    expect(documentRepository.documents).toHaveLength(1);
    expect(structuredImportRepository.batches).toHaveLength(1);
    expect(structuredImportRepository.rows).toHaveLength(1);
    expect(
      documentRepository.auditLogs.filter(
        (auditLog) => auditLog.action === AUDIT_ACTIONS.structuredImportStarted
      )
    ).toHaveLength(1);
    expect(
      documentRepository.auditLogs.filter(
        (auditLog) => auditLog.action === AUDIT_ACTIONS.structuredImportApplied
      )
    ).toHaveLength(1);
  });

  it("reuses the reserved document and object key after a transient storage failure", async () => {
    const { app, documentRepository, structuredImportRepository, storagePutCalls } =
      await buildStructuredImportTestServer(undefined, { failStoragePuts: 1 });

    const first = await postStructuredImport(app, { idempotencyKey: "storage-recovery" });
    expect(first.statusCode).toBe(500);
    expect(documentRepository.documents).toHaveLength(1);
    expect(documentRepository.documents[0]?.status).toBe("processing_failed");
    expect(structuredImportRepository.batches).toHaveLength(1);
    expect(structuredImportRepository.batches[0]?.status).toBe("failed");
    expect(structuredImportRepository.rows).toHaveLength(0);

    const replay = await postStructuredImport(app, { idempotencyKey: "storage-recovery" });
    expect(replay.statusCode).toBe(202);
    expect(replay.json().document.documentId).toBe(documentRepository.documents[0]?.id);
    expect(replay.json().document.storageObjectKey).toBe(
      documentRepository.documents[0]?.storageObjectKey
    );
    expect(storagePutCalls()).toBe(2);
    expect(documentRepository.documents).toHaveLength(1);
    expect(structuredImportRepository.batches).toHaveLength(1);
    expect(structuredImportRepository.rows).toHaveLength(1);
    expect(
      documentRepository.auditLogs.filter(
        (auditLog) => auditLog.action === AUDIT_ACTIONS.structuredImportStarted
      )
    ).toHaveLength(1);
    expect(
      documentRepository.auditLogs.filter(
        (auditLog) => auditLog.action === AUDIT_ACTIONS.structuredImportApplied
      )
    ).toHaveLength(1);
  });

  it("keeps the reserved object referenced and deterministically resumes after DB apply failure", async () => {
    const { app, documentRepository, structuredImportRepository, storagePutCalls } =
      await buildStructuredImportTestServer();
    structuredImportRepository.failNextApply("simulated transactional audit failure");

    const first = await postStructuredImport(app, { idempotencyKey: "apply-recovery" });
    expect(first.statusCode).toBe(500);
    expect(documentRepository.documents).toHaveLength(1);
    expect(documentRepository.documents[0]?.status).toBe("pending_processing");
    expect(structuredImportRepository.batches[0]?.status).toBe("pending");
    expect(structuredImportRepository.rows).toHaveLength(0);
    expect(await storedObjectCount(storageRoot)).toBe(1);

    const replay = await postStructuredImport(app, { idempotencyKey: "apply-recovery" });
    expect(replay.statusCode).toBe(202);
    expect(replay.json().document.documentId).toBe(documentRepository.documents[0]?.id);
    expect(storagePutCalls()).toBe(2);
    expect(await storedObjectCount(storageRoot)).toBe(1);
    expect(documentRepository.documents).toHaveLength(1);
    expect(structuredImportRepository.batches).toHaveLength(1);
    expect(structuredImportRepository.rows).toHaveLength(1);
  });

  it("rejects invalid files atomically and fails hidden or explanation workbook sheets", async () => {
    const { app, structuredImportRepository } = await buildStructuredImportTestServer();

    const invalidCsvResponse = await postStructuredImport(app, {
      idempotencyKey: "invalid-csv",
      body: Buffer.from("未知列\nbad\n", "utf8")
    });
    const hiddenSheetResponse = await postStructuredImport(app, {
      idempotencyKey: "hidden-sheet",
      fileName: "hidden.xlsx",
      contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      body: await structuredWorkbook({ dataset: "dishes", includeHiddenSheet: true })
    });
    const explanationSheetResponse = await postStructuredImport(app, {
      idempotencyKey: "explanation-sheet",
      fileName: "explanation.xlsx",
      contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      body: await structuredWorkbook({ dataset: "dishes", includeExplanationSheet: true })
    });

    expect(invalidCsvResponse.statusCode).toBe(400);
    expect(invalidCsvResponse.json()).toMatchObject({
      error: { code: "STRUCTURED_IMPORT_VALIDATION_FAILED" }
    });
    expect(hiddenSheetResponse.statusCode).toBe(400);
    expect(hiddenSheetResponse.json()).toMatchObject({
      error: { code: "STRUCTURED_IMPORT_VALIDATION_FAILED" }
    });
    expect(explanationSheetResponse.statusCode).toBe(400);
    expect(explanationSheetResponse.json()).toMatchObject({
      error: { code: "STRUCTURED_IMPORT_VALIDATION_FAILED" }
    });
    expect(structuredImportRepository.queryableRowCount("dishes")).toBe(0);
  });

  it("does not publish malformed or over-limit CSV/XLSX imports to storage or durable repositories", async () => {
    const { app, documentRepository, structuredImportRepository, storagePutCalls } =
      await buildStructuredImportTestServer(undefined, {
        runtimeEnv: {
          MAX_STRUCTURED_IMPORT_ROWS: "1",
          MAX_STRUCTURED_CELL_CHARS: "100"
        } as NodeJS.ProcessEnv
      });
    const validCsvLines = validStructuredCsv("dishes").trim().split("\n");
    const overLimitCsv = Buffer.from(
      `${validCsvLines[0]}\n${validCsvLines[1]}\n${validCsvLines[1]}\n`,
      "utf8"
    );

    const responses = await Promise.all([
      postStructuredImport(app, {
        idempotencyKey: "atomic-malformed-csv",
        body: Buffer.from("unknown\nvalue\n", "utf8")
      }),
      postStructuredImport(app, {
        idempotencyKey: "atomic-over-limit-csv",
        body: overLimitCsv
      }),
      postStructuredImport(app, {
        idempotencyKey: "atomic-long-cell-csv",
        body: Buffer.from(validStructuredCsv("dishes", { product_name: "x".repeat(101) }), "utf8")
      }),
      postStructuredImport(app, {
        idempotencyKey: "atomic-malformed-xlsx",
        fileName: "malformed.xlsx",
        contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        body: Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00])
      }),
      postStructuredImport(app, {
        idempotencyKey: "atomic-over-limit-xlsx",
        fileName: "over-limit.xlsx",
        contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        body: await structuredWorkbook({ dataset: "dishes", rowCount: 2 })
      }),
      postStructuredImport(app, {
        idempotencyKey: "atomic-unevaluated-formula-xlsx",
        fileName: "unevaluated-formula.xlsx",
        contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        body: await structuredWorkbook({
          dataset: "dishes",
          cellOverrides: { product_name: { formula: "1+1" } }
        })
      })
    ]);

    for (const response of responses) {
      expect(response.statusCode).toBe(400);
      expect(response.json()).toMatchObject({
        error: {
          code: "STRUCTURED_IMPORT_VALIDATION_FAILED",
          message: "Structured import validation failed."
        }
      });
    }
    expect(responses[3]?.payload).not.toContain("Malformed XLSX ZIP archive");
    expect(storagePutCalls()).toBe(0);
    expect(documentRepository.documents).toHaveLength(0);
    expect(documentRepository.auditLogs).toHaveLength(0);
    expect(structuredImportRepository.batches).toHaveLength(0);
    expect(structuredImportRepository.rows).toHaveLength(0);
  });

  it("retains rows but makes them non-queryable when the source document is archived", async () => {
    const { app, documentRepository, structuredImportRepository, storagePutCalls } =
      await buildStructuredImportTestServer();
    const importResponse = await postStructuredImport(app, {
      idempotencyKey: "archive-rows"
    });
    const documentId = importResponse.json().document.documentId;

    const archivedDocument = await documentRepository.archiveDocument({
      orgId: "default-org",
      documentId,
      actorEmployeeId: baoliManagerEmployee.id,
      audit: {
        requestId: "test-request",
        sourceIp: "127.0.0.1",
        clientSource: "http_api",
        launcherVersion: null
      }
    });
    const statusResponse = await app.inject({
      method: "GET",
      url: `/v1/structured/imports/${importResponse.json().importBatch.importBatchId}`,
      headers: {
        authorization: `Bearer ${await accessTokenFor(baoliManagerEmployee)}`
      }
    });
    const replayResponse = await postStructuredImport(app, { idempotencyKey: "archive-rows" });

    expect(archivedDocument?.status).toBe("archived");
    expect(structuredImportRepository.storedRowCount("dishes")).toBe(1);
    expect(structuredImportRepository.queryableRowCount("dishes")).toBe(0);
    expect(statusResponse.json()).toMatchObject({
      importBatch: {
        status: "archived",
        totalRowCount: 1,
        queryableRowCount: 0
      }
    });
    expect(replayResponse.statusCode).toBe(202);
    expect(replayResponse.json()).toMatchObject({
      document: { documentId, status: "archived" },
      importBatch: { status: "archived", queryableRowCount: 0 }
    });
    expect(storagePutCalls()).toBe(1);
  });

  it("returns import status only to same-org callers authorized by source document labels", async () => {
    const { app } = await buildStructuredImportTestServer([
      adminEmployee,
      baoliManagerEmployee,
      suzhouManagerEmployee,
      labelLessEmployee,
      unlabeledAdminEmployee,
      disabledEmployee,
      orgBAdminEmployee
    ]);

    const matchingImport = await postStructuredImport(app, {
      idempotencyKey: "status-matching",
      labelKeys: ["store:baoli"]
    });
    const allStaffImport = await postStructuredImport(
      app,
      {
        idempotencyKey: "status-all-staff",
        dataset: "business",
        body: Buffer.from(validStructuredCsv("business"), "utf8"),
        labelKeys: ["all_staff"]
      },
      adminEmployee
    );
    const matchingBatchId = matchingImport.json().importBatch.importBatchId;
    const allStaffBatchId = allStaffImport.json().importBatch.importBatchId;

    const matching = await app.inject({
      method: "GET",
      url: `/v1/structured/imports/${matchingBatchId}`,
      headers: { authorization: `Bearer ${await accessTokenFor(baoliManagerEmployee)}` }
    });
    const allStaff = await app.inject({
      method: "GET",
      url: `/v1/structured/imports/${allStaffBatchId}`,
      headers: { authorization: `Bearer ${await accessTokenFor(labelLessEmployee)}` }
    });
    const admin = await app.inject({
      method: "GET",
      url: `/v1/structured/imports/${matchingBatchId}`,
      headers: { authorization: `Bearer ${await accessTokenFor(unlabeledAdminEmployee)}` }
    });
    const noMatch = await app.inject({
      method: "GET",
      url: `/v1/structured/imports/${matchingBatchId}`,
      headers: { authorization: `Bearer ${await accessTokenFor(suzhouManagerEmployee)}` }
    });
    const disabled = await app.inject({
      method: "GET",
      url: `/v1/structured/imports/${matchingBatchId}`,
      headers: { authorization: `Bearer ${await accessTokenFor(disabledEmployee)}` }
    });
    const crossOrg = await app.inject({
      method: "GET",
      url: `/v1/structured/imports/${matchingBatchId}`,
      headers: { authorization: `Bearer ${await accessTokenFor(orgBAdminEmployee)}` }
    });

    for (const response of [matching, allStaff, admin]) {
      expect(response.statusCode).toBe(200);
      expect(JSON.stringify(response.json())).not.toContain("sourceDocumentLabelKeys");
    }
    for (const response of [noMatch, crossOrg]) {
      expect(response.statusCode).toBe(404);
      expect(response.json()).toMatchObject({
        error: { code: "IMPORT_BATCH_NOT_FOUND", message: "Import batch not found." }
      });
      expect(JSON.stringify(response.json())).not.toMatch(
        /dataset|startDate|endDate|totalRowCount|sourceSheetSummary|validationErrors/
      );
    }
    expect(disabled.statusCode).toBe(403);
    expect(disabled.json()).toMatchObject({ error: { code: "EMPLOYEE_DISABLED" } });
  });
});

async function storedObjectCount(root: string | undefined): Promise<number> {
  if (!root) return 0;
  const entries = await readdir(root, { recursive: true, withFileTypes: true });
  return entries.filter((entry) => entry.isFile() && !entry.name.endsWith(".metadata.json")).length;
}

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
      cursorSigningSecret: jwtSecret,
      authenticateAccessToken: authenticateTestAccessToken,
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

  it("returns the menu analysis skill for a Chinese q filter without executing it", async () => {
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
