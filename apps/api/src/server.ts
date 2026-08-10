import { createHash, randomBytes, randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import Fastify, { type FastifyRequest } from "fastify";
import {
  canEmployeeAccessDocument,
  PHASE3_FILE_TYPES,
  PHASE3_ERROR_CODES,
  PUBLIC_INPUT_LIMITS,
  type AuthenticatedEmployee,
  type Phase3FileType,
  type StructuredDatasetName
} from "@enterprise-hub/domain";
import { parseStructuredFile } from "@enterprise-hub/structured-ingestion";
import { createOriginalObjectKey } from "@enterprise-hub/storage";
import { type CatalogLabel } from "./documents.js";
import {
  StructuredImportError,
  type StructuredImportBatchRecord,
  type StructuredImportRepository,
  type StructuredImportTimingEvent
} from "./structured-imports.js";
import { registerMcpHttpRoute } from "./mcp/http.js";
import { registerOfficialAuthRoutes } from "./auth/routes.js";
import {
  errorResponse,
  isPayloadTooLargeError,
  registerApiErrorHandler,
  validationError
} from "./request-errors.js";
import { isTrustedLoopbackProxy, normalizeRequestId } from "./request-audit-context.js";
import { createApiServerContext, type ApiServerOptions } from "./app-context.js";
import { createRequestAuth, type AuthenticatedRequest } from "./request-auth.js";
import { readMultipartFile, registerApiMultipart, type MultipartPart } from "./http/multipart.js";
import { registerSystemRoutes } from "./routes/system.js";
import { registerCatalogRoutes } from "./routes/catalog.js";
import { registerStructuredQueryRoutes } from "./routes/structured-query.js";
import { registerEvidenceRoutes } from "./routes/evidence.js";

export type { ApiServerOptions } from "./app-context.js";

interface ParsedStructuredImportUpload {
  file?: {
    fileName: string;
    contentType?: string;
    body: Buffer;
  };
  dataset?: string;
  enterpriseName?: string;
  startDate?: string;
  endDate?: string;
  idempotencyKey?: string;
  labelKeys: string[];
}

function createDocumentId(): string {
  return `doc_${randomBytes(12).toString("hex")}`;
}

function uniqueSorted(values: string[]): string[] {
  return [...new Set(values.filter((value) => value.length > 0))].sort();
}

async function parseStructuredImportUpload(
  request: FastifyRequest
): Promise<ParsedStructuredImportUpload> {
  const upload: ParsedStructuredImportUpload = {
    labelKeys: []
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

    if (["labelKeys[]", "labelKeys", "labelIds[]", "labelIds"].includes(part.fieldname)) {
      if (value) {
        upload.labelKeys.push(value);
      }
      continue;
    }

    if (part.fieldname === "dataset") {
      upload.dataset = value;
      continue;
    }

    if (part.fieldname === "enterprise_name" || part.fieldname === "enterpriseName") {
      upload.enterpriseName = value;
      continue;
    }

    if (part.fieldname === "startDate") {
      upload.startDate = value;
      continue;
    }

    if (part.fieldname === "endDate") {
      upload.endDate = value;
      continue;
    }

    if (part.fieldname === "idempotencyKey") {
      upload.idempotencyKey = value;
    }
  }

  upload.labelKeys = uniqueSorted(upload.labelKeys);
  return upload;
}

function validateStructuredImportMetadata(upload: ParsedStructuredImportUpload):
  | {
      ok: true;
      dataset: StructuredDatasetName;
      fileType: Extract<Phase3FileType, "xlsx" | "csv">;
      startDate: string;
      endDate: string;
    }
  | {
      ok: false;
      code: string;
      message: string;
    } {
  if (!upload.file) {
    return {
      ok: false,
      code: "INVALID_STRUCTURED_IMPORT_UPLOAD",
      message: "File is required."
    };
  }

  if (upload.file.fileName.length > PUBLIC_INPUT_LIMITS.uploadFilenameChars) {
    return {
      ok: false,
      code: "INVALID_STRUCTURED_IMPORT_UPLOAD",
      message: "Filename exceeds the allowed limit."
    };
  }

  if (!upload.dataset || !["dishes", "business"].includes(upload.dataset)) {
    return {
      ok: false,
      code: "INVALID_STRUCTURED_IMPORT_UPLOAD",
      message: "dataset must be dishes or business."
    };
  }

  if (!upload.enterpriseName) {
    return {
      ok: false,
      code: "INVALID_STRUCTURED_IMPORT_UPLOAD",
      message: "enterprise_name is required."
    };
  }

  if (upload.enterpriseName.length > PUBLIC_INPUT_LIMITS.enterpriseNameChars) {
    return {
      ok: false,
      code: "INVALID_STRUCTURED_IMPORT_UPLOAD",
      message: "enterprise_name exceeds the allowed limit."
    };
  }

  if (!upload.idempotencyKey) {
    return {
      ok: false,
      code: "INVALID_STRUCTURED_IMPORT_UPLOAD",
      message: "idempotencyKey is required."
    };
  }

  if (upload.idempotencyKey.length > PUBLIC_INPUT_LIMITS.idempotencyKeyChars) {
    return {
      ok: false,
      code: "INVALID_STRUCTURED_IMPORT_UPLOAD",
      message: "idempotencyKey exceeds the allowed limit."
    };
  }

  if (!upload.startDate || !upload.endDate || !isDateWindow(upload.startDate, upload.endDate)) {
    return {
      ok: false,
      code: PHASE3_ERROR_CODES.invalidDateWindow,
      message: "startDate and endDate must be valid YYYYMMDD dates."
    };
  }

  if (upload.labelKeys.length === 0) {
    return {
      ok: false,
      code: "UNLABELED_DOCUMENT",
      message: "Structured import must have labels."
    };
  }

  if (
    upload.labelKeys.length > PUBLIC_INPUT_LIMITS.labelsPerRequest ||
    upload.labelKeys.some((labelKey) => labelKey.length > PUBLIC_INPUT_LIMITS.labelKeyChars)
  ) {
    return {
      ok: false,
      code: "INVALID_STRUCTURED_IMPORT_UPLOAD",
      message: "Labels exceed the allowed limit."
    };
  }

  const fileType = fileTypeFromName(upload.file.fileName);

  if (fileType !== "xlsx" && fileType !== "csv") {
    return {
      ok: false,
      code: PHASE3_ERROR_CODES.unsupportedFileType,
      message: "Structured imports support XLSX or CSV only."
    };
  }

  return {
    ok: true,
    dataset: upload.dataset as StructuredDatasetName,
    fileType,
    startDate: upload.startDate,
    endDate: upload.endDate
  };
}

function fileTypeFromName(fileName: string): Phase3FileType | null {
  const extension = fileName.split(".").pop()?.toLowerCase();

  if (extension && PHASE3_FILE_TYPES.includes(extension as Phase3FileType)) {
    return extension as Phase3FileType;
  }

  return null;
}

function isDateWindow(startDate: string, endDate: string): boolean {
  const start = parseYyyyMmDd(startDate);
  const end = parseYyyyMmDd(endDate);

  return Boolean(start && end && start.getTime() <= end.getTime());
}

function parseYyyyMmDd(value: string): Date | null {
  if (!/^\d{8}$/.test(value)) {
    return null;
  }

  return parseDateParts(value.slice(0, 4), value.slice(4, 6), value.slice(6, 8));
}

function parseDateParts(yearValue: string, monthValue: string, dayValue: string): Date | null {
  const year = Number.parseInt(yearValue, 10);
  const month = Number.parseInt(monthValue, 10);
  const day = Number.parseInt(dayValue, 10);
  const date = new Date(Date.UTC(year, month - 1, day));

  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    return null;
  }

  return date;
}

