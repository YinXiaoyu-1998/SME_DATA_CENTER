/** Used by the shipped browser client and the existing lightweight VM test seam. */
export const ledgerModelSource = String.raw`
const ledgerKey = item => JSON.stringify([item.storeName, item.purchaseDate]);
function createLedgerModel(limits) {
  const selected = new Map();
  const validSize = item => Number.isSafeInteger(item.byteSize) && item.byteSize > 0;
  return {
    selected,
    select(item, checked) { if (!checked) selected.delete(ledgerKey(item)); else if (item.status === "ready") selected.set(ledgerKey(item), { ...item }); },
    selectBatch(items, checked) { for (const item of items) this.select(item, checked); },
    reconcile(items) {
      const current = new Map(items.map(item => [ledgerKey(item), item]));
      for (const [key, previous] of selected) selected.set(key, current.get(key) ?? { ...previous, status: "unverified", byteSize: null });
    },
    clear() { selected.clear(); },
    items() { return [...selected.values()].sort((a, b) => (validSize(b) ? b.byteSize : -1) - (validSize(a) ? a.byteSize : -1)); },
    selection() { return [...selected.values()].map(({ storeName, purchaseDate }) => ({ storeName, purchaseDate })).sort((a,b) => ledgerKey(a) < ledgerKey(b) ? -1 : ledgerKey(a) > ledgerKey(b) ? 1 : 0); },
    summary() {
      const items = [...selected.values()];
      const bytes = items.reduce((sum, item) => sum + (validSize(item) ? item.byteSize : 0), 0);
      const unknown = items.filter(item => !validSize(item)).length;
      const invalid = items.filter(item => item.status !== "ready").length;
      const stores = new Set(items.map(item => item.storeName)).size;
      const dates = new Set(items.map(item => item.purchaseDate)).size;
      return { files: items.length, bytes, unknown, invalid, stores, dates, overBytes: Math.max(0, bytes - limits.bytes), remaining: Math.max(0, limits.bytes - bytes), allowed: items.length > 0 && items.length <= limits.files && stores <= limits.stores && dates <= limits.dates && Number.isSafeInteger(bytes) && bytes <= limits.bytes && !unknown && !invalid };
    }
  };
}`;
