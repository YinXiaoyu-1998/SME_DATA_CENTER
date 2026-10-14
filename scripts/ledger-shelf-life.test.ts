import { describe, expect, it } from "vitest";
import { parseShelfLifeArgs, parseShelfLifeMappings } from "./ledger-shelf-life-support.js";

describe("shelf-life maintenance input", () => {
  it("preserves exact names and accepts arbitrary shelf-life text", () => {
    expect(
      parseShelfLifeMappings([
        { itemName: " 加多宝 ", shelfLife: "24月" },
        { itemName: "Juice", shelfLife: "30天" },
        { itemName: "Juice", shelfLife: "30天" }
      ])
    ).toEqual([
      { itemName: " 加多宝 ", shelfLife: "24月" },
      { itemName: "Juice", shelfLife: "30天" }
    ]);
  });

  it.each(
    [
      [],
      {},
      [{ itemName: "加多宝", shelfLife: 24 }],
      [{ itemName: " ", shelfLife: "24月" }],
      [{ itemName: "加多宝", shelfLife: "" }],
      [
        { itemName: "加多宝", shelfLife: "24月" },
        { itemName: "加多宝", shelfLife: "12月" }
      ]
    ].map((input) => ({ input }))
  )("rejects invalid or conflicting input before database work: %j", ({ input }) => {
    expect(() => parseShelfLifeMappings(input)).toThrow();
  });

  const args = ["--org-id", "org-a", "--org-name", "麦家小馆", "--input", "/tmp/map.json"];
  it("defaults to preview and requires an operator to execute", () => {
    expect(parseShelfLifeArgs(args)).toMatchObject({ execute: false, allowRemote: false });
    expect(() => parseShelfLifeArgs([...args, "--execute"])).toThrow();
    expect(parseShelfLifeArgs([...args, "--execute", "--operator", "maintainer"])).toMatchObject({
      execute: true,
      operator: "maintainer"
    });
  });
  it.each(
    [
      ["--input", "/tmp/map.json"],
      [...args, "--org-id", "other"],
      [...args, "--unknown"],
      [...args, "--execute", "--dry-run", "--operator", "maintainer"]
    ].map((input) => ({ input }))
  )("rejects ambiguous CLI arguments: %j", ({ input }) => {
    expect(() => parseShelfLifeArgs(input)).toThrow();
  });
});
