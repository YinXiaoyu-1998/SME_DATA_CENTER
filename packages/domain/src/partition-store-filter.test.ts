import { describe, expect, it } from "vitest";
import * as domain from "./index.js";

describe("partition store-name scope", () => {
  it("normalizes NFC and trim without changing literal characters or case", () => {
    expect(domain.parsePartitionStoreNameContains(undefined)).toBeUndefined();
    expect(
      domain.parsePartitionStoreNameContains([" 麦家小馆 ", "A%_\\", "e\u0301", "two  spaces"])
    ).toEqual(["麦家小馆", "A%_\\", "é", "two  spaces"]);
  });
  it.each(
    [[], [" "], [1], "麦家小馆", null, Array(21).fill("store"), ["x".repeat(256)]].map((value) => ({
      value
    }))
  )("rejects invalid scope %j", ({ value }) => {
    expect(() => domain.parsePartitionStoreNameContains(value)).toThrow(
      domain.PartitionContractError
    );
  });
  it("accepts 20 items of at most 255 characters", () => {
    expect(domain.parsePartitionStoreNameContains(Array(20).fill("x".repeat(255)))).toHaveLength(
      20
    );
  });
});
