import { beforeEach, describe, expect, expectTypeOf, it, vi } from "vitest";
import {
  AUDIT_ACTIONS,
  FILE_UPLOAD_ADMIN_REQUIRED_CODE,
  FILE_UPLOAD_ADMIN_REQUIRED_MESSAGE,
  type AuthenticatedEmployee,
  type FileUploadSurface
} from "@smedc/domain";
import {
  authorizeFileUpload,
  createPrismaUploadAuthorizationAuditRepository,
  fileUploadAdminRequiredResponse,
  type UploadAuthorizationAuditRepository
} from "./file-upload-authorization.js";
import type { RequestAuditContext } from "./request-audit-context.js";

const prisma = vi.hoisted(() => ({
  auditLog: { create: vi.fn() },
  $disconnect: vi.fn()
}));

vi.mock("@prisma/adapter-mariadb", () => ({
  PrismaMariaDb: class PrismaMariaDb {}
}));

vi.mock("@prisma/client", () => ({
  PrismaClient: class PrismaClient {
    constructor() {
      return prisma;
    }
  }
}));

const employee: AuthenticatedEmployee = {
  id: "emp_1",
  orgId: "org_1",
  organizationName: "Test Organization",
  displayName: "Test Employee",
  email: "employee@example.invalid",
  role: "employee",
  disabled: false,
  clearance: 3
};
const requestAudit: RequestAuditContext = {
  requestId: "req_upload_1",
  sourceIp: "198.51.100.10",
  clientSource: "mcp_launcher",
  launcherVersion: "0.5.2"
};

describe("file upload authorization", () => {
  beforeEach(() => vi.clearAllMocks());

  it("allows an active admin independently of clearance without an audit write", async () => {
    const auditRepository = { appendDenied: vi.fn() };
    const logAuditFailure = vi.fn();

    await expect(
      authorizeFileUpload({
        employee: { ...employee, role: "admin", clearance: 0 },
        uploadSurface: "evidence_document",
        audit: requestAudit,
        auditRepository,
        logAuditFailure
      })
    ).resolves.toBe(true);

    expect(auditRepository.appendDenied).not.toHaveBeenCalled();
    expect(logAuditFailure).not.toHaveBeenCalled();
  });

  it("denies an employee and awaits exactly one safe audit write", async () => {
    let finishAudit!: () => void;
    const auditRepository = {
      appendDenied: vi.fn(() => new Promise<void>((resolve) => (finishAudit = resolve)))
    };
    const completed = vi.fn();
    const result = authorizeFileUpload({
      employee,
      uploadSurface: "structured_dataset",
      audit: requestAudit,
      auditRepository,
      logAuditFailure: vi.fn()
    }).then((allowed) => {
      completed();
      return allowed;
    });

    await Promise.resolve();
    expect(completed).not.toHaveBeenCalled();
    expect(auditRepository.appendDenied).toHaveBeenCalledExactlyOnceWith({
      orgId: employee.orgId,
      actorEmployeeId: employee.id,
      uploadSurface: "structured_dataset",
      audit: requestAudit
    });
    finishAudit();
    await expect(result).resolves.toBe(false);
  });

  it("resolves a lazy audit repository only after denying the role", async () => {
    const repository = { appendDenied: vi.fn() };
    const auditRepository = vi.fn(() => repository);
    const input = {
      uploadSurface: "structured_dataset" as const,
      audit: requestAudit,
      auditRepository,
      logAuditFailure: vi.fn()
    };

    await expect(
      authorizeFileUpload({ ...input, employee: { ...employee, role: "admin" } })
    ).resolves.toBe(true);
    expect(auditRepository).not.toHaveBeenCalled();
    await expect(authorizeFileUpload({ ...input, employee })).resolves.toBe(false);
    expect(auditRepository).toHaveBeenCalledTimes(1);
    expect(repository.appendDenied).toHaveBeenCalledTimes(1);
  });

  it("still denies when the lazy audit repository cannot initialize", async () => {
    const logAuditFailure = vi.fn();
    const auditRepository = vi.fn(() => {
      throw new Error("private database configuration");
    });
    await expect(
      authorizeFileUpload({
        employee,
        uploadSurface: "evidence_document",
        audit: requestAudit,
        auditRepository,
        logAuditFailure
      })
    ).resolves.toBe(false);
    expect(auditRepository).toHaveBeenCalledTimes(1);
    expect(logAuditFailure).toHaveBeenCalledExactlyOnceWith({
      requestId: requestAudit.requestId,
      uploadSurface: "evidence_document"
    });
  });

  it("logs only request ID and surface on audit failure and still denies", async () => {
    const auditRepository = {
      appendDenied: vi.fn().mockRejectedValue(new Error("private database details"))
    };
    const logAuditFailure = vi.fn();

    await expect(
      authorizeFileUpload({
        employee,
        uploadSurface: "quarantine_certificate",
        audit: requestAudit,
        auditRepository,
        logAuditFailure
      })
    ).resolves.toBe(false);

    expect(auditRepository.appendDenied).toHaveBeenCalledTimes(1);
    expect(logAuditFailure).toHaveBeenCalledExactlyOnceWith({
      requestId: requestAudit.requestId,
      uploadSurface: "quarantine_certificate"
    });
  });

  it("returns the canonical non-retryable response with request provenance", () => {
    expect(fileUploadAdminRequiredResponse({ id: requestAudit.requestId } as never)).toEqual({
      error: {
        code: FILE_UPLOAD_ADMIN_REQUIRED_CODE,
        message: FILE_UPLOAD_ADMIN_REQUIRED_MESSAGE,
        retryable: false,
        details: {},
        requestId: requestAudit.requestId
      }
    });
  });
});

describe("Prisma upload authorization audit repository", () => {
  beforeEach(() => vi.clearAllMocks());

  it("persists only the fixed denial event, transport surface and request provenance", async () => {
    const repository = createPrismaUploadAuthorizationAuditRepository("mysql://test");

    await repository.appendDenied({
      orgId: employee.orgId,
      actorEmployeeId: employee.id,
      uploadSurface: "structured_dataset",
      audit: requestAudit
    });

    expect(AUDIT_ACTIONS.fileUploadDenied).toBe("file_upload.denied");
    expect(prisma.auditLog.create).toHaveBeenCalledExactlyOnceWith({
      data: {
        orgId: "org_1",
        actorEmployeeId: "emp_1",
        action: "file_upload.denied",
        targetType: "file_upload",
        targetId: null,
        result: "denied",
        metadata: { uploadSurface: "structured_dataset", reason: "admin_role_required" },
        requestId: "req_upload_1",
        clientIp: "198.51.100.10",
        clientSource: "mcp_launcher",
        launcherVersion: "0.5.2"
      }
    });
    await repository.disconnect?.();
    expect(prisma.$disconnect).toHaveBeenCalledTimes(1);
  });

  it("exposes only safe audit inputs and the three transport-level upload surfaces", () => {
    type DeniedInput = Parameters<UploadAuthorizationAuditRepository["appendDenied"]>[0];
    expectTypeOf<keyof DeniedInput>().toEqualTypeOf<
      "orgId" | "actorEmployeeId" | "uploadSurface" | "audit"
    >();
    expectTypeOf<DeniedInput["audit"]>().toEqualTypeOf<RequestAuditContext>();
    expectTypeOf<DeniedInput["uploadSurface"]>().toEqualTypeOf<FileUploadSurface>();
    expectTypeOf<FileUploadSurface>().toEqualTypeOf<
      "evidence_document" | "structured_dataset" | "quarantine_certificate"
    >();
  });
});
