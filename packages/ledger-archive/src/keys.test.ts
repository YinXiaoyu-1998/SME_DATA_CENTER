import { describe, expect, it } from "vitest";
import { createLedgerPdfObjectKey } from "./keys.js";

describe("ledger PDF object keys", () => {
  it("isolates enterprises and preserves exact store names without path collisions", () => {
    const key = { orgId: "org-1", storeName: "a/b", purchaseDate: "2024-02-29" };
    const first = createLedgerPdfObjectKey(key, 12);
    expect(first).toBe("org/org-1/ledger_records/a%2Fb/2024/02/29/台账_12.pdf");
    expect(first).not.toBe(createLedgerPdfObjectKey({ ...key, storeName: "a_b" }, 12));
    expect(first).not.toBe(createLedgerPdfObjectKey({ ...key, orgId: "org-2" }, 12));
  });
});
