import { randomUUID } from "node:crypto";
import { Prisma, type CostCard, type PrismaClient } from "@prisma/client";
import {
  COST_CARD_CATALOG_BATCH_SIZE,
  COST_CARD_CANONICALIZATION_VERSION,
  COST_CARD_REPLACED_OBJECT_GRACE_SECONDS,
  type CostCardFields,
  type CostCardIdentity,
  type CostCardChange,
  type CostCardPublication
} from "@smedc/domain";
import {
  lockAuthorizationPublication,
  persistCostCardReadRequirement,
  persistStructuredSourceReadRequirements,
  requireCurrentUploadAdmin
} from "./source-read-requirements.js";
import { storageGarbageKeyHash, enqueueStorageGarbage } from "./storage-garbage.js";

export type CostCardBaseline = Pick<
  CostCard,
  "id" | "revision" | "contentHash" | "objectKey" | "canonicalizationVersion" | "archivedAt"
>;
export interface PreparedCostCardCandidate {
  id: string;
  identity: CostCardIdentity;
  baseline: CostCardBaseline | null;
  card: CostCardFields;
  contentHash: string;
  canonicalizationVersion: number;
  schemaVersion: number;
  objectKey: string | null;
  checksumSha256: string;
  byteSize: number;
  itemRowCount: number;
  recipeCount: number;
}
export interface PreparedCostCardPublication {
  candidates: PreparedCostCardCandidate[];
  inputItemRowCount: number;
  changes: CostCardChange[];
  changesTruncated: boolean;
}
export interface CostCardPublishInput extends PreparedCostCardPublication {
  orgId: string;
  enterpriseName: string;
  sourceDocumentId: string;
  importBatchId: string;
  actorId: string;
  runId: string;
  workerId: string;
  attemptNumber: number;
  now: Date;
  sourceSheetSummary: Prisma.InputJsonValue;
}
export class CostCardPublicationError extends Error {
  constructor(
    readonly code: string,
    readonly retryable = false
  ) {
    super(code);
  }
}
export function costCardOperation(
  current: CostCardBaseline | null,
  hash: string,
  version: number
): keyof CostCardPublication["counts"] {
  if (
    version !== COST_CARD_CANONICALIZATION_VERSION ||
    (current && current.canonicalizationVersion !== version)
  )
    throw new CostCardPublicationError("COST_CARD_VERSION_UNSUPPORTED");
  return !current
    ? "inserted"
    : current.archivedAt
      ? "restored"
      : current.contentHash === hash
        ? "unchanged"
        : "updated";
}
export function costCardBaselineMatches(
  a: CostCardBaseline | null,
  b: CostCardBaseline | null
): boolean {
  return a === null || b === null
    ? a === b
    : a.id === b.id &&
        a.revision === b.revision &&
        a.contentHash === b.contentHash &&
        a.objectKey === b.objectKey &&
        a.canonicalizationVersion === b.canonicalizationVersion &&
        a.archivedAt?.getTime() === b.archivedAt?.getTime();
}
export function costCardIdentityKey(identity: CostCardIdentity): string {
  return JSON.stringify([
    identity.enterpriseKey,
    identity.sourceNamespace,
    identity.spuId,
    identity.skuId
  ]);
}
export async function readCostCardBaselines(
  reader: Pick<PrismaClient, "costCard">,
  orgId: string,
  identities: readonly CostCardIdentity[]
): Promise<Map<string, CostCard>> {
  const result = new Map<string, CostCard>();
  for (let offset = 0; offset < identities.length; offset += COST_CARD_CATALOG_BATCH_SIZE) {
    const rows = await reader.costCard.findMany({
      where: {
        orgId,
        OR: identities
          .slice(offset, offset + COST_CARD_CATALOG_BATCH_SIZE)
          .map((identity) => ({ ...identity }))
      }
    });
    for (const row of rows)
      result.set(costCardIdentityKey({ ...row, sourceNamespace: "meituan" }), row);
  }
  return result;
}

