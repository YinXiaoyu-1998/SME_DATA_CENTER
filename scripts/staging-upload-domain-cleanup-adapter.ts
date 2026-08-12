import { PrismaMariaDb } from "@prisma/adapter-mariadb";
import { PrismaClient } from "@prisma/client";
import { createStorageAdapter, type StorageAdapter } from "@enterprise-hub/storage";
import type {
  QdrantPointTarget,
  StagingUploadDomainCleanupPlan
} from "./staging-upload-domain-cleanup-support.js";
import type { StagingUploadDomainCleanupAdapter } from "./staging-upload-domain-cleanup.js";

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
): StagingUploadDomainCleanupAdapter {
  const runtime = providers ?? createRuntimeProviders(env);
  const ids = (values: string[]) => ({ where: { id: { in: values } } });

  return {
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
          dishRows: { select: { id: true } },
          businessRows: { select: { id: true } }
        }
      });
      const importBatchIds = batches.map((batch) => batch.id);
      const audits = await runtime.prisma.auditLog.findMany({
        where: {
          OR: [
            { targetType: "document", targetId: { in: documentIds } },
            { targetType: "import_batch", targetId: { in: importBatchIds } }
          ]
        },
        select: { id: true }
      });
      const [processingRuns, documentIndexes, documentLabelCount] = await Promise.all([
        runtime.prisma.processingRun.findMany({
          where: { documentId: { in: documentIds } },
          select: { id: true }
        }),
        runtime.prisma.documentIndex.findMany({
          where: { documentId: { in: documentIds } },
          select: { id: true }
        }),
        runtime.prisma.documentLabel.count({ where: { documentId: { in: documentIds } } })
      ]);
      return {
        documentIds,
        documentLabelCount,
        processingRunIds: processingRuns.map((row) => row.id),
        documentChunkIds: chunks.map((row) => row.id),
        documentIndexIds: documentIndexes.map((row) => row.id),
        importBatchIds,
        importWindowClaimIds: batches.flatMap((batch) =>
          batch.windowClaim ? [batch.windowClaim.id] : []
        ),
        dishRowIds: batches.flatMap((batch) => batch.dishRows.map((row) => row.id)),
        businessRowIds: batches.flatMap((batch) => batch.businessRows.map((row) => row.id)),
        uploadAuditLogIds: audits.map((row) => row.id),
        storageObjectKeys: documents.map((document) => document.storageObjectKey),
        qdrantPoints
      };
    },
    deleteQdrantPoints: (targets) => runtime.qdrant.deletePoints(targets),
    deleteOssObjects: async (keys) => {
      await Promise.all(keys.map((key) => runtime.storage.deleteObject(key)));
    },
    deleteUploadAuditLogs: async (values) =>
      void (await runtime.prisma.auditLog.deleteMany(ids(values))),
    deleteDocumentLabels: async (documentIds) =>
      void (await runtime.prisma.documentLabel.deleteMany({
        where: { documentId: { in: documentIds } }
      })),
    deleteProcessingRuns: async (values) =>
      void (await runtime.prisma.processingRun.deleteMany(ids(values))),
    deleteDocumentChunks: async (values) =>
      void (await runtime.prisma.documentChunk.deleteMany(ids(values))),
    deleteDocumentIndexes: async (values) =>
      void (await runtime.prisma.documentIndex.deleteMany(ids(values))),
    deleteImportWindowClaims: async (values) =>
      void (await runtime.prisma.importWindowClaim.deleteMany(ids(values))),
    deleteDishRows: async (values) => void (await runtime.prisma.dishRow.deleteMany(ids(values))),
    deleteBusinessRows: async (values) =>
      void (await runtime.prisma.businessRow.deleteMany(ids(values))),
    deleteImportBatches: async (values) =>
      void (await runtime.prisma.importBatch.deleteMany(ids(values))),
    deleteDocuments: async (values) => void (await runtime.prisma.document.deleteMany(ids(values))),
    async verifyPostCleanup(plan: StagingUploadDomainCleanupPlan) {
      const [
        documents,
        documentLabels,
        processingRuns,
        documentChunks,
        documentIndexes,
        importBatches,
        importWindowClaims,
        dishRows,
        businessRows,
        uploadAuditLogs,
        qdrantPoints
      ] = await Promise.all([
        runtime.prisma.document.count(ids(plan.documentIds)),
        runtime.prisma.documentLabel.count({ where: { documentId: { in: plan.documentIds } } }),
        runtime.prisma.processingRun.count(ids(plan.processingRunIds)),
        runtime.prisma.documentChunk.count(ids(plan.documentChunkIds)),
        runtime.prisma.documentIndex.count(ids(plan.documentIndexIds)),
        runtime.prisma.importBatch.count(ids(plan.importBatchIds)),
        runtime.prisma.importWindowClaim.count(ids(plan.importWindowClaimIds)),
        runtime.prisma.dishRow.count(ids(plan.dishRowIds)),
        runtime.prisma.businessRow.count(ids(plan.businessRowIds)),
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
        documentLabels,
        processingRuns,
        documentChunks,
        documentIndexes,
        importBatches,
        importWindowClaims,
        dishRows,
        businessRows,
        uploadAuditLogs,
        storageObjects,
        qdrantPoints
      };
    }
  };
}

function createRuntimeProviders(env: NodeJS.ProcessEnv): StagingUploadDomainCleanupProviders {
  const databaseUrl = env["DATABASE_URL"];
  const qdrantUrl = env["QDRANT_URL"];
  if (!databaseUrl || !qdrantUrl)
    throw new Error("Staging cleanup requires DATABASE_URL and QDRANT_URL at runtime.");
  const url = new URL(databaseUrl);
  if (url.protocol !== "mysql:" || ["localhost", "127.0.0.1", "::1"].includes(url.hostname))
    throw new Error("Staging cleanup refuses a local or non-MySQL DATABASE_URL.");
  let qdrantTarget: URL;
  try {
    qdrantTarget = new URL(qdrantUrl);
  } catch {
    throw new Error("Staging cleanup requires an absolute HTTP(S) QDRANT_URL.");
  }
  const qdrantHostname = qdrantTarget.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (
    !["http:", "https:"].includes(qdrantTarget.protocol) ||
    ["localhost", "127.0.0.1", "::1", "0:0:0:0:0:0:0:1"].includes(qdrantHostname)
  ) {
    throw new Error("Staging cleanup refuses a local or non-HTTP(S) QDRANT_URL.");
  }
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
