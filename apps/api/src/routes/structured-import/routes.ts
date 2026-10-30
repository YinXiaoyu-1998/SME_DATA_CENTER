import { ResourceAttributesError } from "@smedc/db";
import { normalizeEnterpriseIdentity } from "@smedc/domain";
import { createHash } from "node:crypto";
import {
  authorizeFileUpload,
  fileUploadAdminRequiredResponse,
  type UploadAuthorizationAuditRepository
} from "../../file-upload-authorization.js";
import { performance } from "node:perf_hooks";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { databaseErrorDetails, type DatabaseRetryEvent } from "@smedc/db";
import {
  PHASE3_ERROR_CODES,
  AUTH_ERROR_CODES,
  canReadResource,
  canEmployeeAccessDocument,
  getStructuredRegistry
} from "@smedc/domain";
import { isBusinessClearance, PHASE3_RUNTIME_LIMIT_DEFAULTS } from "@smedc/domain";
import { preflightStructuredFile, profileStructuredFile } from "@smedc/structured-ingestion";
import { createOriginalObjectKey, type StorageAdapter } from "@smedc/storage";
import type { ApiRuntimeLimits } from "../../config/runtime-limits.js";
import type { RequestAuditContext } from "../../request-audit-context.js";
import type { RequestAuth } from "../../request-auth.js";
import {
  StructuredImportError,
  type StructuredImportRepository
} from "../../structured-imports.js";
import { errorResponse, isPayloadTooLargeError, validationError } from "../../request-errors.js";
import { readMultipartFile, type MultipartPart } from "../../http/multipart.js";
import {
  canonicalStructuredImportFileName,
  createStructuredImportDocumentId,
  hasStructuredImportCode,
  responseForReservedImport,
  structuredImportProgressResponse,
  structuredImportConflictMessage,
  structuredImportFingerprint,
  timingDurationMs,
  validateStructuredImportMetadata,
  type ParsedStructuredImportUpload
} from "./workflow.js";

function importDocumentTitle(input: {
  enterpriseName: string;
  dataset: string;
  metadataPolicy: "window" | "snapshot" | "derived_receipt" | "none";
  startDate: string | null;
  endDate: string | null;
  snapshotDate?: string;
  naturalKey?: string;
  contentDigest: string;
}): string {
  if (input.metadataPolicy === "snapshot") {
    return `${input.enterpriseName}_${input.dataset}_${input.snapshotDate}`;
  }
  if (input.metadataPolicy === "derived_receipt") {
    return `${input.enterpriseName}_${input.dataset}_${input.naturalKey}_${input.startDate}`;
  }
  if (input.metadataPolicy === "none") {
    return `${input.enterpriseName}_${input.dataset}_${input.contentDigest.slice(0, 12)}`;
  }
  return `${input.enterpriseName}_${input.dataset}_${input.startDate}_${input.endDate}`;
}

async function parseStructuredImportUpload(
  request: FastifyRequest
): Promise<ParsedStructuredImportUpload> {
  const upload: ParsedStructuredImportUpload = { confidentialityLevelFieldCount: 0 };

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
    if (part.fieldname === "historicalSupplementReason") {
      if (upload.historicalSupplementReason !== undefined || !value || value.length > 2048)
        throw new ResourceAttributesError("RESOURCE_HISTORICAL_REASON_REQUIRED");
      upload.historicalSupplementReason = value;
      continue;
    }

    if (part.fieldname === "confidentialityLevel") {
      upload.confidentialityLevelFieldCount += 1;
      upload.confidentialityLevel = value;
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

    if (part.fieldname === "snapshotDate") {
      upload.snapshotDate = value;
      continue;
    }

    if (part.fieldname === "idempotencyKey") {
      upload.idempotencyKey = value;
    }
  }

  return upload;
}

function parseConfidentialityLevel(upload: ParsedStructuredImportUpload): number | null {
  if (upload.confidentialityLevelFieldCount === 0) return 0;
  if (
    upload.confidentialityLevelFieldCount !== 1 ||
    !/^[0-3]$/.test(upload.confidentialityLevel ?? "")
  ) {
    return null;
  }
  return Number(upload.confidentialityLevel);
}