/** Objects are prepared before entry. This function performs metadata writes only. */
export async function publishCostCards(
  tx: Prisma.TransactionClient,
  input: CostCardPublishInput
): Promise<CostCardPublication> {
  const state = await lockAuthorizationPublication(tx, input.orgId);
  if (state.mode !== "enabled") throw new CostCardPublicationError("AUTHORIZATION_NOT_ENABLED");
  const leased = await tx.processingRun.updateMany({
    where: {
      id: input.runId,
      orgId: input.orgId,
      documentId: input.sourceDocumentId,
      jobType: "structured_import",
      status: "running",
      lockedBy: input.workerId,
      attemptNumber: input.attemptNumber,
      lockedUntil: { gt: input.now }
    },
    data: { lastHeartbeatAt: input.now }
  });
  if (leased.count !== 1) throw new CostCardPublicationError("PROCESSING_LEASE_LOST");
  await tx.$queryRaw(Prisma.sql`SELECT id FROM organizations WHERE id = ${input.orgId} FOR UPDATE`);
  await requireCurrentUploadAdmin(tx, input.orgId, input.actorId);
  const batch = await tx.importBatch.findFirst({
    where: {
      id: input.importBatchId,
      sourceDocumentId: input.sourceDocumentId,
      orgId: input.orgId,
      dataset: "cost_cards",
      status: { in: ["validating", "applying"] }
    }
  });
  if (!batch) throw new CostCardPublicationError("COST_CARD_BATCH_NOT_APPLICABLE");
  const identities = input.candidates.map((candidate) => candidate.identity);
  const keys = identities.map(costCardIdentityKey);
  const objectKeys = input.candidates.flatMap((candidate) =>
    candidate.objectKey ? [candidate.objectKey] : []
  );
  if (
    !keys.length ||
    new Set(keys).size !== keys.length ||
    new Set(objectKeys).size !== objectKeys.length ||
    identities.some((identity) => identity.enterpriseKey !== identities[0]!.enterpriseKey) ||
    input.candidates.some(
      (candidate) => candidate.baseline && candidate.id !== candidate.baseline.id
    ) ||
    input.inputItemRowCount !==
      input.candidates.reduce((sum, candidate) => sum + candidate.itemRowCount, 0)
  )
    throw new CostCardPublicationError("COST_CARD_INVALID_INPUT");
  // ReadCommitted caller plus the organization lock serializes absent and existing identities.
  const current = await readCostCardBaselines(tx, input.orgId, identities);
  for (const candidate of input.candidates)
    if (
      !costCardBaselineMatches(
        candidate.baseline,
        current.get(costCardIdentityKey(candidate.identity)) ?? null
      )
    )
      throw new CostCardPublicationError("COST_CARD_BASELINE_STALE", true);
  const publication: CostCardPublication = {
    inputCardCount: keys.length,
    inputItemRowCount: input.inputItemRowCount,
    counts: { inserted: 0, updated: 0, unchanged: 0, restored: 0 },
    changes: input.changes,
    changesTruncated: input.changesTruncated
  };
  const writes: Prisma.Sql[] = [];
  for (const candidate of input.candidates) {
    const operation = costCardOperation(
      candidate.baseline,
      candidate.contentHash,
      candidate.canonicalizationVersion
    );
    publication.counts[operation]++;
    if (operation === "unchanged") continue;
    if (!candidate.objectKey) throw new CostCardPublicationError("COST_CARD_OBJECT_NOT_PREPARED");
    const ownership = await tx.storageGarbage.findUnique({
      where: { objectKeyHash: storageGarbageKeyHash(candidate.objectKey) }
    });
    if (
      !ownership ||
      ownership.objectKey !== candidate.objectKey ||
      ownership.processingRunId !== input.runId ||
      !ownership.repeatDeletion
    )
      throw new CostCardPublicationError("COST_CARD_OBJECT_NOT_OWNED");
    const f = candidate.card;
    const revision = (candidate.baseline?.revision ?? 0n) + 1n;
    writes.push(
      Prisma.sql`(${candidate.id}, ${input.orgId}, ${candidate.identity.enterpriseKey}, ${input.enterpriseName}, ${candidate.identity.sourceNamespace}, ${candidate.identity.spuId}, ${candidate.identity.skuId}, ${f.dish_name}, ${f.specification_name}, ${f.base_category_name}, ${f.sale_price}, ${f.has_cost_card}, ${f.source_dish_deleted}, ${candidate.objectKey}, ${candidate.checksumSha256}, ${BigInt(candidate.byteSize)}, ${BigInt(candidate.itemRowCount)}, ${candidate.recipeCount}, ${candidate.schemaVersion}, ${candidate.contentHash}, ${candidate.canonicalizationVersion}, ${input.sourceDocumentId}, ${input.importBatchId}, ${revision}, NULL, ${input.now}, ${input.now})`
    );
    await persistCostCardReadRequirement(
      tx,
      {
        orgId: input.orgId,
        costCardId: candidate.id,
        enterpriseKey: candidate.identity.enterpriseKey,
        workerId: input.workerId
      },
      state
    );
    await tx.storageGarbage.delete({ where: { id: ownership.id } });
    if (candidate.baseline)
      await enqueueStorageGarbage(tx, {
        objectKey: candidate.baseline.objectKey,
        reason: "cost_card_replaced",
        availableAt: new Date(input.now.getTime() + COST_CARD_REPLACED_OBJECT_GRACE_SECONDS * 1000)
      });
  }
  for (let offset = 0; offset < writes.length; offset += COST_CARD_CATALOG_BATCH_SIZE) {
    await tx.$executeRaw(Prisma.sql`INSERT INTO cost_cards (id, org_id, enterprise_key, enterprise_name, source_namespace, spu_id, sku_id, dish_name, specification_name, base_category_name, sale_price, has_cost_card, source_dish_deleted, object_key, checksum_sha256, byte_size, item_row_count, recipe_count, csv_schema_version, content_hash, canonicalization_version, source_document_id, import_batch_id, revision, archived_at, created_at, updated_at)
      VALUES ${Prisma.join(writes.slice(offset, offset + COST_CARD_CATALOG_BATCH_SIZE))}
      ON DUPLICATE KEY UPDATE enterprise_name=VALUES(enterprise_name), dish_name=VALUES(dish_name), specification_name=VALUES(specification_name), base_category_name=VALUES(base_category_name), sale_price=VALUES(sale_price), has_cost_card=VALUES(has_cost_card), source_dish_deleted=VALUES(source_dish_deleted), object_key=VALUES(object_key), checksum_sha256=VALUES(checksum_sha256), byte_size=VALUES(byte_size), item_row_count=VALUES(item_row_count), recipe_count=VALUES(recipe_count), csv_schema_version=VALUES(csv_schema_version), content_hash=VALUES(content_hash), canonicalization_version=VALUES(canonicalization_version), source_document_id=VALUES(source_document_id), import_batch_id=VALUES(import_batch_id), revision=VALUES(revision), archived_at=NULL, updated_at=VALUES(updated_at)`);
  }
  // Register complete input, including unchanged cards; recipe/item bodies never enter MySQL.
  await persistStructuredSourceReadRequirements(tx, {
    orgId: input.orgId,
    sourceDocumentId: input.sourceDocumentId,
    dataset: "cost_cards",
    enterpriseKey: identities[0]!.enterpriseKey,
    rows: [{ payload: {} }],
    workerId: input.workerId,
    authorizationState: state
  });
  await tx.importBatch.update({
    where: { id: batch.id },
    data: {
      status: "applied",
      appliedAt: input.now,
      totalRowCount: input.inputItemRowCount,
      appliedRowCount: input.inputItemRowCount,
      publicationSummary: publication as unknown as Prisma.InputJsonValue,
      sourceSheetSummary: input.sourceSheetSummary,
      validationErrors: [],
      validationErrorCount: 0,
      errorCode: null,
      errorSummary: null
    }
  });
  await tx.document.update({ where: { id: input.sourceDocumentId }, data: { status: "active" } });
  await tx.processingRun.update({
    where: { id: input.runId },
    data: {
      status: "succeeded",
      lockedBy: null,
      lockedUntil: null,
      finishedAt: input.now,
      errorCode: null,
      errorSummary: null
    }
  });
  await tx.auditLog.create({
    data: {
      orgId: input.orgId,
      actorEmployeeId: null,
      clientSource: "worker",
      action: "structured_import.applied",
      targetType: "import_batch",
      targetId: batch.id,
      result: "succeeded",
      metadata: {
        workerId: input.workerId,
        processingRunId: input.runId,
        dataset: "cost_cards",
        counts: { ...publication.counts }
      }
    }
  });
  return publication;
}

