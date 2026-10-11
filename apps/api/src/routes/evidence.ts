import { ResourceAttributesError } from "@smedc/db";
import type { BusinessScopeItem } from "@smedc/domain";
import { randomBytes } from "node:crypto";
import {
  authorizeFileUpload,
  fileUploadAdminRequiredResponse,
  type UploadAuthorizationAuditRepository
} from "../file-upload-authorization.js";
import { extname } from "node:path";
import type { FastifyInstance, FastifyRequest } from "fastify";
import {
  DEFAULT_RETRIEVAL_CONFIG_VERSION,
  PHASE3_ERROR_CODES,
  PUBLIC_INPUT_LIMITS,
  isAllowedFileTypeForDocumentKind,
  type Phase3FileType
} from "@smedc/domain";
import type { DocumentCatalogRepository, DocumentStatusRecord } from "../documents.js";
import { EvidenceSearchCursorError, type EvidenceSearchRepository } from "../evidence.js";
import type { RequestAuditContext } from "../request-audit-context.js";
import type { RequestAuth } from "../request-auth.js";
import type { SourceDocumentDownloadIssuer } from "../source-document-downloads.js";
import {
  errorResponse,
  isPayloadTooLargeError,
  phase3ErrorResponse,
  validationError
} from "../request-errors.js";
import type { StorageAdapter } from "@smedc/storage";
import { readMultipartFile, type MultipartPart } from "../http/multipart.js";

interface ParsedUpload {
  businessCategoryId?: string;
  businessScopes?: unknown;
  businessCategoryFieldCount: number;
  businessScopesFieldCount: number;
  file?: {
    fileName: string;
    contentType?: string;
    body: Buffer;
  };
  title?: string;
  sourceSystem?: string;
  confidentialityLevel?: string;
  confidentialityLevelFieldCount: number;
}

interface EvidenceSearchBody {
  query?: unknown;
  filters?: {
    fileTypes?: unknown;
    documentIds?: unknown;
  };
  limit?: unknown;
  cursor?: unknown;
}

type EvidenceFilterGroupResult =
  { ok: true; values: string[] } | { ok: false; limitExceeded: boolean };

type EvidenceSearchValidation =
  | {
      ok: true;
      query: string;
      filters: {
        fileTypes: string[];
        documentIds: string[];
      };
      limit: number;
      cursor: string | null;
    }
  | {
      ok: false;
      code: string;
      message: string;
    };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function uniqueSorted(values: string[]): string[] {
  return [...new Set(values.filter((value) => value.length > 0))].sort();
}

function createDocumentId(): string {
  return `doc_${randomBytes(12).toString("hex")}`;
}

function fileTypeFromFilename(fileName: string): Phase3FileType | null {
  const extension = extname(fileName).toLowerCase().replace(/^\./, "");
  return isAllowedFileTypeForDocumentKind("evidence", extension) ? extension : null;
}

async function parseUpload(request: FastifyRequest): Promise<ParsedUpload> {
  const upload: ParsedUpload = {
    confidentialityLevelFieldCount: 0,
    businessCategoryFieldCount: 0,
    businessScopesFieldCount: 0
  };

  const multipartRequest = request as unknown as { parts(): AsyncIterable<MultipartPart> };

  for await (const part of multipartRequest.parts()) {
    if (part.type === "file") {
      if (part.fieldname !== "file") {
        continue;
      }

      upload.file = {
        fileName: part.filename,
        contentType: part.mimetype,
        body: await readMultipartFile(part.file)
      };
      continue;
    }

    const value = typeof part.value === "string" ? part.value.trim() : "";

    if (part.fieldname === "confidentialityLevel") {
      upload.confidentialityLevelFieldCount += 1;
      upload.confidentialityLevel = value;
      continue;
    }

    if (part.fieldname === "categoryId") {
      upload.businessCategoryFieldCount += 1;
      upload.businessCategoryId = value;
      continue;
    }
    if (part.fieldname === "scopes") {
      upload.businessScopesFieldCount += 1;
      upload.businessScopes = JSON.parse(value);
      continue;
    }

    if (part.fieldname === "title") {
      upload.title = value;
      continue;
    }

    if (part.fieldname === "sourceSystem") {
      upload.sourceSystem = value;
    }
  }

  return upload;
}

