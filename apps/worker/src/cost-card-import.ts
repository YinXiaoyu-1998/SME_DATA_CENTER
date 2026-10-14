import { createReadStream } from "node:fs";
import { mkdir, mkdtemp, rm, statfs } from "node:fs/promises";
import path from "node:path";
import {
  canonicalizeCostCard,
  hashCostCard,
  COST_CARD_PUBLICATION_MAX_CHANGES,
  COST_CARD_PUBLICATION_MAX_SUMMARY_BYTES,
  PHASE3_RUNTIME_LIMIT_DEFAULTS,
  type CanonicalCostCard,
  type CostCardChange,
  type CostCardChangeField,
  type CostCardPublication
} from "@smedc/domain";
import {
  CostCardPublicationError,
  costCardIdentityKey,
  costCardOperation,
  createCostCardId,
  type CostCardRepository,
  type PreparedCostCardPublication
} from "@smedc/db";
import { createCostCardObjectKey, type StorageAdapter } from "@smedc/storage";
import {
  groupCostCardRows,
  exportCostCardCsv,
  readCostCardCsv,
  type CostCardCsvExport,
  type StructuredParseResult
} from "@smedc/structured-ingestion";
import { persistedSourceSheetSummary, type ClaimedProcessingRun } from "./worker.js";
import type { PartitionImportRuntimeLimits } from "./partition-import.js";

