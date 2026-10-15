import {
  COST_CARD_CSV_SCHEMA_VERSION,
  COST_CARD_MANIFEST_MAX_TTL_SECONDS,
  parseCostCardSelection,
  type CostCardManifest,
  type CostCardManifestEntry,
  type CostCardSelection
} from "@smedc/domain";
import {
  CostCardPublicationError,
  safeCostCardInteger,
  type CostCardDirectoryRepository,
  type CostCardReadActor,
  type CostCardDirectorySnapshot
} from "@smedc/db";
import type { StorageAdapter } from "@smedc/storage";

function fixedCards(snapshot: CostCardDirectorySnapshot) {
  return snapshot.cards.map((card) => {
    if (
      card.sourceNamespace !== "meituan" ||
      card.csvSchemaVersion !== COST_CARD_CSV_SCHEMA_VERSION
    )
      throw new CostCardPublicationError("COST_CARD_SCHEMA_UNSUPPORTED");
    const fields: Omit<CostCardManifestEntry, "presignedDownloadUrl"> = {
      costCardId: card.id,
      revision: card.revision.toString(),
      enterpriseName: card.enterpriseName,
      sourceNamespace: "meituan",
      spuId: card.spuId,
      skuId: card.skuId,
      dishName: card.dishName,
      specificationName: card.specificationName,
      schemaVersion: card.csvSchemaVersion,
      itemRowCount: safeCostCardInteger(card.itemRowCount),
      byteSize: safeCostCardInteger(card.byteSize),
      checksumSha256: card.checksumSha256,
      sourceDocumentId: card.sourceDocumentId,
      importBatchId: card.importBatchId
    };
    return { fields, objectKey: card.objectKey };
  });
}
/** Presigning is outside DB transactions. A new snapshot must still authorize the complete selection. */
export function createCostCardService(input: {
  repository: CostCardDirectoryRepository;
  storage: StorageAdapter;
  maxCards: number;
  urlTtlSeconds: number;
  now?: () => Date;
}) {
  const now = input.now ?? (() => new Date());
  const ttl = Math.min(input.urlTtlSeconds, COST_CARD_MANIFEST_MAX_TTL_SECONDS);
  if (
    !Number.isSafeInteger(ttl) ||
    ttl < 1 ||
    !Number.isSafeInteger(input.maxCards) ||
    input.maxCards < 1
  )
    throw new CostCardPublicationError("COST_CARD_LIMIT_INVALID");
  return {
    async createCostCardManifest({
      auth,
      selection: raw
    }: {
      auth: CostCardReadActor;
      selection: CostCardSelection;
    }): Promise<CostCardManifest> {
      const selection = parseCostCardSelection(raw);
      const snapshot = await input.repository.readSnapshot({
        auth,
        selection,
        maxCards: input.maxCards
      });
      const fixed = fixedCards(snapshot);
      if (fixed.length > input.maxCards)
        throw new CostCardPublicationError("COST_CARD_MANIFEST_TOO_LARGE");
      let expiresAt = Math.floor(now().getTime() / 1000) * 1000 + ttl * 1000;
      const cards: CostCardManifestEntry[] = [];
      for (const card of fixed) {
        const started = Math.floor(now().getTime() / 1000) * 1000;
        const url = await input.storage.createDownloadUrl(card.objectKey, {
          expiresInSeconds: ttl,
          downloadFileName: `${card.fields.costCardId}.csv`
        });
        expiresAt = Math.min(
          expiresAt,
          started + ttl * 1000,
          actualDownloadExpiry(url) ?? Number.POSITIVE_INFINITY
        );
        cards.push({ ...card.fields, presignedDownloadUrl: url });
      }
      let current: CostCardDirectorySnapshot;
      try {
        current = await input.repository.readSnapshot({
          auth,
          selection,
          maxCards: input.maxCards
        });
      } catch (error) {
        if (
          error instanceof CostCardPublicationError &&
          ["COST_CARD_ACCESS_DENIED", "COST_CARD_MANIFEST_TOO_LARGE"].includes(error.code)
        )
          throw new CostCardPublicationError("COST_CARD_CHANGED", true);
        throw error;
      }
      if (
        current.authorizationVersion !== snapshot.authorizationVersion ||
        JSON.stringify(fixedCards(current)) !== JSON.stringify(fixed) ||
        now().getTime() >= expiresAt
      )
        throw new CostCardPublicationError("COST_CARD_CHANGED", true);
      return {
        expiresAt: new Date(expiresAt).toISOString(),
        cardCount: cards.length,
        totalItemRowCount: safeCostCardInteger(
          cards.reduce((sum, card) => sum + card.itemRowCount, 0)
        ),
        cards
      };
    },
    archive: (request: { auth: CostCardReadActor; costCardId: string }) =>
      input.repository.archive(request),
    coverage: (request: { auth: CostCardReadActor; enterpriseName?: string }) =>
      input.repository.coverage(request),
    disconnect: () => input.repository.disconnect?.()
  };
}
export type CostCardService = ReturnType<typeof createCostCardService>;

/** AWS-compatible OSS signatures expose their actual signing instant, including cached/stale URLs. */
function actualDownloadExpiry(value: string): number | undefined {
  const url = new URL(value);
  const absolute = url.searchParams.get("Expires");
  if (absolute && /^\d+$/.test(absolute)) return Number(absolute) * 1000;
  const date = url.searchParams.get("X-Amz-Date"),
    seconds = url.searchParams.get("X-Amz-Expires");
  if (date && /^\d{8}T\d{6}Z$/.test(date) && seconds && /^\d+$/.test(seconds)) {
    const instant = Date.parse(
      `${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6, 8)}T${date.slice(9, 11)}:${date.slice(11, 13)}:${date.slice(13, 15)}Z`
    );
    const expiry = instant + Number(seconds) * 1000;
    if (!Number.isFinite(expiry)) throw new CostCardPublicationError("COST_CARD_CHANGED", true);
    return expiry;
  }
  return undefined;
}
