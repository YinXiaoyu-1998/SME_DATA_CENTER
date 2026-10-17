import { COST_CARD_DIRECTORY_REGISTRY, compileCostCardQuery } from "@smedc/domain";
import { SMEDC_MCP_TOOL_CONTRACTS } from "@smedc/mcp-contract";
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
  it("routes cost-card details to local CSV with published release and independent provenance", async () => {
    const skill = await readFile(path.join(root, "skills/smedc-mcp/SKILL.md"), "utf8");
    const guide = await readFile(
      path.join(root, "skills/smedc-mcp/references/cost-cards.md"),
      "utf8"
    );
    expect(skill).toContain("references/cost-cards.md");
    const example = JSON.parse(guide.match(/```json\n([\s\S]+?)\n```/)?.[1] ?? "null");
    const query = SMEDC_MCP_TOOL_CONTRACTS.find(
      (tool) => tool.name === "query_structured_dataset"
    )!.inputSchema.parse(example);
    expect(
      compileCostCardQuery({
        orgId: "synthetic",
        employee: { id: "synthetic", clearance: 2 },
        query,
        cursorSecret: "synthetic-doc-example",
        businessAuthorization: { version: "1", sql: "1 = 1", params: [] }
      }).dataset
    ).toBe("cost_cards");
    for (const field of COST_CARD_DIRECTORY_REGISTRY.fields)
      expect(guide).toContain(`\`${field.canonicalName}\``);
    for (const invariant of [
      "Launcher `0.11.0` is published and independently verified",
      "matching service rollout",
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
      "saving or resolving unsaved drafts",
      "get_import_status({importBatchId})",
      "cost_card_<costCardId>.csv",
      "archive_cost_card({costCardId})",
      "plus `fileName`",
      "Revoked access returns 404"
    ])
      expect(guide).toContain(invariant);
  });
});

it("parses every store-review Skill JSON example through its named shared contract", async () => {
  const guide = await readFile(
    path.join(root, "skills/smedc-mcp/references/store-reviews.md"),
    "utf8"
  );
  const examples = [
    ...guide.matchAll(
      /`(upsert_store_reviews|query_store_reviews)` —[^\n]*\n\n```json\n([\s\S]*?)\n```/g
    )
  ];
  expect(examples).toHaveLength(6);
  const parsed = examples.map(([, name, json]) => {
    const contract = SMEDC_MCP_TOOL_CONTRACTS.find((tool) => tool.name === name)!;
    return contract.inputSchema.parse(JSON.parse(json!));
  });
  const rows = parsed
    .slice(0, 4)
    .map((input) => (input["reviews"] as Array<Record<string, unknown>>)[0]!);
  expect(rows[0]!["content"]).toBe("环境舒适");
  expect(rows[1]).not.toHaveProperty("content");
  expect(Object.hasOwn(rows[1]!["scores"] as object, "__proto__")).toBe(true);
  expect(rows[2]!["scores"]).toBeNull();
  expect(rows[3]).not.toHaveProperty("content");
  expect(rows[3]).not.toHaveProperty("scores");
  expect(rows[3]!["merchantReply"]).toBeTypeOf("string");
  expect(parsed[5]!["cursor"]).toBe("opaque-cursor-from-previous-page");
});
