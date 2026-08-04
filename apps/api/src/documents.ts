import { PrismaMariaDb } from "@prisma/adapter-mariadb";
import {
  DocumentKind,
  DocumentStatus,
  DocumentType,
  FileType,
  LabelType,
  Prisma,
  PrismaClient,
  ProcessingJobType,
  ProcessingRunStatus
} from "@prisma/client";
import type {
  DocumentKindName,
  DocumentStatusName,
  Phase3FileType,
  ProcessingJobTypeName,
  DocumentTypeName
} from "@enterprise-hub/domain";
import { AUDIT_ACTIONS } from "@enterprise-hub/domain";
import type { RequestAuditContext } from "./request-audit-context.js";

export interface CatalogLabel {
  id: string;
  key: string;
  name: string;
  type: string;
}

export interface CreateUploadedDocumentInput {
  id: string;
  orgId: string;
  title: string;
  documentType: DocumentTypeName;
  documentKind?: DocumentKindName;
  fileType?: Phase3FileType;
  status: DocumentStatusName;
  storageObjectKey: string;
  originalFileName: string;
  contentType?: string;
  byteSize: number;
  checksumSha256: string;
  uploaderId: string;
  sourceSystem: string | null;
  sourceTime: Date | null;
  labelIds: string[];
  labels: string[];
  processingJobType: ProcessingJobTypeName;
  audit: RequestAuditContext;
}

export interface DocumentStatusRecord {
  id: string;
  orgId: string;
  uploaderId: string;
  title: string;
  documentType: DocumentTypeName;
  documentKind: DocumentKindName | null;
  fileType: Phase3FileType | null;
  status: DocumentStatusName;
  storageObjectKey: string;
  originalFileName: string | null;
  contentType: string | null;
  byteSize: number | null;
  checksumSha256: string | null;
  sourceSystem: string | null;
  sourceTime: Date | null;
  labels: string[];
  processingRunStatus: string | null;
  documentIndexStatus: string | null;
}

export interface ArchiveDocumentInput {
  orgId: string;
  documentId: string;
  actorEmployeeId: string;
  audit: RequestAuditContext;
}

export interface AddDocumentLabelsInput {
  orgId: string;
  documentId: string;
  actorEmployeeId: string;
  labelIds: string[];
  labelKeys: string[];
  audit: RequestAuditContext;
}

export interface AuditLogRecord {
  id: string;
  actorEmployeeId: string | null;
  action: string;
  targetType: string;
  targetId: string | null;
  result: string;
  metadata: Record<string, unknown> | null;
  requestId: string | null;
  clientIp: string | null;
  clientSource: string | null;
  launcherVersion: string | null;
  createdAt: Date;
}

export interface ListAuditLogsInput {
  orgId: string;
  limit: number;
  cursor: string | null;
}

export interface AppendAuditLogInput {
  orgId: string;
  actorEmployeeId: string | null;
  action: string;
  targetType: string;
  targetId: string | null;
  result: string;
  metadata?: Record<string, unknown> | null;
  audit: RequestAuditContext;
}

export interface ListAuditLogsResult {
  auditLogs: AuditLogRecord[];
  nextCursor: string | null;
}

export interface DocumentCatalogRepository {
  listLabels(orgId: string): Promise<CatalogLabel[]>;
  findLabelsByKeys(orgId: string, keys: string[]): Promise<CatalogLabel[]>;
  findPersonalLabelForEmployee(orgId: string, employeeId: string): Promise<CatalogLabel | null>;
  createUploadedDocument(input: CreateUploadedDocumentInput): Promise<DocumentStatusRecord>;
  findEvidenceDocumentStatus(
    orgId: string,
    documentId: string
  ): Promise<DocumentStatusRecord | null>;
  appendAuditLog(input: AppendAuditLogInput): Promise<void>;
  archiveDocument(input: ArchiveDocumentInput): Promise<DocumentStatusRecord | null>;
  listAuditLogs(input: ListAuditLogsInput): Promise<ListAuditLogsResult>;
  disconnect?(): Promise<void>;
}

