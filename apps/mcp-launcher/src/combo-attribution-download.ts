import { createReadStream, createWriteStream } from "node:fs";
import { readFile, rename, rm } from "node:fs/promises";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { parse } from "csv-parse";
import { z } from "zod";
import { normalizeEnterpriseIdentity } from "@smedc/domain";
import { ComboAttribution, type CatalogItem } from "./combo-attribution.js";
import {
  apiJson,
  downloadPartitionDataset,
  type PartitionTransferContext
} from "./partition-transfer.js";

type Extract = Awaited<ReturnType<typeof downloadPartitionDataset>>;
export interface EvidenceRange {
  evidenceStartDate: string;
  evidenceEndDate: string;
}

const catalogRow = z.object({
  enterprise_key: z.string(),
  sku_id: z.string(),
  spu_id: z.string(),
  dish_name: z.string(),
  specification_name: z.string().nullable(),
  department_id: z.string().nullable(),
  department_name: z.string().nullable(),
  dish_type: z.enum(["single", "combo"]).nullable(),
  combo_composition: z.string().nullable()
});
const composition = z.object({
  groups: z.array(z.object({ items: z.array(z.object({ skuId: z.string() })) }))
});
const catalogPage = z.object({ rows: z.array(catalogRow), nextCursor: z.string().nullable() });
const mappingRow = z.object({
  id: z.string(),
  sourceName: z.string(),
  specification: z.string().nullable(),
  target: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("sku"), skuId: z.string() }),
    z.object({ kind: z.literal("department"), departmentId: z.string() })
  ]),
  basis: z.string(),
  valid: z.boolean(),
  departmentId: z.string().nullable(),
  departmentName: z.string().nullable()
});
const mappingPage = z.object({ rows: z.array(mappingRow), nextAfterId: z.string().nullable() });

async function readCatalog(context: PartitionTransferContext, enterpriseName: string) {
  const { enterpriseKey } = normalizeEnterpriseIdentity(enterpriseName);
  const items: CatalogItem[] = [];
  const seen = new Set<string>();
  let cursor: string | null = null;
  do {
    const result = catalogPage.parse(
      await apiJson(context, "/v1/structured/query", {
        method: "POST",
        body: {
          dataset: "dish_catalog",
          filter: { field: "enterprise_key", op: "eq", value: enterpriseKey },
          select: Object.keys(catalogRow.shape),
          page: { limit: 200, ...(cursor ? { cursor } : {}) }
        }
      })
    );
    for (const row of result.rows) {
      if (row.enterprise_key !== enterpriseKey || seen.has(row.sku_id))
        throw new Error("Catalog selection changed. Retry the download.");
      seen.add(row.sku_id);
      const groups = row.combo_composition
        ? composition.parse(JSON.parse(row.combo_composition)).groups
        : [];
      items.push({
        sku: row.sku_id,
        spu: row.spu_id,
        name: row.dish_name,
        spec: row.specification_name,
        departmentId: row.department_id,
        departmentName: row.department_name,
        isCombo: row.dish_type === null ? null : row.dish_type === "combo",
        children: groups.flatMap((g) => g.items.map((i) => i.skuId))
      });
    }
    cursor = result.nextCursor;
    if (cursor && !result.rows.length) throw new Error("Incomplete catalog page.");
  } while (cursor);
  return items;
}

async function loadMappings(
  reader: ComboAttribution,
  context: PartitionTransferContext,
  enterpriseName: string,
  storeName: string
) {
  let afterId: string | null = null;
  do {
    const result = mappingPage.parse(
      await apiJson(context, "/v1/combo-sale-mappings/query", {
        method: "POST",
        body: {
          enterpriseName,
          storeName,
          limit: 200,
          ...(afterId ? { afterId } : {})
        }
      })
    );
    for (const mapping of result.rows) reader.addMapping(storeName, mapping);
    if (result.nextAfterId && (!result.rows.length || result.nextAfterId === afterId))
      throw new Error("Incomplete store mapping page.");
    afterId = result.nextAfterId;
  } while (afterId);
}

// All paths originate in the verified range downloader in this invocation.
const localManifest = z.object({
  files: z.array(
    z.object({ storeName: z.string(), businessDate: z.string(), fileName: z.string() })
  )
});
async function files(extract: Extract) {
  const data = localManifest.parse(
    JSON.parse(await readFile(path.join(extract.localDirectory, "manifest.json"), "utf8"))
  );
  const allowed = new Set(extract.files);
  if (
    data.files.length !== allowed.size ||
    data.files.some((f) => !allowed.delete(f.fileName) || path.basename(f.fileName) !== f.fileName)
  )
    throw new Error("Invalid local partition selection.");
  return data.files;
}
async function* csvRows(
  file: string,
  signal?: AbortSignal
): AsyncGenerator<Record<string, string>> {
  const stream = createReadStream(file, { signal });
  const parser = parse({ columns: true, bom: true });
  const transfer = pipeline(stream, parser, { signal });
  // Propagate disk and parse errors through the iterator without an unhandled rejection.
  void transfer.catch(() => {});
  try {
    for await (const row of parser) yield row;
  } finally {
    parser.destroy();
    stream.destroy();
    await transfer;
  }
}

export async function attributeComboExtract(
  context: PartitionTransferContext,
  raw: Extract,
  range: EvidenceRange
) {
  const sales = await files(raw);
  const stores = [...new Set(sales.map((f) => f.storeName))];
  const reader = new ComboAttribution(
    stores.length ? await readCatalog(context, raw.enterpriseName) : []
  );
  let evidenceRows = 0;
  for (let offset = 0; offset < stores.length; offset += 20) {
    const batch = stores.slice(offset, offset + 20);
    for (const store of batch) await loadMappings(reader, context, raw.enterpriseName, store);
    const evidence = await downloadPartitionDataset({
      context,
      dataset: "dishes",
      enterpriseName: raw.enterpriseName,
      startDate: range.evidenceStartDate,
      endDate: range.evidenceEndDate,
      storeNameContains: batch
    });
    try {
      for (const f of await files(evidence)) {
        if (!batch.includes(f.storeName)) continue;
        for await (const row of csvRows(
          path.join(evidence.localDirectory, f.fileName),
          context.signal
        )) {
          if (row["门店"] !== f.storeName) throw new Error("Name evidence store mismatch.");
          reader.addEvidence(
            f.storeName,
            row["菜品名称"]!,
            row["关联菜品名称"]!,
            row["菜品销售方式名称"]!
          );
          evidenceRows++;
        }
      }
    } finally {
      await rm(evidence.localDirectory, { recursive: true, force: true });
    }
  }
  async function* records() {
    for (const f of sales) {
      for await (const row of csvRows(path.join(raw.localDirectory, f.fileName), context.signal)) {
        if (row["门店"] !== f.storeName || row["营业日期"] !== f.businessDate)
          throw new Error("Combo sale scope mismatch.");
        const attribution = reader.resolve({
          store: f.storeName,
          parentName: row["套餐"]!,
          parentCode: row["菜品编码"]!,
          name: row["单品名称"]!,
          spec: row["规格"] ?? null
        });
        yield JSON.stringify({ source: row, attribution }) + "\n";
      }
    }
  }
  const file = path.join(raw.localDirectory, "combo-attribution.jsonl");
  const partial = file + ".partial";
  try {
    await pipeline(records(), createWriteStream(partial, { flags: "wx", mode: 0o600 }), {
      signal: context.signal
    });
    await rename(partial, file);
  } finally {
    await rm(partial, { force: true });
  }
  return { status: "ready", file, format: "jsonl", ...range, evidenceRowCount: evidenceRows };
}
