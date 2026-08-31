import type {
  DocumentKindName,
  DocumentStatusName,
  DocumentTypeName,
  Phase3FileType
} from "@enterprise-hub/domain";
import type { StorageAdapter } from "@enterprise-hub/storage";
import type { DocumentCatalogRepository } from "../documents.js";
import type {
  CreateQuarantineCertificateInput,
  QuarantineCertificateRepository
} from "../quarantine-certificates.js";
import type { SourceDocumentRepository } from "../source-documents.js";
import type { RequestAuditContext } from "../request-audit-context.js";
import {
  adminEmployee,
  baoliManagerEmployee,
  lijieEmployee,
  orgAAdminEmployee,
  orgBAdminEmployee,
  suzhouManagerEmployee
} from "./auth-fixtures.js";

export interface RecordedDocument {
  id: string;
  orgId: string;
  uploaderId: string;
  status: DocumentStatusName;
  title: string;
  documentType: DocumentTypeName;
  documentKind: DocumentKindName | null;
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

export interface RecordedProcessingRun {
  documentId: string;
  status: string;
  jobType: string;
}

export interface RecordedAuditLog {
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

export function createDocumentRepository() {
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
        documentKind?: DocumentKindName;
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

export function createInMemoryQuarantineCertificateRepository(
  documents: RecordedDocument[],
  auditLogs: RecordedAuditLog[]
): QuarantineCertificateRepository & {
  certificates: Array<{
    sourceDocumentId: string;
    orgId: string;
    receiptId: string;
    idempotencyKey: string;
    requestFingerprint: string;
    createdAt: Date;
  }>;
} {
  const certificates: Array<{
    sourceDocumentId: string;
    orgId: string;
    receiptId: string;
    idempotencyKey: string;
    requestFingerprint: string;
    createdAt: Date;
  }> = [];

  function toRecord(certificate: (typeof certificates)[number]) {
    const document = documents.find((candidate) => candidate.id === certificate.sourceDocumentId);
    if (!document) throw new Error("missing source document");

    return {
      sourceDocumentId: certificate.sourceDocumentId,
      receiptId: certificate.receiptId,
      originalFileName: document.originalFileName,
      contentType: document.contentType ?? "",
      byteSize: document.byteSize,
      uploadedAt: certificate.createdAt,
      uploaderId: document.uploaderId,
      labelKeys: [...document.labels].sort(),
      storageObjectKey: document.storageObjectKey,
      requestFingerprint: certificate.requestFingerprint
    };
  }

  return {
    certificates,
    async findByIdempotencyKey(orgId, idempotencyKey) {
      const certificate = certificates.find(
        (candidate) => candidate.orgId === orgId && candidate.idempotencyKey === idempotencyKey
      );
      return certificate ? toRecord(certificate) : null;
    },
    async createCertificate(input: CreateQuarantineCertificateInput) {
      const now = new Date();
      documents.push({
        id: input.sourceDocumentId,
        orgId: input.orgId,
        uploaderId: input.actorEmployeeId,
        status: "active",
        title: input.title,
        documentType: "raw_material",
        documentKind: "quarantine_certificate",
        fileType: input.fileType,
        sourceSystem: null,
        sourceTime: null,
        storageObjectKey: input.storageObjectKey,
        originalFileName: input.originalFileName,
        contentType: input.contentType,
        byteSize: input.byteSize,
        checksumSha256: input.checksumSha256,
        labels: [...input.labelKeys].sort(),
        processingRunStatus: null,
        documentIndexStatus: null,
        createdAt: now
      });
      const certificate = {
        sourceDocumentId: input.sourceDocumentId,
        orgId: input.orgId,
        receiptId: input.receiptId,
        idempotencyKey: input.idempotencyKey,
        requestFingerprint: input.requestFingerprint,
        createdAt: now
      };
      certificates.push(certificate);
      auditLogs.push({
        action: "document.uploaded",
        actorEmployeeId: input.actorEmployeeId,
        targetType: "quarantine_certificate",
        targetId: input.sourceDocumentId,
        result: "succeeded",
        metadata: { receiptId: input.receiptId, labelKeys: input.labelKeys },
        requestId: input.audit.requestId,
        clientIp: input.audit.sourceIp,
        clientSource: input.audit.clientSource,
        launcherVersion: input.audit.launcherVersion,
        createdAt: now
      });
      return toRecord(certificate);
    },
    async queryVisibleByReceiptIds(input) {
      return certificates
        .filter(
          (certificate) =>
            certificate.orgId === input.orgId && input.receiptIds.includes(certificate.receiptId)
        )
        .map(toRecord)
        .filter((certificate) => {
          const document = documents.find(
            (candidate) => candidate.id === certificate.sourceDocumentId
          );
          return document?.status !== "archived";
        })
        .filter((certificate) => {
          if (input.employee.role === "admin") return true;
          if (certificate.labelKeys.includes("all_staff")) return true;
          return certificate.labelKeys.some((labelKey) => input.employee.labels.includes(labelKey));
        })
        .sort((first, second) => {
          const timeDifference = second.uploadedAt.getTime() - first.uploadedAt.getTime();
          return timeDifference || second.sourceDocumentId.localeCompare(first.sourceDocumentId);
        });
    },
    async archiveBySourceDocumentId(input) {
      const certificate = certificates.find(
        (candidate) =>
          candidate.orgId === input.orgId && candidate.sourceDocumentId === input.sourceDocumentId
      );
      if (!certificate) return null;
      const document = documents.find((candidate) => candidate.id === certificate.sourceDocumentId);
      if (!document) return null;
      if (document.uploaderId !== input.employee.id && input.employee.role !== "admin") return null;
      if (document.status === "archived") return 0;
      document.status = "archived";
      auditLogs.push({
        action: "document.archived",
        actorEmployeeId: input.employee.id,
        targetType: "quarantine_certificate",
        targetId: input.sourceDocumentId,
        result: "succeeded",
        metadata: { receiptId: certificate.receiptId, mode: "sourceDocumentId" },
        requestId: input.audit.requestId,
        clientIp: input.audit.sourceIp,
        clientSource: input.audit.clientSource,
        launcherVersion: input.audit.launcherVersion,
        createdAt: new Date()
      });
      return 1;
    },
    async archiveByReceiptId(input) {
      if (input.employee.role !== "admin") return 0;
      const matching = certificates.filter(
        (certificate) =>
          certificate.orgId === input.orgId && certificate.receiptId === input.receiptId
      );
      let archivedCount = 0;
      for (const certificate of matching) {
        const document = documents.find(
          (candidate) => candidate.id === certificate.sourceDocumentId
        );
        if (document && document.status !== "archived") {
          document.status = "archived";
          archivedCount++;
        }
      }
      if (archivedCount > 0) {
        auditLogs.push({
          action: "document.archived",
          actorEmployeeId: input.employee.id,
          targetType: "quarantine_certificate",
          targetId: input.receiptId,
          result: "succeeded",
          metadata: { receiptId: input.receiptId, mode: "receiptId" },
          requestId: input.audit.requestId,
          clientIp: input.audit.sourceIp,
          clientSource: input.audit.clientSource,
          launcherVersion: input.audit.launcherVersion,
          createdAt: new Date()
        });
      }
      return archivedCount;
    }
  };
}

export function createInMemorySourceDocumentRepository(
  documents: RecordedDocument[],
  auditLogs: RecordedAuditLog[]
): SourceDocumentRepository {
  return {
    async findDownloadableSourceDocument(input) {
      const document = documents.find(
        (candidate) => candidate.id === input.sourceDocumentId && candidate.orgId === input.orgId
      );
      if (
        !document ||
        !["pending_processing", "processing", "active", "processing_failed"].includes(
          document.status
        )
      ) {
        return null;
      }
      if (input.employee.role !== "admin") {
        const visible =
          document.labels.includes("all_staff") ||
          document.labels.some((labelKey) => input.employee.labels.includes(labelKey));
        if (!visible) return null;
      }
      return {
        sourceDocumentId: document.id,
        orgId: document.orgId,
        status: document.status,
        storageObjectKey: document.storageObjectKey,
        originalFileName: document.originalFileName,
        contentType: document.contentType ?? "application/octet-stream",
        byteSize: document.byteSize,
        labelKeys: document.labels
      };
    },
    async recordDownloadIssued(input) {
      auditLogs.push({
        action: "document.downloaded",
        actorEmployeeId: input.employee.id,
        targetType: "document",
        targetId: input.sourceDocumentId,
        result: "succeeded",
        metadata: null,
        requestId: input.audit.requestId,
        clientIp: input.audit.sourceIp,
        clientSource: input.audit.clientSource,
        launcherVersion: input.audit.launcherVersion,
        createdAt: new Date()
      });
    }
  };
}

export function createOrganizationContextDocumentRepository(): DocumentCatalogRepository & {
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

export function createOrganizationContextStorageAdapter(): StorageAdapter & {
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
