import { PrismaMariaDb } from "@prisma/adapter-mariadb";
import { PrismaClient } from "@prisma/client";
import { createStorageAdapter, type StorageAdapter } from "@enterprise-hub/storage";
import { isStagingRuntimeDatabaseUrl } from "./staging-runtime-targets.js";
import type {
  QdrantPointTarget,
  StagingUploadDomainCleanupPlan
} from "./staging-upload-domain-cleanup-support.js";
import type { StagingUploadDomainCleanupRuntimeAdapter } from "./staging-upload-domain-cleanup.js";

const LOOPBACK_HOSTNAMES = new Set(["localhost", "127.0.0.1", "::1", "0:0:0:0:0:0:0:1"]);

function normalizeHostname(hostname: string): string {
  return hostname.replace(/^\[|\]$/g, "").toLowerCase();
}

function isLocalHostname(hostname: string): boolean {
  return LOOPBACK_HOSTNAMES.has(normalizeHostname(hostname));
}

/**
 * Fail-closed runtime boundary for the one-time upload-domain cleanup. The
 * cleanup is only allowed when the database is a non-local MySQL target and
 * the Qdrant URL is HTTP(S). Loopback Qdrant (the actual staging shape, where
 * Qdrant listens on 127.0.0.1 under host networking) is accepted only when
 * the paired DATABASE_URL provably targets the known staging private RDS.
 */
export function assertStagingCleanupRuntimeTargets(env: NodeJS.ProcessEnv): void {
  const databaseUrl = env["DATABASE_URL"];
  const qdrantUrl = env["QDRANT_URL"];
  if (!databaseUrl || !qdrantUrl) {
    throw new Error("Staging cleanup requires DATABASE_URL and QDRANT_URL at runtime.");
  }

  const database = new URL(databaseUrl);
  if (database.protocol !== "mysql:" || isLocalHostname(database.hostname)) {
    throw new Error("Staging cleanup refuses a local or non-MySQL DATABASE_URL.");
  }

  let qdrantTarget: URL;
  try {
    qdrantTarget = new URL(qdrantUrl);
  } catch {
    throw new Error("Staging cleanup requires an absolute HTTP(S) QDRANT_URL.");
  }

  const qdrantIsLocal = isLocalHostname(qdrantTarget.hostname);
  const qdrantIsStagingLoopback = qdrantIsLocal && isStagingRuntimeDatabaseUrl(databaseUrl);
  if (
    !["http:", "https:"].includes(qdrantTarget.protocol) ||
    (qdrantIsLocal && !qdrantIsStagingLoopback)
  ) {
    throw new Error("Staging cleanup refuses a local or non-HTTP(S) QDRANT_URL.");
  }
}

type StorageCleanupAdapter = Pick<StorageAdapter, "deleteObject" | "statObject">;

interface QdrantCleanupAdapter {
  deletePoints(targets: QdrantPointTarget[]): Promise<void>;
  countPoints(targets: QdrantPointTarget[]): Promise<number>;
}

export interface StagingUploadDomainCleanupProviders {
  prisma: PrismaClient;
  storage: StorageCleanupAdapter;
  qdrant: QdrantCleanupAdapter;
}

