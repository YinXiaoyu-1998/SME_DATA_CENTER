import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

const root = process.cwd();

describe("SMEDC companion skill guidance", () => {
  it("routes report-extension discovery without making companions mandatory", async () => {
    const skill = await readFile(path.join(root, "skills", "smedc-mcp", "SKILL.md"), "utf8");

    expect(skill).toContain("配套分析、报表或扩展 skill");
    expect(skill).toContain("optional SMEDC analysis, reporting, or extension skills");
    expect(skill).toContain("## Optional Companion Skills");
    expect(skill).toContain("smedc-business-analysis");
    expect(skill).toContain("smedc-delivery-ledger");
    expect(skill).toContain("https://github.com/YinXiaoyu-1998/smedc-companion-skills");
    expect(skill).toMatch(/explicitly authorizes its\s+installation/);
    expect(skill).toContain("Never install it silently");
    expect(skill).toContain("not required for ordinary SMEDC work");
  });

  it("pins the independently verified launcher release", async () => {
    const skill = await readFile(path.join(root, "skills", "smedc-mcp", "SKILL.md"), "utf8");

    expect(skill).toContain("smedc-mcp-launcher@0.5.2");
    expect(skill).not.toContain("smedc-mcp-launcher@0.5.0");
  });
});
