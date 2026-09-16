import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { findNamingViolations, type NamingViolation } from "./check-smedc-naming.js";

let temporaryRoot: string | undefined;

async function tempRoot() {
  temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "smedc-naming-"));
  return temporaryRoot;
}

afterEach(async () => {
  if (temporaryRoot) {
    await rm(temporaryRoot, { recursive: true, force: true });
    temporaryRoot = undefined;
  }
});

describe("SMEDC naming checker", () => {
  it("rejects old product and seed-customer identifiers", async () => {
    const root = await tempRoot();
    const oldProduct = ["enterprise", "hub"].join("-");
    const oldProductSnake = ["enterprise", "hub"].join("_");
    const oldTenant = ["mai", "jia"].join("");

    await writeFile(
      path.join(root, "current.md"),
      [
        `old package ${oldProduct}`,
        `old database ${oldProductSnake}`,
        `old tenant ${oldTenant}`,
        "old Chinese tenant \u9ea6\u5bb6"
      ].join("\n")
    );

    const violations = findNamingViolations(root, ["current.md"]);

    expect(violations.map((violation: NamingViolation) => violation.token)).toEqual([
      "enterprise-hub",
      "enterprise_hub",
      "maijia",
      "\u9ea6\u5bb6"
    ]);
  });

  it("does not flag clean SMEDC current-state text", async () => {
    const root = await tempRoot();
    await writeFile(
      path.join(root, "current.md"),
      "SMEDC is the Small and Medium Enterprises Data Center.\n"
    );

    expect(findNamingViolations(root, ["current.md"])).toEqual([]);
  });

  it("rejects old identifiers in tracked file paths", async () => {
    const root = await tempRoot();
    const oldPath = ["enterprise", "hub"].join("-");
    await writeFile(path.join(root, "clean.md"), "SMEDC\n");

    expect(findNamingViolations(root, [`docs/${oldPath}/clean.md`])).toMatchObject([
      { file: `docs/${oldPath}/clean.md`, line: 0, token: "enterprise-hub" }
    ]);
  });

  it("preserves the narrow transitional launcher recommendation exception", async () => {
    const root = await tempRoot();
    await mkdir(path.join(root, "apps/api/src/auth"), { recursive: true });
    await writeFile(
      path.join(root, "apps/api/src/auth/http-contract.ts"),
      [
        'smedc_launcher_package: "enterprise-hub-mcp-launcher",',
        '  smedc_launcher_package: "enterprise-hub-mcp-launcher";'
      ].join("\n")
    );

    expect(findNamingViolations(root, ["apps/api/src/auth/http-contract.ts"])).toEqual([]);
  });

  it.each([
    ["generic doc", "docs/current-runbook.md"],
    ["Skill", "skills/smedc-mcp/SKILL.md"],
    ["script", "scripts/current-check.ts"]
  ])(
    "rejects the old launcher package outside the narrow exception in a %s",
    async (_label, file) => {
      const root = await tempRoot();
      await mkdir(path.join(root, path.dirname(file)), { recursive: true });
      await writeFile(
        path.join(root, file),
        [
          'smedc_launcher_package: "enterprise-hub-mcp-launcher",',
          "Use enterprise-hub-mcp-launcher@0.4.0 until Task 12."
        ].join("\n")
      );

      const violations = findNamingViolations(root, [file]);
      expect(
        violations.filter(
          (violation) => violation.file === file && violation.token === "enterprise-hub"
        )
      ).toHaveLength(2);
    }
  );
});
