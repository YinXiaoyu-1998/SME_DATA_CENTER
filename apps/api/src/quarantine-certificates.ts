import { createHash } from "node:crypto";
import { PrismaMariaDb } from "@prisma/adapter-mariadb";
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
  type AuthenticatedEmployee
} from "@enterprise-hub/domain";
import type { RequestAuditContext } from "./request-audit-context.js";

export const QUARANTINE_CERTIFICATE_LIMITS = {
  maxReceiptIdChars: 255,
  maxIdempotencyKeyChars: 255,
  maxImageBytes: 50 * 1024 * 1024
} as const;

export interface QuarantineCertificateRecord {
  sourceDocumentId: string;
  receiptId: string;
  originalFileName: string;
  contentType: string;
  byteSize: number;
  uploadedAt: Date;
  uploaderId: string;
  labelKeys: string[];
  storageObjectKey: string;
}

export interface CreateQuarantineCertificateInput {
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
  labelIds: string[];
  labelKeys: string[];
  audit: RequestAuditContext;
}

export interface QueryQuarantineCertificatesInput {
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

export interface QuarantineCertificateRepository {
  findByIdempotencyKey(
    orgId: string,
    idempotencyKey: string
  ): Promise<(QuarantineCertificateRecord & { requestFingerprint: string }) | null>;
  createCertificate(input: CreateQuarantineCertificateInput): Promise<QuarantineCertificateRecord>;
  queryVisibleByReceiptIds(
    input: QueryQuarantineCertificatesInput
  ): Promise<QuarantineCertificateRecord[]>;
  archiveBySourceDocumentId(
    input: ArchiveQuarantineCertificateBySourceInput
  ): Promise<number | null>;
  archiveByReceiptId(input: ArchiveQuarantineCertificatesByReceiptInput): Promise<number>;
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

const certificateInclude = {
  sourceDocument: {
    include: {
      documentLabels: {
        include: {
          label: {
            select: { key: true }
          }
        }
      }
    }
  }
} satisfies Prisma.QuarantineCertificateInclude;

export function normalizeReceiptId(value: string): string {
  return value.trim().toUpperCase();
}

export function quarantineCertificateFingerprint(input: {
  receiptId: string;
  labelKeys: string[];
  fileHash: string;
}): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        receiptId: input.receiptId,
        labelKeys: [...input.labelKeys].sort(),
        fileHash: input.fileHash
      })
    )
    .digest("hex");
}

export function createPrismaQuarantineCertificateRepository(
  databaseUrl = requireDatabaseUrl()
): QuarantineCertificateRepository {
  const prisma = new PrismaClient({ adapter: new PrismaMariaDb(databaseUrl) });

  return {
    async findByIdempotencyKey(orgId, idempotencyKey) {
      const certificate = await prisma.quarantineCertificate.findUnique({
        where: {
          orgId_idempotencyKey: {
            orgId,
            idempotencyKey
          }
        },
        include: certificateInclude
      });

      return certificate ? toCertificateRecord(certificate) : null;
    },
    async createCertificate(input) {
      try {
        const certificate = await prisma.$transaction(async (tx) => {
          await tx.document.create({
            data: {
              id: input.sourceDocumentId,
              orgId: input.orgId,
              title: input.title,
              documentType: DocumentType.raw_material,
              documentKind: DocumentKind.quarantine_certificate,
              fileType: input.fileType as FileType,
              status: DocumentStatus.active,
              storageObjectKey: input.storageObjectKey,
              originalFileName: input.originalFileName,
              contentType: input.contentType,
              byteSize: BigInt(input.byteSize),
              checksumSha256: input.checksumSha256,
              uploaderId: input.actorEmployeeId,
              sourceSystem: null,
              sourceTime: null,
              documentLabels: {
                create: input.labelIds.map((labelId) => ({ labelId }))
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
                labelKeys: input.labelKeys
              } satisfies Prisma.InputJsonObject,
              requestId: input.audit.requestId,
              clientIp: input.audit.sourceIp,
              clientSource: input.audit.clientSource,
              launcherVersion: input.audit.launcherVersion
            }
          });

          return created;
        });

        return toCertificateRecord(certificate);
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
            return toCertificateRecord(existing);
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

      return certificates
        .map(toCertificateRecord)
        .filter((certificate) => canSeeCertificate(input.employee, certificate));
    },
    async archiveBySourceDocumentId(input) {
      const certificate = await prisma.quarantineCertificate.findUnique({
        where: { sourceDocumentId: input.sourceDocumentId },
        include: certificateInclude
      });
      if (!certificate || certificate.orgId !== input.orgId) return null;
      const record = toCertificateRecord(certificate);
      if (record.uploaderId !== input.employee.id && input.employee.role !== "admin") return null;
      if (
        certificate.sourceDocument.status === DocumentStatus.archived ||
        certificate.sourceDocument.archivedAt
      ) {
        return 0;
      }

      await prisma.$transaction(async (tx) => {
        await tx.document.update({
          where: { id: input.sourceDocumentId },
          data: { status: DocumentStatus.archived, archivedAt: new Date() }
        });
        await tx.auditLog.create({
          data: archiveAuditData({
            input,
            targetId: input.sourceDocumentId,
            metadata: { receiptId: certificate.receiptId, mode: "sourceDocumentId" }
          })
        });
      });
      return 1;
    },
    async archiveByReceiptId(input) {
      if (input.employee.role !== "admin") return 0;
      const certificates = await prisma.quarantineCertificate.findMany({
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
      if (certificates.length === 0) return 0;
      const sourceDocumentIds = certificates.map((certificate) => certificate.sourceDocumentId);

      await prisma.$transaction(async (tx) => {
        await tx.document.updateMany({
          where: { id: { in: sourceDocumentIds }, orgId: input.orgId },
          data: { status: DocumentStatus.archived, archivedAt: new Date() }
        });
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
      });
      return sourceDocumentIds.length;
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
  certificate: Pick<QuarantineCertificateRecord, "labelKeys">
): boolean {
  return canEmployeeAccessDocument({
    employee: {
      disabled: employee.disabled,
      role: employee.role,
      labelKeys: employee.labels
    },
    document: { labelKeys: certificate.labelKeys }
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
    labelKeys: certificate.sourceDocument.documentLabels
      .map((documentLabel) => documentLabel.label.key)
      .sort(),
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