export async function archiveCostCard(
  tx: Prisma.TransactionClient,
  input: { orgId: string; actorId: string; costCardId: string }
): Promise<{ costCardId: string; archived: true; revision: string }> {
  await lockAuthorizationPublication(tx, input.orgId);
  await tx.$queryRaw(Prisma.sql`SELECT id FROM organizations WHERE id = ${input.orgId} FOR UPDATE`);
  await requireCurrentUploadAdmin(tx, input.orgId, input.actorId);
  const card = await tx.costCard.findFirst({ where: { id: input.costCardId, orgId: input.orgId } });
  if (!card) throw new CostCardPublicationError("COST_CARD_NOT_FOUND");
  if (card.archivedAt)
    return { costCardId: card.id, archived: true, revision: card.revision.toString() };
  const updated = await tx.costCard.update({
    where: { id: card.id },
    data: { archivedAt: new Date(), revision: { increment: 1 } }
  });
  await tx.businessResource.updateMany({
    where: { orgId: input.orgId, kind: "cost_card", resourceKey: `cost-card:${card.id}` },
    data: { valid: false, authorizationVersion: { increment: 1 }, contentVersion: { increment: 1 } }
  });
  await tx.auditLog.create({
    data: {
      orgId: input.orgId,
      actorEmployeeId: input.actorId,
      action: "cost_card.archived",
      targetType: "cost_card",
      targetId: card.id,
      result: "succeeded",
      metadata: { revision: updated.revision.toString() }
    }
  });
  return { costCardId: card.id, archived: true, revision: updated.revision.toString() };
}
export function createCostCardId(): string {
  return randomUUID().replaceAll("-", "");
}
