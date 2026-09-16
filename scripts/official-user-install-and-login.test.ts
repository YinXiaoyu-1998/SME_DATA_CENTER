import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

const root = process.cwd();

describe("official user install and login documentation", () => {
  it("describes the truthful pre-publication SMEDC hard-cut release state", async () => {
    const doc = await readFile(
      path.join(root, "docs", "implementation", "official-user-install-and-login.md"),
      "utf8"
    );

    expect(doc).toContain("launcher 0.5.0 is the code and Skill target");
    expect(doc).toContain("`smedc-mcp-launcher@0.5.0`");
    expect(doc).toContain("`YinXiaoyu-1998/smedc`");
    expect(doc).toContain("Public npm publication of 0.5.0");
    expect(doc).toContain("server recommendation synchronization are still pending");
    expect(doc).toContain("server metadata deliberately continues to recommend");
    expect(doc).not.toContain("`smedc-mcp-launcher@0.5.0` is public and independently verified");
    expect(doc).not.toContain("recommended by server metadata");
    expect(doc).not.toContain("OAuth Device Authorization is the pinned 0.4.0 flow");
  });
});