function canonicalStructuredImportFileName(input: {
  enterpriseName: string;
  dataset: StructuredDatasetName;
  startDate: string;
  endDate: string;
  fileType: "xlsx" | "csv";
}) {
  let enterpriseSegment =
    input.enterpriseName
      .trim()
      .split("")
      .map((character) => {
        if (/^[A-Za-z0-9-]$/.test(character)) {
          return character.toLowerCase();
        }

        return `u${character.codePointAt(0)?.toString(16) ?? "0"}`;
      })
      .join("_") || "enterprise";

  const suffix = `_${input.dataset}_${input.startDate}_${input.endDate}.${input.fileType}`;
  const maxEnterpriseSegmentChars = PUBLIC_INPUT_LIMITS.uploadFilenameChars - suffix.length;

  if (enterpriseSegment.length > maxEnterpriseSegmentChars) {
    const digest = createHash("sha256").update(input.enterpriseName).digest("hex").slice(0, 12);
    const hashSuffix = `_h${digest}`;
    enterpriseSegment = `${enterpriseSegment.slice(
      0,
      maxEnterpriseSegmentChars - hashSuffix.length
    )}${hashSuffix}`;
  }

  return `${enterpriseSegment}${suffix}`;
}

function structuredImportFingerprint(input: {
  dataset: StructuredDatasetName;
  enterpriseName: string;
  startDate: string;
  endDate: string;
  labelKeys: string[];
  fileHash: string;
}): string {
  return createHash("sha256").update(JSON.stringify(input)).digest("hex");
}