function evidenceFilterGroup(
  value: unknown,
  allowedValues?: ReadonlySet<string>
): EvidenceFilterGroupResult {
  if (value === undefined) {
    return { ok: true, values: [] };
  }

  if (!Array.isArray(value)) {
    return { ok: false, limitExceeded: false };
  }

  if (value.length > PUBLIC_INPUT_LIMITS.evidenceFilterIdsPerGroup) {
    return { ok: false, limitExceeded: true };
  }

  const values: string[] = [];
  for (const item of value) {
    if (typeof item !== "string" || item.trim().length === 0) {
      return { ok: false, limitExceeded: false };
    }

    const normalized = item.trim();
    if (
      normalized.length > PUBLIC_INPUT_LIMITS.evidenceFilterIdChars ||
      (allowedValues && !allowedValues.has(normalized))
    ) {
      return { ok: false, limitExceeded: !allowedValues };
    }

    values.push(normalized);
  }

  return { ok: true, values: uniqueSorted(values) };
}

function validateEvidenceSearchBody(value: unknown): EvidenceSearchValidation {
  if (!isRecord(value)) {
    return {
      ok: false,
      code: PHASE3_ERROR_CODES.invalidQuery,
      message: "Query is required."
    };
  }

  if (typeof value.query !== "string" || value.query.trim().length === 0) {
    return {
      ok: false,
      code: PHASE3_ERROR_CODES.invalidQuery,
      message: "Query is required."
    };
  }

  if (value.query.length > PUBLIC_INPUT_LIMITS.evidenceQueryChars) {
    return {
      ok: false,
      code: PHASE3_ERROR_CODES.limitExceeded,
      message: "Query exceeds the allowed limit."
    };
  }

  const limit = value.limit === undefined ? 10 : value.limit;
  if (typeof limit !== "number" || !Number.isInteger(limit) || limit < 1 || limit > 50) {
    return {
      ok: false,
      code: PHASE3_ERROR_CODES.limitExceeded,
      message: "Limit must be 1-50."
    };
  }

  let cursor: string | null = null;
  if (value.cursor !== undefined && value.cursor !== null) {
    if (typeof value.cursor !== "string") {
      return {
        ok: false,
        code: PHASE3_ERROR_CODES.invalidCursor,
        message: "Cursor is invalid."
      };
    }

    if (value.cursor.length > PUBLIC_INPUT_LIMITS.cursorChars) {
      return {
        ok: false,
        code: PHASE3_ERROR_CODES.invalidCursor,
        message: "Cursor exceeds the allowed limit."
      };
    }

    cursor = value.cursor.trim() || null;
  }

  const filtersValue = value.filters;
  if (filtersValue !== undefined && !isRecord(filtersValue)) {
    return {
      ok: false,
      code: PHASE3_ERROR_CODES.invalidQuery,
      message: "Evidence filters are invalid."
    };
  }

  const filters = filtersValue as Record<string, unknown> | undefined;
  const fileTypes = evidenceFilterGroup(filters?.fileTypes, new Set(["md", "txt", "docx"]));
  const documentIds = evidenceFilterGroup(filters?.documentIds);
  if (!fileTypes.ok || !documentIds.ok) {
    const limitExceeded =
      (!fileTypes.ok && fileTypes.limitExceeded) || (!documentIds.ok && documentIds.limitExceeded);
    return {
      ok: false,
      code: limitExceeded ? PHASE3_ERROR_CODES.limitExceeded : PHASE3_ERROR_CODES.invalidQuery,
      message: limitExceeded
        ? "Evidence filters exceed the allowed limit."
        : "Evidence filters are invalid."
    };
  }

  return {
    ok: true,
    query: value.query.trim(),
    filters: {
      fileTypes: fileTypes.values,
      documentIds: documentIds.values
    },
    limit,
    cursor
  };
}

function parseConfidentialityLevel(upload: ParsedUpload): number | null {
  if (upload.confidentialityLevelFieldCount === 0) return null;
  if (
    upload.confidentialityLevelFieldCount !== 1 ||
    !/^[0-3]$/.test(upload.confidentialityLevel ?? "")
  ) {
    return null;
  }
  return Number(upload.confidentialityLevel);
}

