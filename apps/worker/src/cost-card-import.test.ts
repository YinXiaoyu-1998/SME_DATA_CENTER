import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createReadStream } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { COST_CARD_UPLOAD_SCHEMA, costCardFromRows } from "@smedc/domain";
import { exportCostCardCsv } from "@smedc/structured-ingestion";
import { LocalFileSystemStorageAdapter } from "@smedc/storage";
import type { CostCardRepository } from "@smedc/db";
import { createCostCardImporter, prepareCostCardPublication } from "./cost-card-import.js";

describe("cost card object preparation", () => {
  let root: string;
  afterEach(async () => {
    if (root) await rm(root, { recursive: true, force: true });
  });
  async function fixture() {
    root = await mkdtemp(path.join(os.tmpdir(), "smedc-cost-card-prepare-"));
    const cards = ["A", "B", "C"].map((spuId) =>
      costCardFromRows(
        [
          Object.fromEntries(
            COST_CARD_UPLOAD_SCHEMA.map((field) => [
              field.canonicalName,
              (
                {
                  spu_id: spuId,
                  sku_id: "sku",
                  dish_name: "滩羊肉锅",
                  has_cost_card: "true",
                  source_dish_deleted: "false",
                  recipe_type: "标准配方",
                  recipe_name: "标准",
                  item_code: "item",
                  item_name: "羊肉",
                  cost_unit: "kg",
                  net_quantity: "1"
                } as Record<string, string>
              )[field.canonicalName] ?? null
            ])
          )
        ],
        { enterpriseKey: "synthetic", sourceNamespace: "meituan", spuId, skuId: "sku" }
      )
    );
    for (const card of cards)
      card.recipes[0]!.items[0]!.source = {
        sourceSheetIndex: 0,
        sourceSheetName: "Synthetic",
        sourceRowNumber: 2
      };
    const exported = await exportCostCardCsv(
      {
        cards,
        inputCardCount: 3,
        inputItemRowCount: 3,
        validationErrors: [],
        validationErrorCount: 0,
        validationErrorsTruncated: false
      },
      { workDirectory: root }
    );
    const storage = new LocalFileSystemStorageAdapter({ root: path.join(root, "storage") });
    return { exported, storage, cards };
  }
  it("does not fetch or upload unchanged CSV and bounds old-object reads before truncation", async () => {
    const { exported, storage } = await fixture();
    const fetch = vi.spyOn(storage, "getObjectStream");
    const put = vi.spyOn(storage, "putObjectAtKey");
    const registerCandidate = vi.fn();
    const baselines = exported.cards.map(
      (card, index) =>
        [
          JSON.stringify(["synthetic", "meituan", card.identity.spuId, "sku"]),
          {
            ...card.identity,
            id: `card${index}`,
            revision: 1n,
            contentHash: card.contentHash,
            objectKey: "old.csv",
            canonicalizationVersion: 1,
            csvSchemaVersion: 1,
            archivedAt: index === 2 ? new Date() : null
          }
        ] as const
    );
    const repository = {
      readBaselines: async () => new Map(baselines),
      registerCandidate
    } as unknown as CostCardRepository;
    const prepared = await prepareCostCardPublication({
      orgId: "org",
      sourceDocumentId: "doc",
      importBatchId: "batch",
      runId: "run",
      attemptNumber: 1,
      workerId: "worker",
      exported,
      repository,
      storage,
      objectUploadConcurrency: 2,
      summaryLimits: { maxChanges: 1, maxBytes: 32768 }
    });
    expect(fetch).not.toHaveBeenCalled();
    expect(put).toHaveBeenCalledTimes(1);
    expect(registerCandidate).toHaveBeenCalledTimes(1);
    expect(prepared.candidates.filter((card) => card.objectKey === null)).toHaveLength(2);
    expect(prepared.changes).toMatchObject([
      { operation: "restored", changedFields: ["archived_at"] }
    ]);
    expect(prepared.changesTruncated).toBe(false);
  });

  it.each([
    { maxChanges: 1, maxBytes: 32768 },
    { maxChanges: 100, maxBytes: 300 }
  ])(
    "bounds updated-card reads with summary budget %j without dropping candidates",
    async (summaryLimits) => {
      const { exported, storage, cards } = await fixture();
      const oldCards = structuredClone(cards);
      for (const card of oldCards) card.recipes[0]!.items[0]!.net_quantity = "0";
      const old = await exportCostCardCsv(
        {
          cards: oldCards,
          inputCardCount: 3,
          inputItemRowCount: 3,
          validationErrors: [],
          validationErrorCount: 0,
          validationErrorsTruncated: false
        },
        { workDirectory: root }
      );
      const baselines = new Map();
      for (const [index, card] of old.cards.entries()) {
        const objectKey = `old/${index}.csv`;
        await storage.putObjectAtKey({
          key: objectKey,
          body: createReadStream(card.localFilePath),
          contentLength: card.byteSize,
          checksumSha256: card.checksumSha256
        });
        baselines.set(JSON.stringify(["synthetic", "meituan", card.identity.spuId, "sku"]), {
          id: `card${index}`,
          revision: 1n,
          contentHash: card.contentHash,
          objectKey,
          canonicalizationVersion: 1,
          csvSchemaVersion: 1,
          archivedAt: null
        });
      }
      const fetch = vi.spyOn(storage, "getObjectStream");
      const put = vi.spyOn(storage, "putObjectAtKey");
      const repository: CostCardRepository = {
        readBaselines: async () => baselines,
        registerCandidate: vi.fn(),
        publish: vi.fn()
      };
      const prepared = await prepareCostCardPublication({
        orgId: "org",
        sourceDocumentId: "doc",
        importBatchId: "batch",
        runId: "run",
        attemptNumber: 1,
        workerId: "worker",
        exported,
        repository,
        storage,
        objectUploadConcurrency: 2,
        summaryLimits
      });
      expect(fetch).toHaveBeenCalledTimes(1);
      expect(put).toHaveBeenCalledTimes(3);
      expect(prepared.candidates).toHaveLength(3);
      expect(prepared.changesTruncated).toBe(true);
      if (summaryLimits.maxChanges === 1)
        expect(prepared.changes).toMatchObject([
          { operation: "updated", changedFields: ["recipes.items"] }
        ]);
      else expect(prepared.changes).toEqual([]);
    }
  );

  it("rejects failed object verification and unsupported baseline versions before publication", async () => {
    const { exported, storage } = await fixture();
    const repository: CostCardRepository = {
      readBaselines: async () => new Map(),
      registerCandidate: vi.fn(),
      publish: vi.fn()
    };
    vi.spyOn(storage, "statObject").mockResolvedValue({ key: "wrong", hash: "wrong", size: 1 });
    await expect(
      prepareCostCardPublication({
        orgId: "org",
        sourceDocumentId: "doc",
        importBatchId: "batch",
        runId: "run",
        attemptNumber: 1,
        workerId: "worker",
        exported,
        repository,
        storage,
        objectUploadConcurrency: 1
      })
    ).rejects.toThrow("COST_CARD_OBJECT_VERIFICATION_FAILED");
    expect(repository.publish).not.toHaveBeenCalled();
    expect(repository.registerCandidate).toHaveBeenCalledTimes(1);
    repository.readBaselines = async () =>
      new Map([
        [
          JSON.stringify(["synthetic", "meituan", "A", "sku"]),
          {
            id: "A",
            revision: 1n,
            contentHash: exported.cards[0]!.contentHash,
            objectKey: "old",
            canonicalizationVersion: 2,
            csvSchemaVersion: 1,
            archivedAt: null
          }
        ]
      ]);
    await expect(
      prepareCostCardPublication({
        orgId: "org",
        sourceDocumentId: "doc",
        importBatchId: "batch",
        runId: "run",
        attemptNumber: 1,
        workerId: "worker",
        exported,
        repository,
        storage,
        objectUploadConcurrency: 1
      })
    ).rejects.toThrow("COST_CARD_VERSION_UNSUPPORTED");
    expect(repository.registerCandidate).toHaveBeenCalledTimes(1);
  });

  it.each(["cards", "bytes"])(
    "rejects the complete import at a lowered %s limit before uploading objects",
    async (limit) => {
      const { storage, cards } = await fixture();
      const repository: CostCardRepository = {
        readBaselines: vi.fn(),
        registerCandidate: vi.fn(),
        publish: vi.fn()
      };
      const importer = createCostCardImporter({
        repository,
        limits: {
          workDirectory: root,
          minFreeBytes: 1,
          jobRetentionDays: 1,
          maxSourceBytes: 50 * 1024 * 1024,
          maxRows: 100000,
          maxPartitions: limit === "cards" ? 1 : 100,
          maxCanonicalBytes: limit === "bytes" ? 1 : 100000,
          maxOpenFiles: 2,
          objectUploadConcurrency: 1,
          maxStructuredCellChars: 32767,
          maxXlsxSheets: 10,
          maxXlsxUncompressedBytes: 1000000,
          maxXlsxZipEntries: 1000,
          maxXlsxCompressionRatio: 100
        }
      });
      const run = {
        id: "run",
        orgId: "org",
        documentId: "doc",
        retryCount: 0,
        attemptNumber: 1,
        jobType: "structured_import",
        lockedBy: "worker",
        lockedUntil: new Date(),
        structuredImport: {
          importBatchId: "batch",
          dataset: "cost_cards" as const,
          enterpriseKey: "synthetic",
          enterpriseName: "Synthetic"
        },
        document: {
          id: "doc",
          orgId: "org",
          uploaderId: "admin",
          status: "processing",
          storageObjectKey: "source",
          originalFileName: "source.csv",
          confidentialityLevel: 0
        }
      };
      const rows = cards.map((card) => ({
        sourceSheetIndex: 0,
        sourceSheetName: "Synthetic",
        sourceRowNumber: 2,
        payload: { ...card.card, ...card.recipes[0], ...card.recipes[0]!.items[0] }
      }));
      await expect(
        importer.process({
          run,
          storage,
          result: {
            rows,
            sheetSummary: [],
            ignoredSheets: [],
            validationErrors: [],
            validationErrorCount: 0,
            validationErrorsTruncated: false
          }
        })
      ).rejects.toThrow(/limit exceeded/);
      expect(repository.registerCandidate).not.toHaveBeenCalled();
      expect(repository.publish).not.toHaveBeenCalled();
    }
  );
});
