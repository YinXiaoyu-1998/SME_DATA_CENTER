import { createHash } from "node:crypto";
import { readFile, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { CostCardManifest, CostCardManifestEntry } from "@smedc/domain";
import { afterEach, describe, expect, it } from "vitest";
import { downloadCostCards } from "./cost-card-transfer.js";
import type { PartitionTransferContext } from "./partition-transfer.js";

const root = path.join(os.tmpdir(), "smedc-cost-card-extracts");
const created: string[] = [];
afterEach(async () => {
  await Promise.all(
    created.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))
  );
});

function card(
  id: string,
  body = "synthetic csv",
  overrides: Partial<CostCardManifestEntry> = {}
): CostCardManifestEntry {
  return {
    costCardId: id,
    revision: "9007199254740993",
    enterpriseName: "Synthetic",
    sourceNamespace: "meituan",
    spuId: `spu-${id}`,
    skuId: "shared-sku",
    dishName: "同名菜",
    specificationName: null,
    schemaVersion: 1,
    itemRowCount: 1,
    byteSize: Buffer.byteLength(body),
    checksumSha256: createHash("sha256").update(body).digest("hex"),
    sourceDocumentId: `doc-${id}`,
    importBatchId: `batch-${id}`,
    presignedDownloadUrl: `https://storage.example/${id}`,
    ...overrides
  };
}
function manifest(cards: CostCardManifestEntry[]): CostCardManifest {
  return {
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    cardCount: cards.length,
    totalItemRowCount: cards.reduce((sum, entry) => sum + entry.itemRowCount, 0),
    cards
  };
}
function context(
  fetchImplementation: typeof fetch,
  signal?: AbortSignal
): PartitionTransferContext {
  return {
    serviceUrl: "https://service.example",
    accessToken: "internal",
    launcherVersion: "0.9.0",
    fetchImplementation,
    signal
  };
}
async function directories(): Promise<string[]> {
  return readdir(root).catch(() => []);
}