export function registerStructuredImportRoutes(
  app: FastifyInstance,
  dependencies: {
    auth: RequestAuth;
    storage: () => StorageAdapter;
    structuredImports: () => StructuredImportRepository;
    runtimeLimits: ApiRuntimeLimits;
    createBusinessRequestAudit: (request: FastifyRequest) => RequestAuditContext;
    uploadAuthorizationAudit: () => UploadAuthorizationAuditRepository;
  }
): void {
  app.post("/v1/structured/imports", async (request, reply) => {
    const importRequestStarted = performance.now();
    const timingContext: Record<string, unknown> = {};
    const logDatabaseRetry = (stage: string) => (event: DatabaseRetryEvent) => {
      request.log.warn(
        { event: "structured_import_db_retry", stage, ...timingContext, ...event },
        "structured import database recovery"
      );
    };
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

    const authenticated = await dependencies.auth.authenticate(request, reply);

    if (!authenticated) {
      return;
    }

    const employee = dependencies.auth.employee(request);
    const allowed = await authorizeFileUpload({
      employee,
      uploadSurface: "structured_dataset",
      audit: dependencies.createBusinessRequestAudit(request),
      auditRepository: dependencies.uploadAuthorizationAudit,
      logAuditFailure: (context) => request.log.error(context, "upload denial audit failed")
    });
    if (!allowed) return reply.code(403).send(fileUploadAdminRequiredResponse(request));

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

    const { dataset, fileType } = metadataValidation;
    const registry = getStructuredRegistry(dataset);
    if (registry.accessMode === "partition_extract") {
      return reply
        .code(409)
        .send(
          errorResponse(
            "PARTITION_UPLOAD_SESSION_REQUIRED",
            "business, dishes, settled_orders, and takeaway_orders must use the partition upload session."
          )
        );
    }
    let { startDate, endDate } = metadataValidation;
    const snapshotDate =
      registry.metadataPolicy === "snapshot" ? metadataValidation.snapshotDate : undefined;
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

    let confidentialityLevel = parseConfidentialityLevel(upload);
    if (dataset === "cost_cards") {
      if (normalizeEnterpriseIdentity(enterpriseName).enterpriseKey.length > 128)
        return validationError(
          reply,
          "INVALID_COST_CARD_METADATA",
          "Enterprise identity exceeds the current authorization limit."
        );
      if (upload.confidentialityLevelFieldCount > 0)
        return validationError(
          reply,
          "INVALID_COST_CARD_METADATA",
          "Cost cards use the configured category confidentiality level."
        );
      if (uploadedFile.body.length > PHASE3_RUNTIME_LIMIT_DEFAULTS.maxUploadBytes)
        return validationError(
          reply,
          "COST_CARD_SOURCE_LIMIT_EXCEEDED",
          "Cost card source exceeds 50 MiB."
        );
      const snapshot = await dependencies.auth.authorization(request);
      const category = snapshot.categories.find(
        (category) => category.key === "cost_cards" && category.kind === "fixed"
      );
      if (
        snapshot.mode !== "enabled" ||
        snapshot.disabled ||
        snapshot.role !== "admin" ||
        !category ||
        !isBusinessClearance(category.confidentialityLevel)
      )
        return validationError(
          reply,
          "RESOURCE_CATEGORY_NOT_CONFIGURED",
          "Cost card category configuration is required."
        );
      confidentialityLevel = category.confidentialityLevel;
    }
    if (confidentialityLevel === null) {
      return validationError(
        reply,
        "INVALID_CONFIDENTIALITY_LEVEL",
        "Confidentiality level must be an integer from 0 through 3."
      );
    }

    const audit = dependencies.createBusinessRequestAudit(request);
    Object.assign(timingContext, {
      dataset,
      fileType,
      fileByteSize: uploadedFile.body.byteLength
    });
    try {
      await measureTiming("upload.preflight_file", async () =>
        preflightStructuredFile({
          content: uploadedFile.body,
          fileType,
          fileName: uploadedFile.fileName
        })
      );
    } catch (error) {
      request.log.warn({ err: error }, "structured import preflight failed");
      logTiming("upload.total", importRequestStarted, { outcome: "preflight_failed" });
      return validationError(
        reply,
        "STRUCTURED_IMPORT_VALIDATION_FAILED",
        "Structured import preflight failed."
      );
    }

    let naturalKey: string | undefined;
    if (registry.metadataPolicy === "derived_receipt") {
      try {
        const profile = await measureTiming("upload.profile_file", () =>
          profileStructuredFile({
            dataset,
            fileName: uploadedFile.fileName,
            fileType,
            content: uploadedFile.body,
            limits: {
              maxStructuredImportRows: dependencies.runtimeLimits.maxStructuredImportRows,
              maxXlsxSheets: dependencies.runtimeLimits.maxXlsxSheets,
              maxStructuredCellChars: dependencies.runtimeLimits.maxStructuredCellChars,
              maxXlsxUncompressedBytes: dependencies.runtimeLimits.maxXlsxUncompressedBytes,
              maxXlsxZipEntries: dependencies.runtimeLimits.maxXlsxZipEntries,
              maxXlsxCompressionRatio: dependencies.runtimeLimits.maxXlsxCompressionRatio
            }
          })
        );
        const derivedMetadata = profile.derivedMetadata;
        if (!derivedMetadata) throw new Error("Delivery receipt metadata is missing.");
        startDate = derivedMetadata.receiptDate.replaceAll("-", "");
        endDate = startDate;
        naturalKey = derivedMetadata.receiptId;
      } catch (error) {
        request.log.warn({ err: error }, "structured import profile failed");
        logTiming("upload.total", importRequestStarted, { outcome: "profile_failed" });
        return validationError(
          reply,
          "STRUCTURED_IMPORT_VALIDATION_FAILED",
          "Structured import metadata could not be derived."
        );
      }
    }

    const candidateDocumentId = createStructuredImportDocumentId();
    const originalFileName = uploadedFile.fileName;
    const fileHash = createHash("sha256").update(uploadedFile.body).digest("hex");
    const canonicalFileName = canonicalStructuredImportFileName({
      enterpriseName,
      dataset,
      startDate,
      endDate,
      snapshotDate,
      receiptId: naturalKey,
      contentDigest: fileHash,
      fileType
    });
    const requestFingerprint = structuredImportFingerprint({
      historicalSupplementReason: upload.historicalSupplementReason,
      dataset,
      enterpriseName,
      ...(registry.metadataPolicy === "snapshot"
        ? { snapshotDate }
        : registry.metadataPolicy === "window" || registry.metadataPolicy === "derived_receipt"
          ? { startDate, endDate }
          : {}),
      ...(naturalKey ? { naturalKey } : {}),
      confidentialityLevel,
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
          dependencies.structuredImports().reserveStructuredImport({
            onDatabaseRetry: logDatabaseRetry("reserve_import"),
            orgId: employee.orgId,
            actorEmployeeId: employee.id,
            documentId: candidateDocumentId,
            dataset,
            enterpriseKey: normalizeEnterpriseIdentity(enterpriseName).enterpriseKey,
            ...(dataset === "cost_cards" ? { enterpriseName } : {}),
            historicalSupplementReason: upload.historicalSupplementReason,
            fileType,
            startDate,
            endDate,
            ...(naturalKey ? { naturalKey } : {}),
            idempotencyKey,
            requestFingerprint,
            document: {
              title: importDocumentTitle({
                enterpriseName,
                dataset,
                metadataPolicy: registry.metadataPolicy,
                startDate,
                endDate,
                snapshotDate,
                naturalKey,
                contentDigest: fileHash
              }),
              storageObjectKey: candidateStorageObjectKey,
              originalFileName,
              contentType: uploadedFile.contentType,
              byteSize: uploadedFile.body.byteLength,
              checksumSha256: fileHash,
              confidentialityLevel
            },
            sourceSheetSummary: [],
            totalRowCount: 0,
            audit
          }),
        { sourceDocumentId: candidateDocumentId }
      );
    } catch (error) {
      logTiming("upload.total", importRequestStarted, { outcome: "reservation_failed" });
      if (error instanceof ResourceAttributesError)
        return validationError(
          reply,
          error.code,
          "Historical supplementation requires current admin approval and valid dates."
        );
      if (error instanceof StructuredImportError || hasStructuredImportCode(error)) {
        return reply
          .code(409)
          .send(errorResponse(error.code, structuredImportConflictMessage(error.code)));
      }
      request.log.error(
        { ...databaseErrorDetails(error), ...timingContext, stage: "reserve_import" },
        "structured import reservation failed"
      );
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
      return reply
        .code(202)
        .send(
          dataset === "cost_cards"
            ? structuredImportProgressResponse(reservation.importBatch)
            : responseForReservedImport(reservation.importBatch)
        );
    }

    const reservedBatch = reservation.importBatch;
    try {
      const storedObject = await measureTiming("upload.put_storage_object", () =>
        dependencies.storage().putObject({
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
      const verifiedObject = await dependencies
        .storage()
        .statObject(reservedBatch.storageObjectKey);
      if (
        !verifiedObject ||
        verifiedObject.hash !== fileHash ||
        verifiedObject.size !== uploadedFile.body.byteLength
      ) {
        throw new Error("Published structured import object could not be verified.");
      }
    } catch (error) {
      request.log.error({ err: error }, "structured import storage publication failed");
      logTiming("upload.total", importRequestStarted, { outcome: "storage_failed" });
      return reply
        .code(500)
        .send(errorResponse(PHASE3_ERROR_CODES.internalError, "Structured import failed."));
    }

    try {
      const importBatch = await measureTiming("upload.enqueue_processing", () =>
        dependencies.structuredImports().enqueueReservedStructuredImport({
          onDatabaseRetry: logDatabaseRetry("enqueue_processing"),
          orgId: employee.orgId,
          importBatchId: reservedBatch.id
        })
      );
      logTiming("upload.total", importRequestStarted, { outcome: "queued" });
      return reply
        .code(202)
        .send(
          dataset === "cost_cards"
            ? structuredImportProgressResponse(importBatch)
            : responseForReservedImport(importBatch)
        );
    } catch (error) {
      request.log.error(
        {
          ...databaseErrorDetails(error),
          ...timingContext,
          stage: "enqueue_processing",
          documentId: reservedBatch.sourceDocumentId
        },
        "structured import queue publication failed"
      );
      logTiming("upload.total", importRequestStarted, { outcome: "enqueue_failed" });
      return reply
        .code(500)
        .send(errorResponse(PHASE3_ERROR_CODES.internalError, "Structured import failed."));
    }
  });

  app.get<{ Params: { importBatchId: string } }>(
    "/v1/structured/imports/:importBatchId",
    async (request, reply) => {
      const authenticated = await dependencies.auth.authenticate(request, reply);

      if (!authenticated) {
        return;
      }

      const employee = dependencies.auth.employee(request);
      let snapshot;
      try {
        snapshot = await dependencies.auth.authorization(request);
      } catch (error) {
        if (!(error instanceof Error) || error.message !== "AUTHORIZATION_ADMIN_REQUIRED")
          throw error;
        return reply
          .code(403)
          .send(errorResponse(AUTH_ERROR_CODES.employeeDisabled, "Employee account is disabled."));
      }
      if (snapshot.disabled)
        return reply
          .code(403)
          .send(errorResponse(AUTH_ERROR_CODES.employeeDisabled, "Employee account is disabled."));
      const importBatch = await dependencies
        .structuredImports()
        .findImportBatch(snapshot.orgId, request.params.importBatchId);

      if (
        !importBatch ||
        snapshot.orgId !== employee.orgId ||
        snapshot.employeeId !== employee.id ||
        importBatch.orgId !== snapshot.orgId
      ) {
        return reply
          .code(404)
          .send(errorResponse("IMPORT_BATCH_NOT_FOUND", "Import batch not found."));
      }

      let readRequirements = importBatch.readRequirements ?? [];
      // Unpublished errors still belong to the server-accepted enterprise/category.
      // This status-only scope never grants original-file or directory access.
      if (
        importBatch.dataset === "cost_cards" &&
        ["pending", "validating", "applying", "failed", "rejected"].includes(importBatch.status) &&
        importBatch.enterpriseKey &&
        importBatch.enterpriseKey.length <= 128
      ) {
        const category = snapshot.categories.find(
          (category) => category.key === "cost_cards" && category.kind === "fixed"
        );
        readRequirements = category
          ? [
              {
                orgId: importBatch.orgId,
                categoryId: category.id,
                valid: true,
                scopes: [
                  { enterpriseKey: importBatch.enterpriseKey, ownership: "group", dimensions: {} }
                ]
              }
            ]
          : [];
      }
      const readable =
        snapshot.mode === "enabled"
          ? importBatch.dataset !== "delivery_ledger" &&
            !!readRequirements.length &&
            readRequirements.every((requirement) => canReadResource(snapshot, requirement).allowed)
          : importBatch.dataset !== "cost_cards" &&
            (snapshot.mode === "legacy" || snapshot.mode === "preparing") &&
            canEmployeeAccessDocument({
              employee: snapshot,
              document: { confidentialityLevel: importBatch.sourceDocumentConfidentialityLevel }
            });
      if (readable) return responseForReservedImport(importBatch);
      if (importBatch.uploaderId === snapshot.employeeId)
        return structuredImportProgressResponse(importBatch);
      return reply
        .code(404)
        .send(errorResponse("IMPORT_BATCH_NOT_FOUND", "Import batch not found."));
    }
  );
}
