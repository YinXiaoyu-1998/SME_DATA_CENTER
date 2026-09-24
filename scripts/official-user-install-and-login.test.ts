import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

const root = process.cwd();

function section(document: string, heading: string): string {
  const content = document.split(`## ${heading}\n`)[1];
  expect(content, `Missing active section: ${heading}`).toBeDefined();
  return content?.split("\n## ")[0] ?? "";
}

function prose(content: string): string {
  return content.replace(/\s+/g, " ").trim();
}

function launcherVersions(content: string): string[] {
  // Only explicit installation references: package pins, platform paths, and CLI JSON.
  // Bare compatibility/history versions such as minimum 0.5.0 are not installation pins.
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
  expect(new Set(versions), label).toEqual(new Set(["0.5.2"]));
}

describe("official user install and login documentation", () => {
  it("documents the published admin-only launcher and preserves minimum compatibility", async () => {
    const doc = await readFile(
      path.join(root, "docs", "implementation", "official-user-install-and-login.md"),
      "utf8"
    );

    const status = doc.split("\n## ")[0] ?? "";
    const distribution = section(doc, "Accepted Launcher Source And Distribution Boundary");
    expectPinnedReferences(status, "current install/login status");
    expectPinnedReferences(distribution, "current launcher distribution");
    expect(prose(status)).toContain("recommends 0.5.2");
    expect(prose(status)).toContain("0.5.0 as the minimum compatible launcher");
    expect(prose(distribution)).toContain("`YinXiaoyu-1998/SME_DATA_CENTER`");
    expect(prose(distribution)).toContain("is public and independently verified");
    expect(prose(distribution)).toContain("stage-publish-only permission");
  });

  it("pins the published launcher in the current-facing README", async () => {
    const readme = await readFile(path.join(root, "README.md"), "utf8");

    const official = section(readme, "Official Employee MCP");
    expectPinnedReferences(official, "official README");
    expect(prose(official)).toContain("accepts launcher 0.5.0 as the minimum");
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

  it("keeps upload guidance role-based, static, and safe before local file access", async () => {
    const skill = await readFile(path.join(root, "skills/smedc-mcp/SKILL.md"), "utf8");
    const upload = section(skill, "Admin-Only Uploads");
    // Canonical wire values stay literal; wrapping ordinary prose must not break this test.
    expect(upload).toContain("`403 UPLOAD_ADMIN_REQUIRED`");
    expect(upload).toContain("`File upload requires the admin role.`");
    expect(upload).toContain("`retryable: false`");
    const policy = prose(upload);
    for (const term of [
      "Only active accounts with role `admin` may upload",
      "do not read or transform the local file",
      "Do not re-login or retry",
      "remain visible",
      "Do not dynamically hide or remove upload tools",
      "Clearance is not upload permission",
      "above their own clearance",
      "creates no backend audit",
      "file_upload.denied",
      "delivery_ledger"
    ]) {
      expect(policy).toContain(term);
    }
    expect(prose(section(skill, "SMEDC Data Questions"))).not.toContain("offer to upload it first");
  });

  it("requires separate upload and read roles in the active beta pilot", async () => {
    const doc = await readFile(
      path.join(root, "docs/implementation/beta-access-readiness.md"),
      "utf8"
    );
    const scope = prose(section(doc, "First Pilot Scope"));
    const inputs = prose(section(doc, "Human Inputs Required For The First Beta User"));
    const gates = prose(section(doc, "Pilot Acceptance Gates"));

    expect(scope).toContain("one real beta user with role `employee`");
    expect(scope).toContain("a separate active `admin` account for positive uploads");
    expect(scope).toContain("employee upload denial");
    expect(scope).not.toContain("visibility labels");
    expect(inputs).toContain("Uploading admin");
    expect(inputs).toContain("employee denial, admin upload, employee read");
    expect(inputs).not.toContain("Allowed labels");
    expect(gates).toContain(
      "employee upload request is denied before local file reading or transformation"
    );
    expect(gates).toContain("UPLOAD_ADMIN_REQUIRED");
    expect(gates).toContain("active admin uploads");
    expect(gates).toContain("employee searches");
    expect(gates).toContain("same organization and adequate clearance");
    expect(gates).not.toContain("list authenticated labels");
    expect(gates).not.toContain("evidence upload, indexing, and search succeed");
  });

  it("keeps active acceptance uploads on admin and preserves the partition abort exception", async () => {
    const acceptance = await readFile(
      path.join(root, "docs/implementation/official-manual-acceptance.md"),
      "utf8"
    );
    const contract = await readFile(path.join(root, "docs/implementation/api-contract.md"), "utf8");
    const runner = prose(section(acceptance, "Runner"));
    const upload = prose(section(contract, "File Upload Capability"));
    expect(runner).toContain("admin identity (`admin`, clearance 0)");
    expect(runner).not.toContain("employee identity (`employee`, clearance 0)");
    expect(upload).toContain("employee owner");
    expect(upload).toContain("UPLOAD_ADMIN_REQUIRED");
    expect(upload).toContain("structured_dataset");
    expect(upload).toContain("Delivery Ledger");
  });
});
