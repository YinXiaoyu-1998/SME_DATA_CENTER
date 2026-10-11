import { persistEvidenceReadRequirement, requireCurrentUploadAdmin } from "@smedc/db";
import type { BusinessScopeItem } from "@smedc/domain";
import {
  lockLedgerSourceMutation,
  ledgerPartitionsForDocument,
  readableLedgerPartitionHints,
  markLedgerPartitionsChanged,
  type LedgerPartitionKey
} from "@smedc/ledger-archive";
import { createDatabaseAdapter, retryIdempotentDatabaseOperation } from "@smedc/db";
import {
  DocumentKind,
  DocumentStatus,
  DocumentType,
  FileType,
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
} from "@smedc/domain";
import { AUDIT_ACTIONS } from "@smedc/domain";
import type { RequestAuditContext } from "./request-audit-context.js";

export interface CreateUploadedDocumentInput {
  businessCategoryId?: string;
  businessScopes?: BusinessScopeItem[];
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
  confidentialityLevel: number;
  processingJobType: ProcessingJobTypeName;
  audit: RequestAuditContext;
}

export interface DocumentStatusRecord {
  affectedLedgerPartitions?: LedgerPartitionKey[];
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
  confidentialityLevel: number;
  processingRunStatus: string | null;
  documentIndexStatus: string | null;
  documentIndexRetrievalConfigVersion: string | null;
}

export interface ArchiveDocumentInput {
  orgId: string;
  documentId: string;
  actorEmployeeId: string;
  audit: RequestAuditContext;
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

export interface DocumentCatalogRepository {
  createUploadedDocument(input: CreateUploadedDocumentInput): Promise<DocumentStatusRecord>;
  findEvidenceDocumentStatus(
    orgId: string,
    documentId: string
  ): Promise<DocumentStatusRecord | null>;
  appendAuditLog(input: AppendAuditLogInput): Promise<void>;
  archiveDocument(input: ArchiveDocumentInput): Promise<DocumentStatusRecord | null>;
  disconnect?(): Promise<void>;
}

const documentStatusInclude = {
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
      status: true,
      retrievalConfig: {
        select: {
          version: true
        }
      }
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
  const adapter = createDatabaseAdapter(databaseUrl);
  const prisma = new PrismaClient({ adapter });

  return {
    async createUploadedDocument(input) {
      const document = await prisma.$transaction(async (tx) => {
        await requireCurrentUploadAdmin(tx, input.orgId, input.uploaderId);
        const createdDocument = await tx.document.create({
          data: {
            id: input.id,
            orgId: input.orgId,
            title: input.title,
            documentType: input.documentType as DocumentType,
            documentKind: input.documentKind ? (input.documentKind as DocumentKind) : undefined,
            fileType: input.fileType ? (input.fileType as FileType) : undefined,
            status: input.status as DocumentStatus,
            confidentialityLevel: input.confidentialityLevel,
            storageObjectKey: input.storageObjectKey,
            originalFileName: input.originalFileName,
            contentType: input.contentType,
            byteSize: BigInt(input.byteSize),
            checksumSha256: input.checksumSha256,
            uploaderId: input.uploaderId,
            sourceSystem: input.sourceSystem,
            sourceTime: input.sourceTime,
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

        if (input.documentKind === "evidence")
          await persistEvidenceReadRequirement(tx, {
            orgId: input.orgId,
            documentId: input.id,
            categoryId: input.businessCategoryId,
            scopes: input.businessScopes,
            fileConfidentialityLevel: input.confidentialityLevel,
            valid: false
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
              confidentialityLevel: input.confidentialityLevel,
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
      const document = await retryIdempotentDatabaseOperation(() =>
        prisma.$transaction(async (tx) => {
          await lockLedgerSourceMutation(tx, input.orgId);
          const actor = await tx.employee.findFirst({
            where: {
              id: input.actorEmployeeId,
              orgId: input.orgId,
              role: "admin",
              disabled: false
            },
            select: { id: true }
          });
          if (!actor) return null;
          const existingDocument = await tx.document.findFirst({
            where: {
              id: input.documentId,
              orgId: input.orgId
            }
          });

          if (!existingDocument) {
            return null;
          }

          const affectedLedgerPartitions =
            existingDocument.status !== DocumentStatus.archived &&
            !existingDocument.archivedAt &&
            ["structured", "quarantine_certificate"].includes(existingDocument.documentKind ?? "")
              ? await ledgerPartitionsForDocument(tx, input.orgId, input.documentId)
              : [];
          const visibleHints = await readableLedgerPartitionHints(
            tx,
            input.actorEmployeeId,
            affectedLedgerPartitions
          );
          const changed = await tx.document.updateMany({
            where: {
              id: input.documentId,
              orgId: input.orgId,
              status: { not: DocumentStatus.archived },
              archivedAt: null
            },
            data: {
              status: DocumentStatus.archived,
              archivedAt: new Date()
            }
          });
          const updatedDocument = await tx.document.findFirstOrThrow({
            where: { id: input.documentId, orgId: input.orgId },
            include: documentStatusInclude
          });
          if (!changed.count) return { document: updatedDocument, affectedLedgerPartitions: [] };

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

          await markLedgerPartitionsChanged(tx, affectedLedgerPartitions);
          return {
            document: updatedDocument,
            affectedLedgerPartitions: visibleHints
          };
        })
      );

      return document
        ? {
            ...toDocumentStatusRecord(document.document),
            affectedLedgerPartitions: document.affectedLedgerPartitions
          }
        : null;
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
    confidentialityLevel: document.confidentialityLevel,
    processingRunStatus: document.processingRuns[0]?.status ?? null,
    documentIndexStatus: document.indexes[0]?.status ?? null,
    documentIndexRetrievalConfigVersion: document.indexes[0]?.retrievalConfig.version ?? null
  };
}
