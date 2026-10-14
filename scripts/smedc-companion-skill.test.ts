import { COST_CARD_DIRECTORY_REGISTRY } from "@smedc/domain";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

const root = process.cwd();

describe("SMEDC companion skill guidance", () => {
  it("links the companion repository and its installable skills", async () => {
    const skill = await readFile(path.join(root, "skills", "smedc-mcp", "SKILL.md"), "utf8");

    expect(skill).toContain("smedc-business-analysis");
    expect(skill).toContain("smedc-delivery-ledger");
    expect(skill).toContain("https://github.com/YinXiaoyu-1998/smedc-companion-skills");
  });
  it("routes cost-card details to local CSV with candidate release and independent provenance", async () => {
    const skill = await readFile(path.join(root, "skills/smedc-mcp/SKILL.md"), "utf8");
    const guide = await readFile(
      path.join(root, "skills/smedc-mcp/references/cost-cards.md"),
      "utf8"
    );
    expect(skill).toContain("references/cost-cards.md");
    for (const field of COST_CARD_DIRECTORY_REGISTRY.fields)
      expect(guide).toContain(`\`${field.canonicalName}\``);
    for (const invariant of [
      "candidate `0.10.0`",
      "not published",
      "35",
      "38",
      "download_cost_cards",
      "sourceDocumentId",
      "importBatchId",
      "revision",
      "finally",
      "entire batch",
      "server-side detail filtering or aggregation",
      "matched_product_name",
      "cost_cards",
      "24 hours",
      "safe asynchronous",
      "Only an `applied` batch",
      "importBatch.publicationSummary",
      "readable `sourceSheetSummary` remains an array",
      'metadataPolicy: "none"',
      "selection is flat",
      "retryable 409",
      "value.createdCount",
      "saving or resolving unsaved drafts"
    ])
      expect(guide).toContain(invariant);
  });
});