const documentStatusInclude = {
  documentLabels: {
    include: {
      label: {
        select: {
          key: true
        }
      }
    }
  },
  processingRuns: {
    orderBy: {
      createdAt: "asc"
    },
    take: 1,
    select: {
      status: true
    }
  },
  indexes: {
    orderBy: {
      createdAt: "desc"
    },
    take: 1,
    select: {
      status: true
    }
  }
} satisfies Prisma.DocumentInclude;

function requireDatabaseUrl(): string {
  const databaseUrl = process.env["DATABASE_URL"];

  if (!databaseUrl) {
    throw new Error(
      "DATABASE_URL is required to start the API with the Prisma document repository."
    );
  }

  return databaseUrl;
}

export function createPrismaDocumentCatalogRepository(
  databaseUrl = requireDatabaseUrl()
): DocumentCatalogRepository {
  const adapter = new PrismaMariaDb(databaseUrl);
  const prisma = new PrismaClient({ adapter });

  return {
    async listLabels(orgId) {
      return prisma.label.findMany({
        where: {
          orgId
        },
        orderBy: [{ type: "asc" }, { key: "asc" }],
        select: {
          id: true,
          key: true,
          name: true,
          type: true
        }
      });
    },
    async findLabelsByKeys(orgId, keys) {
      if (keys.length === 0) {
        return [];
      }

      return prisma.label.findMany({
        where: {
          orgId,
          key: { in: keys }
        },
        select: {
          id: true,
          key: true,
          name: true,
          type: true
        }
      });
    },
    async findPersonalLabelForEmployee(orgId, employeeId) {
      const employeeLabel = await prisma.employeeLabel.findFirst({
        where: {
          employeeId,
          label: {
            orgId,
            type: LabelType.personal
          }
        },
        include: {
          label: {
            select: {
              id: true,
              key: true,
              name: true,
              type: true
            }
          }
        }
      });

      return employeeLabel?.label ?? null;
    },
    async createUploadedDocument(input) {
      const document = await prisma.$transaction(async (tx) => {
        const createdDocument = await tx.document.create({
          data: {
            id: input.id,
            orgId: input.orgId,
            title: input.title,
            documentType: input.documentType as DocumentType,
            documentKind: input.documentKind ? (input.documentKind as DocumentKind) : undefined,
            fileType: input.fileType ? (input.fileType as FileType) : undefined,
            status: input.status as DocumentStatus,
            storageObjectKey: input.storageObjectKey,
            originalFileName: input.originalFileName,
            contentType: input.contentType,
            byteSize: BigInt(input.byteSize),
            checksumSha256: input.checksumSha256,
            uploaderId: input.uploaderId,
            sourceSystem: input.sourceSystem,
            sourceTime: input.sourceTime,
            documentLabels: {
              create: input.labelIds.map((labelId) => ({
                labelId
              }))
            },
            processingRuns: {
              create: {
                orgId: input.orgId,
                jobKey: `${input.processingJobType}:${input.id}:v1`,
                status: ProcessingRunStatus.queued,
                jobType: input.processingJobType as ProcessingJobType,
                attemptNumber: 1,
                retryCount: 0,
                availableAt: new Date()
              }
            }
          },
          include: documentStatusInclude
        });

        await tx.auditLog.create({
          data: {
            orgId: input.orgId,
            actorEmployeeId: input.uploaderId,
            action: AUDIT_ACTIONS.documentUploaded,
            targetType: "document",
            targetId: input.id,
            result: "succeeded",
            metadata: {
              labelKeys: input.labels,
              storageObjectKey: input.storageObjectKey
            },
            requestId: input.audit.requestId,
            clientIp: input.audit.sourceIp,
            clientSource: input.audit.clientSource,
            launcherVersion: input.audit.launcherVersion
          }
        });

        return createdDocument;
      });

      return toDocumentStatusRecord(document);
    },
    async findEvidenceDocumentStatus(orgId, documentId) {
      const document = await prisma.document.findFirst({
        where: {
          id: documentId,
          orgId,
          documentKind: DocumentKind.evidence
        },
        include: documentStatusInclude
      });

      return document ? toDocumentStatusRecord(document) : null;
    },
    async appendAuditLog(input) {
      await prisma.auditLog.create({
        data: {
          orgId: input.orgId,
          actorEmployeeId: input.actorEmployeeId,
          action: input.action,
          targetType: input.targetType,
          targetId: input.targetId,
          result: input.result,
          metadata: (input.metadata ?? undefined) as Prisma.InputJsonValue | undefined,
          requestId: input.audit.requestId,
          clientIp: input.audit.sourceIp,
          clientSource: input.audit.clientSource,
          launcherVersion: input.audit.launcherVersion
        }
      });
    },
    async archiveDocument(input) {
      const document = await prisma.$transaction(async (tx) => {
        const existingDocument = await tx.document.findFirst({
          where: {
            id: input.documentId,
            orgId: input.orgId
          }
        });

        if (!existingDocument) {
          return null;
        }

        const updatedDocument = await tx.document.update({
          where: {
            id: input.documentId
          },
          data: {
            status: DocumentStatus.archived,
            archivedAt: new Date()
          },
          include: documentStatusInclude
        });

        await tx.auditLog.create({
          data: {
            orgId: input.orgId,
            actorEmployeeId: input.actorEmployeeId,
            action: AUDIT_ACTIONS.documentArchived,
            targetType: "document",
            targetId: input.documentId,
            result: "succeeded",
            metadata: {
              previousStatus: existingDocument.status
            },
            requestId: input.audit.requestId,
            clientIp: input.audit.sourceIp,
            clientSource: input.audit.clientSource,
            launcherVersion: input.audit.launcherVersion
          }
        });

        return updatedDocument;
      });

      return document ? toDocumentStatusRecord(document) : null;
    },
    async listAuditLogs(input) {
      const offset = parseCursorOffset(input.cursor);
      const auditLogs = await prisma.auditLog.findMany({
        where: {
          orgId: input.orgId
        },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        skip: offset,
        take: input.limit + 1
      });
      const page = auditLogs.slice(0, input.limit);

      return {
        auditLogs: page.map(toAuditLogRecord),
        nextCursor: auditLogs.length > input.limit ? String(offset + input.limit) : null
      };
    },
    async disconnect() {
      await prisma.$disconnect();
    }
  };
}

