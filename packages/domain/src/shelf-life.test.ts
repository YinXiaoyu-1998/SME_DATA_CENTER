import { describe, expect, it } from "vitest";
import { parseShelfLifeEntries } from "./shelf-life.js";

describe("enterprise shelf-life entries", () => {
  it("preserves exact names and arbitrary string values and collapses identical pairs", () => {
    const entries = [
      { itemName: "Juice", shelfLife: "12月" },
      { itemName: "juice", shelfLife: "冷藏 3 天" },
      { itemName: "Ｊuice", shelfLife: "见包装" },
      { itemName: "Juice ", shelfLife: " 24月 " }
    ];
    expect(parseShelfLifeEntries([...entries, entries[0]])).toEqual(entries);
  });

  it("rejects conflicting duplicates, empty strings, unknown fields and excessive inputs", () => {
    for (const input of [
      [],
      [
        { itemName: "A", shelfLife: "1" },
        { itemName: "A", shelfLife: "2" }
      ],
      [{ itemName: " ", shelfLife: "1" }],
      [{ itemName: "A", shelfLife: " " }],
      [{ itemName: "A".repeat(513), shelfLife: "1" }],
      [{ itemName: "A", shelfLife: "1".repeat(256) }],
      [{ itemName: "A", shelfLife: "1", orgId: "other" }],
      Array.from({ length: 10001 }, () => ({ itemName: "A", shelfLife: "1" }))
    ])
      expect(() => parseShelfLifeEntries(input)).toThrow();
  });
});
