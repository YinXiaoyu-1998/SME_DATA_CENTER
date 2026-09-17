import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

const root = process.cwd();

describe("SMEDC business-data cleanup Skill", () => {
  it("tracks the current partition storage model and all exact object keys", async () => {
    const skill = await readFile(
      path.join(root, "skills", "smedc-business-data-cleanup", "SKILL.md"),
      "utf8"
    );

    for (const required of [
      "structured_partitions",
      "partition_import_jobs",
      "storage_garbage",
      "temporaryObjectKey",
      "objectKey",
      "storageObjectKey"
    ]) {
      expect(skill).toContain(required);
    }
    expect(skill).not.toMatch(/`(?:dish_rows|business_rows)`/);
    expect(skill).toContain("temporary source objects");
    expect(skill).toContain("derived partition objects");
  });
});
