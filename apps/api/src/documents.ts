import { PrismaMariaDb } from "@prisma/adapter-mariadb";
import {
  DocumentStatus,
  DocumentType,
  LabelType,
  Prisma,
  PrismaClient,
  ProcessingRunStatus
} from "@prisma/client";
import type { DocumentStatusName, DocumentTypeName } from "@enterprise-hub/domain";
import { AUDIT_ACTIONS } from "@enterprise-hub/domain";

export interface CatalogLabel {
  id: string;
  key: string;
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

export interface DocumentCatalogRepository {
  findLabelsByKeys(orgId: string, keys: string[]): Promise<CatalogLabel[]>;
  findPersonalLabelForEmployee(orgId: string, employeeId: string): Promise<CatalogLabel | null>;
  createUploadedDocument(input: CreateUploadedDocumentInput): Promise<DocumentStatusRecord>;
  findDocumentStatus(orgId: string, documentId: string): Promise<DocumentStatusRecord | null>;
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
    async disconnect() {
      await prisma.$disconnect();
    }
  };
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
