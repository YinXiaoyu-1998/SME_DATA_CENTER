import { runInNewContext } from "node:vm";
import { expect, it } from "vitest";
const limits = { files: 5000, stores: 50, dates: 366, bytes: 1073741824, pageSize: 200 };
type Item = { storeName: string; purchaseDate: string; status: string; byteSize: number | null };
type Model = {
  selected: Map<string, Item>;
  select(item: Item, checked: boolean): void;
  selectBatch(items: Item[], checked: boolean): void;
  clear(): void;
  summary(): {
    bytes: number;
    unknown: number;
    invalid: number;
    overBytes: number;
    remaining: number;
    allowed: boolean;
  };
  items(): Item[];
  selection(): { storeName: string; purchaseDate: string }[];
  reconcile(items: Item[]): void;
};
async function model(): Promise<Model> {
  const module = await import("./ledger-model.js").catch(() => null);
  expect(module).not.toBeNull();
  return runInNewContext(`${module!.ledgerModelSource}; createLedgerModel(limits);`, { limits });
}
const item = (name: string, bytes: number | null, date = "2026-10-01"): Item => ({
  storeName: name,
  purchaseDate: date,
  status: "ready",
  byteSize: bytes
});
it("retains exact cross-query selections, counts all integer bytes and leaves an over-limit set intact", async () => {
  const m = await model();
  m.selectBatch(
    [item(" 店 ", 1073741800), item("店", 24), { ...item("pending", null), status: "pending" }],
    true
  );
  expect(m.summary()).toMatchObject({
    bytes: 1073741824,
    allowed: true,
    remaining: 0,
    overBytes: 0
  });
  m.select(item("é", 1), true);
  expect(m.summary()).toMatchObject({ bytes: 1073741825, allowed: false, overBytes: 1 });
  expect(m.selection()).toHaveLength(3);
  expect(m.items()[0]!.storeName).toBe(" 店 ");
  m.selectBatch([item("é", 1)], false);
  expect(m.selection()).toHaveLength(2);
  expect(m.summary().allowed).toBe(true);
  m.select(item("unknown", null), true);
  expect(m.summary()).toMatchObject({ unknown: 1, allowed: false });
});
it("revalidates the whole selection without dropping unreturned or inaccessible entries", async () => {
  const m = await model();
  m.select(item("one", 12), true);
  m.select(item("two", 30), true);
  m.reconcile([{ ...item("one", null), status: "stale" }]);
  expect(m.selection()).toHaveLength(2);
  expect(m.summary()).toMatchObject({ allowed: false, invalid: 2, unknown: 2 });
  expect(m.items().find((i) => i.storeName === "two")?.status).toBe("unverified");
});
