import { Prisma } from "@prisma/client";
import { parseShelfLifeEntries, type ShelfLifeEntry } from "@smedc/domain";

/** Caller supplies its authorized organization. Receipt publication already holds its org lock. */
export async function lookupShelfLives(
  tx: Prisma.TransactionClient,
  orgId: string,
  itemNames: readonly string[]
): Promise<Map<string, string>> {
  const names = [...new Set(itemNames)];
  const values = new Map<string, string>();
  for (let offset = 0; offset < names.length; offset += 500) {
    const entries = await tx.shelfLifeCatalogEntry.findMany({
      where: { orgId, itemName: { in: names.slice(offset, offset + 500) } },
      select: { itemName: true, shelfLife: true }
    });
    for (const entry of entries) values.set(entry.itemName, entry.shelfLife);
  }
  return values;
}

/** Locks and current reads make this safe even if a future caller has an older TX snapshot. */
export async function planShelfLifeCatalogUpdate(
  tx: Prisma.TransactionClient,
  orgId: string,
  input: readonly ShelfLifeEntry[]
) {
  const entries = parseShelfLifeEntries(input);
  const organizations = await tx.$queryRaw<{ id: string }[]>(
    Prisma.sql`SELECT id FROM organizations WHERE id = ${orgId} FOR UPDATE`
  );
  if (!organizations.length) throw new Error("SHELF_LIFE_ORG_NOT_FOUND");
  const previous = new Map<string, string>();
  for (let offset = 0; offset < entries.length; offset += 500) {
    const rows = await tx.$queryRaw<ShelfLifeEntry[]>(Prisma.sql`
      SELECT item_name AS itemName, shelf_life AS shelfLife FROM shelf_life_catalog_entries
      WHERE org_id = ${orgId} AND item_name IN (${Prisma.join(entries.slice(offset, offset + 500).map((entry) => entry.itemName))})
      FOR UPDATE`);
    for (const row of rows) previous.set(row.itemName, row.shelfLife);
  }
  const changes = entries.flatMap((entry) => {
    const before = previous.get(entry.itemName) ?? null;
    return before === entry.shelfLife
      ? []
      : [{ itemName: entry.itemName, before, after: entry.shelfLife }];
  });
  const inserted = changes.filter((change) => change.before === null).length;
  return {
    inserted,
    updated: changes.length - inserted,
    unchanged: entries.length - changes.length,
    changes
  };
}

/** Merge by exact name; absent entries stay intact. Caller owns authorization and audit in this TX. */
export async function upsertShelfLifeCatalog(
  tx: Prisma.TransactionClient,
  orgId: string,
  entries: readonly ShelfLifeEntry[]
) {
  const plan = await planShelfLifeCatalogUpdate(tx, orgId, entries);
  const added = plan.changes.filter((change) => change.before === null);
  for (let offset = 0; offset < added.length; offset += 500) {
    await tx.shelfLifeCatalogEntry.createMany({
      data: added
        .slice(offset, offset + 500)
        .map((entry) => ({ orgId, itemName: entry.itemName, shelfLife: entry.after }))
    });
  }
  for (const entry of plan.changes.filter((change) => change.before !== null)) {
    await tx.shelfLifeCatalogEntry.update({
      where: { orgId_itemName: { orgId, itemName: entry.itemName } },
      data: { shelfLife: entry.after }
    });
  }
  return plan;
}