function evidenceUploadResponse(document: DocumentStatusRecord, retrievalConfigVersion: string) {
  return {
    document: {
      documentId: document.id,
      documentKind: "evidence",
      fileType: document.fileType,
      status: document.status
    },
    processing: {
      processingRunId: null,
      status: document.processingRunStatus
    },
    documentIndex: {
      status: document.documentIndexStatus ?? "pending",
      retrievalConfigVersion
    }
  };
}

function evidenceStatusResponse(document: DocumentStatusRecord, retrievalConfigVersion: string) {
  return {
    document: {
      documentId: document.id,
      documentKind: document.documentKind,
      fileType: document.fileType,
      title: document.title,
      status: document.status,
      confidentialityLevel: document.confidentialityLevel,
      originalFileName: document.originalFileName,
      sourceSystem: document.sourceSystem
    },
    processing: {
      processingRunId: null,
      status: document.processingRunStatus
    },
    documentIndex: {
      status: document.documentIndexStatus ?? "pending",
      retrievalConfigVersion: document.documentIndexRetrievalConfigVersion ?? retrievalConfigVersion
    }
  };
}

export function registerEvidenceRoutes(
  app: FastifyInstance,
  dependencies: {
    auth: RequestAuth;
    documents: () => DocumentCatalogRepository;
    storage: () => StorageAdapter;
    evidence: () => EvidenceSearchRepository;
    sourceDocumentDownloads: () => SourceDocumentDownloadIssuer;
    cursorSigningSecret: string;
    retrievalConfigVersion?: string;
    createBusinessRequestAudit: (request: FastifyRequest) => RequestAuditContext;
    uploadAuthorizationAudit: () => UploadAuthorizationAuditRepository;
  }
): void {
  app.post("/v1/documents/evidence", async (request, reply) => {
    const authenticated = await dependencies.auth.authenticate(request, reply);

    if (!authenticated) {
      return;
    }

    const employee = dependencies.auth.employee(request);
    const allowed = await authorizeFileUpload({
      employee,
      uploadSurface: "evidence_document",
      audit: dependencies.createBusinessRequestAudit(request),
      auditRepository: dependencies.uploadAuthorizationAudit,
      logAuditFailure: (context) => request.log.error(context, "upload denial audit failed")
    });
    if (!allowed) return reply.code(403).send(fileUploadAdminRequiredResponse(request));

    let upload: ParsedUpload;

    try {
      upload = await parseUpload(request);
    } catch (error) {
      if (isPayloadTooLargeError(error)) {
        throw error;
      }

      return validationError(reply, "INVALID_EVIDENCE_UPLOAD", "Multipart upload is invalid.");
    }

    if (!upload.file) {
      return validationError(reply, "INVALID_EVIDENCE_UPLOAD", "File is required.");
    }

    if (!upload.title) {
      return validationError(reply, "INVALID_EVIDENCE_UPLOAD", "Title is required.");
    }

    if (
      upload.file.fileName.length > PUBLIC_INPUT_LIMITS.uploadFilenameChars ||
      upload.title.length > PUBLIC_INPUT_LIMITS.evidenceTitleChars ||
      (upload.sourceSystem?.length ?? 0) > PUBLIC_INPUT_LIMITS.sourceSystemChars
    ) {
      return validationError(
        reply,
        "INVALID_EVIDENCE_UPLOAD",
        "Evidence upload metadata exceeds the allowed limit."
      );
    }

    const fileType = fileTypeFromFilename(upload.file.fileName);

    if (!fileType) {
      return validationError(
        reply,
        PHASE3_ERROR_CODES.invalidDocumentKindFileType,
        "Evidence documents must be .md, .txt, or .docx files."
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
      !upload.businessCategoryId ||
      upload.businessCategoryFieldCount !== 1 ||
      upload.businessScopesFieldCount !== 1 ||
      !Array.isArray(upload.businessScopes) ||
      !upload.businessScopes.length ||
      !upload.businessScopes.every(
        (scope) =>
          isRecord(scope) &&
          typeof scope.enterpriseKey === "string" &&
          !!scope.enterpriseKey &&
          (scope.ownership === "group"
            ? scope.storeName === undefined
            : scope.ownership === "store" &&
              typeof scope.storeName === "string" &&
              !!scope.storeName.trim()) &&
          isRecord(scope.dimensions) &&
          Object.values(scope.dimensions).every((value) => typeof value === "string" && !!value)
      )
    )
      return validationError(
        reply,
        "RESOURCE_ATTRIBUTES_NOT_READY",
        "Evidence requires an existing category and complete explicit business scopes."
      );

    const audit = dependencies.createBusinessRequestAudit(request);
    const orgId = employee.orgId;
    const documentId = createDocumentId();
    const storedObject = await dependencies.storage().putObject({
      orgId,
      documentId,
      fileName: upload.file.fileName,
      body: upload.file.body,
      contentType: upload.file.contentType
    });

    try {
      const document = await dependencies.documents().createUploadedDocument({
        id: documentId,
        orgId,
        title: upload.title,
        documentType: "management_knowledge",
        documentKind: "evidence",
        fileType,
        status: "pending_processing",
        storageObjectKey: storedObject.key,
        originalFileName: upload.file.fileName,
        contentType: storedObject.contentType,
        byteSize: storedObject.size,
        checksumSha256: storedObject.hash,
        uploaderId: employee.id,
        sourceSystem: upload.sourceSystem || null,
        sourceTime: null,
        confidentialityLevel,
        businessCategoryId: upload.businessCategoryId,
        businessScopes: upload.businessScopes as BusinessScopeItem[],
        processingJobType: "evidence_document_index",
        audit
      });

      return reply
        .code(202)
        .send(
          evidenceUploadResponse(
            document,
            dependencies.retrievalConfigVersion ?? DEFAULT_RETRIEVAL_CONFIG_VERSION
          )
        );
    } catch (error) {
      await dependencies.storage().deleteObject(storedObject.key);
      if (error instanceof ResourceAttributesError)
        return validationError(reply, error.code, "Evidence business attributes are not ready.");
      request.log.error({ err: error, documentId }, "evidence document catalog write failed");
      return reply
        .code(500)
        .send(errorResponse("DOCUMENT_CATALOG_WRITE_FAILED", "Document catalog write failed."));
    }
  });

  app.get<{ Params: { documentId: string } }>(
    "/v1/documents/evidence/:documentId/status",
    async (request, reply) => {
      const authenticated = await dependencies.auth.authenticate(request, reply);

      if (!authenticated) {
        return;
      }

      const employee = dependencies.auth.employee(request);
      const document = await dependencies
        .documents()
        .findEvidenceDocumentStatus(employee.orgId, request.params.documentId);

      if (!document) {
        return reply.code(404).send(errorResponse("DOCUMENT_NOT_FOUND", "Document not found."));
      }

      if (
        employee.role !== "admin" &&
        (document.uploaderId !== employee.id || employee.clearance < document.confidentialityLevel)
      ) {
        return reply.code(404).send(errorResponse("DOCUMENT_NOT_FOUND", "Document not found."));
      }

      return evidenceStatusResponse(
        document,
        dependencies.retrievalConfigVersion ?? DEFAULT_RETRIEVAL_CONFIG_VERSION
      );
    }
  );

  app.post<{ Body: EvidenceSearchBody }>("/v1/evidence/search", async (request, reply) => {
    const authenticated = await dependencies.auth.authenticate(request, reply);

    if (!authenticated) {
      return;
    }

    const validation = validateEvidenceSearchBody(request.body);
    if (!validation.ok) {
      return validationError(reply, validation.code, validation.message);
    }

    const { query, filters, limit, cursor } = validation;
    const employee = dependencies.auth.employee(request);
    const audit = dependencies.createBusinessRequestAudit(request);
    let result;
    try {
      result = await dependencies.evidence().searchEvidence({
        orgId: employee.orgId,
        employee,
        query,
        filters,
        limit,
        cursor,
        cursorSecret: dependencies.cursorSigningSecret,
        audit
      });
    } catch (error) {
      if (error instanceof EvidenceSearchCursorError) {
        return reply.code(400).send(phase3ErrorResponse(request, error.code, error.message));
      }

      throw error;
    }

    const sourceDownloads =
      result.results.length === 0
        ? { sources: [], warnings: [] }
        : await dependencies.sourceDocumentDownloads().issueMany({
            orgId: employee.orgId,
            employee,
            requestedSources: result.results.map((item) => ({
              sourceDocumentId: item.documentId,
              documentTitle: item.documentTitle
            })),
            audit,
            reason: "evidence_search_auto"
          });

    return {
      ...result,
      sources: sourceDownloads.sources,
      warnings: [...new Set([...result.warnings, ...sourceDownloads.warnings])],
      requestId: request.id
    };
  });
}
