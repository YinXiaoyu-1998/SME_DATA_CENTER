import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  COST_CARD_CSV_SCHEMA_VERSION,
  loadPartitionDownloadLimits,
  parsePositiveSafeInteger,
  type CostCardManifest,
  type CostCardManifestEntry,
  type CostCardSelection,
  type LocalCostCardManifest
} from "@smedc/domain";
import { z } from "zod";
import {
  abortable,
  boundedInvocation,
  cleanupStaleExtractDirectories,
  DOWNLOAD_CONCURRENCY,
  downloadVerified,
  mapConcurrent,
  PartitionDownloadError,
  type PartitionTransferContext
} from "./partition-transfer.js";

const safeCount = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const text = z.string().min(1);
const entrySchema = z
  .object({
    costCardId: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/),
    revision: z.string().regex(/^[1-9][0-9]*$/),
    enterpriseName: text,
    sourceNamespace: z.literal("meituan"),
    spuId: text.max(64),
    skuId: text.max(64),
    dishName: text.max(512),
    specificationName: text.max(255).nullable(),
    schemaVersion: z.literal(COST_CARD_CSV_SCHEMA_VERSION),
    itemRowCount: safeCount,
    byteSize: safeCount,
    checksumSha256: z.string().regex(/^[a-f0-9]{64}$/),
    sourceDocumentId: text,
    importBatchId: text,
    presignedDownloadUrl: z.url()
  })
  .strict();
const manifestSchema = z
  .object({
    expiresAt: z.iso.datetime({ offset: true }),
    cardCount: safeCount,
    totalItemRowCount: safeCount,
    cards: z.array(entrySchema)
  })
  .strict();

type LocalEntry = LocalCostCardManifest["cards"][number] & { fileName: string };

export function downloadCostCards(input: {
  context: PartitionTransferContext;
  selection: CostCardSelection;
  fetchManifest: (
    context: PartitionTransferContext,
    selection: CostCardSelection
  ) => Promise<CostCardManifest>;
  limits?: { partitionImportMaxPartitions: number; partitionDownloadMaxBytes: number };
}) {
  const limits = input.limits ?? {
    partitionImportMaxPartitions: parsePositiveSafeInteger({}, "PARTITION_IMPORT_MAX_PARTITIONS", {
      defaultValue: 10_000
    }),
    partitionDownloadMaxBytes: loadPartitionDownloadLimits({}).partitionDownloadMaxBytes
  };
  return boundedInvocation(input.context, async (context) => {
    const root = path.join(os.tmpdir(), "smedc-cost-card-extracts");
    context.signal?.throwIfAborted();
    await cleanupStaleExtractDirectories(root);
    await mkdir(root, { recursive: true });
    const directory = await mkdtemp(path.join(root, "extract-"));
    try {
      // A replacement manifest always starts a complete new batch. Concurrent
      // siblings settle before cleanup, so none can recreate an old output file.
      let remote: CostCardManifest | undefined;
      let cards: LocalEntry[] | undefined;
      for (let attempt = 0; attempt < 2; attempt++) {
        remote = validateManifest(
          await abortable(input.fetchManifest(context, input.selection), context.signal!),
          input.selection,
          limits
        );
        try {
          cards = await mapConcurrent(
            context,
            remote.cards,
            DOWNLOAD_CONCURRENCY,
            async (entry, context) => {
              const fileName = `cost_card_${entry.costCardId}.csv`;
              await downloadVerified(
                context,
                entry.presignedDownloadUrl,
                path.join(directory, fileName),
                entry.byteSize,
                entry.checksumSha256
              );
              const { presignedDownloadUrl, ...safe } = entry;
              void presignedDownloadUrl;
              return { ...safe, fileName };
            }
          );
          break;
        } catch (error) {
          if (attempt !== 0 || !(error instanceof PartitionDownloadError) || error.status !== 403)
            throw error;
          context.signal?.throwIfAborted();
          await rm(directory, { recursive: true, force: true });
          await mkdir(directory);
        }
      }
      if (!remote || !cards) throw new Error("Cost card download did not complete.");
      context.signal?.throwIfAborted();
      const safe: LocalCostCardManifest & { cards: LocalEntry[] } = {
        expiresAt: remote.expiresAt,
        cardCount: remote.cardCount,
        totalItemRowCount: remote.totalItemRowCount,
        cards
      };
      await writeFile(path.join(directory, "manifest.json"), `${JSON.stringify(safe, null, 2)}\n`, {
        encoding: "utf8",
        signal: context.signal
      });
      context.signal?.throwIfAborted();
      return {
        localDirectory: directory,
        dataset: "cost_cards" as const,
        cardCount: remote.cardCount,
        totalItemRowCount: remote.totalItemRowCount,
        files: cards.map((entry) => entry.fileName)
      };
    } catch (error) {
      await rm(directory, { recursive: true, force: true });
      throw error;
    }
  });
}

function validateManifest(
  value: unknown,
  selection: CostCardSelection,
  limits: { partitionImportMaxPartitions: number; partitionDownloadMaxBytes: number }
): CostCardManifest {
  const parsed = manifestSchema.safeParse(value);
  const invalid = () => new Error("Invalid cost card manifest; retry the download.");
  if (!parsed.success) throw invalid();
  const manifest = parsed.data;
  if (
    manifest.cardCount !== manifest.cards.length ||
    manifest.cardCount > limits.partitionImportMaxPartitions ||
    Date.parse(manifest.expiresAt) <= Date.now()
  )
    throw invalid();
  const ids = new Set<string>();
  const fileIds = new Set<string>();
  const identities = new Set<string>();
  let rows = 0;
  let bytes = 0;
  for (const entry of manifest.cards) {
    const identity = JSON.stringify([
      entry.enterpriseName,
      entry.sourceNamespace,
      entry.spuId,
      entry.skuId
    ]);
    if (
      ids.has(entry.costCardId) ||
      fileIds.has(entry.costCardId.toLowerCase()) ||
      identities.has(identity) ||
      !matchesSelection(entry, selection)
    )
      throw invalid();
    ids.add(entry.costCardId);
    fileIds.add(entry.costCardId.toLowerCase());
    identities.add(identity);
    rows += entry.itemRowCount;
    bytes += entry.byteSize;
    if (
      !Number.isSafeInteger(rows) ||
      !Number.isSafeInteger(bytes) ||
      bytes > limits.partitionDownloadMaxBytes
    )
      throw invalid();
  }
  if (rows !== manifest.totalItemRowCount || selection.costCardIds?.some((id) => !ids.has(id)))
    throw invalid();
  return manifest;
}

function matchesSelection(entry: CostCardManifestEntry, selection: CostCardSelection): boolean {
  return (
    (selection.enterpriseName === undefined || selection.enterpriseName === entry.enterpriseName) &&
    (selection.costCardIds === undefined || selection.costCardIds.includes(entry.costCardId)) &&
    (selection.spuIds === undefined || selection.spuIds.includes(entry.spuId)) &&
    (selection.skuIds === undefined || selection.skuIds.includes(entry.skuId)) &&
    (selection.dishName === undefined || selection.dishName === entry.dishName) &&
    (selection.dishNameContains === undefined ||
      entry.dishName.includes(selection.dishNameContains)) &&
    (selection.specificationName === undefined ||
      selection.specificationName === entry.specificationName)
  );
}
