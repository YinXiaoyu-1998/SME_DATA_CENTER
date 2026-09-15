import { createHash, randomBytes } from "node:crypto";
import type { FastifyInstance } from "fastify";
import {
  PARTITION_ERROR_CODES,
  isPartitionDataset,
  normalizeEnterpriseIdentity
} from "@enterprise-hub/domain";
import {
  createPartitionStagingObjectKey,
  type MultipartUploadPart,
  type StorageAdapter
} from "@enterprise-hub/storage";
import type { ApiRuntimeLimits } from "../../config/runtime-limits.js";
import { errorResponse, validationError } from "../../request-errors.js";
import type { RequestAuth } from "../../request-auth.js";
import {
  StructuredPartitionRepositoryError,
  type StructuredPartitionRepository
} from "../../structured-partitions.js";

const PART_URL_PAGE_SIZE = 100;

interface CreateUploadBody {
  dataset?: string;
  enterpriseName?: string;
  startDate?: string;
  endDate?: string;
  originalFileName?: string;
  mediaType?: string;
  sourceByteSize?: number;
  sourceChecksumSha256?: string;
  idempotencyKey?: string;
  confidentialityLevel?: number;
}

interface ManifestBody {
  dataset?: string;
  enterpriseName?: string;
  startDate?: string;
  endDate?: string;
  storeIds?: string[];
}

