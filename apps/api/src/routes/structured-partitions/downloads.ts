import { PrismaClient } from "@prisma/client";
import { z } from "zod";
import {
  canonicalizePartitionDownloadScope,
  createDatabaseAdapter,
  PartitionDownloadRepositoryError,
  type PartitionDownloadRepository,
  type PartitionDownloadStatus
} from "@smedc/db";
import {
  normalizeEnterpriseIdentity,
  PUBLIC_INPUT_LIMITS,
  type PublicPartitionDownloadStatus,
  type PartitionDownloadUrlResponse
} from "@smedc/domain";
import type { StorageAdapter } from "@smedc/storage";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { RequestAuth } from "../../request-auth.js";
import type { RequestAuditContext } from "../../request-audit-context.js";
import { errorResponse } from "../../request-errors.js";

export interface PartitionDownloadAuditRepository {
  append(input: {
    orgId: string;
    actorEmployeeId: string;
    action: "prepare" | "status" | "url";
    targetId: string | null;
    result: "succeeded" | "denied";
    errorCode?: string;
    audit: RequestAuditContext;
  }): Promise<void>;
  disconnect?(): Promise<void>;
}
export function createPrismaPartitionDownloadAuditRepository(
  databaseUrl?: string
): PartitionDownloadAuditRepository {
  const url = databaseUrl ?? process.env["DATABASE_URL"];
  if (!url) throw new Error("DATABASE_URL is required for partition download auditing.");
  const prisma = new PrismaClient({ adapter: createDatabaseAdapter(url) });
  return {
    async append(input) {
      await prisma.auditLog.create({
        data: {
          orgId: input.orgId,
          actorEmployeeId: input.actorEmployeeId,
          action: `partition_download_${input.action}`,
          targetType: "partition_download_request",
          targetId: input.targetId,
          result: input.result,
          metadata: input.errorCode ? { errorCode: input.errorCode } : {},
          requestId: input.audit.requestId,
          clientIp: input.audit.sourceIp,
          clientSource: input.audit.clientSource,
          launcherVersion: input.audit.launcherVersion
        }
      });
    },
    disconnect: () => prisma.$disconnect()
  };
}
const date = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine(
    (value) =>
      Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value
  );
const prepareSchema = z
  .object({
    dataset: z.enum(["business", "dishes"]),
    enterpriseName: z.string().min(1).max(PUBLIC_INPUT_LIMITS.enterpriseNameChars),
    startDate: date,
    endDate: date,
    storeIds: z.array(z.string().min(1).max(255)).min(1).max(2000).optional(),
    storeNameContains: z.array(z.string()).min(1).max(20).optional(),
    idempotencyKey: z
      .string()
      .min(1)
      .max(128)
      .refine((value) => value.trim() === value && value.trim().length > 0)
  })
  .strict();
const idSchema = z
  .string()
  .min(1)
  .max(128)
  .refine((value) =>
    [...value].every((character) => character.charCodeAt(0) > 31 && character.charCodeAt(0) !== 127)
  );