export function createStagingUploadDomainCleanupAdapter(
  env: NodeJS.ProcessEnv = process.env,
  providers?: StagingUploadDomainCleanupProviders
): StagingUploadDomainCleanupRuntimeAdapter {
  const runtime = providers ?? createRuntimeProviders(env);
  const ids = (values: string[]) => ({ where: { id: { in: values } } });

  return {
    async close() {
      await runtime.prisma.$disconnect();
    },
    async collectInventory() {
      const documents = await runtime.prisma.document.findMany({
        select: { id: true, storageObjectKey: true }
      });
      const documentIds = documents.map((document) => document.id);
      const chunks = await runtime.prisma.documentChunk.findMany({
        where: { documentId: { in: documentIds }, qdrantPointId: { not: null } },
        select: {
          id: true,
          qdrantPointId: true,
          documentIndex: { select: { qdrantCollection: true } }
        }
      });
      const qdrantPoints = chunks.map((chunk) => {
        if (!chunk.qdrantPointId || !chunk.documentIndex?.qdrantCollection) {
          throw new Error("Staging cleanup refuses a Qdrant point without an exact collection.");
        }
        return { collection: chunk.documentIndex.qdrantCollection, pointId: chunk.qdrantPointId };
      });
      const batches = await runtime.prisma.importBatch.findMany({
        where: { sourceDocumentId: { in: documentIds } },
        select: {
          id: true,
          windowClaim: { select: { id: true } },
          vipRows: { select: { id: true } },
          dishCatalogRows: { select: { id: true } }
        }
      });
      const importBatchIds = batches.map((batch) => batch.id);
      const [partitionJobs, structuredPartitions, storageGarbage] = await Promise.all([
        runtime.prisma.partitionImportJob.findMany({
          select: { id: true, temporaryObjectKey: true }
        }),
        runtime.prisma.structuredPartition.findMany({ select: { id: true, objectKey: true } }),
        runtime.prisma.storageGarbage.findMany({ select: { id: true, objectKey: true } })
      ]);
      const audits = await runtime.prisma.auditLog.findMany({
        where: {
          OR: [
            { targetType: "document", targetId: { in: documentIds } },
            { targetType: "import_batch", targetId: { in: importBatchIds } }
          ]
        },
        select: { id: true }
      });
      const [processingRuns, documentIndexes] = await Promise.all([
        runtime.prisma.processingRun.findMany({
          where: {
            OR: [
              { documentId: { in: documentIds } },
              { partitionImportJobId: { in: partitionJobs.map((job) => job.id) } }
            ]
          },
          select: { id: true }
        }),
        runtime.prisma.documentIndex.findMany({
          where: { documentId: { in: documentIds } },
          select: { id: true }
        })
      ]);
      return {
        documentIds,
        processingRunIds: processingRuns.map((row) => row.id),
        documentChunkIds: chunks.map((row) => row.id),
        documentIndexIds: documentIndexes.map((row) => row.id),
        importBatchIds,
        importWindowClaimIds: batches.flatMap((batch) =>
          batch.windowClaim ? [batch.windowClaim.id] : []
        ),
        partitionImportJobIds: partitionJobs.map((row) => row.id),
        structuredPartitionIds: structuredPartitions.map((row) => row.id),
        storageGarbageIds: storageGarbage.map((row) => row.id),
        vipRowIds: batches.flatMap((batch) => batch.vipRows.map((row) => row.id)),
        dishCatalogRowIds: batches.flatMap((batch) => batch.dishCatalogRows.map((row) => row.id)),
        uploadAuditLogIds: audits.map((row) => row.id),
        storageObjectKeys: [
          ...new Set([
            ...documents.map((document) => document.storageObjectKey),
            ...partitionJobs.flatMap((job) =>
              job.temporaryObjectKey ? [job.temporaryObjectKey] : []
            ),
            ...structuredPartitions.map((partition) => partition.objectKey),
            ...storageGarbage.map((entry) => entry.objectKey)
          ])
        ],
        qdrantPoints
      };
    },
    deleteQdrantPoints: (targets) => runtime.qdrant.deletePoints(targets),
    deleteOssObjects: async (keys) => {
      await Promise.all(keys.map((key) => runtime.storage.deleteObject(key)));
    },
    deleteUploadAuditLogs: async (values) =>
      void (await runtime.prisma.auditLog.deleteMany(ids(values))),
    deleteProcessingRuns: async (values) =>
      void (await runtime.prisma.processingRun.deleteMany(ids(values))),
    deleteDocumentChunks: async (values) =>
      void (await runtime.prisma.documentChunk.deleteMany(ids(values))),
    deleteDocumentIndexes: async (values) =>
      void (await runtime.prisma.documentIndex.deleteMany(ids(values))),
    deleteImportWindowClaims: async (values) =>
      void (await runtime.prisma.importWindowClaim.deleteMany(ids(values))),
    deletePartitionImportJobs: async (values) =>
      void (await runtime.prisma.partitionImportJob.deleteMany(ids(values))),
    deleteStructuredPartitions: async (values) =>
      void (await runtime.prisma.structuredPartition.deleteMany(ids(values))),
    deleteStorageGarbage: async (values) =>
      void (await runtime.prisma.storageGarbage.deleteMany(ids(values))),
    deleteVipRows: async (values) => void (await runtime.prisma.vipRow.deleteMany(ids(values))),
    deleteDishCatalogRows: async (values) =>
      void (await runtime.prisma.dishCatalogRow.deleteMany(ids(values))),
    deleteImportBatches: async (values) =>
      void (await runtime.prisma.importBatch.deleteMany(ids(values))),
    deleteDocuments: async (values) => void (await runtime.prisma.document.deleteMany(ids(values))),
    async verifyPostCleanup(plan: StagingUploadDomainCleanupPlan) {
      const [
        documents,
        processingRuns,
        documentChunks,
        documentIndexes,
        importBatches,
        importWindowClaims,
        partitionImportJobs,
        structuredPartitions,
        storageGarbage,
        vipRows,
        dishCatalogRows,
        uploadAuditLogs,
        qdrantPoints
      ] = await Promise.all([
        runtime.prisma.document.count(ids(plan.documentIds)),
        runtime.prisma.processingRun.count(ids(plan.processingRunIds)),
        runtime.prisma.documentChunk.count(ids(plan.documentChunkIds)),
        runtime.prisma.documentIndex.count(ids(plan.documentIndexIds)),
        runtime.prisma.importBatch.count(ids(plan.importBatchIds)),
        runtime.prisma.importWindowClaim.count(ids(plan.importWindowClaimIds)),
        runtime.prisma.partitionImportJob.count(ids(plan.partitionImportJobIds)),
        runtime.prisma.structuredPartition.count(ids(plan.structuredPartitionIds)),
        runtime.prisma.storageGarbage.count(ids(plan.storageGarbageIds)),
        runtime.prisma.vipRow.count(ids(plan.vipRowIds)),
        runtime.prisma.dishCatalogRow.count(ids(plan.dishCatalogRowIds)),
        runtime.prisma.auditLog.count(ids(plan.uploadAuditLogIds)),
        runtime.qdrant.countPoints(plan.qdrantPoints)
      ]);
      const storageObjects = (
        await Promise.all(
          plan.storageObjectKeys.map(async (key) => {
            try {
              await runtime.storage.statObject(key);
              return 1;
            } catch (error) {
              if (isObjectNotFound(error)) return 0;
              throw error;
            }
          })
        )
      ).reduce<number>((total, count) => total + count, 0);
      return {
        documents,
        processingRuns,
        documentChunks,
        documentIndexes,
        importBatches,
        importWindowClaims,
        partitionImportJobs,
        structuredPartitions,
        storageGarbage,
        vipRows,
        dishCatalogRows,
        uploadAuditLogs,
        storageObjects,
        qdrantPoints
      };
    }
  };
}

