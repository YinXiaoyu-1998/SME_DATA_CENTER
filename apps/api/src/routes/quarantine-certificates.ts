import { ResourceAttributesError } from "@smedc/db";
import { normalizeEnterpriseIdentity } from "@smedc/domain";
import { createHash, randomBytes } from "node:crypto";
import {
  authorizeFileUpload,
  fileUploadAdminRequiredResponse,
  type UploadAuthorizationAuditRepository
} from "../file-upload-authorization.js";
import { extname } from "node:path";
import type { FastifyInstance, FastifyRequest } from "fastify";
import {
  QUARANTINE_CERTIFICATE_LIMITS,
  QuarantineCertificateError,
  normalizeReceiptId,
  quarantineCertificateFingerprint,
  type QuarantineCertificateRecord,
  type QuarantineCertificateRepository
} from "../quarantine-certificates.js";
import type { RequestAuditContext } from "../request-audit-context.js";
import {
  canPerformPrivilegedAdministrativeOperation,
  PRIVILEGED_ADMIN_OPERATIONS
} from "../privileged-admin-operations.js";
import type { RequestAuth } from "../request-auth.js";
import { errorResponse, isPayloadTooLargeError, validationError } from "../request-errors.js";
import type { StorageAdapter } from "@smedc/storage";
import { readMultipartFile, type MultipartPart } from "../http/multipart.js";

interface ParsedQuarantineUpload {
  historicalSupplementReason?: string;
  enterpriseName?: string;
  storeName?: string;
  enterpriseFieldCount: number;
  storeFieldCount: number;
  files: Array<{
    fileName: string;
    contentType?: string;
    body: Buffer;
  }>;
  receiptId?: string;
  idempotencyKey?: string;
  confidentialityLevel?: string;
  confidentialityLevelFieldCount: number;
}

interface QueryBody {
  receiptIds?: unknown;
}

interface ArchiveBody {
  sourceDocumentId?: unknown;
  receiptId?: unknown;
}

function createDocumentId(): string {
  return `doc_${randomBytes(12).toString("hex")}`;
}

async function parseUpload(request: FastifyRequest): Promise<ParsedQuarantineUpload> {
  const upload: ParsedQuarantineUpload = {
    files: [],
    enterpriseFieldCount: 0,
    storeFieldCount: 0,
    confidentialityLevelFieldCount: 0
  };
  const multipartRequest = request as unknown as { parts(): AsyncIterable<MultipartPart> };

  for await (const part of multipartRequest.parts()) {
    if (part.type === "file") {
      if (part.fieldname === "file") {
        upload.files.push({
          fileName: part.filename,
          contentType: part.mimetype,
          body: await readMultipartFile(part.file)
        });
      }
      continue;
    }

    const value = typeof part.value === "string" ? part.value.trim() : "";
    if (part.fieldname === "historicalSupplementReason") {
      if (upload.historicalSupplementReason !== undefined || !value || value.length > 2048)
        throw new ResourceAttributesError("RESOURCE_HISTORICAL_REASON_REQUIRED");
      upload.historicalSupplementReason = value;
      continue;
    }
    if (!value) continue;

    if (part.fieldname === "enterpriseName" || part.fieldname === "enterprise_name") {
      upload.enterpriseFieldCount += 1;
      upload.enterpriseName = value;
      continue;
    }
    if (part.fieldname === "storeName") {
      upload.storeFieldCount += 1;
      upload.storeName = typeof part.value === "string" ? part.value : "";
      continue;
    }

    if (part.fieldname === "receiptId") {
      upload.receiptId = value;
      continue;
    }

    if (part.fieldname === "idempotencyKey") {
      upload.idempotencyKey = value;
      continue;
    }

    if (part.fieldname === "confidentialityLevel") {
      upload.confidentialityLevelFieldCount += 1;
      upload.confidentialityLevel = value;
    }
  }

  return upload;
}