const safeErrors: Record<string, { status: number; message: string }> = {
  INVALID_PARTITION_DOWNLOAD_SCOPE: {
    status: 400,
    message: "Partition download scope is invalid."
  },
  INVALID_IDEMPOTENCY_KEY: { status: 400, message: "idempotencyKey is invalid." },
  INVALID_PARTITION_DOWNLOAD_REQUEST: {
    status: 400,
    message: "Partition download request is invalid."
  },
  IDEMPOTENCY_CONFLICT: {
    status: 409,
    message: "idempotencyKey was already used for a different scope."
  },
  PARTITION_DOWNLOAD_NOT_FOUND: {
    status: 404,
    message: "Partition download request was not found."
  },
  PARTITION_DOWNLOAD_FORBIDDEN: { status: 403, message: "Partition download is not authorized." },
  PARTITION_DOWNLOAD_REBUILD_REQUIRED: {
    status: 409,
    message: "The original complete manifest cannot be proved; prepare a new download request."
  },
  PARTITION_DOWNLOAD_STALE: {
    status: 409,
    message: "Partitions changed; prepare a new download request."
  },
  PARTITION_DOWNLOAD_NOT_READY: {
    status: 409,
    message: "Partition download is not ready; check request status."
  },
  PARTITION_DOWNLOAD_EXPIRED: {
    status: 410,
    message: "Partition download expired; prepare a new request."
  },
  PARTITION_DOWNLOAD_LIMIT_EXCEEDED: {
    status: 413,
    message: "Partition download is too large; narrow the date or store range."
  },
  PARTITION_DOWNLOAD_ACTIVE_LIMIT_EXCEEDED: {
    status: 429,
    message: "Too many active partition downloads; wait for existing requests to finish."
  },
  PARTITION_DOWNLOAD_SOURCE_INVALID: {
    status: 409,
    message: "Partition source could not be verified; prepare a new request."
  },
  PARTITION_DOWNLOAD_FAILED: {
    status: 409,
    message: "Partition download failed; prepare a new request."
  }
};
function rejected(code: string): never {
  throw new PartitionDownloadRepositoryError(code);
}