export function registerStructuredPartitionRoutes(
  app: FastifyInstance,
  dependencies: {
    auth: RequestAuth;
    storage: () => StorageAdapter;
    partitions: () => StructuredPartitionRepository;
    runtimeLimits: ApiRuntimeLimits;
  }
): void {
  app.post<{ Body: CreateUploadBody }>(
    "/v1/structured/partition-uploads",
    async (request, reply) => {
      const authenticated = await dependencies.auth.authenticate(request, reply);
      if (!authenticated) return;
      const parsed = parseCreateBody(request.body, dependencies.runtimeLimits);
      if (!parsed.ok) return validationError(reply, parsed.code, parsed.message);

      const employee = dependencies.auth.employee(request);
      const jobId = `pjob_${randomBytes(12).toString("hex")}`;
      const objectKey = createPartitionStagingObjectKey({ orgId: employee.orgId, jobId });
      const storage = requireMultipartStorage(dependencies.storage());
      const createdMultipart = await storage.createMultipartUpload({
        key: objectKey,
        contentType: parsed.value.mediaType,
        checksumSha256: parsed.value.sourceChecksumSha256
      });
      try {
        const fingerprint = createHash("sha256").update(JSON.stringify(parsed.value)).digest("hex");
        const reserved = await dependencies.partitions().reserveUpload({
          id: jobId,
          orgId: employee.orgId,
          uploaderId: employee.id,
          dataset: parsed.value.dataset,
          enterpriseKey: parsed.value.enterpriseKey,
          enterpriseName: parsed.value.enterpriseName,
          confidentialityLevel: parsed.value.confidentialityLevel,
          idempotencyKey: parsed.value.idempotencyKey,
          requestFingerprint: fingerprint,
          originalFileName: parsed.value.originalFileName,
          mediaType: parsed.value.mediaType,
          sourceByteSize: BigInt(parsed.value.sourceByteSize),
          sourceChecksumSha256: parsed.value.sourceChecksumSha256,
          sourceStartDate: parsed.value.startDate,
          sourceEndDate: parsed.value.endDate,
          expiresAt: new Date(
            Date.now() + dependencies.runtimeLimits.partitionUploadSessionTtlSeconds * 1000
          ),
          temporaryObjectKey: objectKey,
          multipartUploadId: createdMultipart.uploadId
        });
        if (reserved.state === "existing") {
          await storage.abortMultipartUpload({
            key: objectKey,
            uploadId: createdMultipart.uploadId
          });
        }
        if (
          reserved.job.status !== "uploading" ||
          !reserved.job.temporaryObjectKey ||
          !reserved.job.multipartUploadId
        ) {
          return reply.code(202).send(publicJob(reserved.job));
        }
        return reply
          .code(201)
          .send(
            await uploadSessionResponse(
              storage,
              reserved.job,
              dependencies.runtimeLimits.partitionUploadPartBytes,
              0
            )
          );
      } catch (error) {
        await storage
          .abortMultipartUpload({ key: objectKey, uploadId: createdMultipart.uploadId })
          .catch(() => undefined);
        if (error instanceof StructuredPartitionRepositoryError) {
          return reply.code(409).send(errorResponse(error.code, error.message));
        }
        throw error;
      }
    }
  );

  app.get<{ Params: { jobId: string }; Querystring: { afterPartNumber?: string } }>(
    "/v1/structured/partition-uploads/:jobId/parts",
    async (request, reply) => {
      const authenticated = await dependencies.auth.authenticate(request, reply);
      if (!authenticated) return;
      const employee = dependencies.auth.employee(request);
      const job = await dependencies
        .partitions()
        .findJobForStatus(employee.orgId, request.params.jobId);
      if (!job || job.uploaderId !== employee.id)
        return reply
          .code(404)
          .send(errorResponse("PARTITION_IMPORT_NOT_FOUND", "Partition import not found."));
      if (job.status !== "uploading" || !job.temporaryObjectKey || !job.multipartUploadId)
        return reply
          .code(409)
          .send(
            errorResponse(PARTITION_ERROR_CODES.uploadIncomplete, "Upload session is not active.")
          );
      if (job.expiresAt <= new Date())
        return reply
          .code(410)
          .send(errorResponse(PARTITION_ERROR_CODES.uploadExpired, "Upload session expired."));
      const after = Number(request.query.afterPartNumber ?? 0);
      if (!Number.isSafeInteger(after) || after < 0)
        return validationError(
          reply,
          "INVALID_PART_NUMBER",
          "afterPartNumber must be a non-negative integer."
        );
      return uploadSessionResponse(
        requireMultipartStorage(dependencies.storage()),
        job,
        dependencies.runtimeLimits.partitionUploadPartBytes,
        after
      );
    }
  );

  app.post<{ Params: { jobId: string }; Body: { parts?: MultipartUploadPart[] } }>(
    "/v1/structured/partition-uploads/:jobId/complete",
    async (request, reply) => {
      const authenticated = await dependencies.auth.authenticate(request, reply);
      if (!authenticated) return;
      const employee = dependencies.auth.employee(request);
      const repository = dependencies.partitions();
      const job = await repository.findJobForStatus(employee.orgId, request.params.jobId);
      if (!job || job.uploaderId !== employee.id)
        return reply
          .code(404)
          .send(errorResponse("PARTITION_IMPORT_NOT_FOUND", "Partition import not found."));
      if (job.status !== "uploading" || !job.temporaryObjectKey || !job.multipartUploadId)
        return reply.code(202).send(publicJob(job));
      if (job.expiresAt <= new Date())
        return reply
          .code(410)
          .send(errorResponse(PARTITION_ERROR_CODES.uploadExpired, "Upload session expired."));
      const partCount = Math.ceil(
        Number(job.sourceByteSize) / dependencies.runtimeLimits.partitionUploadPartBytes
      );
      const parts = request.body?.parts;
      if (!validParts(parts, partCount))
        return validationError(
          reply,
          PARTITION_ERROR_CODES.uploadIncomplete,
          "Completed upload parts are incomplete or invalid."
        );
      const storage = requireMultipartStorage(dependencies.storage());
      let stored = await findCompletedSource(storage, job.temporaryObjectKey);
      if (!stored) {
        await storage.completeMultipartUpload({
          key: job.temporaryObjectKey,
          uploadId: job.multipartUploadId,
          parts
        });
        stored = await storage.statObject(job.temporaryObjectKey);
      }
      if (stored.size !== Number(job.sourceByteSize) || stored.hash !== job.sourceChecksumSha256) {
        await storage.deleteObject(job.temporaryObjectKey).catch(() => undefined);
        await repository.finishJob({
          orgId: employee.orgId,
          jobId: job.id,
          status: "rejected",
          errorCode: PARTITION_ERROR_CODES.sourceChecksumMismatch,
          errorSummary: "Uploaded source checksum did not match."
        });
        return reply
          .code(400)
          .send(
            errorResponse(
              PARTITION_ERROR_CODES.sourceChecksumMismatch,
              "Uploaded source checksum did not match."
            )
          );
      }
      return reply.code(202).send(
        publicJob(
          await repository.queueCompletedUpload({
            orgId: employee.orgId,
            jobId: job.id,
            temporaryObjectKey: job.temporaryObjectKey
          })
        )
      );
    }
  );

  app.delete<{ Params: { jobId: string } }>(
    "/v1/structured/partition-uploads/:jobId",
    async (request, reply) => {
      const authenticated = await dependencies.auth.authenticate(request, reply);
      if (!authenticated) return;
      const employee = dependencies.auth.employee(request);
      const repository = dependencies.partitions();
      const job = await repository.findJobForStatus(employee.orgId, request.params.jobId);
      if (!job || job.uploaderId !== employee.id)
        return reply
          .code(404)
          .send(errorResponse("PARTITION_IMPORT_NOT_FOUND", "Partition import not found."));
      if (job.status === "uploading" && job.temporaryObjectKey && job.multipartUploadId) {
        await requireMultipartStorage(dependencies.storage())
          .abortMultipartUpload({ key: job.temporaryObjectKey, uploadId: job.multipartUploadId })
          .catch(() => undefined);
        await repository.finishJob({ orgId: employee.orgId, jobId: job.id, status: "cancelled" });
      }
      return reply.code(204).send();
    }
  );

  app.get<{ Params: { jobId: string } }>(
    "/v1/structured/partition-imports/:jobId",
    async (request, reply) => {
      const authenticated = await dependencies.auth.authenticate(request, reply);
      if (!authenticated) return;
      const employee = dependencies.auth.employee(request);
      const job = await dependencies
        .partitions()
        .findJobForStatus(employee.orgId, request.params.jobId);
      if (!job)
        return reply
          .code(404)
          .send(errorResponse("PARTITION_IMPORT_NOT_FOUND", "Partition import not found."));
      return publicJob(job);
    }
  );

  app.post<{ Body: ManifestBody }>("/v1/structured/partition-manifests", async (request, reply) => {
    const authenticated = await dependencies.auth.authenticate(request, reply);
    if (!authenticated) return;
    const parsed = parseManifestBody(request.body);
    if (!parsed.ok) return validationError(reply, parsed.code, parsed.message);
    const employee = dependencies.auth.employee(request);
    const rows = await dependencies.partitions().listReadableManifestRows({
      orgId: employee.orgId,
      clearance: employee.clearance,
      dataset: parsed.value.dataset,
      enterpriseKey: parsed.value.enterpriseKey,
      startDate: parsed.value.startDate,
      endDate: parsed.value.endDate,
      storeIds: parsed.value.storeIds
    });
    if (rows.length > dependencies.runtimeLimits.partitionManifestMaxPartitions)
      return reply
        .code(413)
        .send(
          errorResponse(
            PARTITION_ERROR_CODES.manifestTooLarge,
            "Partition manifest is too large; narrow the date or store range."
          )
        );
    const storage = dependencies.storage();
    const partitions = await Promise.all(
      rows.map(async (row) => ({
        businessDate: row.businessDate.toISOString().slice(0, 10),
        storeId: row.merchantId,
        storeName: row.storeName,
        rowCount: safeJsonInteger(row.rowCount),
        byteSize: safeJsonInteger(row.byteSize),
        checksumSha256: row.checksumSha256,
        presignedDownloadUrl: await storage.createDownloadUrl(row.objectKey, {
          expiresInSeconds: dependencies.runtimeLimits.partitionManifestUrlTtlSeconds
        })
      }))
    );
    const expiresAt = new Date(
      Date.now() + dependencies.runtimeLimits.partitionManifestUrlTtlSeconds * 1000
    ).toISOString();
    return {
      dataset: parsed.value.dataset,
      enterpriseName: parsed.value.enterpriseName,
      startDate: parsed.value.startDate,
      endDate: parsed.value.endDate,
      expiresAt,
      partitionCount: partitions.length,
      totalRowCount: safeJsonInteger(rows.reduce((sum, row) => sum + row.rowCount, 0n)),
      partitions
    };
  });
}