describe("cost card local transfer", () => {
  it("delivers same-name cards as distinct ID files and preserves safe per-card provenance", async () => {
    const first = card("a", "first");
    const second = card("b", "second", {
      specificationName: "大份",
      sourceDocumentId: "other-doc",
      importBatchId: "other-batch"
    });
    const remote = manifest([first, second]);
    const result = await downloadCostCards({
      context: context(
        async (url) => new Response(String(url).endsWith("/a") ? "first" : "second")
      ),
      selection: { enterpriseName: "Synthetic", costCardIds: ["a", "b"] },
      fetchManifest: async () => remote
    });
    created.push(result.localDirectory);
    expect(result).toMatchObject({
      dataset: "cost_cards",
      cardCount: 2,
      totalItemRowCount: 2,
      files: ["cost_card_a.csv", "cost_card_b.csv"]
    });
    await expect(
      readFile(path.join(result.localDirectory, "cost_card_a.csv"), "utf8")
    ).resolves.toBe("first");
    await expect(
      readFile(path.join(result.localDirectory, "cost_card_b.csv"), "utf8")
    ).resolves.toBe("second");
    const safe = JSON.parse(
      await readFile(path.join(result.localDirectory, "manifest.json"), "utf8")
    );
    expect(safe).toEqual({
      expiresAt: remote.expiresAt,
      cardCount: 2,
      totalItemRowCount: 2,
      cards: [
        {
          costCardId: "a",
          revision: "9007199254740993",
          enterpriseName: "Synthetic",
          sourceNamespace: "meituan",
          spuId: "spu-a",
          skuId: "shared-sku",
          dishName: "同名菜",
          specificationName: null,
          schemaVersion: 1,
          itemRowCount: 1,
          byteSize: 5,
          checksumSha256: first.checksumSha256,
          sourceDocumentId: "doc-a",
          importBatchId: "batch-a",
          fileName: "cost_card_a.csv"
        },
        {
          costCardId: "b",
          revision: "9007199254740993",
          enterpriseName: "Synthetic",
          sourceNamespace: "meituan",
          spuId: "spu-b",
          skuId: "shared-sku",
          dishName: "同名菜",
          specificationName: "大份",
          schemaVersion: 1,
          itemRowCount: 1,
          byteSize: 6,
          checksumSha256: second.checksumSha256,
          sourceDocumentId: "other-doc",
          importBatchId: "other-batch",
          fileName: "cost_card_b.csv"
        }
      ]
    });
    expect(JSON.stringify({ result, safe })).not.toContain("storage.example");
    expect(JSON.stringify({ result, safe })).not.toContain("presignedDownloadUrl");
  });

  it("returns a local empty manifest without downloading any files", async () => {
    const result = await downloadCostCards({
      context: context(async () => {
        throw new Error("No download expected");
      }),
      selection: {},
      fetchManifest: async () => manifest([])
    });
    created.push(result.localDirectory);
    expect(result).toMatchObject({ cardCount: 0, totalItemRowCount: 0, files: [] });
    expect(await readdir(result.localDirectory)).toEqual(["manifest.json"]);
  });

  it("cleans the entire first batch and re-downloads every card from the refreshed manifest", async () => {
    let requested = 0;
    let completedFirst = false;
    const before = await directories();
    const result = await downloadCostCards({
      context: context(async (url) => {
        const target = String(url);
        if (target.endsWith("/a"))
          return new Response(
            new ReadableStream({
              start(controller) {
                controller.enqueue(Buffer.from("old-a"));
                controller.close();
                completedFirst = true;
              }
            })
          );
        if (target.endsWith("/b")) {
          while (!completedFirst) await new Promise<void>((resolve) => setImmediate(resolve));
          // Wait until A's verified output exists before invalidating B's URL.
          for (;;) {
            const current = (await directories()).filter((entry) => !before.includes(entry));
            if (
              current.length &&
              (await readFile(path.join(root, current[0]!, "cost_card_a.csv"), "utf8").catch(
                () => ""
              )) === "old-a"
            )
              break;
            await new Promise<void>((resolve) => setImmediate(resolve));
          }
          return new Response(null, { status: 403 });
        }
        return new Response(target.endsWith("/new-a") ? "new-a" : "new-b");
      }),
      selection: { enterpriseName: "Synthetic" },
      fetchManifest: async () => {
        requested++;
        if (requested === 1) return manifest([card("a", "old-a"), card("b", "old-b")]);
        const current = (await directories()).filter((entry) => !before.includes(entry));
        expect(current).toHaveLength(1);
        expect(await readdir(path.join(root, current[0]!))).toEqual([]);
        return manifest([
          card("new-a", "new-a", {
            revision: "2",
            spuId: "updated-a",
            sourceDocumentId: "new-doc-a",
            importBatchId: "new-batch-a"
          }),
          card("new-b", "new-b", {
            revision: "3",
            spuId: "updated-b",
            sourceDocumentId: "new-doc-b",
            importBatchId: "new-batch-b"
          })
        ]);
      }
    });
    created.push(result.localDirectory);
    expect(requested).toBe(2);
    expect(await readdir(result.localDirectory)).toEqual([
      "cost_card_new-a.csv",
      "cost_card_new-b.csv",
      "manifest.json"
    ]);
    const safe = JSON.parse(
      await readFile(path.join(result.localDirectory, "manifest.json"), "utf8")
    );
    expect(safe.cards).toMatchObject([
      {
        costCardId: "new-a",
        revision: "2",
        spuId: "updated-a",
        sourceDocumentId: "new-doc-a",
        importBatchId: "new-batch-a"
      },
      {
        costCardId: "new-b",
        revision: "3",
        spuId: "updated-b",
        sourceDocumentId: "new-doc-b",
        importBatchId: "new-batch-b"
      }
    ]);
    await expect(
      readFile(path.join(result.localDirectory, "cost_card_new-a.csv"), "utf8")
    ).resolves.toBe("new-a");
  });

  it.each(["checksum", "refresh-denied", "second-expiration", "cancel"])(
    "removes all output on %s",
    async (kind) => {
      const before = await directories();
      let requests = 0;
      const controller = new AbortController();
      const result = downloadCostCards({
        context: context(async () => {
          if (kind === "cancel") {
            controller.abort(new Error("cancelled"));
            return new Response("synthetic csv");
          }
          return kind === "checksum"
            ? new Response("corrupt bytes")
            : new Response(null, { status: 403 });
        }, controller.signal),
        selection: {},
        fetchManifest: async () => {
          requests++;
          if (kind === "refresh-denied" && requests === 2) throw new Error("Permission denied");
          return manifest([card("a")]);
        }
      });
      await expect(result).rejects.toThrow(
        kind === "checksum"
          ? "checksum"
          : kind === "cancel"
            ? "cancelled"
            : kind === "refresh-denied"
              ? "Permission denied"
              : "403"
      );
      expect(requests).toBe(kind === "checksum" || kind === "cancel" ? 1 : 2);
      expect((await directories()).filter((entry) => !before.includes(entry))).toEqual([]);
    }
  );

  it.each([
    [
      "count",
      (m: CostCardManifest) => {
        m.cardCount++;
      }
    ],
    [
      "rows",
      (m: CostCardManifest) => {
        m.totalItemRowCount++;
      }
    ],
    [
      "unsafe ID",
      (m: CostCardManifest) => {
        m.cards[0]!.costCardId = "../../outside";
      }
    ],
    [
      "schema",
      (m: CostCardManifest) => {
        m.cards[0]!.schemaVersion = 2;
      }
    ],
    [
      "checksum",
      (m: CostCardManifest) => {
        m.cards[0]!.checksumSha256 = "invalid";
      }
    ],
    [
      "namespace",
      (m: CostCardManifest) => {
        Object.assign(m.cards[0]!, { sourceNamespace: "other" });
      }
    ],
    [
      "revision",
      (m: CostCardManifest) => {
        m.cards[0]!.revision = "1e2";
      }
    ],
    [
      "expired",
      (m: CostCardManifest) => {
        m.expiresAt = "2000-01-01T00:00:00.000Z";
      }
    ],
    [
      "scope",
      (m: CostCardManifest) => {
        m.cards[0]!.enterpriseName = "Other";
      }
    ],
    [
      "duplicate ID",
      (m: CostCardManifest) => {
        m.cards.push({ ...m.cards[0]!, spuId: "other" });
        m.cardCount++;
        m.totalItemRowCount++;
      }
    ],
    [
      "case-insensitive filename collision",
      (m: CostCardManifest) => {
        m.cards.push({ ...m.cards[0]!, costCardId: "A", spuId: "other" });
        m.cardCount++;
        m.totalItemRowCount++;
      }
    ],
    [
      "duplicate identity",
      (m: CostCardManifest) => {
        m.cards.push({ ...m.cards[0]!, costCardId: "b" });
        m.cardCount++;
        m.totalItemRowCount++;
      }
    ],
    ["missing explicit ID", () => {}]
  ])("rejects invalid manifest %s before bytes are downloaded", async (kind, mutate) => {
    const before = await directories();
    const remote = manifest([card("a")]);
    mutate(remote);
    await expect(
      downloadCostCards({
        context: context(async () => {
          throw new Error("Unexpected download");
        }),
        selection: {
          enterpriseName: "Synthetic",
          ...(kind === "missing explicit ID" ? { costCardIds: ["a", "b"] } : {})
        },
        fetchManifest: async () => remote
      })
    ).rejects.toThrow("Invalid cost card manifest");
    expect((await directories()).filter((entry) => !before.includes(entry))).toEqual([]);
  });

  it.each(["cards", "bytes"])(
    "rejects the whole manifest over the injected %s limit",
    async (kind) => {
      const before = await directories();
      await expect(
        downloadCostCards({
          context: context(async () => {
            throw new Error("Unexpected download");
          }),
          selection: {},
          fetchManifest: async () => manifest([card("a", "abc"), card("b", "abc")]),
          limits: {
            partitionImportMaxPartitions: kind === "cards" ? 1 : 2,
            partitionDownloadMaxBytes: kind === "bytes" ? 5 : 6
          }
        })
      ).rejects.toThrow("Invalid cost card manifest");
      expect((await directories()).filter((entry) => !before.includes(entry))).toEqual([]);
    }
  );

  it("cancels an active sibling and removes partial output on checksum failure", async () => {
    const before = await directories();
    let canceled = false;
    let siblingSignal: AbortSignal | null | undefined;
    await expect(
      downloadCostCards({
        context: context(async (url, init) => {
          if (String(url).endsWith("/a")) return new Response("bad");
          siblingSignal = init?.signal;
          return new Response(
            new ReadableStream({
              start(controller) {
                controller.enqueue(Buffer.from("partial"));
              },
              cancel() {
                canceled = true;
              }
            })
          );
        }),
        selection: {},
        fetchManifest: async () => manifest([card("a", "abc"), card("b", "partial and more")])
      })
    ).rejects.toThrow("checksum");
    expect(canceled).toBe(true);
    expect(siblingSignal?.aborted).toBe(true);
    expect((await directories()).filter((entry) => !before.includes(entry))).toEqual([]);
  });
});
