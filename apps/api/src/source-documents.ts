import { createDatabaseAdapter } from "@enterprise-hub/db";
import { DocumentStatus, Prisma, PrismaClient } from "@prisma/client";
import {
  AUDIT_ACTIONS,
  canEmployeeAccessDocument,
  type AuthenticatedEmployee
} from "@enterprise-hub/domain";
import type { RequestAuditContext } from "./request-audit-context.js";

export const SOURCE_DOCUMENT_DOWNLOAD_EXPIRES_SECONDS = 24 * 60 * 60;

export interface SourceDocumentRecord {
  sourceDocumentId: string;
  orgId: string;
  status: string;
  storageObjectKey: string;
  originalFileName: string;
  contentType: string;
  byteSize: number;
  labelKeys: string[];
}

export interface SourceDocumentRepository {
  findDownloadableSourceDocument(input: {
    orgId: string;
    employee: AuthenticatedEmployee;
    sourceDocumentId: string;
  }): Promise<SourceDocumentRecord | null>;
  recordDownloadIssued(input: {
    orgId: string;
    employee: AuthenticatedEmployee;
    sourceDocumentId: string;
    audit: RequestAuditContext;
  }): Promise<void>;
  disconnect?(): Promise<void>;
}

const downloadableStatuses = new Set([
  "pending_processing",
  "processing",
  "active",
  "processing_failed"
]);

const documentInclude = {
  documentLabels: {
    include: {
      label: {
        select: { key: true }
      }
    }
  }
} satisfies Prisma.DocumentInclude;

export function createPrismaSourceDocumentRepository(
  databaseUrl = requireDatabaseUrl()
): SourceDocumentRepository {
  const prisma = new PrismaClient({ adapter: createDatabaseAdapter(databaseUrl) });

  return {
    async findDownloadableSourceDocument(input) {
      const document = await prisma.document.findFirst({
        where: {
          id: input.sourceDocumentId,
          orgId: input.orgId,
          archivedAt: null,
          status: { in: [...downloadableStatuses] as DocumentStatus[] }
        },
        include: documentInclude
      });
      if (!document) return null;

      const record = toSourceDocumentRecord(document);
      const canAccess = canEmployeeAccessDocument({
        employee: {
          disabled: input.employee.disabled,
          role: input.employee.role,
          labelKeys: input.employee.labels
        },
        document: { labelKeys: record.labelKeys }
      });
      return canAccess ? record : null;
    },
    async recordDownloadIssued(input) {
      await prisma.auditLog.create({
        data: {
          orgId: input.orgId,
          actorEmployeeId: input.employee.id,
          action: AUDIT_ACTIONS.documentDownloaded,
          targetType: "document",
          targetId: input.sourceDocumentId,
          result: "succeeded",
          metadata: Prisma.JsonNull,
          requestId: input.audit.requestId,
          clientIp: input.audit.sourceIp,
          clientSource: input.audit.clientSource,
          launcherVersion: input.audit.launcherVersion
        }
      });
    },
    async disconnect() {
      await prisma.$disconnect();
    }
  };
}

function toSourceDocumentRecord(
  document: Prisma.DocumentGetPayload<{ include: typeof documentInclude }>
): SourceDocumentRecord {
  return {
    sourceDocumentId: document.id,
    orgId: document.orgId,
    status: document.status,
    storageObjectKey: document.storageObjectKey,
    originalFileName: document.originalFileName ?? "source-document",
    contentType: document.contentType ?? "application/octet-stream",
    byteSize: document.byteSize ? Number(document.byteSize) : 0,
    labelKeys: document.documentLabels.map((documentLabel) => documentLabel.label.key).sort()
  };
}

function requireDatabaseUrl(): string {
  const databaseUrl = process.env["DATABASE_URL"];
  if (!databaseUrl) {
    throw new Error("DATABASE_URL is required to start the source document repository.");
  }
  return databaseUrl;
}
