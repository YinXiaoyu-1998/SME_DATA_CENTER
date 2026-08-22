import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { canonicalStructuredImportFileName, structuredImportFingerprint } from "./workflow.js";

describe("structured import workflow metadata", () => {
  it("uses one normalized snapshotDate in the catalog fingerprint and canonical filename", () => {
    const input = {
      dataset: "dish_catalog" as const,
      enterpriseName: "Maijia",
      snapshotDate: "20260819",
      labelKeys: ["all_staff"],
      fileHash: "file-hash"
    };
    const expectedFingerprint = createHash("sha256")
      .update(
        JSON.stringify({
          dataset: "dish_catalog",
          enterpriseName: "Maijia",
          snapshotDate: "20260819",
          labelKeys: ["all_staff"],
          fileHash: "file-hash"
        })
      )
      .digest("hex");

    expect(structuredImportFingerprint(input)).toBe(expectedFingerprint);
    expect(
      canonicalStructuredImportFileName({
        dataset: "dish_catalog",
        enterpriseName: "Maijia",
        snapshotDate: "20260819",
        fileType: "xlsx"
      })
    ).toBe("m_a_i_j_i_a_dish_catalog_20260819.xlsx");
  });
});