async function findCompletedSource(storage: StorageAdapter, key: string) {
  try {
    return await storage.statObject(key);
  } catch (error) {
    if (isObjectNotFound(error)) return undefined;
    throw error;
  }
}

function isObjectNotFound(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const candidate = error as {
    code?: unknown;
    name?: unknown;
    $metadata?: { httpStatusCode?: unknown };
  };
  return (
    candidate.code === "ENOENT" ||
    candidate.name === "NotFound" ||
    candidate.name === "NoSuchKey" ||
    candidate.$metadata?.httpStatusCode === 404
  );
}

function parseCreateBody(body: CreateUploadBody | undefined, limits: ApiRuntimeLimits) {
  if (!body || !body.dataset || !isPartitionDataset(body.dataset))
    return invalid("INVALID_PARTITION_UPLOAD", "dataset must be business or dishes.");
  let enterprise: ReturnType<typeof normalizeEnterpriseIdentity>;
  try {
    enterprise = normalizeEnterpriseIdentity(body.enterpriseName ?? "");
  } catch {
    return invalid("INVALID_PARTITION_UPLOAD", "enterpriseName is required.");
  }
  if (!validDate(body.startDate) || !validDate(body.endDate) || body.startDate! > body.endDate!)
    return invalid(
      "INVALID_PARTITION_UPLOAD",
      "startDate and endDate must be a valid inclusive date range."
    );
  if (!body.originalFileName?.trim() || !/\.(csv|xlsx)$/i.test(body.originalFileName))
    return invalid("INVALID_PARTITION_UPLOAD", "originalFileName must be CSV or XLSX.");
  if (!body.mediaType?.trim()) return invalid("INVALID_PARTITION_UPLOAD", "mediaType is required.");
  if (
    !Number.isSafeInteger(body.sourceByteSize) ||
    body.sourceByteSize! <= 0 ||
    body.sourceByteSize! > limits.partitionImportMaxSourceBytes
  )
    return invalid(
      PARTITION_ERROR_CODES.limitExceeded,
      `sourceByteSize must be between 1 and ${limits.partitionImportMaxSourceBytes}.`
    );
  if (!/^[a-f0-9]{64}$/.test(body.sourceChecksumSha256 ?? ""))
    return invalid(
      "INVALID_PARTITION_UPLOAD",
      "sourceChecksumSha256 must be lowercase SHA-256 hex."
    );
  if (!body.idempotencyKey?.trim() || body.idempotencyKey.length > 255)
    return invalid(
      "INVALID_PARTITION_UPLOAD",
      "idempotencyKey is required and must be at most 255 characters."
    );
  const confidentialityLevel = body.confidentialityLevel ?? 0;
  if (
    !Number.isInteger(confidentialityLevel) ||
    confidentialityLevel < 0 ||
    confidentialityLevel > 3
  )
    return invalid(
      "INVALID_CONFIDENTIALITY_LEVEL",
      "confidentialityLevel must be an integer from 0 through 3."
    );
  return {
    ok: true as const,
    value: {
      ...body,
      dataset: body.dataset,
      ...enterprise,
      enterpriseName: enterprise.enterpriseName,
      originalFileName: body.originalFileName.trim(),
      mediaType: body.mediaType.trim(),
      sourceByteSize: body.sourceByteSize!,
      sourceChecksumSha256: body.sourceChecksumSha256!,
      idempotencyKey: body.idempotencyKey.trim(),
      confidentialityLevel,
      startDate: body.startDate!,
      endDate: body.endDate!
    }
  };
}