function parseConfidentialityLevel(upload: ParsedQuarantineUpload): number | null {
  if (upload.confidentialityLevelFieldCount === 0) return 0;
  if (
    upload.confidentialityLevelFieldCount !== 1 ||
    !/^[0-3]$/.test(upload.confidentialityLevel ?? "")
  ) {
    return null;
  }
  return Number(upload.confidentialityLevel);
}

function imageFileType(input: {
  fileName: string;
  contentType?: string;
  body: Buffer;
}): "jpg" | "jpeg" | "png" | null {
  const extension = extname(input.fileName).toLowerCase().replace(/^\./, "");
  if (extension !== "jpg" && extension !== "jpeg" && extension !== "png") {
    return null;
  }

  const expectedContentType = extension === "png" ? "image/png" : "image/jpeg";
  if (input.contentType !== expectedContentType) {
    return null;
  }

  if (extension === "png") {
    const pngSignature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    return input.body.subarray(0, pngSignature.length).equals(pngSignature) ? "png" : null;
  }

  return input.body[0] === 0xff && input.body[1] === 0xd8 ? (extension as "jpg" | "jpeg") : null;
}

function certificateResponse(certificate: QuarantineCertificateRecord) {
  return {
    sourceDocumentId: certificate.sourceDocumentId,
    receiptId: certificate.receiptId,
    originalFileName: certificate.originalFileName,
    contentType: certificate.contentType,
    byteSize: certificate.byteSize,
    uploadedAt: certificate.uploadedAt.toISOString(),
    affectedLedgerPartitions: certificate.affectedLedgerPartitions ?? []
  };
}

function normalizeReceiptIds(input: unknown): string[] | null {
  if (!Array.isArray(input) || input.length === 0 || input.length > 100) {
    return null;
  }

  const receiptIds: string[] = [];
  for (const value of input) {
    if (typeof value !== "string") return null;
    const normalized = normalizeReceiptId(value);
    if (!normalized || normalized.length > QUARANTINE_CERTIFICATE_LIMITS.maxReceiptIdChars) {
      return null;
    }
    if (!receiptIds.includes(normalized)) {
      receiptIds.push(normalized);
    }
  }

  return receiptIds;
}

