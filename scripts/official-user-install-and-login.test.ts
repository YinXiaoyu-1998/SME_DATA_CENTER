import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

const root = process.cwd();

describe("official user install and login documentation", () => {
  it("documents the published admin-only launcher and preserves minimum compatibility", async () => {
    const doc = await readFile(
      path.join(root, "docs", "implementation", "official-user-install-and-login.md"),
      "utf8"
    );

    expect(doc).toContain("`smedc-mcp-launcher@0.5.2`");
    expect(doc).toContain("`YinXiaoyu-1998/SME_DATA_CENTER`");
    expect(doc).toContain("is public and independently");
    expect(doc).toContain("stage-publish-only permission");
    expect(doc).toContain("recommends 0.5.2");
    expect(doc).toContain("0.5.0 as the minimum compatible launcher");
    expect(doc).toContain("UPLOAD_ADMIN_REQUIRED");
    expect(doc).not.toContain("Public npm publication of 0.5.1");
    expect(doc).not.toContain("server metadata deliberately continues to recommend");
    expect(doc).not.toContain("OAuth Device Authorization is the pinned 0.4.0 flow");
  });

  it("pins the published launcher in the current-facing README", async () => {
    const readme = await readFile(path.join(root, "README.md"), "utf8");

    expect(readme).toContain("`smedc-mcp-launcher@0.5.2` local stdio launcher");
    expect(readme).toContain("accepts launcher 0.5.0 as the minimum");
    expect(readme).not.toContain("`smedc-mcp-launcher@0.5.0` local stdio launcher");
  });

  it("keeps upload guidance role-based, static, and safe before local file access", async () => {
    const skill = await readFile(path.join(root, "skills/smedc-mcp/SKILL.md"), "utf8");
    expect(skill).toContain("Only active accounts with role `admin` may upload");
    expect(skill).toContain("File upload requires the admin role.");
    expect(skill).toContain("`retryable: false`");
    expect(skill).toContain("do not read or transform the local file");
    expect(skill).toContain("Do not re-login or retry");
    expect(skill).toContain("remain visible");
    expect(skill).toContain("Do not dynamically hide or remove upload tools");
    expect(skill).toContain("Clearance is not upload permission");
    expect(skill).toContain("above their own clearance");
    expect(skill).toContain("creates no backend audit");
    expect(skill).toContain("file_upload.denied");
    expect(skill).toContain("delivery_ledger");
    expect(skill).not.toMatch(/offer to upload it\s+first/);
    expect(skill).not.toContain("0.5.1");
    expect(skill).not.toContain("smedc-mcp-launcher@latest");
  });

  it("keeps active acceptance uploads on admin and preserves the partition abort exception", async () => {
    const acceptance = await readFile(
      path.join(root, "docs/implementation/official-manual-acceptance.md"),
      "utf8"
    );
    const contract = await readFile(path.join(root, "docs/implementation/api-contract.md"), "utf8");
    expect(acceptance).toContain("admin identity (`admin`, clearance 0)");
    expect(acceptance).not.toContain("low-clearance employee explicitly upload");
    expect(acceptance).not.toContain("employee identity (`employee`, clearance 0)");
    expect(contract).toContain("employee owner");
    expect(contract).toContain("UPLOAD_ADMIN_REQUIRED");
    expect(contract).toContain("structured_dataset");
    expect(contract).toContain("Delivery Ledger");
  });
});
