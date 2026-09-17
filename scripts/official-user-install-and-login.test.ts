import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

const root = process.cwd();

describe("official user install and login documentation", () => {
  it("describes the truthful post-publication pre-deploy SMEDC hard-cut release state", async () => {
    const doc = await readFile(
      path.join(root, "docs", "implementation", "official-user-install-and-login.md"),
      "utf8"
    );

    expect(doc).toContain("`smedc-mcp-launcher@0.5.0`");
    expect(doc).toContain("`YinXiaoyu-1998/SME_DATA_CENTER`");
    expect(doc).toContain("is public and independently");
    expect(doc).toContain("stage-publish-only permission");
    expect(doc).toContain("staging remains frozen");
    expect(doc).toContain("changes server metadata to require and");
    expect(doc).not.toContain("Public npm publication of 0.5.0");
    expect(doc).not.toContain("server metadata deliberately continues to recommend");
    expect(doc).not.toContain("OAuth Device Authorization is the pinned 0.4.0 flow");
  });
});
