import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const repoRoot = process.cwd();

describe("structured-import async staging cutover runbooks", () => {
  it("documents the one-time quiesced cleanup and rollback migration boundary", async () => {
    const runbook = await readFile(
      join(repoRoot, "docs/implementation/staging-deploy-runbook.md"),
      "utf8"
    );

    expect(runbook).toContain("## Structured-import async one-time cutover");
    expect(runbook).toMatch(/briefly stop\s+the API and worker/);
    expect(runbook).toContain("--target staging");
    expect(runbook).toContain("delete-upload-domain");
    expect(runbook).toContain("npm run staging:cleanup-upload-domain");
    expect(runbook).toContain("support module alone performs no cleanup");
    expect(runbook).toContain("repo-contained staging adapter");
    expect(runbook).toContain("DocumentLabel, ProcessingRun, DocumentChunk, DocumentIndex");
    expect(runbook).toContain("ImportBatch, ImportWindowClaim, DishRow, and BusinessRow");
    expect(runbook).toMatch(/Image rollback does not reverse Prisma\s+migrations/);
  });

  it("requires post-cutover acceptance to prove all three terminal upload outcomes and cleanup", async () => {
    const acceptance = await readFile(
      join(repoRoot, "docs/implementation/official-manual-acceptance.md"),
      "utf8"
    );

    expect(acceptance).toContain("## Structured-import async cutover acceptance");
    expect(acceptance).toContain("valid table -> `applied`");
    expect(acceptance).toContain("invalid table -> `rejected`");
    expect(acceptance).toContain("text -> `ready`");
    expect(acceptance).toContain("hard-delete the synthetic acceptance account");
  });
});
