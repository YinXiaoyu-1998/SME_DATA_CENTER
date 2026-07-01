import { PrismaMariaDb } from "@prisma/adapter-mariadb";
import {
  DocumentStatus,
  DocumentType,
  LabelType,
  Prisma,
  PrismaClient,
  ProcessingRunStatus
} from "@prisma/client";
import type {
  AuthenticatedEmployee,
  DocumentStatusName,
  DocumentTypeName
} from "@enterprise-hub/domain";
import { AUDIT_ACTIONS, canEmployeeAccessDocument } from "@enterprise-hub/domain";

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
  requestId: string;
  clientIp: string;
}

export interface DocumentStatusRecord {
  id: string;
  orgId: string;
  uploaderId: string;
  title: string;
  documentType: DocumentTypeName;
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
}

export interface DocumentQueryRecord extends DocumentStatusRecord {
  createdAt: Date;
  sourceMetadata: Record<string, unknown> | null;
}

export interface ListDocumentsInput {
  orgId: string;
  employee: AuthenticatedEmployee;
  q: string | null;
  documentType: DocumentTypeName | null;
  labelKey: string | null;
  limit: number;
  cursor: string | null;
}

export interface ListDocumentsResult {
  documents: DocumentQueryRecord[];
  nextCursor: string | null;
}

export interface DocumentQueryAuditInput {
  orgId: string;
  employeeId: string;
  q: string | null;
  documentType: DocumentTypeName | null;
  labelKey: string | null;
  resultCount: number;
  requestId: string;
  clientIp: string;
}

export interface DocumentDownloadAuditInput {
  orgId: string;
  employeeId: string;
  documentId: string;
  requestId: string;
  clientIp: string;
}

export interface ArchiveDocumentInput {
  orgId: string;
  documentId: string;
  actorEmployeeId: string;
  requestId: string;
  clientIp: string;
}

export interface AddDocumentLabelsInput {
  orgId: string;
  documentId: string;
  actorEmployeeId: string;
  labelIds: string[];
  labelKeys: string[];
  requestId: string;
  clientIp: string;
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
  createdAt: Date;
}

export interface ListAuditLogsInput {
  orgId: string;
  limit: number;
  cursor: string | null;
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
  findDocumentStatus(orgId: string, documentId: string): Promise<DocumentStatusRecord | null>;
  listAccessibleActiveDocuments(input: ListDocumentsInput): Promise<ListDocumentsResult>;
  findAccessibleActiveDocument(
    orgId: string,
    documentId: string,
    employee: AuthenticatedEmployee
  ): Promise<DocumentQueryRecord | null>;
  appendDocumentQueryAudit(input: DocumentQueryAuditInput): Promise<void>;
  appendDocumentDownloadAudit(input: DocumentDownloadAuditInput): Promise<void>;
  archiveDocument(input: ArchiveDocumentInput): Promise<DocumentQueryRecord | null>;
  addDocumentLabels(input: AddDocumentLabelsInput): Promise<DocumentQueryRecord | null>;
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
  }
} satisfies Prisma.DocumentInclude;

const documentQueryInclude = {
  documentLabels: {
    include: {
      label: {
        select: {
          key: true
        }
      }
    }
  },
  chunks: {
    select: {
      chunkText: true
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
                status: ProcessingRunStatus.queued,
                attemptNumber: 1,
                retryCount: 0
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
            requestId: input.requestId,
            clientIp: input.clientIp
          }
        });

        return createdDocument;
      });

      return toDocumentStatusRecord(document);
    },
    async findDocumentStatus(orgId, documentId) {
      const document = await prisma.document.findFirst({
        where: {
          id: documentId,
          orgId
        },
        include: documentStatusInclude
      });

      return document ? toDocumentStatusRecord(document) : null;
    },
    async listAccessibleActiveDocuments(input) {
      const offset = parseCursorOffset(input.cursor);
      const documents = await prisma.document.findMany({
        where: buildActiveDocumentWhere(input),
        include: documentQueryInclude,
        orderBy: [{ sourceTime: "desc" }, { createdAt: "desc" }, { id: "desc" }]
      });
      const matchingDocuments = filterKeywordMatches(documents, input.q).map(toDocumentQueryRecord);
      const page = matchingDocuments.slice(offset, offset + input.limit);
      const nextCursor =
        matchingDocuments.length > offset + input.limit ? String(offset + input.limit) : null;

      return {
        documents: page,
        nextCursor
      };
    },
    async findAccessibleActiveDocument(orgId, documentId, employee) {
      const document = await prisma.document.findFirst({
        where: {
          id: documentId,
          orgId,
          status: DocumentStatus.active
        },
        include: documentQueryInclude
      });

      if (!document) {
        return null;
      }

      if (
        !employeeCanAccessDocument(
          employee,
          document.documentLabels.map((label) => label.label.key)
        )
      ) {
        return null;
      }

      return toDocumentQueryRecord(document);
    },
    async appendDocumentQueryAudit(input) {
      await prisma.auditLog.create({
        data: {
          orgId: input.orgId,
          actorEmployeeId: input.employeeId,
          action: AUDIT_ACTIONS.documentQueried,
          targetType: "document_query",
          targetId: null,
          result: "succeeded",
          metadata: {
            q: input.q,
            documentType: input.documentType,
            labelKey: input.labelKey,
            resultCount: input.resultCount
          },
          requestId: input.requestId,
          clientIp: input.clientIp
        }
      });
    },
    async appendDocumentDownloadAudit(input) {
      await prisma.auditLog.create({
        data: {
          orgId: input.orgId,
          actorEmployeeId: input.employeeId,
          action: AUDIT_ACTIONS.documentDownloaded,
          targetType: "document",
          targetId: input.documentId,
          result: "succeeded",
          metadata: {
            documentId: input.documentId
          },
          requestId: input.requestId,
          clientIp: input.clientIp
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
          include: documentQueryInclude
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
            requestId: input.requestId,
            clientIp: input.clientIp
          }
        });

        return updatedDocument;
      });

      return document ? toDocumentQueryRecord(document) : null;
    },
    async addDocumentLabels(input) {
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

        if (input.labelIds.length > 0) {
          await tx.documentLabel.createMany({
            data: input.labelIds.map((labelId) => ({
              documentId: input.documentId,
              labelId
            })),
            skipDuplicates: true
          });
        }

        await tx.auditLog.create({
          data: {
            orgId: input.orgId,
            actorEmployeeId: input.actorEmployeeId,
            action: AUDIT_ACTIONS.documentLabelsAdded,
            targetType: "document",
            targetId: input.documentId,
            result: "succeeded",
            metadata: {
              labelKeys: input.labelKeys
            },
            requestId: input.requestId,
            clientIp: input.clientIp
          }
        });

        return tx.document.findFirst({
          where: {
            id: input.documentId,
            orgId: input.orgId
          },
          include: documentQueryInclude
        });
      });

      return document ? toDocumentQueryRecord(document) : null;
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
    createdAt: auditLog.createdAt
  };
}

