import { Prisma, type PrismaClient } from "@prisma/client";
import { enqueueStorageGarbage, storageGarbageKeyHash } from "@smedc/db";
import { createPrismaLedgerArtifactAccess } from "./access.js";
import { createPrismaLedgerSourceReader } from "./source-reader.js";
import { lockLedgerSourceMutation } from "./changes.js";
import { reduceLedgerRequestStatus } from "./service.js";
import type { LedgerPartitionKey, LedgerSourceRef } from "./types.js";

export type LedgerLeaseToken = { runId: string; lockedBy: string; attemptNumber: number };
export type LedgerPdfCandidate = {
  objectKey: string;
  byteSize: number;
  checksumSha256: string;
  pageCount: number;
};
export type PublishLedgerPdfInput = {
  partitionId: string;
  generation: number;
  dataRevision: number;
  sourceFingerprint: string;
  leaseToken: LedgerLeaseToken;
  candidate: LedgerPdfCandidate | null;
  sources: LedgerSourceRef[];
  rowCount: number;
  certificateCount: number;
};
export class LedgerPublicationError extends Error {
  constructor(
    readonly code: string,
    readonly retryable: boolean
  ) {
    super(code);
  }
}

export async function updateLedgerRefreshRequestStatus(
  tx: Prisma.TransactionClient,
  orgId: string,
  requestId: string
): Promise<void> {
  const request = await tx.ledgerArtifactRequest.findFirstOrThrow({
    where: { id: requestId, orgId }
  });
  const scope = request.scope as { internal?: boolean; enumerationComplete?: boolean };
  const items = await tx.ledgerArtifactRequestItem.groupBy({
    where: { orgId, requestId },
    by: ["status"]
  });
  const status =
    scope.internal && !scope.enumerationComplete
      ? "running"
      : reduceLedgerRequestStatus(items.map((item) => item.status));
  await tx.ledgerArtifactRequest.update({ where: { id: requestId }, data: { status } });
}

