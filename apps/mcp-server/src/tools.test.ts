import { describe, expect, it } from "vitest";
import { MCP_TOOL_CONTRACTS } from "./tools.js";

describe("MCP tool contract", () => {
  it("defines the required Phase 2 tool names in deterministic order", () => {
    expect(MCP_TOOL_CONTRACTS.map((tool) => tool.name)).toEqual([
      "enterprise_hub_login_dev",
      "enterprise_hub_list_labels",
      "enterprise_hub_upload_document",
      "enterprise_hub_get_document_status",
      "enterprise_hub_search_documents",
      "enterprise_hub_get_document",
      "enterprise_hub_get_document_download_url",
      "enterprise_hub_archive_document",
      "enterprise_hub_list_skills"
    ]);
  });

  it("documents every tool purpose, input fields, and result shape", () => {
    for (const tool of MCP_TOOL_CONTRACTS) {
      expect(tool.description).not.toHaveLength(0);
      expect(tool.inputFields.length).toBeGreaterThan(0);
      expect(tool.resultShape.length).toBeGreaterThan(0);
    }
  });

  it("keeps document tools explicitly session-scoped", () => {
    const sessionScopedTools = MCP_TOOL_CONTRACTS.filter(
      (tool) => tool.name !== "enterprise_hub_login_dev"
    );

    for (const tool of sessionScopedTools) {
      expect(tool.inputFields.some((field) => field.name === "sessionName")).toBe(true);
    }
  });
});