function hasStructuredImportCode(error: unknown): error is { code: string } {
  if (!error || typeof error !== "object" || !("code" in error)) {
    return false;
  }

  const code = (error as { code?: unknown }).code;

  return (
    code === "IDEMPOTENCY_KEY_CONFLICT" ||
    code === "ACTIVE_IMPORT_EXISTS" ||
    code === "IMPORT_IN_PROGRESS"
  );
}

function structuredImportConflictMessage(code: string): string {
  if (code === "IDEMPOTENCY_KEY_CONFLICT") {
    return "Idempotency key was reused with different import content.";
  }

  if (code === "ACTIVE_IMPORT_EXISTS") {
    return "An active import already exists for this dataset date window.";
  }

  if (code === "IMPORT_IN_PROGRESS") {
    return "An import is already in progress for this dataset date window.";
  }

  return "Structured import conflict.";
}

function structuredImportResponse(input: {
  importBatch: StructuredImportBatchRecord;
  document: {
    documentId: string;
    fileType: "xlsx" | "csv";
    storageObjectKey: string;
    originalFileName: string;
    status: "active" | "archived";
  };
}) {
  return {
    document: {
      documentId: input.document.documentId,
      documentKind: "structured",
      fileType: input.document.fileType,
      status: input.document.status,
      storageObjectKey: input.document.storageObjectKey,
      originalFileName: input.document.originalFileName
    },
    processing: {
      processingRunId: null,
      status: "succeeded"
    },
    importBatch: importBatchResponse(input.importBatch)
  };
}

function responseForReservedImport(importBatch: StructuredImportBatchRecord) {
  return structuredImportResponse({
    importBatch,
    document: {
      documentId: importBatch.sourceDocumentId,
      fileType: importBatch.sourceDocumentFileType,
      storageObjectKey: importBatch.storageObjectKey,
      originalFileName: importBatch.originalFileName,
      status: importBatch.sourceDocumentStatus === "archived" ? "archived" : "active"
    }
  });
}

function timingDurationMs(started: number): number {
  return Number((performance.now() - started).toFixed(3));
}

