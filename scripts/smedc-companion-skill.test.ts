import {
  COST_CARD_DIRECTORY_REGISTRY,
  compileCostCardQuery,
  parseStoreReviewBatch,
  resolveStoreReviewReplyState,
  type StoreReviewReplyState
} from "@smedc/domain";
import { launcherUploadFileInputSchema, SMEDC_MCP_TOOL_CONTRACTS } from "@smedc/mcp-contract";
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
      "Launcher `0.14.0` is published and independently verified",
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
  expect(examples).toHaveLength(11);
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
  expect(parsed.at(-1)!["cursor"]).toBe("opaque-cursor-from-previous-page");
});

it("applies store-review examples as verified facts without treating unknown or drafts as replies", async () => {
  const guide = await readFile(
    path.join(root, "skills/smedc-mcp/references/store-reviews.md"),
    "utf8"
  );
  const examples = [
    ...guide.matchAll(
      /`(upsert_store_reviews|query_store_reviews)` —[^\n]*\n\n```json\n([\s\S]*?)\n```/g
    )
  ];
  const states = new Map<string, StoreReviewReplyState>();
  const seen = new Set<string>();
  for (const [, name, json] of examples) {
    const input = SMEDC_MCP_TOOL_CONTRACTS.find((tool) => tool.name === name)!.inputSchema.parse(
      JSON.parse(json!)
    );
    if (name !== "upsert_store_reviews") continue;
    for (const row of parseStoreReviewBatch(input).reviews) {
      const identity = JSON.stringify([
        row.enterpriseName,
        row.source,
        row.storeName,
        row.reviewedAt,
        row.reviewerName,
        row.feedbackId ?? null
      ]);
      const state = resolveStoreReviewReplyState(states.get(identity) ?? null, row);
      states.set(identity, state);
      if (row.replyStatus) seen.add(row.replyStatus);
    }
  }
  expect([...seen].sort()).toEqual([
    "needs_verification",
    "replied",
    "unreplied_no_content",
    "unreplied_with_content"
  ]);
  expect([...states.values()]).toContainEqual({
    content: null,
    merchantReply: "感谢您的支持。",
    replyStatus: "replied"
  });
  expect([...states.values()]).toContainEqual({
    content: "环境舒适",
    merchantReply: "感谢您的评价，期待再次光临。",
    replyStatus: "needs_verification"
  });
  const query = JSON.parse(examples.at(-1)![2]!);
  expect(query.replyStatuses).toEqual(["unreplied_no_content", "unreplied_with_content"]);
});

it("applies published feedback examples without merging same-minute platform records", async () => {
  const guide = await readFile(
    path.join(root, "skills/smedc-mcp/references/store-reviews.md"),
    "utf8"
  );
  const examples = [
    ...guide.matchAll(
      /`(upsert_store_reviews|query_store_reviews)` —[^\n]*\n\n```json\n([\s\S]*?)\n```/g
    )
  ];
  const feedbackExample = examples
    .map(([, name, json]) => ({ name, input: JSON.parse(json!) }))
    .find(
      ({ name, input }) =>
        name === "upsert_store_reviews" &&
        input.reviews.some((row: Record<string, unknown>) => row.feedbackId)
    );
  expect(feedbackExample).toBeDefined();
  const parsed = parseStoreReviewBatch(feedbackExample!.input);
  expect(parsed.reviews.map((row) => row.feedbackId)).toEqual([
    "feedback-test-a",
    "feedback-test-b"
  ]);
  expect(parsed.reviews[0]!.reviewerName).toBe(parsed.reviews[1]!.reviewerName);
  expect(parsed.reviews[0]!.reviewedAt).toBe(parsed.reviews[1]!.reviewedAt);
  const filter = examples
    .map(([, name, json]) => ({ name, input: JSON.parse(json!) }))
    .find(({ name, input }) => name === "query_store_reviews" && input.feedbackId);
  expect(
    SMEDC_MCP_TOOL_CONTRACTS.find((tool) => tool.name === "query_store_reviews")!.inputSchema.parse(
      filter!.input
    )
  ).toMatchObject({ feedbackId: "feedback-test-a" });
});

it.each(["in_store_orders", "takeaway_orders"])(
  "validates %s Skill examples against the public upload and extract contracts",
  async (dataset) => {
    const reference = dataset === "in_store_orders" ? "in-store-orders" : "takeaway-orders";
    const skill = await readFile(path.join(root, "skills/smedc-mcp/SKILL.md"), "utf8");
    expect(skill).toContain(`references/${reference}.md`);
    const guide = await readFile(
      path.join(root, `skills/smedc-mcp/references/${reference}.md`),
      "utf8"
    );
    const examples = [...guide.matchAll(/`([a-z_]+)` —[^\n]*\n\n```json\n([\s\S]*?)\n```/g)];
    expect(examples.map(([, name]) => name)).toEqual([
      "upload_structured_dataset",
      "get_partition_import_status",
      "describe_structured_dataset_coverage",
      "download_structured_partitions",
      "prepare_structured_partition_download",
      "get_structured_partition_download_status",
      "download_structured_partitions"
    ]);
    for (const [, name, json] of examples) {
      const contract = SMEDC_MCP_TOOL_CONTRACTS.find((tool) => tool.name === name)!;
      const input = JSON.parse(json!);
      if (name === "upload_structured_dataset") {
        // The launcher validates its path variant, then sends source bytes outside MCP.
        expect(launcherUploadFileInputSchema.safeParse(input.file).success).toBe(true);
        input.file = {
          name: input.file.name,
          mediaType: input.file.mediaType,
          encoding: "base64",
          contentBase64: "YQ=="
        };
      }
      expect(contract.inputSchema.safeParse(input).success, name).toBe(true);
    }
    expect(JSON.parse(examples[0]![2]!)).toMatchObject({
      dataset,
      file: { encoding: "path" },
      startDate: "20261001",
      endDate: "20261002"
    });
    expect(JSON.parse(examples.at(-1)![2]!)).toEqual({ requestId: "pd_synthetic_example" });
  }
);
