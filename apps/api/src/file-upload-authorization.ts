import { PrismaClient } from "@prisma/client";
import { createDatabaseAdapter } from "@smedc/db";
import {
  AUDIT_ACTIONS,
  FILE_UPLOAD_ADMIN_REQUIRED_CODE,
  FILE_UPLOAD_ADMIN_REQUIRED_MESSAGE,
  canEmployeeUploadFiles,
  type AuthenticatedEmployee,
  type FileUploadSurface
} from "@smedc/domain";
import type { FastifyRequest } from "fastify";
import type { RequestAuditContext } from "./request-audit-context.js";
import { phase3ErrorResponse } from "./request-errors.js";

export interface UploadAuthorizationAuditRepository {
  appendDenied(input: {
    orgId: string;
    actorEmployeeId: string;
    uploadSurface: FileUploadSurface;
    audit: RequestAuditContext;
  }): Promise<void>;
  disconnect?(): Promise<void>;
}

function requireDatabaseUrl(): string {
  const databaseUrl = process.env["DATABASE_URL"];
  if (!databaseUrl) {
    throw new Error("DATABASE_URL is required for the upload authorization audit repository.");
  }
  return databaseUrl;
}

export function createPrismaUploadAuthorizationAuditRepository(
  databaseUrl = requireDatabaseUrl()
): UploadAuthorizationAuditRepository {
  const prisma = new PrismaClient({ adapter: createDatabaseAdapter(databaseUrl) });

  return {
    async appendDenied(input) {
      await prisma.auditLog.create({
        data: {
          orgId: input.orgId,
          actorEmployeeId: input.actorEmployeeId,
          action: AUDIT_ACTIONS.fileUploadDenied,
          targetType: "file_upload",
          targetId: null,
          result: "denied",
          metadata: { uploadSurface: input.uploadSurface, reason: "admin_role_required" },
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

export async function authorizeFileUpload(input: {
  employee: AuthenticatedEmployee;
  uploadSurface: FileUploadSurface;
  audit: RequestAuditContext;
  auditRepository: UploadAuthorizationAuditRepository | (() => UploadAuthorizationAuditRepository);
  logAuditFailure: (context: { requestId: string; uploadSurface: FileUploadSurface }) => void;
}): Promise<boolean> {
  if (canEmployeeUploadFiles(input.employee)) {
    return true;
  }

  try {
    const repository =
      typeof input.auditRepository === "function" ? input.auditRepository() : input.auditRepository;
    await repository.appendDenied({
      orgId: input.employee.orgId,
      actorEmployeeId: input.employee.id,
      uploadSurface: input.uploadSurface,
      audit: input.audit
    });
  } catch {
    input.logAuditFailure({ requestId: input.audit.requestId, uploadSurface: input.uploadSurface });
  }
  return false;
}

export function fileUploadAdminRequiredResponse(request: FastifyRequest) {
  return phase3ErrorResponse(
    request,
    FILE_UPLOAD_ADMIN_REQUIRED_CODE,
    FILE_UPLOAD_ADMIN_REQUIRED_MESSAGE
  );
}
