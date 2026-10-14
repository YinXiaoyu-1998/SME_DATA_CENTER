import { describe, expect, it } from "vitest";
import { parseShelfLifeCsv } from "./shelf-life-catalog-support.js";

describe("shelf-life CSV", () => {
  it("reads BOM, quoted delimiters and newlines without changing exact strings", () => {
    expect(parseShelfLifeCsv('\uFEFF物品名,保质期\r\n"A,B","冷藏\n3天"\r\nA ,12月\r\n')).toEqual([
      { itemName: "A,B", shelfLife: "冷藏\n3天" },
      { itemName: "A ", shelfLife: "12月" }
    ]);
  });
  it("requires exactly the agreed columns and rejects invalid/conflicting rows", () => {
    for (const csv of [
      "品名,保质期\nA,1",
      "物品名,保质期,其他\nA,1,2",
      "物品名,保质期\nA",
      "物品名,保质期\nA,1\nA,2",
      "物品名,保质期\n,1"
    ])
      expect(() => parseShelfLifeCsv(csv)).toThrow();
  });
});
