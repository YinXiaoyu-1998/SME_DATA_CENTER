import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

const root = process.cwd();

describe("Enterprise Hub companion skill guidance", () => {
  it("routes report-extension discovery without making companions mandatory", async () => {
    const skill = await readFile(
      path.join(root, "skills", "enterprise-hub-mcp", "SKILL.md"),
      "utf8"
    );

    expect(skill).toContain("配套分析、报表或扩展 skill");
    expect(skill).toContain("optional Enterprise Hub analysis, reporting, or extension skills");
    expect(skill).toContain("## Optional Companion Skills");
    expect(skill).toContain("maijia-business-analyses-smedc");
    expect(skill).toContain("https://github.com/YinXiaoyu-1998/maijia-business-analyses-smedc");
    expect(skill).toMatch(/explicitly authorizes its\s+installation/);
    expect(skill).toContain("Never install it silently");
    expect(skill).toContain("not required for ordinary Enterprise Hub work");
  });
});
