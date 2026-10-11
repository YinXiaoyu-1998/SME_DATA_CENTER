import {
  persistPhotoReadRequirement,
  requireCurrentUploadAdmin,
  createBusinessAuthorizationRepository,
  toResourceReadRequirement,
  bindHistoricalSupplementIntent
} from "@smedc/db";
import {
  lockLedgerSourceMutation,
  ledgerPartitionsForReceipt,
  readableLedgerPartitionHints,
  markLedgerPartitionsChanged,
  type LedgerPartitionKey
} from "@smedc/ledger-archive";
import { createHash } from "node:crypto";
import { createDatabaseAdapter, retryIdempotentDatabaseOperation } from "@smedc/db";
import {
  DocumentKind,
  DocumentStatus,
  DocumentType,
  FileType,
  Prisma,
  PrismaClient
} from "@prisma/client";
import {
  AUDIT_ACTIONS,
  canEmployeeAccessDocument,
  canReadResource,
  type AuthorizationSnapshot,
  type AuthenticatedEmployee
} from "@smedc/domain";
import type { RequestAuditContext } from "./request-audit-context.js";
import { canPerformPrivilegedAdministrativeOperation } from "./privileged-admin-operations.js";

export const QUARANTINE_CERTIFICATE_LIMITS = {
  maxReceiptIdChars: 255,
  maxIdempotencyKeyChars: 255,
  maxImageBytes: 50 * 1024 * 1024
} as const;

export interface QuarantineCertificateRecord {
  affectedLedgerPartitions?: LedgerPartitionKey[];
  sourceDocumentId: string;
  receiptId: string;
  originalFileName: string;
  contentType: string;
  byteSize: number;
  uploadedAt: Date;
  uploaderId: string;
  confidentialityLevel: number;
  storageObjectKey: string;
}

export interface CreateQuarantineCertificateInput {
  historicalSupplementReason?: string;
  enterpriseKey?: string;
  storeName?: string;
  orgId: string;
  actorEmployeeId: string;
  sourceDocumentId: string;
  title: string;
  receiptId: string;
  idempotencyKey: string;
  requestFingerprint: string;
  fileType: "jpg" | "jpeg" | "png";
  storageObjectKey: string;
  originalFileName: string;
  contentType: string;
  byteSize: number;
  checksumSha256: string;
  confidentialityLevel: number;
  audit: RequestAuditContext;
}

export interface QueryQuarantineCertificatesInput {
  authorization?: AuthorizationSnapshot;
  orgId: string;
  employee: AuthenticatedEmployee;
  receiptIds: string[];
}

export interface ArchiveQuarantineCertificateBySourceInput {
  orgId: string;
  employee: AuthenticatedEmployee;
  sourceDocumentId: string;
  audit: RequestAuditContext;
}

export interface ArchiveQuarantineCertificatesByReceiptInput {
  orgId: string;
  employee: AuthenticatedEmployee;
  receiptId: string;
  audit: RequestAuditContext;
}

export type QuarantineCertificateArchiveResult = {
  archivedCount: number;
  affectedLedgerPartitions: LedgerPartitionKey[];
};

export interface QuarantineCertificateRepository {
  findByIdempotencyKey(
    orgId: string,
    idempotencyKey: string,
    actorEmployeeId?: string
  ): Promise<(QuarantineCertificateRecord & { requestFingerprint: string }) | null>;
  createCertificate(input: CreateQuarantineCertificateInput): Promise<QuarantineCertificateRecord>;
  queryVisibleByReceiptIds(
    input: QueryQuarantineCertificatesInput
  ): Promise<QuarantineCertificateRecord[]>;
  // Legacy injected repositories may return counts; the HTTP adapter normalizes this seam.
  archiveBySourceDocumentId(
    input: ArchiveQuarantineCertificateBySourceInput
  ): Promise<number | QuarantineCertificateArchiveResult | null>;
  archiveByReceiptId(
    input: ArchiveQuarantineCertificatesByReceiptInput
  ): Promise<number | QuarantineCertificateArchiveResult>;
  disconnect?(): Promise<void>;
}

export class QuarantineCertificateError extends Error {
  constructor(
    readonly code: "IDEMPOTENCY_KEY_CONFLICT" | "QUARANTINE_CERTIFICATE_CREATE_FAILED",
    message: string
  ) {
    super(message);
    this.name = "QuarantineCertificateError";
  }
}

const certificateInclude = { sourceDocument: true } satisfies Prisma.QuarantineCertificateInclude;

export function normalizeReceiptId(value: string): string {
  return value.trim().toUpperCase();
}

