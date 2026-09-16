import { describe, expect, test } from "vitest";
import path from "node:path";
import { profilePartitionSource } from "./profile-partition-source.js";

const fixtureReaderCommand = [
  process.execPath,
  "--import",
  "tsx",
  path.resolve("packages/structured-ingestion/src/calamine-reader-test-helper.ts")
];

describe("profilePartitionSource", () => {
  test("returns only aggregate metrics for a real partition source", async () => {
    const result = await profilePartitionSource({
      dataset: "dishes",
      sourcePath: path.resolve(
        "fixtures/structured/synthetic_dishes_20260706_20260712_first1000.xlsx"
      ),
      xlsxReaderCommand: fixtureReaderCommand
    });

    expect(result).toMatchObject({
      sourceBytes: 501_122,
      totalRows: 997,
      dateMin: "2026-07-06",
      dateMax: "2026-07-06"
    });
    expect(result.distinctStores).toBeGreaterThan(1);
    expect(result.partitionCount).toBe(result.distinctStores);
    expect(result.sourceExportProfile).toMatchObject({
      sourceFormat: "xlsx",
      totalMs: expect.any(Number),
      structureReadMs: expect.any(Number),
      mergeScanMs: expect.any(Number),
      rowDecodeMs: expect.any(Number),
      rowRoutingMs: expect.any(Number),
      canonicalizeMs: expect.any(Number),
      partitionWriteMs: expect.any(Number),
      partitionFlushCount: expect.any(Number),
      finalizeMs: expect.any(Number)
    });
    expect(Object.keys(result).sort()).toEqual([
      "canonicalBytes",
      "dateMax",
      "dateMin",
      "distinctStores",
      "elapsedMs",
      "partitionCount",
      "peakRssBytes",
      "sourceBytes",
      "sourceExportProfile",
      "totalRows"
    ]);
  });
});
