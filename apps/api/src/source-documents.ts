import {
  createBusinessAuthorizationRepository,
  getSourceReadRequirements,
  createDatabaseAdapter,
  toResourceReadRequirement
} from "@smedc/db";
import { DocumentStatus, Prisma, PrismaClient } from "@prisma/client";
import { AUDIT_ACTIONS, canReadResource, type StructuredDatasetName } from "@smedc/domain";
import type { SourceDocumentDownloadRepository } from "./source-document-downloads.js";

export const SOURCE_DOCUMENT_DOWNLOAD_EXPIRES_SECONDS = 24 * 60 * 60;

export interface SourceDocumentRecord {
  sourceDocumentId: string;
  orgId: string;
  status: string;
  storageObjectKey: string;
  originalFileName: string | null;
  contentType: string | null;
  byteSize: number | null;
  confidentialityLevel: number;
  importDataset: StructuredDatasetName | null;
}

export interface SourceDocumentRepository extends SourceDocumentDownloadRepository {
  disconnect?(): Promise<void>;
}

const downloadableStatuses = new Set([
  "pending_processing",
  "processing",
  "active",
  "processing_failed"
]);

const documentInclude = {
  importBatch: { select: { dataset: true } }
} satisfies Prisma.DocumentInclude;

export function createPrismaSourceDocumentRepository(
  databaseUrl = requireDatabaseUrl()
): SourceDocumentRepository {
  const prisma = new PrismaClient({ adapter: createDatabaseAdapter(databaseUrl) });

  return {
    async findDownloadableSourceDocuments(input) {
      if (input.employee.disabled || input.sourceDocumentIds.length === 0) return [];
      const permissions = createBusinessAuthorizationRepository({ prisma });
      const snapshot = await permissions.loadAuthorizationSnapshot(input.employee.id, input.orgId);
      if (snapshot.disabled || snapshot.mode === "suspended") return [];
      const modern = snapshot.mode === "enabled";
      const documents = await prisma.document.findMany({
        where: {
          id: { in: [...new Set(input.sourceDocumentIds)].slice(0, 50) },
          orgId: input.orgId,
          archivedAt: null,
          status: { in: [...downloadableStatuses] as DocumentStatus[] },
          ...(!modern ? { confidentialityLevel: { lte: snapshot.clearance } } : {})
        },
        include: documentInclude
      });
      const readable = [];
      for (const document of documents) {
        if (document.importBatch?.dataset === "delivery_ledger") continue;
        if (!modern) {
          readable.push(document);
          continue;
        }
        try {
          const requirements =
            document.documentKind === "structured"
              ? await getSourceReadRequirements(prisma, document.id, input.orgId)
              : await prisma.businessResource
                  .findMany({
                    where: { orgId: input.orgId, documentId: document.id },
                    include: { scopes: { include: { dimensions: true } } }
                  })
                  .then((resources) => resources.map(toResourceReadRequirement));
          if (
            document.status === "active" &&
            requirements.length &&
            requirements.every((requirement) => canReadResource(snapshot, requirement).allowed)
          )
            readable.push(document);
        } catch {
          /* An unresolved lineage cannot grant original access. */
        }
      }
      return readable.map(toSourceDocumentRecord);
    },
    async recordDownloadsIssued(input) {
      await prisma.auditLog.createMany({
        data: [...new Set(input.sourceDocumentIds)].map((sourceDocumentId) => ({
          orgId: input.orgId,
          actorEmployeeId: input.employee.id,
          action: AUDIT_ACTIONS.documentDownloaded,
          targetType: "document",
          targetId: sourceDocumentId,
          result: "succeeded",
          metadata: { reason: input.reason },
          requestId: input.audit.requestId,
          clientIp: input.audit.sourceIp,
          clientSource: input.audit.clientSource,
          launcherVersion: input.audit.launcherVersion
        }))
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
    originalFileName: document.originalFileName,
    contentType: document.contentType,
    byteSize: document.byteSize === null ? null : Number(document.byteSize),
    confidentialityLevel: document.confidentialityLevel,
    importDataset: document.importBatch?.dataset ?? null
  };
}

function requireDatabaseUrl(): string {
  const databaseUrl = process.env["DATABASE_URL"];
  if (!databaseUrl) {
    throw new Error("DATABASE_URL is required to start the source document repository.");
  }
  return databaseUrl;
}
