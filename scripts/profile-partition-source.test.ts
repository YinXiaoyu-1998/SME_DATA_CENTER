import { describe, expect, test } from "vitest";
import path from "node:path";
import { profilePartitionSource } from "./profile-partition-source.js";

describe("profilePartitionSource", () => {
  test("returns only aggregate metrics for a real partition source", async () => {
    const result = await profilePartitionSource({
      dataset: "dishes",
      sourcePath: path.resolve("fixtures/structured/maijia_dishes_20260706_20260712_first1000.xlsx")
    });

    expect(result).toMatchObject({
      sourceBytes: 501_122,
      totalRows: 997,
      dateMin: "2026-07-06",
      dateMax: "2026-07-06"
    });
    expect(result.distinctStores).toBeGreaterThan(1);
    expect(result.partitionCount).toBe(result.distinctStores);
    expect(Object.keys(result).sort()).toEqual([
      "canonicalBytes",
      "dateMax",
      "dateMin",
      "distinctStores",
      "elapsedMs",
      "partitionCount",
      "peakRssBytes",
      "sourceBytes",
      "totalRows"
    ]);
  });
});
