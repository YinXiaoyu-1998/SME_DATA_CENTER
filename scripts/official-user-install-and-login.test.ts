import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { launcherUploadFileInputSchema, SMEDC_MCP_TOOL_CONTRACTS } from "@smedc/mcp-contract";

const root = process.cwd();

function section(document: string, heading: string): string {
  const content = document.split(`## ${heading}\n`)[1];
  expect(content, `Missing active section: ${heading}`).toBeDefined();
  return content?.split("\n## ")[0] ?? "";
}

function launcherVersions(content: string): string[] {
  // Only explicit installation references: package pins, platform paths, and CLI JSON.
  // Bare historical versions are not installation pins.
  const patterns = [
    /smedc-mcp-launcher@([^\s`"']+)/g,
    /launcher[\\/]+versions[\\/]+([^\\/\s`"']+)/g,
    /"launcherVersion"\s*:\s*"([^"]+)"/g,
    /this document pins launcher\s+(\S+?)(?=[.;]?(?:\s|$))/g
  ];
  return patterns.flatMap((pattern) =>
    [...content.matchAll(pattern)].map((match) => match[1] ?? "")
  );
}

function expectPinnedReferences(content: string, label: string): void {
  const versions = launcherVersions(content);
  expect(versions.length, `No launcher references in ${label}`).toBeGreaterThan(0);
  expect(new Set(versions), label).toEqual(new Set(["0.6.0"]));
}

describe("official user install and login documentation", () => {
  it("validates the conditional PDF upload example against the bundled public tool contract", async () => {
    const skill = await readFile(path.join(root, "skills/smedc-mcp/SKILL.md"), "utf8");
    const examples = [...skill.matchAll(/^ *```json\n([\s\S]*?)\n *```/gm)]
      .map((match) => JSON.parse(match[1]!))
      .filter((value) => value.tool === "upload_evidence_document");
    expect(examples).toHaveLength(1);
    const contract = SMEDC_MCP_TOOL_CONTRACTS.find((c) => c.name === "upload_evidence_document")!;
    // Native launcher contracts extend the HTTP upload shape with local path encoding.
    const launcherSchema = z
      .object({ ...contract.inputShape, file: launcherUploadFileInputSchema })
      .strict();
    expect(launcherSchema.safeParse(examples[0].arguments).success).toBe(true);
    expect(examples[0].arguments.confidentialityLevel).toBeUndefined();
  });

  it("pins the approved launcher in active installation guidance", async () => {
    const doc = await readFile(
      path.join(root, "docs", "implementation", "official-user-install-and-login.md"),
      "utf8"
    );

    const status = doc.split("\n## ")[0] ?? "";
    const distribution = section(doc, "Accepted Launcher Source And Distribution Boundary");
    expectPinnedReferences(status, "current install/login status");
    expectPinnedReferences(distribution, "current launcher distribution");
  });

  it("pins the published launcher in the current-facing README", async () => {
    const readme = await readFile(path.join(root, "README.md"), "utf8");

    const official = section(readme, "Official Employee MCP");
    expectPinnedReferences(official, "official README");
  });

  it("pins every active Skill package, platform path, and CLI version reference", async () => {
    const skill = await readFile(path.join(root, "skills/smedc-mcp/SKILL.md"), "utf8");
    const update = await readFile(
      path.join(root, "skills/smedc-mcp/references/update-skill.md"),
      "utf8"
    );
    expectPinnedReferences(skill.split("\n## ")[0] ?? "", "Skill approved package");
    for (const heading of [
      "Official Install Or Update",
      "Device-Code Login Flow",
      "Configure The Invoking Agent",
      "Removal And Complete Uninstall"
    ]) {
      expectPinnedReferences(section(skill, heading), heading);
    }
    expectPinnedReferences(
      section(update, "Continue Within The Requested Scope"),
      "Skill update pin"
    );
  });
});
