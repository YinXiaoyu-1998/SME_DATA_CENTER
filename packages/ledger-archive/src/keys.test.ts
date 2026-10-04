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

it("retains ordinary Chinese and reversibly escapes only unsafe characters and dot segments", () => {
  const base = { orgId: "org-1", purchaseDate: "2026-10-01" };
  expect(createLedgerPdfObjectKey({ ...base, storeName: "麦家小馆（通州保利店）" }, 1)).toBe(
    "org/org-1/ledger_records/麦家小馆（通州保利店）/2026/10/01/台账_1.pdf"
  );
  const names = ["a/b", "a\\b", "a%b", "a\u0000b", ".", "..", "普通.门店", "a%2Fb"];
  const paths = names.map((storeName) => createLedgerPdfObjectKey({ ...base, storeName }, 1));
  expect(new Set(paths).size).toBe(names.length);
  paths.forEach((path, index) =>
    expect(decodeURIComponent(path.split("/")[3]!)).toBe(names[index])
  );
  expect(paths[4]).toContain("/%2E/");
  expect(paths[5]).toContain("/%2E%2E/");
  expect(paths[6]).toContain("/普通.门店/");
});

it("enforces the complete physical OSS key UTF-8 budget including prefix and generation filename", () => {
  const base = { orgId: "org-1", storeName: "中", purchaseDate: "2026-10-01" };
  const overhead =
    Buffer.byteLength(createLedgerPdfObjectKey(base, 4_294_967_295), "utf8") -
    Buffer.byteLength("中");
  const storeName =
    "中".repeat(Math.floor((1_023 - overhead) / 3)) + "a".repeat((1_023 - overhead) % 3);
  const boundary = { ...base, storeName };
  expect(Buffer.byteLength(createLedgerPdfObjectKey(boundary, 4_294_967_295))).toBe(1_023);
  expect(() =>
    createLedgerPdfObjectKey({ ...boundary, storeName: `${storeName}a` }, 4_294_967_295)
  ).toThrow("LEDGER_OBJECT_KEY_TOO_LONG");
  expect(() => createLedgerPdfObjectKey(boundary, 4_294_967_295, "中")).toThrow(
    "LEDGER_OBJECT_KEY_TOO_LONG"
  );
  const prefixedBudget = 1_023 - overhead - Buffer.byteLength("中/");
  const prefixedName = "中".repeat(Math.floor(prefixedBudget / 3)) + "a".repeat(prefixedBudget % 3);
  expect(
    Buffer.byteLength(
      `中/${createLedgerPdfObjectKey({ ...boundary, storeName: prefixedName }, 4_294_967_295, "/中/")}`
    )
  ).toBe(1_023);
  expect(() =>
    createLedgerPdfObjectKey({ ...boundary, storeName: `${prefixedName}a` }, 4_294_967_295, "/中/")
  ).toThrow("LEDGER_OBJECT_KEY_TOO_LONG");
  expect(() => createLedgerPdfObjectKey({ ...base, storeName: "中".repeat(512) }, 1)).toThrow(
    "LEDGER_OBJECT_KEY_TOO_LONG"
  );
});

it("reserves immutable attempt filename width at admission", async () => {
  const { assertLedgerPartitionObjectKeyFits } = await import("./keys.js");
  const key = { orgId: "org", storeName: "x", purchaseDate: "2026-10-01" };
  const uuid = "ffffffff-ffff-ffff-ffff-ffffffffffff";
  expect(createLedgerPdfObjectKey(key, 1, "", uuid)).toContain(`台账_1-${uuid}.pdf`);
  expect(() => createLedgerPdfObjectKey(key, 1, "", "../bad")).toThrow("LEDGER_ATTEMPT_ID_INVALID");
  const overhead = Buffer.byteLength(createLedgerPdfObjectKey(key, 4_294_967_295, "", uuid)) - 1;
  assertLedgerPartitionObjectKeyFits({ ...key, storeName: "x".repeat(1023 - overhead) });
  expect(() =>
    assertLedgerPartitionObjectKeyFits({ ...key, storeName: "x".repeat(1024 - overhead) })
  ).toThrow("LEDGER_OBJECT_KEY_TOO_LONG");
});
