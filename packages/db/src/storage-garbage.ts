import { createHash, randomUUID } from "node:crypto";
import { Prisma } from "@prisma/client";

export function storageGarbageKeyHash(objectKey: string): string {
  return createHash("sha256").update(objectKey, "utf8").digest("hex");
}

/** Exact keys only. Active processing leases protect registered upload candidates from GC. */
export async function enqueueStorageGarbage(
  tx: Pick<Prisma.TransactionClient, "storageGarbage">,
  input: { objectKey: string; reason: string; availableAt?: Date; processingRunId?: string }
): Promise<void> {
  const objectKeyHash = storageGarbageKeyHash(input.objectKey);
  const row = await tx.storageGarbage.upsert({
    where: { objectKeyHash },
    create: {
      id: randomUUID().replaceAll("-", ""),
      ...input,
      objectKeyHash,
      repeatDeletion: Boolean(input.processingRunId)
    },
    update: {
      reason: input.reason,
      availableAt: input.availableAt ?? new Date(),
      lastErrorCode: null,
      processingRunId: input.processingRunId ?? null,
      repeatDeletion: Boolean(input.processingRunId)
    }
  });
  if (row.objectKey !== input.objectKey) throw new Error("STORAGE_GARBAGE_HASH_COLLISION");
}

export async function listDueStorageGarbage(
  tx: Pick<Prisma.TransactionClient, "$queryRaw">,
  now: Date,
  limit: number
): Promise<{ id: string; objectKey: string }[]> {
  if (!Number.isSafeInteger(limit) || limit < 1) throw new Error("STORAGE_GARBAGE_LIMIT_INVALID");
  return tx.$queryRaw(Prisma.sql`
    SELECT g.id, g.object_key AS objectKey FROM storage_garbage g
    LEFT JOIN processing_runs r ON r.id = g.processing_run_id
    WHERE g.available_at <= ${now}
      AND (r.id IS NULL OR r.status <> 'running' OR r.locked_until IS NULL OR r.locked_until <= ${now})
      AND NOT EXISTS (SELECT 1 FROM cost_cards c WHERE BINARY c.object_key = BINARY g.object_key)
    ORDER BY g.available_at, g.id LIMIT ${limit}
  `);
}

/** Caller must use a READ COMMITTED transaction; lock run before queue, as publication does. */
export async function canDeleteStorageGarbage(
  tx: Prisma.TransactionClient,
  input: { id: string; objectKey: string; now: Date }
): Promise<boolean> {
  const candidate = await tx.storageGarbage.findUnique({ where: { id: input.id } });
  if (!candidate || candidate.objectKey !== input.objectKey) return false;
  const runs = candidate.processingRunId
    ? await tx.$queryRaw<Array<{ status: string; lockedUntil: Date | null }>>(Prisma.sql`
        SELECT status, locked_until AS lockedUntil FROM processing_runs
        WHERE id = ${candidate.processingRunId} FOR UPDATE
      `)
    : [];
  const locked = await tx.$queryRaw<Array<{ processingRunId: string | null }>>(Prisma.sql`
    SELECT processing_run_id AS processingRunId FROM storage_garbage
    WHERE id = ${input.id} AND BINARY object_key = BINARY ${input.objectKey} FOR UPDATE
  `);
  if (locked.length !== 1 || locked[0]!.processingRunId !== candidate.processingRunId) return false;
  const run = runs[0];
  const leaseNow = new Date();
  if (run?.status === "running" && run.lockedUntil && run.lockedUntil > leaseNow) return false;
  // A fresh RC statement after acquiring the locks observes committed current/archived references.
  const rows = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    SELECT g.id FROM storage_garbage g
    WHERE g.id = ${input.id} AND BINARY g.object_key = BINARY ${input.objectKey}
      AND g.available_at <= ${input.now}
      AND NOT EXISTS (SELECT 1 FROM cost_cards c WHERE BINARY c.object_key = BINARY g.object_key)
  `);
  return rows.length === 1;
}