export function registerPartitionDownloadRoutes(
  app: FastifyInstance,
  dependencies: {
    auth: RequestAuth;
    downloads: () => PartitionDownloadRepository;
    storage: () => StorageAdapter;
    audit: () => PartitionDownloadAuditRepository;
    createBusinessRequestAudit: (request: FastifyRequest) => RequestAuditContext;
    now?: () => Date;
  }
): void {
  const register = (method: "GET" | "POST", path: string, action: "prepare" | "status" | "url") => {
    app.route({
      method,
      url: path,
      handler: async (request, reply) => {
        if (!(await dependencies.auth.authenticate(request, reply))) return;
        const actor = dependencies.auth.employee(request);
        let targetId: string | null = null;
        const audit = dependencies.createBusinessRequestAudit(request);
        const record = (result: "succeeded" | "denied", errorCode?: string) =>
          dependencies.audit().append({
            orgId: actor.orgId,
            actorEmployeeId: actor.id,
            action,
            targetId,
            result,
            ...(errorCode ? { errorCode } : {}),
            audit
          });
        try {
          if (actor.disabled) rejected("PARTITION_DOWNLOAD_FORBIDDEN");
          if (Object.keys(request.query as object).length)
            rejected("INVALID_PARTITION_DOWNLOAD_REQUEST");
          let result: PublicPartitionDownloadStatus | PartitionDownloadUrlResponse;
          if (action === "prepare") {
            const parsed = prepareSchema.safeParse(request.body);
            if (!parsed.success) rejected("INVALID_PARTITION_DOWNLOAD_SCOPE");
            let enterprise: ReturnType<typeof normalizeEnterpriseIdentity>;
            try {
              enterprise = normalizeEnterpriseIdentity(parsed.data.enterpriseName);
            } catch {
              return rejected("INVALID_PARTITION_DOWNLOAD_SCOPE");
            }
            const { idempotencyKey, ...rawScope } = parsed.data;
            let scope;
            try {
              scope = canonicalizePartitionDownloadScope({ ...rawScope, ...enterprise });
            } catch {
              return rejected("INVALID_PARTITION_DOWNLOAD_SCOPE");
            }
            result = publicStatus(
              await dependencies.downloads().prepare(actor, scope, idempotencyKey)
            );
            targetId = result.requestId;
          } else {
            const parsed = idSchema.safeParse((request.params as { requestId: unknown }).requestId);
            if (!parsed.success || request.body !== undefined)
              rejected("INVALID_PARTITION_DOWNLOAD_REQUEST");
            targetId = parsed.data;
            if (action === "status")
              result = publicStatus(await dependencies.downloads().read(actor, targetId));
            else {
              result = await dependencies
                .downloads()
                .issueCurrent(actor, targetId, async (current) => {
                  if (current.request.status !== "succeeded")
                    rejected("PARTITION_DOWNLOAD_NOT_READY");
                  const expiresAt = new Date(
                    Math.min(
                      current.request.expiresAt.getTime(),
                      current.artifact?.expiresAt.getTime() ?? Infinity
                    )
                  );
                  const now = dependencies.now?.() ?? new Date();
                  if (expiresAt <= now) rejected("PARTITION_DOWNLOAD_EXPIRED");
                  const { scope, limits, request: status } = current;
                  const metadata = {
                    requestId: status.requestId,
                    status: "succeeded" as const,
                    scope: {
                      dataset: scope.dataset,
                      enterpriseName: scope.enterpriseName,
                      startDate: scope.startDate,
                      endDate: scope.endDate,
                      ...(scope.storeIds ? { storeIds: scope.storeIds } : {}),
                      ...(scope.storeNameContains
                        ? { storeNameContains: scope.storeNameContains }
                        : {})
                    },
                    partitionCount: status.partitionCount,
                    totalRowCount: status.totalRowCount,
                    totalByteSize: status.totalByteSize,
                    expiresAt: expiresAt.toISOString(),
                    archiveBounds: {
                      maxRawByteSize: String(limits.partitionDownloadMaxBytes),
                      maxManifestByteSize: 8 * 1024 * 1024,
                      maxZipByteSize: String(
                        BigInt(limits.partitionDownloadMaxBytes) +
                          8n * 1024n * 1024n +
                          BigInt(status.partitionCount + 1) * 512n +
                          4096n
                      )
                    }
                  };
                  if (status.partitionCount === 0) return { ...metadata, partitionCount: 0 };
                  else {
                    const artifact = current.artifact;
                    if (!artifact) rejected("PARTITION_DOWNLOAD_NOT_READY");
                    const ttl = Math.min(
                      900,
                      limits.partitionDownloadUrlTtlSeconds,
                      Math.floor((expiresAt.getTime() - now.getTime()) / 1000)
                    );
                    if (ttl < 1) rejected("PARTITION_DOWNLOAD_EXPIRED");
                    const downloadUrl = await dependencies
                      .storage()
                      .createDownloadUrl(artifact.objectKey, { expiresInSeconds: ttl });
                    return {
                      ...metadata,
                      downloadUrl,
                      byteSize: artifact.byteSize.toString(),
                      checksumSha256: artifact.checksumSha256,
                      urlExpiresAt: new Date(now.getTime() + ttl * 1000).toISOString()
                    };
                  }
                });
            }
          }
          await record("succeeded");
          return reply.code(action === "prepare" ? 202 : 200).send(result);
        } catch (error) {
          const code =
            error instanceof PartitionDownloadRepositoryError &&
            Object.hasOwn(safeErrors, error.code)
              ? error.code
              : "INTERNAL_ERROR";
          try {
            await record("denied", code);
          } catch {
            request.log.error(
              { requestId: audit.requestId, action },
              "Partition download audit failed."
            );
          }
          const safe = safeErrors[code] ?? {
            status: 500,
            message: "Partition download request could not be completed."
          };
          return reply.code(safe.status).send(errorResponse(code, safe.message));
        }
      }
    });
  };
  register("POST", "/v1/structured/partition-downloads", "prepare");
  register("GET", "/v1/structured/partition-downloads/:requestId", "status");
  register("POST", "/v1/structured/partition-downloads/:requestId/url", "url");
}
function publicStatus(value: PartitionDownloadStatus): PublicPartitionDownloadStatus {
  return {
    requestId: value.requestId,
    status: value.status,
    partitionCount: value.partitionCount,
    completedPartitionCount: value.completedPartitionCount,
    totalRowCount: value.totalRowCount,
    totalByteSize: value.totalByteSize,
    retryAfterSeconds: value.retryAfterSeconds,
    errorCode:
      value.errorCode && Object.hasOwn(safeErrors, value.errorCode)
        ? value.errorCode
        : value.errorCode
          ? "PARTITION_DOWNLOAD_FAILED"
          : null,
    expiresAt: value.expiresAt.toISOString()
  };
}