function createRuntimeProviders(env: NodeJS.ProcessEnv): StagingUploadDomainCleanupProviders {
  assertStagingCleanupRuntimeTargets(env);
  const databaseUrl = env["DATABASE_URL"]!;
  const qdrantUrl = env["QDRANT_URL"]!;
  const prisma = new PrismaClient({ adapter: new PrismaMariaDb(databaseUrl) });
  return {
    prisma,
    storage: createStorageAdapter(env),
    qdrant: createQdrantAdapter(qdrantUrl, env["QDRANT_API_KEY"])
  };
}

function isObjectNotFound(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const candidate = error as {
    name?: unknown;
    code?: unknown;
    $metadata?: { httpStatusCode?: unknown };
  };
  return (
    candidate.name === "NoSuchKey" ||
    candidate.code === "NoSuchKey" ||
    candidate.code === "ENOENT" ||
    candidate.$metadata?.httpStatusCode === 404
  );
}

function createQdrantAdapter(url: string, apiKey: string | undefined): QdrantCleanupAdapter {
  const headers = { "content-type": "application/json", ...(apiKey ? { "api-key": apiKey } : {}) };
  const groups = (targets: QdrantPointTarget[]): Map<string, QdrantPointTarget[]> => {
    const grouped = new Map<string, QdrantPointTarget[]>();
    for (const target of targets) {
      grouped.set(target.collection, [...(grouped.get(target.collection) ?? []), target]);
    }
    return grouped;
  };
  return {
    async deletePoints(targets) {
      for (const [collection, values] of groups(targets)) {
        const response = await fetch(
          `${url.replace(/\/$/, "")}/collections/${encodeURIComponent(collection!)}/points/delete?wait=true`,
          {
            method: "POST",
            headers,
            body: JSON.stringify({ points: values!.map((value) => value.pointId) })
          }
        );
        if (!response.ok) throw new Error(`Qdrant cleanup failed: HTTP ${response.status}`);
      }
    },
    async countPoints(targets) {
      let total = 0;
      for (const [collection, values] of groups(targets)) {
        const response = await fetch(
          `${url.replace(/\/$/, "")}/collections/${encodeURIComponent(collection!)}/points`,
          {
            method: "POST",
            headers,
            body: JSON.stringify({
              ids: values!.map((value) => value.pointId),
              with_payload: false,
              with_vector: false
            })
          }
        );
        if (!response.ok) throw new Error(`Qdrant verification failed: HTTP ${response.status}`);
        const body = (await response.json()) as { result?: unknown[] };
        total += Array.isArray(body.result) ? body.result.length : 0;
      }
      return total;
    }
  };
}
