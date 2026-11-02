import { expect, it } from "vitest";
import { SMEDC_MCP_TOOL_CONTRACTS } from "./index.js";
it("prepares only a bounded exact source scope and confirms using server preview identity", () => {
  const prepare = SMEDC_MCP_TOOL_CONTRACTS.find((t) => t.name === "prepare_order_scope_transition");
  expect(prepare).toBeDefined();
  const input = {
    enterpriseName: "Synthetic",
    startDate: "2026-10-26",
    endDate: "2026-10-27",
    storeNames: ["Store A"],
    orderScope: "settled_only",
    sourceChecksumSha256: "a".repeat(64)
  };
  expect(prepare!.inputSchema.parse(input)).toEqual(input);
  for (const invalid of [
    { ...input, orgId: "other" },
    { ...input, storeNames: [] },
    { ...input, orderScope: "legacy_unknown" },
    { ...input, startDate: "2026-10-28" }
  ])
    expect(prepare!.inputSchema.safeParse(invalid).success).toBe(false);
  const upload = SMEDC_MCP_TOOL_CONTRACTS.find((t) => t.name === "upload_structured_dataset")!;
  const source = {
    file: { name: "orders.csv", mediaType: "text/csv", encoding: "base64", contentBase64: "eA==" },
    dataset: "in_store_orders",
    enterpriseName: "Synthetic",
    startDate: "20261026",
    endDate: "20261027",
    idempotencyKey: "one",
    orderScope: "settled_only",
    orderScopeTransition: { previewId: "osc_1", confirmationDigest: "b".repeat(64) }
  };
  expect(upload.inputSchema.parse(source)).toEqual(source);
  expect(upload.inputSchema.safeParse({ ...source, orderScope: undefined }).success).toBe(false);
  expect(
    upload.inputSchema.safeParse({ ...source, dataset: "dishes", orderScope: undefined }).success
  ).toBe(false);
});