export function quarantineCertificateFingerprint(input: {
  receiptId: string;
  confidentialityLevel: number;
  fileHash: string;
  historicalSupplementReason?: string;
  enterpriseKey?: string;
  storeName?: string;
}): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        receiptId: input.receiptId,
        ...(input.historicalSupplementReason !== undefined
          ? { historicalSupplementReason: input.historicalSupplementReason }
          : {}),
        ...(input.enterpriseKey ? { enterpriseKey: input.enterpriseKey } : {}),
        ...(input.storeName ? { storeName: input.storeName } : {}),
        confidentialityLevel: input.confidentialityLevel,
        fileHash: input.fileHash
      })
    )
    .digest("hex");
}

export function createPrismaQuarantineCertificateRepository(
  databaseUrl = requireDatabaseUrl()
): QuarantineCertificateRepository {
  const prisma = new PrismaClient({ adapter: createDatabaseAdapter(databaseUrl) });

  return {
    async findByIdempotencyKey(orgId, idempotencyKey, actorEmployeeId) {
      const certificate = await prisma.quarantineCertificate.findUnique({
        where: {
          orgId_idempotencyKey: {
            orgId,
            idempotencyKey
          }
        },
        include: certificateInclude
      });

      if (!certificate) return null;
      const audit = await prisma.auditLog.findFirst({
        where: {
          orgId,
          targetId: certificate.sourceDocumentId,
          action: AUDIT_ACTIONS.documentUploaded
        },
        orderBy: { createdAt: "asc" }
      });
      const metadata = audit?.metadata as {
        affectedLedgerPartitions?: LedgerPartitionKey[];
      } | null;
      return {
        ...toCertificateRecord(certificate),
        affectedLedgerPartitions: await readableLedgerPartitionHints(
          prisma,
          actorEmployeeId ?? certificate.sourceDocument.uploaderId,
          metadata?.affectedLedgerPartitions ?? []
        )
      };
    },
    async createCertificate(input) {
      try {
        const certificate = await retryIdempotentDatabaseOperation(() =>
          prisma.$transaction(async (tx) => {
            await lockLedgerSourceMutation(tx, input.orgId);
            await requireCurrentUploadAdmin(tx, input.orgId, input.actorEmployeeId);
            const historicalSupplement = await bindHistoricalSupplementIntent(
              tx,
              input.orgId,
              input.actorEmployeeId,
              input.historicalSupplementReason
            );
            await tx.document.create({
              data: {
                id: input.sourceDocumentId,
                orgId: input.orgId,
                title: input.title,
                documentType: DocumentType.raw_material,
                documentKind: DocumentKind.quarantine_certificate,
                fileType: input.fileType as FileType,
                status: DocumentStatus.active,
                confidentialityLevel: input.confidentialityLevel,
                storageObjectKey: input.storageObjectKey,
                originalFileName: input.originalFileName,
                contentType: input.contentType,
                byteSize: BigInt(input.byteSize),
                checksumSha256: input.checksumSha256,
                uploaderId: input.actorEmployeeId,
                sourceSystem: null,
                sourceTime: null,
                sourceMetadata: {
                  receiptId: input.receiptId,
                  ...(historicalSupplement
                    ? { historicalSupplement: { ...historicalSupplement } }
                    : {}),
                  ...(input.enterpriseKey ? { enterpriseKey: input.enterpriseKey } : {}),
                  ...(input.storeName ? { storeName: input.storeName } : {})
                }
              }
            });

            const created = await tx.quarantineCertificate.create({
              data: {
                orgId: input.orgId,
                sourceDocumentId: input.sourceDocumentId,
                receiptId: input.receiptId,
                idempotencyKey: input.idempotencyKey,
                requestFingerprint: input.requestFingerprint
              },
              include: certificateInclude
            });

            await persistPhotoReadRequirement(tx, { ...input, historicalSupplement });

            const affectedLedgerPartitions = await ledgerPartitionsForReceipt(
              tx,
              input.orgId,
              input.receiptId
            );
            await markLedgerPartitionsChanged(tx, affectedLedgerPartitions);
            await tx.auditLog.create({
              data: {
                orgId: input.orgId,
                actorEmployeeId: input.actorEmployeeId,
                action: AUDIT_ACTIONS.documentUploaded,
                targetType: "quarantine_certificate",
                targetId: input.sourceDocumentId,
                result: "succeeded",
                metadata: {
                  receiptId: input.receiptId,
                  affectedLedgerPartitions,
                  confidentialityLevel: input.confidentialityLevel
                } satisfies Prisma.InputJsonObject,
                requestId: input.audit.requestId,
                clientIp: input.audit.sourceIp,
                clientSource: input.audit.clientSource,
                launcherVersion: input.audit.launcherVersion
              }
            });

            return {
              ...toCertificateRecord(created),
              affectedLedgerPartitions: await readableLedgerPartitionHints(
                tx,
                input.actorEmployeeId,
                affectedLedgerPartitions
              )
            };
          })
        );

        return certificate;
      } catch (error) {
        if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
          const existing = await prisma.quarantineCertificate.findUnique({
            where: {
              orgId_idempotencyKey: {
                orgId: input.orgId,
                idempotencyKey: input.idempotencyKey
              }
            },
            include: certificateInclude
          });
          if (existing?.requestFingerprint === input.requestFingerprint) {
            const audit = await prisma.auditLog.findFirst({
              where: {
                orgId: input.orgId,
                targetId: existing.sourceDocumentId,
                action: AUDIT_ACTIONS.documentUploaded
              },
              orderBy: { createdAt: "asc" }
            });
            const metadata = audit?.metadata as {
              affectedLedgerPartitions?: LedgerPartitionKey[];
            } | null;
            return {
              ...toCertificateRecord(existing),
              affectedLedgerPartitions: await readableLedgerPartitionHints(
                prisma,
                input.actorEmployeeId,
                metadata?.affectedLedgerPartitions ?? []
              )
            };
          }

          throw new QuarantineCertificateError(
            "IDEMPOTENCY_KEY_CONFLICT",
            "Idempotency key was reused with different certificate content."
          );
        }

        throw error;
      }
    },
    async queryVisibleByReceiptIds(input) {
      const certificates = await prisma.quarantineCertificate.findMany({
        where: {
          orgId: input.orgId,
          receiptId: { in: input.receiptIds },
          sourceDocument: {
            archivedAt: null,
            status: { not: DocumentStatus.archived }
          }
        },
        include: certificateInclude,
        orderBy: [{ createdAt: "desc" }, { sourceDocumentId: "desc" }]
      });

      const snapshot =
        input.authorization ??
        (await createBusinessAuthorizationRepository({ prisma }).loadAuthorizationSnapshot(
          input.employee.id,
          input.orgId
        ));
      if (snapshot.disabled || snapshot.orgId !== input.orgId) return [];
      const visible: QuarantineCertificateRecord[] = [];
      for (const certificate of certificates) {
        if (snapshot.mode === "legacy" || snapshot.mode === "preparing") {
          if (
            canSeeCertificate(
              { ...input.employee, clearance: snapshot.clearance },
              toCertificateRecord(certificate)
            )
          )
            visible.push(toCertificateRecord(certificate));
        } else {
          const resources = await prisma.businessResource.findMany({
            where: {
              orgId: input.orgId,
              documentId: certificate.sourceDocumentId,
              kind: "quarantine_certificate"
            },
            include: { scopes: { include: { dimensions: true } } }
          });
          const requirements = resources.map((resource) => ({
            ...toResourceReadRequirement(resource),
            valid:
              resource.valid &&
              certificate.sourceDocument.status === "active" &&
              !certificate.sourceDocument.archivedAt
          }));
          if (
            requirements.length &&
            requirements.every((requirement) => canReadResource(snapshot, requirement).allowed)
          )
            visible.push(toCertificateRecord(certificate));
        }
      }
      return visible;
    },
    async archiveBySourceDocumentId(input) {
      const certificate = await prisma.quarantineCertificate.findUnique({
        where: { sourceDocumentId: input.sourceDocumentId },
        include: certificateInclude
      });
      if (!certificate || certificate.orgId !== input.orgId) return null;
      if (
        !canPerformPrivilegedAdministrativeOperation(
          input.employee,
          "archiveQuarantineCertificates"
        )
      ) {
        return null;
      }
      if (
        certificate.sourceDocument.status === DocumentStatus.archived ||
        certificate.sourceDocument.archivedAt
      ) {
        return { archivedCount: 0, affectedLedgerPartitions: [] };
      }

      return retryIdempotentDatabaseOperation(() =>
        prisma.$transaction(async (tx) => {
          await lockLedgerSourceMutation(tx, input.orgId);
          const actor = await tx.employee.findFirst({
            where: { id: input.employee.id, orgId: input.orgId, role: "admin", disabled: false },
            select: { id: true }
          });
          if (!actor) return { archivedCount: 0, affectedLedgerPartitions: [] };
          const affectedLedgerPartitions = await ledgerPartitionsForReceipt(
            tx,
            input.orgId,
            certificate.receiptId
          );
          const visibleHints = await readableLedgerPartitionHints(
            tx,
            input.employee.id,
            affectedLedgerPartitions
          );
          const changed = await tx.document.updateMany({
            where: {
              id: input.sourceDocumentId,
              orgId: input.orgId,
              status: { not: DocumentStatus.archived },
              archivedAt: null
            },
            data: { status: DocumentStatus.archived, archivedAt: new Date() }
          });
          if (!changed.count) return { archivedCount: 0, affectedLedgerPartitions: [] };
          await markLedgerPartitionsChanged(tx, affectedLedgerPartitions);
          await tx.auditLog.create({
            data: archiveAuditData({
              input,
              targetId: input.sourceDocumentId,
              metadata: { receiptId: certificate.receiptId, mode: "sourceDocumentId" }
            })
          });
          return {
            archivedCount: changed.count,
            affectedLedgerPartitions: visibleHints
          };
        })
      );
    },
    async archiveByReceiptId(input) {
      if (
        !canPerformPrivilegedAdministrativeOperation(
          input.employee,
          "archiveQuarantineCertificates"
        )
      ) {
        return { archivedCount: 0, affectedLedgerPartitions: [] };
      }
      return retryIdempotentDatabaseOperation(() =>
        prisma.$transaction(async (tx) => {
          await lockLedgerSourceMutation(tx, input.orgId);
          const actor = await tx.employee.findFirst({
            where: { id: input.employee.id, orgId: input.orgId, role: "admin", disabled: false },
            select: { id: true }
          });
          if (!actor) return { archivedCount: 0, affectedLedgerPartitions: [] };
          const certificates = await tx.quarantineCertificate.findMany({
            where: {
              orgId: input.orgId,
              receiptId: input.receiptId,
              sourceDocument: {
                status: { not: DocumentStatus.archived },
                archivedAt: null
              }
            },
            select: { sourceDocumentId: true }
          });
          if (certificates.length === 0) return { archivedCount: 0, affectedLedgerPartitions: [] };
          const sourceDocumentIds = certificates.map((certificate) => certificate.sourceDocumentId);

          const affectedLedgerPartitions = await ledgerPartitionsForReceipt(
            tx,
            input.orgId,
            input.receiptId
          );
          const visibleHints = await readableLedgerPartitionHints(
            tx,
            input.employee.id,
            affectedLedgerPartitions
          );
          const changed = await tx.document.updateMany({
            where: {
              id: { in: sourceDocumentIds },
              orgId: input.orgId,
              status: { not: DocumentStatus.archived },
              archivedAt: null
            },
            data: { status: DocumentStatus.archived, archivedAt: new Date() }
          });
          if (!changed.count) return { archivedCount: 0, affectedLedgerPartitions: [] };
          await markLedgerPartitionsChanged(tx, affectedLedgerPartitions);
          await tx.auditLog.create({
            data: archiveAuditData({
              input,
              targetId: input.receiptId,
              metadata: {
                receiptId: input.receiptId,
                mode: "receiptId",
                sourceDocumentIds
              }
            })
          });
          return {
            archivedCount: changed.count,
            affectedLedgerPartitions: visibleHints
          };
        })
      );
    },
    async disconnect() {
      await prisma.$disconnect();
    }
  };
}