function parseManifestBody(body: ManifestBody | undefined) {
  if (!body?.dataset || !isPartitionDataset(body.dataset))
    return invalid("INVALID_PARTITION_MANIFEST", "dataset must be business or dishes.");
  let enterprise: ReturnType<typeof normalizeEnterpriseIdentity>;
  try {
    enterprise = normalizeEnterpriseIdentity(body.enterpriseName ?? "");
  } catch {
    return invalid("INVALID_PARTITION_MANIFEST", "enterpriseName is required.");
  }
  if (!validDate(body.startDate) || !validDate(body.endDate) || body.startDate! > body.endDate!)
    return invalid(
      "INVALID_PARTITION_MANIFEST",
      "startDate and endDate must be a valid inclusive date range."
    );
  if (
    body.storeIds &&
    (body.storeIds.length > 10_000 || body.storeIds.some((value) => !value.trim()))
  )
    return invalid("INVALID_PARTITION_MANIFEST", "storeIds must contain non-empty merchant IDs.");
  return {
    ok: true as const,
    value: {
      dataset: body.dataset,
      ...enterprise,
      startDate: body.startDate!,
      endDate: body.endDate!,
      ...(body.storeIds
        ? { storeIds: [...new Set(body.storeIds.map((value) => value.trim()))] }
        : {})
    }
  };
}