export function registerQuarantineCertificateRoutes(
  app: FastifyInstance,
  dependencies: {
    auth: RequestAuth;
    storage: () => StorageAdapter;
    quarantineCertificates: () => QuarantineCertificateRepository;
    createBusinessRequestAudit: (request: FastifyRequest) => RequestAuditContext;
    uploadAuthorizationAudit: () => UploadAuthorizationAuditRepository;
  }
): void {
  app.post("/v1/documents/quarantine-certificates", async (request, reply) => {
    const authenticated = await dependencies.auth.authenticate(request, reply);
    if (!authenticated) return;

    const employee = dependencies.auth.employee(request);
    const allowed = await authorizeFileUpload({
      employee,
      uploadSurface: "quarantine_certificate",
      audit: dependencies.createBusinessRequestAudit(request),
      auditRepository: dependencies.uploadAuthorizationAudit,
      logAuditFailure: (context) => request.log.error(context, "upload denial audit failed")
    });
    if (!allowed) return reply.code(403).send(fileUploadAdminRequiredResponse(request));

    let upload: ParsedQuarantineUpload;
    try {
      upload = await parseUpload(request);
    } catch (error) {
      if (isPayloadTooLargeError(error)) throw error;
      return validationError(
        reply,
        "INVALID_QUARANTINE_CERTIFICATE_UPLOAD",
        "Multipart upload is invalid."
      );
    }

    if (upload.files.length !== 1) {
      return validationError(
        reply,
        "INVALID_QUARANTINE_CERTIFICATE_UPLOAD",
        "Exactly one file is required."
      );
    }

    const normalizedReceiptId = upload.receiptId ? normalizeReceiptId(upload.receiptId) : "";
    if (
      !normalizedReceiptId ||
      normalizedReceiptId.length > QUARANTINE_CERTIFICATE_LIMITS.maxReceiptIdChars ||
      !upload.idempotencyKey ||
      upload.idempotencyKey.length > QUARANTINE_CERTIFICATE_LIMITS.maxIdempotencyKeyChars
    ) {
      return validationError(
        reply,
        "INVALID_QUARANTINE_CERTIFICATE_UPLOAD",
        "Quarantine certificate upload metadata is invalid."
      );
    }

    const file = upload.files[0]!;
    if (file.body.byteLength > QUARANTINE_CERTIFICATE_LIMITS.maxImageBytes) {
      return reply
        .code(413)
        .send(errorResponse("PAYLOAD_TOO_LARGE", "Request payload is too large."));
    }

    const fileType = imageFileType(file);
    if (!fileType) {
      return validationError(
        reply,
        "INVALID_QUARANTINE_CERTIFICATE_IMAGE",
        "Quarantine certificate must be a JPG or PNG image."
      );
    }

    const confidentialityLevel = parseConfidentialityLevel(upload);
    if (confidentialityLevel === null) {
      return validationError(
        reply,
        "INVALID_CONFIDENTIALITY_LEVEL",
        "Confidentiality level must be an integer from 0 through 3."
      );
    }

    if (
      !upload.enterpriseName ||
      upload.enterpriseName.length > 128 ||
      upload.enterpriseFieldCount !== 1 ||
      !upload.storeName?.trim() ||
      upload.storeName.length > 255 ||
      upload.storeFieldCount !== 1
    )
      return validationError(
        reply,
        "RESOURCE_SINGLE_STORE_REQUIRED",
        "A photo requires one explicit enterprise and store name."
      );
    const enterpriseKey = normalizeEnterpriseIdentity(upload.enterpriseName).enterpriseKey;

    const fileHash = createHash("sha256").update(file.body).digest("hex");
    const requestFingerprint = quarantineCertificateFingerprint({
      receiptId: normalizedReceiptId,
      historicalSupplementReason: upload.historicalSupplementReason,
      enterpriseKey,
      storeName: upload.storeName,
      confidentialityLevel,
      fileHash
    });
    const existing = await dependencies
      .quarantineCertificates()
      .findByIdempotencyKey(employee.orgId, upload.idempotencyKey, employee.id);
    if (existing) {
      if (existing.requestFingerprint !== requestFingerprint) {
        return reply
          .code(409)
          .send(
            errorResponse(
              "IDEMPOTENCY_KEY_CONFLICT",
              "Idempotency key was reused with different certificate content."
            )
          );
      }

      return reply.code(201).send(certificateResponse(existing));
    }

    const sourceDocumentId = createDocumentId();
    const storedObject = await dependencies.storage().putObject({
      orgId: employee.orgId,
      documentId: sourceDocumentId,
      fileName: file.fileName,
      body: file.body,
      contentType: file.contentType
    });

    try {
      const certificate = await dependencies.quarantineCertificates().createCertificate({
        orgId: employee.orgId,
        actorEmployeeId: employee.id,
        sourceDocumentId,
        title: `检疫证明 ${normalizedReceiptId} - ${file.fileName}`,
        receiptId: normalizedReceiptId,
        historicalSupplementReason: upload.historicalSupplementReason,
        enterpriseKey,
        storeName: upload.storeName,
        idempotencyKey: upload.idempotencyKey,
        requestFingerprint,
        fileType,
        storageObjectKey: storedObject.key,
        originalFileName: file.fileName,
        contentType: file.contentType ?? (fileType === "png" ? "image/png" : "image/jpeg"),
        byteSize: storedObject.size,
        checksumSha256: storedObject.hash,
        confidentialityLevel,
        audit: dependencies.createBusinessRequestAudit(request)
      });

      return reply.code(201).send(certificateResponse(certificate));
    } catch (error) {
      await dependencies.storage().deleteObject(storedObject.key);
      if (error instanceof ResourceAttributesError)
        return validationError(
          reply,
          error.code,
          "Photo business attributes are not ready or do not match the receipt store."
        );
      if (error instanceof QuarantineCertificateError) {
        return reply.code(409).send(errorResponse(error.code, error.message));
      }

      throw error;
    }
  });

  app.post<{ Body: QueryBody }>("/v1/quarantine-certificates/query", async (request, reply) => {
    const authenticated = await dependencies.auth.authenticate(request, reply);
    if (!authenticated) return;

    const receiptIds = normalizeReceiptIds(request.body?.receiptIds);
    if (!receiptIds) {
      return validationError(
        reply,
        "INVALID_QUARANTINE_CERTIFICATE_QUERY",
        "receiptIds must contain 1-100 receipt IDs."
      );
    }

    const employee = dependencies.auth.employee(request);
    const certificates = await dependencies.quarantineCertificates().queryVisibleByReceiptIds({
      orgId: employee.orgId,
      employee,
      authorization: await dependencies.auth.authorization(request),
      receiptIds
    });
    const certificatesByReceiptId = new Map<string, ReturnType<typeof certificateResponse>[]>();
    for (const certificate of certificates) {
      const group = certificatesByReceiptId.get(certificate.receiptId) ?? [];
      group.push(certificateResponse(certificate));
      certificatesByReceiptId.set(certificate.receiptId, group);
    }

    return {
      results: receiptIds.map((receiptId) => ({
        receiptId,
        certificates: certificatesByReceiptId.get(receiptId) ?? []
      }))
    };
  });

  app.post<{ Body: ArchiveBody }>("/v1/quarantine-certificates/archive", async (request, reply) => {
    const authenticated = await dependencies.auth.authenticate(request, reply);
    if (!authenticated) return;

    const sourceDocumentId =
      typeof request.body?.sourceDocumentId === "string"
        ? request.body.sourceDocumentId.trim()
        : "";
    const receiptId =
      typeof request.body?.receiptId === "string" ? normalizeReceiptId(request.body.receiptId) : "";
    if (
      (sourceDocumentId.length === 0 && receiptId.length === 0) ||
      (sourceDocumentId.length > 0 && receiptId.length > 0) ||
      receiptId.length > QUARANTINE_CERTIFICATE_LIMITS.maxReceiptIdChars
    ) {
      return validationError(
        reply,
        "INVALID_QUARANTINE_CERTIFICATE_ARCHIVE",
        "Provide exactly one of sourceDocumentId or receiptId."
      );
    }

    const employee = dependencies.auth.employee(request);
    const audit = dependencies.createBusinessRequestAudit(request);

    {
      if (!canPerformPrivilegedAdministrativeOperation(employee, "archiveQuarantineCertificates")) {
        return reply
          .code(403)
          .send(
            errorResponse(
              "FORBIDDEN",
              `${PRIVILEGED_ADMIN_OPERATIONS.archiveQuarantineCertificates.description} is admin-only.`
            )
          );
      }
    }
    if (receiptId) {
      const archivedCount = await dependencies.quarantineCertificates().archiveByReceiptId({
        orgId: employee.orgId,
        employee,
        receiptId,
        audit
      });
      return typeof archivedCount === "number"
        ? { archivedCount, affectedLedgerPartitions: [] }
        : archivedCount;
    }

    const archivedCount = await dependencies.quarantineCertificates().archiveBySourceDocumentId({
      orgId: employee.orgId,
      employee,
      sourceDocumentId,
      audit
    });
    if (archivedCount === null) {
      return reply
        .code(404)
        .send(
          errorResponse("QUARANTINE_CERTIFICATE_NOT_FOUND", "Quarantine certificate not found.")
        );
    }

    return typeof archivedCount === "number"
      ? { archivedCount, affectedLedgerPartitions: [] }
      : archivedCount;
  });
}
