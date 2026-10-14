import { randomUUID } from "node:crypto";
import { Prisma, PrismaClient, type CostCard } from "@prisma/client";
import { createDatabaseAdapter } from "./adapter.js";
import { toResourceReadRequirement } from "./business-authorization-records.js";
import { createBusinessAuthorizationRepository } from "./business-authorization.js";
import { compileStructuredReadScope } from "./business-authorization-sql.js";
import {
  COST_CARD_CATALOG_BATCH_SIZE,
  COST_CARD_CANONICALIZATION_VERSION,
  COST_CARD_REPLACED_OBJECT_GRACE_SECONDS,
  COST_CARD_PUBLICATION_TRANSACTION_TIMEOUT_MS,
  type CostCardFields,
  type CostCardIdentity,
  type CostCardChange,
  type CostCardPublication
} from "@smedc/domain";
import {
  compileCostCardSelection,
  parseCostCardSelection,
  isBusinessClearance,
  type AuthenticatedEmployee,
  type CostCardSelection,
  type CostCardCoverage
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
  | "id"
  | "revision"
  | "contentHash"
  | "objectKey"
  | "canonicalizationVersion"
  | "csvSchemaVersion"
  | "archivedAt"
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
        a.csvSchemaVersion === b.csvSchemaVersion &&
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
  await tx.$queryRaw(
    Prisma.sql`SELECT id FROM processing_runs WHERE id = ${input.runId} FOR UPDATE`
  );
  const leaseNow = new Date();
  const leased = await tx.processingRun.updateMany({
    where: {
      id: input.runId,
      orgId: input.orgId,
      documentId: input.sourceDocumentId,
      jobType: "structured_import",
      status: "running",
      lockedBy: input.workerId,
      attemptNumber: input.attemptNumber,
      lockedUntil: { gt: leaseNow }
    },
    data: { lastHeartbeatAt: leaseNow }
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
    new Set(input.candidates.map((candidate) => candidate.id)).size !== input.candidates.length ||
    new Set(objectKeys).size !== objectKeys.length ||
    identities.some((identity) => identity.enterpriseKey !== identities[0]!.enterpriseKey) ||
    input.candidates.some(
      (candidate) =>
        (candidate.baseline && candidate.id !== candidate.baseline.id) ||
        candidate.card.spu_id !== candidate.identity.spuId ||
        candidate.card.sku_id !== candidate.identity.skuId
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
  const inserts: Prisma.CostCardCreateManyInput[] = [];
  const updates: Prisma.CostCardCreateManyInput[] = [];
  for (const candidate of input.candidates) {
    const operation = costCardOperation(
      candidate.baseline,
      candidate.contentHash,
      candidate.canonicalizationVersion
    );
    publication.counts[operation]++;
    if (operation === "unchanged") continue;
    if (!candidate.objectKey) throw new CostCardPublicationError("COST_CARD_OBJECT_NOT_PREPARED");
    if (
      !candidate.objectKey.startsWith(
        `cost-cards/${input.orgId}/${input.runId}/${input.attemptNumber}/`
      )
    )
      throw new CostCardPublicationError("COST_CARD_OBJECT_NOT_OWNED");
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
    const data: Prisma.CostCardCreateManyInput = {
      id: candidate.id,
      orgId: input.orgId,
      ...candidate.identity,
      enterpriseName: input.enterpriseName,
      dishName: f.dish_name,
      specificationName: f.specification_name,
      baseCategoryName: f.base_category_name,
      salePrice: f.sale_price,
      hasCostCard: f.has_cost_card,
      sourceDishDeleted: f.source_dish_deleted,
      objectKey: candidate.objectKey,
      checksumSha256: candidate.checksumSha256,
      byteSize: BigInt(candidate.byteSize),
      itemRowCount: BigInt(candidate.itemRowCount),
      recipeCount: candidate.recipeCount,
      csvSchemaVersion: candidate.schemaVersion,
      contentHash: candidate.contentHash,
      canonicalizationVersion: candidate.canonicalizationVersion,
      sourceDocumentId: input.sourceDocumentId,
      importBatchId: input.importBatchId,
      revision,
      archivedAt: null,
      createdAt: input.now,
      updatedAt: input.now
    };
    (candidate.baseline ? updates : inserts).push(data);
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
  // Plain INSERT cannot turn a primary/object-key collision into an unrelated identity update.
  for (let offset = 0; offset < inserts.length; offset += COST_CARD_CATALOG_BATCH_SIZE)
    await tx.costCard.createMany({
      data: inserts.slice(offset, offset + COST_CARD_CATALOG_BATCH_SIZE)
    });
  const mutableColumns = [
    ["enterprise_name", "enterpriseName"],
    ["dish_name", "dishName"],
    ["specification_name", "specificationName"],
    ["base_category_name", "baseCategoryName"],
    ["sale_price", "salePrice"],
    ["has_cost_card", "hasCostCard"],
    ["source_dish_deleted", "sourceDishDeleted"],
    ["object_key", "objectKey"],
    ["checksum_sha256", "checksumSha256"],
    ["byte_size", "byteSize"],
    ["item_row_count", "itemRowCount"],
    ["recipe_count", "recipeCount"],
    ["csv_schema_version", "csvSchemaVersion"],
    ["content_hash", "contentHash"],
    ["canonicalization_version", "canonicalizationVersion"],
    ["source_document_id", "sourceDocumentId"],
    ["import_batch_id", "importBatchId"],
    ["revision", "revision"]
  ] as const;
  const updateBaselines = new Map(
    input.candidates.flatMap((candidate) =>
      candidate.baseline ? [[candidate.id, candidate.baseline] as const] : []
    )
  );
  for (let offset = 0; offset < updates.length; offset += COST_CARD_CATALOG_BATCH_SIZE) {
    const chunk = updates.slice(offset, offset + COST_CARD_CATALOG_BATCH_SIZE);
    const assignments = mutableColumns.map(
      ([column, property]) =>
        Prisma.sql`${Prisma.raw(column)} = CASE id ${Prisma.join(
          chunk.map((row) => Prisma.sql`WHEN ${row.id} THEN ${row[property]}`),
          " "
        )} END`
    );
    const targets = chunk.map((row) => {
      const baseline = updateBaselines.get(row.id!)!;
      return Prisma.sql`(id = ${row.id} AND BINARY enterprise_key = BINARY ${row.enterpriseKey} AND BINARY source_namespace = BINARY ${row.sourceNamespace} AND BINARY spu_id = BINARY ${row.spuId} AND BINARY sku_id = BINARY ${row.skuId} AND revision = ${baseline.revision} AND content_hash = ${baseline.contentHash} AND object_key = ${baseline.objectKey} AND canonicalization_version = ${baseline.canonicalizationVersion} AND ${baseline.archivedAt === null ? Prisma.sql`archived_at IS NULL` : Prisma.sql`archived_at = ${baseline.archivedAt}`})`;
    });
    const written = await tx.$executeRaw(
      Prisma.sql`UPDATE cost_cards SET ${Prisma.join(assignments)}, archived_at = NULL, updated_at = ${input.now} WHERE org_id = ${input.orgId} AND (${Prisma.join(targets, " OR ")})`
    );
    if (written !== chunk.length)
      throw new CostCardPublicationError("COST_CARD_BASELINE_STALE", true);
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

/** Publication summaries describe the retained batch, independently of original-file display state. */
export async function getCostCardPublicationReadRequirements(
  reader: Pick<PrismaClient, "businessResource">,
  orgId: string,
  sourceDocumentId: string
) {
  const rows = await reader.businessResource.findMany({
    where: { orgId, sourceDocumentId, kind: "source_fragment", category: { key: "cost_cards" } },
    include: { scopes: { include: { dimensions: true } } }
  });
  return rows.map(toResourceReadRequirement);
}

export interface CostCardRepository {
  readBaselines(
    orgId: string,
    identities: readonly CostCardIdentity[]
  ): Promise<Map<string, CostCardBaseline>>;
  registerCandidate(input: { objectKey: string; processingRunId: string }): Promise<void>;
  publish(input: CostCardPublishInput): Promise<CostCardPublication>;
  disconnect?(): Promise<void>;
}
export function createPrismaCostCardRepository(client?: PrismaClient): CostCardRepository {
  const prisma =
    client ??
    new PrismaClient({
      adapter: createDatabaseAdapter(
        process.env["DATABASE_URL"] ??
          (() => {
            throw new Error("DATABASE_URL is required for cost cards.");
          })()
      )
    });
  return {
    readBaselines: (orgId, identities) => readCostCardBaselines(prisma, orgId, identities),
    registerCandidate: (input) =>
      enqueueStorageGarbage(prisma, { ...input, reason: "cost_card_candidate" }),
    async publish(input) {
      try {
        return await prisma.$transaction((tx) => publishCostCards(tx, input), {
          isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted,
          timeout: COST_CARD_PUBLICATION_TRANSACTION_TIMEOUT_MS
        });
      } catch (error) {
        // A lost commit acknowledgement must not turn an applied publication into failure.
        const batch = await prisma.importBatch.findFirst({
          where: {
            id: input.importBatchId,
            orgId: input.orgId,
            sourceDocumentId: input.sourceDocumentId,
            dataset: "cost_cards",
            status: "applied"
          }
        });
        if (batch?.publicationSummary)
          return batch.publicationSummary as unknown as CostCardPublication;
        throw error;
      }
    },
    async disconnect() {
      if (!client) await prisma.$disconnect();
    }
  };
}

export type CostCardReadActor = Pick<AuthenticatedEmployee, "id" | "orgId">;
export interface CostCardDirectorySnapshot {
  authorizationVersion: string;
  cards: CostCard[];
}
export interface CostCardDirectoryRepository {
  readSnapshot(input: {
    auth: CostCardReadActor;
    selection: CostCardSelection;
    maxCards: number;
  }): Promise<CostCardDirectorySnapshot>;
  coverage(input: { auth: CostCardReadActor; enterpriseName?: string }): Promise<CostCardCoverage>;
  archive(input: {
    auth: CostCardReadActor;
    costCardId: string;
  }): Promise<{ costCardId: string; archived: true; revision: string }>;
  disconnect?(): Promise<void>;
}
export function safeCostCardInteger(value: number | bigint | string | Prisma.Decimal): number {
  const number = Number(value.toString());
  if (!Number.isSafeInteger(number) || number < 0)
    throw new CostCardPublicationError("COST_CARD_METADATA_INVALID");
  return number;
}
export function createPrismaCostCardDirectoryRepository(
  client?: PrismaClient,
  databaseUrl = process.env["DATABASE_URL"]
): CostCardDirectoryRepository {
  const prisma =
    client ??
    new PrismaClient({
      adapter: createDatabaseAdapter(
        databaseUrl ??
          (() => {
            throw new Error("DATABASE_URL is required for cost cards.");
          })()
      )
    });
  const permissions = createBusinessAuthorizationRepository({ prisma });
  async function scope(
    tx: Prisma.TransactionClient,
    auth: CostCardReadActor,
    selection: CostCardSelection
  ) {
    const snapshot = await permissions.loadAuthorizationSnapshot(auth.id, auth.orgId, tx);
    const category = snapshot.categories.find(
      (category) => category.key === "cost_cards" && category.kind === "fixed"
    );
    if (
      snapshot.mode !== "enabled" ||
      snapshot.disabled ||
      !category ||
      !isBusinessClearance(category.confidentialityLevel)
    )
      throw new CostCardPublicationError("COST_CARD_ACCESS_DENIED");
    const authorization = compileStructuredReadScope(snapshot, "cost_card", "cost_cards");
    const compiled = compileCostCardSelection(selection);
    return {
      snapshot,
      sql: `CAST(c.org_id AS BINARY) = CAST(? AS BINARY) AND c.archived_at IS NULL AND (${authorization.sql}) AND (${compiled.sql})`,
      params: [auth.orgId, ...authorization.params, ...compiled.params]
    };
  }
  return {
    readSnapshot(input) {
      if (!Number.isSafeInteger(input.maxCards) || input.maxCards < 1)
        throw new CostCardPublicationError("COST_CARD_LIMIT_INVALID");
      const selection = parseCostCardSelection(input.selection);
      return prisma.$transaction(
        async (tx) => {
          const authorized = await scope(tx, input.auth, selection);
          const ids = await tx.$queryRawUnsafe<Array<{ id: string }>>(
            `SELECT c.id FROM cost_cards c WHERE ${authorized.sql} ORDER BY c.id ASC LIMIT ?`,
            ...authorized.params,
            input.maxCards + 1
          );
          if (ids.length > input.maxCards)
            throw new CostCardPublicationError("COST_CARD_MANIFEST_TOO_LARGE");
          if (
            selection.costCardIds &&
            selection.costCardIds.some((id) => !ids.some((row) => row.id === id))
          )
            throw new CostCardPublicationError("COST_CARD_ACCESS_DENIED");
          const cards: CostCard[] = [];
          for (let offset = 0; offset < ids.length; offset += COST_CARD_CATALOG_BATCH_SIZE)
            cards.push(
              ...(await tx.costCard.findMany({
                where: {
                  orgId: input.auth.orgId,
                  id: {
                    in: ids
                      .slice(offset, offset + COST_CARD_CATALOG_BATCH_SIZE)
                      .map((row) => row.id)
                  },
                  archivedAt: null
                }
              }))
            );
          cards.sort((a, b) => a.id.localeCompare(b.id));
          return { authorizationVersion: authorized.snapshot.authorizationVersion, cards };
        },
        { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead }
      );
    },
    coverage(input) {
      return prisma.$transaction(
        async (tx) => {
          const authorized = await scope(
            tx,
            input.auth,
            input.enterpriseName === undefined ? {} : { enterpriseName: input.enterpriseName }
          );
          const rows = await tx.$queryRawUnsafe<
            Array<{
              sourceDocumentId: string;
              importBatchId: string;
              cardCount: bigint;
              totalItemRowCount: Prisma.Decimal;
            }>
          >(
            `SELECT c.source_document_id AS sourceDocumentId, c.import_batch_id AS importBatchId, COUNT(*) AS cardCount, SUM(c.item_row_count) AS totalItemRowCount FROM cost_cards c WHERE ${authorized.sql} GROUP BY c.source_document_id, c.import_batch_id ORDER BY c.source_document_id, c.import_batch_id`,
            ...authorized.params
          );
          const sources = rows.map((row) => ({
            ...row,
            cardCount: safeCostCardInteger(row.cardCount),
            totalItemRowCount: safeCostCardInteger(row.totalItemRowCount)
          }));
          return {
            dataset: "cost_cards",
            accessMode: "catalog_query",
            metadataPolicy: "none",
            sources,
            cardCount: safeCostCardInteger(
              sources.reduce((sum, source) => sum + source.cardCount, 0)
            ),
            totalItemRowCount: safeCostCardInteger(
              sources.reduce((sum, source) => sum + source.totalItemRowCount, 0)
            )
          };
        },
        { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead }
      );
    },
    archive: (input) =>
      prisma.$transaction(
        (tx) =>
          archiveCostCard(tx, {
            orgId: input.auth.orgId,
            actorId: input.auth.id,
            costCardId: input.costCardId
          }),
        { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted }
      ),
    async disconnect() {
      if (!client) await prisma.$disconnect();
    }
  };
}
