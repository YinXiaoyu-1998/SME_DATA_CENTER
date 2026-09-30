import { createHash } from "node:crypto";
import type { StorageAdapter } from "@smedc/storage";
import type { QdrantEvidenceWriter } from "./evidence-index.js";
import type { ClaimedProcessingRun } from "./worker.js";

export interface PdfEvidenceAttempt {
  id: string;
  orgId: string;
  documentId: string;
  runId: string;
  attemptNumber: number;
  contentVersion: number;
  retrievalConfigVersion: string;
  parserFingerprint: string;
  generation: string;
  collection: string;
  pointIds: string[];
  parsedObjectKey: string;
  state: string;
}
export interface PdfEvidenceAttemptRepository {
  stage(input: { attempt: PdfEvidenceAttempt; workerId: string; now: Date }): Promise<void>;
  listRecoverable(input: { now: Date; limit: number }): Promise<PdfEvidenceAttempt[]>;
  claimCleanup(input: {
    id: string;
    now: Date;
    settledWorkerId?: string;
    expected?: PdfEvidenceAttempt;
  }): Promise<"owned" | "live" | "cleanup">;
  finishCleanup(id: string): Promise<void>;
}
export function pdfCandidateIdentity(
  run: ClaimedProcessingRun,
  checksum: string,
  fingerprint: string,
  config: string
) {
  const hash = (value: string) => createHash("sha256").update(value).digest("hex");
  const generation = hash(
    JSON.stringify([
      run.orgId,
      run.documentId,
      run.document?.contentVersion ?? 1,
      checksum,
      fingerprint,
      run.id,
      run.attemptNumber,
      config
    ])
  );
  return {
    id: `pdf_${generation.slice(0, 28)}`,
    generation,
    parsedObjectKey: `org/${hash(run.orgId)}/documents/${hash(run.documentId)}/parsed/v${run.document?.contentVersion ?? 1}/${checksum}/${hash(fingerprint)}/${generation}.json`
  };
}
/** DB ownership is checked before any deletion. Unknown commit outcomes retain the manifest. */
export async function reconcilePdfEvidenceAttempt(input: {
  attempt: PdfEvidenceAttempt;
  repository: PdfEvidenceAttemptRepository;
  storage: Pick<StorageAdapter, "deleteObject">;
  qdrantWriter: Pick<QdrantEvidenceWriter, "deleteEvidencePoints">;
  settledWorkerId?: string;
  now?: Date;
}): Promise<"owned" | "live" | "cleaned"> {
  const disposition = await input.repository.claimCleanup({
    id: input.attempt.id,
    expected: input.attempt,
    now: input.now ?? new Date(),
    settledWorkerId: input.settledWorkerId
  });
  if (disposition !== "cleanup") return disposition;
  if (!input.qdrantWriter.deleteEvidencePoints)
    throw new Error("PDF artifact cleanup is not configured.");
  await input.qdrantWriter.deleteEvidencePoints({
    collection: input.attempt.collection,
    pointIds: input.attempt.pointIds
  });
  await input.storage.deleteObject(input.attempt.parsedObjectKey);
  await input.repository.finishCleanup(input.attempt.id);
  return "cleaned";
}

export class PdfArtifactRecoveryError extends Error {
  readonly code = "PDF_ARTIFACT_RECOVERY_REQUIRED";
  readonly retryable = true;
  constructor() {
    super("PDF artifact recovery remains pending.");
  }
}