function invalid(code: string, message: string) {
  return { ok: false as const, code, message };
}
function validDate(value: string | undefined): boolean {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  return new Date(`${value}T00:00:00.000Z`).toISOString().slice(0, 10) === value;
}
function validParts(
  parts: MultipartUploadPart[] | undefined,
  expected: number
): parts is MultipartUploadPart[] {
  return (
    Array.isArray(parts) &&
    parts.length === expected &&
    parts.every(
      (part, index) =>
        part.partNumber === index + 1 && typeof part.etag === "string" && part.etag.length > 0
    )
  );
}
function safeJsonInteger(value: bigint): number | string {
  return value <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(value) : value.toString();
}

function requireMultipartStorage(
  storage: StorageAdapter
): Required<
  Pick<
    StorageAdapter,
    | "createMultipartUpload"
    | "createUploadPartUrl"
    | "completeMultipartUpload"
    | "abortMultipartUpload"
  >
> &
  StorageAdapter {
  if (
    !storage.createMultipartUpload ||
    !storage.createUploadPartUrl ||
    !storage.completeMultipartUpload ||
    !storage.abortMultipartUpload
  )
    throw new Error("Configured storage does not support multipart partition uploads.");
  return storage as Required<
    Pick<
      StorageAdapter,
      | "createMultipartUpload"
      | "createUploadPartUrl"
      | "completeMultipartUpload"
      | "abortMultipartUpload"
    >
  > &
    StorageAdapter;
}

async function uploadSessionResponse(
  storage: ReturnType<typeof requireMultipartStorage>,
  job: Awaited<ReturnType<StructuredPartitionRepository["findJobForStatus"]>> & {},
  partSize: number,
  afterPartNumber: number
) {
  if (!job || !job.temporaryObjectKey || !job.multipartUploadId)
    throw new Error("Upload session is incomplete.");
  const totalParts = Math.ceil(Number(job.sourceByteSize) / partSize);
  const lastPart = Math.min(totalParts, afterPartNumber + PART_URL_PAGE_SIZE);
  const parts = await Promise.all(
    Array.from(
      { length: Math.max(0, lastPart - afterPartNumber) },
      (_, index) => afterPartNumber + index + 1
    ).map(async (partNumber) => ({
      partNumber,
      uploadUrl: await storage.createUploadPartUrl({
        key: job.temporaryObjectKey!,
        uploadId: job.multipartUploadId!,
        partNumber
      })
    }))
  );
  return {
    partitionImportJobId: job.id,
    status: job.status,
    partSize,
    totalParts,
    expiresAt: job.expiresAt.toISOString(),
    parts,
    nextAfterPartNumber: lastPart < totalParts ? lastPart : null
  };
}

function publicJob(
  job: NonNullable<Awaited<ReturnType<StructuredPartitionRepository["findJobForStatus"]>>>
) {
  return {
    partitionImportJobId: job.id,
    dataset: job.dataset,
    enterpriseName: job.enterpriseName,
    status: job.status,
    totalRowCount: safeJsonInteger(job.totalRowCount),
    partitionCount: job.partitionCount,
    error: job.errorCode ? { code: job.errorCode, message: job.errorSummary } : null,
    validationErrors: job.validationErrors,
    expiresAt: job.expiresAt.toISOString(),
    finishedAt: job.finishedAt?.toISOString() ?? null
  };
}