function buildActiveDocumentWhere(input: ListDocumentsInput): Prisma.DocumentWhereInput {
  const and: Prisma.DocumentWhereInput[] = [
    {
      orgId: input.orgId,
      status: DocumentStatus.active
    }
  ];

  if (input.documentType) {
    and.push({
      documentType: input.documentType as DocumentType
    });
  }

  if (input.labelKey) {
    and.push({
      documentLabels: {
        some: {
          label: {
            key: input.labelKey
          }
        }
      }
    });
  }

  if (input.employee.role !== "admin") {
    and.push({
      documentLabels: {
        some: {
          label: {
            key: {
              in: unique([...input.employee.labels, "all_staff"])
            }
          }
        }
      }
    });
  }

  return {
    AND: and
  };
}

function parseCursorOffset(cursor: string | null): number {
  if (!cursor) {
    return 0;
  }

  const offset = Number.parseInt(cursor, 10);
  return Number.isFinite(offset) && offset > 0 ? offset : 0;
}

function filterKeywordMatches(
  documents: Array<Prisma.DocumentGetPayload<{ include: typeof documentQueryInclude }>>,
  q: string | null
) {
  const keyword = q?.trim().toLowerCase();

  if (!keyword) {
    return documents;
  }

  return documents.filter((document) => {
    const searchableText = [
      document.title,
      document.sourceSystem,
      document.originalFileName,
      JSON.stringify(document.sourceMetadata ?? {}),
      ...document.chunks.map((chunk) => chunk.chunkText)
    ]
      .filter((value): value is string => Boolean(value))
      .join("\n")
      .toLowerCase();

    return searchableText.includes(keyword);
  });
}

function employeeCanAccessDocument(employee: AuthenticatedEmployee, documentLabelKeys: string[]) {
  if (employee.role === "admin") {
    return true;
  }

  return canEmployeeAccessDocument({
    employee: {
      disabled: employee.disabled,
      labelKeys: employee.labels
    },
    document: {
      labelKeys: documentLabelKeys
    }
  });
}

function unique(values: string[]) {
  return [...new Set(values)];
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
    status: document.status,
    storageObjectKey: document.storageObjectKey,
    originalFileName: document.originalFileName,
    contentType: document.contentType,
    byteSize: document.byteSize === null ? null : Number(document.byteSize),
    checksumSha256: document.checksumSha256,
    sourceSystem: document.sourceSystem,
    sourceTime: document.sourceTime,
    labels: document.documentLabels.map((documentLabel) => documentLabel.label.key).sort(),
    processingRunStatus: document.processingRuns[0]?.status ?? null
  };
}

function toDocumentQueryRecord(
  document: Prisma.DocumentGetPayload<{ include: typeof documentQueryInclude }>
): DocumentQueryRecord {
  return {
    id: document.id,
    orgId: document.orgId,
    uploaderId: document.uploaderId,
    title: document.title,
    documentType: document.documentType,
    status: document.status,
    storageObjectKey: document.storageObjectKey,
    originalFileName: document.originalFileName,
    contentType: document.contentType,
    byteSize: document.byteSize === null ? null : Number(document.byteSize),
    checksumSha256: document.checksumSha256,
    sourceSystem: document.sourceSystem,
    sourceTime: document.sourceTime,
    labels: document.documentLabels.map((documentLabel) => documentLabel.label.key).sort(),
    processingRunStatus: null,
    createdAt: document.createdAt,
    sourceMetadata: document.sourceMetadata as Record<string, unknown> | null
  };
}