function importBatchResponse(importBatch: StructuredImportBatchRecord) {
  return {
    importBatchId: importBatch.id,
    sourceDocumentId: importBatch.sourceDocumentId,
    dataset: importBatch.dataset,
    status: importBatch.status,
    startDate: importBatch.startDate,
    endDate: importBatch.endDate,
    sourceSheetSummary: importBatch.sourceSheetSummary,
    validationErrors: importBatch.validationErrors,
    totalRowCount: importBatch.totalRowCount,
    appliedRowCount: importBatch.appliedRowCount,
    queryableRowCount: importBatch.queryableRowCount
  };
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

export function buildApiServer(options: ApiServerOptions = {}) {
  const context = createApiServerContext(options);
  const requestAuth = createRequestAuth(context);
  const { environment, delegationProof, runtimeLimits, cursorSigningSecret, readinessCheck } =
    context;
  const documents = context.documents;
  const storage = context.storage;
  const structuredImports = context.structuredImports;
  const structuredQueries = context.structuredQueries;
  const skills = context.skills;
  const evidence = context.evidence;
  const createBusinessRequestAudit = context.createBusinessRequestAudit;

  const app = Fastify({
    logger: options.logger ?? true,
    requestIdHeader: false,
    genReqId(rawRequest) {
      return normalizeRequestId(rawRequest.headers["x-request-id"]) ?? `req_${randomUUID()}`;
    },
    trustProxy(address) {
      return isTrustedLoopbackProxy(address);
    }
  });

  registerApiErrorHandler(app);

  app.addHook("onRequest", async (request, reply) => {
    reply.header("x-request-id", request.id);
  });

  app.addHook("onClose", async () => {
    await context.close();
  });

  registerApiMultipart(app, { maxUploadBytes: runtimeLimits.maxUploadBytes });

  registerMcpHttpRoute(app, {
    maxUploadBytes: runtimeLimits.maxUploadBytes,
    delegationProof,
    mcpMaxConcurrentRequests: runtimeLimits.mcpMaxConcurrentRequests,
    publicOrigin: (options.runtimeEnv ?? process.env)["ENTERPRISE_HUB_PUBLIC_ORIGIN"],
    authenticate: async (request, reply) => {
      const authenticated = await requestAuth.authenticate(request, reply);

      if (!authenticated) {
        return null;
      }

      return (request as AuthenticatedRequest).employee;
    }
  });

  if (context.authCore) {
    const publicOrigin = environment["ENTERPRISE_HUB_PUBLIC_ORIGIN"];
    if (!publicOrigin) {
      throw new Error("ENTERPRISE_HUB_PUBLIC_ORIGIN is required for official authentication.");
    }
    registerOfficialAuthRoutes(app, { auth: context.authCore, publicOrigin });
    void context.authCore.pruneSecurityEvents().catch((error: unknown) => {
      app.log.error({ err: error }, "Failed to prune expired authentication security events.");
    });
    const pruneTimer = setInterval(
      () => {
        void context.authCore?.pruneSecurityEvents().catch((error: unknown) => {
          app.log.error({ err: error }, "Failed to prune expired authentication security events.");
        });
      },
      24 * 60 * 60 * 1000
    );
    pruneTimer.unref();
    app.addHook("onClose", async () => clearInterval(pruneTimer));
  }

  registerSystemRoutes(app, { auth: requestAuth, readinessCheck });

  registerEvidenceRoutes(app, {
    auth: requestAuth,
    documents,
    storage,
    evidence,
    cursorSigningSecret,
    createBusinessRequestAudit
  });

  app.post("/v1/structured/imports", async (request, reply) => {
    const importRequestStarted = performance.now();
    const timingContext: Record<string, unknown> = {};
    const logTiming = (stage: string, started: number, extra: Record<string, unknown> = {}) => {
      request.log.info(
        {
          event: "structured_import_timing",
          stage,
          durationMs: timingDurationMs(started),
          elapsedMs: timingDurationMs(importRequestStarted),
          ...timingContext,
          ...extra
        },
        "structured import timing"
      );
    };
    const logApplyTiming = (event: StructuredImportTimingEvent) => {
      request.log.info(
        {
          event: "structured_import_timing",
          elapsedMs: timingDurationMs(importRequestStarted),
          ...timingContext,
          ...event,
          stage: event.stage,
          durationMs: event.durationMs
        },
        "structured import timing"
      );
    };
    const measureTiming = async <T>(
      stage: string,
      workload: () => Promise<T>,
      extra: Record<string, unknown> = {}
    ): Promise<T> => {
      const started = performance.now();
      try {
        return await workload();
      } finally {
        logTiming(stage, started, extra);
      }
    };

    const authenticated = await requestAuth.authenticate(request, reply);

    if (!authenticated) {
      return;
    }

    let upload: ParsedStructuredImportUpload;

    try {
      upload = await measureTiming("upload.parse_multipart", () =>
        parseStructuredImportUpload(request)
      );
    } catch (error) {
      logTiming("upload.total", importRequestStarted, { outcome: "invalid_multipart" });
      if (isPayloadTooLargeError(error)) {
        throw error;
      }

      return validationError(
        reply,
        "INVALID_STRUCTURED_IMPORT_UPLOAD",
        "Multipart structured import upload is invalid."
      );
    }

    const metadataValidationStarted = performance.now();
    const metadataValidation = validateStructuredImportMetadata(upload);
    logTiming("upload.validate_metadata", metadataValidationStarted);

    if (!metadataValidation.ok) {
      logTiming("upload.total", importRequestStarted, { outcome: "invalid_metadata" });
      return validationError(reply, metadataValidation.code, metadataValidation.message);
    }

    const { dataset, fileType, startDate, endDate } = metadataValidation;
    const uploadedFile = upload.file;
    const enterpriseName = upload.enterpriseName;
    const idempotencyKey = upload.idempotencyKey;

    if (!uploadedFile || !enterpriseName || !idempotencyKey) {
      logTiming("upload.total", importRequestStarted, { outcome: "incomplete_metadata" });
      return validationError(
        reply,
        "INVALID_STRUCTURED_IMPORT_METADATA",
        "Structured import metadata is incomplete."
      );
    }

    const employee = (request as AuthenticatedRequest).employee;
    const audit = createBusinessRequestAudit(request);
    Object.assign(timingContext, {
      dataset,
      fileType,
      fileByteSize: uploadedFile.body.byteLength
    });
    const requestedLabels = await measureTiming("upload.resolve_labels", () =>
      documents().findLabelsByKeys(employee.orgId, upload.labelKeys)
    );
    const foundLabelKeys = new Set(requestedLabels.map((label) => label.key));
    const missingLabelKeys = upload.labelKeys.filter((labelKey) => !foundLabelKeys.has(labelKey));

    if (missingLabelKeys.length > 0) {
      logTiming("upload.total", importRequestStarted, { outcome: "unknown_label" });
      return validationError(reply, "UNKNOWN_LABEL", "One or more labels do not exist.");
    }

    const forbiddenLabelKeys = forbiddenRequestedLabels(employee, requestedLabels);

    if (forbiddenLabelKeys.length > 0) {
      logTiming("upload.total", importRequestStarted, { outcome: "forbidden_label" });
      return reply
        .code(403)
        .send(errorResponse("FORBIDDEN_LABEL", "One or more labels cannot be assigned."));
    }

    if (requestedLabels.length === 0) {
      logTiming("upload.total", importRequestStarted, { outcome: "unlabeled_document" });
      return validationError(reply, "UNLABELED_DOCUMENT", "Structured import must have labels.");
    }

    let validation: Awaited<ReturnType<typeof parseStructuredFile>>;

    try {
      validation = await measureTiming("upload.parse_file", () =>
        parseStructuredFile({
          dataset,
          content: uploadedFile.body,
          fileType,
          startDate,
          endDate,
          fileName: uploadedFile.fileName,
          limits: {
            maxStructuredImportRows: runtimeLimits.maxStructuredImportRows,
            maxXlsxSheets: runtimeLimits.maxXlsxSheets,
            maxStructuredCellChars: runtimeLimits.maxStructuredCellChars,
            maxXlsxUncompressedBytes: runtimeLimits.maxXlsxUncompressedBytes,
            maxXlsxZipEntries: runtimeLimits.maxXlsxZipEntries,
            maxXlsxCompressionRatio: runtimeLimits.maxXlsxCompressionRatio
          }
        })
      );
    } catch (error) {
      request.log.warn({ err: error }, "structured import validation failed");
      logTiming("upload.total", importRequestStarted, { outcome: "parse_failed" });
      return validationError(
        reply,
        "STRUCTURED_IMPORT_VALIDATION_FAILED",
        "Structured import validation failed."
      );
    }
    Object.assign(timingContext, {
      rowCount: validation.rows.length,
      sheetCount: validation.sheetSummary.length
    });

    const candidateDocumentId = createDocumentId();
    const originalFileName = uploadedFile.fileName;
    const canonicalFileName = canonicalStructuredImportFileName({
      enterpriseName,
      dataset,
      startDate,
      endDate,
      fileType
    });
    const fileHash = createHash("sha256").update(uploadedFile.body).digest("hex");
    const requestFingerprint = structuredImportFingerprint({
      dataset,
      enterpriseName,
      startDate,
      endDate,
      labelKeys: requestedLabels.map((label) => label.key).sort(),
      fileHash
    });
    const candidateStorageObjectKey = createOriginalObjectKey({
      orgId: employee.orgId,
      documentId: candidateDocumentId,
      fileName: canonicalFileName
    });

    let reservation: Awaited<ReturnType<StructuredImportRepository["reserveStructuredImport"]>>;
    try {
      reservation = await measureTiming(
        "upload.reserve_import",
        () =>
          structuredImports().reserveStructuredImport({
            orgId: employee.orgId,
            actorEmployeeId: employee.id,
            documentId: candidateDocumentId,
            dataset,
            fileType,
            startDate,
            endDate,
            idempotencyKey,
            requestFingerprint,
            document: {
              title: `${enterpriseName}_${dataset}_${startDate}_${endDate}`,
              storageObjectKey: candidateStorageObjectKey,
              originalFileName,
              contentType: uploadedFile.contentType,
              byteSize: uploadedFile.body.byteLength,
              checksumSha256: fileHash,
              labelIds: requestedLabels.map((label) => label.id),
              labels: requestedLabels.map((label) => label.key).sort()
            },
            sourceSheetSummary: validation.sheetSummary,
            totalRowCount: validation.rows.length,
            audit
          }),
        { sourceDocumentId: candidateDocumentId }
      );
    } catch (error) {
      logTiming("upload.total", importRequestStarted, { outcome: "reservation_failed" });
      if (error instanceof StructuredImportError || hasStructuredImportCode(error)) {
        return reply
          .code(409)
          .send(errorResponse(error.code, structuredImportConflictMessage(error.code)));
      }
      request.log.error({ err: error }, "structured import reservation failed");
      return reply
        .code(500)
        .send(errorResponse(PHASE3_ERROR_CODES.internalError, "Structured import failed."));
    }

    Object.assign(timingContext, {
      importBatchId: reservation.importBatch.id,
      sourceDocumentId: reservation.importBatch.sourceDocumentId
    });
    if (reservation.state === "existing") {
      logTiming("upload.total", importRequestStarted, { outcome: "existing" });
      return reply.code(202).send(responseForReservedImport(reservation.importBatch));
    }

    const reservedBatch = reservation.importBatch;
    try {
      const storedObject = await measureTiming("upload.put_storage_object", () =>
        storage().putObject({
          orgId: employee.orgId,
          documentId: reservedBatch.sourceDocumentId,
          fileName: canonicalFileName,
          body: uploadedFile.body,
          contentType: uploadedFile.contentType
        })
      );
      if (
        storedObject.key !== reservedBatch.storageObjectKey ||
        storedObject.hash !== fileHash ||
        storedObject.size !== uploadedFile.body.byteLength
      ) {
        throw new Error("Published structured import object does not match its reservation.");
      }
    } catch (error) {
      try {
        const authoritative = await structuredImports().markStructuredImportStorageFailure({
          orgId: employee.orgId,
          importBatchId: reservedBatch.id,
          errorCode: "STORAGE_WRITE_FAILED",
          errorSummary: error instanceof Error ? error.message : "Storage write failed."
        });
        if (authoritative.status === "applied") {
          logTiming("upload.total", importRequestStarted, { outcome: "storage_failed_applied" });
          return reply.code(202).send(responseForReservedImport(authoritative));
        }
      } catch (markError) {
        request.log.error({ err: markError }, "failed to record structured storage failure");
      }
      request.log.error({ err: error }, "structured import storage publication failed");
      logTiming("upload.total", importRequestStarted, { outcome: "storage_failed" });
      return reply
        .code(500)
        .send(errorResponse(PHASE3_ERROR_CODES.internalError, "Structured import failed."));
    }

    try {
      const importBatch = await measureTiming("upload.apply_import", () =>
        structuredImports().applyReservedStructuredImport({
          orgId: employee.orgId,
          actorEmployeeId: employee.id,
          importBatchId: reservedBatch.id,
          rows: validation.rows,
          audit,
          onTiming: logApplyTiming
        })
      );
      logTiming("upload.total", importRequestStarted, { outcome: "applied" });
      return reply.code(202).send(responseForReservedImport(importBatch));
    } catch (error) {
      request.log.error(
        { err: error, documentId: reservedBatch.sourceDocumentId },
        "structured import apply failed"
      );
      logTiming("upload.total", importRequestStarted, { outcome: "apply_failed" });
      return reply
        .code(500)
        .send(errorResponse(PHASE3_ERROR_CODES.internalError, "Structured import failed."));
    }
  });

  app.get<{ Params: { importBatchId: string } }>(
    "/v1/structured/imports/:importBatchId",
    async (request, reply) => {
      const authenticated = await requestAuth.authenticate(request, reply);

      if (!authenticated) {
        return;
      }

      const employee = (request as AuthenticatedRequest).employee;
      const importBatch = await structuredImports().findImportBatch(
        employee.orgId,
        request.params.importBatchId
      );

      if (
        !importBatch ||
        !canEmployeeAccessDocument({
          employee: {
            disabled: employee.disabled,
            role: employee.role,
            labelKeys: employee.labels
          },
          document: {
            labelKeys: importBatch.sourceDocumentLabelKeys
          }
        })
      ) {
        return reply
          .code(404)
          .send(errorResponse("IMPORT_BATCH_NOT_FOUND", "Import batch not found."));
      }

      return {
        importBatch: importBatchResponse(importBatch)
      };
    }
  );
  registerStructuredQueryRoutes(app, { auth: requestAuth, structuredQueries, cursorSigningSecret });

  registerCatalogRoutes(app, { auth: requestAuth, documents, skills });

  return app;
}