export interface CostCardPrepareInput {
  orgId: string;
  sourceDocumentId: string;
  importBatchId: string;
  runId: string;
  workerId: string;
  attemptNumber: number;
  exported: CostCardCsvExport;
  repository: CostCardRepository;
  storage: StorageAdapter;
  objectUploadConcurrency: number;
  summaryLimits?: { maxChanges: number; maxBytes: number };
  signal?: AbortSignal;
}
/** Lock-free preparation; catalog hashes classify every card before any old object is read. */
export async function prepareCostCardPublication(
  input: CostCardPrepareInput
): Promise<PreparedCostCardPublication> {
  const put = input.storage.putObjectAtKey?.bind(input.storage);
  if (!put) throw new CostCardPublicationError("COST_CARD_STORAGE_UNSUPPORTED");
  if (
    !Number.isSafeInteger(input.objectUploadConcurrency) ||
    input.objectUploadConcurrency < 1 ||
    input.objectUploadConcurrency > 8
  )
    throw new CostCardPublicationError("COST_CARD_CONCURRENCY_INVALID");
  const sorted = [...input.exported.cards].sort((a, b) => {
    const left = costCardIdentityKey(a.identity),
      right = costCardIdentityKey(b.identity);
    return left < right ? -1 : left > right ? 1 : 0;
  });
  const baselines = await input.repository.readBaselines(
    input.orgId,
    sorted.map((card) => card.identity)
  );
  const candidates = sorted.map((card) => {
    const baseline = baselines.get(costCardIdentityKey(card.identity)) ?? null;
    const operation = costCardOperation(baseline, card.contentHash, card.canonicalizationVersion);
    return {
      ...card,
      id: baseline?.id ?? createCostCardId(),
      baseline,
      objectKey:
        operation === "unchanged"
          ? null
          : createCostCardObjectKey({
              orgId: input.orgId,
              runId: input.runId,
              attemptNumber: input.attemptNumber,
              candidateId: createCostCardId()
            })
    };
  });
  const counts: CostCardPublication["counts"] = {
    inserted: 0,
    updated: 0,
    unchanged: 0,
    restored: 0
  };
  for (const card of candidates)
    counts[costCardOperation(card.baseline, card.contentHash, card.canonicalizationVersion)]++;
  const maxChanges = Math.min(
    input.summaryLimits?.maxChanges ?? COST_CARD_PUBLICATION_MAX_CHANGES,
    COST_CARD_PUBLICATION_MAX_CHANGES
  );
  const maxBytes = Math.min(
    input.summaryLimits?.maxBytes ?? COST_CARD_PUBLICATION_MAX_SUMMARY_BYTES,
    COST_CARD_PUBLICATION_MAX_SUMMARY_BYTES
  );
  if (
    !Number.isSafeInteger(maxChanges) ||
    maxChanges < 0 ||
    !Number.isSafeInteger(maxBytes) ||
    maxBytes < 1
  )
    throw new CostCardPublicationError("COST_CARD_SUMMARY_LIMIT_INVALID");
  const changes: CostCardChange[] = [];
  let changesTruncated = false;
  for (const card of candidates) {
    input.signal?.throwIfAborted();
    const operation = costCardOperation(
      card.baseline,
      card.contentHash,
      card.canonicalizationVersion
    );
    if (operation === "unchanged") continue;
    if (changes.length >= maxChanges) {
      changesTruncated = true;
      break;
    }
    let changedFields: CostCardChangeField[] =
      operation === "inserted" ? ["card.created"] : operation === "restored" ? ["archived_at"] : [];
    if (card.baseline && card.baseline.contentHash !== card.contentHash) {
      const [old, current] = await Promise.all([
        readCostCardCsv({
          stream: await input.storage.getObjectStream(card.baseline.objectKey),
          schemaVersion: card.baseline.csvSchemaVersion,
          identity: card.identity
        }),
        readCostCardCsv({
          stream: createReadStream(card.localFilePath),
          schemaVersion: card.schemaVersion,
          identity: card.identity
        })
      ]);
      if (hashCostCard(old) !== card.baseline.contentHash)
        throw new CostCardPublicationError("COST_CARD_OLD_OBJECT_INVALID");
      changedFields = [...changedFields, ...changedCostCardFields(old, current)];
    }
    const change: CostCardChange = {
      costCardId: card.id,
      identity: card.identity,
      operation,
      changedFields
    };
    const trial = {
      inputCardCount: candidates.length,
      inputItemRowCount: input.exported.inputItemRowCount,
      counts,
      changes: [...changes, change],
      changesTruncated: false
    };
    if (Buffer.byteLength(JSON.stringify(trial), "utf8") > maxBytes) {
      changesTruncated = true;
      break;
    }
    changes.push(change);
  }
  // Adopted objects are removed from this persistent exact-key queue by the publisher.
  // Failure paths leave them queued; no direct deletion can race a successful commit.
  let next = 0;
  let uploadError: unknown;
  await Promise.all(
    Array.from({ length: Math.min(input.objectUploadConcurrency, candidates.length) }, async () => {
      while (uploadError === undefined) {
        const card = candidates[next++];
        if (!card) return;
        if (!card.objectKey) continue;
        try {
          input.signal?.throwIfAborted();
          await input.repository.registerCandidate({
            objectKey: card.objectKey,
            processingRunId: input.runId
          });
          const written = await put({
            key: card.objectKey,
            body: createReadStream(card.localFilePath),
            contentLength: card.byteSize,
            checksumSha256: card.checksumSha256,
            contentType: "text/csv; charset=utf-8"
          });
          const verified = await input.storage.statObject(card.objectKey);
          if (
            written.key !== card.objectKey ||
            written.hash !== card.checksumSha256 ||
            written.size !== card.byteSize ||
            verified.hash !== card.checksumSha256 ||
            verified.size !== card.byteSize
          )
            throw new CostCardPublicationError("COST_CARD_OBJECT_VERIFICATION_FAILED", true);
        } catch (error) {
          uploadError = error;
        }
      }
    })
  );
  if (uploadError !== undefined) throw uploadError;
  return {
    candidates,
    inputItemRowCount: input.exported.inputItemRowCount,
    changes,
    changesTruncated
  };
}