export function createPrismaLedgerPublicationArchive({
  prisma,
  now = () => new Date()
}: {
  prisma: PrismaClient;
  now?: () => Date;
}) {
  const reader = createPrismaLedgerSourceReader({ prisma });
  const access = createPrismaLedgerArtifactAccess({ prisma });
  async function lockLease(tx: Prisma.TransactionClient, token: LedgerLeaseToken, orgId: string) {
    await lockLedgerSourceMutation(tx, orgId);
    await tx.$queryRaw(
      Prisma.sql`SELECT id FROM processing_runs WHERE id = ${token.runId} FOR UPDATE`
    );
    const run = await tx.processingRun.findFirst({
      where: {
        id: token.runId,
        orgId,
        status: "running",
        lockedBy: token.lockedBy,
        attemptNumber: token.attemptNumber,
        lockedUntil: { gt: now() }
      }
    });
    if (!run) throw new LedgerPublicationError("PROCESSING_LEASE_LOST", false);
    return run;
  }
  return {
    readLedgerSnapshot: reader.readLedgerSnapshot,
    async getGeneration(input: { runId: string; orgId: string }) {
      const run = await prisma.processingRun.findFirstOrThrow({
        where: { id: input.runId, orgId: input.orgId, jobType: "ledger_pdf_generate" },
        include: { ledgerArtifactRequestItem: { include: { partition: true } } }
      });
      const item = run.ledgerArtifactRequestItem;
      if (!item) throw new LedgerPublicationError("LEDGER_GENERATION_JOB_INVALID", false);
      const key: LedgerPartitionKey = {
        orgId: run.orgId,
        storeName: item.partition.storeName,
        purchaseDate: item.partition.purchaseDate.toISOString().slice(0, 10)
      };
      return { partitionId: item.partitionId, generation: item.generation, key };
    },
    async registerCandidate(input: {
      orgId: string;
      leaseToken: LedgerLeaseToken;
      objectKey: string;
    }) {
      await prisma.$transaction(
        async (tx) => {
          await lockLease(tx, input.leaseToken, input.orgId);
          await enqueueStorageGarbage(tx, {
            objectKey: input.objectKey,
            reason: "ledger_upload_candidate",
            processingRunId: input.leaseToken.runId
          });
        },
        { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted }
      );
    },
    async leaseIsActive(
      token: Pick<LedgerLeaseToken, "runId" | "attemptNumber"> & { lockedBy?: string }
    ): Promise<boolean> {
      return Boolean(
        await prisma.processingRun.findFirst({
          where: {
            id: token.runId,
            status: "running",
            lockedBy: token.lockedBy,
            attemptNumber: token.attemptNumber,
            lockedUntil: { gt: now() }
          },
          select: { id: true }
        })
      );
    },
    async publishLedgerPdf(input: PublishLedgerPdfInput): Promise<"published" | "superseded"> {
      return prisma.$transaction(
        async (tx) => {
          const preliminary = await tx.processingRun.findUniqueOrThrow({
            where: { id: input.leaseToken.runId }
          });
          const run = await lockLease(tx, input.leaseToken, preliminary.orgId);
          if (run.jobType !== "ledger_pdf_generate" || !run.ledgerArtifactRequestItemId)
            throw new LedgerPublicationError("LEDGER_GENERATION_JOB_INVALID", false);
          const item = await tx.ledgerArtifactRequestItem.findFirstOrThrow({
            where: { id: run.ledgerArtifactRequestItemId, orgId: run.orgId }
          });
          if (item.partitionId !== input.partitionId || item.generation !== input.generation)
            throw new LedgerPublicationError("LEDGER_GENERATION_JOB_INVALID", false);
          await tx.$queryRaw(
            Prisma.sql`SELECT id FROM ledger_pdf_partitions WHERE id = ${input.partitionId} AND org_id = ${run.orgId} FOR UPDATE`
          );
          const partition = await tx.ledgerPdfPartition.findFirstOrThrow({
            where: { id: input.partitionId, orgId: run.orgId }
          });
          const superseded = partition.requestedGeneration !== input.generation;
          // A dirty revision alone has no replacement job. Keep this generation alive and
          // let the bounded worker retry read a fresh snapshot instead of orphaning repair.
          if (!superseded && partition.dataRevision !== input.dataRevision)
            throw new LedgerPublicationError("LEDGER_SOURCE_CHANGED", true);
          if (
            !superseded &&
            !(await access.sourcesAreCurrent({ orgId: run.orgId, sources: input.sources, tx }))
          )
            throw new LedgerPublicationError("LEDGER_SOURCE_CHANGED", true);
          if (!superseded) {
            if (
              partition.currentObjectKey &&
              partition.currentObjectKey !== input.candidate?.objectKey
            )
              await enqueueStorageGarbage(tx, {
                objectKey: partition.currentObjectKey,
                reason: "ledger_pdf_replaced"
              });
            if (input.candidate) {
              const garbage = await tx.storageGarbage.findUnique({
                where: { objectKeyHash: storageGarbageKeyHash(input.candidate.objectKey) }
              });
              if (
                !garbage ||
                garbage.objectKey !== input.candidate.objectKey ||
                garbage.processingRunId !== run.id
              )
                throw new LedgerPublicationError("LEDGER_CANDIDATE_NOT_REGISTERED", false);
              if (
                !Number.isSafeInteger(input.candidate.byteSize) ||
                input.candidate.byteSize <= 0 ||
                input.candidate.byteSize > 200 * 1024 * 1024 ||
                !/^[a-f0-9]{64}$/.test(input.candidate.checksumSha256) ||
                !Number.isSafeInteger(input.candidate.pageCount) ||
                input.candidate.pageCount < 1 + input.certificateCount
              )
                throw new LedgerPublicationError("LEDGER_PDF_INVALID", false);
              await tx.storageGarbage.delete({ where: { id: garbage.id } });
            }
            await tx.ledgerPdfPartition.update({
              where: { id: partition.id },
              data: {
                publishedGeneration: input.generation,
                publishedDataRevision: input.dataRevision,
                publishedSourceFingerprint: input.sourceFingerprint,
                currentObjectKey: input.candidate?.objectKey ?? null,
                checksumSha256: input.candidate?.checksumSha256 ?? null,
                byteSize: input.candidate ? BigInt(input.candidate.byteSize) : null,
                rowCount: input.rowCount,
                certificateCount: input.certificateCount,
                confidentialityLevel: Math.max(
                  0,
                  ...input.sources.map((source) => source.confidentialityLevel)
                ),
                templateVersion: "food-purchase-ledger-cn-v2",
                generatedAt: now(),
                errorCode: null
              }
            });
            await tx.ledgerPdfSource.deleteMany({
              where: { partitionId: partition.id, orgId: run.orgId }
            });
            if (input.sources.length)
              await tx.ledgerPdfSource.createMany({
                data: input.sources.map((source) => ({
                  ...source,
                  orgId: run.orgId,
                  partitionId: partition.id
                }))
              });
          }
          // The run lock prevents reclaims, but time still passes inside this transaction.
          const finishedAt = now();
          const completed = await tx.processingRun.updateMany({
            where: {
              id: run.id,
              status: "running",
              lockedBy: input.leaseToken.lockedBy,
              attemptNumber: input.leaseToken.attemptNumber,
              lockedUntil: { gt: finishedAt }
            },
            data: {
              status: "succeeded",
              lockedBy: null,
              lockedUntil: null,
              finishedAt,
              errorCode: null,
              errorSummary: null
            }
          });
          if (completed.count !== 1)
            throw new LedgerPublicationError("PROCESSING_LEASE_LOST", false);
          await tx.ledgerArtifactRequestItem.update({
            where: { id: item.id },
            data: {
              status: superseded ? "superseded" : input.candidate ? "succeeded" : "empty",
              dataRevision: input.dataRevision,
              errorCode: null
            }
          });
          await updateLedgerRefreshRequestStatus(tx, run.orgId, item.requestId);
          return superseded ? "superseded" : "published";
        },
        { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted, timeout: 30_000 }
      );
    }
  };
}
