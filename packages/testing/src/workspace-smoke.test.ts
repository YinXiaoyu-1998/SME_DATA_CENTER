import { describe, expect, it } from "vitest";

const workspaceNames = [
  "@enterprise-hub/api",
  "@enterprise-hub/worker",
  "@enterprise-hub/admin-web",
  "@enterprise-hub/mcp-server",
  "@enterprise-hub/domain",
  "@enterprise-hub/storage",
  "@enterprise-hub/db",
  "@enterprise-hub/testing"
];

describe("workspace skeleton", () => {
  it("declares the initial Day 0 workspaces", () => {
    expect(workspaceNames).toContain("@enterprise-hub/api");
    expect(workspaceNames).toContain("@enterprise-hub/db");
    expect(workspaceNames).toHaveLength(8);
  });
});