export function changedCostCardFields(
  before: CanonicalCostCard,
  after: CanonicalCostCard
): CostCardChangeField[] {
  const a = JSON.parse(canonicalizeCostCard(before)) as CanonicalCostCard;
  const b = JSON.parse(canonicalizeCostCard(after)) as CanonicalCostCard;
  const fields: CostCardChangeField[] = [];
  for (const key of Object.keys(a.card) as Array<keyof CanonicalCostCard["card"]>)
    if (a.card[key] !== b.card[key]) fields.push(key);
  const key = (recipe: CanonicalCostCard["recipes"][number]) =>
    JSON.stringify([recipe.recipe_type, recipe.recipe_name]);
  const old = new Map(a.recipes.map((recipe) => [key(recipe), recipe]));
  const current = new Map(b.recipes.map((recipe) => [key(recipe), recipe]));
  if ([...current.keys()].some((name) => !old.has(name))) fields.push("recipes.added");
  if ([...old.keys()].some((name) => !current.has(name))) fields.push("recipes.removed");
  for (const [name, recipe] of current) {
    const previous = old.get(name);
    if (!previous) continue;
    const { items: oldItems, stores: oldStores, ...oldFields } = previous;
    const { items, stores, ...recipeFields } = recipe;
    if (JSON.stringify(oldFields) !== JSON.stringify(recipeFields)) fields.push("recipes.fields");
    if (JSON.stringify(oldItems) !== JSON.stringify(items)) fields.push("recipes.items");
    if (JSON.stringify(oldStores) !== JSON.stringify(stores)) fields.push("recipes.stores");
  }
  return [...new Set(fields)];
}

export function createCostCardImporter(input: {
  repository: CostCardRepository;
  limits: PartitionImportRuntimeLimits;
}) {
  return {
    sourceLimits: {
      maxBytes: Math.min(input.limits.maxSourceBytes, PHASE3_RUNTIME_LIMIT_DEFAULTS.maxUploadBytes),
      maxRows: Math.min(input.limits.maxRows, PHASE3_RUNTIME_LIMIT_DEFAULTS.maxStructuredImportRows)
    },
    disconnect: () => input.repository.disconnect?.(),
    async process({
      run,
      storage,
      result,
      signal,
      now = () => new Date()
    }: {
      run: ClaimedProcessingRun;
      storage: StorageAdapter;
      result: StructuredParseResult;
      signal?: AbortSignal;
      now?: () => Date;
    }) {
      const job = run.structuredImport;
      if (!job?.enterpriseKey || !job.enterpriseName || !run.document || !run.lockedBy)
        throw new CostCardPublicationError("COST_CARD_IMPORT_SCOPE_MISSING");
      const parsed = groupCostCardRows(result.rows, { enterpriseKey: job.enterpriseKey });
      if (parsed.validationErrorCount)
        return {
          outcome: "rejected" as const,
          result: {
            ...result,
            validationErrors: parsed.validationErrors,
            validationErrorCount: parsed.validationErrorCount,
            validationErrorsTruncated: parsed.validationErrorsTruncated
          }
        };
      await mkdir(input.limits.workDirectory, { recursive: true });
      const free = await statfs(input.limits.workDirectory);
      if (BigInt(free.bavail) * BigInt(free.bsize) < BigInt(input.limits.minFreeBytes))
        throw new CostCardPublicationError("COST_CARD_DISK_LIMIT_EXCEEDED", true);
      const workDirectory = await mkdtemp(path.join(input.limits.workDirectory, `cost-${run.id}-`));
      try {
        signal?.throwIfAborted();
        const exported = await exportCostCardCsv(parsed, {
          workDirectory,
          signal,
          limits: {
            maxPartitions: input.limits.maxPartitions,
            maxCanonicalBytes: input.limits.maxCanonicalBytes,
            maxOpenFiles: input.limits.maxOpenFiles
          }
        });
        const prepared = await prepareCostCardPublication({
          orgId: run.orgId,
          sourceDocumentId: run.documentId,
          importBatchId: job.importBatchId,
          runId: run.id,
          attemptNumber: run.attemptNumber,
          workerId: run.lockedBy,
          exported,
          repository: input.repository,
          storage,
          objectUploadConcurrency: input.limits.objectUploadConcurrency,
          signal
        });
        signal?.throwIfAborted();
        const publication = await input.repository.publish({
          ...prepared,
          orgId: run.orgId,
          enterpriseName: job.enterpriseName,
          sourceDocumentId: run.documentId,
          importBatchId: job.importBatchId,
          actorId: run.document.uploaderId,
          runId: run.id,
          workerId: run.lockedBy,
          attemptNumber: run.attemptNumber,
          now: now(),
          sourceSheetSummary: persistedSourceSheetSummary("cost_cards", result)
        });
        return { outcome: "published" as const, publication };
      } finally {
        await rm(workDirectory, { recursive: true, force: true });
      }
    }
  };
}
