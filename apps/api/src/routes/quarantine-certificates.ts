import { createHash, randomBytes } from "node:crypto";
import { extname } from "node:path";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { PUBLIC_INPUT_LIMITS, type AuthenticatedEmployee } from "@enterprise-hub/domain";
import type { CatalogLabel, DocumentCatalogRepository } from "../documents.js";
import {
  QUARANTINE_CERTIFICATE_LIMITS,
  QuarantineCertificateError,
  normalizeReceiptId,
  quarantineCertificateFingerprint,
  type QuarantineCertificateRecord,
  type QuarantineCertificateRepository
} from "../quarantine-certificates.js";
import type { RequestAuditContext } from "../request-audit-context.js";
import type { RequestAuth } from "../request-auth.js";
import { errorResponse, isPayloadTooLargeError, validationError } from "../request-errors.js";
import type { StorageAdapter } from "@enterprise-hub/storage";
import { readMultipartFile, type MultipartPart } from "../http/multipart.js";

interface ParsedQuarantineUpload {
  files: Array<{
    fileName: string;
    contentType?: string;
    body: Buffer;
  }>;
  receiptId?: string;
  idempotencyKey?: string;
  labelKeys: string[];
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

function uniqueSorted(values: string[]): string[] {
  return [...new Set(values.filter((value) => value.length > 0))].sort();
}

function forbiddenRequestedLabels(
  employee: AuthenticatedEmployee,
  labels: CatalogLabel[]
): string[] {
  if (employee.role === "admin") {
    return [];
  }

  return labels
    .filter((label) => label.type === "all_staff" || !employee.labels.includes(label.key))
    .map((label) => label.key)
    .sort();
}

async function parseUpload(request: FastifyRequest): Promise<ParsedQuarantineUpload> {
  const upload: ParsedQuarantineUpload = {
    files: [],
    labelKeys: []
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
    if (!value) continue;

    if (part.fieldname === "receiptId") {
      upload.receiptId = value;
      continue;
    }

    if (part.fieldname === "idempotencyKey") {
      upload.idempotencyKey = value;
      continue;
    }

    if (part.fieldname === "labelKeys[]" || part.fieldname === "labelKeys") {
      upload.labelKeys.push(value);
    }
  }

  upload.labelKeys = uniqueSorted(upload.labelKeys);
  return upload;
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
    uploadedAt: certificate.uploadedAt.toISOString()
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
    documents: () => DocumentCatalogRepository;
    storage: () => StorageAdapter;
    quarantineCertificates: () => QuarantineCertificateRepository;
    createBusinessRequestAudit: (request: FastifyRequest) => RequestAuditContext;
  }
): void {
  app.post("/v1/documents/quarantine-certificates", async (request, reply) => {
    const authenticated = await dependencies.auth.authenticate(request, reply);
    if (!authenticated) return;

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
      upload.idempotencyKey.length > QUARANTINE_CERTIFICATE_LIMITS.maxIdempotencyKeyChars ||
      upload.labelKeys.length === 0 ||
      upload.labelKeys.length > PUBLIC_INPUT_LIMITS.labelsPerRequest ||
      upload.labelKeys.some((labelKey) => labelKey.length > PUBLIC_INPUT_LIMITS.labelKeyChars)
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

    const employee = dependencies.auth.employee(request);
    const requestedLabels = await dependencies
      .documents()
      .findLabelsByKeys(employee.orgId, upload.labelKeys);
    const foundLabelKeys = new Set(requestedLabels.map((label) => label.key));
    if (upload.labelKeys.some((labelKey) => !foundLabelKeys.has(labelKey))) {
      return validationError(reply, "UNKNOWN_LABEL", "One or more labels do not exist.");
    }

    const forbiddenLabels = forbiddenRequestedLabels(employee, requestedLabels);
    if (forbiddenLabels.length > 0) {
      return reply
        .code(403)
        .send(errorResponse("FORBIDDEN_LABEL", "One or more labels cannot be assigned."));
    }

    const fileHash = createHash("sha256").update(file.body).digest("hex");
    const requestFingerprint = quarantineCertificateFingerprint({
      receiptId: normalizedReceiptId,
      labelKeys: upload.labelKeys,
      fileHash
    });
    const existing = await dependencies
      .quarantineCertificates()
      .findByIdempotencyKey(employee.orgId, upload.idempotencyKey);
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
        idempotencyKey: upload.idempotencyKey,
        requestFingerprint,
        fileType,
        storageObjectKey: storedObject.key,
        originalFileName: file.fileName,
        contentType: file.contentType ?? (fileType === "png" ? "image/png" : "image/jpeg"),
        byteSize: storedObject.size,
        checksumSha256: storedObject.hash,
        labelIds: requestedLabels.map((label) => label.id),
        labelKeys: requestedLabels.map((label) => label.key).sort(),
        audit: dependencies.createBusinessRequestAudit(request)
      });

      return reply.code(201).send(certificateResponse(certificate));
    } catch (error) {
      await dependencies.storage().deleteObject(storedObject.key);
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

    if (receiptId) {
      if (employee.role !== "admin") {
        return reply
          .code(403)
          .send(errorResponse("FORBIDDEN", "Only admins can archive by receipt ID."));
      }
      const archivedCount = await dependencies.quarantineCertificates().archiveByReceiptId({
        orgId: employee.orgId,
        employee,
        receiptId,
        audit
      });
      return { archivedCount };
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

    return { archivedCount };
  });
}