function toMetadataRecord(value: Prisma.JsonValue | null): Record<string, unknown> | null {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }

  return null;
}

function toAuditLogRecord(auditLog: Prisma.AuditLogGetPayload<object>): AuditLogRecord {
  return {
    id: auditLog.id,
    actorEmployeeId: auditLog.actorEmployeeId,
    action: auditLog.action,
    targetType: auditLog.targetType,
    targetId: auditLog.targetId,
    result: auditLog.result,
    metadata: toMetadataRecord(auditLog.metadata),
    requestId: auditLog.requestId,
    clientIp: auditLog.clientIp,
    clientSource: auditLog.clientSource,
    launcherVersion: auditLog.launcherVersion,
    createdAt: auditLog.createdAt
  };
}

function parseCursorOffset(cursor: string | null): number {
  if (!cursor) {
    return 0;
  }

  const offset = Number.parseInt(cursor, 10);
  return Number.isFinite(offset) && offset > 0 ? offset : 0;
}

function toDocumentStatusRecord(
  document: Prisma.DocumentGetPayload<{ include: typeof documentStatusInclude }>
): DocumentStatusRecord {
  return {
    id: document.id,
    orgId: document.orgId,
    uploaderId: document.uploaderId,
    title: document.title,
    documentType: document.documentType,
    documentKind: document.documentKind,
    fileType: document.fileType,
    status: document.status,
    storageObjectKey: document.storageObjectKey,
    originalFileName: document.originalFileName,
    contentType: document.contentType,
    byteSize: document.byteSize === null ? null : Number(document.byteSize),
    checksumSha256: document.checksumSha256,
    sourceSystem: document.sourceSystem,
    sourceTime: document.sourceTime,
    labels: document.documentLabels.map((documentLabel) => documentLabel.label.key).sort(),
    processingRunStatus: document.processingRuns[0]?.status ?? null,
    documentIndexStatus: document.indexes[0]?.status ?? null
  };
}