/** Scalars intentionally outlive run/document deletion so cleanup ownership is not lost. */
export function createPrismaPdfEvidenceAttemptRepository(
  prisma: import("@prisma/client").PrismaClient
): PdfEvidenceAttemptRepository {
  return {
    async stage({ attempt, workerId, now }) {
      if (
        attempt.pointIds.length > 5000 ||
        new Set(attempt.pointIds).size !== attempt.pointIds.length
      )
        throw new Error("Invalid PDF attempt point manifest.");
      await prisma.$transaction(async (tx) => {
        const run = await tx.processingRun.findFirst({
          where: {
            id: attempt.runId,
            orgId: attempt.orgId,
            documentId: attempt.documentId,
            attemptNumber: attempt.attemptNumber,
            status: "running",
            lockedBy: workerId,
            lockedUntil: { gt: now },
            document: {
              orgId: attempt.orgId,
              contentVersion: attempt.contentVersion,
              fileType: "pdf"
            }
          }
        });
        if (!run) throw new Error("PDF attempt lease is no longer current.");
        await tx.pdfEvidenceAttempt.create({ data: { ...attempt, pointIds: attempt.pointIds } });
      });
    },
    async listRecoverable({ now, limit }) {
      const records = await prisma.pdfEvidenceAttempt.findMany({
        where: {
          state: { in: ["staged", "active", "cleanup", "cleaned"] },
          nextRecoveryAt: { lte: now }
        },
        orderBy: { nextRecoveryAt: "asc" },
        take: Math.min(limit, 10)
      });
      return records.map((record) => ({ ...record, pointIds: readPointIds(record.pointIds) }));
    },
    async claimCleanup({ id, now, settledWorkerId, expected }) {
      return prisma.$transaction(async (tx) => {
        // A locking UPDATE waits for in-flight activation, unlike an ordinary MVCC SELECT.
        const locked = await tx.pdfEvidenceAttempt.updateMany({
          where: { id },
          data: { nextRecoveryAt: new Date(now.getTime() + 300_000) }
        });
        if (locked.count !== 1) throw new Error("PDF attempt manifest is unavailable.");
        const attempt = await tx.pdfEvidenceAttempt.findUniqueOrThrow({ where: { id } });
        const pointIds = readPointIds(attempt.pointIds);
        if (expected) {
          const fields = [
            "orgId",
            "documentId",
            "runId",
            "attemptNumber",
            "contentVersion",
            "retrievalConfigVersion",
            "parserFingerprint",
            "generation",
            "collection",
            "parsedObjectKey"
          ] as const;
          if (
            fields.some((field) => attempt[field] !== expected[field]) ||
            JSON.stringify(pointIds) !== JSON.stringify(expected.pointIds)
          )
            throw new Error("PDF manifest ownership does not match.");
        }
        const ownedObject = await tx.documentIndex.findFirst({
          where: { parsedObjectKey: attempt.parsedObjectKey },
          select: { id: true }
        });
        const ownedPoint = pointIds.length
          ? await tx.documentChunk.findFirst({
              where: { qdrantPointId: { in: pointIds } },
              select: { id: true }
            })
          : null;
        if (ownedObject || ownedPoint) {
          await tx.pdfEvidenceAttempt.update({
            where: { id },
            data: { state: "active", nextRecoveryAt: new Date(now.getTime() + 86_400_000) }
          });
          return "owned";
        }
        const run = await tx.processingRun.findUnique({ where: { id: attempt.runId } });
        const live =
          run?.status === "running" &&
          run.attemptNumber === attempt.attemptNumber &&
          run.lockedUntil &&
          run.lockedUntil > now;
        if (live && run.lockedBy !== settledWorkerId) {
          await tx.pdfEvidenceAttempt.update({
            where: { id },
            data: { nextRecoveryAt: new Date(run.lockedUntil!.getTime() + 60_000) }
          });
          return "live";
        }
        await tx.pdfEvidenceAttempt.update({ where: { id }, data: { state: "cleanup" } });
        return "cleanup";
      });
    },
    async finishCleanup(id) {
      // Keep the exact manifest, and revisit it after late/ambiguous external writes.
      await prisma.pdfEvidenceAttempt.updateMany({
        where: { id, state: "cleanup" },
        data: { state: "cleaned", nextRecoveryAt: new Date(Date.now() + 86_400_000) }
      });
    }
  };
}
function readPointIds(value: unknown): string[] {
  if (
    !Array.isArray(value) ||
    value.length > 5000 ||
    !value.every((id) => typeof id === "string" && id.length > 0 && id.length <= 128)
  )
    throw new Error("Invalid PDF attempt point manifest.");
  return value as string[];
}
