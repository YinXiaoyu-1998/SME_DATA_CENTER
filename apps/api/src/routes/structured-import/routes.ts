import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { databaseErrorDetails, type DatabaseRetryEvent } from "@enterprise-hub/db";
import {
  PHASE3_ERROR_CODES,
  canEmployeeAccessDocument,
  getStructuredRegistry,
  type AuthenticatedEmployee
} from "@enterprise-hub/domain";
import {
  preflightStructuredFile,
  profileStructuredFile
} from "@enterprise-hub/structured-ingestion";
import { createOriginalObjectKey, type StorageAdapter } from "@enterprise-hub/storage";
import type { ApiRuntimeLimits } from "../../config/runtime-limits.js";
import type { CatalogLabel, DocumentCatalogRepository } from "../../documents.js";
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
  structuredImportConflictMessage,
  structuredImportFingerprint,
  timingDurationMs,
  uniqueSorted,
  validateStructuredImportMetadata,
  type ParsedStructuredImportUpload
} from "./workflow.js";

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

    if (part.fieldname === "snapshotDate") {
      upload.snapshotDate = value;
      continue;
    }

    if (part.fieldname === "idempotencyKey") {
      upload.idempotencyKey = value;
    }
  }

  upload.labelKeys = uniqueSorted(upload.labelKeys);
  return upload;
}

export function registerStructuredImportRoutes(
  app: FastifyInstance,
  dependencies: {
    auth: RequestAuth;
    documents: () => DocumentCatalogRepository;
    storage: () => StorageAdapter;
    structuredImports: () => StructuredImportRepository;
    runtimeLimits: ApiRuntimeLimits;
    createBusinessRequestAudit: (request: FastifyRequest) => RequestAuditContext;
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

    const employee = dependencies.auth.employee(request);
    const audit = dependencies.createBusinessRequestAudit(request);
    Object.assign(timingContext, {
      dataset,
      fileType,
      fileByteSize: uploadedFile.body.byteLength
    });
    const requestedLabels = await measureTiming("upload.resolve_labels", () =>
      dependencies.documents().findLabelsByKeys(employee.orgId, upload.labelKeys)
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
      dataset,
      enterpriseName,
      ...(registry.metadataPolicy === "snapshot"
        ? { snapshotDate }
        : registry.metadataPolicy === "window" || registry.metadataPolicy === "derived_receipt"
          ? { startDate, endDate }
          : {}),
      ...(naturalKey ? { naturalKey } : {}),
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
          dependencies.structuredImports().reserveStructuredImport({
            onDatabaseRetry: logDatabaseRetry("reserve_import"),
            orgId: employee.orgId,
            actorEmployeeId: employee.id,
            documentId: candidateDocumentId,
            dataset,
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
              labelIds: requestedLabels.map((label) => label.id),
              labels: requestedLabels.map((label) => label.key).sort()
            },
            sourceSheetSummary: [],
            totalRowCount: 0,
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
      return reply.code(202).send(responseForReservedImport(reservation.importBatch));
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
      return reply.code(202).send(responseForReservedImport(importBatch));
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
      const importBatch = await dependencies
        .structuredImports()
        .findImportBatch(employee.orgId, request.params.importBatchId);

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

      return responseForReservedImport(importBatch);
    }
  );
}
