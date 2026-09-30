import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { SMEDC_MCP_TOOL_CONTRACTS } from "@smedc/mcp-contract";

const root = process.cwd();

describe("SMEDC companion skill guidance", () => {
  it("keeps PDF in evidence search rather than inventing a companion structured dataset", () => {
    const contracts = new Map(SMEDC_MCP_TOOL_CONTRACTS.map((c) => [c.name, c]));
    expect(
      contracts
        .get("search_document_evidence")!
        .inputSchema.safeParse({ query: "table clause", filters: { fileTypes: ["pdf"] } }).success
    ).toBe(true);
    expect(
      contracts.get("upload_structured_dataset")!.inputSchema.safeParse({
        dataset: "pdf",
        enterpriseName: "synthetic",
        idempotencyKey: "synthetic",
        file: {
          name: "table.pdf",
          mediaType: "application/pdf",
          encoding: "path",
          filePath: "/absolute/table.pdf"
        }
      }).success
    ).toBe(false);
  });
  it("links the companion repository and its installable skills", async () => {
    const skill = await readFile(path.join(root, "skills", "smedc-mcp", "SKILL.md"), "utf8");

    expect(skill).toContain("smedc-business-analysis");
    expect(skill).toContain("smedc-delivery-ledger");
    expect(skill).toContain("https://github.com/YinXiaoyu-1998/smedc-companion-skills");
  });
});