function archiveAuditData(input: {
  input: ArchiveQuarantineCertificateBySourceInput | ArchiveQuarantineCertificatesByReceiptInput;
  targetId: string;
  metadata: Prisma.InputJsonObject;
}) {
  return {
    orgId: input.input.orgId,
    actorEmployeeId: input.input.employee.id,
    action: AUDIT_ACTIONS.documentArchived,
    targetType: "quarantine_certificate",
    targetId: input.targetId,
    result: "succeeded",
    metadata: input.metadata,
    requestId: input.input.audit.requestId,
    clientIp: input.input.audit.sourceIp,
    clientSource: input.input.audit.clientSource,
    launcherVersion: input.input.audit.launcherVersion
  };
}

function canSeeCertificate(
  employee: AuthenticatedEmployee,
  certificate: Pick<QuarantineCertificateRecord, "confidentialityLevel">
): boolean {
  return canEmployeeAccessDocument({
    employee: {
      disabled: employee.disabled,
      clearance: employee.clearance
    },
    document: { confidentialityLevel: certificate.confidentialityLevel }
  });
}

function toCertificateRecord(
  certificate: Prisma.QuarantineCertificateGetPayload<{ include: typeof certificateInclude }>
): QuarantineCertificateRecord & { requestFingerprint: string } {
  return {
    sourceDocumentId: certificate.sourceDocumentId,
    receiptId: certificate.receiptId,
    originalFileName: certificate.sourceDocument.originalFileName ?? "",
    contentType: certificate.sourceDocument.contentType ?? "",
    byteSize: certificate.sourceDocument.byteSize ? Number(certificate.sourceDocument.byteSize) : 0,
    uploadedAt: certificate.createdAt,
    uploaderId: certificate.sourceDocument.uploaderId,
    confidentialityLevel: certificate.sourceDocument.confidentialityLevel,
    storageObjectKey: certificate.sourceDocument.storageObjectKey,
    requestFingerprint: certificate.requestFingerprint
  };
}

function requireDatabaseUrl(): string {
  const databaseUrl = process.env["DATABASE_URL"];
  if (!databaseUrl) {
    throw new Error("DATABASE_URL is required to start the quarantine certificate repository.");
  }
  return databaseUrl;
}
