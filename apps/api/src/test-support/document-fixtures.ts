import type {
  DocumentKindName,
  DocumentStatusName,
  DocumentTypeName,
  Phase3FileType
} from "@smedc/domain";
import type { StorageAdapter } from "@smedc/storage";
import type { DocumentCatalogRepository } from "../documents.js";
import type {
  CreateQuarantineCertificateInput,
  QuarantineCertificateRepository
} from "../quarantine-certificates.js";
import type { SourceDocumentRepository } from "../source-documents.js";
import type { RequestAuditContext } from "../request-audit-context.js";
import { canPerformPrivilegedAdministrativeOperation } from "../privileged-admin-operations.js";

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
  confidentialityLevel: number;
  processingRunStatus: string | null;
  documentIndexStatus: string | null;
  documentIndexRetrievalConfigVersion: string | null;
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
  const documents: RecordedDocument[] = [];
  const processingRuns: RecordedProcessingRun[] = [];
  const auditLogs: RecordedAuditLog[] = [];
  const uploadInputs: unknown[] = [];

  return {
    documents,
    processingRuns,
    auditLogs,
    uploadInputs,
    async createUploadedDocument(
      input: Omit<
        RecordedDocument,
        | "contentType"
        | "processingRunStatus"
        | "documentIndexStatus"
        | "documentIndexRetrievalConfigVersion"
        | "documentKind"
        | "fileType"
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
        documentIndexStatus: null,
        documentIndexRetrievalConfigVersion: null
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
      confidentialityLevel: document.confidentialityLevel,
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
        confidentialityLevel: input.confidentialityLevel,
        processingRunStatus: null,
        documentIndexStatus: null,
        documentIndexRetrievalConfigVersion: null,
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
        metadata: { receiptId: input.receiptId, confidentialityLevel: input.confidentialityLevel },
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
        .filter((certificate) => input.employee.clearance >= certificate.confidentialityLevel)
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
      if (
        document.uploaderId !== input.employee.id &&
        !canPerformPrivilegedAdministrativeOperation(
          input.employee,
          "archiveQuarantineCertificates"
        )
      ) {
        return null;
      }
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
      if (
        !canPerformPrivilegedAdministrativeOperation(
          input.employee,
          "archiveQuarantineCertificates"
        )
      ) {
        return 0;
      }
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
    async findDownloadableSourceDocuments(input) {
      if (input.employee.disabled) return [];
      const requested = new Set(input.sourceDocumentIds);
      return documents
        .filter(
          (document) =>
            requested.has(document.id) &&
            document.orgId === input.orgId &&
            ["pending_processing", "processing", "active", "processing_failed"].includes(
              document.status
            ) &&
            input.employee.clearance >= document.confidentialityLevel
        )
        .map((document) => ({
          sourceDocumentId: document.id,
          orgId: document.orgId,
          status: document.status,
          storageObjectKey: document.storageObjectKey,
          originalFileName: document.originalFileName,
          contentType: document.contentType,
          byteSize: document.byteSize,
          confidentialityLevel: document.confidentialityLevel
        }));
    },
    async recordDownloadsIssued(input) {
      for (const sourceDocumentId of new Set(input.sourceDocumentIds)) {
        auditLogs.push({
          action: "document.downloaded",
          actorEmployeeId: input.employee.id,
          targetType: "document",
          targetId: sourceDocumentId,
          result: "succeeded",
          metadata: { reason: input.reason },
          requestId: input.audit.requestId,
          clientIp: input.audit.sourceIp,
          clientSource: input.audit.clientSource,
          launcherVersion: input.audit.launcherVersion,
          createdAt: new Date()
        });
      }
    }
  };
}

export function createOrganizationContextDocumentRepository(): DocumentCatalogRepository & {
  catalogWriteOrgIds: string[];
  auditWriteOrgIds: string[];
} {
  const base = createDocumentRepository() as DocumentCatalogRepository;
  const catalogWriteOrgIds: string[] = [];
  const auditWriteOrgIds: string[] = [];

  return {
    ...base,
    catalogWriteOrgIds,
    auditWriteOrgIds,
    async createUploadedDocument(input) {
      catalogWriteOrgIds.push(input.orgId);
      auditWriteOrgIds.push(input.orgId);
      return base.createUploadedDocument(input);
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
